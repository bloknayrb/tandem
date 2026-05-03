<script lang="ts">
import type { Editor as TiptapEditor } from "@tiptap/core";
import { onDestroy, untrack } from "svelte";
import { isUploadPath } from "../shared/paths";
import { toPmPos } from "../shared/positions/types";
import type { CapturedAnchor } from "../shared/types";
import ConnectionBanner from "./components/ConnectionBanner.svelte";
import CoworkAdminDeclinedModal from "./components/CoworkAdminDeclinedModal.svelte";
import EmptyState from "./components/EmptyState.svelte";
import HelpModal from "./components/HelpModal.svelte";
import OnboardingTutorial from "./components/OnboardingTutorial.svelte";
import PanelSlot from "./components/PanelSlot.svelte";
import ReviewOnlyBanner from "./components/ReviewOnlyBanner.svelte";
import SettingsPopover from "./components/SettingsPopover.svelte";
import ToastContainer from "./components/ToastContainer.svelte";
import { isTauriRuntime } from "./cowork/cowork-helpers";
import Editor from "./editor/Editor.svelte";
import { authorshipPluginKey } from "./editor/extensions/authorship";
import Toolbar from "./editor/toolbar/Toolbar.svelte";
import { createConnectionBanner } from "./hooks/useConnectionBanner.svelte";
import { createDragResize } from "./hooks/useDragResize.svelte";
import { createFileDrop } from "./hooks/useFileDrop.svelte";
import { createModeGate } from "./hooks/useModeGate.svelte";
import { createNotifications } from "./hooks/useNotifications.svelte";
import { createReviewCompletion } from "./hooks/useReviewCompletion.svelte";
import { createSaveShortcut } from "./hooks/useSaveShortcut.svelte";
import { createSettingsShortcut } from "./hooks/useSettingsShortcut.svelte";
import { createTabCycleKeyboard } from "./hooks/useTabCycleKeyboard.svelte";
import { createTabOrder } from "./hooks/useTabOrder.svelte";
import { createTandemModeBroadcast } from "./hooks/useTandemModeBroadcast.svelte";
import { createTandemSettings, TEXT_SIZE_PX } from "./hooks/useTandemSettings.svelte";
import { createTheme } from "./hooks/useTheme.svelte";
import { createTutorial } from "./hooks/useTutorial.svelte";
import { createWebViewZoom } from "./hooks/useWebViewZoom.svelte";
import { createYjsSync } from "./hooks/yjsSync.svelte";
import {
  getRightWidth,
  loadPanelWidth,
  PANEL_MAX_WIDTH,
  PANEL_MIN_WIDTH,
  type PanelLayout,
} from "./panel-layout";
import ReviewSummary from "./panels/ReviewSummary.svelte";
import { pmSelectionToFlat } from "./positions";
import StatusBar from "./status/StatusBar.svelte";
import DocumentTabs from "./tabs/DocumentTabs.svelte";
import { addRecentFile, loadRecentFiles, saveRecentFiles } from "./utils/recentFiles";

const yjsSync = createYjsSync();
onDestroy(() => yjsSync.destroy());

const tabOrder = createTabOrder(() => yjsSync.tabs);
createTabCycleKeyboard(
  () => tabOrder.orderedTabs,
  () => yjsSync.activeTabId,
  (id) => yjsSync.setActiveTabId(id),
);

$effect(() => {
  const tabs = yjsSync.tabs;
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
});

const settingsState = createTandemSettings();
const modeState = createTandemModeBroadcast(
  () => yjsSync.bootstrapYdoc,
  () => settingsState.settings.selectionDwellMs,
);
const modeGate = createModeGate(
  () => yjsSync.annotations,
  () => modeState.tandemMode,
);
const connectionBanner = createConnectionBanner(() => yjsSync.disconnectedSince);
createWebViewZoom();

const openDocs = $derived(yjsSync.tabs.map((t) => ({ id: t.id, fileName: t.fileName })));

const saveShortcut = createSaveShortcut(() => yjsSync.activeTabId);
const notifications = createNotifications();
const fileDrop = createFileDrop();
const reviewCompletion = createReviewCompletion(() => yjsSync.annotations);

let settingsOpen = $state(false);
let settingsBtnEl = $state<HTMLButtonElement | null>(null);

function toggleSettings() {
  settingsOpen = !settingsOpen;
}

createSettingsShortcut(() => toggleSettings);

// Guard: only dispatch when visibility actually changes. Without this, every
// call to updateSettings() (which replaces the entire settings object even
// when showAuthorship is unchanged) would dispatch a transaction, causing
// FormattingToolbar's tick++ listener to fire inside Svelte's effect flush
// and eventually exceed the 1000-update depth limit.
let _lastAuthorshipVisible: boolean | undefined;
$effect(() => {
  const ed = editor;
  if (!ed) return;
  const visible = settingsState.settings.showAuthorship;
  if (_lastAuthorshipVisible === visible) return;
  _lastAuthorshipVisible = visible;
  const tr = ed.state.tr.setMeta(authorshipPluginKey, { type: "toggle", visible });
  ed.view.dispatch(tr);
});

$effect(() => {
  document.body.classList.toggle("tandem-reduce-motion", settingsState.settings.reduceMotion);
  return () => document.body.classList.remove("tandem-reduce-motion");
});

createTheme(() => settingsState.settings.theme);

$effect(() => {
  const px = TEXT_SIZE_PX[settingsState.settings.textSize];
  document.documentElement.style.setProperty("--tandem-editor-font-size", `${px}px`);
  return () => document.documentElement.style.removeProperty("--tandem-editor-font-size");
});

let reviewMode = $state(false);
let showChat = $state(settingsState.settings.primaryTab === "chat");

const pendingAnnotationBadge = $derived(
  !showChat ? 0 : modeGate.visibleAnnotations.filter((a) => a.status === "pending").length,
);

let activeAnnotationId = $state<string | null>(null);
let showHelp = $state(false);
let capturedAnchor = $state<CapturedAnchor | null>(null);
let editor = $state<TiptapEditor | null>(null);

let panelLayout = $state<PanelLayout>(
  (() => {
    const initLayout = settingsState.settings.layout;
    if (initLayout === "three-panel") {
      return { kind: "three-panel", left: loadPanelWidth("left"), right: loadPanelWidth("right") };
    } else if (initLayout === "tabbed-left") {
      return { kind: "tabbed-left", left: loadPanelWidth("left") };
    } else {
      return { kind: "tabbed", right: loadPanelWidth("right") };
    }
  })(),
);

$effect(() => {
  const layout = settingsState.settings.layout;
  const prev = untrack(() => panelLayout);
  if (layout === "three-panel") {
    if (prev.kind === "three-panel") return;
    const right = "right" in prev ? prev.right : loadPanelWidth("right");
    const left = "left" in prev ? prev.left : loadPanelWidth("left");
    panelLayout = { kind: "three-panel", left, right };
  } else if (layout === "tabbed-left") {
    if (prev.kind === "tabbed-left") return;
    const left = "left" in prev ? prev.left : loadPanelWidth("left");
    panelLayout = { kind: "tabbed-left", left };
  } else {
    if (prev.kind === "tabbed") return;
    const right = "right" in prev ? prev.right : loadPanelWidth("right");
    panelLayout = { kind: "tabbed", right };
  }
});

const editorMaxWidth = $derived(
  settingsState.settings.editorWidthPercent < 100
    ? `${settingsState.settings.editorWidthPercent}%`
    : undefined,
);
const editorMargin = $derived(
  settingsState.settings.editorWidthPercent < 100 ? "0 auto" : undefined,
);

const dragResize = createDragResize(
  () => panelLayout,
  (updater) => {
    panelLayout = updater(panelLayout);
  },
);

function toggleReviewMode() {
  reviewMode = !reviewMode;
}

function exitReviewMode() {
  reviewMode = false;
}

function captureSelectionForChat() {
  if (showChat) return;
  if (!editor) return;
  const { from, to } = editor.state.selection;
  if (from === to) return;
  const range = pmSelectionToFlat(editor.state.doc, { from: toPmPos(from), to: toPmPos(to) });
  const text = editor.state.doc.textBetween(from, to, "\n");
  capturedAnchor = {
    ...range,
    textSnapshot: text.length > 200 ? text.slice(0, 197) + "..." : text,
  };
}

$effect(() => {
  function handler(e: KeyboardEvent) {
    if (e.key !== "?") return;
    const el = e.target as HTMLElement;
    if (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable) return;
    showHelp = untrack(() => !showHelp);
  }
  window.addEventListener("keydown", handler);
  return () => window.removeEventListener("keydown", handler);
});

const activeTab = $derived(yjsSync.tabs.find((t) => t.id === yjsSync.activeTabId));

const tutorial = createTutorial(
  () => modeGate.visibleAnnotations,
  () => editor,
  () => activeTab?.fileName,
);
</script>

{#if !yjsSync.ready}
  <div
    style="display: flex; align-items: center; justify-content: center; height: 100vh; color: var(--tandem-fg-subtle);"
  >
    Connecting...
  </div>
{:else}
  <div style="display: flex; flex-direction: column; height: 100vh;">
    {#if yjsSync.serverRestarted}
      <div
        style="padding: 8px 16px; background: var(--tandem-warning-bg); border-bottom: 1px solid var(--tandem-warning-border); font-size: 13px; color: var(--tandem-warning-fg-strong); text-align: center;"
      >
        Server restarted — refreshing documents
      </div>
    {/if}

    {#if connectionBanner.showBanner}
      <ConnectionBanner onDismiss={connectionBanner.dismiss} />
    {/if}

    <Toolbar
      {editor}
      ydoc={activeTab?.ydoc ?? null}
      onSettingsOpen={toggleSettings}
      bind:settingsBtn={settingsBtnEl}
      tandemMode={modeState.tandemMode}
      onModeChange={modeState.setTandemMode}
      heldCount={modeGate.heldCount}
    />

    <DocumentTabs
      tabs={tabOrder.orderedTabs}
      activeTabId={yjsSync.activeTabId}
      onTabSwitch={yjsSync.setActiveTabId}
      onTabClose={yjsSync.handleTabClose}
      reorder={tabOrder.reorder}
      reduceMotion={settingsState.settings.reduceMotion}
    />

    {#if panelLayout.kind === "three-panel"}
      <div style="display: flex; flex: 1; overflow: hidden;">
        <div
          style={`display: flex; flex-direction: column; width: ${panelLayout.left}px; border-right: 1px solid var(--tandem-border);`}
        >
          <div
            style="padding: 6px 12px; font-size: 11px; font-weight: 600; color: var(--tandem-fg-muted); border-bottom: 1px solid var(--tandem-border); background: var(--tandem-surface-muted); text-transform: uppercase; letter-spacing: 0.5px;"
          >
            {settingsState.settings.panelOrder === "chat-editor-annotations" ? "Chat" : "Annotations"}
          </div>
          <div style="display: flex; flex-direction: column; flex: 1; min-height: 0;">
            {#if settingsState.settings.panelOrder === "chat-editor-annotations"}
              <PanelSlot
                kind="chat"
                ctrlYdoc={yjsSync.bootstrapYdoc}
                {editor}
                activeDocId={yjsSync.activeTabId}
                {openDocs}
                claudeActive={yjsSync.claudeActive}
                claudeStatus={yjsSync.claudeStatus}
                {capturedAnchor}
                onCapturedAnchorChange={(a) => (capturedAnchor = a)}
                reduceMotion={settingsState.settings.reduceMotion}
                visible={true}
              />
            {:else}
              <PanelSlot
                kind="side"
                annotations={modeGate.visibleAnnotations}
                {editor}
                ydoc={activeTab?.ydoc ?? null}
                heldCount={modeGate.heldCount}
                tandemMode={modeState.tandemMode}
                onModeChange={modeState.setTandemMode}
                activeDocFormat={activeTab?.format}
                documentId={activeTab?.id}
                {reviewMode}
                onToggleReviewMode={toggleReviewMode}
                onExitReviewMode={exitReviewMode}
                {activeAnnotationId}
                onActiveAnnotationChange={(id) => (activeAnnotationId = id)}
                reduceMotion={settingsState.settings.reduceMotion}
              />
            {/if}
          </div>
        </div>

        {@render resizeHandle("left", (e) => dragResize.handleResizeStart(e, "left"), undefined, panelLayout.left)}
        {@render editorColumn()}
        {@render resizeHandle("right", (e) => dragResize.handleResizeStart(e, "right"), undefined, getRightWidth(panelLayout))}

        <div
          style={`display: flex; flex-direction: column; width: ${getRightWidth(panelLayout)}px; border-left: 1px solid var(--tandem-border);`}
        >
          <div
            style="padding: 6px 12px; font-size: 11px; font-weight: 600; color: var(--tandem-fg-muted); border-bottom: 1px solid var(--tandem-border); background: var(--tandem-surface-muted); text-transform: uppercase; letter-spacing: 0.5px;"
          >
            {settingsState.settings.panelOrder === "chat-editor-annotations" ? "Annotations" : "Chat"}
          </div>
          <div style="display: flex; flex-direction: column; flex: 1; min-height: 0;">
            {#if settingsState.settings.panelOrder === "chat-editor-annotations"}
              <PanelSlot
                kind="side"
                annotations={modeGate.visibleAnnotations}
                {editor}
                ydoc={activeTab?.ydoc ?? null}
                heldCount={modeGate.heldCount}
                tandemMode={modeState.tandemMode}
                onModeChange={modeState.setTandemMode}
                activeDocFormat={activeTab?.format}
                documentId={activeTab?.id}
                {reviewMode}
                onToggleReviewMode={toggleReviewMode}
                onExitReviewMode={exitReviewMode}
                {activeAnnotationId}
                onActiveAnnotationChange={(id) => (activeAnnotationId = id)}
                reduceMotion={settingsState.settings.reduceMotion}
              />
            {:else}
              <PanelSlot
                kind="chat"
                ctrlYdoc={yjsSync.bootstrapYdoc}
                {editor}
                activeDocId={yjsSync.activeTabId}
                {openDocs}
                claudeActive={yjsSync.claudeActive}
                claudeStatus={yjsSync.claudeStatus}
                {capturedAnchor}
                onCapturedAnchorChange={(a) => (capturedAnchor = a)}
                reduceMotion={settingsState.settings.reduceMotion}
                visible={true}
              />
            {/if}
          </div>
        </div>
      </div>

    {:else if panelLayout.kind === "tabbed-left"}
      <div style="display: flex; flex: 1; overflow: hidden;">
        {@render tabbedPanel(panelLayout.left, "left")}
        {@render resizeHandle("left", (e) => dragResize.handleResizeStart(e, "left"), undefined, panelLayout.left)}
        {@render editorColumn()}
      </div>

    {:else}
      <div style="display: flex; flex: 1; overflow: hidden;">
        {@render editorColumn()}
        {@render resizeHandle("right", (e) => dragResize.handleResizeStart(e, "right"), "panel-resize-handle", getRightWidth(panelLayout))}
        {@render tabbedPanel(getRightWidth(panelLayout), "right")}
      </div>
    {/if}

    <StatusBar
      connected={yjsSync.connected}
      connectionStatus={yjsSync.connectionStatus}
      reconnectAttempts={yjsSync.reconnectAttempts}
      disconnectedSince={yjsSync.disconnectedSince}
      claudeStatus={yjsSync.claudeStatus}
      claudeActive={yjsSync.claudeActive}
      readOnly={yjsSync.readOnly}
      documentCount={yjsSync.tabs.length}
      saving={saveShortcut.saving}
    />

    {#if reviewCompletion.showReviewSummary && reviewCompletion.reviewSummaryData}
      <ReviewSummary
        accepted={reviewCompletion.reviewSummaryData.accepted}
        dismissed={reviewCompletion.reviewSummaryData.dismissed}
        total={reviewCompletion.reviewSummaryData.total}
        onDismiss={reviewCompletion.dismissReviewSummary}
      />
    {/if}

    <SettingsPopover
      open={settingsOpen}
      onClose={() => (settingsOpen = false)}
      settings={settingsState.settings}
      onUpdate={settingsState.updateSettings}
      returnFocusEl={settingsBtnEl}
      anchorEl={settingsBtnEl}
    />

    <HelpModal open={showHelp} onClose={() => (showHelp = false)} />

    <ToastContainer toasts={notifications.toasts} onDismiss={notifications.dismiss} />

    {#if isTauriRuntime()}
      <CoworkAdminDeclinedModal />
    {/if}

    {#if tutorial.tutorialActive}
      <OnboardingTutorial
        currentStep={tutorial.currentStep}
        onNext={tutorial.nextStep}
        onDismiss={tutorial.dismissTutorial}
        coworkStatus={tutorial.coworkStatus}
      />
    {/if}
  </div>
{/if}

{#snippet resizeHandle(side: "left" | "right", onmousedown: (e: MouseEvent) => void, testId?: string, widthPx?: number)}
  <div
    data-testid={testId ?? `${side}-panel-resize-handle`}
    role="slider"
    aria-orientation="vertical"
    aria-label={side === "left" ? "Resize left panel" : "Resize right panel"}
    aria-valuenow={widthPx !== undefined
      ? Math.round(((widthPx - PANEL_MIN_WIDTH) / (PANEL_MAX_WIDTH - PANEL_MIN_WIDTH)) * 100)
      : 50}
    aria-valuemin={0}
    aria-valuemax={100}
    tabindex="0"
    {onmousedown}
    style="width: 4px; cursor: col-resize; background: transparent; flex-shrink: 0; transition: background 0.15s;"
    onmouseenter={(e) => {
      (e.currentTarget as HTMLDivElement).style.background = "var(--tandem-border-strong)";
    }}
    onmouseleave={(e) => {
      (e.currentTarget as HTMLDivElement).style.background = "transparent";
    }}
  ></div>
{/snippet}

{#snippet editorColumn()}
  <div
    role="region"
    aria-label="Document editor"
    style={`flex: 1; overflow: auto; padding: 24px 48px; border: ${fileDrop.fileDragOver ? "2px dashed var(--tandem-accent)" : "2px solid transparent"}; background: ${fileDrop.fileDragOver ? "var(--tandem-accent-bg)" : ""}; transition: border-color 0.15s, background 0.15s;`}
    ondragover={fileDrop.handleEditorDragOver}
    ondragleave={fileDrop.handleEditorDragLeave}
    ondrop={fileDrop.handleEditorDrop}
  >
    <ReviewOnlyBanner
      visible={activeTab?.readOnly === true && activeTab?.format === "docx"}
      documentId={activeTab?.id}
    />
    <div style={`max-width: ${editorMaxWidth ?? "none"}; margin: ${editorMargin ?? "0"};`}>
      {#if activeTab}
        {#key activeTab.id}
          <Editor
            ydoc={activeTab.ydoc}
            provider={activeTab.provider}
            readOnly={yjsSync.readOnly}
            {reviewMode}
            {activeAnnotationId}
            onEditorReady={(ed) => (editor = ed)}
            onAnnotationClick={(id) => {
              showChat = false;
              activeAnnotationId = id;
            }}
          />
        {/key}
      {:else}
        <EmptyState connected={yjsSync.connected} claudeActive={yjsSync.claudeActive} />
      {/if}
    </div>
  </div>
{/snippet}

{#snippet tabbedPanel(width: number, borderSide: "left" | "right")}
  <div
    style={`display: flex; flex-direction: column; width: ${width}px; ${borderSide === "left" ? "border-right" : "border-left"}: 1px solid var(--tandem-border);`}
  >
    <div
      style="display: flex; border-bottom: 1px solid var(--tandem-border); background: var(--tandem-surface-muted);"
    >
      <button
        data-testid="annotations-tab"
        onclick={() => (showChat = false)}
        style={`flex: 1; padding: 8px; font-size: 12px; font-weight: ${showChat ? 400 : 600}; border: none; border-bottom: ${showChat ? "none" : "2px solid var(--tandem-accent)"}; background: transparent; cursor: pointer; color: ${showChat ? "var(--tandem-fg-muted)" : "var(--tandem-accent)"}; position: relative;`}
      >
        Annotations
        {#if showChat && pendingAnnotationBadge > 0}
          <span
            style="position: absolute; top: 2px; right: 6px; background: var(--tandem-error); color: var(--tandem-error-fg); font-size: 9px; width: 16px; height: 16px; border-radius: 50%; display: flex; align-items: center; justify-content: center; font-weight: 700;"
          >
            {pendingAnnotationBadge > 9 ? "9+" : pendingAnnotationBadge}
          </span>
        {/if}
      </button>
      <button
        data-testid="chat-tab"
        onmousedown={captureSelectionForChat}
        onclick={() => (showChat = true)}
        style={`flex: 1; padding: 8px; font-size: 12px; font-weight: ${showChat ? 600 : 400}; border: none; border-bottom: ${showChat ? "2px solid var(--tandem-accent)" : "none"}; background: transparent; cursor: pointer; color: ${showChat ? "var(--tandem-accent)" : "var(--tandem-fg-muted)"}; position: relative;`}
      >
        Chat
      </button>
    </div>
    <PanelSlot
      kind="chat"
      ctrlYdoc={yjsSync.bootstrapYdoc}
      {editor}
      activeDocId={yjsSync.activeTabId}
      {openDocs}
      claudeActive={yjsSync.claudeActive}
      claudeStatus={yjsSync.claudeStatus}
      {capturedAnchor}
      onCapturedAnchorChange={(a) => (capturedAnchor = a)}
      reduceMotion={settingsState.settings.reduceMotion}
      visible={showChat}
    />
    <PanelSlot
      kind="side"
      annotations={modeGate.visibleAnnotations}
      {editor}
      ydoc={activeTab?.ydoc ?? null}
      heldCount={modeGate.heldCount}
      tandemMode={modeState.tandemMode}
      onModeChange={modeState.setTandemMode}
      activeDocFormat={activeTab?.format}
      documentId={activeTab?.id}
      {reviewMode}
      onToggleReviewMode={toggleReviewMode}
      onExitReviewMode={exitReviewMode}
      {activeAnnotationId}
      onActiveAnnotationChange={(id) => (activeAnnotationId = id)}
      reduceMotion={settingsState.settings.reduceMotion}
      visible={!showChat}
    />
  </div>
{/snippet}
