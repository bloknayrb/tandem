import { HocuspocusProvider } from "@hocuspocus/provider";
import * as Y from "yjs";
import { API_CLOSE } from "../../shared/api-paths.js";
import {
  CTRL_ROOM,
  DEFAULT_MCP_PORT,
  DEFAULT_WS_PORT,
  Y_MAP_ACTIVE_DOCUMENT_ID,
  Y_MAP_ANNOTATIONS,
  Y_MAP_AWARENESS,
  Y_MAP_CLAUDE,
  Y_MAP_DOCUMENT_META,
  Y_MAP_GENERATION_ID,
  Y_MAP_OPEN_DOCUMENTS,
  Y_MAP_READ_ONLY,
  Y_MAP_STORE_READ_ONLY,
} from "../../shared/constants";
import { sanitizeAnnotation } from "../../shared/sanitize";
import type { Annotation } from "../../shared/types";
import type { DocListEntry, OpenTab } from "../types";
import { deduplicateDocList } from "./useYjsSync";

export type ConnectionStatus = "connected" | "connecting" | "disconnected";

export interface YjsSyncState {
  readonly tabs: OpenTab[];
  readonly activeTabId: string | null;
  setActiveTabId: (id: string) => void;
  handleTabClose: (id: string) => void;
  readonly connected: boolean;
  readonly connectionStatus: ConnectionStatus;
  readonly reconnectAttempts: number;
  readonly disconnectedSince: number | null;
  readonly annotations: Annotation[];
  readonly claudeStatus: string | null;
  readonly claudeActive: boolean;
  readonly readOnly: boolean;
  /** True when the annotation store is locked by another Tandem instance. Annotations won't be saved. */
  readonly storeReadOnly: boolean;
  /** @internal Internal CTRL_ROOM connection mechanism — not intended for consumer use. */
  readonly bootstrapYdoc: Y.Doc | null;
  readonly ready: boolean;
  /** Briefly true after the server restarts and the client reconnects. */
  readonly serverRestarted: boolean;
  /** Caller invokes this in component teardown (`onDestroy`). */
  destroy: () => void;
  /** Force an immediate reconnect attempt on all providers. */
  reconnect: () => void;
}

/**
 * Svelte 5 port of `useYjsSync`.
 *
 * Key differences vs the React version:
 *  - `$effect` does NOT run in declaration order. Bootstrap and the bootstrap-doc
 *    observer are therefore collapsed into a single bootstrap step (run inline at
 *    factory-call time, akin to `onMount`) rather than two effects relying on
 *    declaration order. The `bootstrap` $state flag gates active-tab observers
 *    in case any future caller wants to consume them before bootstrap completes.
 *  - The active-tab observer effect reads BOTH `activeTabId` and the identity of
 *    `tabs[activeTabId]?.ydoc` so a Y.Doc swap (reload-from-disk) rewires too.
 *  - Refs (mutable, non-reactive) are plain `let` — only consumer-visible UI
 *    state is `$state`. CRDT internals don't need reactivity.
 *  - All five `event.keysChanged` guards from the original are preserved.
 *  - Every `ymap.observe(fn)` has a matching `ymap.unobserve(fn)` with named
 *    function references stored in cleanups.
 */
export function createYjsSync(): YjsSyncState {
  // ---------- Reactive UI state (mirrors React useState) ----------
  let tabsState = $state<OpenTab[]>([]);
  let activeTabIdState = $state<string | null>(null);
  let connected = $state(false);
  let connectionStatus = $state<ConnectionStatus>("connecting");
  let reconnectAttempts = $state(0);
  let disconnectedSince = $state<number | null>(null);
  let annotationsState = $state<Annotation[]>([]);
  let claudeStatus = $state<string | null>(null);
  let claudeActive = $state(false);
  let readOnly = $state(false);
  let storeReadOnly = $state(false);
  let ready = $state(false);
  let serverRestarted = $state(false);
  // Surface bootstrap Y.Doc reactively so `bootstrapYdoc` flips from null to populated
  // when the bootstrap step completes (parallel of React's setReady re-render).
  let bootstrapYdocState = $state<Y.Doc | null>(null);

  // ---------- Refs (non-reactive mutable state) ----------
  let restartTimer: ReturnType<typeof setTimeout> | null = null;
  /** Track whether we've ever connected — don't count initial attempt as a reconnect. */
  let hadConnection = false;
  let generationId: string | null = null;
  // Synchronous dedup guards — prevent duplicate provider creation when multiple
  // Yjs observers fire before reactive state catches up.
  const pendingIds = new Set<string>();
  const pendingProviders = new Map<string, { ydoc: Y.Doc; provider: HocuspocusProvider }>();
  const observers = new Map<string, { cleanup: () => void }>();
  const tabMetaCleanups = new Map<string, () => void>();
  let destroyed = false;

  // ---------- setupTabObservers (annotation/awareness/documentMeta) ----------
  const setupTabObservers = (tab: OpenTab): (() => void) => {
    const { ydoc } = tab;

    const annotationsMap = ydoc.getMap(Y_MAP_ANNOTATIONS);
    const annotationObserver = () => {
      const anns: Annotation[] = [];
      annotationsMap.forEach((value) => {
        anns.push(
          sanitizeAnnotation(value as Annotation, (event) => {
            console.warn("[sanitize]", event);
          }),
        );
      });
      annotationsState = anns;
    };
    annotationsMap.observe(annotationObserver);
    annotationObserver();

    const awarenessMap = ydoc.getMap(Y_MAP_AWARENESS);
    let prevStatus: string | null = null;
    let prevActive = false;
    const awarenessObserver = () => {
      const claude = awarenessMap.get(Y_MAP_CLAUDE) as
        | { status: string; timestamp: number; active: boolean }
        | undefined;
      const newStatus = claude?.status ?? null;
      const newActive = claude?.active ?? false;
      if (newStatus !== prevStatus) {
        prevStatus = newStatus;
        claudeStatus = newStatus;
      }
      if (newActive !== prevActive) {
        prevActive = newActive;
        claudeActive = newActive;
      }
    };
    awarenessMap.observe(awarenessObserver);
    awarenessObserver();

    const documentMetaMap = ydoc.getMap(Y_MAP_DOCUMENT_META);
    let prevReadOnly = false;
    const documentMetaObserver = (event: Y.YMapEvent<unknown>) => {
      // keysChanged guard #1 (preserves original line 128)
      if (!event.keysChanged.has(Y_MAP_READ_ONLY)) return;
      const ro = (documentMetaMap.get(Y_MAP_READ_ONLY) as boolean | undefined) === true;
      if (ro !== prevReadOnly) {
        prevReadOnly = ro;
        readOnly = ro;
      }
    };
    documentMetaMap.observe(documentMetaObserver);
    const initRo = (documentMetaMap.get(Y_MAP_READ_ONLY) as boolean | undefined) === true;
    if (initRo !== prevReadOnly) {
      prevReadOnly = initRo;
      readOnly = initRo;
    }

    return () => {
      annotationsMap.unobserve(annotationObserver);
      awarenessMap.unobserve(awarenessObserver);
      documentMetaMap.unobserve(documentMetaObserver);
    };
  };

  // ---------- handleDocumentList: reconcile tabs from server-broadcast list ----------
  const handleDocumentList = (docList: DocListEntry[], newActiveId: string | null) => {
    const currentTabs = tabsState;
    const existingIds = new Set(currentTabs.map((t) => t.id));
    const serverIds = new Set(docList.map((d) => d.id));

    // Once tabs state catches up, drop pending tracking for IDs that are now real tabs.
    // (In React this happened during render; here we do it on each reconcile.)
    for (const t of currentTabs) {
      pendingIds.delete(t.id);
      pendingProviders.delete(t.id);
    }

    // Clean up orphaned pending providers for docs the server no longer lists.
    for (const [id, pending] of pendingProviders) {
      if (!serverIds.has(id)) {
        tabMetaCleanups.get(id)?.();
        tabMetaCleanups.delete(id);
        pending.provider.destroy();
        pending.ydoc.destroy();
        pendingProviders.delete(id);
        pendingIds.delete(id);
      }
    }

    const toCreate = deduplicateDocList(docList, existingIds, pendingIds);
    const newTabs: OpenTab[] = [];
    for (const doc of toCreate) {
      pendingIds.add(doc.id);

      const ydoc = new Y.Doc();
      const provider = new HocuspocusProvider({
        url: `ws://127.0.0.1:${DEFAULT_WS_PORT}`,
        name: doc.id,
        document: ydoc,
      });
      pendingProviders.set(doc.id, { ydoc, provider });

      const meta = ydoc.getMap(Y_MAP_DOCUMENT_META);
      const metaObserver = (event: Y.YMapEvent<unknown>) => {
        // keysChanged guards #2 + #3 (preserves original line 183)
        if (
          !event.keysChanged.has(Y_MAP_OPEN_DOCUMENTS) &&
          !event.keysChanged.has(Y_MAP_ACTIVE_DOCUMENT_ID)
        )
          return;
        const docs = meta.get(Y_MAP_OPEN_DOCUMENTS) as DocListEntry[] | undefined;
        const active = meta.get(Y_MAP_ACTIVE_DOCUMENT_ID) as string | null | undefined;
        if (docs) handleDocumentList(docs, active ?? null);
      };
      meta.observe(metaObserver);
      tabMetaCleanups.set(doc.id, () => meta.unobserve(metaObserver));

      newTabs.push({ ...doc, ydoc, provider });
    }

    const toRemove = currentTabs.filter((t) => !serverIds.has(t.id));
    for (const t of toRemove) {
      const obs = observers.get(t.id);
      if (obs) {
        obs.cleanup();
        observers.delete(t.id);
      }
      tabMetaCleanups.get(t.id)?.();
      tabMetaCleanups.delete(t.id);
      pendingIds.delete(t.id);
      pendingProviders.delete(t.id);
      t.provider.destroy();
      t.ydoc.destroy();
    }

    const kept = currentTabs.filter((t) => serverIds.has(t.id));
    tabsState = [...kept, ...newTabs];

    // Keep the client's current tab when a *different* tab was closed and the
    // server isn't explicitly requesting a switch.
    if (newActiveId !== null) {
      const prev = activeTabIdState;
      if (prev === null) {
        activeTabIdState = newActiveId;
      } else if (!serverIds.has(prev)) {
        activeTabIdState = newActiveId; // active tab was removed
      } else if (toRemove.length > 0 && newActiveId === prev) {
        // close of another tab — keep current
      } else {
        activeTabIdState = newActiveId;
      }
    }
  };

  // Forward-declared so the bootstrap block (below) can assign and destroy() can call.
  let bootstrapCleanup: (() => void) | null = null;
  let bootstrapProviderRef: HocuspocusProvider | null = null;

  // ---------- Bootstrap (collapsed Effect 1+2: connect bootstrap provider AND wire its observer) ----------
  // Done inline (eager) so the bootstrap provider + observer are guaranteed
  // wired before any active-tab observer effect runs. Mirrors React's effect-
  // order guarantee without relying on Svelte $effect declaration order.
  {
    const ydoc = new Y.Doc();
    const provider = new HocuspocusProvider({
      url: `ws://127.0.0.1:${DEFAULT_WS_PORT}`,
      name: CTRL_ROOM,
      document: ydoc,
    });
    bootstrapYdocState = ydoc;
    bootstrapProviderRef = provider;

    provider.on("status", ({ status }: { status: string }) => {
      connected = status === "connected";
      const known: ConnectionStatus[] = ["connected", "connecting", "disconnected"];
      connectionStatus = known.includes(status as ConnectionStatus)
        ? (status as ConnectionStatus)
        : "connecting";

      if (status === "connected") {
        hadConnection = true;
        reconnectAttempts = 0;
        disconnectedSince = null;
      } else if (status === "disconnected") {
        if (disconnectedSince === null) disconnectedSince = Date.now();
      } else if (status === "connecting") {
        if (hadConnection) reconnectAttempts = reconnectAttempts + 1;
        if (disconnectedSince === null) disconnectedSince = Date.now();
      }
    });

    // Wire bootstrap-doc meta observer (originally Effect 2)
    const meta = ydoc.getMap(Y_MAP_DOCUMENT_META);
    const bootstrapObserver = (event: Y.YMapEvent<unknown>) => {
      // keysChanged guard #4 (preserves original line 275)
      if (event.keysChanged.has(Y_MAP_GENERATION_ID)) {
        const newGenId = meta.get(Y_MAP_GENERATION_ID) as string | undefined;
        if (newGenId && generationId && newGenId !== generationId) {
          console.warn("[Tandem] Server restarted — refreshing documents");
          serverRestarted = true;
          if (restartTimer) clearTimeout(restartTimer);
          restartTimer = setTimeout(() => {
            serverRestarted = false;
          }, 5000);
        }
        if (newGenId) generationId = newGenId;
      }

      // keysChanged guard #5 (preserves original line 286)
      if (
        event.keysChanged.has(Y_MAP_OPEN_DOCUMENTS) ||
        event.keysChanged.has(Y_MAP_ACTIVE_DOCUMENT_ID)
      ) {
        const docs = meta.get(Y_MAP_OPEN_DOCUMENTS) as DocListEntry[] | undefined;
        const active = meta.get(Y_MAP_ACTIVE_DOCUMENT_ID) as string | null | undefined;
        if (docs) handleDocumentList(docs, active ?? null);
      }

      // keysChanged guard #6: annotation store read-only state
      if (event.keysChanged.has(Y_MAP_STORE_READ_ONLY)) {
        storeReadOnly = (meta.get(Y_MAP_STORE_READ_ONLY) as boolean | undefined) === true;
      }
    };
    meta.observe(bootstrapObserver);

    // Initial read — process state that synced before observer was wired
    const initGenId = meta.get(Y_MAP_GENERATION_ID) as string | undefined;
    if (initGenId) generationId = initGenId;
    const initDocs = meta.get(Y_MAP_OPEN_DOCUMENTS) as DocListEntry[] | undefined;
    const initActive = meta.get(Y_MAP_ACTIVE_DOCUMENT_ID) as string | null | undefined;
    if (initDocs) handleDocumentList(initDocs, initActive ?? null);
    storeReadOnly = (meta.get(Y_MAP_STORE_READ_ONLY) as boolean | undefined) === true;

    // Stash bootstrap cleanup for destroy()
    bootstrapCleanup = () => {
      meta.unobserve(bootstrapObserver);
      if (restartTimer) {
        clearTimeout(restartTimer);
        restartTimer = null;
      }
      provider.destroy();
      ydoc.destroy();
      bootstrapYdocState = null;
      bootstrapProviderRef = null;
    };

    ready = true;
  }

  // ---------- Effect: rewire active-tab observers ----------
  // Memoize the active tab via $derived so the effect only re-runs when the
  // active tab's identity changes (tab switch) or its Y.Doc identity changes
  // (Y.Doc swap). Reading `tabsState.find(...)` directly inside the effect
  // would re-run on ANY mutation to `tabsState` (open/close of a non-active
  // tab), tearing down and rebuilding observers unnecessarily.
  const activeTabDerived = $derived(tabsState.find((t) => t.id === activeTabIdState) ?? null);
  const activeYdocDerived = $derived(activeTabDerived?.ydoc ?? null);

  const stopEffects = $effect.root(() => {
    $effect(() => {
      // In current architecture, reload-from-disk replaces the entire tab
      // entry (Y.Doc + provider), so activeTabDerived's identity changes too.
      // The explicit ydoc identity dep below is defensive/future-proof in
      // case a future code path swaps just the Y.Doc reference.
      void activeYdocDerived;
      const activeTab = activeTabDerived;

      // Tear down all current observers (only one is ever attached, but match React semantics).
      for (const obs of observers.values()) obs.cleanup();
      observers.clear();

      if (activeTab) {
        const cleanup = setupTabObservers(activeTab);
        observers.set(activeTab.id, { cleanup });
      } else {
        annotationsState = [];
        claudeStatus = null;
        claudeActive = false;
        readOnly = false;
      }
    });

    // Note: pending-IDs cleanup is handled inside `handleDocumentList` on
    // every reconcile — no separate $effect needed.
  });

  // ---------- Public API methods ----------
  const setActiveTabId = (id: string) => {
    activeTabIdState = id;
  };

  const handleTabClose = (tabId: string) => {
    // Optimistically switch to adjacent tab if closing the active one
    if (activeTabIdState === tabId) {
      const currentTabs = tabsState;
      const idx = currentTabs.findIndex((t) => t.id === tabId);
      const remaining = currentTabs.filter((t) => t.id !== tabId);
      if (remaining.length === 0) {
        activeTabIdState = null;
      } else {
        activeTabIdState = remaining[Math.min(idx, remaining.length - 1)].id;
      }
    }

    // Tell the server to close the document — broadcast reconciles tabs.
    fetch(`http://127.0.0.1:${DEFAULT_MCP_PORT}${API_CLOSE}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ documentId: tabId }),
    })
      .then((res) => {
        if (!res.ok) console.warn("[Tandem] Server rejected close:", res.status);
      })
      .catch((err) => {
        console.warn("[Tandem] Failed to close document on server:", err);
      });
  };

  const destroy = () => {
    if (destroyed) return;
    destroyed = true;
    // Stop the $effect.root scope (tears down both effects)
    stopEffects();
    // Tear down active observers
    for (const obs of observers.values()) obs.cleanup();
    observers.clear();
    // Tear down per-tab meta observers
    for (const cleanup of tabMetaCleanups.values()) cleanup();
    tabMetaCleanups.clear();
    // Destroy pending providers
    for (const pending of pendingProviders.values()) {
      pending.provider.destroy();
      pending.ydoc.destroy();
    }
    pendingProviders.clear();
    pendingIds.clear();
    // Destroy real tab providers
    for (const t of tabsState) {
      t.provider.destroy();
      t.ydoc.destroy();
    }
    // Tear down bootstrap
    bootstrapCleanup?.();
    // Reset reactive state so consumers that still hold the state object
    // post-teardown can't read destroyed Y.Doc references.
    tabsState = [];
    annotationsState = [];
    activeTabIdState = null;
    ready = false;
  };

  return {
    get tabs() {
      return tabsState;
    },
    get activeTabId() {
      return activeTabIdState;
    },
    setActiveTabId,
    handleTabClose,
    get connected() {
      return connected;
    },
    get connectionStatus() {
      return connectionStatus;
    },
    get reconnectAttempts() {
      return reconnectAttempts;
    },
    get disconnectedSince() {
      return disconnectedSince;
    },
    get annotations() {
      return annotationsState;
    },
    get claudeStatus() {
      return claudeStatus;
    },
    get claudeActive() {
      return claudeActive;
    },
    get readOnly() {
      return readOnly;
    },
    get storeReadOnly() {
      return storeReadOnly;
    },
    get bootstrapYdoc() {
      return bootstrapYdocState;
    },
    get ready() {
      return ready;
    },
    get serverRestarted() {
      return serverRestarted;
    },
    destroy,
    reconnect() {
      bootstrapProviderRef?.connect();
      for (const t of tabsState) {
        t.provider.connect();
      }
    },
  };
}
