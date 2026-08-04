/**
 * Built-in action registrations for the command palette.
 *
 * Action shapes are registered at module import time so the Shortcuts settings
 * tab has a non-empty list on first paint. The `run()` functions reference
 * lazily-resolved dependency getters; if a getter hasn't been wired yet (App
 * hasn't mounted) the action logs a warning and no-ops rather than crashing.
 *
 * Wire the getters by calling wireActionDeps() from App.svelte after mount.
 */

import {
  API_BACKUPS,
  API_BACKUPS_RESTORE,
  API_LAUNCHER_NONCE,
  API_LAUNCHER_RELAUNCH,
  API_LAUNCHER_START_FRESH,
  API_LAUNCHER_STATUS,
  API_SAVE,
  API_SCRATCHPAD,
} from "../../shared/api-paths.js";
import { isTransientlyUnavailable, type LauncherStatus } from "../../shared/launcher/contract.js";
import { resolveDefaultDirectory } from "../utils/default-directory.js";
import { API_BASE } from "../utils/fileUpload.js";
import { addRecentFile, loadRecentFiles, saveRecentFiles } from "../utils/recentFiles.js";
import { type Action, registerAction } from "./registry.svelte.js";

// ---------------------------------------------------------------------------
// Dependency injection — App.svelte calls wireActionDeps on mount
// ---------------------------------------------------------------------------

interface ActionDeps {
  getActiveTabId: () => string | null;
  /** Absolute filesystem path of the active doc, or null for upload://,
   * scratchpads, or app-internal docs. Launcher palette actions use this
   * to derive a cwd for `/relaunch-here`. */
  getActiveDocumentPath: () => string | null;
  /** Push a transient toast notification (info/warning/error). */
  notify: (severity: "info" | "warning" | "error", message: string) => void;
  /** Open the Settings modal (the single consolidated settings surface). */
  openSettings: () => void;
  toggleSoloMode: () => void;
  openFindBar: () => void;
  openFindBarTabs: () => void;
  findNext: () => void;
  findPrev: () => void;
  closeActiveTab: () => void;
  openFileDialog: () => void;
  toggleLeftPanel: () => void;
  toggleRightPanel: () => void;
  reopenClosedTab: () => void;
  annotationNext: () => void;
  annotationPrev: () => void;
  annotationAccept: () => void;
  annotationDismiss: () => void;
  selectBlock: () => void;
  toggleAuthorship: () => void;
  toggleFormattingBar: () => void;
  /**
   * Toggle the raw-markdown source view for the active document (#1021). A
   * no-op when the active doc isn't an editable .md (the App-level handler
   * guards on format + read-only).
   */
  toggleSourceView: () => void;
  /** Reveal Chat and focus its composer. */
  focusChat: () => void;
  /**
   * Save the active document under a new file path. Used to promote an
   * ephemeral scratchpad (or any `upload://`-backed doc) into a real file.
   * Resolves once the save attempt completes (success or failure) so action
   * runners can chain notifications.
   */
  saveAs: () => Promise<void>;
  /** Save the active target, promoting upload-backed documents through Save As. */
  save: () => Promise<void>;
}

let deps: ActionDeps | null = null;

export function wireActionDeps(d: ActionDeps): void {
  deps = d;
}

function guardedRun(id: string, fn: (d: ActionDeps) => void | Promise<void>) {
  if (!deps) {
    console.warn(`[actions] "${id}" invoked before App mounted — deps not wired yet`);
    return;
  }
  fn(deps);
}

// ---------------------------------------------------------------------------
// Save — mirrors useSaveShortcut.svelte.ts logic
// ---------------------------------------------------------------------------

let saving = $state(false);
// Set right before `saving` flips back to false in `triggerSave`'s `finally`,
// so a falling-edge "Saved" flash (StatusBar.svelte) can tell a completed save
// apart from a failed one instead of firing on every path alike.
let lastSaveOk = $state(false);
export const saveStore = {
  get saving() {
    return saving;
  },
  get lastSaveOk() {
    return lastSaveOk;
  },
};
let inflight = false;

let scratchpadInflight = false;

/**
 * Debounce (ms) before auto-opening a scratchpad once the empty state is
 * reached. The window absorbs three transients that must NOT trigger an
 * auto-open:
 *   1. Initial connect — `connected` flips true before the server's
 *      `openDocuments` list has synced, so `tabs` is briefly empty. The
 *      startup doc (welcome.md / CHANGELOG.md) arrives within this window.
 *   2. Y.Doc swap (reload-from-disk) — `activeTab` is momentarily null while
 *      the tab entry is replaced.
 *   3. Tab-switch churn during reconcile.
 * It must comfortably exceed the time for the bootstrap `openDocuments`
 * broadcast to land after `connected` flips.
 */
export const SCRATCHPAD_EMPTY_STATE_DEBOUNCE_MS = 400;

/**
 * Pure gate for the App-level auto-open-scratchpad effect (#842). Returns true
 * only when the user has genuinely reached the empty tab-bar state with a live
 * server connection — never during the disconnect-debounce window (which fails
 * the `connected` check) and never with a doc still open.
 *
 * Extracted as a pure function so the precedence/timing logic is unit-testable
 * without standing up a Svelte component or a Hocuspocus provider.
 */
export function shouldAutoOpenScratchpad(state: {
  connected: boolean;
  tabCount: number;
  activeTabId: string | null;
}): boolean {
  return state.connected && state.tabCount === 0 && state.activeTabId === null;
}

export async function createScratchpad(): Promise<void> {
  if (scratchpadInflight) return;
  scratchpadInflight = true;
  try {
    const res = await fetch(`${API_BASE}${API_SCRATCHPAD}`, { method: "POST" });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      console.warn(
        "[Tandem] New Scratchpad failed:",
        (body as Record<string, string>).message ?? res.statusText,
      );
    }
  } catch (err) {
    console.warn("[Tandem] New Scratchpad request failed:", err);
  } finally {
    scratchpadInflight = false;
  }
}

/**
 * Detect whether the page is running inside the Tauri WebView. Re-implemented
 * here (rather than imported from `cowork/cowork-helpers`) so this module
 * stays free of UI-tree dependencies — registering builtins at import time
 * must not pull in Svelte component code.
 */
function isTauriRuntime(): boolean {
  try {
    return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
  } catch {
    return false;
  }
}

/** Allowed save-as formats. Mirrors the server-side guard in
 * `document-service.ts#saveDocumentAsToDisk`. */
type SaveAsFormat = "md" | "txt";

let saveAsInflight = false;

/**
 * Resolve the full `defaultPath` (dir + filename) for the Save-As dialog using
 * the shared smart-default directory precedence (configured save folder →
 * Claude working dir → OS home; see `utils/default-directory.ts`). Falls back to
 * the bare filename (OS-default dir) if no tier resolves or the path module is
 * unavailable.
 */
async function resolveSaveAsDefaultPath(fileName: string): Promise<string> {
  const dir = await resolveDefaultDirectory();
  if (!dir) return fileName;
  try {
    const { join } = await import("@tauri-apps/api/path");
    return await join(dir, fileName);
  } catch {
    return fileName;
  }
}

/** Normalize a Tauri-dialog-returned path to the chosen format extension.
 *  Examples: ("notes.md", "md") → "notes.md"; ("notes", "md") → "notes.md";
 *  ("notes.rtf", "md") → "notes.md" (extension overridden to the chosen format
 *  so the on-disk file matches the user's format pick). */
export function normalizeSaveAsExtension(targetPath: string, format: SaveAsFormat): string {
  const expectedExt = `.${format}`;
  // No extension at all (or the trailing segment starts with no dot at all)
  // → append the expected one.
  const lastSlash = Math.max(targetPath.lastIndexOf("/"), targetPath.lastIndexOf("\\"));
  const basename = targetPath.slice(lastSlash + 1);
  if (!basename.includes(".")) return `${targetPath}${expectedExt}`;
  const ext = targetPath.slice(targetPath.lastIndexOf(".")).toLowerCase();
  if (ext === expectedExt) return targetPath;
  // Trailing extension exists but doesn't match — strip and replace.
  const stem = targetPath.slice(0, targetPath.lastIndexOf("."));
  return `${stem}${expectedExt}`;
}

/** Trigger an anchor-based download for the given bytes. Browser save-as
 *  fallback — exported for unit-test stubbing of the anchor click path. */
export function downloadBlob(content: string, fileName: string, mime: string): void {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = fileName;
  // Some browsers require the anchor to be in the DOM before .click() fires.
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  // Release the object URL after a tick to let the download stream attach.
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

interface SaveAsOptions {
  activeDocId: string | null;
  notify: (severity: "info" | "warning" | "error", message: string) => void;
  /** Hint for the native dialog's default filename. Falls back to "Scratchpad.md". */
  defaultName?: string;
  /** The active doc's current format. Used by the browser download fallback to
   *  preserve the doc's format (e.g. a .txt-backed scratchpad downloads as .txt,
   *  not re-formatted to markdown). Non-md/txt formats fall back to "md". */
  sourceFormat?: string;
}

/**
 * Save-as orchestrator. Tauri runtime opens the native save dialog and POSTs
 * `{ targetPath, format }` to `/api/save`; browser runtime POSTs
 * `{ serialize: true, format }` and triggers an anchor download with the
 * returned bytes.
 *
 * Exported so App.svelte's `wireActionDeps({ saveAs })` can bind it. The
 * inflight flag is module-scoped so the palette action and the Ctrl+Shift+S
 * keybinding cannot race.
 */
export async function triggerSaveAs(opts: SaveAsOptions): Promise<boolean> {
  if (saveAsInflight) return false;
  const { activeDocId, notify, defaultName, sourceFormat } = opts;
  if (!activeDocId) {
    notify("warning", "No active document to save.");
    return false;
  }
  saveAsInflight = true;
  try {
    if (isTauriRuntime()) {
      return await runTauriSaveAs(activeDocId, notify, defaultName ?? "Scratchpad.md");
    } else {
      return await runBrowserSaveAs(activeDocId, notify, sourceFormat);
    }
  } finally {
    saveAsInflight = false;
  }
}

async function runTauriSaveAs(
  activeDocId: string,
  notify: SaveAsOptions["notify"],
  defaultName: string,
): Promise<boolean> {
  let selected: string | null;
  try {
    const { save } = await import("@tauri-apps/plugin-dialog");
    // Smart default (#1023): open the dialog in the user's configured save
    // folder, else the Claude working dir, else home — falling back to a bare
    // filename (OS-default dir) when none resolve.
    const defaultPath = await resolveSaveAsDefaultPath(defaultName);
    selected = await save({
      defaultPath,
      filters: [
        { name: "Markdown", extensions: ["md"] },
        { name: "Plain Text", extensions: ["txt"] },
      ],
    });
  } catch (err) {
    notify("error", `Save As dialog unavailable: ${err instanceof Error ? err.message : err}`);
    return false;
  }
  if (typeof selected !== "string" || selected.length === 0) return false; // user cancelled

  // Determine format from the chosen extension; default to .md when the user
  // typed a non-supported extension (or none) — and normalize the path so the
  // on-disk file ends with the expected ext.
  const lower = selected.toLowerCase();
  const format: SaveAsFormat = lower.endsWith(".txt") ? "txt" : "md";
  const normalizedPath = normalizeSaveAsExtension(selected, format);
  if (normalizedPath !== selected) {
    notify("info", `Saving as ${format.toUpperCase()} — only .md and .txt are supported.`);
  }

  try {
    const res = await fetch(`${API_BASE}${API_SAVE}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        documentId: activeDocId,
        targetPath: normalizedPath,
        format,
      }),
    });
    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as { message?: string };
      notify("error", `Save As failed: ${body.message ?? res.statusText}`);
      return false;
    }
    const json = (await res.json().catch(() => null)) as {
      data?: {
        status?: "saved" | "error";
        fileName?: string;
        targetPath?: string;
        reason?: string;
      };
    } | null;
    if (json?.data?.status !== "saved") {
      notify(
        "error",
        `Save As failed: ${json?.data?.reason ?? "the server returned an invalid result."}`,
      );
      return false;
    }
    const fileName = json?.data?.fileName ?? normalizedPath;
    // Register the promoted file in recents so it surfaces in the New Tab
    // launcher (issue #1019). Use the server's resolved `targetPath` so the
    // stored string matches the path the openDocuments broadcast records —
    // otherwise the recents-sync effect in App.svelte would later add a second,
    // slightly-different entry for the same file. Falling back to the local
    // normalizedPath keeps registration working if the server omits targetPath.
    // Registration here is deterministic (it fires the instant the server
    // confirms the write) rather than relying on the broadcast→reconcile→effect
    // round-trip, which can miss if the tab is closed before it completes.
    const promotedPath = json?.data?.targetPath ?? normalizedPath;
    saveRecentFiles(addRecentFile(loadRecentFiles(), promotedPath));
    notify("info", `Saved to ${fileName}.`);
    return true;
  } catch (err) {
    notify("error", `Save As request failed: ${err instanceof Error ? err.message : err}`);
    return false;
  }
}

async function runBrowserSaveAs(
  activeDocId: string,
  notify: SaveAsOptions["notify"],
  sourceFormat?: string,
): Promise<boolean> {
  // Browser distribution can't write to arbitrary paths — fall back to a
  // Blob + anchor download. Preserve the doc's current format so a .txt-backed
  // doc isn't re-formatted to markdown; anything outside the md/txt allowlist
  // falls back to .md. User can rename after download.
  const format: SaveAsFormat = sourceFormat === "txt" ? "txt" : "md";
  try {
    const res = await fetch(`${API_BASE}${API_SAVE}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ documentId: activeDocId, serialize: true, format }),
    });
    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as { message?: string };
      notify("error", `Save As failed: ${body.message ?? res.statusText}`);
      return false;
    }
    const json = (await res.json().catch(() => null)) as {
      data?: { content?: string; fileName?: string };
    } | null;
    const content = json?.data?.content;
    const fileName = json?.data?.fileName ?? `Scratchpad.${format}`;
    if (typeof content !== "string") {
      notify("error", "Save As returned no content.");
      return false;
    }
    downloadBlob(content, fileName, format === "md" ? "text/markdown" : "text/plain");
    notify("info", "Downloaded; scratchpad remains in-session.");
    return true;
  } catch (err) {
    notify("error", `Save As request failed: ${err instanceof Error ? err.message : err}`);
    return false;
  }
}

export async function triggerSave(activeDocId: string | null): Promise<boolean> {
  if (!activeDocId || inflight) return false;
  inflight = true;
  saving = true;
  let ok = false;
  try {
    const resp = await fetch(`${API_BASE}${API_SAVE}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ documentId: activeDocId }),
    });
    if (!resp.ok) {
      const body = await resp.json().catch(() => ({}));
      const message = (body as Record<string, string>).message ?? resp.statusText;
      console.warn("[Tandem] Save failed:", message);
      deps?.notify("error", `Save failed: ${message}`);
    } else {
      // Surface export-fidelity downgrades (#1145, 0c). The server already
      // returns these on a .docx save (SaveResult.fidelityWarnings) but the
      // success body was previously dropped here. The persistent fidelity
      // notice carries the specifics; this is the immediate "it happened" nudge.
      // `deps?.` guards the pre-mount window (deps is wired in App.onMount).
      const json = (await resp.json().catch(() => null)) as {
        data?: {
          status?: "saved" | "skipped" | "error";
          reason?: string;
          skipCode?: string;
          fidelityWarnings?: string[];
          integrityWarnings?: string[];
          unpreservedImports?: number;
        };
      } | null;
      // A skipped or failed save is HTTP 200, so `resp.ok` alone would fire StatusBar's
      // "Saved HH:MM" flash on a save that never happened. With an external
      // conflict pending that flash sits on screen next to a banner saying the
      // opposite — and via the activity-tray retry action it can fire for a
      // non-active document, where there is no banner at all (#1238).
      //
      const result = json?.data;
      if (result?.status === "skipped") {
        deps?.notify("warning", saveSkippedMessage(result.skipCode, result.reason));
        return false;
      }
      if (result?.status === "error") {
        deps?.notify(
          "error",
          `Save failed: ${result.reason ?? "The document could not be saved."}`,
        );
        return false;
      }
      if (result?.status !== "saved") {
        deps?.notify("error", "Save failed: the server returned an invalid result.");
        return false;
      }
      ok = true;
      // Post-write verification advisory (#1123 0e) — louder + distinct from an
      // announced downgrade: the save may have lost content UNEXPECTEDLY. Point
      // at the restore on-ramp; the persistent notice carries the specifics.
      // Deliberately NOT folded into the "N features simplified" line below.
      const integrity = json?.data?.integrityWarnings?.length ?? 0;
      if (integrity > 0) {
        deps?.notify(
          "error",
          'Saved, but some content may not have been preserved — your original is backed up. See the document notice, or run "Restore a backup of this document…" from the command palette.',
        );
      }
      // Two distinct facts, ONE toast (#1142 G3). A third toast would fire on
      // almost every .docx save — nearly any real Word file has an unrecognized
      // style — and a three-toast stack trains people to dismiss it unread,
      // destroying the signal G3 exists to send.
      //
      // Deliberately NO number on the unpreserved-imports half: it counts
      // fidelity-report LINES (feature categories), and that list is capped, so
      // "N Word features" would be a falsifiable claim on the one surface built
      // for honesty. The persistent notice carries the real counts.
      //
      // It repeats on every save, and the reason is NOT "the loss is re-incurred"
      // — after the first save the file on disk already lacks those features.
      // It repeats because the comparison is against the BACKED-UP ORIGINAL,
      // which is still the thing the user can get back.
      const downgraded = json?.data?.fidelityWarnings?.length ?? 0;
      const unpreserved = json?.data?.unpreservedImports ?? 0;
      if (downgraded > 0 && unpreserved > 0) {
        deps?.notify(
          "warning",
          `Saved — ${downgraded} Word feature${downgraded === 1 ? " was" : "s were"} simplified on export, and the backed-up original has features this file doesn't. See the document notice for details.`,
        );
      } else if (downgraded > 0) {
        deps?.notify(
          "warning",
          `Saved — ${downgraded} Word feature${downgraded === 1 ? " was" : "s were"} simplified on export; see the document notice for details.`,
        );
      } else if (unpreserved > 0) {
        deps?.notify(
          "warning",
          "Saved — the backed-up original has Word features this file doesn't. Your original can still be restored; see the document notice for details.",
        );
      }
    }
  } catch (err) {
    console.warn("[Tandem] Save request failed:", err);
    deps?.notify("error", "Save failed — check your connection and try again.");
  } finally {
    inflight = false;
    lastSaveOk = ok;
    saving = false;
  }
  return ok;
}

/** User-facing copy for every structured save skip. The fallback remains
 * honest for older servers that have not yet added a skip code. */
export function saveSkippedMessage(skipCode?: string, reason?: string): string {
  switch (skipCode) {
    case "EXTERNAL_CONFLICT":
    case "FILE_MODIFIED":
      return "Not saved — this file changed on disk. Choose Keep or Reload before saving.";
    case "PROMOTION_REQUIRED":
      return "Not saved — choose Save As to turn this upload or scratchpad into a file.";
    case "READ_ONLY":
      return "Not saved — this document is read-only.";
    case "UNSUPPORTED_FORMAT":
    case "ADAPTER_UNAVAILABLE":
      return "Not saved — this document format cannot be written to disk.";
    case "SAVE_IN_PROGRESS":
      return "Not saved — another save is already in progress. Try again in a moment.";
    case "SOURCE_MISSING":
      return "Not saved — the original file no longer exists. Reopen it or use Save As.";
    case "FILE_STATE_UNAVAILABLE":
      return "Not saved — Tandem could not verify the file state. Check access and try again.";
    case "NOT_OPEN":
      return "Not saved — the document is no longer open.";
    case "EXPLICIT_ONLY":
      return "Not saved automatically — use Save to write this document format.";
    default:
      return `Not saved${reason ? ` — ${reason}.` : "."}`;
  }
}

// ---------------------------------------------------------------------------
// Claude launcher — /relaunch-here + start-fresh (#477 PR 4b)
// ---------------------------------------------------------------------------

let launcherInflight = false;

type FetchResult<T> =
  | { ok: true; value: T }
  | { ok: false; kind: "not-built" | "network" | "server-error"; detail?: string };

async function fetchLauncherStatus(): Promise<FetchResult<LauncherStatus>> {
  let res: Response;
  try {
    res = await fetch(`${API_BASE}${API_LAUNCHER_STATUS}`);
  } catch (err) {
    return { ok: false, kind: "network", detail: err instanceof Error ? err.message : String(err) };
  }
  if (res.status === 404) return { ok: false, kind: "not-built" };
  if (!res.ok) return { ok: false, kind: "server-error", detail: `HTTP ${res.status}` };
  return { ok: true, value: (await res.json()) as LauncherStatus };
}

async function fetchLauncherNonce(): Promise<FetchResult<string>> {
  let res: Response;
  try {
    res = await fetch(`${API_BASE}${API_LAUNCHER_NONCE}`, { method: "GET" });
  } catch (err) {
    return { ok: false, kind: "network", detail: err instanceof Error ? err.message : String(err) };
  }
  if (res.status === 404) return { ok: false, kind: "not-built" };
  if (!res.ok) return { ok: false, kind: "server-error", detail: `HTTP ${res.status}` };
  const body = (await res.json()) as { nonce?: unknown };
  if (typeof body.nonce !== "string") {
    return { ok: false, kind: "server-error", detail: "malformed nonce response" };
  }
  return { ok: true, value: body.nonce };
}

function deriveCwdFromDocPath(docPath: string | null): string | null {
  if (!docPath) return null;
  // Reject upload:// and other non-filesystem URIs before they reach the API.
  if (/^[a-z]+:\/\//.test(docPath)) return null;
  // path.dirname equivalent that handles both separators.
  const lastSlash = Math.max(docPath.lastIndexOf("/"), docPath.lastIndexOf("\\"));
  return lastSlash > 0 ? docPath.slice(0, lastSlash) : null;
}

/** Convergent tail for both launcher palette actions: acquire a nonce,
 * POST to the endpoint, notify on success/failure. Diverges on the
 * preflight (status check, cwd derivation, confirm prompt) — that lives
 * in each caller. The `extraBody` carries action-specific fields (cwd
 * for relaunch; nothing for start-fresh). */
async function postLauncherMutation(
  d: ActionDeps,
  endpoint: string,
  extraBody: Record<string, unknown>,
  labels: { failPrefix: string; requestFailPrefix: string; successMessage: string },
): Promise<void> {
  const nonceResult = await fetchLauncherNonce();
  if (!nonceResult.ok) {
    d.notify(
      "error",
      `Failed to acquire launcher nonce: ${nonceResult.kind}${nonceResult.detail ? ` (${nonceResult.detail})` : ""}.`,
    );
    return;
  }
  const nonce = nonceResult.value;
  try {
    const res = await fetch(`${API_BASE}${endpoint}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...extraBody, nonce }),
    });
    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as { message?: string };
      d.notify("error", `${labels.failPrefix}: ${body.message ?? res.statusText}`);
      return;
    }
    d.notify("info", labels.successMessage);
  } catch (err) {
    d.notify("error", `${labels.requestFailPrefix}: ${err instanceof Error ? err.message : err}`);
  }
}

/** Guards that both palette actions share: in-flight check + availability
 * probe. Returns true when the caller should proceed, false when it
 * should bail (caller need not notify — guards notify when appropriate). */
async function checkLauncherAvailable(d: ActionDeps): Promise<boolean> {
  if (launcherInflight) return false;
  const result = await fetchLauncherStatus();
  if (!result.ok) {
    if (result.kind === "not-built") {
      d.notify("warning", "Assistant launcher not active in this Tandem build.");
    } else if (result.kind === "network") {
      d.notify("error", `Cannot reach Tandem server${result.detail ? `: ${result.detail}` : ""}.`);
    } else {
      d.notify(
        "error",
        `Launcher status check failed${result.detail ? `: ${result.detail}` : ""}.`,
      );
    }
    return false;
  }
  const status = result.value;
  if (!status.available) {
    // #1236: "not active in this Tandem build" is a lie in the deferred case —
    // the launcher is present and about to start, it just hasn't seen a human
    // yet. Showing the window is what releases it, and the user is by
    // definition looking at the window to have run this command.
    if (isTransientlyUnavailable(status.reason)) {
      d.notify("info", "Your assistant is starting up — try again in a moment.");
      return false;
    }
    d.notify("warning", "Assistant launcher not active in this Tandem build.");
    return false;
  }
  // Side-channel: surface bundled-skill refresh failures to the user. The
  // server only includes `skillRefresh` on loopback, and the field is
  // optional on the discriminated-union so absence is the success case.
  if ("skillRefresh" in status && status.skillRefresh) {
    d.notify(
      "warning",
      `Bundled skill refresh failed: ${status.skillRefresh.message}. Run \`tandem setup\` to retry.`,
    );
  }
  return true;
}

async function relaunchHere(d: ActionDeps): Promise<void> {
  if (!(await checkLauncherAvailable(d))) return;
  const cwd = deriveCwdFromDocPath(d.getActiveDocumentPath());
  if (!cwd) {
    d.notify(
      "warning",
      "Active document isn't saved to a folder. Set a working directory in Settings → AI Assistants.",
    );
    return;
  }
  if (
    !confirm(`Restart the managed assistant in:\n${cwd}\n\nYour current task may be interrupted.`)
  )
    return;
  launcherInflight = true;
  try {
    await postLauncherMutation(
      d,
      API_LAUNCHER_RELAUNCH,
      { cwd },
      {
        failPrefix: "Relaunch failed",
        requestFailPrefix: "Relaunch request failed",
        successMessage: `Assistant restarting in ${cwd}.`,
      },
    );
  } finally {
    launcherInflight = false;
  }
}

/**
 * Restart the supervised Claude Code process (#1018/#1022). Thin re-entry to
 * the existing `launcher-relaunch-here` palette action so the AI-readiness
 * "Restart Claude Code" chip and the palette command share one code path
 * (cwd derivation + confirm + nonce + notify). Used when launcher status is
 * `available: true, running: false` (configured but crashed/stopped).
 */
export function relaunchClaudeCode(): void {
  guardedRun("launcher-relaunch-here", (d) => void relaunchHere(d));
}

export function startFreshClaudeCode(): void {
  guardedRun("launcher-start-fresh", (d) => void startFreshConversation(d));
}

async function startFreshConversation(d: ActionDeps): Promise<void> {
  if (!(await checkLauncherAvailable(d))) return;
  if (!confirm("Drop the saved assistant conversation and restart fresh. This cannot be undone.")) {
    return;
  }
  launcherInflight = true;
  try {
    await postLauncherMutation(
      d,
      API_LAUNCHER_START_FRESH,
      {},
      {
        failPrefix: "Start fresh failed",
        requestFailPrefix: "Start-fresh request failed",
        successMessage: "Assistant restarting with a fresh conversation.",
      },
    );
  } finally {
    launcherInflight = false;
  }
}

// ---------------------------------------------------------------------------
// Restore a backup of the active document (#1086)
// ---------------------------------------------------------------------------

interface BackupSnapshot {
  name: string;
  timestamp: string;
  size: number;
}

let restoreBackupInflight = false;

function formatBackupTimestamp(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString();
}

/**
 * Minimal restore flow: list the document's snapshots (max 3, newest first),
 * confirm, and restore the MOST RECENT one. The command palette has no
 * dynamic-sublist support, so older snapshots are surfaced in the confirm text
 * and restorable via Claude (`tandem_restoreBackup`) — the MCP tool is the
 * primary surface (ADR-038); this action is the discoverable on-ramp.
 */
async function restoreBackupOfActiveDoc(d: ActionDeps): Promise<void> {
  if (restoreBackupInflight) return;
  const activeDocId = d.getActiveTabId();
  if (!activeDocId) {
    d.notify("warning", "No active document.");
    return;
  }
  restoreBackupInflight = true;
  try {
    const listRes = await fetch(
      `${API_BASE}${API_BACKUPS}?documentId=${encodeURIComponent(activeDocId)}`,
    );
    if (!listRes.ok) {
      const body = (await listRes.json().catch(() => ({}))) as { message?: string };
      d.notify("error", `Couldn't list backups: ${body.message ?? listRes.statusText}`);
      return;
    }
    const listJson = (await listRes.json().catch(() => null)) as {
      data?: { backups?: BackupSnapshot[] };
    } | null;
    const backups = listJson?.data?.backups ?? [];
    if (backups.length === 0) {
      d.notify(
        "info",
        "No backups exist for this document yet. Tandem snapshots the on-disk file before its first overwrite each session.",
      );
      return;
    }
    const newest = backups[0];
    const lines = backups
      .map((b, i) => `  ${i + 1}. ${formatBackupTimestamp(b.timestamp)}`)
      .join("\n");
    const ok = confirm(
      `Available backups (newest first):\n${lines}\n\n` +
        `Restore the most recent backup (${formatBackupTimestamp(newest.timestamp)})? ` +
        "The document reloads with the backup's content; annotations are preserved.\n\n" +
        "Older backups can be restored by asking Claude (tandem_restoreBackup).",
    );
    if (!ok) return;
    const restoreRes = await fetch(`${API_BASE}${API_BACKUPS_RESTORE}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ documentId: activeDocId, backup: newest.name }),
    });
    if (!restoreRes.ok) {
      const body = (await restoreRes.json().catch(() => ({}))) as { message?: string };
      d.notify("error", `Restore failed: ${body.message ?? restoreRes.statusText}`);
      return;
    }
    d.notify("info", `Restored backup from ${formatBackupTimestamp(newest.timestamp)}.`);
  } catch (err) {
    d.notify("error", `Restore request failed: ${err instanceof Error ? err.message : err}`);
  } finally {
    restoreBackupInflight = false;
  }
}

// ---------------------------------------------------------------------------
// Show in file explorer — reveal the active doc in the OS file manager (#299)
// ---------------------------------------------------------------------------

/**
 * Reveal the active document in the OS file manager via the native
 * `show_in_file_manager` Tauri command. Disabled (notifies) when the active
 * doc has no on-disk path — scratchpads, `upload://` docs, and app-internal
 * docs all return `null` from `getActiveDocumentPath()`. The action is only
 * *registered* in the Tauri runtime (see BUILTINS spread), so this never runs
 * in browser mode; the import below is a defensive fallback.
 */
async function showInFileManager(d: ActionDeps): Promise<void> {
  const path = d.getActiveDocumentPath();
  if (!path) {
    d.notify("warning", "This document isn't saved to a file yet.");
    return;
  }
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    await invoke("show_in_file_manager", { path });
  } catch (err) {
    d.notify(
      "error",
      `Couldn't reveal in file manager: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

// ---------------------------------------------------------------------------
// Register all builtins at module top-level
// ---------------------------------------------------------------------------

const BUILTINS: Action[] = [
  {
    id: "save",
    label: "Save document",
    group: "document",
    shortcut: "Ctrl+S",
    run() {
      guardedRun("save", (d) => void d.save());
    },
  },
  {
    id: "settings",
    label: "Open settings",
    group: "view",
    shortcut: "Ctrl+,",
    run() {
      guardedRun("settings", (d) => d.openSettings());
    },
  },
  {
    id: "toggle-mode",
    label: "Toggle Solo / Tandem mode",
    group: "document",
    shortcut: "Ctrl+Shift+M",
    run() {
      guardedRun("toggle-mode", (d) => d.toggleSoloMode());
    },
  },
  {
    id: "new-scratchpad",
    label: "New Scratchpad",
    group: "document",
    shortcut: "Ctrl+N",
    run() {
      void createScratchpad();
    },
  },
  {
    id: "save-as",
    label: "Save As…",
    group: "document",
    shortcut: "Ctrl+Shift+S",
    run() {
      guardedRun("save-as", (d) => void d.saveAs());
    },
  },
  {
    id: "focus-chat",
    label: "Focus Chat",
    group: "view",
    shortcut: "Ctrl+Shift+J",
    run() {
      guardedRun("focus-chat", (d) => d.focusChat());
    },
  },
  {
    id: "close-tab",
    label: "Close active tab",
    group: "document",
    shortcut: "Ctrl+W",
    run() {
      guardedRun("close-tab", (d) => d.closeActiveTab());
    },
  },
  {
    id: "open-file",
    label: "Open file…",
    group: "document",
    shortcut: "Ctrl+O",
    run() {
      guardedRun("open-file", (d) => d.openFileDialog());
    },
  },
  {
    id: "find",
    label: "Find / Replace",
    group: "navigation",
    shortcut: "Ctrl+F",
    run() {
      guardedRun("find", (d) => d.openFindBar());
    },
  },
  {
    id: "find-in-tabs",
    label: "Find in open tabs",
    group: "navigation",
    shortcut: "Ctrl+Shift+F",
    run() {
      guardedRun("find-in-tabs", (d) => d.openFindBarTabs());
    },
  },
  {
    id: "find-next",
    label: "Find next match",
    group: "navigation",
    shortcut: "Ctrl+G",
    run() {
      guardedRun("find-next", (d) => d.findNext());
    },
  },
  {
    id: "find-previous",
    label: "Find previous match",
    group: "navigation",
    shortcut: "Ctrl+Shift+G",
    run() {
      guardedRun("find-previous", (d) => d.findPrev());
    },
  },
  {
    id: "toggle-left-panel",
    label: "Toggle left panel",
    group: "view",
    shortcut: "Alt+Shift+Left",
    run() {
      guardedRun("toggle-left-panel", (d) => d.toggleLeftPanel());
    },
  },
  {
    id: "toggle-right-panel",
    label: "Toggle right panel",
    group: "view",
    shortcut: "Alt+Shift+Right",
    run() {
      guardedRun("toggle-right-panel", (d) => d.toggleRightPanel());
    },
  },
  {
    id: "reopen-closed-tab",
    label: "Reopen closed tab (this session)",
    group: "document",
    shortcut: "Ctrl+Alt+T",
    run() {
      guardedRun("reopen-closed-tab", (d) => d.reopenClosedTab());
    },
  },
  {
    id: "annotation-next",
    label: "Next annotation",
    group: "annotations",
    shortcut: "Alt+]",
    run() {
      guardedRun("annotation-next", (d) => d.annotationNext());
    },
  },
  {
    id: "annotation-previous",
    label: "Previous annotation",
    group: "annotations",
    shortcut: "Alt+[",
    run() {
      guardedRun("annotation-previous", (d) => d.annotationPrev());
    },
  },
  {
    id: "annotation-accept",
    label: "Accept focused annotation",
    group: "annotations",
    shortcut: "Ctrl+Enter",
    run() {
      guardedRun("annotation-accept", (d) => d.annotationAccept());
    },
  },
  {
    id: "annotation-dismiss",
    label: "Dismiss focused annotation",
    group: "annotations",
    shortcut: "Ctrl+Shift+Enter",
    run() {
      guardedRun("annotation-dismiss", (d) => d.annotationDismiss());
    },
  },
  // Note: comment-on-selection (Ctrl+Alt+M) is intentionally NOT registered as
  // a palette action — opening the palette collapses the editor selection
  // (focus moves to palette input), so a palette-invoked "comment on selection"
  // would always fire with no selection. Static row in static-shortcuts.ts.
  {
    id: "select-block",
    label: "Select containing block",
    group: "editor",
    shortcut: "Alt+L",
    run() {
      guardedRun("select-block", (d) => d.selectBlock());
    },
  },
  {
    id: "toggle-authorship",
    label: "Toggle authorship colors",
    group: "view",
    shortcut: "Ctrl+Alt+A",
    run() {
      guardedRun("toggle-authorship", (d) => d.toggleAuthorship());
    },
  },
  {
    // Palette-only (no keyboard shortcut): Ctrl+Alt+F is a Linux VT switch, so
    // it's deliberately not bound. Restoring a hidden bar is via this action,
    // the Appearance setting, or the always-full selection popup.
    id: "toggle-formatting-bar",
    label: "Toggle formatting bar",
    group: "view",
    run() {
      guardedRun("toggle-formatting-bar", (d) => d.toggleFormattingBar());
    },
  },
  {
    id: "toggle-source-view",
    label: "View / exit Markdown source",
    group: "view",
    shortcut: "Ctrl+Shift+E",
    run() {
      guardedRun("toggle-source-view", (d) => d.toggleSourceView());
    },
  },
  {
    // Palette-only: discoverable on-ramp to the pre-overwrite document
    // backups (#1086). Restores the most recent snapshot after a confirm.
    id: "restore-backup",
    label: "Restore a backup of this document…",
    group: "document",
    run() {
      guardedRun("restore-backup", (d) => void restoreBackupOfActiveDoc(d));
    },
  },
  {
    id: "launcher-relaunch-here",
    label: "Relaunch assistant in this folder",
    group: "claude",
    run() {
      guardedRun("launcher-relaunch-here", (d) => void relaunchHere(d));
    },
  },
  {
    id: "launcher-start-fresh",
    label: "Start fresh assistant conversation",
    group: "claude",
    run() {
      guardedRun("launcher-start-fresh", (d) => void startFreshConversation(d));
    },
  },
  // Reveal-in-OS-file-manager only makes sense in the desktop app, which can
  // spawn Explorer / Finder / xdg-open. The browser distribution has no such
  // capability, so the action is gated out of the registry entirely there
  // (conditional spread below) rather than shown-and-erroring.
  ...(isTauriRuntime()
    ? [
        {
          id: "show-in-file-explorer",
          label: "Show in file explorer",
          group: "document",
          run() {
            guardedRun("show-in-file-explorer", (d) => void showInFileManager(d));
          },
        } satisfies Action,
      ]
    : []),
];

for (const action of BUILTINS) {
  registerAction(action);
}
