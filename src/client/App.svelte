<script lang="ts">
import type { Editor as TiptapEditor } from "@tiptap/core";
import { onDestroy, untrack } from "svelte";
import { API_OPEN } from "../shared/api-paths.js";
import { isUploadPath } from "../shared/paths";
import { toPmPos } from "../shared/positions/types";
import type { CapturedAnchor } from "../shared/types";
import { isPendingReviewTarget } from "../shared/types";
import {
  createScratchpad,
  saveStore,
  triggerSave,
  wireActionDeps,
} from "./actions/builtin.svelte.js";
import CommandPalette from "./components/CommandPalette.svelte";
import ConnectionBanner from "./components/ConnectionBanner.svelte";
import CoworkAdminDeclinedModal from "./components/CoworkAdminDeclinedModal.svelte";
import EmptyState from "./components/EmptyState.svelte";
import FileOpenDialog from "./components/FileOpenDialog.svelte";
import HelpModal from "./components/HelpModal.svelte";
import OnboardingTutorial from "./components/OnboardingTutorial.svelte";
import PanelSlot from "./components/PanelSlot.svelte";
import ReviewOnlyBanner from "./components/ReviewOnlyBanner.svelte";
import SettingsModal from "./components/SettingsModal.svelte";
import SettingsPopover from "./components/SettingsPopover.svelte";
import ToastContainer from "./components/ToastContainer.svelte";
import { isTauriRuntime } from "./cowork/cowork-helpers";
import DocxPageContainer from "./editor/DocxPageContainer.svelte";
import Editor from "./editor/Editor.svelte";
import { authorshipPluginKey } from "./editor/extensions/authorship";
import { getFindState } from "./editor/extensions/find-replace.js";
import FindReplaceBar from "./editor/find-replace/FindReplaceBar.svelte";
import Toolbar from "./editor/toolbar/Toolbar.svelte";
import { createAccentHue } from "./hooks/useAccentHue.svelte";
import {
  nextAnnotationId,
  prevAnnotationId,
  sortAnnotationsByPosition,
} from "./hooks/useAnnotationOrder.js";
import { createAnnotationPatterns } from "./hooks/useAnnotationPatterns.svelte";
import { createClosedTabStack } from "./hooks/useClosedTabStack.js";
import { createConnectionBanner } from "./hooks/useConnectionBanner.svelte";
import { createDensity } from "./hooks/useDensity.svelte";
import { createDragResize } from "./hooks/useDragResize.svelte";
import { createRootEditorFont } from "./hooks/useEditorFont.svelte";
import { createFileDrop } from "./hooks/useFileDrop.svelte";
import { shouldDispatchFindNav } from "./hooks/useFindShortcuts.js";
import { createHighContrast } from "./hooks/useHighContrast.svelte";
import { createMarginPositions } from "./hooks/useMarginPositions.svelte";
import { shouldShowInMode } from "./hooks/useModeGate";
import { createNotifications } from "./hooks/useNotifications.svelte";
import { isSettingsModalShortcut, isSettingsShortcut } from "./hooks/useSettingsShortcut.js";
import { createTabCycleKeyboard } from "./hooks/useTabCycleKeyboard.svelte";
import { pickTabByDigit, shouldIgnoreShortcut } from "./hooks/useTabKeyboardShortcuts.js";
import { createTabOrder } from "./hooks/useTabOrder.svelte";
import { createTandemModeBroadcast } from "./hooks/useTandemModeBroadcast.svelte";
import { createTandemSettings, TEXT_SIZE_PX, THEME_NEXT } from "./hooks/useTandemSettings.svelte";
import { createTheme } from "./hooks/useTheme.svelte";
import { createTutorial } from "./hooks/useTutorial.svelte";
import { createWebViewZoom } from "./hooks/useWebViewZoom.svelte";
import { createYjsSync } from "./hooks/yjsSync.svelte";
import { loadPanelWidth, PANEL_MAX_WIDTH, PANEL_MIN_WIDTH } from "./panel-layout";
import type { FilterAuthor, FilterStatus, FilterType } from "./panels/FilterBar.svelte";
import MarginColumn from "./panels/MarginColumn.svelte";
import RailTabPicker from "./panels/RailTabPicker.svelte";
import { useAnnotationReview } from "./panels/useAnnotationReview.svelte";
import { pmSelectionToFlat } from "./positions";
import FormattingBar from "./shell/FormattingBar.svelte";
import TitleBar from "./shell/TitleBar.svelte";
import StatusBar from "./status/StatusBar.svelte";
import DocumentTabs from "./tabs/DocumentTabs.svelte";
import { API_BASE } from "./utils/fileUpload.js";
import { addRecentFile, loadRecentFiles, saveRecentFiles } from "./utils/recentFiles";

const yjsSync = createYjsSync();
onDestroy(() => yjsSync.destroy());

// In-memory closed-tab history for Ctrl+Alt+T (reopen closed tab). Lifetime is
// the app session; resets on reload. See useClosedTabStack.ts for rationale.
const closedTabStack = createClosedTabStack();
const inflightReopens = new Set<string>();

function closeTabAndRecord(tabId: string) {
  const tab = yjsSync.tabs.find((t) => t.id === tabId);
  if (tab && !isUploadPath(tab.filePath)) {
    closedTabStack.push({ filePath: tab.filePath, closedAt: Date.now() });
  }
  yjsSync.handleTabClose(tabId);
}

async function reopenClosedTab() {
  const rec = closedTabStack.pop();
  if (!rec) return;
  // Server may have rejected the original close (rare); also covers the
  // close→reopen→close→reopen rapid cycle for the same path. If the file is
  // still open, just activate it.
  const existing = yjsSync.tabs.find((t) => t.filePath === rec.filePath);
  if (existing) {
    yjsSync.setActiveTabId(existing.id);
    return;
  }
  if (inflightReopens.has(rec.filePath)) return;
  inflightReopens.add(rec.filePath);
  const handleFailure = (reason: string) => {
    // Restore the record so the user can retry with another Ctrl+Alt+T;
    // silent drop would also surprise users who expect LIFO to be retryable.
    closedTabStack.push(rec);
    const basename = rec.filePath.split(/[\\/]/).pop() || rec.filePath;
    notifications.push({
      id: `reopen-failed-${Date.now()}`,
      type: "general-error",
      severity: "error",
      message: `Couldn't reopen ${basename}: ${reason}`,
      dedupKey: `reopen-failed:${rec.filePath}`,
      timestamp: Date.now(),
    });
  };
  try {
    const response = await fetch(`${API_BASE}${API_OPEN}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ filePath: rec.filePath }),
    });
    if (!response.ok) {
      // fetch() only rejects on network errors — server-side 4xx/5xx never
      // throw. Without this branch, the record was silently dropped on a
      // failed reopen and the toast never fired.
      handleFailure(`server returned ${response.status}`);
    }
  } catch (err) {
    handleFailure(err instanceof Error ? err.message : "network error");
  } finally {
    inflightReopens.delete(rec.filePath);
  }
}

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
const connectionBanner = createConnectionBanner(
  () => yjsSync.disconnectedSince,
  () => settingsState.settings.degradedBannerDelayMs,
);
createWebViewZoom();

const openDocs = $derived(yjsSync.tabs.map((t) => ({ id: t.id, fileName: t.fileName })));

const notifications = createNotifications();
const fileDrop = createFileDrop();

let settingsOpen = $state(false);
let settingsModalOpen = $state(false);
let settingsBtnEl = $state<HTMLButtonElement | null>(null);
let paletteOpen = $state(false);
let fileOpenDialogOpen = $state(false);

function toggleSettings() {
  settingsOpen = !settingsOpen;
}

function cycleTheme() {
  settingsState.updateSettings({ theme: THEME_NEXT[settingsState.settings.theme] });
}

// Wire action dependencies for builtin actions (save, settings, find, mode)
// after the reactive state they depend on is available.
wireActionDeps({
  getActiveTabId: () => yjsSync.activeTabId,
  openSettings: () => (settingsOpen = true),
  openSettingsModal: () => (settingsModalOpen = true),
  toggleSoloMode: () =>
    modeState.setTandemMode(modeState.tandemMode === "solo" ? "tandem" : "solo"),
  openFindBar: () => {
    findBarForceScope = "doc";
    findBarOpen = true;
  },
  openFindBarTabs: () => {
    findBarForceScope = "tabs";
    findBarOpen = true;
  },
  findNext: () => {
    const ed = editor;
    const findState = ed ? getFindState(ed.state) : undefined;
    if (ed && shouldDispatchFindNav(findState)) {
      ed.commands.findNext();
    } else {
      findBarForceScope = "doc";
      findBarOpen = true;
    }
  },
  findPrev: () => {
    const ed = editor;
    const findState = ed ? getFindState(ed.state) : undefined;
    if (ed && shouldDispatchFindNav(findState)) {
      ed.commands.findPrev();
    } else {
      findBarForceScope = "doc";
      findBarOpen = true;
    }
  },
  closeActiveTab: () => {
    const id = yjsSync.activeTabId;
    if (id) closeTabAndRecord(id);
  },
  openFileDialog: () => {
    fileOpenDialogOpen = true;
  },
  toggleLeftPanel: () => toggleLeftPanel(),
  toggleRightPanel: () => toggleRightPanel(),
  reopenClosedTab: () => void reopenClosedTab(),
  annotationNext: () => {
    const sorted = sortAnnotationsByPosition(modeGate.visibleAnnotations);
    const nextId = nextAnnotationId(sorted, activeAnnotationId);
    if (nextId) {
      activeAnnotationId = nextId;
      const ann = sorted.find((a) => a.id === nextId);
      if (ann) review.scrollToAnnotation(ann);
    }
  },
  annotationPrev: () => {
    const sorted = sortAnnotationsByPosition(modeGate.visibleAnnotations);
    const prevId = prevAnnotationId(sorted, activeAnnotationId);
    if (prevId) {
      activeAnnotationId = prevId;
      const ann = sorted.find((a) => a.id === prevId);
      if (ann) review.scrollToAnnotation(ann);
    }
  },
  annotationAccept: () => {
    const cur = modeGate.visibleAnnotations.find((a) => a.id === activeAnnotationId);
    if (cur && cur.author !== "user") review.handleAccept(cur.id);
  },
  annotationDismiss: () => {
    const cur = modeGate.visibleAnnotations.find((a) => a.id === activeAnnotationId);
    if (cur && cur.author !== "user") review.handleDismiss(cur.id);
  },
  selectBlock: () => editor?.chain().focus().selectParentNode().run(),
  toggleAuthorship: () =>
    settingsState.updateSettings({
      showAuthorship: !settingsState.settings.showAuthorship,
    }),
});

// The authorship plugin reads its initial visibility from localStorage at
// construction time, so dispatch only on subsequent changes — first-run
// dispatch was the path that produced an effect-depth loop under prod
// scheduling (transaction → tick → effect rerun → dispatch …).
let lastDispatchedAuthorship: boolean | null = null;
$effect(() => {
  const ed = editor;
  if (!ed) return;
  const visible = settingsState.settings.showAuthorship;
  if (lastDispatchedAuthorship === visible) return;
  const firstRun = lastDispatchedAuthorship === null;
  lastDispatchedAuthorship = visible;
  if (firstRun) return;
  untrack(() => {
    const tr = ed.state.tr.setMeta(authorshipPluginKey, { type: "toggle", visible });
    ed.view.dispatch(tr);
  });
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

let activeRailTab = $state<"annotations" | "chat" | "outline">(
  settingsState.settings.primaryTab === "chat" ? "chat" : "annotations",
);
let activeLeftRailTab = $state<"annotations" | "chat" | "outline">(
  settingsState.settings.leftRailTabs[0] ?? "annotations",
);

// `untrack` so the write doesn't form a self-dep with the includes() read.
$effect(() => {
  const leftTabs = settingsState.settings.leftRailTabs;
  if (!leftTabs.includes(activeLeftRailTab)) {
    untrack(() => {
      activeLeftRailTab = leftTabs[0] ?? "annotations";
    });
  }
});
$effect(() => {
  const rightTabs = settingsState.settings.rightRailTabs;
  if (!rightTabs.includes(activeRailTab)) {
    untrack(() => {
      activeRailTab = rightTabs[0] ?? "chat";
    });
  }
});

const pendingAnnotationBadge = $derived(
  activeRailTab === "annotations"
    ? 0
    : modeGate.visibleAnnotations.filter(isPendingReviewTarget).length,
);

let activeAnnotationId = $state<string | null>(null);
let showHelp = $state(false);
let capturedAnchor = $state<CapturedAnchor | null>(null);
let editor = $state<TiptapEditor | null>(null);
let marginLayerEl = $state<HTMLDivElement | null>(null);
let slashCommandMenuOpen = $state(false);
let findBarOpen = $state(false);
let findBarForceScope = $state<"doc" | "tabs">("doc");
let outlineFocusTrigger = $state(0);
let commentFocusTrigger = $state(0);
let activeAnnotationFilter = $state<{
  type: FilterType;
  author: FilterAuthor;
  status: FilterStatus;
}>({
  type: "all",
  author: "all",
  status: "all",
});

const leftPanelWidth = loadPanelWidth("left");
const rightPanelWidth = loadPanelWidth("right");

const dragResizeLeft = createDragResize({
  side: "left",
  initialWidth: leftPanelWidth,
  getVisible: () => effectiveLeftVisible,
});

const dragResizeRight = createDragResize({
  side: "right",
  initialWidth: rightPanelWidth,
  getVisible: () => effectiveRightVisible,
});

// Left rail: no solo override (outline stays visible in solo mode).
// Right rail: suppressed in solo when soloRailHidden is set.
const effectiveLeftVisible = $derived(settingsState.settings.leftPanelVisible);
const effectiveRightVisible = $derived(
  settingsState.settings.rightPanelVisible &&
    !(modeState.tandemMode === "solo" && settingsState.settings.soloRailHidden),
);

function toggleLeftPanel() {
  settingsState.updateSettings({ leftPanelVisible: !settingsState.settings.leftPanelVisible });
}

function toggleRightPanel() {
  if (effectiveRightVisible) {
    settingsState.updateSettings({ rightPanelVisible: false });
  } else {
    // Also clear soloRailHidden so the panel actually shows in solo mode.
    settingsState.updateSettings({
      rightPanelVisible: true,
      ...(modeState.tandemMode === "solo" ? { soloRailHidden: false } : {}),
    });
  }
}

// Returns true if committed, false if blocked (would empty the other rail).
function moveTabsBetweenRails(
  side: "left" | "right",
  newTabsForSide: ("annotations" | "chat" | "outline")[],
): boolean {
  const leftTabs = settingsState.settings.leftRailTabs;
  const rightTabs = settingsState.settings.rightRailTabs;
  const currentSide = side === "left" ? leftTabs : rightTabs;
  const otherTabs = side === "left" ? rightTabs : leftTabs;
  const newlyAdded = newTabsForSide.filter((t) => !currentSide.includes(t));
  if (newlyAdded.length === 0) {
    settingsState.updateSettings(
      side === "left" ? { leftRailTabs: newTabsForSide } : { rightRailTabs: newTabsForSide },
    );
    return true;
  }
  const prunedOther = otherTabs.filter((t) => !newlyAdded.includes(t));
  if (prunedOther.length === 0) {
    console.warn(
      "[tandem] cross-rail tab move blocked — would leave the %s rail empty",
      side === "left" ? "right" : "left",
    );
    return false;
  }
  settingsState.updateSettings(
    side === "left"
      ? { leftRailTabs: newTabsForSide, rightRailTabs: prunedOther }
      : { rightRailTabs: newTabsForSide, leftRailTabs: prunedOther },
  );
  return true;
}

function handleFilterChange(
  type: (typeof activeAnnotationFilter)["type"],
  author: (typeof activeAnnotationFilter)["author"],
  status: (typeof activeAnnotationFilter)["status"],
) {
  activeAnnotationFilter = { type, author, status };
}

const editorMaxWidth = $derived(
  settingsState.settings.editorWidthPercent < 100
    ? `${settingsState.settings.editorWidthPercent}%`
    : undefined,
);
const editorMargin = $derived(
  settingsState.settings.editorWidthPercent < 100 ? "0 auto" : undefined,
);

function captureSelectionForChat() {
  if (activeRailTab === "chat") return;
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
      // Letter shortcuts use `e.code` ("KeyA" etc.) instead of `e.key` so they
      // remain layout-independent on Dvorak/AZERTY AND fire correctly on macOS
      // when Option is held (Option+letter produces alt characters like "†"/"µ"
      // that don't match e.key === "t" or "m"). Digit-1..9 already used e.code;
      // Backslash already used e.code; Enter is layout-stable and stays on
      // e.key. Shift/Alt modifier discrimination is explicit so intent is on
      // the page (e.g. Ctrl+M vs Ctrl+Shift+M).
      if (e.code === "KeyA" && !e.altKey && !e.shiftKey) {
        const active = document.activeElement;
        if (active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement) return;
        if (active?.closest?.(".ProseMirror")) return;
        e.preventDefault();
        editor?.commands.selectAll();
      } else if (e.code === "KeyS") {
        e.preventDefault();
        void triggerSave(yjsSync.activeTabId);
      } else if (isSettingsModalShortcut(e)) {
        // Wave 1: Ctrl+Shift+, opens the new SettingsModal sibling component
        // (see `components/SettingsModal.svelte`). Must be tested before
        // `isSettingsShortcut` even though that predicate also rejects shift —
        // shielding the order against future predicate edits.
        e.preventDefault();
        settingsModalOpen = true;
      } else if (isSettingsShortcut(e)) {
        e.preventDefault();
        settingsOpen = true;
      } else if (e.shiftKey && e.code === "KeyP") {
        e.preventDefault();
        paletteOpen = !untrack(() => paletteOpen);
      } else if (e.code === "KeyN") {
        const el = e.target as HTMLElement;
        if (el.tagName === "INPUT" || el.tagName === "TEXTAREA") return;
        e.preventDefault();
        void createScratchpad();
      } else if (e.key === "/") {
        const el = e.target as HTMLElement;
        if (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable) return;
        e.preventDefault();
        showHelp = untrack(() => !showHelp);
      } else if (e.code === "KeyW") {
        if (shouldIgnoreShortcut(e)) return;
        e.preventDefault();
        const id = yjsSync.activeTabId;
        if (id) closeTabAndRecord(id);
      } else if (e.code === "KeyO") {
        if (shouldIgnoreShortcut(e)) return;
        e.preventDefault();
        fileOpenDialogOpen = true;
      } else if (/^Digit[1-9]$/.test(e.code)) {
        if (shouldIgnoreShortcut(e)) return;
        const nextId = pickTabByDigit(yjsSync.tabs, Number(e.code.slice(5)));
        if (nextId) {
          e.preventDefault();
          yjsSync.setActiveTabId(nextId);
        }
      } else if (e.shiftKey && !e.altKey && e.code === "KeyM") {
        if (shouldIgnoreShortcut(e)) return;
        e.preventDefault();
        modeState.setTandemMode(modeState.tandemMode === "solo" ? "tandem" : "solo");
      } else if (e.code === "Backslash") {
        if (shouldIgnoreShortcut(e)) return;
        e.preventDefault();
        if (e.shiftKey) toggleRightPanel();
        else toggleLeftPanel();
      } else if (e.altKey && e.code === "KeyT") {
        if (shouldIgnoreShortcut(e)) return;
        e.preventDefault();
        void reopenClosedTab();
      }
    }
    // Ctrl/Cmd+F — focus outline search if outline panel visible; else open find bar (doc scope).
    // Ctrl/Cmd+Shift+F — open find bar pre-scoped to "Open tabs" (bypasses outline route).
    // Note: intentionally NOT gated on shouldIgnoreShortcut — Ctrl+F should always
    // claim find behavior to prevent the browser's native find-in-page from firing.
    if ((e.ctrlKey || e.metaKey) && e.code === "KeyF") {
      e.preventDefault();
      if (e.shiftKey) {
        findBarForceScope = "tabs";
        findBarOpen = true;
        return;
      }
      const isOutlineVisible =
        (effectiveLeftVisible && activeLeftRailTab === "outline") ||
        (effectiveRightVisible && activeRailTab === "outline");
      if (isOutlineVisible) {
        outlineFocusTrigger += 1;
      } else {
        findBarForceScope = "doc";
        findBarOpen = true;
      }
    }
    // Ctrl/Cmd+G — find next; Ctrl/Cmd+Shift+G — find previous.
    // With no active query, fall back to opening the find bar.
    if ((e.ctrlKey || e.metaKey) && e.code === "KeyG") {
      if (shouldIgnoreShortcut(e)) return;
      e.preventDefault();
      const ed = editor;
      const findState = ed ? getFindState(ed.state) : undefined;
      if (ed && shouldDispatchFindNav(findState)) {
        if (e.shiftKey) ed.commands.findPrev();
        else ed.commands.findNext();
      } else {
        findBarForceScope = "doc";
        findBarOpen = true;
      }
    }
    // Alt+] / Alt+[ — next / previous annotation. Plain Alt (no ctrl/meta/shift)
    // so they work cross-platform without an fn-key on Mac (unlike F8).
    if (e.altKey && !e.ctrlKey && !e.metaKey && !e.shiftKey) {
      if (e.code === "BracketRight") {
        if (shouldIgnoreShortcut(e)) return;
        e.preventDefault();
        const sorted = sortAnnotationsByPosition(modeGate.visibleAnnotations);
        const nextId = nextAnnotationId(sorted, activeAnnotationId);
        if (nextId) {
          activeAnnotationId = nextId;
          const ann = sorted.find((a) => a.id === nextId);
          if (ann) review.scrollToAnnotation(ann);
        }
        return;
      }
      if (e.code === "BracketLeft") {
        if (shouldIgnoreShortcut(e)) return;
        e.preventDefault();
        const sorted = sortAnnotationsByPosition(modeGate.visibleAnnotations);
        const prevId = prevAnnotationId(sorted, activeAnnotationId);
        if (prevId) {
          activeAnnotationId = prevId;
          const ann = sorted.find((a) => a.id === prevId);
          if (ann) review.scrollToAnnotation(ann);
        }
        return;
      }
    }
    // Ctrl/Cmd+Enter — accept focused annotation; Ctrl/Cmd+Shift+Enter — dismiss.
    // Only Claude- or import-authored annotations can be accepted/dismissed
    // (mirrors the SidePanel.svelte:440 prop gate). User-authored notes never
    // become review-targets so the underlying handler is also gated.
    if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
      if (shouldIgnoreShortcut(e)) return;
      e.preventDefault();
      const cur = modeGate.visibleAnnotations.find((a) => a.id === activeAnnotationId);
      if (cur && cur.author !== "user") {
        if (e.shiftKey) review.handleDismiss(cur.id);
        else review.handleAccept(cur.id);
      }
      return;
    }
    // Ctrl/Cmd+Alt+M — open the comment popup focused on its textarea, using
    // whatever text is currently selected in the editor. Intentionally NOT
    // gated on shouldIgnoreShortcut: contenteditable focus is the common case
    // (user has selected text in the editor) and we want this to fire there.
    //
    // Three orthogonal preconditions gate the popup; branch feedback so a
    // disabled-setting toast doesn't misfire when the real cause is "no
    // selection" or "read-only doc". Suppression from palette/find is silent
    // — the user is already in a different UI context.
    if ((e.ctrlKey || e.metaKey) && e.altKey && e.code === "KeyM") {
      e.preventDefault();
      const hasSelection = !!editor && editor.state.selection.from !== editor.state.selection.to;
      const reviewOnly = activeTab?.readOnly === true;
      const popupSuppressed = slashCommandMenuOpen || findBarOpen || paletteOpen;
      if (popupSuppressed) {
        // Palette/find UI is the active context; user understands why.
        return;
      }
      if (!hasSelection) {
        notifications.push({
          id: `comment-shortcut-no-selection-${Date.now()}`,
          type: "general-error",
          severity: "info",
          message: "Select text to comment",
          dedupKey: "comment-shortcut-no-selection",
          timestamp: Date.now(),
        });
        return;
      }
      if (reviewOnly) {
        notifications.push({
          id: `comment-shortcut-readonly-${Date.now()}`,
          type: "general-error",
          severity: "info",
          message: "Document is read-only",
          dedupKey: "comment-shortcut-readonly",
          timestamp: Date.now(),
        });
        return;
      }
      if (!settingsState.settings.selectionToolbar) {
        notifications.push({
          id: `comment-shortcut-toolbar-off-${Date.now()}`,
          type: "general-error",
          severity: "info",
          message: "Enable selection toolbar in Settings to comment via keyboard",
          dedupKey: "comment-shortcut-toolbar-off",
          timestamp: Date.now(),
        });
        return;
      }
      commentFocusTrigger += 1;
      return;
    }
    // Alt+L — select the containing block (paragraph / heading / list item).
    // Chosen over Ctrl+L to avoid the browser address-bar conflict in dev mode.
    if (e.altKey && !e.ctrlKey && !e.metaKey && !e.shiftKey && e.code === "KeyL") {
      if (shouldIgnoreShortcut(e)) return;
      e.preventDefault();
      if (editor) editor.chain().focus().selectParentNode().run();
      return;
    }
    // Ctrl/Cmd+Alt+A — toggle authorship colors. Works even when focus is in
    // a form input (it's a global UI preference, not a contextual action).
    if ((e.ctrlKey || e.metaKey) && e.altKey && e.code === "KeyA") {
      e.preventDefault();
      settingsState.updateSettings({
        showAuthorship: !settingsState.settings.showAuthorship,
      });
      return;
    }
  }
  window.addEventListener("keydown", handler);
  return () => window.removeEventListener("keydown", handler);
});

const activeTab = $derived(yjsSync.tabs.find((t) => t.id === yjsSync.activeTabId));

// Lifted from SidePanel.svelte so that:
//   1. There's exactly one review instance (both rails would otherwise mount
//      their own, doubling accept/dismiss writes — which would also double
//      `applySuggestion`'s text insertion before the idempotency guard fix).
//   2. App-level keyboard shortcuts (Ctrl+Enter accept, etc.) can dispatch
//      directly without an upward callback.
// SidePanel now receives `review` as a prop.
const review = useAnnotationReview({
  getYdoc: () => activeTab?.ydoc ?? null,
  getEditor: () => editor,
  getAnnotations: () => modeGate.visibleAnnotations,
  onActiveAnnotationChange: (id) => {
    activeAnnotationId = id;
  },
  getScrollBehavior: () => (settingsState.settings.reduceMotion ? "auto" : "smooth"),
  // Lets the hook's auto-set effect avoid clobbering externally-set ids
  // (e.g., from Alt+]/Alt+[ keyboard navigation).
  getActiveAnnotationId: () => activeAnnotationId,
});

// #649: Word-style margin annotation view.
// PR 1 ships minimum viable — bubbles appear at correct Y, naive scroll sync
// via DOM nesting in the positioning layer. Collision resolution lands in
// PR 2; rail-collapse and narrow-layout auto-disable in PR 3.
const marginNotes = $derived(
  settingsState.settings.marginView
    ? modeGate.visibleAnnotations.filter((a) => a.type === "note")
    : [],
);
const marginComments = $derived(
  settingsState.settings.marginView
    ? modeGate.visibleAnnotations.filter((a) => a.author === "import" || a.type === "comment")
    : [],
);
const marginPositions = createMarginPositions({
  getEditor: () => editor,
  getYdoc: () => activeTab?.ydoc ?? null,
  getAnnotations: () => [...marginNotes, ...marginComments],
  getLayerEl: () => marginLayerEl,
  getEnabled: () => settingsState.settings.marginView,
});

const tutorial = createTutorial(
  () => modeGate.visibleAnnotations,
  () => editor,
  () => activeTab?.fileName,
);
</script>

<div style="display: flex; flex-direction: column; height: 100vh; background: var(--tandem-bg); color: var(--tandem-fg);">
  <TitleBar
    tandemMode={modeState.tandemMode}
    onModeChange={modeState.setTandemMode}
    claudeActive={yjsSync.claudeActive}
    leftPanelVisible={effectiveLeftVisible}
    onToggleLeftPanel={toggleLeftPanel}
    rightPanelVisible={effectiveRightVisible}
    onToggleRightPanel={toggleRightPanel}
    theme={settingsState.settings.theme}
    onCycleTheme={cycleTheme}
    showAuthorship={settingsState.settings.showAuthorship}
    onAuthorshipChange={(visible) => settingsState.updateSettings({ showAuthorship: visible })}
    onOpenHelp={() => (showHelp = true)}
    onOpenSettings={toggleSettings}
    onOpenSettingsModal={() => (settingsModalOpen = true)}
    bind:settingsBtn={settingsBtnEl}
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
      selectionToolbar={settingsState.settings.selectionToolbar}
      suppressSelectionToolbar={slashCommandMenuOpen || findBarOpen || paletteOpen}
      requestCommentFocus={commentFocusTrigger}
    />

    <DocumentTabs
      tabs={tabOrder.orderedTabs}
      activeTabId={yjsSync.activeTabId}
      onTabSwitch={yjsSync.setActiveTabId}
      onTabClose={closeTabAndRecord}
      reorder={tabOrder.reorder}
      reduceMotion={settingsState.settings.reduceMotion}
      onRequestOpenDialog={() => { fileOpenDialogOpen = true; }}
    />

    <FormattingBar
      {editor}
      ydoc={activeTab?.ydoc ?? null}
    />

    <!-- Single persistent container — editor column is always rendered in the same
         DOM position so the Editor component never remounts on panel toggles.
         Left and right rails are independently shown/hidden around the stable editor column. -->
    <div style="display: flex; flex: 1; overflow: hidden; background: var(--tandem-bg);">
      {#if effectiveLeftVisible}
        {@const leftTabs = settingsState.settings.leftRailTabs}
        {@const iconOnlyLeft = leftTabs.length > 3}
        {@const disabledLeftTabs = settingsState.settings.rightRailTabs.length === 1 ? settingsState.settings.rightRailTabs : []}
        <div
          style={`display: flex; flex-direction: column; width: ${dragResizeLeft.width}px; border-right: 1px solid var(--tandem-border); background: var(--tandem-surface-muted);`}
        >
          <div
            style="display: flex; border-bottom: 1px solid var(--tandem-border); background: var(--tandem-surface-muted); min-height: 38px; align-items: stretch; padding: 0 var(--tandem-space-2); gap: 2px;"
          >
            {#if leftTabs.includes("annotations")}
              <button
                data-testid="left-annotations-tab"
                onclick={() => { activeLeftRailTab = "annotations"; }}
                style={`flex: 1; padding: 0 var(--tandem-space-2); font-size: 12px; font-weight: 500; border: none; border-bottom: ${activeLeftRailTab === "annotations" ? "2px solid var(--tandem-accent)" : "2px solid transparent"}; background: transparent; cursor: pointer; color: ${activeLeftRailTab === "annotations" ? "var(--tandem-fg)" : "var(--tandem-fg-subtle)"}; white-space: nowrap;`}
                title={iconOnlyLeft ? "Annotations" : undefined}
              >{iconOnlyLeft ? "◨" : "Annotations"}</button>
            {/if}
            {#if leftTabs.includes("chat")}
              <button
                data-testid="left-chat-tab"
                onclick={() => { activeLeftRailTab = "chat"; }}
                style={`flex: 1; padding: 0 var(--tandem-space-2); font-size: 12px; font-weight: 500; border: none; border-bottom: ${activeLeftRailTab === "chat" ? "2px solid var(--tandem-accent)" : "2px solid transparent"}; background: transparent; cursor: pointer; color: ${activeLeftRailTab === "chat" ? "var(--tandem-fg)" : "var(--tandem-fg-subtle)"}; white-space: nowrap;`}
                title={iconOnlyLeft ? "Chat" : undefined}
              >{iconOnlyLeft ? "💬" : "Chat"}</button>
            {/if}
            {#if leftTabs.includes("outline")}
              <button
                data-testid="left-outline-tab"
                onclick={() => { activeLeftRailTab = "outline"; }}
                style={`flex: 1; padding: 0 var(--tandem-space-2); font-size: 12px; font-weight: 500; border: none; border-bottom: ${activeLeftRailTab === "outline" ? "2px solid var(--tandem-accent)" : "2px solid transparent"}; background: transparent; cursor: pointer; color: ${activeLeftRailTab === "outline" ? "var(--tandem-fg)" : "var(--tandem-fg-subtle)"}; white-space: nowrap;`}
                title={iconOnlyLeft ? "Outline" : undefined}
              >{iconOnlyLeft ? "≡" : "Outline"}</button>
            {/if}
            <div style="display: flex; align-items: center; margin-left: auto; padding-right: var(--tandem-space-1);">
              <RailTabPicker
                enabledTabs={leftTabs}
                disabledTabs={disabledLeftTabs}
                testIdPrefix="left-"
                onTabsChange={(tabs) => { moveTabsBetweenRails("left", tabs); }}
              />
            </div>
          </div>
          <div style="display: flex; flex-direction: column; flex: 1; min-height: 0;">
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
              visible={activeLeftRailTab === "chat" && leftTabs.includes("chat")}
            />
            <PanelSlot
              kind="side"
              annotations={modeGate.visibleAnnotations}
              activeFilterType={activeAnnotationFilter.type}
              activeFilterAuthor={activeAnnotationFilter.author}
              activeFilterStatus={activeAnnotationFilter.status}
              onFilterChange={handleFilterChange}
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
              storeReadOnly={yjsSync.storeReadOnly}
              {review}
              visible={activeLeftRailTab === "annotations" && leftTabs.includes("annotations")}
            />
            <PanelSlot
              kind="outline"
              focusTrigger={outlineFocusTrigger}
              {editor}
              visible={activeLeftRailTab === "outline" && leftTabs.includes("outline")}
            />
          </div>
        </div>
        {@render resizeHandle("left", (e) => dragResizeLeft.handleResizeStart(e), undefined, dragResizeLeft.width)}
      {/if}

      {@render editorColumn()}

      {#if effectiveRightVisible}
        {@render resizeHandle("right", (e) => dragResizeRight.handleResizeStart(e), "panel-resize-handle", dragResizeRight.width)}
        {@render tabbedPanel(dragResizeRight.width, "right")}
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
      connected={yjsSync.connected}
      reconnectAttempts={yjsSync.reconnectAttempts}
    />

    <SettingsModal
      open={settingsModalOpen}
      onClose={() => (settingsModalOpen = false)}
      settings={settingsState.settings}
      onUpdate={settingsState.updateSettings}
      returnFocusEl={settingsBtnEl}
      triggerEl={settingsBtnEl}
      connected={yjsSync.connected}
      reconnectAttempts={yjsSync.reconnectAttempts}
    />

    <HelpModal open={showHelp} onClose={() => (showHelp = false)} />

    {#if fileOpenDialogOpen}
      <FileOpenDialog onClose={() => (fileOpenDialogOpen = false)} />
    {/if}

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
      else if (e.key === "Home") delta = PANEL_MIN_WIDTH - (side === "left" ? dragResizeLeft.width : dragResizeRight.width);
      else if (e.key === "End") delta = PANEL_MAX_WIDTH - (side === "left" ? dragResizeLeft.width : dragResizeRight.width);
      if (delta !== null) {
        e.preventDefault();
        e.stopPropagation();
        if (side === "left") dragResizeLeft.handleResizeStep(delta);
        else dragResizeRight.handleResizeStep(delta);
      }
    }}
    onkeyup={() => {
      // Width is already persisted inside handleResizeStep on each keyboard step.
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
        currentFilePath={activeTab!.filePath}
        {activeAnnotationId}
        onEditorReady={(ed) => (editor = ed)}
        onAnnotationClick={(id) => {
          activeRailTab = "annotations";
                    activeAnnotationId = id;
        }}
        onSlashCommandMenuChange={(open) => (slashCommandMenuOpen = open)}
      />
    {/snippet}
    <!-- Positioning layer for margin annotation bubbles (#649). The layer
         wraps editor content so its block height matches the editor's, and
         scroll sync between text and bubbles is free (both live inside the
         same scrolling block).

         INVARIANT 1 — no re-bind: this <div> must remain mounted across
         marginView toggles. `marginLayerEl` is a $state ref read inside
         useMarginPositions's $effect, which subscribes; re-binding via
         {#if}/{#key} would cause listener teardown/rebuild storms (the
         feedback_svelte_state_bind_this_loop pattern). Use `display:
         contents` when off — wrapper is layout-invisible, so default-off
         users get the master-branch layout with no new containing block,
         and the bind stays stable.

         INVARIANT 2 — getEnabled() short-circuit ordering: recompute()
         reads layer.getBoundingClientRect() ONLY after the getEnabled()
         early-return. `display: contents` elements return a zero-size
         rect, so bypassing that guard would silently produce
         layerTop=0 and page-relative bubble offsets. Don't move the
         guard. -->
    <div
      bind:this={marginLayerEl}
      style={settingsState.settings.marginView ? "position: relative;" : "display: contents;"}
    >
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
      {#if settingsState.settings.marginView && activeTab}
        <MarginColumn
          side="left"
          annotations={marginNotes}
          positions={marginPositions.byId}
          width={240}
          edgeInset={8}
          {activeAnnotationId}
          repliesById={new Map()}
          onClick={(ann) => {
            activeAnnotationId = ann.id;
            review.scrollToAnnotation(ann);
          }}
        />
        <MarginColumn
          side="right"
          annotations={marginComments}
          positions={marginPositions.byId}
          width={240}
          edgeInset={8}
          {activeAnnotationId}
          repliesById={new Map()}
          onClick={(ann) => {
            activeAnnotationId = ann.id;
            review.scrollToAnnotation(ann);
          }}
          onAccept={review.handleAccept}
          onDismiss={review.handleDismiss}
        />
      {/if}
    </div>
    <!-- Find/Replace bar — always mounted so query persists; overlaid at bottom of editor column -->
    <FindReplaceBar
      {editor}
      open={findBarOpen}
      onClose={() => (findBarOpen = false)}
      tabs={yjsSync.tabs}
      forceScope={findBarForceScope}
    />
  </div>
{/snippet}

{#snippet tabbedPanel(width: number, borderSide: "left" | "right")}
  {@const enabledTabs = settingsState.settings.rightRailTabs}
  {@const iconOnly = enabledTabs.length > 3}
  <div
    style={`display: flex; flex-direction: column; width: ${width}px; ${borderSide === "left" ? "border-right" : "border-left"}: 1px solid var(--tandem-border); background: var(--tandem-surface-muted);`}
  >
    <div
      style="display: flex; border-bottom: 1px solid var(--tandem-border); background: var(--tandem-surface-muted); min-height: 38px; align-items: stretch; padding: 0 var(--tandem-space-2); gap: 2px;"
    >
      {#if enabledTabs.includes("annotations")}
        <button
          data-testid="annotations-tab"
          onclick={() => { activeRailTab = "annotations"; }}
          style={`flex: 1; padding: 0 var(--tandem-space-2); font-size: 12px; font-weight: 500; border: none; border-bottom: ${activeRailTab === "annotations" ? "2px solid var(--tandem-accent)" : "2px solid transparent"}; background: transparent; cursor: pointer; color: ${activeRailTab === "annotations" ? "var(--tandem-fg)" : "var(--tandem-fg-subtle)"}; position: relative; white-space: nowrap;`}
          title={iconOnly ? "Annotations" : undefined}
        >
          {#if iconOnly}◨{:else}Annotations{/if}
          {#if activeRailTab !== "annotations" && pendingAnnotationBadge > 0}
            <span
              style="position: absolute; top: 2px; right: 2px; background: var(--tandem-error); color: var(--tandem-error-fg); font-size: 9px; width: 16px; height: 16px; border-radius: 50%; display: flex; align-items: center; justify-content: center; font-weight: 700;"
            >
              {pendingAnnotationBadge > 9 ? "9+" : pendingAnnotationBadge}
            </span>
          {/if}
        </button>
      {/if}
      {#if enabledTabs.includes("chat")}
        <button
          data-testid="chat-tab"
          onmousedown={captureSelectionForChat}
          onclick={() => { activeRailTab = "chat";  }}
          style={`flex: 1; padding: 0 var(--tandem-space-2); font-size: 12px; font-weight: 500; border: none; border-bottom: ${activeRailTab === "chat" ? "2px solid var(--tandem-accent)" : "2px solid transparent"}; background: transparent; cursor: pointer; color: ${activeRailTab === "chat" ? "var(--tandem-fg)" : "var(--tandem-fg-subtle)"}; white-space: nowrap;`}
          title={iconOnly ? "Chat" : undefined}
        >
          {#if iconOnly}💬{:else}Chat{/if}
        </button>
      {/if}
      {#if enabledTabs.includes("outline")}
        <button
          data-testid="outline-tab"
          onclick={() => { activeRailTab = "outline"; }}
          style={`flex: 1; padding: 0 var(--tandem-space-2); font-size: 12px; font-weight: 500; border: none; border-bottom: ${activeRailTab === "outline" ? "2px solid var(--tandem-accent)" : "2px solid transparent"}; background: transparent; cursor: pointer; color: ${activeRailTab === "outline" ? "var(--tandem-fg)" : "var(--tandem-fg-subtle)"}; white-space: nowrap;`}
          title={iconOnly ? "Outline" : undefined}
        >
          {#if iconOnly}≡{:else}Outline{/if}
        </button>
      {/if}
      <div style="display: flex; align-items: center; margin-left: auto; padding-right: var(--tandem-space-1);">
        <RailTabPicker
          enabledTabs={settingsState.settings.rightRailTabs}
          disabledTabs={settingsState.settings.leftRailTabs.length === 1 ? settingsState.settings.leftRailTabs : []}
          onTabsChange={(tabs) => { moveTabsBetweenRails("right", tabs); }}
        />
      </div>
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
      visible={activeRailTab === "chat" && enabledTabs.includes("chat")}
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
      storeReadOnly={yjsSync.storeReadOnly}
      {review}
      onFilterChange={(type, author, status) => {
        activeAnnotationFilter = { type, author, status };
      }}
      visible={activeRailTab === "annotations" && enabledTabs.includes("annotations")}
    />
    {#if enabledTabs.includes("outline")}
      <PanelSlot
        kind="outline"
        {editor}
        annotations={modeGate.visibleAnnotations}
        focusTrigger={outlineFocusTrigger}
        activeFilterType={activeAnnotationFilter.type}
        visible={activeRailTab === "outline"}
      />
    {/if}
  </div>
{/snippet}
