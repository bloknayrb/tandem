import React, { useState, useRef, useCallback, useEffect, useMemo } from "react";
import type { Editor as TiptapEditor } from "@tiptap/react";
import * as Y from "yjs";
import { HocuspocusProvider } from "@hocuspocus/provider";
import { Editor } from "./editor/Editor";
import { SidePanel } from "./panels/SidePanel";
import { ChatPanel } from "./panels/ChatPanel";
import { StatusBar } from "./status/StatusBar";
import { Toolbar } from "./editor/toolbar/Toolbar";
import { DocumentTabs } from "./tabs/DocumentTabs";
import { ReviewSummary } from "./panels/ReviewSummary";
import {
  DEFAULT_WS_PORT,
  INTERRUPTION_MODE_DEFAULT,
  INTERRUPTION_MODE_KEY,
  REVIEW_BANNER_THRESHOLD,
} from "../shared/constants";
import type { Annotation, InterruptionMode } from "../shared/types";
import { InterruptionModeSchema } from "../shared/types";
import { useAnnotationGate } from "./hooks/useAnnotationGate";
import type { DocListEntry, OpenTab } from "./types";

export type { DocListEntry, OpenTab };

export default function App() {
  const [tabs, setTabs] = useState<OpenTab[]>([]);
  const [activeTabId, setActiveTabId] = useState<string | null>(null);
  const [connected, setConnected] = useState(false);
  const [annotations, setAnnotations] = useState<Annotation[]>([]);

  // Interruption mode — persisted to localStorage
  const [interruptionMode, setInterruptionMode] = useState<InterruptionMode>(() => {
    const saved = localStorage.getItem(INTERRUPTION_MODE_KEY);
    return InterruptionModeSchema.safeParse(saved).success
      ? (saved as InterruptionMode)
      : INTERRUPTION_MODE_DEFAULT;
  });
  useEffect(() => {
    localStorage.setItem(INTERRUPTION_MODE_KEY, interruptionMode);
  }, [interruptionMode]);

  const { visibleAnnotations, heldCount } = useAnnotationGate(annotations, interruptionMode);
  const [claudeStatus, setClaudeStatus] = useState<string | null>(null);
  const [claudeActive, setClaudeActive] = useState(false);
  const [readOnly, setReadOnly] = useState(false);
  const [ready, setReady] = useState(false);
  const [showReviewSummary, setShowReviewSummary] = useState(false);
  const [reviewSummaryData, setReviewSummaryData] = useState<{
    accepted: number;
    dismissed: number;
    total: number;
  } | null>(null);
  const [reviewMode, setReviewMode] = useState(false);
  const [showBanner, setShowBanner] = useState(false);
  const [showChat, setShowChat] = useState(false);
  const [activeAnnotationId, setActiveAnnotationId] = useState<string | null>(null);
  const [, setEditorVersion] = useState(0);

  const editorRef = useRef<TiptapEditor | null>(null);
  const prevPendingRef = useRef<number>(0);
  const observersRef = useRef<Map<string, { cleanup: () => void }>>(new Map());
  const tabsRef = useRef<OpenTab[]>([]);
  tabsRef.current = tabs;

  const handleEditorReady = useCallback((editor: TiptapEditor | null) => {
    editorRef.current = editor;
    if (editor) setEditorVersion((v) => v + 1);
  }, []);

  /** Set up observers for a tab's Y.Doc. Returns cleanup function. */
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
        | {
            status: string;
            timestamp: number;
            active: boolean;
          }
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

  /**
   * Bootstrap connection to coordinate document list.
   * Uses '__tandem_ctrl__' room to avoid collision with document IDs.
   */
  const bootstrapRef = useRef<{ ydoc: Y.Doc; provider: HocuspocusProvider } | null>(null);

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

  /**
   * Sync tabs from server-broadcast 'openDocuments' list.
   * Allocations happen outside the setTabs updater to be StrictMode-safe.
   */
  const handleDocumentListRef =
    useRef<(docList: DocListEntry[], newActiveId: string | null) => void>();
  handleDocumentListRef.current = (docList: DocListEntry[], newActiveId: string | null) => {
    const currentTabs = tabsRef.current;
    const existingIds = new Set(currentTabs.map((t) => t.id));
    const serverIds = new Set(docList.map((d) => d.id));

    // Allocate new tabs outside the updater (StrictMode-safe)
    const newTabs: OpenTab[] = [];
    for (const doc of docList) {
      if (!existingIds.has(doc.id)) {
        const ydoc = new Y.Doc();
        const provider = new HocuspocusProvider({
          url: `ws://localhost:${DEFAULT_WS_PORT}`,
          name: doc.id,
          document: ydoc,
        });

        // Listen for openDocuments broadcasts on this doc's meta
        const meta = ydoc.getMap("documentMeta");
        meta.observe(() => {
          const docs = meta.get("openDocuments") as DocListEntry[] | undefined;
          const active = meta.get("activeDocumentId") as string | null | undefined;
          if (docs) {
            handleDocumentListRef.current?.(docs, active ?? null);
          }
        });

        newTabs.push({ ...doc, ydoc, provider });
      }
    }

    // Remove closed tabs (cleanup outside updater)
    const toRemove = currentTabs.filter((t) => !serverIds.has(t.id));
    for (const t of toRemove) {
      const obs = observersRef.current.get(t.id);
      if (obs) {
        obs.cleanup();
        observersRef.current.delete(t.id);
      }
      t.provider.destroy();
      t.ydoc.destroy();
    }

    setTabs((prevTabs) => {
      const kept = prevTabs.filter((t) => serverIds.has(t.id));
      return [...kept, ...newTabs];
    });

    if (newActiveId !== null) {
      setActiveTabId(newActiveId);
    }
  };

  // Listen on the bootstrap doc for document list broadcasts
  useEffect(() => {
    if (!bootstrapRef.current) return;
    const meta = bootstrapRef.current.ydoc.getMap("documentMeta");
    const observer = () => {
      const docs = meta.get("openDocuments") as DocListEntry[] | undefined;
      const active = meta.get("activeDocumentId") as string | null | undefined;
      if (docs) {
        handleDocumentListRef.current?.(docs, active ?? null);
      }
    };
    meta.observe(observer);
    observer(); // Handle data already present from initial sync
    return () => meta.unobserve(observer);
  }, []);

  // When active tab changes, rewire observers (use tabsRef to avoid tabs dep)
  useEffect(() => {
    for (const obs of observersRef.current.values()) {
      obs.cleanup();
    }
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

  // Detect review completion: all pending -> 0 while resolved > 0 (single pass)
  useEffect(() => {
    let pending = 0,
      accepted = 0,
      dismissed = 0;
    for (const a of annotations) {
      if (a.status === "pending") pending++;
      else if (a.status === "accepted") accepted++;
      else dismissed++;
    }
    const total = accepted + dismissed;

    if (prevPendingRef.current > 0 && pending === 0 && total > 0) {
      setReviewSummaryData({ accepted, dismissed, total });
      setShowReviewSummary(true);
    }
    prevPendingRef.current = pending;
  }, [annotations]);

  const pendingCount = useMemo(
    () => annotations.filter((a) => a.status === "pending").length,
    [annotations],
  );

  // Show banner when pending annotations exceed threshold
  useEffect(() => {
    if (pendingCount >= REVIEW_BANNER_THRESHOLD && !reviewMode) {
      setShowBanner(true);
    }
    if (pendingCount === 0) {
      setShowBanner(false);
    }
  }, [pendingCount, reviewMode]);

  const toggleReviewMode = useCallback(() => {
    setReviewMode((prev) => !prev);
    setShowBanner(false);
  }, []);

  const exitReviewMode = useCallback(() => {
    setReviewMode(false);
    setShowBanner(false);
  }, []);

  const handleTabSwitch = useCallback((tabId: string) => {
    setActiveTabId(tabId);
  }, []);

  const handleTabClose = useCallback((tabId: string) => {
    setActiveTabId((prev) => {
      if (prev !== tabId) return prev;
      const remaining = tabsRef.current.filter((t) => t.id !== tabId);
      return remaining.length > 0 ? remaining[0].id : null;
    });
  }, []);

  const activeTab = tabs.find((t) => t.id === activeTabId);

  if (!ready) {
    return (
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          height: "100vh",
          color: "#9ca3af",
        }}
      >
        Connecting...
      </div>
    );
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100vh" }}>
      <Toolbar editor={editorRef.current} ydoc={activeTab?.ydoc ?? null} />
      {tabs.length > 0 && (
        <DocumentTabs
          tabs={tabs}
          activeTabId={activeTabId}
          onTabSwitch={handleTabSwitch}
          onTabClose={handleTabClose}
        />
      )}
      {showBanner && !reviewMode && (
        <div
          style={{
            padding: "8px 16px",
            background: "#eef2ff",
            borderBottom: "1px solid #c7d2fe",
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            fontSize: "13px",
            color: "#4338ca",
          }}
        >
          <span>{pendingCount} annotations pending review.</span>
          <div style={{ display: "flex", gap: "8px" }}>
            <button
              onClick={toggleReviewMode}
              style={{
                padding: "3px 10px",
                fontSize: "12px",
                border: "1px solid #6366f1",
                borderRadius: "4px",
                background: "#6366f1",
                color: "white",
                cursor: "pointer",
                fontWeight: 500,
              }}
            >
              Review in sequence
            </button>
            <button
              onClick={() => setShowBanner(false)}
              style={{
                padding: "3px 10px",
                fontSize: "12px",
                border: "1px solid #d1d5db",
                borderRadius: "4px",
                background: "white",
                color: "#6b7280",
                cursor: "pointer",
              }}
            >
              Dismiss
            </button>
          </div>
        </div>
      )}
      <div style={{ display: "flex", flex: 1, overflow: "hidden" }}>
        <div style={{ flex: 1, overflow: "auto", padding: "24px 48px" }}>
          {activeTab ? (
            <Editor
              key={activeTab.id}
              ydoc={activeTab.ydoc}
              provider={activeTab.provider}
              readOnly={readOnly}
              reviewMode={reviewMode}
              activeAnnotationId={activeAnnotationId}
              onConnectionChange={setConnected}
              onEditorReady={handleEditorReady}
            />
          ) : (
            <div
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                height: "100%",
                color: "#9ca3af",
              }}
            >
              No document open. Use Claude to open a file with tandem_open.
            </div>
          )}
        </div>
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            width: "300px",
            borderLeft: "1px solid #e5e7eb",
          }}
        >
          {/* Panel toggle tabs */}
          <div
            style={{
              display: "flex",
              borderBottom: "1px solid #e5e7eb",
              background: "#f9fafb",
            }}
          >
            <button
              onClick={() => setShowChat(false)}
              style={{
                flex: 1,
                padding: "8px",
                fontSize: "12px",
                fontWeight: showChat ? 400 : 600,
                border: "none",
                borderBottom: showChat ? "none" : "2px solid #6366f1",
                background: "transparent",
                cursor: "pointer",
                color: showChat ? "#6b7280" : "#6366f1",
              }}
            >
              Annotations
            </button>
            <button
              onClick={() => setShowChat(true)}
              style={{
                flex: 1,
                padding: "8px",
                fontSize: "12px",
                fontWeight: showChat ? 600 : 400,
                border: "none",
                borderBottom: showChat ? "2px solid #6366f1" : "none",
                background: "transparent",
                cursor: "pointer",
                color: showChat ? "#6366f1" : "#6b7280",
              }}
            >
              Chat
            </button>
          </div>
          {/* Panel content */}
          {showChat ? (
            <ChatPanel
              ctrlYdoc={bootstrapRef.current?.ydoc ?? null}
              editor={editorRef.current}
              activeDocId={activeTabId}
              openDocs={tabs.map((t) => ({ id: t.id, fileName: t.fileName }))}
            />
          ) : (
            <SidePanel
              annotations={visibleAnnotations}
              editor={editorRef.current}
              ydoc={activeTab?.ydoc ?? null}
              heldCount={heldCount}
              interruptionMode={interruptionMode}
              onModeChange={setInterruptionMode}
              reviewMode={reviewMode}
              onToggleReviewMode={toggleReviewMode}
              onExitReviewMode={exitReviewMode}
              activeAnnotationId={activeAnnotationId}
              onActiveAnnotationChange={setActiveAnnotationId}
            />
          )}
        </div>
      </div>
      <StatusBar
        connected={connected}
        claudeStatus={claudeStatus}
        claudeActive={claudeActive}
        readOnly={readOnly}
        documentCount={tabs.length}
        interruptionMode={interruptionMode}
        onModeChange={setInterruptionMode}
        heldCount={heldCount}
      />
      {showReviewSummary && reviewSummaryData && (
        <ReviewSummary
          accepted={reviewSummaryData.accepted}
          dismissed={reviewSummaryData.dismissed}
          total={reviewSummaryData.total}
          onDismiss={() => setShowReviewSummary(false)}
        />
      )}
    </div>
  );
}
