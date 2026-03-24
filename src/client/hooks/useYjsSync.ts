import { useState, useRef, useCallback, useEffect } from "react";
import * as Y from "yjs";
import { HocuspocusProvider } from "@hocuspocus/provider";
import { DEFAULT_WS_PORT } from "../../shared/constants";
import type { Annotation } from "../../shared/types";
import type { DocListEntry, OpenTab } from "../types";

export interface YjsSyncResult {
  tabs: OpenTab[];
  activeTabId: string | null;
  setActiveTabId: (id: string) => void;
  handleTabClose: (id: string) => void;
  connected: boolean;
  annotations: Annotation[];
  claudeStatus: string | null;
  claudeActive: boolean;
  readOnly: boolean;
  bootstrapYdoc: Y.Doc | null;
  ready: boolean;
}

export function useYjsSync(): YjsSyncResult {
  const [tabs, setTabs] = useState<OpenTab[]>([]);
  const [activeTabId, setActiveTabId] = useState<string | null>(null);
  const [connected, setConnected] = useState(false);
  const [annotations, setAnnotations] = useState<Annotation[]>([]);
  const [claudeStatus, setClaudeStatus] = useState<string | null>(null);
  const [claudeActive, setClaudeActive] = useState(false);
  const [readOnly, setReadOnly] = useState(false);
  const [ready, setReady] = useState(false);

  const bootstrapRef = useRef<{ ydoc: Y.Doc; provider: HocuspocusProvider } | null>(null);
  const tabsRef = useRef<OpenTab[]>([]);
  tabsRef.current = tabs;
  const observersRef = useRef<Map<string, { cleanup: () => void }>>(new Map());
  const tabMetaCleanupsRef = useRef<Map<string, () => void>>(new Map());
  const handleDocumentListRef =
    useRef<(docList: DocListEntry[], newActiveId: string | null) => void>();

  /** Wire annotation, awareness, documentMeta observers for the active tab. Returns cleanup fn. */
  const setupTabObservers = useCallback((tab: OpenTab) => {
    const { ydoc } = tab;

    const annotationsMap = ydoc.getMap("annotations");
    const annotationObserver = () => {
      const anns: Annotation[] = [];
      annotationsMap.forEach((value) => {
        anns.push(value as Annotation);
      });
      setAnnotations(anns);
    };
    annotationsMap.observe(annotationObserver);
    annotationObserver();

    const awarenessMap = ydoc.getMap("awareness");
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

    const documentMetaMap = ydoc.getMap("documentMeta");
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

    const newTabs: OpenTab[] = [];
    for (const doc of docList) {
      if (!existingIds.has(doc.id)) {
        const ydoc = new Y.Doc();
        const provider = new HocuspocusProvider({
          url: `ws://localhost:${DEFAULT_WS_PORT}`,
          name: doc.id,
          document: ydoc,
        });

        const meta = ydoc.getMap("documentMeta");
        const metaObserver = () => {
          const docs = meta.get("openDocuments") as DocListEntry[] | undefined;
          const active = meta.get("activeDocumentId") as string | null | undefined;
          if (docs) handleDocumentListRef.current?.(docs, active ?? null);
        };
        meta.observe(metaObserver);
        tabMetaCleanupsRef.current.set(doc.id, () => meta.unobserve(metaObserver));

        newTabs.push({ ...doc, ydoc, provider });
      }
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
      name: "__tandem_ctrl__",
      document: ydoc,
    });
    bootstrapRef.current = { ydoc, provider };

    provider.on("status", ({ status }: { status: string }) => {
      setConnected(status === "connected");
    });

    setReady(true);

    return () => {
      provider.destroy();
      ydoc.destroy();
      bootstrapRef.current = null;
    };
  }, []);

  // Observe bootstrap doc for openDocuments broadcasts.
  // Uses [] because bootstrapRef.current is guaranteed populated by the effect above
  // (effects run in declaration order within a component/hook).
  useEffect(() => {
    if (!bootstrapRef.current) return;
    const meta = bootstrapRef.current.ydoc.getMap("documentMeta");
    const observer = () => {
      const docs = meta.get("openDocuments") as DocListEntry[] | undefined;
      const active = meta.get("activeDocumentId") as string | null | undefined;
      if (docs) handleDocumentListRef.current?.(docs, active ?? null);
    };
    meta.observe(observer);
    observer();
    return () => meta.unobserve(observer);
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
    setActiveTabId((prev) => {
      if (prev !== tabId) return prev;
      const remaining = tabsRef.current.filter((t) => t.id !== tabId);
      return remaining.length > 0 ? remaining[0].id : null;
    });
  }, []);

  return {
    tabs,
    activeTabId,
    setActiveTabId,
    handleTabClose,
    connected,
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
  };
}
