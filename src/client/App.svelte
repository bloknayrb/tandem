<script lang="ts">
import type { Editor as TiptapEditor } from "@tiptap/core";
import { onDestroy, untrack } from "svelte";
import { BYO_MODELS_ENABLED } from "../shared/constants";
import { isScratchpadPath, isUploadPath, scratchpadUuidFromPath } from "../shared/paths";
import { toPmPos } from "../shared/positions/types";
import type { Annotation, CapturedAnchor, TandemNotification } from "../shared/types";
import { isPendingReviewTarget } from "../shared/types";
import { generateNotificationId } from "../shared/utils";
import {
  createScratchpad,
  relaunchClaudeCode,
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
import DocxConflictBanner from "./components/DocxConflictBanner.svelte";
import EmptyState from "./components/EmptyState.svelte";
import FidelityReportBanner from "./components/FidelityReportBanner.svelte";
import FileOpenDialog from "./components/FileOpenDialog.svelte";
import HelpModal from "./components/HelpModal.svelte";
import IntegrationWizardModal from "./components/IntegrationWizardModal.svelte";
import LicenseBanner from "./components/LicenseBanner.svelte";
import LicenseWall from "./components/LicenseWall.svelte";
import OnboardingTutorial from "./components/OnboardingTutorial.svelte";
import PanelSlot from "./components/PanelSlot.svelte";
import ReviewOnlyBanner from "./components/ReviewOnlyBanner.svelte";
import SettingsModal, { SETTINGS_TAB_IDS } from "./components/SettingsModal.svelte";
import ToastContainer from "./components/ToastContainer.svelte";
import UpdaterBanner from "./components/UpdaterBanner.svelte";
import { isTauriRuntime } from "./cowork/cowork-helpers";
import Editor from "./editor/Editor.svelte";
import { annotationPluginKey } from "./editor/extensions/annotation";
import { authorshipPluginKey } from "./editor/extensions/authorship";
import { getFindState } from "./editor/extensions/find-replace.js";
import FindReplaceBar from "./editor/find-replace/FindReplaceBar.svelte";
import SourceView from "./editor/SourceView.svelte";
import Toolbar from "./editor/toolbar/Toolbar.svelte";
import { createAccentHue } from "./hooks/useAccentHue.svelte";
import { createAiReadiness } from "./hooks/useAiReadiness.svelte";
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
import { licenseStore } from "./hooks/useLicense.svelte";
import { createMarginPositions } from "./hooks/useMarginPositions.svelte";
import { createModels } from "./hooks/useModels.svelte";
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
import { motionOff } from "./panels/cardMotion";
import MarginColumn from "./panels/MarginColumn.svelte";
import { isLeftMarginAnnotation, isRightMarginAnnotation } from "./panels/marginSides";
import PeekStrip from "./panels/PeekStrip.svelte";
import { useAnnotationReview } from "./panels/useAnnotationReview.svelte";
import { pmSelectionToFlat } from "./positions";
import FormattingBar from "./shell/FormattingBar.svelte";
import TitleBar from "./shell/TitleBar.svelte";
import StatusBar from "./status/StatusBar.svelte";
import DocumentTabs from "./tabs/DocumentTabs.svelte";
import { tabIdsToCloseOthers, tabIdsToCloseRight } from "./tabs/tab-context-menu.js";
import { isRenamable } from "./types.js";
import { openFileForRuntime } from "./utils/browse-file";
import { addRecentFile, loadRecentFiles, saveRecentFiles } from "./utils/recentFiles";
import { openServerPath } from "./utils/server-paths";

// `getRetryStrategy` is read lazily inside yjsSync (only after bootstrap), so it
// safely closes over `settingsState`, which is initialized further down.
const yjsSync = createYjsSync({
  getRetryStrategy: () => settingsState.settings.sidecarRetryStrategy,
});
onDestroy(() => yjsSync.destroy());

// #864: persist unsaved scratchpad content for recovery + warn before losing
// it. Logic lives in the hook to keep App.svelte minimal.
const scratchpadPersistence = createScratchpadPersistence(() => yjsSync.tabs);
onDestroy(() => scratchpadPersistence.destroy());

// #1116: license gate (ADR-040). Polls /api/license/status; on any
// restricted↔unrestricted transition, rebuild the doc-room providers so the
// server re-applies Surface A's read-only mode via onAuthenticate (a bare
// reconnect() can't — connect() no-ops on a live socket in hocuspocus-provider
// 3.x). This clamps to read-only on trial→restricted and releases it on
// restricted→licensed. Dark builds (the default until v1.0) poll once and go
// quiet — the store self-stops when gateActive is false, so this never fires.
licenseStore.start({ onTransition: () => yjsSync.rebuildForLicenseChange() });
onDestroy(() => licenseStore.stop());

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
  // #1021: warn before closing a tab with uncommitted markdown-source edits
  // (mirrors the #864 scratchpad confirm above). The disk file is intact — this
  // is loss of unsaved source-view work only.
  if (sourceDirtyTabs.has(tabId)) {
    const ok = window.confirm(
      "This document has unsaved markdown-source edits that will be lost. Close it anyway?",
    );
    if (!ok) return;
  }
  if (tab && !isUploadPath(tab.filePath)) {
    closedTabStack.push({ filePath: tab.filePath, closedAt: Date.now() });
  }
  // Drop any source-view flag + draft for the closed tab so the maps don't leak (#1021).
  if (sourceViewTabs.has(tabId)) {
    const next = new Set(sourceViewTabs);
    next.delete(tabId);
    sourceViewTabs = next;
  }
  clearSourceDraft(tabId);
  // Drop the closed tab's remembered scroll position so scrollMemory doesn't
  // leak across long sessions (mirrors the source-view/draft cleanup above; #1055).
  scrollMemory.delete(tabId);
  yjsSync.handleTabClose(tabId);
}

// Tab context-menu bulk closes (#923 Phase 2). The id lists are computed by
// pure helpers (which guard against a stale right-clicked id closing every
// tab) and snapshotted before the loop — closeTabAndRecord mutates the tab
// list, so iterating live tabs would skip entries. Each close routes through
// closeTabAndRecord so the scratchpad-unsaved guard + closed-tab stack apply.
function closeOtherTabs(keepId: string) {
  for (const id of tabIdsToCloseOthers(tabOrder.orderedTabs, keepId)) closeTabAndRecord(id);
}

function closeTabsToRight(fromId: string) {
  for (const id of tabIdsToCloseRight(tabOrder.orderedTabs, fromId)) closeTabAndRecord(id);
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
// Models registry is the server-authoritative store singleton since M2 (#1123);
// the chip reads its `$state` getters, not `settingsState.settings.models`.
const modelsStore = createModels();
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

// Tray "Setup AI Assistant" (Tauri-only): the Rust side emits
// "open-integration-wizard" after focusing the window. Re-dispatch the same
// window CustomEvent the Settings "Reopen wizard" affordance uses, so the
// wizard opens on demand. Replaces the old run_setup() tray round-trip removed
// in #477 PR 3c-ii-c.
if (isTauriRuntime()) {
  let unlisten: (() => void) | null = null;
  let cancelled = false;
  import("@tauri-apps/api/event")
    .then(({ listen }) =>
      listen("open-integration-wizard", () => {
        window.dispatchEvent(new CustomEvent("tandem:open-integration-wizard"));
      }),
    )
    .then((un) => {
      if (cancelled) un();
      else unlisten = un;
    })
    .catch((err) => {
      console.warn("[App] Failed to wire open-integration-wizard listener:", err);
      // The tray "Setup AI Assistant" item is now the primary replacement for
      // the removed run_setup() round-trip; if its listener can't wire, clicking
      // it would be a silent no-op (Rust emits the event, nothing receives it).
      // Surface a recoverable warning instead of swallowing it to console.
      notifications.push({
        id: `open-wizard-listener-failed-${Date.now()}`,
        type: "launcher",
        severity: "warning",
        message:
          "Couldn't enable the Setup shortcut. Open Settings → Reopen wizard to configure integrations.",
        dedupKey: "open-wizard-listener-failed",
        timestamp: Date.now(),
      });
    });
  onDestroy(() => {
    cancelled = true;
    unlisten?.();
  });
}

// Surface OS file-association open failures (Tauri-only) as a warning toast.
// The Rust side classifies the rejected double-clicked file and signals a
// STABLE, PATH-FREE reason code via two surfaces, both handled here (see #630):
//  - cold-start: buffered in a OnceLock-style slot (the App listener doesn't
//    exist yet at classification time) — polled once via `get_startup_rejection`
//    on mount. The buffer is TAKEN, so a WebView reload won't replay it.
//  - warm-start / macOS Apple-Event: emitted live as `startup-file-rejected`.
// The user double-clicked a file and silently landed on welcome.md; this is the
// feedback. The message is composed here from the code so no path reaches the
// DOM (mirrors the sidecar-restart-failed contract).
if (isTauriRuntime()) {
  const messageForCode = (code: string): string => {
    switch (code) {
      case "unsupported-extension":
        return "That file type can't be opened in Tandem.";
      case "not-a-file":
      case "non-file-url":
        return "That file couldn't be opened — it may have moved or been deleted.";
      case "suspicious-path":
        return "That file path was rejected for safety reasons.";
      default:
        return "That file couldn't be opened in Tandem.";
    }
  };
  const pushStartupRejection = (code: string): void => {
    notifications.push({
      id: `startup-file-rejected-${Date.now()}`,
      type: "general-error",
      severity: "warning",
      message: messageForCode(code),
      dedupKey: "startup-file-rejected",
      timestamp: Date.now(),
      errorCode: "STARTUP_FILE_REJECTED",
    });
  };

  let unlistenRejected: (() => void) | null = null;
  let rejectedCancelled = false;

  // Live (warm-start / macOS Apple-Event) rejections arrive as events.
  import("@tauri-apps/api/event")
    .then(({ listen }) =>
      listen<string>("startup-file-rejected", (event) => {
        pushStartupRejection(typeof event.payload === "string" ? event.payload : "");
      }),
    )
    .then((un) => {
      if (rejectedCancelled) un();
      else unlistenRejected = un;
    })
    .catch((err) => {
      console.warn("[App] Failed to wire startup-file-rejected listener:", err);
    });

  // Cold-start rejection was buffered before this listener existed — drain it
  // once. `get_startup_rejection` TAKES the value, so this is idempotent across
  // re-mounts.
  import("@tauri-apps/api/core")
    .then(({ invoke }) => invoke<string | null>("get_startup_rejection"))
    .then((code) => {
      if (code) pushStartupRejection(code);
    })
    .catch((err) => {
      console.warn("[App] Failed to poll buffered startup rejection:", err);
    });

  onDestroy(() => {
    rejectedCancelled = true;
    unlistenRejected?.();
  });
}

let settingsModalOpen = $state(false);

const firstRun = createFirstRunNeeded();

// AI-readiness (#1018/#1022): keys on launcher status, not the doc-sync "Synced"
// dot. Gate on the monotonic `firstRun.settled` (set true once, never reset) so
// a `refetch()` during a server blip can't bounce the chip back to "booting".
const aiReadiness = createAiReadiness({
  connected: () => yjsSync.connected,
  firstRunSettled: () => firstRun.settled,
  soloMode: () => modeState.tandemMode === "solo",
});

// Boot-race guard for the first-run wizard. The hook's boot fetch fires once at
// construction with no retry; in the desktop app the WebView loads immediately
// while the sidecar is still spawning (no `visible:false`, sidecar started on a
// background task), so a cold-start race can leave `needed=false` permanently.
// Re-check once the sidecar is confirmed reachable. `yjsSync.connected` is a
// sound readiness proxy: the connect path only builds the Hocuspocus provider
// AFTER a successful `GET :3479/api/info`, so `connected === true` implies
// `first-run-needed` (registered in the same route pass) is live. Latch only on
// a SUCCESSFUL refetch (component-scoped, non-reactive) so a transient failure
// lets a later reconnect retry; dismissal is still respected by isAutoOpenFirstRun.
// Skip entirely once `needed === true`: this recheck exists to recover a false
// NEGATIVE (the race), not to revalidate a value the wizard is already showing.
// Without this guard, a transient failure on this second, redundant fetch would
// unconditionally reset `needed=false` (fetchOnce's error path), yanking an
// already-auto-opened wizard out from under the user mid-flow.
let firstRunRecheckedOnConnect = false;
$effect(() => {
  if (yjsSync.connected && !firstRunRecheckedOnConnect && firstRun.needed !== true) {
    void firstRun.refetch().then((ok) => {
      if (ok) firstRunRecheckedOnConnect = true;
    });
  }
});

/** Opens the Claude Code integration wizard (the "Connect AI" CTA). Reuses the
 *  existing manual-reopen event path so dismissal isn't burned (see the
 *  `tandem:open-integration-wizard` listener below). */
function connectAi(): void {
  window.dispatchEvent(new CustomEvent("tandem:open-integration-wizard"));
}

/** Restarts the stopped Claude Code process (the "Restart Claude Code" CTA),
 *  then re-polls launcher status so the chip clears once it's back up. Two
 *  staggered refreshes cover a slow cold start (MCP init / skill refresh) so
 *  the chip doesn't look stuck waiting for the next 8s background poll. */
function restartClaude(): void {
  relaunchClaudeCode();
  setTimeout(() => aiReadiness.refresh(), 2_000);
  setTimeout(() => aiReadiness.refresh(), 5_000);
}

// #1018 loud failures: ChatPanel (chat send) and Toolbar ("Send to Claude"
// comment) dispatch `tandem:addressed-ai` AFTER persisting. If AI isn't
// actually connected (`chip` non-null: unconfigured/stopped, not Solo, not
// booting), surface a notice that AFFIRMS the save and frames absence as
// deferred delivery — the message/comment persists in the Y.Doc and is read
// whenever an agent next connects. Never "failed/lost". `chip` is read
// imperatively at event time (no reactive dependency, no loop). Notes/
// highlights never dispatch this (ADR-027 — they're private, never sent to AI).
$effect(() => {
  const onAddressedAi = async (e: Event) => {
    const via = (e as CustomEvent<{ via?: string }>).detail?.via;
    if (aiReadiness.chip === null) return; // ready / booting / Solo — nothing to nudge
    // The polled chip can be up to 8s stale: an agent whose MCP initialize
    // landed after the last background poll still reads as absent, firing a
    // false "no AI is connected" notice while the agent is live (#1083).
    // Confirm with a fresh /health probe before alarming.
    if (await aiReadiness.probeSession()) return;
    const chip = aiReadiness.chip; // re-read — state may have settled while probing
    if (chip === null) return;
    const noun = via === "comment" ? "Comment" : "Message";
    notifications.push(
      {
        id: `ai-not-ready-${via ?? "chat"}-${Date.now()}`,
        type: "launcher",
        severity: "warning",
        message: `${noun} saved — no AI is connected yet. It'll be seen when AI connects.`,
        dedupKey: `ai-not-ready-${via ?? "chat"}`,
        timestamp: Date.now(),
      },
      {
        label: chip === "connect" ? "Connect AI" : "Restart Claude Code",
        onClick: chip === "connect" ? connectAi : restartClaude,
      },
    );
  };
  window.addEventListener("tandem:addressed-ai", onAddressedAi);
  return () => window.removeEventListener("tandem:addressed-ai", onAddressedAi);
});

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
// `firstRun.needed` is intentionally MCP-anchored: the Node server can only
// see MCP-client config (it has no visibility into model state, which lives
// in client localStorage, or Cowork state, which lives behind Tauri). The
// unified wizard surfaces models + Cowork client-side under "More
// integrations" — do NOT try to make `needed` "smart" about them.
const isAutoOpenFirstRun = $derived(
  firstRun.needed === true &&
    firstRun.serverVersion !== null &&
    dismissedForVersion !== firstRun.serverVersion,
);
const shouldShowWizard = $derived(manuallyReopened || isAutoOpenFirstRun);

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
// deterministically, independent of the keyboard shortcut. Exposed only in
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
// whenever the user opens Settings (any tab counts). Do NOT destructure:
// the `showDot` getter loses reactivity when pulled out.
const updateAvailable = createUpdateAvailable();

function openSettingsModalWithAck() {
  updateAvailable.acknowledge();
  settingsModalOpen = true;
}

const defaultModelLabel = $derived.by(() => {
  const id = modelsStore.defaultModelId;
  if (id === null) return null;
  const entry = modelsStore.models.find((m) => m.id === id);
  return entry ? entry.displayName : null;
});

// `initialTabId` is applied only on the closed → open transition, so a
// mid-open chip click leaves the user's current tab alone.
let nextSettingsTabId = $state<string | null>(null);

function openModelsSettings() {
  if (!settingsModalOpen) nextSettingsTabId = SETTINGS_TAB_IDS.models;
  openSettingsModalWithAck();
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
  openSettings: openSettingsModalWithAck,
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
  toggleSourceView: () => toggleSourceView(),
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

createTheme(
  () => settingsState.settings.theme,
  () => settingsState.settings.systemLightVariant,
);
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
// Per-tab raw-markdown source view (#1021). Ephemeral (not persisted): the set
// of tab IDs currently showing the markdown source editor instead of WYSIWYG.
let sourceViewTabs = $state(new Set<string>());
// In-progress source text + dirty flags, keyed by tab ID, lifted out of
// SourceView so uncommitted edits survive a tab switch (which unmounts the
// component) and so tab close / app quit can warn before discarding them
// (#1021 review SHOULD-FIX).
let sourceDrafts = $state(new Map<string, string>());
let sourceDirtyTabs = $state(new Set<string>());

function updateSourceDraft(tabId: string, text: string, dirty: boolean): void {
  const drafts = new Map(sourceDrafts);
  const dirtyTabs = new Set(sourceDirtyTabs);
  if (dirty) {
    drafts.set(tabId, text);
    dirtyTabs.add(tabId);
  } else {
    drafts.delete(tabId);
    dirtyTabs.delete(tabId);
  }
  sourceDrafts = drafts;
  sourceDirtyTabs = dirtyTabs;
}

function clearSourceDraft(tabId: string): void {
  if (!sourceDrafts.has(tabId) && !sourceDirtyTabs.has(tabId)) return;
  const drafts = new Map(sourceDrafts);
  const dirtyTabs = new Set(sourceDirtyTabs);
  drafts.delete(tabId);
  dirtyTabs.delete(tabId);
  sourceDrafts = drafts;
  sourceDirtyTabs = dirtyTabs;
}
let outlineFocusTrigger = $state(0);
let commentFocusTrigger = $state(0);
let newTabMenuTrigger = $state(0);
// F2 (#1017): increment to start renaming the active tab. DocumentTabs owns the
// rename-edit state; this counter is its trigger, mirroring newTabMenuTrigger.
let renameTabTrigger = $state(0);

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
  pinFromFloat("left");
  railFloat.left = false;
  const nextVisible = !layoutModel.leftVisible;
  layoutModel.toggleLeft();
  focusToggleTarget("left", nextVisible);
};
const toggleRightPanel = () => {
  pinFromFloat("right");
  railFloat.right = false;
  const nextVisible = !layoutModel.rightVisible;
  layoutModel.toggleRight();
  focusToggleTarget("right", nextVisible);
};
// Pinning a floated rail: snap the shell to the float's width (no 14→full open
// replay) for the single commit frame, then restore the transition next frame.
// No-op when the rail isn't floating (a plain collapse/expand keeps its motion).
function pinFromFloat(side: RailSide) {
  if (!railFloat[side]) return;
  railPinSnap[side] = true;
  requestAnimationFrame(() => {
    railPinSnap[side] = false;
  });
}

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
// Per-side hover-float lifecycle is a small state machine: idle → floating
// (railFloat) → closing (railFloatClosing) → idle, the two phases mutually
// exclusive. railPinSnap is an orthogonal one-frame modifier (the float→pin
// exit), not a lifecycle phase. Kept as separate booleans because each maps 1:1
// to a CSS class; promote to an explicit enum if a fourth phase ever lands.
const railFloat = $state({ left: false, right: false });
// Set for ONE frame when a hover-float is pinned: the floated panel is already
// painted at full width over the editor, so the shell must snap to that width
// (transition suppressed) instead of replaying the 14→full open from collapsed,
// which would flash the panel away and regrow it. Cleared on the next rAF so
// later collapses still animate.
const railPinSnap = $state({ left: false, right: false });
// True while a hover-float is sliding BACK out to the minimized sliver. The
// panel stays mounted+painted (display:flex, positioned over the editor) and
// plays the reverse slide; a timer drops the flag once it's tucked away, at
// which point `.rail-full` reverts to display:none. Without this the panel just
// vanishes on mouseout instead of retreating into the edge.
const railFloatClosing = $state({ left: false, right: false });

// Plain (non-$state) refs: hover/animation timer handles + pointer/focus
// presence. Never rendered, so $state would only churn reactivity. Each
// handler clears its own side's timer before scheduling a new one; a single
// unmount-only $effect (below) clears them on teardown.
const HOVER_ENTER_MS = 120;
const HOVER_LEAVE_MS = 180;
const RAIL_ANIM_FALLBACK_MS = 400;
// Duration of the float-out slide; must match the slide-out keyframe duration in
// CSS so the `float-closing` flag drops exactly as the panel finishes tucking
// away (the keyframe's `forwards` fill holds it off-screen until then).
const FLOAT_CLOSE_MS = 300;
// The retreat path checks reduced motion (via `motionOff`, which OR-s the in-app
// setting with the OS query): the slide-in can ignore it (under `animation: none`
// the panel just appears, the correct reduced behaviour), but the closing phase
// holds the panel for FLOAT_CLOSE_MS, so without this gate an OS-reduce user (app
// setting off) would see it linger then vanish instead of dropping instantly.
// Mirrors the CSS `@media (prefers-reduced-motion)` guard.
const hoverTimer: Record<RailSide, ReturnType<typeof setTimeout> | undefined> = {
  left: undefined,
  right: undefined,
};
const closeTimer: Record<RailSide, ReturnType<typeof setTimeout> | undefined> = {
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
  // Re-entered while the panel is sliding back out: cancel the retreat and snap
  // straight back to floating. The panel is still on screen, so skip the enter
  // delay (a delay here would let it finish collapsing and flash away first).
  if (railFloatClosing[side]) {
    clearTimeout(closeTimer[side]);
    railFloatClosing[side] = false;
    railFloat[side] = true;
    return;
  }
  hoverTimer[side] = setTimeout(() => {
    railFloat[side] = true;
  }, HOVER_ENTER_MS);
}

function maybeHideFloat(side: RailSide) {
  // Float stays open while EITHER the pointer or focus is inside the shell.
  if (pointerInside[side] || focusInside[side]) return;
  if (!railFloat[side]) return;
  railFloat[side] = false;
  // No retreat slide when the rail is pinned (still visible via its non-collapsed
  // state — there's nothing to retreat) or under reduced motion: drop straight to
  // the minimized sliver. Only a collapsed hover-float slides back into the edge.
  if (railVisible(side) || motionOff(settingsState.settings.reduceMotion)) {
    railFloatClosing[side] = false;
    return;
  }
  // Hand off to the closing phase: keep the panel mounted and let it slide back
  // into the edge, then drop the flag so `.rail-full` returns to display:none.
  railFloatClosing[side] = true;
  clearTimeout(closeTimer[side]);
  closeTimer[side] = setTimeout(() => {
    railFloatClosing[side] = false;
  }, FLOAT_CLOSE_MS);
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
    clearTimeout(closeTimer.left);
    clearTimeout(closeTimer.right);
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
    // In source view, SourceView owns Ctrl+S (it commits the edit) and
    // stopPropagations — this is belt-and-suspenders against that invariant
    // being broken later: the global save must never write the stale Y.Doc to
    // disk underneath an open source edit (#1021 review must-fix).
    if (inSourceView) return;
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
  settings: (e) => {
    e.preventDefault();
    openSettingsModalWithAck();
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
    const reviewOnly = isReadOnly;
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
    // F2 = rename the active tab (#1017). A bare function key can't be a
    // remappable chord (isBindableChord requires a modifier), so it's handled
    // here as a FIXED shortcut, outside matchShortcut. shouldIgnoreShortcut
    // suppresses INPUT/TEXTAREA + IME (not contenteditable), so F2 still fires
    // with the caret in the editor — the dominant "rename while working" case —
    // but not while typing in a field (incl. the rename input itself).
    if (e.key === "F2" && !e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey) {
      if (shouldIgnoreShortcut(e)) return;
      const tab = yjsSync.tabs.find((t) => t.id === yjsSync.activeTabId);
      if (tab && isRenamable(tab)) {
        e.preventDefault();
        renameTabTrigger += 1;
      }
      return;
    }
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
// + stopPropagation (selection toolbar, Help) halt Escape
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

// #1055: per-tab vertical scroll memory. The `.editor-scroll` container is
// always-mounted across tab switches (only its inner content remounts via the
// `{#key activeTab.id}` block), so we remember each document's scrollTop keyed
// by documentId and restore it on switch-back instead of jumping to the top.
let editorScrollEl = $state<HTMLDivElement | null>(null);
const scrollMemory = new Map<string, number>();
// The document id currently displayed in `editorScrollEl`. A plain variable
// (not reactive state): the scroll listener reads it to attribute live scroll
// to the right document without re-triggering the switch effect.
let scrollMemoryDocId: string | undefined;

// Continuously record the active document's live scrollTop. Capturing on every
// scroll (rather than only when switching away) is timing-independent: by the
// time the switch effect re-runs the inner content has already remounted via
// `{#key activeTab.id}` and the container's scrollTop has reset, so reading it
// then would record the WRONG (incoming) position for the outgoing document.
$effect(() => {
  const el = editorScrollEl;
  if (!el) return;
  const onScroll = (): void => {
    if (scrollMemoryDocId !== undefined) {
      scrollMemory.set(scrollMemoryDocId, el.scrollTop);
    }
  };
  el.addEventListener("scroll", onScroll, { passive: true });
  return () => el.removeEventListener("scroll", onScroll);
});

// Restore the saved scrollTop whenever the active document changes.
$effect(() => {
  const el = editorScrollEl;
  // Read the active document id so this effect re-runs on tab switch. (The
  // derived may re-fire with the same id when the tab array updates for
  // unrelated reasons — the `=== scrollMemoryDocId` guard makes those re-runs
  // no-ops so we never disturb the user's live scroll position.)
  const nextId = activeTab?.id;
  if (!el) return;
  if (nextId === scrollMemoryDocId) return;

  scrollMemoryDocId = nextId;
  if (nextId === undefined) return;

  const saved = scrollMemory.get(nextId) ?? 0;

  // Content height isn't final synchronously after the `{#key}` content swap,
  // so re-apply the saved offset across a few frames until the container can
  // actually hold it (the browser clamps scrollTop to scrollHeight -
  // clientHeight otherwise). Bounded so a now-shorter document can't loop.
  let frame = 0;
  let cancelled = false;
  const apply = (): void => {
    if (cancelled || scrollMemoryDocId !== nextId) return;
    el.scrollTop = saved;
    if (el.scrollTop < saved && frame < 30) {
      frame += 1;
      requestAnimationFrame(apply);
    }
  };
  requestAnimationFrame(apply);

  return () => {
    cancelled = true;
  };
});

// Raw-markdown source view (#1021). Only editable .md documents qualify
// (read-only .md like CHANGELOG and non-.md formats are excluded).
const isReadOnly = $derived(activeTab?.readOnly === true);
// When the license wall is up (trial expired, no license) the editor is forced
// read-only as a client-side belt to the server gates — Surface A already makes
// the Hocuspocus connection read-only, so this only stops local keystrokes that
// the full-screen wall already covers. `showWall` is false when the gate is dark
// or the license is valid, so this collapses to `isReadOnly` in the normal case.
// Kept separate from `isReadOnly` so document-level affordances (source view,
// status indicator) keep their own meaning. (#1116)
const editorReadOnly = $derived(isReadOnly || licenseStore.ui.showWall);
const canSourceView = $derived(!!activeTab && activeTab.format === "md" && !isReadOnly);
const inSourceView = $derived(!!activeTab && sourceViewTabs.has(activeTab.id));

function toggleSourceView(): void {
  if (!activeTab) return;
  const id = activeTab.id;
  const next = new Set(sourceViewTabs);
  if (next.has(id)) {
    next.delete(id);
  } else {
    if (!canSourceView) return;
    next.add(id);
    // Source view replaces the Tiptap editor; close editor-bound overlays so
    // they don't linger non-functional over the textarea.
    findBarOpen = false;
    slashCommandMenuOpen = false;
    paletteOpen = false;
  }
  sourceViewTabs = next;
}

function exitSourceView(id: string): void {
  if (!sourceViewTabs.has(id)) return;
  const next = new Set(sourceViewTabs);
  next.delete(id);
  sourceViewTabs = next;
  // Returning to WYSIWYG discards any in-progress draft (a dirty exit commits
  // first via SourceView.handleExit, which already cleared it).
  clearSourceDraft(id);
}

// Warn before unloading the page (reload / quit) while any source view holds
// uncommitted edits — mirrors the scratchpad #864 beforeunload guard.
$effect(() => {
  const onBeforeUnload = (ev: BeforeUnloadEvent): void => {
    if (sourceDirtyTabs.size === 0) return;
    ev.preventDefault();
    ev.returnValue = "You have unsaved markdown-source edits.";
  };
  window.addEventListener("beforeunload", onBeforeUnload);
  return () => window.removeEventListener("beforeunload", onBeforeUnload);
});

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
  onApplyFailed: (ann) =>
    notifications.push({
      // Keyed by ann.id (matches dedupKey below), not Date.now() — two
      // different annotations failing in the same millisecond must not
      // collide onto one id, which would let one toast's dismiss timer
      // remove the other's still-live entry.
      id: `suggestion-apply-failed-${ann.id}`,
      type: "annotation-error",
      severity: "warning",
      message:
        "Couldn't apply the suggestion — the text has changed. The annotation is still pending.",
      dedupKey: `suggestion-apply-failed:${ann.id}`,
      timestamp: Date.now(),
    }),
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

// WS-A2: umbrella held-count for the StatusBar signal. Counts every item the
// AI hasn't seen yet because the user is in Solo — held comments plus held
// replies ON comments (note/highlight replies never reach the AI, so a held
// marker there is not "held from the AI" and must not inflate the count).
// Derived from the persisted `heldInSolo` field, NEVER from live mode, so it
// matches the per-card "Held" pill and survives a server restart.
const heldCount = $derived.by(() => {
  let n = 0;
  for (const a of visibleAnnotations) {
    if (a.heldInSolo === true) n++;
    if (a.type === "comment") {
      const replies = marginReplies.byId.get(a.id);
      if (replies) for (const r of replies) if (r.heldInSolo === true) n++;
    }
  }
  return n;
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
    onSendToClaude: (id: string) => marginSendNoteToClaude(ydoc, id, modeState.tandemMode),
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
    theme={settingsState.settings.theme}
    onSetTheme={(t) => settingsState.updateSettings({ theme: t })}
    onOpenHelp={() => (showHelp = true)}
    onOpenSettings={openSettingsModalWithAck}
    updateAvailable={updateAvailable.showDot}
    defaultModelLabel={BYO_MODELS_ENABLED ? defaultModelLabel : null}
    onOpenModelsSettings={openModelsSettings}
    aiChip={aiReadiness.chip}
    onConnectAi={connectAi}
    onRestartClaude={restartClaude}
    sourceViewActive={inSourceView}
    onToggleSourceView={canSourceView || inSourceView ? toggleSourceView : null}
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

    <!-- #1116: trial countdown. Self-gates (renders only during an active trial;
         silent when the gate is dark or a license is active). -->
    <LicenseBanner />

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
      onOpenSettings={openSettingsModalWithAck}
      formattingBarVisible={settingsState.settings.formattingBarVisible}
      onToggleFormattingBar={() =>
        settingsState.updateSettings({
          formattingBarVisible: !settingsState.settings.formattingBarVisible,
        })}
      reduceMotion={settingsState.settings.reduceMotion}
      tandemMode={modeState.tandemMode}
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
        onOpenSettings={openSettingsModalWithAck}
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
        class:rail-floating-chrome={railFloat.left || railFloatClosing.left}
        class:floating={railFloat.left}
        class:float-closing={railFloatClosing.left}
        class:pin-snap={railPinSnap.left}
        data-testid={railFloat.left ? "rail-float-left" : undefined}
        style={effectiveLeftVisible ? `width: ${dragResizeLeft.width}px;` : ""}
        onmouseenter={() => onRailShellEnter("left")}
        onmouseleave={() => onRailShellLeave("left")}
        onfocusin={() => onRailShellFocusIn("left")}
        onfocusout={(e) => onRailShellFocusOut("left", e)}
        ontransitionend={(e) => onRailShellTransitionEnd("left", e)}
      >
        {#if railFloat.left || railFloatClosing.left}
          <div
            class="rail-float-shadow rail-float-shadow-left"
            style={`width: ${dragResizeLeft.width}px;`}
            aria-hidden="true"
          ></div>
        {/if}
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
        class:rail-floating-chrome={railFloat.right || railFloatClosing.right}
        class:floating={railFloat.right}
        class:float-closing={railFloatClosing.right}
        class:pin-snap={railPinSnap.right}
        data-testid={railFloat.right ? "rail-float-right" : undefined}
        style={effectiveRightVisible ? `width: ${dragResizeRight.width}px;` : ""}
        onmouseenter={() => onRailShellEnter("right")}
        onmouseleave={() => onRailShellLeave("right")}
        onfocusin={() => onRailShellFocusIn("right")}
        onfocusout={(e) => onRailShellFocusOut("right", e)}
        ontransitionend={(e) => onRailShellTransitionEnd("right", e)}
      >
        {#if railFloat.right || railFloatClosing.right}
          <div
            class="rail-float-shadow rail-float-shadow-right"
            style={`width: ${dragResizeRight.width}px;`}
            aria-hidden="true"
          ></div>
        {/if}
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
            tandemMode={modeState.tandemMode}
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
      aiLiveIndicator={aiReadiness.liveIndicator}
      aiState={aiReadiness.state}
      soloMode={modeState.tandemMode === "solo"}
      claudeWorkingTool={yjsSync.claudeWorking?.tool ?? null}
      readOnly={isReadOnly}
      saving={saveStore.saving}
      lastSaveOk={saveStore.lastSaveOk}
      {editor}
      {heldCount}
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
      onReplayTutorial={tutorial.restartTutorial}
    />

    <!-- #1116: restricted-mode activation wall. Self-gates on `ui.showWall`
         (trial expired, no license). Full-screen scrim over the editor; the
         read/export escape hatch holds since the document underneath stays
         loaded. Server gates (Surface A/B) are the real enforcement. -->
    <LicenseWall />

    <HelpModal
      open={showHelp}
      onClose={() => (showHelp = false)}
      effectiveShortcutLabels={effectiveShortcutLabels}
    />

    {#if shouldShowWizard}
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

    {#if isTauriRuntime() && !shouldShowWizard}
      <!-- Gated off while the wizard is open so only ONE createCoworkStatus
           poller is live at a time and the wizard's Cowork sub-view owns the
           declined state inline. On wizard close this re-mounts and re-derives
           uacDeclined from its own poller (no App-level armed state). -->
      <CoworkAdminDeclinedModal />
    {/if}

    {#if tutorial.tutorialActive && !shouldShowWizard}
      <!-- Sequenced behind the first-run wizard: the wizard scrim (z=100000)
           buries the tutorial card (z=900) AND the welcome doc it points at, so
           on a true first run the card waits until the wizard is dismissed
           (shouldShowWizard→false). Mirrors the CoworkAdminDeclinedModal gate
           above. Nothing harmful happens while buried: the user can't drive any
           step forward under the scrim, and the only auto-advancing step (the
           completion timer) is unreachable from the step-0 start state. (Claude
           could in theory resolve a seed annotation via MCP and nudge step 0,
           but that's real progress, not a lost step.) -->
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
    onCloseOthers={closeOtherTabs}
    onCloseToRight={closeTabsToRight}
    reorder={tabOrder.reorder}
    reduceMotion={settingsState.settings.reduceMotion}
    onRequestOpenDialog={() => void requestOpenFile()}
    openMenuTrigger={newTabMenuTrigger}
    onTabRename={(tabId, newName) =>
      yjsSync.handleTabRename(tabId, newName, (message) =>
        notifications.push({
          id: generateNotificationId(),
          type: "launcher",
          severity: "error",
          message,
          timestamp: Date.now(),
        }),
      )}
    renameTrigger={renameTabTrigger}
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
  <!-- Non-scrolling offset parent for the floating find bar: anchors it to the
       editor column's top-right so it floats above the doc and never scrolls
       away. `.editor-scroll` keeps all its bindings, handlers, and styles. -->
  <div class="editor-column-wrap">
    <div
      bind:this={editorScrollEl}
      data-testid="editor-scroll-container"
      class="editor-scroll tandem-scroll-fade-y"
      class:hide-raw-md={!settingsState.settings.showRawMarkdown}
      use:scrollFade={"y"}
      role="region"
      aria-label="Document editor"
      style={`position: relative; flex: 1; overflow: auto; padding: max(var(--tandem-space-7), 52px) var(--tandem-space-5) var(--tandem-space-7) var(--tandem-space-5); border: ${fileDrop.fileDragOver || tauriFileDrop.fileDragOver ? "2px dashed var(--tandem-accent)" : "2px solid transparent"}; background: ${fileDrop.fileDragOver || tauriFileDrop.fileDragOver ? "var(--tandem-accent-bg)" : "var(--tandem-bg)"}; transition: border-color 0.15s, background 0.15s; border-radius: ${fileDrop.fileDragOver || tauriFileDrop.fileDragOver ? "var(--tandem-r-5)" : "0"};`}
      ondragover={fileDrop.handleEditorDragOver}
      ondragleave={fileDrop.handleEditorDragLeave}
      ondrop={fileDrop.handleEditorDrop}
    >
    <ReviewOnlyBanner
      visible={isReadOnly && activeTab?.format === "docx"}
      documentId={activeTab?.id}
    />
    {#if activeTab && activeTab.format === "docx"}
      <DocxConflictBanner
        ydoc={activeTab.ydoc}
        documentId={activeTab.id}
        fileName={activeTab.fileName}
      />
      <FidelityReportBanner
        ydoc={activeTab.ydoc}
        documentId={activeTab.id}
        fileName={activeTab.fileName}
      />
    {/if}
    {#snippet editorContent()}
      <Editor
        ydoc={activeTab!.ydoc}
        provider={activeTab!.provider}
        readOnly={editorReadOnly}
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
        reduceMotion={settingsState.settings.reduceMotion}
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
    {/snippet}
    {#if inSourceView && activeTab}
      <!-- Raw-markdown source view (#1021) replaces the WYSIWYG stage entirely.
           The Tiptap editor unmounts (editor → null); margin hooks park safely
           via their null-editor guards (see createMarginPositions).

           This UNMOUNTS marginLayerEl, which INVARIANT 1 below forbids across
           *marginView* toggles. It's safe here because `inSourceView` is
           margin-independent state — no margin effect reads or writes it, so
           there's no bind:this feedback loop (the storm INVARIANT 1 guards is a
           self-triggering cycle, not a one-way unmount on an external toggle). -->
      <!-- Keyed on the tab ID so switching to another source-view tab remounts
           a fresh SourceView that re-fetches + restores that tab's own draft —
           rather than reactively swapping documentId on a shared instance. -->
      {#key activeTab.id}
        <SourceView
          documentId={activeTab.id}
          ydoc={activeTab.ydoc}
          initialDraft={sourceDrafts.get(activeTab.id)}
          onDraftChange={(text, dirty) => updateSourceDraft(activeTab!.id, text, dirty)}
          onExit={() => exitSourceView(activeTab!.id)}
        />
      {/key}
    {:else}
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
              aiChip={aiReadiness.chip}
              onOpenFile={() => (fileOpenDialogOpen = true)}
              onRetry={() => yjsSync.reconnect()}
              onOpenSettings={openSettingsModalWithAck}
              onConnectAi={connectAi}
              onRestartClaude={restartClaude}
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
    {/if}
    </div>
    <!-- Find/Replace bar: sibling of the scroll container so it floats top-right
         of the editor column without scrolling with the document. The `{#if open}`
         gate lives inside the component. -->
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
  /* z-index lifts the pinned rail above the editor column. Both rails are
     z:auto flex items of the same row as the editor-scroll, and the editor is
     later in DOM — so without this its opaque background paints OVER the rail's
     outset side-shadow, clipping it dead at the panel's inside edge ("cut off
     by the editor"). The floating state bumps to --tandem-z-rail-float (5); this
     is the pinned/collapsed baseline, shared by both rails. */
  .rail-shell-left,
  .rail-shell-right {
    z-index: 1;
  }
  .rail-shell-left {
    border-radius: 0 var(--tandem-rail-inner-radius, 14px) var(--tandem-rail-inner-radius, 14px) 0;
    box-shadow: var(--tandem-rail-shadow-left);
  }
  .rail-shell-right {
    border-radius: var(--tandem-rail-inner-radius, 14px) 0 0 var(--tandem-rail-inner-radius, 14px);
    box-shadow: var(--tandem-rail-shadow-right);
  }
  .rail-shell.collapsed {
    width: 14px;
    cursor: pointer;
  }
  /* Float→pin: snap the shell to the floated width for the commit frame so the
     panel stays put instead of replaying the 14→full open from collapsed. */
  .rail-shell.pin-snap {
    transition: none;
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
     width. The anchor flips to the window edge and the panel extends inward.
     `.rail-floating-chrome` is present for BOTH the open (`.floating`) and the
     retreat (`.float-closing`) phases — same chrome, reverse slide — so every
     structural rule below keys on it; only the animation rules distinguish the
     two phases. */
  .rail-shell.rail-floating-chrome {
    overflow: visible;
    z-index: var(--tandem-z-rail-float);
  }
  /* `display: flex` here has the SAME specificity as the `.collapsed .rail-full`
     display:none above and wins by SOURCE ORDER — this rule must stay AFTER it.
     (The `.collapsed.animating` rule outranks both on specificity.) */
  /* The shell normally owns the panel background, but when floating it stays a
     14px sliver — so the full-width floating panel must paint its OWN opaque
     surface, or the 14px collapsed shell shows through as a minimized-rail strip
     down the edge (and the editor shows behind the rest). Matches the shell bg.
     overflow:hidden (inherited from the base `.rail-full`) is KEPT so panel
     content clips to the rounded corner — the directional drop shadow is cast by
     a separate `.rail-float-shadow` layer instead, because an outset box-shadow
     on this element would be clipped by that same overflow on the rounded side. */
  .rail-shell.rail-floating-chrome .rail-full {
    display: flex;
    background: var(--tandem-surface-muted);
  }
  /* Drop-shadow layer for the floating panel: an empty, transparent, content-free
     sibling painted BEHIND `.rail-full` (earlier in DOM) at the same bounds. It
     carries the directional box-shadow so the shadow renders unclipped (it has no
     overflow:hidden of its own and nothing to clip), while `.rail-full` keeps its
     overflow clip for the rounded content. Grows with the panel via the same
     reveal keyframe; pointer-transparent so it never eats clicks. */
  .rail-float-shadow {
    position: absolute;
    inset-block: 0;
    pointer-events: none;
  }
  .rail-shell-left.rail-floating-chrome .rail-float-shadow-left {
    left: 0;
    border-radius: 0 var(--tandem-rail-inner-radius, 14px) var(--tandem-rail-inner-radius, 14px) 0;
    box-shadow: var(--tandem-rail-shadow-left);
  }
  .rail-shell-right.rail-floating-chrome .rail-float-shadow-right {
    right: 0;
    border-radius: var(--tandem-rail-inner-radius, 14px) 0 0 var(--tandem-rail-inner-radius, 14px);
    box-shadow: var(--tandem-rail-shadow-right);
  }
  /* Floating panels must read as the same rail, not a square overlay: match the
     extended shell's rounded inner corner and slide out from the window edge with
     the shell's open easing/duration (#798), per-side because each slides toward
     the editor from its own edge. */
  .rail-shell-left.rail-floating-chrome .rail-full-left {
    right: auto;
    left: 0;
    border-radius: 0 var(--tandem-rail-inner-radius, 14px) var(--tandem-rail-inner-radius, 14px) 0;
  }
  .rail-shell-right.rail-floating-chrome .rail-full-right {
    left: auto;
    right: 0;
    border-radius: var(--tandem-rail-inner-radius, 14px) 0 0 var(--tandem-rail-inner-radius, 14px);
  }
  /* Slide IN on float, OUT on retreat — the panel and its shadow move together.
     The leaving slide uses `forwards` so the panel holds off-screen at the end
     instead of snapping back to translateX(0) for the frames before the JS drops
     the `float-closing` flag (which then returns `.rail-full` to display:none). */
  .rail-shell-left.floating .rail-full-left,
  .rail-shell-left.floating .rail-float-shadow-left {
    animation: tandem-rail-float-slide-left 360ms cubic-bezier(0.22, 1, 0.36, 1);
  }
  .rail-shell-right.floating .rail-full-right,
  .rail-shell-right.floating .rail-float-shadow-right {
    animation: tandem-rail-float-slide-right 360ms cubic-bezier(0.22, 1, 0.36, 1);
  }
  .rail-shell-left.float-closing .rail-full-left,
  .rail-shell-left.float-closing .rail-float-shadow-left {
    animation: tandem-rail-float-slide-out-left 300ms cubic-bezier(0.64, 0, 0.78, 0) forwards;
  }
  .rail-shell-right.float-closing .rail-full-right,
  .rail-shell-right.float-closing .rail-float-shadow-right {
    animation: tandem-rail-float-slide-out-right 300ms cubic-bezier(0.64, 0, 0.78, 0) forwards;
  }
  /* The 14px peek sliver would otherwise poke through the floating panel's
     inside edge (PeekStrip paints after `.rail-full` in DOM). */
  .rail-shell.rail-floating-chrome :global(.peek-strip) {
    display: none;
  }
  /* Hide the edge-collapse grab handle while floating: its 1.5px accent bar
     reads as a stray minimized-rail sliver against the editor, and "collapse"
     is the wrong verb for a floated panel (clicking the zone PINS). The 12px
     hit zone stays clickable — only the visual bar + hover tint are dropped. */
  .rail-shell.rail-floating-chrome .panel-edge-collapse::before {
    display: none;
  }
  .rail-shell.rail-floating-chrome .panel-edge-collapse:hover {
    background: transparent;
  }
  /* Slide the floating panel out from the window edge, as if the collapsed
     sliver itself slid open: the panel translates in as a rigid body from behind
     its own edge (the left rail from the left, the right rail from the right)
     rather than wiping open in place. The leading edge carries the drop shadow
     with it, and the row's overflow:hidden clips the still-tucked portion so it
     reads as emerging from the edge. translateX (unlike the old clip-path wipe)
     never clips the box-shadow, so no inset padding is needed. */
  @keyframes tandem-rail-float-slide-left {
    from {
      transform: translateX(-100%);
    }
    to {
      transform: translateX(0);
    }
  }
  @keyframes tandem-rail-float-slide-right {
    from {
      transform: translateX(100%);
    }
    to {
      transform: translateX(0);
    }
  }
  /* Retreat: the reverse of the open slide — the panel tucks back behind its own
     edge. `forwards` (on the rule) holds it there until the JS drops the flag. */
  @keyframes tandem-rail-float-slide-out-left {
    from {
      transform: translateX(0);
    }
    to {
      transform: translateX(-100%);
    }
  }
  @keyframes tandem-rail-float-slide-out-right {
    from {
      transform: translateX(0);
    }
    to {
      transform: translateX(100%);
    }
  }
  /* Reduced motion: no slide either way. The JS retreat path is already gated on
     the in-app reduceMotion setting (it never enters `float-closing`); these
     cover the OS-level query independently as defense in depth. */
  @media (prefers-reduced-motion: reduce) {
    .rail-shell.rail-floating-chrome .rail-full,
    .rail-shell.rail-floating-chrome .rail-float-shadow {
      animation: none;
    }
  }
  :global(body.tandem-reduce-motion) .rail-shell.rail-floating-chrome .rail-full,
  :global(body.tandem-reduce-motion) .rail-shell.rail-floating-chrome .rail-float-shadow {
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

  .editor-column-wrap {
    /* Wraps `.editor-scroll` so the floating find bar (its sibling) anchors to
       the editor column's bounds and floats above the scrolling document rather
       than scrolling with it. Takes the flex slot `.editor-scroll` held in the
       editor row; the scroll element fills it. As an *ancestor* of
       `.editor-scroll` it doesn't alter the positioned-ancestor chain for the
       margin bubbles (INVARIANT 4 resolves them against `.margin-track`). */
    position: relative;
    flex: 1;
    min-width: 0;
    display: flex;
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
