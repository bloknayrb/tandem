<script lang="ts">
import type { Editor as TiptapEditor } from "@tiptap/core";
import { onDestroy, untrack } from "svelte";
import { isScratchpadPath, isUploadPath, scratchpadUuidFromPath } from "../shared/paths";
import { toPmPos } from "../shared/positions/types";
import type { Annotation, CapturedAnchor, TandemNotification } from "../shared/types";
import { isPendingReviewTarget } from "../shared/types";
import { generateNotificationId } from "../shared/utils";
import {
  createScratchpad,
  SCRATCHPAD_EMPTY_STATE_DEBOUNCE_MS,
  saveStore,
  shouldAutoOpenScratchpad,
  triggerSave,
  triggerSaveAs,
  wireActionDeps,
} from "./actions/builtin.svelte.js";
import { effectiveBindingLabels } from "./actions/keybindings.js";
import { scrollFade } from "./actions/scrollFade.svelte.js";
import { buildOverrides } from "./actions/shortcut-conflicts.js";
import ActivityTray from "./components/ActivityTray.svelte";
import { resolveActivityAction } from "./components/activityActions.js";
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
import { createClosedTabStack } from "./hooks/useClosedTabStack.svelte";
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
import { createScratchpadPersistence } from "./hooks/useScratchpadPersistence.svelte";
import { createTabCycleKeyboard } from "./hooks/useTabCycleKeyboard.svelte";
import { pickTabByDigit, shouldIgnoreShortcut } from "./hooks/useTabKeyboardShortcuts.js";
import { createTabOrder } from "./hooks/useTabOrder.svelte";
import { createTandemModeBroadcast } from "./hooks/useTandemModeBroadcast.svelte";
import { createTandemSettings, resolveFont, TEXT_SIZE_PX } from "./hooks/useTandemSettings.svelte";
import { initTauriFileDrop, tauriFileDrop } from "./hooks/useTauriFileDrop.svelte";
import { createTheme } from "./hooks/useTheme.svelte";
import { createTutorial } from "./hooks/useTutorial.svelte";
import { createUpdateAvailable } from "./hooks/useUpdateAvailable.svelte";
import { createUpdaterBanner } from "./hooks/useUpdaterBanner.svelte";
import { createViewportWidth } from "./hooks/useViewportWidth.svelte";
import { createWebViewZoom } from "./hooks/useWebViewZoom.svelte";
import { createYjsSync } from "./hooks/yjsSync.svelte";
import { createEditorStageModel } from "./layout/editor-stage.svelte";
import { createLayoutModel } from "./layout/model.svelte";
import { loadPanelWidth, PANEL_MAX_WIDTH, PANEL_MIN_WIDTH } from "./panel-layout";
import {
  editAnnotation as marginEditAnnotation,
  removeAnnotation as marginRemoveAnnotation,
  replyToAnnotation as marginReplyToAnnotation,
  sendNoteToClaude as marginSendNoteToClaude,
} from "./panels/annotation-actions";
import MarginColumn from "./panels/MarginColumn.svelte";
import { isLeftMarginAnnotation, isRightMarginAnnotation } from "./panels/marginSides";
import PeekStrip from "./panels/PeekStrip.svelte";
import { useAnnotationReview } from "./panels/useAnnotationReview.svelte";
import { pmSelectionToFlat } from "./positions";
import FormattingBar from "./shell/FormattingBar.svelte";
import TitleBar from "./shell/TitleBar.svelte";
import StatusBar from "./status/StatusBar.svelte";
import DocumentTabs from "./tabs/DocumentTabs.svelte";
import { openFileForRuntime } from "./utils/browse-file";
import { addRecentFile, loadRecentFiles, saveRecentFiles } from "./utils/recentFiles";
import { openServerPath } from "./utils/server-paths";

const yjsSync = createYjsSync();
onDestroy(() => yjsSync.destroy());

// #864: persist unsaved scratchpad content for recovery + warn before losing
// it. Logic lives in the hook to keep App.svelte minimal.
const scratchpadPersistence = createScratchpadPersistence(() => yjsSync.tabs);
onDestroy(() => scratchpadPersistence.destroy());

// In-memory closed-tab history for Ctrl+Alt+T (reopen closed tab). Lifetime is
// the app session; resets on reload. See useClosedTabStack.ts for rationale.
const closedTabStack = createClosedTabStack();
const inflightReopens = new Set<string>();

function closeTabAndRecord(tabId: string) {
  const tab = yjsSync.tabs.find((t) => t.id === tabId);
  // #864: warn before closing a scratchpad that has unsaved content. Annotations
  // are intentionally out of scope (accepted loss); only document text matters.
  if (tab && isScratchpadPath(tab.filePath)) {
    const uuid = scratchpadUuidFromPath(tab.filePath);
    if (uuid && scratchpadPersistence.hasUnsavedContent(uuid)) {
      const ok = window.confirm(
        "This scratchpad has unsaved content that will be lost. Close it anyway?",
      );
      if (!ok) return;
      // User accepted the loss — discard the recovery copy so the next
      // scratchpad open doesn't restore the content they just dismissed.
      scratchpadPersistence.clearUnsaved(uuid);
    }
  }
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

// Remapped-shortcut override layer (ADR-041). Rebuilt whenever the user's
// customShortcuts change; the keydown handler reads it at call time.
const shortcutOverrides = $derived(buildOverrides(settingsState.settings.customShortcuts));
// Effective (override ?? default) formatted labels for Help-modal reflection.
const effectiveShortcutLabels = $derived(effectiveBindingLabels(shortcutOverrides));

const visibleAnnotations = $derived(yjsSync.annotations);
const connectionBanner = createConnectionBanner(
  () => yjsSync.disconnectedSince,
  () => settingsState.settings.degradedBannerDelayMs,
);
const updaterBanner = createUpdaterBanner();
createWebViewZoom();

const openDocs = $derived(yjsSync.tabs.map((t) => ({ id: t.id, fileName: t.fileName })));

const notifications = createNotifications();
let activityOpen = $state(false);
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
  (
    window as unknown as {
      __tandemTest?: {
        openSettingsModal: () => void;
        pushNotification: (n: TandemNotification) => void;
        activeDocumentId: () => string | null;
      };
    }
  ).__tandemTest = {
    openSettingsModal: () => {
      settingsModalOpen = true;
    },
    // Drives the activity center deterministically in E2E without the
    // SSE-connect race (the server's notify-stream has no buffer replay,
    // so a notification pushed before the EventSource connects is lost).
    // Exercises the real client `push` → ingest → tray + transient-pop path.
    pushNotification: (n: TandemNotification) => notifications.push(n),
    // Lets the activity-tray Retry E2E target a genuinely-open doc so the
    // onAction handler reaches triggerSave instead of the closed-doc fallback.
    activeDocumentId: () => yjsSync.activeTabId,
  };
}
let paletteOpen = $state(false);
let fileOpenDialogOpen = $state(false);

// Open-file action: native picker in Tauri, FileOpenDialog modal in the
// browser distribution. Error surfacing is owned by `openFileForRuntime` /
// `browseNativeFile` via the `onError` callback; void callers can fire-and-
// forget safely.
function requestOpenFile(): Promise<void> {
  return openFileForRuntime({
    isTauri: isTauriRuntime(),
    openModal: () => {
      fileOpenDialogOpen = true;
    },
    onError: (message) =>
      notifications.push({
        id: generateNotificationId(),
        type: "general-error",
        severity: "error",
        message,
        timestamp: Date.now(),
      }),
  });
}

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
  openFileDialog: () => void requestOpenFile(),
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
    const cur = activeOrFirstPending();
    if (cur && cur.author !== "user") review.handleAccept(cur.id);
  },
  annotationDismiss: () => {
    const cur = activeOrFirstPending();
    if (cur && cur.author !== "user") review.handleDismiss(cur.id);
  },
  selectBlock: () => editor?.chain().focus().selectParentNode().run(),
  toggleAuthorship: () => setAuthorshipVisible(!settingsState.settings.showAuthorship),
  toggleFormattingBar: () =>
    settingsState.updateSettings({
      formattingBarVisible: !settingsState.settings.formattingBarVisible,
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

// Toggle authorship visibility, auto-unmuting in one updateSettings call when
// the master overlay is on — same coherence rule as the per-type Decorations
// rows, so toggling authorship via Ctrl+Alt+A or the command palette while
// muted is never an invisible no-op (1.13). The Decorations dropdown's own
// authorship row folds the same unmute inside `toggleRow`.
function setAuthorshipVisible(visible: boolean): void {
  settingsState.updateSettings({
    showAuthorship: visible,
    ...(settingsState.settings.decorationsMuted ? { decorationsMuted: false } : {}),
  });
}

// The authorship plugin reads its initial visibility from localStorage at
// construction time, so dispatch only on subsequent changes — first-run
// dispatch was the path that produced an effect-depth loop under prod
// scheduling (transaction → tick → effect rerun → dispatch …).
// Effective visibility folds in the master `decorationsMuted` overlay (1.13);
// reading settings inside the effect body keeps it reactive (NOT a frozen const).
let lastDispatchedAuthorship: boolean | null = null;
$effect(() => {
  const ed = editor;
  if (!ed) return;
  const s = settingsState.settings;
  const visible = !s.decorationsMuted && s.showAuthorship;
  if (lastDispatchedAuthorship === visible) return;
  const firstRun = lastDispatchedAuthorship === null;
  lastDispatchedAuthorship = visible;
  if (firstRun) return;
  untrack(() => {
    const tr = ed.state.tr.setMeta(authorshipPluginKey, { type: "toggle", visible });
    ed.view.dispatch(tr);
  });
});

// #596 → 1.13: per-type decoration visibility. Plugin reads localStorage at
// init; this handles flips. Effective visibility folds in `decorationsMuted`.
// The dedupe guard uses a positional encoding (NOT JSON.stringify, which would
// silently break on a later key reorder/spread → missed or redundant dispatch).
let lastDispatchedDecorations: string | null = null;
$effect(() => {
  const ed = editor;
  if (!ed) return;
  const s = settingsState.settings;
  const muted = s.decorationsMuted;
  const visible = {
    comment: !muted && s.showComments,
    highlight: !muted && s.showHighlights,
    note: !muted && s.showNotes,
  };
  const encoded = `${visible.comment ? 1 : 0}${visible.highlight ? 1 : 0}${visible.note ? 1 : 0}`;
  if (lastDispatchedDecorations === encoded) return;
  const firstRun = lastDispatchedDecorations === null;
  lastDispatchedDecorations = encoded;
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

// When hover-reveal is on, the collapsed-rail `:hover → 28px` peek-grow is
// suppressed (CSS gates on this class) so hovering floats the full panel
// instead of nudging the editor 14px. Off → the classic peek-grow returns.
$effect(() => {
  document.body.classList.toggle(
    "tandem-rail-hover-reveal",
    settingsState.settings.railHoverReveal,
  );
  return () => document.body.classList.remove("tandem-rail-hover-reveal");
});

createTheme(() => settingsState.settings.theme);
createAccentHue(() => settingsState.settings.accentHue);
// #811: resolve the font from the ACTIVE tab's format so a tab switch
// re-derives. `activeTab` MUST be dereferenced inside this getter closure —
// hoisting the format into a const here would freeze the value at init and
// the $effect would never re-run on tab switch (stale-closure trap).
createRootEditorFont(() => resolveFont(settingsState.settings, activeTab?.format));
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
let newTabMenuTrigger = $state(0);

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
  // Clear the transient float BEFORE the visibility commit so there is never a
  // frame with both `.collapsed.floating` and an expanded inline width (Svelte
  // batches both writes into one DOM update).
  railFloat.left = false;
  const nextVisible = !layoutModel.leftVisible;
  layoutModel.toggleLeft();
  focusToggleTarget("left", nextVisible);
};
const toggleRightPanel = () => {
  railFloat.right = false;
  const nextVisible = !layoutModel.rightVisible;
  layoutModel.toggleRight();
  focusToggleTarget("right", nextVisible);
};

// ── Rail motion (#798) + hover-reveal floating mode ───────────────────────
// Two independent behaviours layered on the always-mounted dual-layer shells:
//   1. A width/box-shadow transition on collapse/expand. `display:none` can't
//      transition, so on COLLAPSE we keep `.rail-full` displayed via a per-side
//      `animating` flag until the width transition ends, then drop it — at rest
//      the display:none guarantee (scroll-pop kill + Tab-order drop) holds.
//   2. Hover a CLOSED, non-pinned rail to float its full panel OVER the editor
//      (the 14px collapsed shell stays in flow, so the editor never reflows).
//      Click the edge/peek zone while floating to PIN (toggle*Panel). Float is
//      transient: it auto-hides when neither the pointer nor focus is inside.
type RailSide = "left" | "right";
const railAnimating = $state({ left: false, right: false });
const railFloat = $state({ left: false, right: false });

// Plain (non-$state) refs: hover/animation timer handles + pointer/focus
// presence. Never rendered, so $state would only churn reactivity. Each
// handler clears its own side's timer before scheduling a new one; a single
// unmount-only $effect (below) clears them on teardown.
const HOVER_ENTER_MS = 120;
const HOVER_LEAVE_MS = 180;
const RAIL_ANIM_FALLBACK_MS = 400;
const hoverTimer: Record<RailSide, ReturnType<typeof setTimeout> | undefined> = {
  left: undefined,
  right: undefined,
};
const animTimer: Record<RailSide, ReturnType<typeof setTimeout> | undefined> = {
  left: undefined,
  right: undefined,
};
const pointerInside: Record<RailSide, boolean> = { left: false, right: false };
const focusInside: Record<RailSide, boolean> = { left: false, right: false };

const railVisible = (side: RailSide) =>
  side === "left" ? effectiveLeftVisible : effectiveRightVisible;

function onRailShellEnter(side: RailSide) {
  pointerInside[side] = true;
  if (railVisible(side) || !settingsState.settings.railHoverReveal) return;
  clearTimeout(hoverTimer[side]);
  hoverTimer[side] = setTimeout(() => {
    railFloat[side] = true;
  }, HOVER_ENTER_MS);
}

function maybeHideFloat(side: RailSide) {
  // Float stays open while EITHER the pointer or focus is inside the shell.
  if (pointerInside[side] || focusInside[side]) return;
  railFloat[side] = false;
}

function onRailShellLeave(side: RailSide) {
  pointerInside[side] = false;
  clearTimeout(hoverTimer[side]);
  hoverTimer[side] = setTimeout(() => maybeHideFloat(side), HOVER_LEAVE_MS);
}

function onRailShellFocusIn(side: RailSide) {
  focusInside[side] = true;
}

// Closes the focus-sticky hole: if focus leaves the shell entirely (e.g. the
// outline `jumpTo` moves focus into the editor) the mouseleave timer may never
// re-fire, so hide here instead — unless the pointer is still hovering.
function onRailShellFocusOut(side: RailSide, e: FocusEvent) {
  const shell = e.currentTarget as HTMLElement;
  const next = e.relatedTarget as Node | null;
  if (next && shell.contains(next)) return; // focus moved within the shell
  focusInside[side] = false;
  maybeHideFloat(side);
}

function onRailShellTransitionEnd(side: RailSide, e: TransitionEvent) {
  // Only the shell's OWN width transition clears the flag — `.rail-full.floating`
  // bubbles transform/opacity transitionends, and a future descendant width
  // transition would otherwise re-pop the content mid-collapse.
  if (e.propertyName !== "width" || e.target !== e.currentTarget) return;
  railAnimating[side] = false;
  clearTimeout(animTimer[side]);
}

// Drive the collapse `animating` flag off visibility changes. Read both derives
// to track them; mutate inside untrack so reduceMotion / prev-state reads don't
// add spurious deps.
// Seed with the mount-time visibility (untrack: this is a one-time snapshot the
// $effect below diffs against, not a reactive reference).
const prevRailVisible: Record<RailSide, boolean> = untrack(() => ({
  left: effectiveLeftVisible,
  right: effectiveRightVisible,
}));
$effect(() => {
  const lv = effectiveLeftVisible;
  const rv = effectiveRightVisible;
  untrack(() => {
    handleRailVisChange("left", lv);
    handleRailVisChange("right", rv);
  });
});
function handleRailVisChange(side: RailSide, visible: boolean) {
  if (visible === prevRailVisible[side]) return;
  const collapsing = prevRailVisible[side] && !visible;
  prevRailVisible[side] = visible;
  // Under reduced motion the width snaps (no transition → no transitionend), so
  // never set the flag: `.rail-full` drops to display:none synchronously.
  if (!collapsing || settingsState.settings.reduceMotion) return;
  railAnimating[side] = true;
  clearTimeout(animTimer[side]);
  animTimer[side] = setTimeout(() => {
    railAnimating[side] = false;
  }, RAIL_ANIM_FALLBACK_MS);
}

$effect(() => {
  // Unmount-only cleanup (no deps): clear every outstanding timer.
  return () => {
    clearTimeout(hoverTimer.left);
    clearTimeout(hoverTimer.right);
    clearTimeout(animTimer.left);
    clearTimeout(animTimer.right);
  };
});

const viewport = createViewportWidth();

// Editor stage model (Phase 3.5): owns the horizontal grid layout — a content
// reading-measure track flanked by per-side margin-annotation tracks, centered
// by `1fr` gutters. Replaces the old `editorMaxWidth` / global
// `MARGIN_VIEW_RESERVE_PX` cascade so the margin reserve is taken PER SIDE,
// only where a margin actually renders (opening a rail that hides one margin
// no longer subtracts phantom width from the content). Per-side
// rail-replaces-margin (#683) and the narrow auto-hide threshold + hysteresis
// live in the model; the threshold reads persisted-at-mount rail widths (not
// the live drag width) so it stays stable mid-drag. The grid is non-docx only.
const editorStage = createEditorStageModel({
  getFormat: () => activeTab?.format,
  getMarginView: () => settingsState.settings.marginView,
  getEditorMeasure: () => settingsState.settings.editorMeasure,
  getLeftRailVisible: () => effectiveLeftVisible,
  getRightRailVisible: () => effectiveRightVisible,
  getViewportWidth: () => viewport.width,
  // Presence-collapse inputs. Read the UNGATED `visibleAnnotations` (declared
  // above, `= yjsSync.annotations`) through the shared side-split predicates +
  // `status === "pending"` — the same set the column renders. NOT
  // `marginNotes`/`marginComments` (declared below, `effectivelyOn`-gated):
  // those would close a `$derived` cycle through `effectivelyOn`. See stage-c1
  // [MF-11].
  getLeftHasPending: () =>
    visibleAnnotations.some((a) => a.status === "pending" && isLeftMarginAnnotation(a)),
  getRightHasPending: () =>
    visibleAnnotations.some((a) => a.status === "pending" && isRightMarginAnnotation(a)),
  leftRailWidthPx: leftPanelWidth,
  rightRailWidthPx: rightPanelWidth,
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
    void requestOpenFile();
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
  "new-tab-menu": (e) => {
    // shouldIgnoreShortcut suppresses only INPUT/TEXTAREA + IME — not
    // contenteditable — so Ctrl+T still fires with the cursor in the editor,
    // the dominant "open a new tab while working" case. DocumentTabs owns the
    // menu state; toggle it via the trigger counter.
    if (shouldIgnoreShortcut(e)) return;
    e.preventDefault();
    newTabMenuTrigger += 1;
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
    const cur = activeOrFirstPending();
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
    setAuthorshipVisible(!settingsState.settings.showAuthorship);
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
    // Read overrides at call time (not as an effect dep) so the listener is
    // registered exactly once and never churns / captures a stale map.
    const match = matchShortcut(
      e,
      untrack(() => shortcutOverrides),
    );
    if (!match) return;
    dispatch[match.id]?.(e, match.context);
  }
  window.addEventListener("keydown", handler);
  return () => window.removeEventListener("keydown", handler);
});

// Escape deselects the active annotation — empty selection is a valid resting
// state. The deselect is SCOPED TO THE EDITING SURFACE: it fires when focus is in
// the editor or the annotation rail, OR when nothing in particular is focused
// (document.body / null). The body case matters because a selection can outlive
// its focus: e.g. select an editor highlight (which focuses the editor), then
// click a neutral, non-focusable chrome area that blurs focus back to body — the
// annotation stays active but focus is no longer in the editor. A focus-trapping
// overlay instead holds focus INSIDE itself, so any *specific* non-editing
// element owning focus means an overlay is up and keeps its own Escape-to-close —
// the deselect doesn't piggyback, no per-overlay protocol needed.
// Belt-and-suspenders for overlays that DO leave focus in the editing surface,
// via two distinct mechanisms: (1) overlays with a capture-phase window listener
// + stopPropagation (selection toolbar, settings popover, Help) halt Escape
// before this bubble-phase listener ever runs — `e.defaultPrevented` is moot for
// them; (2) the slash menu calls preventDefault() in its ProseMirror keydown
// handler without stopping propagation, so this listener DOES run and the
// `e.defaultPrevented` guard is what skips it. `findBarOpen` is explicit because
// the find bar closes on Escape WITHOUT preventDefault, so if focus has returned
// to the editor (e.g. after jumping to a match) while find is still open, neither
// guard above would catch the stray deselect. Reads happen at event time, outside
// any tracking scope, so the effect registers once with current values.
$effect(() => {
  function onEscape(e: KeyboardEvent) {
    if (e.key !== "Escape" || e.defaultPrevented) return;
    if (activeAnnotationId === null || findBarOpen) return;
    const el = document.activeElement as HTMLElement | null;
    if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) return;
    const inEditingSurface =
      !el ||
      el === document.body ||
      !!el.closest(
        '.ProseMirror, [data-testid="editor-root"], [data-testid="annotation-list-scroll-container"]',
      );
    if (!inEditingSurface) return;
    e.preventDefault();
    activeAnnotationId = null;
  }
  window.addEventListener("keydown", onEscape);
  return () => window.removeEventListener("keydown", onEscape);
});

const activeTab = $derived(yjsSync.tabs.find((t) => t.id === yjsSync.activeTabId));

// #842: when the user reaches the empty tab-bar state (e.g. closes the last
// tab) with a live connection, auto-open a fresh scratchpad instead of
// stranding them on "No document open."
//
// The debounce is load-bearing, not cosmetic: on initial connect `connected`
// flips true before the server's `openDocuments` list syncs, so `tabs` is
// briefly empty. Firing immediately would race the startup doc
// (welcome.md / CHANGELOG.md, opened server-side before HTTP bind) and open a
// stray scratchpad ahead of it. The timer also rides out the transient
// `activeTab === null` during a Y.Doc swap (reload-from-disk) and never fires
// during the disconnect-debounce window (gate requires `connected`). The
// startup doc arriving within the window re-runs this effect, cleanup clears
// the pending timer, and the gate no longer passes — so no scratchpad opens.
$effect(() => {
  if (
    !shouldAutoOpenScratchpad({
      connected: yjsSync.connected,
      tabCount: yjsSync.tabs.length,
      activeTabId: yjsSync.activeTabId,
    })
  ) {
    return;
  }
  const timer = setTimeout(() => {
    void createScratchpad();
  }, SCRATCHPAD_EMPTY_STATE_DEBOUNCE_MS);
  return () => clearTimeout(timer);
});

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

// Resolve target for accept/dismiss: the explicitly-selected annotation, or —
// when nothing is selected (the empty resting state) — the first pending review
// target. Shared by the Ctrl+Enter shortcut and the command-palette
// accept/dismiss commands so the two surfaces can never diverge (review finding).
// The two branches differ in what they can return: the fallback
// (getReviewTargets()[0]) is always a Claude target because getReviewTargets()
// excludes user notes/highlights, but the active branch returns WHATEVER is
// selected — which can be a user highlight overlapping a Claude comment (#768).
// So the `author !== "user"` guard at call sites is load-bearing for the active
// branch, not just defense-in-depth.
function activeOrFirstPending(): Annotation | undefined {
  return activeAnnotationId
    ? visibleAnnotations.find((a) => a.id === activeAnnotationId)
    : review.getReviewTargets()[0];
}

// #649: Word-style margin annotation view.
// PR 1 ships minimum viable — bubbles appear at correct Y, naive scroll sync
// via DOM nesting in the positioning layer. Collision resolution lands in
// PR 2; rail-collapse and narrow-layout auto-disable in PR 3.
// Side-split via the shared predicates (panels/marginSides) so these render
// arrays and the editorStage presence-collapse booleans can never diverge.
// Still gated on `effectivelyOn` here (the column only mounts when on); the
// presence booleans deliberately read the ungated source instead (see above).
const marginNotes = $derived(
  editorStage.effectivelyOn ? visibleAnnotations.filter(isLeftMarginAnnotation) : [],
);
const marginComments = $derived(
  editorStage.effectivelyOn ? visibleAnnotations.filter(isRightMarginAnnotation) : [],
);
const marginPositions = createMarginPositions({
  getEditor: () => editor,
  getYdoc: () => activeTab?.ydoc ?? null,
  getAnnotations: () => [...marginNotes, ...marginComments],
  getLayerEl: () => marginLayerEl,
  getEnabled: () => editorStage.effectivelyOn,
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
      showAuthorship={settingsState.settings.showAuthorship}
      showComments={settingsState.settings.showComments}
      showHighlights={settingsState.settings.showHighlights}
      showNotes={settingsState.settings.showNotes}
      decorationsMuted={settingsState.settings.decorationsMuted}
      onUpdateDecorations={(partial) => settingsState.updateSettings(partial)}
      onOpenSettings={toggleSettings}
      formattingBarVisible={settingsState.settings.formattingBarVisible}
      onToggleFormattingBar={() =>
        settingsState.updateSettings({
          formattingBarVisible: !settingsState.settings.formattingBarVisible,
        })}
      reduceMotion={settingsState.settings.reduceMotion}
    />

    {#if settingsState.settings.formattingBarVisible}
      <FormattingBar
        {editor}
        ydoc={activeTab?.ydoc ?? null}
        showAuthorship={settingsState.settings.showAuthorship}
        showComments={settingsState.settings.showComments}
        showHighlights={settingsState.settings.showHighlights}
        showNotes={settingsState.settings.showNotes}
        decorationsMuted={settingsState.settings.decorationsMuted}
        onUpdateDecorations={(partial) => settingsState.updateSettings(partial)}
        onOpenSettings={toggleSettings}
        onHide={() => settingsState.updateSettings({ formattingBarVisible: false })}
      />
    {/if}

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
        // inline overflow toolbar), scope this reset or move it to a focus
        // listener. Today the row has no horizontally-scrollable children, so
        // the unconditional reset is safe.
        e.currentTarget.scrollLeft = 0;
      }}
    >
      <!-- Left rail: always-mounted dual-layer shell. The `.rail-full` layer
           (the outline panel) display:none's when collapsed — its PanelSlot
           instance + scroll position persist, but it has no layout box, so its
           scroll effects can't pop the editor and its children leave the Tab
           order. The peek layer previews the outline as tick-marks. The shell
           owns the chrome (bg, radius, shadow) + hover-grow + the width/shadow
           transition (#798); the outermost 8px of the full layer is the
           edge-click collapse zone. `.floating` lets a hover-revealed panel
           paint over the editor (the 14px shell stays in flow). -->
      <!-- svelte-ignore a11y_no_static_element_interactions -->
      <!-- The mouse/focus handlers are a pointer-only reveal enhancement; the
           real controls (peek strip, edge-collapse, panel contents) are
           focusable buttons, and keyboard users pin via Alt+Shift+Arrow. -->
      <div
        class="rail-shell rail-shell-left"
        class:collapsed={!effectiveLeftVisible}
        class:animating={railAnimating.left}
        class:floating={railFloat.left}
        data-testid={railFloat.left ? "rail-float-left" : undefined}
        style={effectiveLeftVisible ? `width: ${dragResizeLeft.width}px;` : ""}
        onmouseenter={() => onRailShellEnter("left")}
        onmouseleave={() => onRailShellLeave("left")}
        onfocusin={() => onRailShellFocusIn("left")}
        onfocusout={(e) => onRailShellFocusOut("left", e)}
        ontransitionend={(e) => onRailShellTransitionEnd("left", e)}
      >
        <div
          data-testid="left-outline-rail"
          class="rail-full rail-full-left"
          style={`width: ${dragResizeLeft.width}px;`}
        >
          <PanelSlot
            kind="outline"
            focusTrigger={outlineFocusTrigger}
            {editor}
            visible={true}
          />
          {@render edgeCollapse("left", toggleLeftPanel)}
        </div>
        <PeekStrip side="left" collapsed={!effectiveLeftVisible} kind="outline" onActivate={toggleLeftPanel} />
      </div>
      {#if effectiveLeftVisible}
        {@render resizeHandle("left", (e) => dragResizeLeft.handleResizeStart(e), undefined, dragResizeLeft.width)}
      {/if}

      {@render editorColumn()}

      {#if effectiveRightVisible}
        {@render resizeHandle("right", (e) => dragResizeRight.handleResizeStart(e), "panel-resize-handle", dragResizeRight.width)}
      {/if}
      <!-- Right rail: always-mounted dual-layer shell (mirrors the left rail).
           The `.rail-full` layer (tabs + chat/annotations panels) display:none's
           when collapsed; the peek layer previews annotations as colored dots.
           See the left rail for the display-toggle rationale. -->
      <!-- svelte-ignore a11y_no_static_element_interactions -->
      <div
        class="rail-shell rail-shell-right"
        class:collapsed={!effectiveRightVisible}
        class:animating={railAnimating.right}
        class:floating={railFloat.right}
        data-testid={railFloat.right ? "rail-float-right" : undefined}
        style={effectiveRightVisible ? `width: ${dragResizeRight.width}px;` : ""}
        onmouseenter={() => onRailShellEnter("right")}
        onmouseleave={() => onRailShellLeave("right")}
        onfocusin={() => onRailShellFocusIn("right")}
        onfocusout={(e) => onRailShellFocusOut("right", e)}
        ontransitionend={(e) => onRailShellTransitionEnd("right", e)}
      >
        <div
          class="rail-full rail-full-right"
          style={`width: ${dragResizeRight.width}px;`}
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
        <PeekStrip
          side="right"
          collapsed={!effectiveRightVisible}
          kind="annotations"
          annotations={visibleAnnotations}
          onActivate={toggleRightPanel}
        />
      </div>
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

    <HelpModal
      open={showHelp}
      onClose={() => (showHelp = false)}
      effectiveShortcutLabels={effectiveShortcutLabels}
    />

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

    <ActivityTray
      items={notifications.activity}
      open={activityOpen}
      onToggle={() => (activityOpen = !activityOpen)}
      onDismiss={notifications.dismissActivity}
      onClear={notifications.clearActivity}
      onAction={(item) => {
        const action = resolveActivityAction(item);
        if (!action) return;
        // The failed doc may have been closed since the error fired; triggerSave
        // would silently skip a closed doc, so tell the user to reopen instead.
        if (yjsSync.tabs.some((t) => t.id === action.documentId)) {
          void triggerSave(action.documentId);
        } else {
          notifications.push({
            // Deterministic per-doc id (matches the dedupKey) so repeat clicks
            // coalesce on one stable row instead of risking a same-ms id clash.
            id: `retry-unavailable-${action.documentId}`,
            type: "general-error",
            severity: "warning",
            message: "Reopen the document to retry the save.",
            dedupKey: `retry-unavailable:${action.documentId}`,
            timestamp: Date.now(),
          });
        }
      }}
    />

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
    onRequestOpenDialog={() => void requestOpenFile()}
    openMenuTrigger={newTabMenuTrigger}
    closedTabTop={closedTabStack.top}
    onReopenClosed={reopenClosedTab}
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

<!-- Edge-click collapse zone: full-height 12px strip at the outer edge of
     the rail. Both rails run edge-to-edge top-to-bottom; the grip bar inside
     is vertically centered. The right rail's scrollbar shares the outer edge
     — a known minor conflict; the strip stays narrow so a Windows scrollbar
     (~17px) remains grabbable from the inside half. Sibling of panel content
     (not a parent) so descendant clicks never bubble in. -->
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
        onClearAnnotation={() => {
          activeAnnotationId = null;
        }}
        onSlashCommandMenuChange={(open) => (slashCommandMenuOpen = open)}
      />
    {/snippet}
    <!-- One snippet, two call sites: left wires `marginNotes`, right wires
         `marginComments` (the only per-side difference). All other props +
         handlers are identical, so the distinct annotation wiring lives at the
         call site rather than in two near-identical bodies. -->
    {#snippet marginColumn(side: "left" | "right", annotations: readonly Annotation[])}
      <!-- Per-side geometry + mode resolved from `side`: the format clamp (docx
           → full|off) and presence-collapse (empty side → off) both live in the
           editorStage getters, so each call site gets its side-correct width.
           A side rendered here is never `off` (the {#if leftVisible/rightVisible}
           guards gate mounting), so `geom` is always the live widthMode track. -->
      {@const geom = side === "left" ? editorStage.leftGeometry : editorStage.rightGeometry}
      {@const mode = side === "left" ? editorStage.leftMode : editorStage.rightMode}
      <MarginColumn
        {side}
        {annotations}
        positions={marginPositions.byId}
        width={geom.column}
        edgeInset={geom.inset}
        gap={geom.gap}
        {mode}
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
        reduceMotion={settingsState.settings.reduceMotion}
      />
    {/snippet}
    <!-- Margin-annotation positioning layer + editor stage (#649 / Phase 3.5).
         The layer wraps editor content so its block height matches the
         editor's; bubble Y-positions + scroll sync are measured against it.

         INVARIANT 1 — no re-bind: this <div> must remain mounted across
         marginView toggles. `marginLayerEl` is a $state ref read inside
         useMarginPositions's $effect, which subscribes; re-binding via
         {#if}/{#key} would cause listener teardown/rebuild storms (the
         feedback_svelte_state_bind_this_loop pattern). Only the element's
         STYLE changes (grid ⇄ contents/relative); it never remounts.

         INVARIANT 2 — getEnabled() short-circuit ordering: recompute() reads
         layer.getBoundingClientRect() ONLY after the getEnabled() early-return.
         When margins are off the layer is `display: contents` (docx) or a
         collapsed grid (non-docx); measuring then would be meaningless, so the
         guard must stay ahead of the rect read. Don't move it.

         INVARIANT 3 — no padding/border on the stage: useMarginPositions reads
         the border-box top as the bubble origin, and the grid's first row
         starts at the content-box top. Any padding-/border-top would offset
         every bubble. Spacing lives on `.editor-scroll`; the stage and its
         `.margin-track` cells stay padding/border-free.

         Layout is format-aware (editorStage.layerStyle):
         - docx keeps its own path — `position: relative` (margin siblings
           absolutely position against the layer) / `display: contents` off.
         - non-docx is a CSS Grid stage [1fr · marginL · content · marginR · 1fr]:
           content track at the reading measure, per-side margin tracks (272px
           shown / 0 hidden), `1fr` gutters centering the block. Reserve is
           taken only where a margin renders (the per-side fix). -->
    <div bind:this={marginLayerEl} data-testid="editor-stage" style={editorStage.layerStyle}>
      {#if activeTab?.format === "docx"}
        {#key activeTab.id}
          {@render editorContent()}
        {/key}
        {#if editorStage.leftVisible && activeTab}{@render marginColumn("left", marginNotes)}{/if}
        {#if editorStage.rightVisible && activeTab}{@render marginColumn("right", marginComments)}{/if}
      {:else}
        <!-- Content track (grid column 3). The grid template caps its width at
             the reading measure; the `1fr` gutters (columns 1 & 5) center it.

             INVARIANT 5 — every cell pins `grid-row: 1`. The margin tracks are
             declared AFTER the content in DOM order but at lower column indices
             (2 & 4 vs 3). Under the default sparse `grid-auto-flow: row`, an
             item whose explicit column is behind the auto-placement cursor is
             bumped to the next row — so without an explicit row the margin
             tracks land in row 2, BELOW the content, dumping every bubble at the
             bottom of the stage. `grid-row: 1` on all three keeps the single-row
             layout the bubble-offset math assumes. Don't drop it. -->
        <div class="editor-content-track" style="grid-column: 3; grid-row: 1;">
          {#if activeTab}
            {#key activeTab.id}
              {@render editorContent()}
            {/key}
          {:else}
            <EmptyState
              connected={yjsSync.connected}
              claudeActive={yjsSync.claudeActive}
              onOpenFile={() => (fileOpenDialogOpen = true)}
              onRetry={() => yjsSync.reconnect()}
              onOpenSettings={openSettingsModalWithAck}
            />
          {/if}
        </div>
        <!-- Per-side margin tracks (grid columns 2 & 4): a `position: relative`
             cell of the reserve width. MarginColumn's existing absolute
             geometry lands unchanged inside it, and the cell top equals the
             layer top so layer-relative bubble offsets stay valid. Mounted only
             when that side renders a margin. -->
        {#if editorStage.leftVisible && activeTab}
          <div class="margin-track" style="grid-column: 2; grid-row: 1;">
            {@render marginColumn("left", marginNotes)}
          </div>
        {/if}
        {#if editorStage.rightVisible && activeTab}
          <div class="margin-track" style="grid-column: 4; grid-row: 1;">
            {@render marginColumn("right", marginComments)}
          </div>
        {/if}
      {/if}
    </div>
    <!-- End-of-document marker — gives the editor enough trailing scroll
         room that the last heading can reach the scroll-spy threshold zone
         (top of the viewport) when clicked from the outline. A faint pill
         marks where the document ends; the rest is empty whitespace.
         Hidden when there's no active document so the EmptyState scene
         isn't dragged down by phantom space. -->
    {#if activeTab}
      <div class="editor-end-marker" aria-hidden="true">
        <span class="editor-end-pill">End of document</span>
      </div>
    {/if}
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
  /* Always-mounted dual-layer rail. The shell owns width + chrome (bg, inner
     radius, side shadow) + the hover-grow; its two children (`.rail-full` via
     the data-testid divs in markup, and `.rail-peek` via PeekStrip) are
     absolute layers display-toggled by the `collapsed` class. Expanded width
     is set inline (`width: <dragWidth>px`); the collapsed width + hover-grow
     live here so the CSS `:hover` rule can win (an inline width would not be
     overridable). overflow:hidden clips the 28px peek button to a 14px sliver
     at rest. */
  .rail-shell {
    position: relative;
    flex-shrink: 0;
    overflow: hidden;
    margin-top: var(--tandem-rail-top-clearance, 0);
    margin-bottom: var(--tandem-status-clearance-total, 60px);
    background: var(--tandem-surface-muted);
    /* #798: ease the open/close width + the side shadow. The collapse-side
       display:none of `.rail-full` is deferred by the `.animating` flag (JS)
       so the content clips away with the width instead of popping. */
    transition:
      width 360ms cubic-bezier(0.22, 1, 0.36, 1),
      box-shadow 280ms cubic-bezier(0.22, 1, 0.36, 1);
  }
  /* Reduce motion: snap (the JS path likewise skips the `animating` flag so
     `.rail-full` drops to display:none synchronously). The :global body class
     mirrors the OS query but also honours the in-app reduceMotion setting; the
     media-query rule wins by SOURCE ORDER (equal specificity to the base), the
     body-class rule by added specificity — both override the base transition. */
  @media (prefers-reduced-motion: reduce) {
    .rail-shell {
      transition: none;
    }
  }
  :global(body.tandem-reduce-motion) .rail-shell {
    transition: none;
  }
  .rail-shell-left {
    border-radius: 0 var(--tandem-rail-inner-radius, 14px) var(--tandem-rail-inner-radius, 14px) 0;
    box-shadow: var(--tandem-rail-shadow-left);
  }
  .rail-shell-right {
    z-index: 1;
    border-radius: var(--tandem-rail-inner-radius, 14px) 0 0 var(--tandem-rail-inner-radius, 14px);
    box-shadow: var(--tandem-rail-shadow-right);
  }
  .rail-shell.collapsed {
    width: 14px;
    cursor: pointer;
  }
  /* Width-grow is :hover ONLY — never :focus-within. The peek strip is
     tabindex="-1", so its only focus path is the inert restoration focus that
     focusToggleTarget() applies after a keyboard collapse (preserving Tab
     position). Per #859 that restoration focus must be visually inert; a
     :focus-within widen would silently expand the sliver 14→28px on collapse
     with no user hover — the exact bug #859 fixed. The PeekStrip's own
     affordances (chevron/label/tick reveal) are likewise scoped to :hover.
     Gated off when hover-reveal is on: there, hovering floats the full panel
     instead, and a 14→28px in-flow grow would nudge the editor first. */
  :global(body:not(.tandem-rail-hover-reveal)) .rail-shell.collapsed:hover {
    width: 28px;
  }
  /* The full layer fills the shell, anchored to the shell's inside edge (left
     rail → right side, right rail → left side). Only the expanded width is
     dynamic (set inline); the static box + the display:none-when-collapsed
     (load-bearing: kills the scroll-pop + drops children from the Tab order)
     live here, driven by the `collapsed` class already on the shell. */
  .rail-full {
    position: absolute;
    inset-block: 0;
    display: flex;
    flex-direction: column;
    overflow: hidden;
  }
  .rail-full-left {
    right: 0;
  }
  .rail-full-right {
    left: 0;
  }
  .rail-shell.collapsed .rail-full {
    display: none;
  }
  /* Collapse animation: keep `.rail-full` displayed while the width transition
     runs so it clips away smoothly; the JS clears `animating` on transitionend,
     restoring the at-rest display:none. (0,4,0) beats the display:none above. */
  .rail-shell.collapsed.animating .rail-full {
    display: flex;
  }
  /* Hover-reveal float: the shell stays 14px in flow (editor unmoved), but it
     stops clipping so its `.rail-full` paints OVER the editor at the real drag
     width. The anchor flips to the window edge and the panel extends inward. */
  .rail-shell.floating {
    overflow: visible;
    z-index: var(--tandem-z-rail-float);
  }
  /* `display: flex` here has the SAME specificity as the `.collapsed .rail-full`
     display:none above and wins by SOURCE ORDER — this rule must stay AFTER it.
     (The `.collapsed.animating` rule outranks both on specificity.) */
  .rail-shell.floating .rail-full {
    display: flex;
    animation: tandem-rail-float-in 280ms cubic-bezier(0.22, 1, 0.36, 1);
  }
  .rail-shell-left.floating .rail-full-left {
    right: auto;
    left: 0;
    --rail-float-from: -12px;
    box-shadow: var(--tandem-rail-shadow-left);
  }
  .rail-shell-right.floating .rail-full-right {
    left: auto;
    right: 0;
    --rail-float-from: 12px;
    box-shadow: var(--tandem-rail-shadow-right);
  }
  /* The 14px peek sliver would otherwise poke through the floating panel's
     inside edge (PeekStrip paints after `.rail-full` in DOM). */
  .rail-shell.floating :global(.peek-strip) {
    display: none;
  }
  @keyframes tandem-rail-float-in {
    from {
      opacity: 0;
      transform: translateX(var(--rail-float-from, 0));
    }
    to {
      opacity: 1;
      transform: translateX(0);
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .rail-shell.floating .rail-full {
      animation: none;
    }
  }
  :global(body.tandem-reduce-motion) .rail-shell.floating .rail-full {
    animation: none;
  }
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

  /* Editor stage grid cells (Phase 3.5; non-docx). Both cells are
     padding/border-free so the grid's first row starts at the stage's
     border-box top — the origin useMarginPositions measures bubble offsets
     against (INVARIANT 3). */
  .editor-content-track {
    /* `min-width: 0` lets the content shrink below the reading measure when the
       margin tracks + gutters consume the row (the minmax(0,…) track floor);
       without it a grid item's `min-width: auto` would force overflow. */
    min-width: 0;
  }
  .margin-track {
    /* INVARIANT 4 — `position: relative` is load-bearing, NOT cosmetic. A grid
       container does NOT establish a positioned containing block for its
       descendants, so without this rule MarginColumn's absolute bubbles + leader
       SVG would resolve against `.editor-scroll` (the next positioned ancestor),
       breaking bubble X (off-track) AND Y (`.editor-scroll`'s padding-box top,
       not the layer's border-box top — the origin useMarginPositions measures).
       With it, the cell top equals the stage(layer) top (single grid row, no
       padding), so MarginColumn's layer-relative `top` offsets land correctly.
       Do not drop it during a CSS tidy. */
    position: relative;
    min-width: 0;
  }

  .editor-end-marker {
    /* Trailing scroll room so the outline's last heading can pin to the top.
       Pill sits just below content; the remaining height is empty whitespace
       so the user can scroll the last heading up to the threshold zone. */
    height: 70vh;
    display: flex;
    align-items: flex-start;
    justify-content: center;
    padding-top: var(--tandem-space-5);
    pointer-events: none;
  }
  .editor-end-pill {
    font-size: var(--tandem-text-2xs, 10px);
    font-weight: 500;
    letter-spacing: 0.04em;
    text-transform: uppercase;
    color: var(--tandem-fg-faint, var(--tandem-fg-subtle));
    background: var(--tandem-surface-muted);
    border-radius: var(--tandem-r-pill);
    padding: var(--tandem-space-1) var(--tandem-space-3);
    opacity: 0.6;
  }
  .panel-edge-collapse {
    position: absolute;
    width: 12px;
    top: 0;
    bottom: 0;
    cursor: pointer;
    z-index: 1;
    background: transparent;
    transition: background 140ms ease;
    display: flex;
    align-items: center;
    justify-content: center;
  }
  .panel-edge-collapse::before {
    content: "";
    width: 1.5px;
    height: 28px;
    background: var(--tandem-border-strong);
    border-radius: 1px;
    opacity: 0.55;
    transition: opacity 140ms ease, height 140ms ease, background 140ms ease;
  }
  .panel-edge-collapse:hover::before {
    opacity: 1;
    height: 36px;
    background: var(--tandem-accent);
  }
  .panel-edge-collapse-left {
    left: 0;
  }
  .panel-edge-collapse-right {
    right: 0;
  }
  .panel-edge-collapse:hover {
    background: var(--tandem-accent-bg);
  }
  /* tabindex="-1": never reachable via Tab, so the only focus paths are the
     keyboard-toggle restoration helper (focusToggleTarget) and a mouse click
     — neither warrants a keyboard-style focus ring. The restoration focus
     follows a keydown, so :focus-visible matches and would draw a lingering
     blue ring after Alt+Shift+Arrow toggles (#859). Suppress the ring; the
     :hover background still signals the zone on pointer interaction. */
  .panel-edge-collapse:focus-visible {
    outline: none;
  }
</style>
