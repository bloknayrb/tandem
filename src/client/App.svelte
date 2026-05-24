<script lang="ts">
import type { Editor as TiptapEditor } from "@tiptap/core";
import { onDestroy, untrack } from "svelte";
import { cubicOut } from "svelte/easing";
import { isUploadPath } from "../shared/paths";
import { toPmPos } from "../shared/positions/types";
import type { CapturedAnchor } from "../shared/types";
import { isPendingReviewTarget } from "../shared/types";
import { generateNotificationId } from "../shared/utils";
import {
  createScratchpad,
  saveStore,
  triggerSave,
  triggerSaveAs,
  wireActionDeps,
} from "./actions/builtin.svelte.js";
import { scrollFade } from "./actions/scrollFade.svelte.js";
import CommandPalette from "./components/CommandPalette.svelte";
import ConnectionBanner from "./components/ConnectionBanner.svelte";
import CoworkAdminDeclinedModal from "./components/CoworkAdminDeclinedModal.svelte";
import EmptyState from "./components/EmptyState.svelte";
import FileOpenDialog from "./components/FileOpenDialog.svelte";
import FirstRunModelPickerModal from "./components/FirstRunModelPickerModal.svelte";
import HelpModal from "./components/HelpModal.svelte";
import IntegrationWizardModal from "./components/IntegrationWizardModal.svelte";
import OnboardingTutorial from "./components/OnboardingTutorial.svelte";
import PanelSlot from "./components/PanelSlot.svelte";
import ReviewOnlyBanner from "./components/ReviewOnlyBanner.svelte";
import SettingsModal, { SETTINGS_TAB_IDS } from "./components/SettingsModal.svelte";
import SettingsPopover from "./components/SettingsPopover.svelte";
import ToastContainer from "./components/ToastContainer.svelte";
import UpdaterBanner from "./components/UpdaterBanner.svelte";
import { isTauriRuntime } from "./cowork/cowork-helpers";
import Editor from "./editor/Editor.svelte";
import { annotationPluginKey } from "./editor/extensions/annotation";
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
import { createAnnotationReplies } from "./hooks/useAnnotationReplies.svelte";
import { matchShortcut, type ShortcutContext, type ShortcutId } from "./hooks/useAppShortcuts.js";
import { createClosedTabStack } from "./hooks/useClosedTabStack.js";
import { createConnectionBanner } from "./hooks/useConnectionBanner.svelte";
import { createDensity } from "./hooks/useDensity.svelte";
import { createDragResize } from "./hooks/useDragResize.svelte";
import { createRootEditorFont } from "./hooks/useEditorFont.svelte";
import { createFileDrop } from "./hooks/useFileDrop.svelte";
import { shouldDispatchFindNav } from "./hooks/useFindShortcuts.js";
import { createFirstRunNeeded } from "./hooks/useFirstRunNeeded.svelte";
import { createHighContrast } from "./hooks/useHighContrast.svelte";
import { createMarginPositions } from "./hooks/useMarginPositions.svelte";
import { createNotifications } from "./hooks/useNotifications.svelte";
import { createTabCycleKeyboard } from "./hooks/useTabCycleKeyboard.svelte";
import { pickTabByDigit, shouldIgnoreShortcut } from "./hooks/useTabKeyboardShortcuts.js";
import { createTabOrder } from "./hooks/useTabOrder.svelte";
import { createTandemModeBroadcast } from "./hooks/useTandemModeBroadcast.svelte";
import { createTandemSettings, TEXT_SIZE_PX } from "./hooks/useTandemSettings.svelte";
import { initTauriFileDrop, tauriFileDrop } from "./hooks/useTauriFileDrop.svelte";
import { createTheme } from "./hooks/useTheme.svelte";
import { createTutorial } from "./hooks/useTutorial.svelte";
import { createUpdateAvailable } from "./hooks/useUpdateAvailable.svelte";
import { createUpdaterBanner } from "./hooks/useUpdaterBanner.svelte";
import { createViewportWidth } from "./hooks/useViewportWidth.svelte";
import { createWebViewZoom } from "./hooks/useWebViewZoom.svelte";
import { createYjsSync } from "./hooks/yjsSync.svelte";
import { createLayoutModel } from "./layout/model.svelte";
import { loadPanelWidth, PANEL_MAX_WIDTH, PANEL_MIN_WIDTH } from "./panel-layout";
import {
  editAnnotation as marginEditAnnotation,
  removeAnnotation as marginRemoveAnnotation,
  replyToAnnotation as marginReplyToAnnotation,
  sendNoteToClaude as marginSendNoteToClaude,
} from "./panels/annotation-actions";
import MarginColumn from "./panels/MarginColumn.svelte";
import PeekStrip from "./panels/PeekStrip.svelte";
import { useAnnotationReview } from "./panels/useAnnotationReview.svelte";
import { pmSelectionToFlat } from "./positions";
import FormattingBar from "./shell/FormattingBar.svelte";
import TitleBar from "./shell/TitleBar.svelte";
import StatusBar from "./status/StatusBar.svelte";
import DocumentTabs from "./tabs/DocumentTabs.svelte";
import { addRecentFile, loadRecentFiles, saveRecentFiles } from "./utils/recentFiles";
import { openServerPath } from "./utils/server-paths";

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
    const result = await openServerPath(rec.filePath);
    if (!result.ok) handleFailure(result.error);
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
const layoutModel = createLayoutModel(settingsState, modeState);
const visibleAnnotations = $derived(yjsSync.annotations);
const connectionBanner = createConnectionBanner(
  () => yjsSync.disconnectedSince,
  () => settingsState.settings.degradedBannerDelayMs,
);
const updaterBanner = createUpdaterBanner();
createWebViewZoom();

const openDocs = $derived(yjsSync.tabs.map((t) => ({ id: t.id, fileName: t.fileName })));

const notifications = createNotifications();
const fileDrop = createFileDrop();
initTauriFileDrop(notifications.push);

// Surface sidecar restart failures (Tauri-only) as a generic toast. The
// Rust side emits "sidecar-restart-failed" with a stable code; the message
// is hard-coded here so no path, errno text, env var, or auth token from
// the underlying failure can ever reach the DOM. See #631.
if (isTauriRuntime()) {
  let unlisten: (() => void) | null = null;
  let cancelled = false;
  import("@tauri-apps/api/event")
    .then(({ listen }) =>
      listen("sidecar-restart-failed", () => {
        notifications.push({
          id: `sidecar-restart-failed-${Date.now()}`,
          type: "general-error",
          severity: "error",
          message: "Sidecar failed to restart — see logs",
          dedupKey: "sidecar-restart-failed",
          timestamp: Date.now(),
          errorCode: "SIDECAR_RESTART_FAILED",
        });
      }),
    )
    .then((un) => {
      if (cancelled) un();
      else unlisten = un;
    })
    .catch((err) => {
      console.warn("[App] Failed to wire sidecar-restart-failed listener:", err);
    });
  onDestroy(() => {
    cancelled = true;
    unlisten?.();
  });
}

let settingsOpen = $state(false);
let settingsModalOpen = $state(false);

const firstRun = createFirstRunNeeded();
const WIZARD_DISMISSED_KEY = "tandem:wizard-dismissed";
let dismissedForVersion = $state<string | null>(readDismissed());
let manuallyReopened = $state(false);

function readDismissed(): string | null {
  try {
    return localStorage.getItem(WIZARD_DISMISSED_KEY);
  } catch {
    return null;
  }
}

// Server says first-run is needed AND the user hasn't dismissed this
// server version yet. `&&` (not `||`) so a stomped/absent localStorage
// value still triggers when the server says it's needed.
const isAutoOpenFirstRun = $derived(
  firstRun.needed === true &&
    firstRun.serverVersion !== null &&
    dismissedForVersion !== firstRun.serverVersion,
);
const shouldShowWizard = $derived(manuallyReopened || isAutoOpenFirstRun);

// The first-run model picker is the leading step of the auto-open flow.
// Manual reopen is excluded — that path re-runs the MCP-client wizard
// only; Settings → Models is the post-first-run surface.
let modelPickerHandled = $state(false);
const shouldShowModelPicker = $derived(
  isAutoOpenFirstRun && settingsState.settings.models.length === 0 && !modelPickerHandled,
);

function closeIntegrationWizard(): void {
  // Only persist dismissal when this close ends an auto-open session.
  // A manual reopen → close where the server says `needed === false`
  // would otherwise burn the dismissal slot for `serverVersion`.
  if (isAutoOpenFirstRun && firstRun.serverVersion !== null) {
    try {
      localStorage.setItem(WIZARD_DISMISSED_KEY, firstRun.serverVersion);
      dismissedForVersion = firstRun.serverVersion;
    } catch {
      // localStorage unavailable — the server-side check re-prompts on next launch.
    }
  }
  manuallyReopened = false;
  modelPickerHandled = false;
}

// Sync dismissal state across tabs: if one tab dismisses (writes to
// localStorage), other open tabs see the `storage` event and update
// their reactive view. The event only fires in OTHER tabs — the writing
// tab updates `dismissedForVersion` synchronously above.
$effect(() => {
  const onStorage = (ev: StorageEvent) => {
    if (ev.key === WIZARD_DISMISSED_KEY) {
      dismissedForVersion = ev.newValue;
    }
  };
  window.addEventListener("storage", onStorage);
  return () => window.removeEventListener("storage", onStorage);
});

// SettingsClaudeCodeTab dispatches this when the user clicks "Reopen wizard".
// Listening here avoids threading another callback through every Settings tab.
$effect(() => {
  const onOpen = () => {
    manuallyReopened = true;
    settingsModalOpen = false;
    // Re-fetch first-run state so a reopen reflects any concurrent
    // persist from another tab / CLI.
    void firstRun.refetch();
  };
  window.addEventListener("tandem:open-integration-wizard", onOpen);
  return () => window.removeEventListener("tandem:open-integration-wizard", onOpen);
});
let settingsBtnEl = $state<HTMLButtonElement | null>(null);

// Dev-only test hook for E2E specs that need to open the SettingsModal
// without going through the keyboard shortcut. The `Ctrl+Shift+,` path is
// covered by other tests but is unreliable to drive from Playwright because
// Tiptap's default keymap binds `Mod-Shift-,` to subscript and consumes the
// event before App.svelte's window-level handler sees it. Exposed only in
// dev/test builds — stripped by `import.meta.env.DEV` in production.
if (import.meta.env.DEV) {
  (window as unknown as { __tandemTest?: { openSettingsModal: () => void } }).__tandemTest = {
    openSettingsModal: () => {
      settingsModalOpen = true;
    },
  };
}
let paletteOpen = $state(false);
let fileOpenDialogOpen = $state(false);

// Issue #660 — titlebar settings-icon update-available dot. Acknowledged
// whenever the user opens settings (popover OR modal — any tab counts). Do
// NOT destructure: the `showDot` getter loses reactivity when pulled out.
const updateAvailable = createUpdateAvailable();

function toggleSettings() {
  // Acknowledge on the false→true transition only (closing settings via the
  // gear shouldn't re-clear an already-acknowledged dot, but acknowledge() is
  // idempotent so this is defence-in-depth).
  if (!settingsOpen) updateAvailable.acknowledge();
  settingsOpen = !settingsOpen;
}

function openSettingsModalWithAck() {
  updateAvailable.acknowledge();
  settingsModalOpen = true;
}

const defaultModelLabel = $derived.by(() => {
  const id = settingsState.settings.defaultModelId;
  if (id === null) return null;
  const entry = settingsState.settings.models.find((m) => m.id === id);
  return entry ? entry.displayName : null;
});

// `initialTabId` is applied only on the closed → open transition, so a
// mid-open chip click leaves the user's current tab alone.
let nextSettingsTabId = $state<string | null>(null);

function openModelsSettings() {
  if (!settingsModalOpen) nextSettingsTabId = SETTINGS_TAB_IDS.models;
  openSettingsModalWithAck();
}

function openSettingsPopoverWithAck() {
  updateAvailable.acknowledge();
  settingsOpen = true;
}

// Wire action dependencies for builtin actions (save, settings, find, mode)
// after the reactive state they depend on is available.
wireActionDeps({
  getActiveTabId: () => yjsSync.activeTabId,
  getActiveDocumentPath: () => {
    const tab = yjsSync.tabs.find((t) => t.id === yjsSync.activeTabId);
    return tab && !isUploadPath(tab.filePath) ? tab.filePath : null;
  },
  notify: (severity, message) => {
    notifications.push({
      id: `launcher-${Date.now()}`,
      type: "launcher",
      severity,
      message,
      timestamp: Date.now(),
    });
  },
  openSettings: openSettingsPopoverWithAck,
  openSettingsModal: openSettingsModalWithAck,
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
    const sorted = sortAnnotationsByPosition(visibleAnnotations);
    const nextId = nextAnnotationId(sorted, activeAnnotationId);
    if (nextId) {
      activeAnnotationId = nextId;
      const ann = sorted.find((a) => a.id === nextId);
      if (ann) review.scrollToAnnotation(ann);
    }
  },
  annotationPrev: () => {
    const sorted = sortAnnotationsByPosition(visibleAnnotations);
    const prevId = prevAnnotationId(sorted, activeAnnotationId);
    if (prevId) {
      activeAnnotationId = prevId;
      const ann = sorted.find((a) => a.id === prevId);
      if (ann) review.scrollToAnnotation(ann);
    }
  },
  annotationAccept: () => {
    const cur = visibleAnnotations.find((a) => a.id === activeAnnotationId);
    if (cur && cur.author !== "user") review.handleAccept(cur.id);
  },
  annotationDismiss: () => {
    const cur = visibleAnnotations.find((a) => a.id === activeAnnotationId);
    if (cur && cur.author !== "user") review.handleDismiss(cur.id);
  },
  selectBlock: () => editor?.chain().focus().selectParentNode().run(),
  toggleAuthorship: () =>
    settingsState.updateSettings({
      showAuthorship: !settingsState.settings.showAuthorship,
    }),
  saveAs: async () => {
    const tab = yjsSync.tabs.find((t) => t.id === yjsSync.activeTabId);
    // Save-As is a PROMOTION path — only offer it for ephemeral upload://
    // (scratchpad) docs. A doc already on disk would be silently corrupted by
    // a promote (orphaned annotations, deleted session). The server enforces
    // this too (NOT_PROMOTABLE); guard the affordance here so the user gets a
    // clear toast instead of a server error. See #827 review (Medium).
    if (!tab || !isUploadPath(tab.filePath)) {
      notifications.push({
        id: generateNotificationId(),
        type: "launcher",
        severity: "info",
        message: "Save As is only available for scratchpads; this document is already on disk.",
        timestamp: Date.now(),
      });
      return;
    }
    // Default-name hint for the native dialog: prefer the existing basename.
    // For a synthetic upload:// path that's already "Scratchpad.md".
    const lastSlash = Math.max(tab.filePath.lastIndexOf("/"), tab.filePath.lastIndexOf("\\"));
    const defaultName = tab.filePath.slice(lastSlash + 1);
    await triggerSaveAs({
      activeDocId: yjsSync.activeTabId,
      defaultName,
      sourceFormat: tab.format,
      notify: (severity, message) =>
        notifications.push({
          id: generateNotificationId(),
          type: "launcher",
          severity,
          message,
          timestamp: Date.now(),
        }),
    });
  },
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

// #596: mirrors the authorship toggle pattern; plugin reads localStorage at init, this handles flips.
let lastDispatchedDecorations: boolean | null = null;
$effect(() => {
  const ed = editor;
  if (!ed) return;
  const visible = settingsState.settings.showAnnotationDecorations;
  if (lastDispatchedDecorations === visible) return;
  const firstRun = lastDispatchedDecorations === null;
  lastDispatchedDecorations = visible;
  if (firstRun) return;
  untrack(() => {
    const tr = ed.state.tr.setMeta(annotationPluginKey, {
      type: "toggle-decorations",
      visible,
    });
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

// Right rail tabs are hard-coded to Annotations + Chat. The initial
// selection still respects the user's `primaryTab` preference.
let activeRailTab = $state<"annotations" | "chat">(
  settingsState.settings.primaryTab === "chat" ? "chat" : "annotations",
);

const pendingAnnotationBadge = $derived(
  activeRailTab === "annotations" ? 0 : visibleAnnotations.filter(isPendingReviewTarget).length,
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

// Panel visibility + tab-move semantics are encapsulated by `layoutModel`
// (ADR-037). The model owns the orphan-rail rule, the solo-mode override
// for the right rail, and the `soloRailHidden`-clearing side-effect when
// toggling the right panel back on in solo mode.
const effectiveLeftVisible = $derived(layoutModel.leftVisible);
const effectiveRightVisible = $derived(layoutModel.rightVisible);
// After a keyboard-driven toggle the activated element unmounts (collapse
// zone → peek strip and vice versa). Without explicit focus restoration the
// browser drops focus to <body> and the user loses their tab position.
// queueMicrotask defers until after Svelte mounts the replacement element.
function focusToggleTarget(side: "left" | "right", nextVisible: boolean) {
  queueMicrotask(() => {
    const id = nextVisible ? `panel-edge-collapse-${side}` : `peek-strip-${side}`;
    const el = document.querySelector<HTMLElement>(`[data-testid="${id}"]`);
    if (el) {
      el.focus();
    } else {
      console.warn(`[tandem] focusToggleTarget: ${id} not mounted; focus dropped to body`);
    }
  });
}
const toggleLeftPanel = () => {
  const nextVisible = !layoutModel.leftVisible;
  layoutModel.toggleLeft();
  focusToggleTarget("left", nextVisible);
};
const toggleRightPanel = () => {
  const nextVisible = !layoutModel.rightVisible;
  layoutModel.toggleRight();
  focusToggleTarget("right", nextVisible);
};

/**
 * Slide transition for the rail containers. Translates the rail off the
 * window edge so showing/hiding the rail reads as a slide rather than a
 * snap. Reduced-motion users get a zero-duration no-op (collapses to a
 * snap, the existing behavior).
 *
 * Known limitation: while the rail's outro is running, its DOM is still
 * mounted alongside the PeekStrip (Svelte default). The editor column
 * briefly reflows around both. Margin-annotation positions catch up via
 * the existing ResizeObserver-driven layout effect; brief lag during the
 * ~220ms transition is acceptable.
 */
function railSlide(_node: HTMLElement, params: { side: "left" | "right"; reduceMotion: boolean }) {
  if (params.reduceMotion) return { duration: 0, css: () => "" };
  const dir = params.side === "left" ? -1 : 1;
  return {
    duration: 220,
    easing: cubicOut,
    css: (t: number) => `transform: translateX(${(1 - t) * 100 * dir}%);`,
  };
}

// Margin annotation view reserves a column + edge inset + breathing-room gap
// per side. Subtract from available width so the editor text never sits
// underneath (or flush against) the absolutely-positioned MarginColumn cards.
// `MARGIN_VIEW_GAP_PX` is the space between the editor's text edge and the
// near edge of the margin column — it also defines the horizontal zone where
// leader lines from anchor text to bubbles are drawn (see MarginColumn).
const MARGIN_VIEW_COLUMN_WIDTH_PX = 240;
const MARGIN_VIEW_EDGE_INSET_PX = 8;
const MARGIN_VIEW_GAP_PX = 24;
const MARGIN_VIEW_RESERVE_PX =
  2 * (MARGIN_VIEW_COLUMN_WIDTH_PX + MARGIN_VIEW_EDGE_INSET_PX + MARGIN_VIEW_GAP_PX);

// Below this readable editor width, margin columns auto-hide rather than
// squeeze the editor into an unreadable strip. Pairs with a 32px hysteresis
// band (`MARGIN_VIEW_HYSTERESIS_PX`) so a viewport drag through the threshold
// doesn't flicker columns on/off at 60fps.
const MIN_EDITOR_WIDTH_PX = 480;
const MARGIN_VIEW_HYSTERESIS_PX = 32;

const viewport = createViewportWidth();

// Per-side rail-replaces-margin behavior (#683): when a rail is open, hide the
// margin column on that side. Reasoning: rail + margin on the same side leaves
// the editor crushed and visually competes for the same gutter. Hiding by side
// preserves margin annotations on the un-collapsed side and matches the user
// mental model that "rail replaces margin." Both columns hide together when
// `narrowSticky === true`.
//
// The threshold reads the persisted-at-mount rail widths (not the live
// `dragResizeLeft/Right.width`) so it stays stable while a user is mid-drag.
// Without this, the boundary slides under the drag and margin columns flip
// on/off as the cursor moves — the 32px hysteresis below only absorbs
// viewport-axis jitter, not threshold drift.
const railsWidthPx = $derived(
  (effectiveLeftVisible ? leftPanelWidth : 0) + (effectiveRightVisible ? rightPanelWidth : 0),
);
const marginNarrowThresholdPx = $derived(
  MARGIN_VIEW_RESERVE_PX + railsWidthPx + MIN_EDITOR_WIDTH_PX,
);

// Hysteresis-debounced narrow flag. A plain `width < threshold` boundary
// flickers when a user drags through it because each side of the threshold
// re-evaluates on every frame. Sticky entry at `< threshold`, sticky exit at
// `> threshold + HYSTERESIS` gives a 32px deadband.
let narrowSticky = $state(false);
$effect(() => {
  const w = viewport.width;
  const t = marginNarrowThresholdPx;
  if (w < t) narrowSticky = true;
  else if (w > t + MARGIN_VIEW_HYSTERESIS_PX) narrowSticky = false;
});

const marginViewEffectivelyOn = $derived(settingsState.settings.marginView && !narrowSticky);
const marginLeftVisible = $derived(marginViewEffectivelyOn && !effectiveLeftVisible);
const marginRightVisible = $derived(marginViewEffectivelyOn && !effectiveRightVisible);

const editorMaxWidth = $derived.by(() => {
  const pct = settingsState.settings.editorWidthPercent;
  const reserve = marginViewEffectivelyOn ? MARGIN_VIEW_RESERVE_PX : 0;
  // `max(0px, ...)` guards against `editorWidthPercent` settings that, on
  // narrow viewports with marginView on, would compute a negative max-width.
  // CSS clamps negative max-width to 0 anyway, but the explicit wrap keeps
  // the resulting style declaration legible in devtools.
  return reserve > 0 ? `max(0px, calc(${pct}% - ${reserve}px))` : `${pct}%`;
});

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

/**
 * App-level keydown handler. The pure shortcut-matching logic lives in
 * `matchShortcut` (see `hooks/useAppShortcuts.ts`) so it's testable in
 * isolation against Dvorak / macOS Option-letter / IME edge cases. This
 * dispatch table holds the side-effecting branches (editor commands,
 * modal state, findState, notification toasts) so the helper stays pure.
 *
 * Each handler is responsible for its own `preventDefault()` policy —
 * some shortcuts intentionally let the event through when focus is in a
 * form field (e.g. Ctrl+W / Ctrl+O via `shouldIgnoreShortcut`), and some
 * always claim the event (e.g. Ctrl+F to suppress the browser's native
 * find-in-page) regardless of input focus.
 */
type ShortcutHandler = (e: KeyboardEvent, ctx: ShortcutContext | undefined) => void;
const dispatch: Partial<Record<ShortcutId, ShortcutHandler>> = {
  "toggle-help": (e) => {
    // INPUT/TEXTAREA/contenteditable guard: "?" and Ctrl+/ both fall through
    // in form fields so the keystroke remains usable as input.
    const el = e.target as HTMLElement | null;
    if (el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable)) {
      return;
    }
    e.preventDefault();
    showHelp = untrack(() => !showHelp);
  },
  "select-all": (e) => {
    // Skip when focus is in a real form field or anywhere inside ProseMirror —
    // the editor's own select-all should win in both cases.
    const active = document.activeElement;
    if (active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement) return;
    if (active?.closest?.(".ProseMirror")) return;
    e.preventDefault();
    editor?.commands.selectAll();
  },
  save: (e) => {
    e.preventDefault();
    void triggerSave(yjsSync.activeTabId);
  },
  "save-as": (e) => {
    // Don't hijack Ctrl+Shift+S while typing in a chat / annotation input.
    const el = e.target as HTMLElement | null;
    if (el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable)) {
      return;
    }
    e.preventDefault();
    const tab = yjsSync.tabs.find((t) => t.id === yjsSync.activeTabId);
    // Save-As is a PROMOTION path — only for ephemeral upload:// (scratchpad)
    // docs; mirrors the palette `saveAs` gate + server NOT_PROMOTABLE. See #827.
    if (!tab || !isUploadPath(tab.filePath)) {
      notifications.push({
        id: generateNotificationId(),
        type: "launcher",
        severity: "info",
        message: "Save As is only available for scratchpads; this document is already on disk.",
        timestamp: Date.now(),
      });
      return;
    }
    const lastSlash = Math.max(tab.filePath.lastIndexOf("/"), tab.filePath.lastIndexOf("\\"));
    const defaultName = tab.filePath.slice(lastSlash + 1);
    void triggerSaveAs({
      activeDocId: yjsSync.activeTabId,
      defaultName,
      sourceFormat: tab.format,
      notify: (severity, message) =>
        notifications.push({
          id: generateNotificationId(),
          type: "launcher",
          severity,
          message,
          timestamp: Date.now(),
        }),
    });
  },
  "settings-modal": (e) => {
    e.preventDefault();
    openSettingsModalWithAck();
  },
  settings: (e) => {
    e.preventDefault();
    openSettingsPopoverWithAck();
  },
  "toggle-palette": (e) => {
    e.preventDefault();
    paletteOpen = !untrack(() => paletteOpen);
  },
  "new-scratchpad": (e) => {
    // Slightly looser than `shouldIgnoreShortcut`: only the tagName check, no
    // isComposing fallthrough — preserves the legacy behavior.
    const el = e.target as HTMLElement | null;
    if (el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA")) return;
    e.preventDefault();
    void createScratchpad();
  },
  "close-tab": (e) => {
    if (shouldIgnoreShortcut(e)) return;
    e.preventDefault();
    const id = yjsSync.activeTabId;
    if (id) closeTabAndRecord(id);
  },
  "open-file": (e) => {
    if (shouldIgnoreShortcut(e)) return;
    e.preventDefault();
    fileOpenDialogOpen = true;
  },
  "pick-tab": (e, ctx) => {
    if (shouldIgnoreShortcut(e)) return;
    const digit = ctx?.tabIndex;
    if (digit === undefined) return;
    const nextId = pickTabByDigit(yjsSync.tabs, digit);
    if (nextId) {
      e.preventDefault();
      yjsSync.setActiveTabId(nextId);
    }
  },
  "toggle-mode": (e) => {
    if (shouldIgnoreShortcut(e)) return;
    e.preventDefault();
    modeState.setTandemMode(modeState.tandemMode === "solo" ? "tandem" : "solo");
  },
  "reopen-closed-tab": (e) => {
    if (shouldIgnoreShortcut(e)) return;
    e.preventDefault();
    void reopenClosedTab();
  },
  find: (e, ctx) => {
    // Intentionally NOT gated on shouldIgnoreShortcut — Ctrl+F should always
    // claim find behavior to prevent the browser's native find-in-page from firing.
    e.preventDefault();
    if (ctx?.shift) {
      findBarForceScope = "tabs";
      findBarOpen = true;
      return;
    }
    if (effectiveLeftVisible) {
      outlineFocusTrigger += 1;
    } else {
      findBarForceScope = "doc";
      findBarOpen = true;
    }
  },
  "find-nav": (e, ctx) => {
    if (shouldIgnoreShortcut(e)) return;
    e.preventDefault();
    const ed = editor;
    const findState = ed ? getFindState(ed.state) : undefined;
    if (ed && shouldDispatchFindNav(findState)) {
      if (ctx?.shift) ed.commands.findPrev();
      else ed.commands.findNext();
    } else {
      findBarForceScope = "doc";
      findBarOpen = true;
    }
  },
  "annotation-accept-or-dismiss": (e, ctx) => {
    if (shouldIgnoreShortcut(e)) return;
    e.preventDefault();
    const cur = visibleAnnotations.find((a) => a.id === activeAnnotationId);
    if (cur && cur.author !== "user") {
      if (ctx?.shift) review.handleDismiss(cur.id);
      else review.handleAccept(cur.id);
    }
  },
  "comment-on-selection": (e) => {
    // Intentionally NOT gated on shouldIgnoreShortcut: contenteditable focus
    // is the common case (user has selected text in the editor).
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
  },
  "toggle-authorship": (e) => {
    // Works even when focus is in a form input (global UI preference).
    e.preventDefault();
    settingsState.updateSettings({
      showAuthorship: !settingsState.settings.showAuthorship,
    });
  },
  "toggle-left-panel": (e) => {
    if (shouldIgnoreShortcut(e)) return;
    e.preventDefault();
    toggleLeftPanel();
  },
  "toggle-right-panel": (e) => {
    if (shouldIgnoreShortcut(e)) return;
    e.preventDefault();
    toggleRightPanel();
  },
  "annotation-next": (e) => {
    if (shouldIgnoreShortcut(e)) return;
    e.preventDefault();
    const sorted = sortAnnotationsByPosition(visibleAnnotations);
    const nextId = nextAnnotationId(sorted, activeAnnotationId);
    if (nextId) {
      activeAnnotationId = nextId;
      const ann = sorted.find((a) => a.id === nextId);
      if (ann) review.scrollToAnnotation(ann);
    }
  },
  "annotation-prev": (e) => {
    if (shouldIgnoreShortcut(e)) return;
    e.preventDefault();
    const sorted = sortAnnotationsByPosition(visibleAnnotations);
    const prevId = prevAnnotationId(sorted, activeAnnotationId);
    if (prevId) {
      activeAnnotationId = prevId;
      const ann = sorted.find((a) => a.id === prevId);
      if (ann) review.scrollToAnnotation(ann);
    }
  },
  "select-block": (e) => {
    if (shouldIgnoreShortcut(e)) return;
    e.preventDefault();
    if (editor) editor.chain().focus().selectParentNode().run();
  },
};

$effect(() => {
  function handler(e: KeyboardEvent) {
    const match = matchShortcut(e);
    if (!match) return;
    dispatch[match.id]?.(e, match.context);
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
  getAnnotations: () => visibleAnnotations,
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
  marginViewEffectivelyOn ? visibleAnnotations.filter((a) => a.type === "note") : [],
);
const marginComments = $derived(
  marginViewEffectivelyOn
    ? visibleAnnotations.filter((a) => a.author === "import" || a.type === "comment")
    : [],
);
const marginPositions = createMarginPositions({
  getEditor: () => editor,
  getYdoc: () => activeTab?.ydoc ?? null,
  getAnnotations: () => [...marginNotes, ...marginComments],
  getLayerEl: () => marginLayerEl,
  getEnabled: () => marginViewEffectivelyOn,
});
// Replies feed the bubble reply count + thread preview. We observe the raw
// Y.Map here; MarginColumn applies the `getVisibleReplies()` ADR-027 filter
// at the lookup site so note / highlight bubbles never expose replies.
const marginReplies = createAnnotationReplies({
  getYdoc: () => activeTab?.ydoc ?? null,
});

// All six handlers + ydoc/docId in one $derived so closures capture the same
// activeTab snapshot. Per-property access at call sites preserves reactivity
// (destructuring would freeze the values at template-instantiation time).
const marginHandlers = $derived.by(() => {
  const ydoc = activeTab?.ydoc ?? null;
  const docId = activeTab?.id;
  return {
    ydoc,
    docId,
    onEdit: (id: string, c: string) => marginEditAnnotation(ydoc, id, c),
    onReply: (id: string, t: string) => marginReplyToAnnotation(id, t, docId),
    onRemove: (id: string) => marginRemoveAnnotation(id, docId),
    onSendToClaude: (id: string) => marginSendNoteToClaude(ydoc, id),
  };
});

const tutorial = createTutorial(
  () => visibleAnnotations,
  () => editor,
  () => activeTab?.fileName,
);
</script>

<div
  data-tandem-mode={modeState.tandemMode}
  style="display: flex; flex-direction: column; height: 100vh; background: var(--tandem-bg); color: var(--tandem-fg);"
>
  <TitleBar
    tandemMode={modeState.tandemMode}
    onModeChange={modeState.setTandemMode}
    claudeActive={yjsSync.claudeActive}
    theme={settingsState.settings.theme}
    onSetTheme={(t) => settingsState.updateSettings({ theme: t })}
    showAuthorship={settingsState.settings.showAuthorship}
    onAuthorshipChange={(visible) => settingsState.updateSettings({ showAuthorship: visible })}
    onOpenHelp={() => (showHelp = true)}
    onOpenSettings={toggleSettings}
    onOpenSettingsModal={openSettingsModalWithAck}
    updateAvailable={updateAvailable.showDot}
    defaultModelLabel={defaultModelLabel}
    onOpenModelsSettings={openModelsSettings}
    bind:settingsBtn={settingsBtnEl}
    center={titleBarTabs}
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

    {#if isTauriRuntime() && updaterBanner.showBanner && updaterBanner.availableVersion}
      <UpdaterBanner
        version={updaterBanner.availableVersion}
        installing={updaterBanner.installing}
        onInstall={() => { updaterBanner.install(); }}
        onDismiss={updaterBanner.dismiss}
      />
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

    <FormattingBar
      {editor}
      ydoc={activeTab?.ydoc ?? null}
    />

    <!-- Single persistent container — editor column is always rendered in the same
         DOM position so the Editor component never remounts on panel toggles.
         Left and right rails are independently shown/hidden around the stable editor column.
         `onscroll` resets scrollLeft to 0: `overflow: hidden` makes this a scroll
         container, and when the right rail mounts with `transform: translateX(100%)`,
         focus lands on the (now-offscreen) edge-collapse button and the browser
         auto-scrolls the container by 300px to bring it into view, causing the
         whole row to "pop" -300px and slide back over the transition window.
         Pinning scrollLeft to 0 cancels that without affecting layout.

         DO NOT change `overflow: hidden` to `overflow: clip` without restoring
         the focus-pop fix some other way. `clip` suppresses `scroll` events
         entirely, so the onscroll handler below would never fire and the
         focus-driven auto-scroll into the off-stage rail would resurface. -->
    <div
      style="position: relative; display: flex; flex: 1; overflow: hidden; background: var(--tandem-bg);"
      onscroll={(e) => {
        // TODO: if a future child needs horizontal scroll (overflowing table,
        // inline overflow toolbar), scope this reset to the railSlide transition
        // window (~250ms) or move it to a focus listener. Today the row has no
        // horizontally-scrollable children, so the unconditional reset is safe.
        e.currentTarget.scrollLeft = 0;
      }}
    >
      {#if effectiveLeftVisible}
        <!-- Left rail is locked to the outline; the outline rail has no tab
             bar. Outermost 8px is the edge-click collapse zone. -->
        <div
          data-testid="left-outline-rail"
          transition:railSlide={{ side: "left", reduceMotion: settingsState.settings.reduceMotion }}
          style={`position: relative; display: flex; flex-direction: column; width: ${dragResizeLeft.width}px; background: var(--tandem-surface-muted); border-radius: 0 var(--tandem-rail-inner-radius, 14px) var(--tandem-rail-inner-radius, 14px) 0; margin-top: var(--tandem-rail-top-clearance, 0); margin-bottom: var(--tandem-status-clearance-total, 60px); overflow: hidden; box-shadow: var(--tandem-rail-shadow-left);`}
        >
          <PanelSlot
            kind="outline"
            focusTrigger={outlineFocusTrigger}
            {editor}
            visible={true}
          />
          {@render edgeCollapse("left", toggleLeftPanel)}
        </div>
        {@render resizeHandle("left", (e) => dragResizeLeft.handleResizeStart(e), undefined, dragResizeLeft.width)}
      {:else}
        <PeekStrip side="left" onActivate={toggleLeftPanel} />
      {/if}

      {@render editorColumn()}

      {#if effectiveRightVisible}
        {@render resizeHandle("right", (e) => dragResizeRight.handleResizeStart(e), "panel-resize-handle", dragResizeRight.width)}
        <!-- Right rail: single node owns width + transition + styling, matching
             the left rail's shape above so the two slide-in animations stay symmetric. -->
        <div
          transition:railSlide={{ side: "right", reduceMotion: settingsState.settings.reduceMotion }}
          style={`position: relative; z-index: 1; display: flex; flex-direction: column; width: ${dragResizeRight.width}px; background: var(--tandem-surface-muted); border-radius: var(--tandem-rail-inner-radius, 14px) 0 0 var(--tandem-rail-inner-radius, 14px); margin-top: var(--tandem-rail-top-clearance, 0); margin-bottom: var(--tandem-status-clearance-total, 60px); overflow: hidden; box-shadow: var(--tandem-rail-shadow-right);`}
        >
          {@render edgeCollapse("right", toggleRightPanel)}
          <div class="rail-tabs-row">
            <div class="rail-tabs-track">
              <button
                data-testid="annotations-tab"
                class={"rail-tab" + (activeRailTab === "annotations" ? " on" : "")}
                onclick={() => { activeRailTab = "annotations"; }}
              >
                Annotations
                {#if activeRailTab !== "annotations" && pendingAnnotationBadge > 0}
                  <span class="rail-tab-badge">
                    {pendingAnnotationBadge > 9 ? "9+" : pendingAnnotationBadge}
                  </span>
                {/if}
              </button>
              <button
                data-testid="chat-tab"
                class={"rail-tab" + (activeRailTab === "chat" ? " on" : "")}
                onmousedown={captureSelectionForChat}
                onclick={() => { activeRailTab = "chat"; }}
              >
                Chat
              </button>
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
            visible={activeRailTab === "chat"}
          />
          <PanelSlot
            kind="side"
            annotations={visibleAnnotations}
            {editor}
            ydoc={activeTab?.ydoc ?? null}
            activeDocFormat={activeTab?.format}
            documentId={activeTab?.id}
            {activeAnnotationId}
            onActiveAnnotationChange={(id) => (activeAnnotationId = id)}
            reduceMotion={settingsState.settings.reduceMotion}
            storeReadOnly={yjsSync.storeReadOnly}
            claudeWorkingAnnotationId={yjsSync.claudeWorking?.annotationId ?? null}
            {review}
            visible={activeRailTab === "annotations"}
          />
        </div>
      {:else}
        <PeekStrip side="right" onActivate={toggleRightPanel} />
      {/if}
    </div>

    <StatusBar
      connected={yjsSync.connected}
      connectionStatus={yjsSync.connectionStatus}
      reconnectAttempts={yjsSync.reconnectAttempts}
      disconnectedSince={yjsSync.disconnectedSince}
      claudeStatus={yjsSync.claudeStatus}
      claudeActive={yjsSync.claudeActive}
      claudeWorkingTool={yjsSync.claudeWorking?.tool ?? null}
      readOnly={yjsSync.readOnly}
      saving={saveStore.saving}
      {editor}
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
      onClose={() => {
        settingsModalOpen = false;
        // Reset so a subsequent open without an explicit target lands on the
        // default tab instead of replaying the last-requested initial.
        nextSettingsTabId = null;
      }}
      settings={settingsState.settings}
      onUpdate={settingsState.updateSettings}
      returnFocusEl={settingsBtnEl}
      triggerEl={settingsBtnEl}
      connected={yjsSync.connected}
      reconnectAttempts={yjsSync.reconnectAttempts}
      initialTabId={nextSettingsTabId}
      notify={(severity, message) =>
        notifications.push({
          id: `settings-${Date.now()}`,
          type: "launcher",
          severity,
          message,
          timestamp: Date.now(),
        })}
    />

    <HelpModal open={showHelp} onClose={() => (showHelp = false)} />

    {#if shouldShowModelPicker}
      <FirstRunModelPickerModal onComplete={() => (modelPickerHandled = true)} />
    {:else if shouldShowWizard}
      <IntegrationWizardModal open={true} onClose={closeIntegrationWizard} />
    {/if}

    {#if fileOpenDialogOpen}
      <FileOpenDialog onClose={() => (fileOpenDialogOpen = false)} />
    {/if}

    <CommandPalette
      open={paletteOpen}
      onClose={() => (paletteOpen = false)}
      {editor}
      annotations={visibleAnnotations}
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

{#snippet titleBarTabs()}
  <DocumentTabs
    tabs={tabOrder.orderedTabs}
    activeTabId={yjsSync.activeTabId}
    onTabSwitch={yjsSync.setActiveTabId}
    onTabClose={closeTabAndRecord}
    reorder={tabOrder.reorder}
    reduceMotion={settingsState.settings.reduceMotion}
    onRequestOpenDialog={() => { fileOpenDialogOpen = true; }}
  />
{/snippet}

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

<!-- Edge-click collapse zone: full-height 8px strip at the outer edge of the
     rail. The right rail insets the top by 40px to clear the rail-tabs-row
     tab buttons (~36px tall); the left rail has no tab bar and runs edge-
     to-edge. The right rail's scrollbar shares the outer edge — a known
     minor conflict; the strip stays 8px so a Windows scrollbar (~17px)
     remains grabbable from the inside half. Sibling of panel content (not
     a parent) so descendant clicks never bubble in. -->
{#snippet edgeCollapse(side: "left" | "right", onToggle: () => void)}
  <!-- Not in the Tab sequence: keyboard users have Alt+Shift+Arrow for
       the same action, and tab-reachable edge zones would push other
       focusable elements past the tab-traversal budget. -->
  <!-- svelte-ignore a11y_click_events_have_key_events -->
  <div
    class={`panel-edge-collapse panel-edge-collapse-${side}`}
    data-testid={`panel-edge-collapse-${side}`}
    role="button"
    tabindex="-1"
    aria-label={side === "left" ? "Hide left panel" : "Hide right panel"}
    onclick={onToggle}
  ></div>
{/snippet}

{#snippet editorColumn()}
  <div
    class="editor-scroll tandem-scroll-fade-y"
    use:scrollFade={"y"}
    role="region"
    aria-label="Document editor"
    style={`position: relative; flex: 1; overflow: auto; padding: max(var(--tandem-space-7), 52px) var(--tandem-space-5) var(--tandem-space-7) var(--tandem-space-5); border: ${fileDrop.fileDragOver || tauriFileDrop.fileDragOver ? "2px dashed var(--tandem-accent)" : "2px solid transparent"}; background: ${fileDrop.fileDragOver || tauriFileDrop.fileDragOver ? "var(--tandem-accent-bg)" : "var(--tandem-bg)"}; transition: border-color 0.15s, background 0.15s; border-radius: ${fileDrop.fileDragOver || tauriFileDrop.fileDragOver ? "var(--tandem-r-5)" : "0"};`}
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
        format={activeTab!.format}
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
      style={marginViewEffectivelyOn ? "position: relative;" : "display: contents;"}
    >
      <!-- Editor renders paged white-sheet layout for .docx via the `.tandem-paged`
           class (driven by the `format` prop / `isPaged` $derived inside Editor.svelte).
           For .docx we skip the max-width wrapper so the gray canvas can paint full-width;
           the inner white sheet is centered by editor.css. -->
      {#if activeTab?.format === "docx"}
        {#key activeTab.id}
          {@render editorContent()}
        {/key}
      {:else}
        <div style={`max-width: ${editorMaxWidth}; margin: 0 auto;`}>
          {#if activeTab}
            {#key activeTab.id}
              {@render editorContent()}
            {/key}
          {:else}
            <EmptyState connected={yjsSync.connected} claudeActive={yjsSync.claudeActive} />
          {/if}
        </div>
      {/if}
      {#if marginLeftVisible && activeTab}
        <MarginColumn
          side="left"
          annotations={marginNotes}
          positions={marginPositions.byId}
          width={MARGIN_VIEW_COLUMN_WIDTH_PX}
          edgeInset={MARGIN_VIEW_EDGE_INSET_PX}
          gap={MARGIN_VIEW_GAP_PX}
          {activeAnnotationId}
          repliesById={marginReplies.byId}
          onClick={(ann) => {
            activeAnnotationId = ann.id;
            review.scrollToAnnotation(ann);
          }}
          onAccept={review.handleAccept}
          onDismiss={review.handleDismiss}
          onRemove={marginHandlers.onRemove}
          onEdit={marginHandlers.onEdit}
          onReply={marginHandlers.onReply}
          onSendToClaude={marginHandlers.onSendToClaude}
        />
      {/if}
      {#if marginRightVisible && activeTab}
        <MarginColumn
          side="right"
          annotations={marginComments}
          positions={marginPositions.byId}
          width={MARGIN_VIEW_COLUMN_WIDTH_PX}
          edgeInset={MARGIN_VIEW_EDGE_INSET_PX}
          gap={MARGIN_VIEW_GAP_PX}
          {activeAnnotationId}
          repliesById={marginReplies.byId}
          onClick={(ann) => {
            activeAnnotationId = ann.id;
            review.scrollToAnnotation(ann);
          }}
          onAccept={review.handleAccept}
          onDismiss={review.handleDismiss}
          onRemove={marginHandlers.onRemove}
          onEdit={marginHandlers.onEdit}
          onReply={marginHandlers.onReply}
          onSendToClaude={marginHandlers.onSendToClaude}
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

<style>
  .rail-tabs-row {
    display: flex;
    align-items: center;
    gap: var(--tandem-space-2);
    margin: 12px 12px 10px;
    flex-shrink: 0;
  }
  .rail-tabs-track {
    display: flex;
    flex: 1;
    gap: 3px;
    padding: 4px;
    background: var(--tandem-surface-sunk);
    border-radius: var(--tandem-r-pill);
    font-size: 11.5px;
  }
  .rail-tab {
    flex: 1;
    text-align: center;
    padding: 5px 8px;
    border: none;
    border-radius: var(--tandem-r-pill);
    background: transparent;
    color: var(--tandem-fg-subtle);
    font: inherit;
    font-weight: 500;
    cursor: pointer;
    position: relative;
    white-space: nowrap;
    transition: background 140ms ease, color 140ms ease;
  }
  .rail-tab:hover:not(.on) {
    color: var(--tandem-fg);
  }
  .rail-tab.on {
    background: var(--tandem-surface);
    color: var(--tandem-fg);
    box-shadow: 0 1px 2px rgba(0, 0, 0, 0.05);
  }
  .rail-tab-badge {
    position: absolute;
    top: 2px;
    right: 2px;
    background: var(--tandem-error);
    color: var(--tandem-error-fg);
    font-size: 9px;
    width: 16px;
    height: 16px;
    border-radius: 50%;
    display: flex;
    align-items: center;
    justify-content: center;
    font-weight: 700;
  }

  /* Edge-click collapse zone. Full-height 8px strip on the rail's outer
     edge. Left rail goes edge-to-edge; right rail starts below the
     rail-tabs-row (40px) to clear the rail-tabs-row tab buttons (right
     rail only). Sibling to panel content so descendant clicks don't
     bubble in. */
  .panel-edge-collapse {
    position: absolute;
    width: 8px;
    top: 0;
    bottom: 0;
    cursor: pointer;
    z-index: 1;
    background: transparent;
    transition: background 140ms ease;
  }
  .panel-edge-collapse-left {
    left: 0;
  }
  .panel-edge-collapse-right {
    right: 0;
    top: 40px;
  }
  .panel-edge-collapse:hover {
    background: var(--tandem-accent-bg);
  }
  .panel-edge-collapse:focus-visible {
    background: var(--tandem-accent-bg);
    outline: 2px solid var(--tandem-accent);
    outline-offset: -2px;
  }
</style>
