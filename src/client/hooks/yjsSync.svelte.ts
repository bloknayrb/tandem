import {
  type CompleteHocuspocusProviderWebsocketConfiguration,
  HocuspocusProvider,
  type HocuspocusProviderConfiguration,
} from "@hocuspocus/provider";
import * as Y from "yjs";
import { API_CLOSE, API_INFO, API_RENAME } from "../../shared/api-paths.js";
import {
  CTRL_ROOM,
  DEFAULT_MCP_PORT,
  DEFAULT_WS_PORT,
  Y_MAP_ACTIVE_DOCUMENT_EPOCH,
  Y_MAP_ACTIVE_DOCUMENT_ID,
  Y_MAP_ANNOTATIONS,
  Y_MAP_AWARENESS,
  Y_MAP_CLAUDE,
  Y_MAP_DOCUMENT_META,
  Y_MAP_OPEN_DOCUMENTS,
  Y_MAP_STORE_READ_ONLY,
} from "../../shared/constants";
import { sanitizeAnnotation } from "../../shared/sanitize";
import type { Annotation, ClaudeAwareness } from "../../shared/types";
import type { DocListEntry, OpenTab } from "../types";
import { createRebuildScheduler } from "./rebuild-scheduler.js";
import { resolveActiveTabId } from "./tab-reconcile.js";
import type { SidecarRetryStrategy } from "./useTandemSettings";
import { deduplicateDocList } from "./useYjsSync";

export type ConnectionStatus = "connected" | "connecting" | "disconnected";

/**
 * Map a user-chosen reconnect strategy onto @hocuspocus/provider's
 * websocket backoff knobs. Both strategies keep `maxAttempts: 0` (unlimited) —
 * auto-reconnect must NEVER be disabled, because the stale-tab generation-gate
 * recovery depends on a rejected provider eventually reconnecting and re-sending
 * Auth to trigger `authenticationFailed → scheduleRebuild`. The strategy only
 * changes the backoff *timing*:
 *   - "exponential": mirrors the provider defaults (1s → 30s, factor 2, jitter).
 *   - "constant-2s": a flat 2s retry (factor 1, no jitter).
 * These are forwarded via the provider's `url` branch — at runtime the provider
 * passes its whole config to `new HocuspocusProviderWebsocket(configuration)`,
 * so these keys take effect even though the provider's `url`-branch *type* only
 * advertises `url`/`preserveTrailingSlash` (hence the cast at the call sites).
 * NOTE: this assumes each provider owns its own socket (current design — a bare
 * `url` per provider). If a shared `websocketProvider` is ever introduced, this
 * per-construction config would be silently ignored.
 */
type ReconnectBackoff = Pick<
  CompleteHocuspocusProviderWebsocketConfiguration,
  "delay" | "factor" | "maxAttempts" | "minDelay" | "maxDelay" | "jitter"
>;
export function backoffOptionsFor(strategy: SidecarRetryStrategy): ReconnectBackoff {
  if (strategy === "constant-2s") {
    return {
      delay: 2000,
      factor: 1,
      maxAttempts: 0,
      minDelay: 2000,
      maxDelay: 2000,
      jitter: false,
    };
  }
  // "exponential" (default): provider defaults — 1s base, ×2, capped at 30s.
  return { delay: 1000, factor: 2, maxAttempts: 0, minDelay: 1000, maxDelay: 30000, jitter: true };
}

/**
 * Typing-presence snapshot derived from `ClaudeAwareness.working` (#651).
 * `annotationId` is present only for tools that target a specific annotation
 * (currently `tandem_annotationReply`). Per ADR-027 the server strips note IDs
 * before broadcasting, so consumers never receive a note's ID here.
 */
export type ClaudeWorking = NonNullable<ClaudeAwareness["working"]>;

export interface YjsSyncState {
  readonly tabs: OpenTab[];
  readonly activeTabId: string | null;
  setActiveTabId: (id: string) => void;
  handleTabClose: (id: string) => void;
  handleTabRename: (id: string, newName: string, onError?: (message: string) => void) => void;
  readonly connected: boolean;
  readonly connectionStatus: ConnectionStatus;
  readonly reconnectAttempts: number;
  readonly disconnectedSince: number | null;
  readonly annotations: Annotation[];
  readonly claudeStatus: string | null;
  readonly claudeActive: boolean;
  /** #651: current MCP tool Claude is executing on the active doc, or null. */
  readonly claudeWorking: ClaudeWorking | null;
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
  /**
   * Rebuild all providers to force re-authentication after a license-state
   * change (#1116). Unlike `reconnect()`, this re-runs the server's
   * `onAuthenticate` gate on a live socket so Surface A's read-only clamp is
   * applied/released. See the method body for why a bare reconnect can't.
   */
  rebuildForLicenseChange: () => void;
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
export function createYjsSync(opts?: {
  /**
   * Live getter for the reconnect backoff strategy. Read lazily at each provider
   * construction (post-bootstrap), so a setting change applies to subsequently
   * built providers / the next rebuild — in-flight sockets are not re-wired.
   * Lazy by design: the getter may close over state initialized AFTER this
   * factory is called (e.g. App.svelte builds settings below createYjsSync), and
   * it is only ever invoked after `await fetchGenerationId()`, so the closed-over
   * binding is live by call time.
   */
  getRetryStrategy?: () => SidecarRetryStrategy;
}): YjsSyncState {
  // Merge the current reconnect-strategy backoff into a provider config. The cast
  // is centralized here: the backoff keys forward to the internal websocket at
  // runtime (the provider does `new HocuspocusProviderWebsocket(configuration)`),
  // but the provider's `url`-branch type doesn't advertise them. See backoffOptionsFor.
  const withBackoff = (base: HocuspocusProviderConfiguration): HocuspocusProviderConfiguration =>
    ({
      ...base,
      ...backoffOptionsFor(opts?.getRetryStrategy?.() ?? "exponential"),
    }) as HocuspocusProviderConfiguration;
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
  let claudeWorking = $state<ClaudeWorking | null>(null);
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
  /**
   * The server generation this client is synced against, fetched from
   * GET /api/info (deliberately not broadcast via the ctrl Y.Map — a stale
   * tab's merge-back could clobber a CRDT-carried value). Every provider pins
   * it as its Hocuspocus auth token AT CONSTRUCTION: the token identifies the
   * ydoc's provenance, so a provider whose ydoc predates a server restart
   * keeps presenting the old generation and is rejected before its stale
   * state can merge back.
   */
  let generationId: string | null = null;
  // Last activation epoch applied from the server. Lets handleDocumentList tell a
  // genuine (re)activation (epoch advanced) from a stale re-broadcast of an
  // unchanged active id (epoch same), so the latter never clobbers a local tab
  // switch. Shared across the bootstrap + all per-tab observers (one closure).
  let lastAppliedActiveEpoch: number | null = null;
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
    // Track working as a stringified snapshot so we only assign a new object
    // when it actually changes — avoids retriggering downstream $derived /
    // $effect on every observer call (which fires on any awareness key write,
    // e.g. status updates from `tandem_status`).
    let prevWorkingKey: string | null = null;
    const workingKey = (w: ClaudeAwareness["working"]): string | null => {
      if (!w) return null;
      // Prefer the monotonic `token` (collision-free) as the identity key;
      // fall back to startedAt for snapshots written before #823.
      return `${w.tool} ${w.annotationId ?? ""} ${w.token ?? w.startedAt}`;
    };
    const awarenessObserver = () => {
      const claude = awarenessMap.get(Y_MAP_CLAUDE) as ClaudeAwareness | undefined;
      const newStatus = claude?.status ?? null;
      const newActive = claude?.active ?? false;
      const newWorking = claude?.working ?? null;
      if (newStatus !== prevStatus) {
        prevStatus = newStatus;
        claudeStatus = newStatus;
      }
      if (newActive !== prevActive) {
        prevActive = newActive;
        claudeActive = newActive;
      }
      const newWorkingKey = workingKey(newWorking);
      if (newWorkingKey !== prevWorkingKey) {
        prevWorkingKey = newWorkingKey;
        claudeWorking = newWorking;
      }
    };
    awarenessMap.observe(awarenessObserver);
    awarenessObserver();

    return () => {
      annotationsMap.unobserve(annotationObserver);
      awarenessMap.unobserve(awarenessObserver);
    };
  };

  // ---------- Generation fetch + full-rebuild plumbing (stale-tab resync) ----------
  const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

  /** Fetch the current server generation id, or null if unreachable/absent.
   *  Timeboxed: a half-open server (accepts TCP, never responds) must not
   *  hang the connect/rebuild poll loops forever. */
  const fetchGenerationId = async (): Promise<string | null> => {
    try {
      const res = await fetch(`http://127.0.0.1:${DEFAULT_MCP_PORT}${API_INFO}`, {
        signal: AbortSignal.timeout(5000),
      });
      if (!res.ok) return null;
      const body = (await res.json()) as { generationId?: string | null };
      return body.generationId ?? null;
    } catch {
      return null;
    }
  };

  /** Destroy every per-tab provider/ydoc (active, kept, and pending) and clear
   *  tab state. Deliberately does NOT null `activeTabIdState`: the #842
   *  auto-scratchpad gate (`shouldAutoOpenScratchpad`) requires a null active
   *  id, so keeping the stale id holds that gate closed and prevents a stray
   *  scratchpad from spawning during a >400ms resync window — and the
   *  post-rebuild doc broadcast re-resolves the active tab anyway. */
  const teardownAllTabs = () => {
    for (const obs of observers.values()) obs.cleanup();
    observers.clear();
    for (const cleanup of tabMetaCleanups.values()) cleanup();
    tabMetaCleanups.clear();
    for (const pending of pendingProviders.values()) {
      pending.provider.destroy();
      pending.ydoc.destroy();
    }
    pendingProviders.clear();
    pendingIds.clear();
    for (const t of tabsState) {
      t.provider.destroy();
      t.ydoc.destroy();
    }
    tabsState = [];
  };

  /**
   * authenticationFailed → the server rejected our pinned generation token,
   * i.e. the server restarted and this client's Y.Docs are stale. Re-fetch the
   * generation and rebuild everything (ctrl + tabs) from scratch — fresh empty
   * Y.Docs sync cleanly from the server instead of CRDT-merging stale content
   * back into it. Orchestration (single-flight, microtask deferral, poll loop)
   * lives in createRebuildScheduler so the branches are unit-testable.
   *
   * Note the rejected provider's websocket stays "connected" while denied (the
   * server holds it until a 30s idle close) — provider status events are NOT a
   * health signal here; this event is the only reliable trigger.
   */
  const scheduleRebuild = createRebuildScheduler({
    isDestroyed: () => destroyed,
    fetchGenerationId,
    getPinnedGeneration: () => generationId,
    onGenerationUnchanged: () => {
      // Near-unreachable (/api/info and the gate disagreeing). Nothing to
      // rebuild — and deliberately NO socket cycling here: in
      // @hocuspocus/provider 3.x, disconnect() latches shouldConnect=false
      // and an immediate connect() early-returns while the denied socket
      // still reports "connected", leaving the socket permanently down.
      // Left alone, the server's ~30s idle close fires, the provider
      // auto-reconnects and re-sends Auth — the state self-heals.
      console.warn("[Tandem] Provider auth failed without a generation change");
    },
    rebuild: (gen) => {
      console.warn("[Tandem] Server restarted — resyncing documents");
      teardownAllTabs();
      bootstrapCleanup?.();
      // Banner state set AFTER cleanup (bootstrapCleanup clears restartTimer).
      serverRestarted = true;
      lastAppliedActiveEpoch = null;
      restartTimer = setTimeout(() => {
        serverRestarted = false;
      }, 5000);
      startBootstrap(gen);
    },
    sleep,
  });

  // ---------- handleDocumentList: reconcile tabs from server-broadcast list ----------
  const handleDocumentList = (
    docList: DocListEntry[],
    newActiveId: string | null,
    activeEpoch: number | null,
  ) => {
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
      const provider = new HocuspocusProvider(
        withBackoff({
          url: `ws://127.0.0.1:${DEFAULT_WS_PORT}`,
          name: doc.id,
          document: ydoc,
          // Pinned string, not a closure: if the generation changes after this
          // provider is built, its ydoc is stale and must NOT re-authenticate.
          token: generationId,
        }),
      );
      provider.on("authenticationFailed", scheduleRebuild);
      pendingProviders.set(doc.id, { ydoc, provider });

      const meta = ydoc.getMap(Y_MAP_DOCUMENT_META);
      const metaObserver = (event: Y.YMapEvent<unknown>) => {
        // keysChanged guards #2 + #3 (preserves original line 183). The epoch key
        // is included so the guard can't silently no-op if it is ever written
        // without the active id in the same transaction.
        if (
          !event.keysChanged.has(Y_MAP_OPEN_DOCUMENTS) &&
          !event.keysChanged.has(Y_MAP_ACTIVE_DOCUMENT_ID) &&
          !event.keysChanged.has(Y_MAP_ACTIVE_DOCUMENT_EPOCH)
        )
          return;
        const docs = meta.get(Y_MAP_OPEN_DOCUMENTS) as DocListEntry[] | undefined;
        const active = meta.get(Y_MAP_ACTIVE_DOCUMENT_ID) as string | null | undefined;
        const epoch = meta.get(Y_MAP_ACTIVE_DOCUMENT_EPOCH) as number | null | undefined;
        if (docs) handleDocumentList(docs, active ?? null, epoch ?? null);
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

    // Kept tabs reuse their live ydoc/provider, but refresh the server-owned
    // metadata fields (fileName / filePath / format / readOnly). This matters
    // for in-place promotion: Save As keeps the same documentId/room but
    // rewrites filePath + fileName, so a kept tab must pick up the new basename
    // or the tab title stays stale ("Scratchpad.md").
    const docById = new Map(docList.map((d) => [d.id, d]));
    const kept = currentTabs
      .filter((t) => serverIds.has(t.id))
      .map((t) => {
        const entry = docById.get(t.id);
        if (!entry) return t;
        if (
          entry.fileName === t.fileName &&
          entry.filePath === t.filePath &&
          entry.format === t.format &&
          entry.readOnly === t.readOnly &&
          entry.source === t.source
        ) {
          return t; // no metadata drift — preserve identity to avoid needless rerenders
        }
        return {
          ...t,
          fileName: entry.fileName,
          filePath: entry.filePath,
          format: entry.format,
          readOnly: entry.readOnly,
          // `source` must be refreshed too (#1017): a scratchpad Save-As-to-disk
          // (#827) keeps the same documentId/room but flips source upload→file.
          // Without this, the promoted tab keeps a stale `source: "upload"` and
          // the rename affordance (gated on source === "file") stays disabled
          // until a full reload.
          source: entry.source,
        };
      });
    tabsState = [...kept, ...newTabs];

    // Resolve the active tab. A stale re-broadcast of an unchanged active id
    // (same epoch) must not clobber a local keyboard/click switch; a genuine
    // (re)activation (advanced epoch) applies. See resolveActiveTabId.
    if (newActiveId !== null) {
      activeTabIdState = resolveActiveTabId({
        prev: activeTabIdState,
        serverActiveId: newActiveId,
        serverIds,
        removedCount: toRemove.length,
        serverEpoch: activeEpoch,
        lastAppliedEpoch: lastAppliedActiveEpoch,
      });
      lastAppliedActiveEpoch = activeEpoch;
    }
    // Note: when newActiveId === null (last tab closed) we leave
    // lastAppliedActiveEpoch stale. Harmless: epoch is monotonic, so the next
    // genuine reactivation still satisfies activeEpoch !== lastAppliedActiveEpoch.
  };

  // Forward-declared so startBootstrap (below) can assign and destroy() can call.
  let bootstrapCleanup: (() => void) | null = null;
  let bootstrapProviderRef: HocuspocusProvider | null = null;

  // ---------- Bootstrap: connect ctrl provider AND wire its observer ----------
  // A function (not an inline block) because the authenticationFailed rebuild
  // path re-runs it with the post-restart generation. The first run is gated
  // on fetching the generation from /api/info — the ctrl provider needs the
  // token at construction, and a ctrl Y.Map broadcast can't be the source (a
  // stale tab's merge-back could clobber a CRDT-carried value).
  function startBootstrap(gen: string) {
    generationId = gen;
    const ydoc = new Y.Doc();
    const provider = new HocuspocusProvider(
      withBackoff({
        url: `ws://127.0.0.1:${DEFAULT_WS_PORT}`,
        name: CTRL_ROOM,
        document: ydoc,
        // Pinned string — same provenance rule as tab providers.
        token: gen,
      }),
    );
    bootstrapYdocState = ydoc;
    bootstrapProviderRef = provider;

    provider.on("authenticationFailed", scheduleRebuild);
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

    // Wire bootstrap-doc meta observer. Guard #4 (generation-id key) is gone:
    // restart detection moved to the authenticationFailed → scheduleRebuild
    // path, which a stale tab cannot miss (the server gate rejects it) and a
    // stale merge cannot clobber (it never reads the map's generation value).
    const meta = ydoc.getMap(Y_MAP_DOCUMENT_META);
    const bootstrapObserver = (event: Y.YMapEvent<unknown>) => {
      // keysChanged guard #5 (preserves original line 286). Epoch key included so
      // the guard can't silently no-op if it is ever written alone.
      if (
        event.keysChanged.has(Y_MAP_OPEN_DOCUMENTS) ||
        event.keysChanged.has(Y_MAP_ACTIVE_DOCUMENT_ID) ||
        event.keysChanged.has(Y_MAP_ACTIVE_DOCUMENT_EPOCH)
      ) {
        const docs = meta.get(Y_MAP_OPEN_DOCUMENTS) as DocListEntry[] | undefined;
        const active = meta.get(Y_MAP_ACTIVE_DOCUMENT_ID) as string | null | undefined;
        const epoch = meta.get(Y_MAP_ACTIVE_DOCUMENT_EPOCH) as number | null | undefined;
        if (docs) handleDocumentList(docs, active ?? null, epoch ?? null);
      }

      // keysChanged guard #6: annotation store read-only state
      if (event.keysChanged.has(Y_MAP_STORE_READ_ONLY)) {
        storeReadOnly = (meta.get(Y_MAP_STORE_READ_ONLY) as boolean | undefined) === true;
      }
    };
    meta.observe(bootstrapObserver);

    // Initial read — process state that synced before observer was wired
    const initDocs = meta.get(Y_MAP_OPEN_DOCUMENTS) as DocListEntry[] | undefined;
    const initActive = meta.get(Y_MAP_ACTIVE_DOCUMENT_ID) as string | null | undefined;
    const initEpoch = meta.get(Y_MAP_ACTIVE_DOCUMENT_EPOCH) as number | null | undefined;
    if (initDocs) handleDocumentList(initDocs, initActive ?? null, initEpoch ?? null);
    storeReadOnly = (meta.get(Y_MAP_STORE_READ_ONLY) as boolean | undefined) === true;

    // Stash bootstrap cleanup for destroy() and the rebuild path
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
      bootstrapCleanup = null;
    };

    ready = true;
  }

  // Initial connect: fetch the generation, then bootstrap. If the server is
  // down at launch, flip `ready` + "disconnected" after the first failed
  // attempt so the normal chrome and ConnectionBanner render (matching the
  // old eager-bootstrap behavior) instead of a bare "Connecting…" screen —
  // every `ready` consumer is reactive and null-guards `bootstrapYdoc`. The
  // poll keeps running and bootstraps the moment the server answers.
  void (async () => {
    while (!destroyed) {
      const gen = await fetchGenerationId();
      if (destroyed) return;
      if (gen) {
        startBootstrap(gen);
        return;
      }
      ready = true;
      connectionStatus = "disconnected";
      connected = false;
      if (disconnectedSince === null) disconnectedSince = Date.now();
      await sleep(1000);
    }
  })();

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
        claudeWorking = null;
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

  const handleTabRename = (tabId: string, newName: string, onError?: (message: string) => void) => {
    const target = tabsState.find((t) => t.id === tabId);
    if (!target) return;
    const prevFileName = target.fileName;

    // Optimistically update the visible label by reassigning the array with a
    // fresh tab object — matching the reassign style handleDocumentList uses.
    // The server broadcast reconciles fileName + filePath authoritatively (the
    // metadata-drift path in handleDocumentList); on failure we revert + toast.
    const renameLocal = (name: string) =>
      tabsState.map((t) => (t.id === tabId ? { ...t, fileName: name } : t));
    tabsState = renameLocal(newName);

    const revert = (message: string) => {
      tabsState = renameLocal(prevFileName);
      onError?.(message);
    };

    fetch(`http://127.0.0.1:${DEFAULT_MCP_PORT}${API_RENAME}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ documentId: tabId, newName }),
    })
      .then(async (res) => {
        if (res.ok) return;
        let message = `Rename failed (${res.status}).`;
        try {
          const body = (await res.json()) as { message?: string };
          if (body?.message) message = body.message;
        } catch {
          // non-JSON body — keep the status-code message
        }
        console.warn("[Tandem] Server rejected rename:", res.status, message);
        revert(message);
      })
      .catch((err) => {
        console.warn("[Tandem] Failed to rename document on server:", err);
        revert("Rename failed: could not reach the server.");
      });
  };

  const destroy = () => {
    if (destroyed) return;
    destroyed = true;
    // Stop the $effect.root scope (tears down both effects)
    stopEffects();
    // Tear down every per-tab observer + provider/ydoc (also resets tabsState)
    teardownAllTabs();
    // Tear down bootstrap
    bootstrapCleanup?.();
    // Reset reactive state so consumers that still hold the state object
    // post-teardown can't read destroyed Y.Doc references.
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
    handleTabRename,
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
    get claudeWorking() {
      return claudeWorking;
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
    /**
     * Force every provider to re-authenticate after a license-state change
     * (#1116, ADR-040 Surface A). `reconnect()` above is a no-op on a live
     * socket — in @hocuspocus/provider 3.x `connect()` early-returns when the
     * status is already Connected — so it cannot make the server re-run
     * `onAuthenticate` and re-evaluate `connection.readOnly` for already-open
     * documents. Tearing down and re-bootstrapping creates fresh sockets that
     * re-send Auth, so the server's gate clamps document rooms to read-only on
     * trial→restricted and releases them on restricted→licensed.
     *
     * Reuses the server-restart rebuild primitives (`teardownAllTabs` +
     * `startBootstrap`) but with the CURRENT pinned generation (no generation
     * change) and without the "server restarted" banner. It does NOT touch
     * `disconnect()` — a sync disconnect()+connect() on a healthy socket
     * latches `shouldConnect=false` and wedges it (see scheduleRebuild's
     * onGenerationUnchanged note). Inert in dark builds: the only caller (the
     * license store's onTransition) never fires unless the gate is active.
     */
    rebuildForLicenseChange() {
      if (destroyed) return;
      const gen = generationId;
      if (gen === null) return; // not bootstrapped yet — nothing to re-auth
      teardownAllTabs();
      bootstrapCleanup?.();
      lastAppliedActiveEpoch = null;
      startBootstrap(gen);
    },
  };
}
