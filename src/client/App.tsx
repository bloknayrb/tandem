import type { Editor as TiptapEditor } from "@tiptap/react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { isUploadPath } from "../shared/paths";
import { toPmPos } from "../shared/positions/types";
import type { CapturedAnchor, TandemMode } from "../shared/types";
import { TandemModeSchema } from "../shared/types";
import { ConnectionBanner } from "./components/ConnectionBanner";
import { CoworkAdminDeclinedModal } from "./components/CoworkAdminDeclinedModal";
import { EmptyState } from "./components/EmptyState";
import { HelpModal } from "./components/HelpModal";
import { OnboardingTutorial } from "./components/OnboardingTutorial";
import { ChatSlot, SideSlot } from "./components/PanelSlot";
import { ReviewOnlyBanner } from "./components/ReviewOnlyBanner";
import { SettingsPopover } from "./components/SettingsPopover";
import { ToastContainer } from "./components/ToastContainer";
import { isTauriRuntime } from "./cowork/cowork-helpers";
import { Editor } from "./editor/Editor";
import { authorshipPluginKey } from "./editor/extensions/authorship";
import { Toolbar } from "./editor/toolbar/Toolbar";
import { useConnectionBanner } from "./hooks/useConnectionBanner";
import { useDragResize } from "./hooks/useDragResize";
import { useFileDrop } from "./hooks/useFileDrop";
import { useModeGate } from "./hooks/useModeGate";
import { useNotifications } from "./hooks/useNotifications";
import { useReviewCompletion } from "./hooks/useReviewCompletion";
import { useSaveShortcut } from "./hooks/useSaveShortcut";
import { useSettingsShortcut } from "./hooks/useSettingsShortcut";
import { useTabCycleKeyboard } from "./hooks/useTabCycleKeyboard";
import { useTabOrder } from "./hooks/useTabOrder";
import { useTandemModeBroadcast } from "./hooks/useTandemModeBroadcast";
import { TEXT_SIZE_PX, useTandemSettings } from "./hooks/useTandemSettings";
import { useTheme } from "./hooks/useTheme";
import { useTutorial } from "./hooks/useTutorial";
import { useWebViewZoom } from "./hooks/useWebViewZoom";
import { useYjsSync } from "./hooks/useYjsSync";
import { loadPanelWidth, type PanelLayout } from "./panel-layout";
import { ReviewSummary } from "./panels/ReviewSummary";
import { pmSelectionToFlat } from "./positions";
import { StatusBar } from "./status/StatusBar";
import { DocumentTabs } from "./tabs/DocumentTabs";
import type { DocListEntry, OpenTab } from "./types";
import { addRecentFile, loadRecentFiles, saveRecentFiles } from "./utils/recentFiles";

export type { DocListEntry, OpenTab };

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
        if (!isUploadPath(tab.filePath)) {
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

  const { settings, updateSettings } = useTandemSettings();

  // Tandem mode — persisted to localStorage, broadcasts to CTRL_ROOM Y.Map
  const { tandemMode, setTandemMode } = useTandemModeBroadcast(
    bootstrapYdoc,
    settings.selectionDwellMs,
  );

  const { visibleAnnotations, heldCount } = useModeGate(annotations, tandemMode);

  const { showBanner: showDisconnectBanner, dismiss: dismissConnectionBanner } =
    useConnectionBanner(disconnectedSince);

  const openDocs = useMemo(() => tabs.map((t) => ({ id: t.id, fileName: t.fileName })), [tabs]);

  const { saving } = useSaveShortcut(activeTabId);
  const { toasts, dismiss: dismissToast } = useNotifications();
  const { fileDragOver, handleEditorDragOver, handleEditorDragLeave, handleEditorDrop } =
    useFileDrop();
  const { showReviewSummary, reviewSummaryData, dismissReviewSummary } =
    useReviewCompletion(annotations);

  const [settingsOpen, setSettingsOpen] = useState(false);
  const settingsBtnRef = useRef<HTMLButtonElement | null>(null);

  const openSettings = useCallback(() => {
    setSettingsOpen(true);
  }, []);
  const settingsOpenRef = useRef(settingsOpen);
  settingsOpenRef.current = settingsOpen;
  const toggleSettings = useCallback(() => {
    if (settingsOpenRef.current) {
      setSettingsOpen(false);
      return;
    }
    openSettings();
  }, [openSettings]);
  useSettingsShortcut(toggleSettings);

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

  // Body class mirrors the reduce-motion setting so CSS rules (animations,
  // transitions) can be scoped without a media query alone. JS-level gating
  // of scrollIntoView `behavior` still happens in the panels.
  useEffect(() => {
    document.body.classList.toggle("tandem-reduce-motion", settings.reduceMotion);
    return () => document.body.classList.remove("tandem-reduce-motion");
  }, [settings.reduceMotion]);

  useTheme(settings.theme);

  // Expose editor font-size as a CSS custom property so the editor style
  // picks it up without recreating the Tiptap instance.
  useEffect(() => {
    const px = TEXT_SIZE_PX[settings.textSize];
    document.documentElement.style.setProperty("--tandem-editor-font-size", `${px}px`);
    return () => {
      document.documentElement.style.removeProperty("--tandem-editor-font-size");
    };
  }, [settings.textSize]);

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

  const { handleResizeStart } = useDragResize({ panelLayout, setPanelLayout });

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

  const { tutorialActive, currentStep, dismissTutorial, nextStep, coworkStatus } = useTutorial(
    annotations,
    editorRef,
    activeTab?.fileName,
  );

  // Shared props for SidePanel across all layout render sites
  const sidePanelProps = {
    annotations: visibleAnnotations,
    editor: editorRef.current,
    ydoc: activeTab?.ydoc ?? null,
    heldCount,
    tandemMode,
    onModeChange: setTandemMode,
    activeDocFormat: activeTab?.format,
    documentId: activeTab?.id,
    reviewMode,
    onToggleReviewMode: toggleReviewMode,
    onExitReviewMode: exitReviewMode,
    activeAnnotationId,
    onActiveAnnotationChange: setActiveAnnotationId,
    reduceMotion: settings.reduceMotion,
  } as const;

  // Shared props for ChatPanel across all layout render sites
  const chatPanelProps = {
    ctrlYdoc: bootstrapYdoc,
    editor: editorRef.current,
    activeDocId: activeTabId,
    openDocs,
    claudeActive,
    claudeStatus,
    capturedAnchor,
    onCapturedAnchorChange: setCapturedAnchor,
    inputRef: chatInputRef,
    reduceMotion: settings.reduceMotion,
  } as const;

  if (!ready) {
    return (
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          height: "100vh",
          color: "var(--tandem-fg-subtle)",
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
            background: "var(--tandem-warning-bg)",
            borderBottom: "1px solid var(--tandem-warning-border)",
            fontSize: "13px",
            color: "var(--tandem-warning-fg-strong)",
            textAlign: "center",
          }}
        >
          Server restarted — refreshing documents
        </div>
      )}
      {showDisconnectBanner && <ConnectionBanner onDismiss={dismissConnectionBanner} />}
      <Toolbar
        editor={editorRef.current}
        ydoc={activeTab?.ydoc ?? null}
        onSettingsOpen={toggleSettings}
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
        reduceMotion={settings.reduceMotion}
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
              borderRight: "1px solid var(--tandem-border)",
            }}
          >
            <div
              style={{
                padding: "6px 12px",
                fontSize: "11px",
                fontWeight: 600,
                color: "var(--tandem-fg-muted)",
                borderBottom: "1px solid var(--tandem-border)",
                background: "var(--tandem-surface-muted)",
                textTransform: "uppercase",
                letterSpacing: "0.5px",
              }}
            >
              {settings.panelOrder === "chat-editor-annotations" ? "Chat" : "Annotations"}
            </div>
            <div style={{ display: "flex", flexDirection: "column", flex: 1, minHeight: 0 }}>
              {settings.panelOrder === "chat-editor-annotations" ? (
                <ChatSlot {...chatPanelProps} visible={true} />
              ) : (
                <SideSlot {...sidePanelProps} />
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
              (e.currentTarget as HTMLDivElement).style.background = "var(--tandem-border-strong)";
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
              border: fileDragOver ? "2px dashed var(--tandem-accent)" : "2px solid transparent",
              background: fileDragOver ? "var(--tandem-accent-bg)" : undefined,
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
              (e.currentTarget as HTMLDivElement).style.background = "var(--tandem-border-strong)";
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
              borderLeft: "1px solid var(--tandem-border)",
            }}
          >
            <div
              style={{
                padding: "6px 12px",
                fontSize: "11px",
                fontWeight: 600,
                color: "var(--tandem-fg-muted)",
                borderBottom: "1px solid var(--tandem-border)",
                background: "var(--tandem-surface-muted)",
                textTransform: "uppercase",
                letterSpacing: "0.5px",
              }}
            >
              {settings.panelOrder === "chat-editor-annotations" ? "Annotations" : "Chat"}
            </div>
            <div style={{ display: "flex", flexDirection: "column", flex: 1, minHeight: 0 }}>
              {settings.panelOrder === "chat-editor-annotations" ? (
                <SideSlot {...sidePanelProps} />
              ) : (
                <ChatSlot {...chatPanelProps} visible={true} />
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
              border: fileDragOver ? "2px dashed var(--tandem-accent)" : "2px solid transparent",
              background: fileDragOver ? "var(--tandem-accent-bg)" : undefined,
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
              (e.currentTarget as HTMLDivElement).style.background = "var(--tandem-border-strong)";
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
              borderLeft: "1px solid var(--tandem-border)",
            }}
          >
            {/* Panel toggle tabs */}
            <div
              style={{
                display: "flex",
                borderBottom: "1px solid var(--tandem-border)",
                background: "var(--tandem-surface-muted)",
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
                  borderBottom: showChat ? "none" : "2px solid var(--tandem-accent)",
                  background: "transparent",
                  cursor: "pointer",
                  color: showChat ? "var(--tandem-fg-muted)" : "var(--tandem-accent)",
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
                      background: "var(--tandem-error)",
                      color: "var(--tandem-error-fg)",
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
                  borderBottom: showChat ? "2px solid var(--tandem-accent)" : "none",
                  background: "transparent",
                  cursor: "pointer",
                  color: showChat ? "var(--tandem-accent)" : "var(--tandem-fg-muted)",
                  position: "relative",
                }}
              >
                Chat
              </button>
            </div>
            {/* Panel content — both panels stay mounted, toggle visibility via CSS */}
            <ChatSlot {...chatPanelProps} visible={showChat} />
            <SideSlot {...sidePanelProps} visible={!showChat} />
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
        settings={settings}
        onUpdate={updateSettings}
        returnFocusRef={settingsBtnRef}
        anchorRef={settingsBtnRef}
      />
      <HelpModal open={showHelp} onClose={() => setShowHelp(false)} />
      <ToastContainer toasts={toasts} onDismiss={dismissToast} />
      {isTauriRuntime() && <CoworkAdminDeclinedModal />}
      {tutorialActive && (
        <OnboardingTutorial
          currentStep={currentStep}
          onNext={nextStep}
          onDismiss={dismissTutorial}
          coworkStatus={coworkStatus}
        />
      )}
    </div>
  );
}
