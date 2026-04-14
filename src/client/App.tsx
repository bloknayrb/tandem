import type { Editor as TiptapEditor } from "@tiptap/react";
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  DISCONNECT_DEBOUNCE_MS,
  PANEL_WIDTH_KEYS,
  type PanelSide,
  PROLONGED_DISCONNECT_MS,
  TANDEM_MODE_DEFAULT,
  TANDEM_MODE_KEY,
  Y_MAP_DWELL_MS,
  Y_MAP_MODE,
  Y_MAP_USER_AWARENESS,
} from "../shared/constants";
import { toPmPos } from "../shared/positions/types";
import type { CapturedAnchor, TandemMode } from "../shared/types";
import { TandemModeSchema } from "../shared/types";
import { HelpModal } from "./components/HelpModal";
import { OnboardingTutorial } from "./components/OnboardingTutorial";
import { ReviewOnlyBanner } from "./components/ReviewOnlyBanner";
import { SettingsPopover } from "./components/SettingsPopover";
import { ToastContainer } from "./components/ToastContainer";
import { Editor } from "./editor/Editor";
import { authorshipPluginKey } from "./editor/extensions/authorship";
import { Toolbar } from "./editor/toolbar/Toolbar";
import { useFileDrop } from "./hooks/useFileDrop";
import { useModeGate } from "./hooks/useModeGate";
import { useNotifications } from "./hooks/useNotifications";
import { useReviewCompletion } from "./hooks/useReviewCompletion";
import { useSaveShortcut } from "./hooks/useSaveShortcut";
import { useSettingsShortcut } from "./hooks/useSettingsShortcut";
import { useTabCycleKeyboard } from "./hooks/useTabCycleKeyboard";
import { useTabOrder } from "./hooks/useTabOrder";
import { useTandemSettings } from "./hooks/useTandemSettings";
import { useTutorial } from "./hooks/useTutorial";
import { useWebViewZoom } from "./hooks/useWebViewZoom";
import { useYjsSync } from "./hooks/useYjsSync";
import type { PanelLayout } from "./panel-layout";
import { ChatPanel } from "./panels/ChatPanel";
import { ReviewSummary } from "./panels/ReviewSummary";
import { SidePanel } from "./panels/SidePanel";
import { pmSelectionToFlat } from "./positions";
import { StatusBar } from "./status/StatusBar";
import { DocumentTabs } from "./tabs/DocumentTabs";
import type { DocListEntry, OpenTab } from "./types";
import { addRecentFile, loadRecentFiles, saveRecentFiles } from "./utils/recentFiles";

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

function loadPanelWidth(side: PanelSide): number {
  const key = PANEL_WIDTH_KEYS[side];
  try {
    const saved = localStorage.getItem(key);
    if (saved) {
      const parsed = parseInt(saved, 10);
      if (Number.isFinite(parsed)) {
        return Math.max(PANEL_MIN_WIDTH, Math.min(PANEL_MAX_WIDTH, parsed));
      }
      // Non-finite saved value — fall through and warn so corrupt storage
      // is diagnosable instead of silently reverting to the default.
      console.warn(`[tandem] ignoring non-numeric panel width for ${key}: ${saved}`);
    }
  } catch (err) {
    console.warn(`[tandem] localStorage unavailable reading ${key}:`, err);
  }
  return PANEL_DEFAULT_WIDTH;
}

export default function App() {
  useWebViewZoom();

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
  useTabCycleKeyboard(orderedTabs, activeTabId, setActiveTabId);

  // Sync open tabs into the recent files list so files opened by Claude also appear.
  // Dep is tabs.length (not tabs) to avoid spurious fires from array identity changes.
  useEffect(() => {
    if (tabs.length === 0) return;
    try {
      const before = loadRecentFiles();
      let recent = before;
      for (const tab of tabs) {
        if (!tab.filePath.startsWith("upload://")) {
          recent = addRecentFile(recent, tab.filePath);
        }
      }
      if (recent.length !== before.length || recent.some((p, i) => p !== before[i])) {
        saveRecentFiles(recent);
      }
    } catch (err) {
      console.warn("[tandem] failed to sync recent files:", err);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tabs.length]);

  // Tandem mode — persisted to localStorage
  const [tandemMode, setTandemMode] = useState<TandemMode>(() => {
    try {
      const saved = localStorage.getItem(TANDEM_MODE_KEY);
      return TandemModeSchema.safeParse(saved).success
        ? (saved as TandemMode)
        : TANDEM_MODE_DEFAULT;
    } catch (err) {
      console.warn(`[tandem] localStorage unavailable reading ${TANDEM_MODE_KEY}:`, err);
      return TANDEM_MODE_DEFAULT;
    }
  });
  useEffect(() => {
    try {
      localStorage.setItem(TANDEM_MODE_KEY, tandemMode);
    } catch (err) {
      console.warn(`[tandem] failed to persist ${TANDEM_MODE_KEY}:`, err);
    }
  }, [tandemMode]);

  // Broadcast tandem mode to CTRL_ROOM Y.Map so the server (and Claude) can see it
  useEffect(() => {
    if (!bootstrapYdoc) return;
    const awareness = bootstrapYdoc.getMap(Y_MAP_USER_AWARENESS);
    awareness.set(Y_MAP_MODE, tandemMode);
  }, [tandemMode, bootstrapYdoc]);

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

  const { visibleAnnotations, heldCount } = useModeGate(annotations, tandemMode);
  const openDocs = useMemo(() => tabs.map((t) => ({ id: t.id, fileName: t.fileName })), [tabs]);

  const { saving } = useSaveShortcut(activeTabId);
  const { toasts, dismiss: dismissToast } = useNotifications();
  const { fileDragOver, handleEditorDragOver, handleEditorDragLeave, handleEditorDrop } =
    useFileDrop();
  const { showReviewSummary, reviewSummaryData, dismissReviewSummary } =
    useReviewCompletion(annotations);

  const { settings, updateSettings } = useTandemSettings();
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsAnchor, setSettingsAnchor] = useState<DOMRect | null>(null);
  const settingsBtnRef = useRef<HTMLButtonElement | null>(null);

  const openSettings = useCallback(() => {
    const rect = settingsBtnRef.current?.getBoundingClientRect() ?? null;
    setSettingsAnchor(rect);
    setSettingsOpen(true);
  }, []);
  useSettingsShortcut(openSettings);

  // Broadcast selection dwell time to CTRL_ROOM so the server uses the user's setting
  useEffect(() => {
    if (!bootstrapYdoc) return;
    const awareness = bootstrapYdoc.getMap(Y_MAP_USER_AWARENESS);
    awareness.set(Y_MAP_DWELL_MS, settings.selectionDwellMs);
  }, [settings.selectionDwellMs, bootstrapYdoc]);

  // Dispatch authorship toggle to the ProseMirror plugin when the setting changes
  useEffect(() => {
    const editor = editorRef.current;
    if (!editor) return;
    const tr = editor.state.tr.setMeta(authorshipPluginKey, {
      type: "toggle",
      visible: settings.showAuthorship,
    });
    editor.view.dispatch(tr);
  }, [settings.showAuthorship]);

  const [reviewMode, setReviewMode] = useState(false);
  const [showChat, setShowChat] = useState(() => settings.primaryTab === "chat");

  // Badge counts for the tab toggle buttons
  const pendingAnnotationBadge = useMemo(() => {
    if (!showChat) return 0;
    return visibleAnnotations.filter((a) => a.status === "pending").length;
  }, [visibleAnnotations, showChat]);

  const [activeAnnotationId, setActiveAnnotationId] = useState<string | null>(null);
  const [showHelp, setShowHelp] = useState(false);
  const [capturedAnchor, setCapturedAnchor] = useState<CapturedAnchor | null>(null);
  const editorRef = useRef<TiptapEditor | null>(null);
  const chatInputRef = useRef<HTMLTextAreaElement | null>(null);

  const handleEditorReady = useCallback((editor: TiptapEditor | null) => {
    editorRef.current = editor;
  }, []);

  const handleAnnotationClick = useCallback((annotationId: string) => {
    setShowChat(false);
    setActiveAnnotationId(annotationId);
  }, []);

  const [panelLayout, setPanelLayout] = useState<PanelLayout>(() =>
    settings.layout === "three-panel"
      ? { kind: "three-panel", left: loadPanelWidth("left"), right: loadPanelWidth("right") }
      : { kind: "tabbed", right: loadPanelWidth("right") },
  );

  // Transition between variants when the user toggles layout mid-session.
  // Preserves `right` across both directions and `left` on return to three-panel.
  useEffect(() => {
    setPanelLayout((prev) => {
      if (settings.layout === "three-panel") {
        if (prev.kind === "three-panel") return prev;
        return { kind: "three-panel", left: loadPanelWidth("left"), right: prev.right };
      }
      if (prev.kind === "tabbed") return prev;
      return { kind: "tabbed", right: prev.right };
    });
  }, [settings.layout]);

  const editorMaxWidth =
    settings.editorWidthPercent < 100 ? `${settings.editorWidthPercent}%` : undefined;
  const editorMargin = settings.editorWidthPercent < 100 ? "0 auto" : undefined;

  const panelLayoutRef = useRef(panelLayout);
  panelLayoutRef.current = panelLayout;
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

  const handleResizeStart = useCallback((e: React.MouseEvent, side: PanelSide) => {
    e.preventDefault();
    const startX = e.clientX;
    const current = panelLayoutRef.current;
    // `left` is only defined in three-panel; fall back to the default so a
    // stale mid-transition drag never reads undefined.
    const startWidth =
      side === "left"
        ? current.kind === "three-panel"
          ? current.left
          : PANEL_DEFAULT_WIDTH
        : current.right;
    const storageKey = PANEL_WIDTH_KEYS[side];
    let latestWidth = startWidth;

    document.body.style.userSelect = "none";
    document.body.style.cursor = "col-resize";

    const onMouseMove = (ev: MouseEvent) => {
      const delta = ev.clientX - startX;
      // The left panel's handle sits on its right edge (drag right = wider).
      // The right panel's handle sits on its left edge (drag right = narrower).
      const next = side === "left" ? startWidth + delta : startWidth - delta;
      latestWidth = Math.max(PANEL_MIN_WIDTH, Math.min(PANEL_MAX_WIDTH, next));
      setPanelLayout((prev) => {
        if (side === "right") {
          return prev.kind === "three-panel"
            ? { ...prev, right: latestWidth }
            : { kind: "tabbed", right: latestWidth };
        }
        // Left handle is only rendered in three-panel, but guard anyway.
        if (prev.kind !== "three-panel") return prev;
        return { ...prev, left: latestWidth };
      });
    };

    const onMouseUp = () => {
      document.removeEventListener("mousemove", onMouseMove);
      document.removeEventListener("mouseup", onMouseUp);
      dragListenersRef.current = null;
      document.body.style.userSelect = "";
      document.body.style.cursor = "";
      try {
        localStorage.setItem(storageKey, String(latestWidth));
      } catch (err) {
        console.warn(`[tandem] failed to persist ${storageKey}:`, err);
      }
    };

    dragListenersRef.current = { move: onMouseMove, up: onMouseUp };
    document.addEventListener("mousemove", onMouseMove);
    document.addEventListener("mouseup", onMouseUp);
  }, []);

  const toggleReviewMode = useCallback(() => {
    setReviewMode((prev) => !prev);
  }, []);

  const exitReviewMode = useCallback(() => {
    setReviewMode(false);
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
      <Toolbar
        editor={editorRef.current}
        ydoc={activeTab?.ydoc ?? null}
        onSettingsClick={(rect) => {
          setSettingsAnchor(rect);
          setSettingsOpen(true);
        }}
        settingsBtnRef={settingsBtnRef}
        tandemMode={tandemMode}
        onModeChange={setTandemMode}
        heldCount={heldCount}
      />
      <DocumentTabs
        tabs={orderedTabs}
        activeTabId={activeTabId}
        onTabSwitch={setActiveTabId}
        onTabClose={handleTabClose}
        reorder={reorder}
      />
      {panelLayout.kind === "three-panel" ? (
        /* ── Three-panel layout: Left | Editor | Right ── */
        <div style={{ display: "flex", flex: 1, overflow: "hidden" }}>
          {/* Left panel */}
          <div
            style={{
              display: "flex",
              flexDirection: "column",
              width: `${panelLayout.left}px`,
              borderRight: "1px solid #e5e7eb",
            }}
          >
            <div
              style={{
                padding: "6px 12px",
                fontSize: "11px",
                fontWeight: 600,
                color: "#6b7280",
                borderBottom: "1px solid #e5e7eb",
                background: "#f9fafb",
                textTransform: "uppercase",
                letterSpacing: "0.5px",
              }}
            >
              {settings.panelOrder === "chat-editor-annotations" ? "Chat" : "Annotations"}
            </div>
            <div style={{ display: "flex", flexDirection: "column", flex: 1, minHeight: 0 }}>
              {settings.panelOrder === "chat-editor-annotations" ? (
                <ChatPanel
                  ctrlYdoc={bootstrapYdoc}
                  editor={editorRef.current}
                  activeDocId={activeTabId}
                  openDocs={openDocs}
                  claudeActive={claudeActive}
                  claudeStatus={claudeStatus}
                  visible={true}
                  capturedAnchor={capturedAnchor}
                  onCapturedAnchorChange={setCapturedAnchor}
                  inputRef={chatInputRef}
                />
              ) : (
                <SidePanel
                  annotations={visibleAnnotations}
                  editor={editorRef.current}
                  ydoc={activeTab?.ydoc ?? null}
                  heldCount={heldCount}
                  tandemMode={tandemMode}
                  onModeChange={setTandemMode}
                  activeDocFormat={activeTab?.format}
                  documentId={activeTab?.id}
                  reviewMode={reviewMode}
                  onToggleReviewMode={toggleReviewMode}
                  onExitReviewMode={exitReviewMode}
                  activeAnnotationId={activeAnnotationId}
                  onActiveAnnotationChange={setActiveAnnotationId}
                />
              )}
            </div>
          </div>
          {/* Left resize handle */}
          <div
            data-testid="left-panel-resize-handle"
            role="separator"
            aria-orientation="vertical"
            aria-label="Resize left panel"
            tabIndex={0}
            onMouseDown={(e) => handleResizeStart(e, "left")}
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
          {/* Editor (center) */}
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
            <div
              style={{
                maxWidth: editorMaxWidth,
                margin: editorMargin,
              }}
            >
              {activeTab ? (
                <Editor
                  key={activeTab.id}
                  ydoc={activeTab.ydoc}
                  provider={activeTab.provider}
                  readOnly={readOnly}
                  reviewMode={reviewMode}
                  activeAnnotationId={activeAnnotationId}
                  onEditorReady={handleEditorReady}
                  onAnnotationClick={handleAnnotationClick}
                />
              ) : (
                <EmptyState connected={connected} claudeActive={claudeActive} />
              )}
            </div>
          </div>
          {/* Right resize handle */}
          <div
            data-testid="right-panel-resize-handle"
            role="separator"
            aria-orientation="vertical"
            aria-label="Resize right panel"
            tabIndex={0}
            onMouseDown={(e) => handleResizeStart(e, "right")}
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
          {/* Right panel */}
          <div
            style={{
              display: "flex",
              flexDirection: "column",
              width: `${panelLayout.right}px`,
              borderLeft: "1px solid #e5e7eb",
            }}
          >
            <div
              style={{
                padding: "6px 12px",
                fontSize: "11px",
                fontWeight: 600,
                color: "#6b7280",
                borderBottom: "1px solid #e5e7eb",
                background: "#f9fafb",
                textTransform: "uppercase",
                letterSpacing: "0.5px",
              }}
            >
              {settings.panelOrder === "chat-editor-annotations" ? "Annotations" : "Chat"}
            </div>
            <div style={{ display: "flex", flexDirection: "column", flex: 1, minHeight: 0 }}>
              {settings.panelOrder === "chat-editor-annotations" ? (
                <SidePanel
                  annotations={visibleAnnotations}
                  editor={editorRef.current}
                  ydoc={activeTab?.ydoc ?? null}
                  heldCount={heldCount}
                  tandemMode={tandemMode}
                  onModeChange={setTandemMode}
                  activeDocFormat={activeTab?.format}
                  documentId={activeTab?.id}
                  reviewMode={reviewMode}
                  onToggleReviewMode={toggleReviewMode}
                  onExitReviewMode={exitReviewMode}
                  activeAnnotationId={activeAnnotationId}
                  onActiveAnnotationChange={setActiveAnnotationId}
                />
              ) : (
                <ChatPanel
                  ctrlYdoc={bootstrapYdoc}
                  editor={editorRef.current}
                  activeDocId={activeTabId}
                  openDocs={openDocs}
                  claudeActive={claudeActive}
                  claudeStatus={claudeStatus}
                  visible={true}
                  capturedAnchor={capturedAnchor}
                  onCapturedAnchorChange={setCapturedAnchor}
                  inputRef={chatInputRef}
                />
              )}
            </div>
          </div>
        </div>
      ) : (
        /* ── Tabbed layout (default): Editor | Tabs+Panel ── */
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
            <div
              style={{
                maxWidth: editorMaxWidth,
                margin: editorMargin,
              }}
            >
              {activeTab ? (
                <Editor
                  key={activeTab.id}
                  ydoc={activeTab.ydoc}
                  provider={activeTab.provider}
                  readOnly={readOnly}
                  reviewMode={reviewMode}
                  activeAnnotationId={activeAnnotationId}
                  onEditorReady={handleEditorReady}
                  onAnnotationClick={handleAnnotationClick}
                />
              ) : (
                <EmptyState connected={connected} claudeActive={claudeActive} />
              )}
            </div>
          </div>
          {/* Resize handle */}
          <div
            data-testid="panel-resize-handle"
            role="separator"
            aria-orientation="vertical"
            aria-label="Resize panel"
            tabIndex={0}
            onMouseDown={(e) => handleResizeStart(e, "right")}
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
              width: `${panelLayout.right}px`,
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
                data-testid="annotations-tab"
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
                  position: "relative",
                }}
              >
                Annotations
                {showChat && pendingAnnotationBadge > 0 && (
                  <span
                    style={{
                      position: "absolute",
                      top: "2px",
                      right: "6px",
                      background: "#ef4444",
                      color: "#fff",
                      fontSize: "9px",
                      width: "16px",
                      height: "16px",
                      borderRadius: "50%",
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                      fontWeight: 700,
                    }}
                  >
                    {pendingAnnotationBadge > 9 ? "9+" : pendingAnnotationBadge}
                  </span>
                )}
              </button>
              <button
                data-testid="chat-tab"
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
                  position: "relative",
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
                inputRef={chatInputRef}
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
                tandemMode={tandemMode}
                onModeChange={setTandemMode}
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
      )}
      <StatusBar
        connected={connected}
        connectionStatus={connectionStatus}
        reconnectAttempts={reconnectAttempts}
        disconnectedSince={disconnectedSince}
        claudeStatus={claudeStatus}
        claudeActive={claudeActive}
        readOnly={readOnly}
        documentCount={tabs.length}
        saving={saving}
      />
      {showReviewSummary && reviewSummaryData && (
        <ReviewSummary
          accepted={reviewSummaryData.accepted}
          dismissed={reviewSummaryData.dismissed}
          total={reviewSummaryData.total}
          onDismiss={dismissReviewSummary}
        />
      )}
      <SettingsPopover
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        anchorRect={settingsAnchor}
        settings={settings}
        onUpdate={updateSettings}
        returnFocusRef={settingsBtnRef}
      />
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
