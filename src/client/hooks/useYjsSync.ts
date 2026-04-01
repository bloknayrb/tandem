import { useState, useRef, useCallback, useEffect } from "react";
import * as Y from "yjs";
import { HocuspocusProvider } from "@hocuspocus/provider";
import {
  DEFAULT_WS_PORT,
  DEFAULT_MCP_PORT,
  CTRL_ROOM,
  Y_MAP_ANNOTATIONS,
  Y_MAP_AWARENESS,
  Y_MAP_DOCUMENT_META,
} from "../../shared/constants";
import type { Annotation } from "../../shared/types";
import type { DocListEntry, OpenTab } from "../types";

/** Filter a document list to only docs not already represented in tabs or pending creation. */
export function deduplicateDocList(
  docList: DocListEntry[],
  existingIds: Set<string>,
  pendingIds: Set<string>,
): DocListEntry[] {
  return docList.filter((d) => !existingIds.has(d.id) && !pendingIds.has(d.id));
}

export type ConnectionStatus = "connected" | "connecting" | "disconnected";

export interface YjsSyncResult {
  tabs: OpenTab[];
  activeTabId: string | null;
  setActiveTabId: (id: string) => void;
  handleTabClose: (id: string) => void;
  connected: boolean;
  connectionStatus: ConnectionStatus;
  reconnectAttempts: number;
  disconnectedSince: number | null;
  annotations: Annotation[];
  claudeStatus: string | null;
  claudeActive: boolean;
  readOnly: boolean;
  bootstrapYdoc: Y.Doc | null;
  ready: boolean;
  /** Briefly true after the server restarts and the client reconnects. */
  serverRestarted: boolean;
}

export function useYjsSync(): YjsSyncResult {
  const [tabs, setTabs] = useState<OpenTab[]>([]);
  const [activeTabId, setActiveTabId] = useState<string | null>(null);
  const [connected, setConnected] = useState(false);
  const [connectionStatus, setConnectionStatus] = useState<ConnectionStatus>("connecting");
  const [reconnectAttempts, setReconnectAttempts] = useState(0);
  const [disconnectedSince, setDisconnectedSince] = useState<number | null>(null);
  const [annotations, setAnnotations] = useState<Annotation[]>([]);
  const [claudeStatus, setClaudeStatus] = useState<string | null>(null);
  const [claudeActive, setClaudeActive] = useState(false);
  const [readOnly, setReadOnly] = useState(false);
  const [ready, setReady] = useState(false);
  const [serverRestarted, setServerRestarted] = useState(false);
  const restartTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** Track whether we've ever connected — don't count initial connection attempt as a reconnect. */
  const hadConnectionRef = useRef(false);

  const bootstrapRef = useRef<{ ydoc: Y.Doc; provider: HocuspocusProvider } | null>(null);
  const generationIdRef = useRef<string | null>(null);
  const tabsRef = useRef<OpenTab[]>([]);
  tabsRef.current = tabs;

  // Synchronous dedup guards — prevent duplicate provider creation when multiple
  // Yjs observers fire before React re-renders (tabsRef would still be stale).
  const pendingIdsRef = useRef<Set<string>>(new Set());
  const pendingProvidersRef = useRef<Map<string, { ydoc: Y.Doc; provider: HocuspocusProvider }>>(
    new Map(),
  );
  // Once tabs state catches up, clear pending tracking for IDs that are now real tabs
  for (const t of tabs) {
    pendingIdsRef.current.delete(t.id);
    pendingProvidersRef.current.delete(t.id);
  }

  const observersRef = useRef<Map<string, { cleanup: () => void }>>(new Map());
  const tabMetaCleanupsRef = useRef<Map<string, () => void>>(new Map());
  const handleDocumentListRef =
    useRef<(docList: DocListEntry[], newActiveId: string | null) => void>(undefined);

  /** Wire annotation, awareness, documentMeta observers for the active tab. Returns cleanup fn. */
  const setupTabObservers = useCallback((tab: OpenTab) => {
    const { ydoc } = tab;

    const annotationsMap = ydoc.getMap(Y_MAP_ANNOTATIONS);
    const annotationObserver = () => {
      const anns: Annotation[] = [];
      annotationsMap.forEach((value) => {
        anns.push(value as Annotation);
      });
      setAnnotations(anns);
    };
    annotationsMap.observe(annotationObserver);
    annotationObserver();

    const awarenessMap = ydoc.getMap(Y_MAP_AWARENESS);
    let prevStatus: string | null = null;
    let prevActive = false;
    const awarenessObserver = () => {
      const claude = awarenessMap.get("claude") as
        | { status: string; timestamp: number; active: boolean }
        | undefined;
      const newStatus = claude?.status ?? null;
      const newActive = claude?.active ?? false;
      if (newStatus !== prevStatus) {
        prevStatus = newStatus;
        setClaudeStatus(newStatus);
      }
      if (newActive !== prevActive) {
        prevActive = newActive;
        setClaudeActive(newActive);
      }
    };
    awarenessMap.observe(awarenessObserver);
    awarenessObserver();

    const documentMetaMap = ydoc.getMap(Y_MAP_DOCUMENT_META);
    let prevReadOnly = false;
    const documentMetaObserver = () => {
      const ro = (documentMetaMap.get("readOnly") as boolean | undefined) === true;
      if (ro !== prevReadOnly) {
        prevReadOnly = ro;
        setReadOnly(ro);
      }
    };
    documentMetaMap.observe(documentMetaObserver);
    documentMetaObserver();

    return () => {
      annotationsMap.unobserve(annotationObserver);
      awarenessMap.unobserve(awarenessObserver);
      documentMetaMap.unobserve(documentMetaObserver);
    };
  }, []);

  /** Sync tabs from server-broadcast 'openDocuments' list. */
  handleDocumentListRef.current = (docList: DocListEntry[], newActiveId: string | null) => {
    const currentTabs = tabsRef.current;
    const existingIds = new Set(currentTabs.map((t) => t.id));
    const serverIds = new Set(docList.map((d) => d.id));

    // Clean up orphaned pending providers for docs the server no longer lists.
    // Deleting during Map for...of iteration is safe per the JS spec.
    for (const [id, pending] of pendingProvidersRef.current) {
      if (!serverIds.has(id)) {
        tabMetaCleanupsRef.current.get(id)?.();
        tabMetaCleanupsRef.current.delete(id);
        pending.provider.destroy();
        pending.ydoc.destroy();
        pendingProvidersRef.current.delete(id);
        pendingIdsRef.current.delete(id);
      }
    }

    const toCreate = deduplicateDocList(docList, existingIds, pendingIdsRef.current);
    const newTabs: OpenTab[] = [];
    for (const doc of toCreate) {
      pendingIdsRef.current.add(doc.id);

      const ydoc = new Y.Doc();
      const provider = new HocuspocusProvider({
        url: `ws://localhost:${DEFAULT_WS_PORT}`,
        name: doc.id,
        document: ydoc,
      });
      pendingProvidersRef.current.set(doc.id, { ydoc, provider });

      const meta = ydoc.getMap(Y_MAP_DOCUMENT_META);
      const metaObserver = () => {
        const docs = meta.get("openDocuments") as DocListEntry[] | undefined;
        const active = meta.get("activeDocumentId") as string | null | undefined;
        if (docs) handleDocumentListRef.current?.(docs, active ?? null);
      };
      meta.observe(metaObserver);
      tabMetaCleanupsRef.current.set(doc.id, () => meta.unobserve(metaObserver));

      newTabs.push({ ...doc, ydoc, provider });
    }

    const toRemove = currentTabs.filter((t) => !serverIds.has(t.id));
    for (const t of toRemove) {
      const obs = observersRef.current.get(t.id);
      if (obs) {
        obs.cleanup();
        observersRef.current.delete(t.id);
      }
      tabMetaCleanupsRef.current.get(t.id)?.();
      tabMetaCleanupsRef.current.delete(t.id);
      pendingIdsRef.current.delete(t.id);
      pendingProvidersRef.current.delete(t.id);
      t.provider.destroy();
      t.ydoc.destroy();
    }

    setTabs((prevTabs) => {
      const kept = prevTabs.filter((t) => serverIds.has(t.id));
      return [...kept, ...newTabs];
    });

    if (newActiveId !== null) setActiveTabId(newActiveId);
  };

  // Bootstrap connection — coordinates document list.
  // NOTE: bootstrapRef is populated synchronously inside this effect before setReady(true).
  // The observer effect below uses [] and runs after this one (React guarantees effect order
  // within a component), so bootstrapRef.current is always set when the observer effect runs.
  useEffect(() => {
    const ydoc = new Y.Doc();
    const provider = new HocuspocusProvider({
      url: `ws://localhost:${DEFAULT_WS_PORT}`,
      name: CTRL_ROOM,
      document: ydoc,
    });
    bootstrapRef.current = { ydoc, provider };

    provider.on("status", ({ status }: { status: string }) => {
      setConnected(status === "connected");
      setConnectionStatus(status as ConnectionStatus);

      if (status === "connected") {
        hadConnectionRef.current = true;
        setReconnectAttempts(0);
        setDisconnectedSince(null);
      } else if (status === "disconnected") {
        setDisconnectedSince((prev) => prev ?? Date.now());
      } else if (status === "connecting") {
        // Only count reconnection attempts after the first successful connection
        if (hadConnectionRef.current) {
          setReconnectAttempts((prev) => prev + 1);
        }
        setDisconnectedSince((prev) => prev ?? Date.now());
      }
    });

    setReady(true);

    return () => {
      provider.destroy();
      ydoc.destroy();
      bootstrapRef.current = null;
    };
  }, []);

  // Observe bootstrap doc for openDocuments broadcasts and server restart detection.
  // Uses [] because bootstrapRef.current is guaranteed populated by the effect above
  // (effects run in declaration order within a component/hook).
  useEffect(() => {
    if (!bootstrapRef.current) return;
    const meta = bootstrapRef.current.ydoc.getMap(Y_MAP_DOCUMENT_META);
    const observer = () => {
      // Detect server restart via generationId change
      const newGenId = meta.get("generationId") as string | undefined;
      if (newGenId && generationIdRef.current && newGenId !== generationIdRef.current) {
        console.warn("[Tandem] Server restarted — refreshing documents");
        setServerRestarted(true);
        if (restartTimerRef.current) clearTimeout(restartTimerRef.current);
        restartTimerRef.current = setTimeout(() => setServerRestarted(false), 5000);
      }
      if (newGenId) generationIdRef.current = newGenId;

      const docs = meta.get("openDocuments") as DocListEntry[] | undefined;
      const active = meta.get("activeDocumentId") as string | null | undefined;
      if (docs) handleDocumentListRef.current?.(docs, active ?? null);
    };
    meta.observe(observer);
    observer();
    return () => {
      meta.unobserve(observer);
      if (restartTimerRef.current) clearTimeout(restartTimerRef.current);
    };
  }, []);

  // Rewire observers when active tab changes
  useEffect(() => {
    for (const obs of observersRef.current.values()) obs.cleanup();
    observersRef.current.clear();

    const activeTab = tabsRef.current.find((t) => t.id === activeTabId);
    if (activeTab) {
      const cleanup = setupTabObservers(activeTab);
      observersRef.current.set(activeTab.id, { cleanup });
    } else {
      setAnnotations([]);
      setClaudeStatus(null);
      setClaudeActive(false);
      setReadOnly(false);
    }
  }, [activeTabId, setupTabObservers]);

  const handleTabClose = useCallback((tabId: string) => {
    // Optimistically switch to adjacent tab if closing the active one
    setActiveTabId((prev) => {
      if (prev !== tabId) return prev;
      const currentTabs = tabsRef.current;
      const idx = currentTabs.findIndex((t) => t.id === tabId);
      const remaining = currentTabs.filter((t) => t.id !== tabId);
      if (remaining.length === 0) return null;
      // Prefer next tab; fall back to previous
      return remaining[Math.min(idx, remaining.length - 1)].id;
    });

    // Tell the server to close the document — the broadcast will reconcile tabs
    fetch(`http://localhost:${DEFAULT_MCP_PORT}/api/close`, {
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
  }, []);

  return {
    tabs,
    activeTabId,
    setActiveTabId,
    handleTabClose,
    connected,
    connectionStatus,
    reconnectAttempts,
    disconnectedSince,
    annotations,
    claudeStatus,
    claudeActive,
    readOnly,
    // bootstrapRef.current is null before the first render completes (effects run after render).
    // The ready flag is set by the same effect that populates bootstrapRef, so the re-render
    // triggered by setReady(true) ensures bootstrapYdoc is non-null by the time App.tsx
    // renders past the `if (!ready)` guard.
    bootstrapYdoc: bootstrapRef.current?.ydoc ?? null,
    ready,
    serverRestarted,
  };
}
