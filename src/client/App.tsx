import React, { useState, useRef, useCallback, useEffect, useMemo } from "react";
import type { Editor as TiptapEditor } from "@tiptap/react";
import { Editor } from "./editor/Editor";
import { SidePanel } from "./panels/SidePanel";
import { ChatPanel } from "./panels/ChatPanel";
import { StatusBar } from "./status/StatusBar";
import { Toolbar } from "./editor/toolbar/Toolbar";
import { DocumentTabs } from "./tabs/DocumentTabs";
import { ReviewSummary } from "./panels/ReviewSummary";
import { HelpModal } from "./components/HelpModal";
import { ReviewOnlyBanner } from "./components/ReviewOnlyBanner";
import { ToastContainer } from "./components/ToastContainer";
import { OnboardingTutorial } from "./components/OnboardingTutorial";
import {
  DISCONNECT_DEBOUNCE_MS,
  INTERRUPTION_MODE_DEFAULT,
  INTERRUPTION_MODE_KEY,
  PROLONGED_DISCONNECT_MS,
  REVIEW_BANNER_THRESHOLD,
  Y_MAP_USER_AWARENESS,
} from "../shared/constants";
import type { InterruptionMode, CapturedAnchor } from "../shared/types";
import { InterruptionModeSchema } from "../shared/types";
import { pmSelectionToFlat } from "./positions";
import { toPmPos } from "../shared/positions/types";
import { useAnnotationGate } from "./hooks/useAnnotationGate";
import { useFileDrop } from "./hooks/useFileDrop";
import { useNotifications } from "./hooks/useNotifications";
import { useReviewCompletion } from "./hooks/useReviewCompletion";
import { useTabOrder } from "./hooks/useTabOrder";
import { useTutorial } from "./hooks/useTutorial";
import { useYjsSync } from "./hooks/useYjsSync";
import type { DocListEntry, OpenTab } from "./types";

export type { DocListEntry, OpenTab };

/** Connection-aware empty state shown when no document is open. */
function EmptyState({ connected, claudeActive }: { connected: boolean; claudeActive: boolean }) {
  const [showDisconnected, setShowDisconnected] = useState(false);

  useEffect(() => {
    if (connected) {
      setShowDisconnected(false);
      return;
    }
    const timer = setTimeout(() => setShowDisconnected(true), DISCONNECT_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [connected]);

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        height: "100%",
        color: "#9ca3af",
        gap: "8px",
      }}
    >
      {showDisconnected ? (
        <span>Cannot reach the Tandem server. Is it running?</span>
      ) : (
        <>
          <span>No document open. Click + in the tab bar or drop a file here.</span>
          {connected && !claudeActive && (
            <span style={{ fontSize: "0.85em", color: "#b0b8c4" }}>
              Tip: open Claude Code in this directory to start collaborating
            </span>
          )}
        </>
      )}
    </div>
  );
}

/** Red banner shown after prolonged disconnect (>30s). Dismissible. */
function ConnectionBanner({ onDismiss }: { onDismiss: () => void }) {
  return (
    <div
      style={{
        padding: "8px 16px",
        background: "#fef2f2",
        borderBottom: "1px solid #fca5a5",
        fontSize: "13px",
        color: "#991b1b",
        textAlign: "center",
        display: "flex",
        justifyContent: "center",
        alignItems: "center",
        gap: "12px",
      }}
    >
      <span>Connection to the Tandem server has been lost. Ensure the server is running.</span>
      <button
        onClick={onDismiss}
        style={{
          background: "none",
          border: "none",
          cursor: "pointer",
          color: "#991b1b",
          fontSize: "16px",
          lineHeight: 1,
          padding: "0 4px",
        }}
        aria-label="Dismiss connection banner"
      >
        \u00d7
      </button>
    </div>
  );
}

const PANEL_MIN_WIDTH = 200;
const PANEL_MAX_WIDTH = 600;
const PANEL_DEFAULT_WIDTH = 300;
const PANEL_WIDTH_KEY = "tandem-panel-width";

export default function App() {
  const {
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
    bootstrapYdoc,
    ready,
    serverRestarted,
  } = useYjsSync();

  const { orderedTabs, reorder } = useTabOrder(tabs);

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

  // Broadcast interruption mode to Y.Map so the server (and Claude) can see it
  const activeYdoc = tabs.find((t) => t.id === activeTabId)?.ydoc;
  useEffect(() => {
    if (!activeYdoc) return;
    const awareness = activeYdoc.getMap(Y_MAP_USER_AWARENESS);
    awareness.set("interruptionMode", interruptionMode);
  }, [interruptionMode, activeYdoc]);

  // Prolonged disconnect banner — shown after PROLONGED_DISCONNECT_MS of being disconnected
  const [showDisconnectBanner, setShowDisconnectBanner] = useState(false);
  const [disconnectBannerDismissed, setDisconnectBannerDismissed] = useState(false);
  useEffect(() => {
    if (disconnectedSince == null) {
      setShowDisconnectBanner(false);
      setDisconnectBannerDismissed(false);
      return;
    }
    const elapsed = Date.now() - disconnectedSince;
    const remaining = PROLONGED_DISCONNECT_MS - elapsed;
    if (remaining <= 0) {
      setShowDisconnectBanner(true);
      return;
    }
    const timer = setTimeout(() => setShowDisconnectBanner(true), remaining);
    return () => clearTimeout(timer);
  }, [disconnectedSince]);

  const { visibleAnnotations, heldCount } = useAnnotationGate(annotations, interruptionMode);
  const openDocs = useMemo(() => tabs.map((t) => ({ id: t.id, fileName: t.fileName })), [tabs]);

  const { toasts, dismiss: dismissToast } = useNotifications();
  const { fileDragOver, handleEditorDragOver, handleEditorDragLeave, handleEditorDrop } =
    useFileDrop();
  const { pendingCount, showReviewSummary, reviewSummaryData, dismissReviewSummary } =
    useReviewCompletion(annotations);

  const [reviewMode, setReviewMode] = useState(false);
  const [showBanner, setShowBanner] = useState(false);
  const [showChat, setShowChat] = useState(false);
  const [activeAnnotationId, setActiveAnnotationId] = useState<string | null>(null);
  const [showHelp, setShowHelp] = useState(false);
  const [capturedAnchor, setCapturedAnchor] = useState<CapturedAnchor | null>(null);
  const editorRef = useRef<TiptapEditor | null>(null);

  const handleEditorReady = useCallback((editor: TiptapEditor | null) => {
    editorRef.current = editor;
  }, []);

  const [panelWidth, setPanelWidth] = useState<number>(() => {
    try {
      const saved = localStorage.getItem(PANEL_WIDTH_KEY);
      if (saved) {
        const parsed = parseInt(saved, 10);
        if (Number.isFinite(parsed)) {
          return Math.max(PANEL_MIN_WIDTH, Math.min(PANEL_MAX_WIDTH, parsed));
        }
      }
    } catch {
      // localStorage unavailable (incognito/storage-disabled)
    }
    return PANEL_DEFAULT_WIDTH;
  });

  const panelWidthRef = useRef(panelWidth);
  panelWidthRef.current = panelWidth;
  const dragListenersRef = useRef<{
    move: (e: MouseEvent) => void;
    up: () => void;
  } | null>(null);

  // Clean up drag listeners if the component unmounts mid-drag
  useEffect(() => {
    return () => {
      if (dragListenersRef.current) {
        document.removeEventListener("mousemove", dragListenersRef.current.move);
        document.removeEventListener("mouseup", dragListenersRef.current.up);
        document.body.style.userSelect = "";
        document.body.style.cursor = "";
      }
    };
  }, []);

  const handleResizeStart = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    const startX = e.clientX;
    const startWidth = panelWidthRef.current;
    let latestWidth = startWidth;

    document.body.style.userSelect = "none";
    document.body.style.cursor = "col-resize";

    const onMouseMove = (ev: MouseEvent) => {
      latestWidth = Math.max(
        PANEL_MIN_WIDTH,
        Math.min(PANEL_MAX_WIDTH, startWidth - (ev.clientX - startX)),
      );
      setPanelWidth(latestWidth);
    };

    const onMouseUp = () => {
      document.removeEventListener("mousemove", onMouseMove);
      document.removeEventListener("mouseup", onMouseUp);
      dragListenersRef.current = null;
      document.body.style.userSelect = "";
      document.body.style.cursor = "";
      try {
        localStorage.setItem(PANEL_WIDTH_KEY, String(latestWidth));
      } catch {
        // localStorage unavailable
      }
    };

    dragListenersRef.current = { move: onMouseMove, up: onMouseUp };
    document.addEventListener("mousemove", onMouseMove);
    document.addEventListener("mouseup", onMouseUp);
  }, []);

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

  // Snapshot editor selection for chat anchor (mousedown fires before click moves focus from editor)
  const captureSelectionForChat = useCallback(() => {
    if (showChat) return;
    const editor = editorRef.current;
    if (!editor) return;
    const { from, to } = editor.state.selection;
    if (from === to) return;
    const range = pmSelectionToFlat(editor.state.doc, { from: toPmPos(from), to: toPmPos(to) });
    const text = editor.state.doc.textBetween(from, to, "\n");
    setCapturedAnchor({
      ...range,
      textSnapshot: text.length > 200 ? text.slice(0, 197) + "..." : text,
    });
  }, [showChat]);

  // Toggle help modal with '?' — skip when focus is in a text input
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key !== "?") return;
      const el = e.target as HTMLElement;
      if (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable) return;
      setShowHelp((prev) => !prev);
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);

  const activeTab = tabs.find((t) => t.id === activeTabId);

  const { tutorialActive, currentStep, dismissTutorial, nextStep } = useTutorial(
    annotations,
    editorRef,
    activeTab?.fileName,
  );

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
      {serverRestarted && (
        <div
          style={{
            padding: "8px 16px",
            background: "#fef3c7",
            borderBottom: "1px solid #fbbf24",
            fontSize: "13px",
            color: "#92400e",
            textAlign: "center",
          }}
        >
          Server restarted — refreshing documents
        </div>
      )}
      {showDisconnectBanner && !disconnectBannerDismissed && (
        <ConnectionBanner onDismiss={() => setDisconnectBannerDismissed(true)} />
      )}
      <Toolbar editor={editorRef.current} ydoc={activeTab?.ydoc ?? null} />
      <DocumentTabs
        tabs={orderedTabs}
        activeTabId={activeTabId}
        onTabSwitch={setActiveTabId}
        onTabClose={handleTabClose}
        reorder={reorder}
      />
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
        <div
          style={{
            flex: 1,
            overflow: "auto",
            padding: "24px 48px",
            border: fileDragOver ? "2px dashed #6366f1" : "2px solid transparent",
            background: fileDragOver ? "#eef2ff" : undefined,
            transition: "border-color 0.15s, background 0.15s",
          }}
          onDragOver={handleEditorDragOver}
          onDragLeave={handleEditorDragLeave}
          onDrop={handleEditorDrop}
        >
          <ReviewOnlyBanner
            visible={activeTab?.readOnly === true && activeTab?.format === "docx"}
            documentId={activeTab?.id}
          />
          {activeTab ? (
            <Editor
              key={activeTab.id}
              ydoc={activeTab.ydoc}
              provider={activeTab.provider}
              readOnly={readOnly}
              reviewMode={reviewMode}
              activeAnnotationId={activeAnnotationId}
              onEditorReady={handleEditorReady}
            />
          ) : (
            <EmptyState connected={connected} claudeActive={claudeActive} />
          )}
        </div>
        {/* Resize handle */}
        <div
          data-testid="panel-resize-handle"
          role="separator"
          aria-orientation="vertical"
          aria-label="Resize panel"
          tabIndex={0}
          onMouseDown={handleResizeStart}
          style={{
            width: "4px",
            cursor: "col-resize",
            background: "transparent",
            flexShrink: 0,
            transition: "background 0.15s",
          }}
          onMouseEnter={(e) => {
            (e.currentTarget as HTMLDivElement).style.background = "#d1d5db";
          }}
          onMouseLeave={(e) => {
            (e.currentTarget as HTMLDivElement).style.background = "transparent";
          }}
        />
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            width: `${panelWidth}px`,
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
              onMouseDown={captureSelectionForChat}
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
          {/* Panel content — both panels stay mounted, toggle visibility via CSS */}
          <div
            style={{
              display: showChat ? "flex" : "none",
              flexDirection: "column",
              flex: 1,
              minHeight: 0,
            }}
          >
            <ChatPanel
              ctrlYdoc={bootstrapYdoc}
              editor={editorRef.current}
              activeDocId={activeTabId}
              openDocs={openDocs}
              claudeActive={claudeActive}
              claudeStatus={claudeStatus}
              visible={showChat}
              capturedAnchor={capturedAnchor}
              onCapturedAnchorChange={setCapturedAnchor}
            />
          </div>
          <div
            style={{
              display: showChat ? "none" : "flex",
              flexDirection: "column",
              flex: 1,
              minHeight: 0,
            }}
          >
            <SidePanel
              annotations={visibleAnnotations}
              editor={editorRef.current}
              ydoc={activeTab?.ydoc ?? null}
              heldCount={heldCount}
              interruptionMode={interruptionMode}
              onModeChange={setInterruptionMode}
              activeDocFormat={activeTab?.format}
              documentId={activeTab?.id}
              reviewMode={reviewMode}
              onToggleReviewMode={toggleReviewMode}
              onExitReviewMode={exitReviewMode}
              activeAnnotationId={activeAnnotationId}
              onActiveAnnotationChange={setActiveAnnotationId}
            />
          </div>
        </div>
      </div>
      <StatusBar
        connected={connected}
        connectionStatus={connectionStatus}
        reconnectAttempts={reconnectAttempts}
        disconnectedSince={disconnectedSince}
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
          onDismiss={dismissReviewSummary}
        />
      )}
      <HelpModal open={showHelp} onClose={() => setShowHelp(false)} />
      <ToastContainer toasts={toasts} onDismiss={dismissToast} />
      {tutorialActive && (
        <OnboardingTutorial
          currentStep={currentStep}
          onNext={nextStep}
          onDismiss={dismissTutorial}
        />
      )}
    </div>
  );
}
