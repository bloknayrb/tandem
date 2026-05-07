<script lang="ts">
import type { Editor as TiptapEditor } from "@tiptap/core";
import { onDestroy, untrack } from "svelte";
import { PANEL_WIDTH_KEYS, Y_MAP_DOCUMENT_META, Y_MAP_SAVED_AT_VERSION } from "../shared/constants";
import { isUploadPath } from "../shared/paths";
import { toPmPos } from "../shared/positions/types";
import type { CapturedAnchor } from "../shared/types";
import { isPendingReviewTarget } from "../shared/types";
import { saveStore, triggerSave, wireActionDeps } from "./actions/builtin.svelte.js";
import CommandPalette from "./components/CommandPalette.svelte";
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
import DocxPageContainer from "./editor/DocxPageContainer.svelte";
import Editor from "./editor/Editor.svelte";
import { authorshipPluginKey } from "./editor/extensions/authorship";
import FindReplaceBar from "./editor/find-replace/FindReplaceBar.svelte";
import Toolbar from "./editor/toolbar/Toolbar.svelte";
import { createAccentHue } from "./hooks/useAccentHue.svelte";
import { createAnnotationPatterns } from "./hooks/useAnnotationPatterns.svelte";
import { createConnectionBanner } from "./hooks/useConnectionBanner.svelte";
import { createDensity } from "./hooks/useDensity.svelte";
import { createDragResize } from "./hooks/useDragResize.svelte";
import { createRootEditorFont } from "./hooks/useEditorFont.svelte";
import { createFileDrop } from "./hooks/useFileDrop.svelte";
import { createHighContrast } from "./hooks/useHighContrast.svelte";
import { shouldShowInMode } from "./hooks/useModeGate";
import { createNotifications } from "./hooks/useNotifications.svelte";
import { isSettingsShortcut } from "./hooks/useSettingsShortcut.js";
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
  PANEL_DEFAULT_WIDTH,
  PANEL_MAX_WIDTH,
  PANEL_MIN_WIDTH,
  type PanelLayout,
} from "./panel-layout";
import type { FilterAuthor, FilterStatus, FilterType } from "./panels/FilterBar.svelte";
import { pmSelectionToFlat } from "./positions";
import FormattingBar from "./shell/FormattingBar.svelte";
import TitleBar from "./shell/TitleBar.svelte";
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
const modeGate = $derived.by(() => {
  const annotations = yjsSync.annotations;
  const mode = modeState.tandemMode;
  const visibleAnnotations = [];
  let heldCount = 0;

  for (const ann of annotations) {
    if (shouldShowInMode(ann, mode)) visibleAnnotations.push(ann);
    else if (ann.status === "pending") heldCount++;
  }

  return { visibleAnnotations, heldCount };
});
const connectionBanner = createConnectionBanner(() => yjsSync.disconnectedSince);
createWebViewZoom();

const openDocs = $derived(yjsSync.tabs.map((t) => ({ id: t.id, fileName: t.fileName })));

const notifications = createNotifications();
const fileDrop = createFileDrop();

let settingsOpen = $state(false);
let settingsBtnEl = $state<HTMLButtonElement | null>(null);
let paletteOpen = $state(false);

function toggleSettings() {
  settingsOpen = !settingsOpen;
}

// Wire action dependencies for builtin actions (save, settings, find, mode)
// after the reactive state they depend on is available.
wireActionDeps({
  getActiveTabId: () => yjsSync.activeTabId,
  openSettings: () => (settingsOpen = true),
  toggleSoloMode: () =>
    modeState.setTandemMode(modeState.tandemMode === "solo" ? "tandem" : "solo"),
  // openFindBar wired when PR 570 (find/replace bar) merges into this branch
  openFindBar: () => {},
});

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
createAccentHue(() => settingsState.settings.accentHue);
createRootEditorFont(() => settingsState.settings.editorFont);
createDensity(() => settingsState.settings.density);
createHighContrast(() => settingsState.settings.highContrast);
createAnnotationPatterns(() => settingsState.settings.annotationPatterns);

$effect(() => {
  const px = TEXT_SIZE_PX[settingsState.settings.textSize];
  document.documentElement.style.setProperty("--tandem-editor-font-size", `${px}px`);
  return () => document.documentElement.style.removeProperty("--tandem-editor-font-size");
});

let showChat = $state(settingsState.settings.primaryTab === "chat");

const pendingAnnotationBadge = $derived(
  !showChat ? 0 : modeGate.visibleAnnotations.filter(isPendingReviewTarget).length,
);

let activeAnnotationId = $state<string | null>(null);
let showHelp = $state(false);
let capturedAnchor = $state<CapturedAnchor | null>(null);
let editor = $state<TiptapEditor | null>(null);
let slashCommandMenuOpen = $state(false);
let findBarOpen = $state(false);
let outlineFocusTrigger = $state(0);
let activeAnnotationFilter = $state<{
  type: FilterType;
  author: FilterAuthor;
  status: FilterStatus;
}>({
  type: "all",
  author: "all",
  status: "all",
});

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

const effectivePanelHidden = $derived(
  settingsState.settings.panelHidden ||
    (modeState.tandemMode === "solo" && settingsState.settings.soloRailHidden),
);

function togglePanel() {
  if (effectivePanelHidden) {
    // Show panel: clear both flags so solo-mode soloRailHidden doesn't keep it hidden.
    settingsState.updateSettings({
      panelHidden: false,
      ...(modeState.tandemMode === "solo" ? { soloRailHidden: false } : {}),
    });
  } else {
    settingsState.updateSettings({ panelHidden: true });
  }
}

// Remembers the last non-three-panel layout so toggling off three-panel restores it.
let prevNonThreePanelLayout: "tabbed" | "tabbed-left" = "tabbed";

function toggleLayout() {
  const current = settingsState.settings.layout;
  if (current === "three-panel") {
    settingsState.updateSettings({ layout: prevNonThreePanelLayout });
  } else {
    prevNonThreePanelLayout = current;
    settingsState.updateSettings({ layout: "three-panel" });
  }
}

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
    if (e.key === "?") {
      const el = e.target as HTMLElement;
      if (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable) return;
      showHelp = untrack(() => !showHelp);
      return;
    }
    if (e.ctrlKey || e.metaKey) {
      if (e.key === "a") {
        const active = document.activeElement;
        if (active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement) return;
        if (active?.closest?.(".ProseMirror")) return;
        e.preventDefault();
        editor?.commands.selectAll();
      } else if (e.key === "s") {
        e.preventDefault();
        void triggerSave(yjsSync.activeTabId);
      } else if (isSettingsShortcut(e)) {
        e.preventDefault();
        settingsOpen = true;
      } else if (e.shiftKey && e.key === "P") {
        e.preventDefault();
        paletteOpen = !untrack(() => paletteOpen);
      } else if (e.key === "/") {
        const el = e.target as HTMLElement;
        if (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable) return;
        e.preventDefault();
        showHelp = untrack(() => !showHelp);
      }
    }
    // Ctrl/Cmd+F — focus outline search if the outline panel is visible; fall back to find bar.
    if ((e.ctrlKey || e.metaKey) && e.key === "f") {
      e.preventDefault();
      const isOutlineVisible =
        panelLayout.kind === "three-panel" &&
        !effectivePanelHidden &&
        settingsState.settings.leftSlot.kind === "outline";
      if (isOutlineVisible) {
        outlineFocusTrigger += 1;
      } else {
        findBarOpen = true;
      }
    }
  }
  window.addEventListener("keydown", handler);
  return () => window.removeEventListener("keydown", handler);
});

const activeTab = $derived(yjsSync.tabs.find((t) => t.id === yjsSync.activeTabId));

// Track dirty state for the active tab so TitleBar can show the unsaved dot.
let activeTabDirty = $state(false);
$effect(() => {
  const tab = activeTab;
  if (!tab || tab.readOnly) {
    activeTabDirty = false;
    return;
  }
  const fragment = tab.ydoc.getXmlFragment("default");
  const meta = tab.ydoc.getMap(Y_MAP_DOCUMENT_META);
  let armed = false;
  let baseline: number | null = null;
  activeTabDirty = false;
  const armTimer = setTimeout(() => {
    armed = true;
    baseline = (meta.get(Y_MAP_SAVED_AT_VERSION) as number) ?? 0;
  }, 500);
  const onFragmentChange = () => {
    if (armed) activeTabDirty = true;
  };
  fragment.observeDeep(onFragmentChange);
  const onMetaChange = (event: import("yjs").YMapEvent<unknown>) => {
    if (!event.keysChanged.has(Y_MAP_SAVED_AT_VERSION)) return;
    if (!armed) return;
    const saved = meta.get(Y_MAP_SAVED_AT_VERSION) as number | undefined;
    if (saved !== undefined && saved !== baseline) {
      baseline = saved;
      activeTabDirty = false;
    }
  };
  meta.observe(onMetaChange);
  return () => {
    clearTimeout(armTimer);
    fragment.unobserveDeep(onFragmentChange);
    meta.unobserve(onMetaChange);
  };
});

const tutorial = createTutorial(
  () => modeGate.visibleAnnotations,
  () => editor,
  () => activeTab?.fileName,
);
</script>

<div style="display: flex; flex-direction: column; height: 100vh; background: var(--tandem-bg); color: var(--tandem-fg);">
  <TitleBar
    title={activeTab?.fileName}
    dirty={activeTabDirty}
    panelVisible={!settingsState.settings.panelHidden}
    onTogglePanel={togglePanel}
    isThreePanel={panelLayout.kind === "three-panel"}
    onToggleLayout={toggleLayout}
  />
  {#if !yjsSync.ready}
    <div
      style="display: flex; flex: 1; align-items: center; justify-content: center; color: var(--tandem-fg-subtle);"
    >
      Connecting...
    </div>
  {:else}
    {#if yjsSync.serverRestarted}
      <div
        style="padding: var(--tandem-space-2) var(--tandem-space-4); background: var(--tandem-warning-bg); border-bottom: 1px solid var(--tandem-warning-border); font-size: 13px; color: var(--tandem-warning-fg-strong); text-align: center;"
      >
        Server restarted — refreshing documents
      </div>
    {/if}

    {#if connectionBanner.showBanner}
      <ConnectionBanner
        onDismiss={connectionBanner.dismiss}
        onRetry={() => { yjsSync.reconnect(); }}
      />
    {/if}

    <Toolbar
      {editor}
      ydoc={activeTab?.ydoc ?? null}
      onSettingsOpen={toggleSettings}
      bind:settingsBtn={settingsBtnEl}
      tandemMode={modeState.tandemMode}
      onModeChange={modeState.setTandemMode}
      selectionToolbar={settingsState.settings.selectionToolbar}
      suppressSelectionToolbar={slashCommandMenuOpen || findBarOpen || paletteOpen}
    />

    <DocumentTabs
      tabs={tabOrder.orderedTabs}
      activeTabId={yjsSync.activeTabId}
      onTabSwitch={yjsSync.setActiveTabId}
      onTabClose={yjsSync.handleTabClose}
      reorder={tabOrder.reorder}
      reduceMotion={settingsState.settings.reduceMotion}
    />

    <FormattingBar
      {editor}
      ydoc={activeTab?.ydoc ?? null}
      panelVisible={!settingsState.settings.panelHidden}
      onTogglePanel={togglePanel}
      rightPanelVisible={!effectivePanelHidden}
      onTogglePanelRight={togglePanel}
    />

    <!-- Single persistent container — editor column is always rendered in the same
         DOM position so the Editor component never remounts on layout changes.
         Panels are conditionally shown/hidden around the stable editor column. -->
    <div style="display: flex; flex: 1; overflow: hidden; background: var(--tandem-bg);">
      {#if panelLayout.kind === "three-panel"}
        {#if !effectivePanelHidden}
          <div
            style={`display: flex; flex-direction: column; width: ${panelLayout.left}px; border-right: 1px solid var(--tandem-border); background: var(--tandem-surface-muted);`}
          >
            <div
              style="padding: var(--tandem-space-2) var(--tandem-space-3); font-family: var(--tandem-font-mono); font-size: 10px; font-weight: 500; color: var(--tandem-fg-subtle); border-bottom: 1px solid var(--tandem-border); background: var(--tandem-surface-muted); text-transform: uppercase; letter-spacing: 0.06em;"
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
                  kind={settingsState.settings.leftSlot.kind}
                  annotations={modeGate.visibleAnnotations}
                  focusTrigger={outlineFocusTrigger}
                  activeFilterType={activeAnnotationFilter.type}
                  activeFilterAuthor={activeAnnotationFilter.author}
                  activeFilterStatus={activeAnnotationFilter.status}
                  onFilterChange={(type, author, status) => {
                    activeAnnotationFilter = { type, author, status };
                  }}
                  {editor}
                  ydoc={activeTab?.ydoc ?? null}
                  heldCount={modeGate.heldCount}
                  tandemMode={modeState.tandemMode}
                  onModeChange={modeState.setTandemMode}
                  activeDocFormat={activeTab?.format}
                  documentId={activeTab?.id}
                  {activeAnnotationId}
                  onActiveAnnotationChange={(id) => (activeAnnotationId = id)}
                  reduceMotion={settingsState.settings.reduceMotion}
                />
              {/if}
            </div>
          </div>
          {@render resizeHandle("left", (e) => dragResize.handleResizeStart(e, "left"), undefined, panelLayout.left)}
        {/if}
      {:else if panelLayout.kind === "tabbed-left"}
        {#if !effectivePanelHidden}
          {@render tabbedPanel(panelLayout.left, "left")}
          {@render resizeHandle("left", (e) => dragResize.handleResizeStart(e, "left"), undefined, panelLayout.left)}
        {/if}
      {/if}

      {@render editorColumn()}

      {#if panelLayout.kind === "three-panel"}
        {#if !effectivePanelHidden}
          {@render resizeHandle("right", (e) => dragResize.handleResizeStart(e, "right"), undefined, getRightWidth(panelLayout))}
          <div
            style={`display: flex; flex-direction: column; width: ${getRightWidth(panelLayout)}px; border-left: 1px solid var(--tandem-border); background: var(--tandem-surface-muted);`}
          >
            <div
              style="padding: var(--tandem-space-2) var(--tandem-space-3); font-family: var(--tandem-font-mono); font-size: 10px; font-weight: 500; color: var(--tandem-fg-subtle); border-bottom: 1px solid var(--tandem-border); background: var(--tandem-surface-muted); text-transform: uppercase; letter-spacing: 0.06em;"
            >
              {settingsState.settings.panelOrder === "chat-editor-annotations" ? "Annotations" : "Chat"}
            </div>
            <div style="display: flex; flex-direction: column; flex: 1; min-height: 0;">
              {#if settingsState.settings.panelOrder === "chat-editor-annotations"}
                <PanelSlot
                  kind={settingsState.settings.leftSlot.kind}
                  annotations={modeGate.visibleAnnotations}
                  focusTrigger={outlineFocusTrigger}
                  activeFilterType={activeAnnotationFilter.type}
                  activeFilterAuthor={activeAnnotationFilter.author}
                  activeFilterStatus={activeAnnotationFilter.status}
                  onFilterChange={(type, author, status) => {
                    activeAnnotationFilter = { type, author, status };
                  }}
                  {editor}
                  ydoc={activeTab?.ydoc ?? null}
                  heldCount={modeGate.heldCount}
                  tandemMode={modeState.tandemMode}
                  onModeChange={modeState.setTandemMode}
                  activeDocFormat={activeTab?.format}
                  documentId={activeTab?.id}
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
        {/if}
      {:else if panelLayout.kind === "tabbed"}
        {#if !effectivePanelHidden}
          {@render resizeHandle("right", (e) => dragResize.handleResizeStart(e, "right"), "panel-resize-handle", getRightWidth(panelLayout))}
          {@render tabbedPanel(getRightWidth(panelLayout), "right")}
        {/if}
      {/if}
    </div>

    <StatusBar
      connected={yjsSync.connected}
      connectionStatus={yjsSync.connectionStatus}
      reconnectAttempts={yjsSync.reconnectAttempts}
      disconnectedSince={yjsSync.disconnectedSince}
      claudeStatus={yjsSync.claudeStatus}
      claudeActive={yjsSync.claudeActive}
      readOnly={yjsSync.readOnly}
      documentCount={yjsSync.tabs.length}
      saving={saveStore.saving}
      heldCount={modeGate.heldCount}
      mode={modeState.tandemMode}
      onShowHeld={() => modeState.setTandemMode("tandem")}
    />

    <SettingsPopover
      open={settingsOpen}
      onClose={() => (settingsOpen = false)}
      settings={settingsState.settings}
      onUpdate={settingsState.updateSettings}
      returnFocusEl={settingsBtnEl}
      anchorEl={settingsBtnEl}
    />

    <HelpModal open={showHelp} onClose={() => (showHelp = false)} />

    <CommandPalette
      open={paletteOpen}
      onClose={() => (paletteOpen = false)}
      {editor}
      annotations={modeGate.visibleAnnotations}
      onFocusAnnotation={(id) => { activeAnnotationId = id; }}
    />

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
  {/if}
</div>

{#snippet resizeHandle(side: "left" | "right", onmousedown: (e: MouseEvent) => void, testId?: string, widthPx?: number)}
  <div
    data-testid={testId ?? `${side}-panel-resize-handle`}
    role="slider"
    aria-orientation="horizontal"
    aria-label={side === "left" ? "Resize left panel" : "Resize right panel"}
    aria-valuenow={widthPx !== undefined
      ? Math.round(((widthPx - PANEL_MIN_WIDTH) / (PANEL_MAX_WIDTH - PANEL_MIN_WIDTH)) * 100)
      : 50}
    aria-valuemin={0}
    aria-valuemax={100}
    tabindex="0"
    {onmousedown}
    onkeydown={(e) => {
      const STEP = 16;
      const BIG_STEP = 80;
      let delta: number | null = null;
      if (e.key === "ArrowRight" || e.key === "ArrowUp") delta = STEP;
      else if (e.key === "ArrowLeft" || e.key === "ArrowDown") delta = -STEP;
      else if (e.key === "PageUp") delta = BIG_STEP;
      else if (e.key === "PageDown") delta = -BIG_STEP;
      else if (e.key === "Home") delta = PANEL_MIN_WIDTH - (side === "left" ? (panelLayout.kind !== "tabbed" && "left" in panelLayout ? panelLayout.left : PANEL_DEFAULT_WIDTH) : getRightWidth(panelLayout));
      else if (e.key === "End") delta = PANEL_MAX_WIDTH - (side === "left" ? (panelLayout.kind !== "tabbed" && "left" in panelLayout ? panelLayout.left : PANEL_DEFAULT_WIDTH) : getRightWidth(panelLayout));
      if (delta !== null) {
        e.preventDefault();
        e.stopPropagation();
        dragResize.handleResizeStep(side, delta);
      }
    }}
    onkeyup={(e) => {
      const resizeKeys = ["ArrowRight","ArrowLeft","ArrowUp","ArrowDown","PageUp","PageDown","Home","End"];
      if (!resizeKeys.includes(e.key)) return;
      const layoutNow = panelLayout;
      const w = side === "left"
        ? ("left" in layoutNow ? layoutNow.left : PANEL_DEFAULT_WIDTH)
        : getRightWidth(layoutNow);
      const shouldPersist = (side === "left" && "left" in layoutNow) || (side === "right" && "right" in layoutNow);
      if (shouldPersist) {
        try { localStorage.setItem(PANEL_WIDTH_KEYS[side], String(w)); } catch {}
      }
    }}
    style="width: 4px; cursor: col-resize; background: transparent; flex-shrink: 0; transition: background 0.15s; position: relative; z-index: var(--tandem-z-base);"
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
    class="editor-scroll"
    role="region"
    aria-label="Document editor"
    style={`position: relative; flex: 1; overflow: auto; padding: var(--tandem-space-7) var(--tandem-space-5); border: ${fileDrop.fileDragOver ? "2px dashed var(--tandem-accent)" : "2px solid transparent"}; background: ${fileDrop.fileDragOver ? "var(--tandem-accent-bg)" : "var(--tandem-bg)"}; transition: border-color 0.15s, background 0.15s; border-radius: ${fileDrop.fileDragOver ? "var(--tandem-r-5)" : "0"};`}
    ondragover={fileDrop.handleEditorDragOver}
    ondragleave={fileDrop.handleEditorDragLeave}
    ondrop={fileDrop.handleEditorDrop}
  >
    <ReviewOnlyBanner
      visible={activeTab?.readOnly === true && activeTab?.format === "docx"}
      documentId={activeTab?.id}
    />
    {#snippet editorContent()}
      <Editor
        ydoc={activeTab!.ydoc}
        provider={activeTab!.provider}
        readOnly={yjsSync.readOnly}
        {activeAnnotationId}
        onEditorReady={(ed) => (editor = ed)}
        onAnnotationClick={(id) => {
          showChat = false;
          activeAnnotationId = id;
        }}
        onSlashCommandMenuChange={(open) => (slashCommandMenuOpen = open)}
      />
    {/snippet}
    <!-- DocxPageContainer wraps Editor for .docx; format is stable per activeTab.id key guard —
         both branches share the same onEditorReady to update the editor ref -->
    {#if activeTab?.format === "docx"}
      <DocxPageContainer>
        {#key activeTab.id}
          {@render editorContent()}
        {/key}
      </DocxPageContainer>
    {:else}
      <div style={`max-width: ${editorMaxWidth ?? "68ch"}; margin: ${editorMargin ?? "0 auto"};`}>
        {#if activeTab}
          {#key activeTab.id}
            {@render editorContent()}
          {/key}
        {:else}
          <EmptyState connected={yjsSync.connected} claudeActive={yjsSync.claudeActive} />
        {/if}
      </div>
    {/if}
    <!-- Find/Replace bar — always mounted so query persists; overlaid at bottom of editor column -->
    <FindReplaceBar
      {editor}
      open={findBarOpen}
      onClose={() => (findBarOpen = false)}
      tabs={yjsSync.tabs}
    />
  </div>
{/snippet}

{#snippet tabbedPanel(width: number, borderSide: "left" | "right")}
  <div
    style={`display: flex; flex-direction: column; width: ${width}px; ${borderSide === "left" ? "border-right" : "border-left"}: 1px solid var(--tandem-border); background: var(--tandem-surface-muted);`}
  >
    <div
      style="display: flex; border-bottom: 1px solid var(--tandem-border); background: var(--tandem-surface-muted); min-height: 38px; align-items: stretch; padding: 0 var(--tandem-space-3); gap: 2px;"
    >
      <button
        data-testid="annotations-tab"
        onclick={() => (showChat = false)}
        style={`flex: 1; padding: 0 var(--tandem-space-3); font-size: 12px; font-weight: 500; border: none; border-bottom: ${showChat ? "2px solid transparent" : "2px solid var(--tandem-accent)"}; background: transparent; cursor: pointer; color: ${showChat ? "var(--tandem-fg-subtle)" : "var(--tandem-fg)"}; position: relative;`}
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
        style={`flex: 1; padding: 0 var(--tandem-space-3); font-size: 12px; font-weight: 500; border: none; border-bottom: ${showChat ? "2px solid var(--tandem-accent)" : "2px solid transparent"}; background: transparent; cursor: pointer; color: ${showChat ? "var(--tandem-fg)" : "var(--tandem-fg-subtle)"}; position: relative;`}
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
      {activeAnnotationId}
      onActiveAnnotationChange={(id) => (activeAnnotationId = id)}
      reduceMotion={settingsState.settings.reduceMotion}
      onFilterChange={(type, author, status) => {
        activeAnnotationFilter = { type, author, status };
      }}
      visible={!showChat}
    />
  </div>
{/snippet}
