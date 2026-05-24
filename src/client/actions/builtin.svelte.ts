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
  API_LAUNCHER_NONCE,
  API_LAUNCHER_RELAUNCH,
  API_LAUNCHER_START_FRESH,
  API_LAUNCHER_STATUS,
  API_SAVE,
  API_SCRATCHPAD,
} from "../../shared/api-paths.js";
import type { LauncherStatus } from "../../shared/launcher/contract.js";
import { API_BASE } from "../utils/fileUpload.js";
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
  openSettings: () => void;
  /**
   * Open the new SettingsModal (Wave 1 sibling component). Separate from
   * `openSettings`, which targets the legacy SettingsPopover until Wave 2
   * retires it.
   */
  openSettingsModal: () => void;
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
  /**
   * Save the active document under a new file path. Used to promote an
   * ephemeral scratchpad (or any `upload://`-backed doc) into a real file.
   * Resolves once the save attempt completes (success or failure) so action
   * runners can chain notifications.
   */
  saveAs: () => Promise<void>;
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
export const saveStore = {
  get saving() {
    return saving;
  },
};
let inflight = false;

let scratchpadInflight = false;

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
export async function triggerSaveAs(opts: SaveAsOptions): Promise<void> {
  if (saveAsInflight) return;
  const { activeDocId, notify, defaultName, sourceFormat } = opts;
  if (!activeDocId) {
    notify("warning", "No active document to save.");
    return;
  }
  saveAsInflight = true;
  try {
    if (isTauriRuntime()) {
      await runTauriSaveAs(activeDocId, notify, defaultName ?? "Scratchpad.md");
    } else {
      await runBrowserSaveAs(activeDocId, notify, sourceFormat);
    }
  } finally {
    saveAsInflight = false;
  }
}

async function runTauriSaveAs(
  activeDocId: string,
  notify: SaveAsOptions["notify"],
  defaultName: string,
): Promise<void> {
  let selected: string | null;
  try {
    const { save } = await import("@tauri-apps/plugin-dialog");
    selected = await save({
      defaultPath: defaultName,
      filters: [
        { name: "Markdown", extensions: ["md"] },
        { name: "Plain Text", extensions: ["txt"] },
      ],
    });
  } catch (err) {
    notify("error", `Save As dialog unavailable: ${err instanceof Error ? err.message : err}`);
    return;
  }
  if (typeof selected !== "string" || selected.length === 0) return; // user cancelled

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
      return;
    }
    const json = (await res.json().catch(() => null)) as { data?: { fileName?: string } } | null;
    const fileName = json?.data?.fileName ?? normalizedPath;
    notify("info", `Saved to ${fileName}.`);
  } catch (err) {
    notify("error", `Save As request failed: ${err instanceof Error ? err.message : err}`);
  }
}

async function runBrowserSaveAs(
  activeDocId: string,
  notify: SaveAsOptions["notify"],
  sourceFormat?: string,
): Promise<void> {
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
      return;
    }
    const json = (await res.json().catch(() => null)) as {
      data?: { content?: string; fileName?: string };
    } | null;
    const content = json?.data?.content;
    const fileName = json?.data?.fileName ?? `Scratchpad.${format}`;
    if (typeof content !== "string") {
      notify("error", "Save As returned no content.");
      return;
    }
    downloadBlob(content, fileName, format === "md" ? "text/markdown" : "text/plain");
    notify("info", "Downloaded; scratchpad remains in-session.");
  } catch (err) {
    notify("error", `Save As request failed: ${err instanceof Error ? err.message : err}`);
  }
}

export async function triggerSave(activeDocId: string | null): Promise<void> {
  if (!activeDocId || inflight) return;
  inflight = true;
  saving = true;
  try {
    const resp = await fetch(`${API_BASE}${API_SAVE}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ documentId: activeDocId }),
    });
    if (!resp.ok) {
      const body = await resp.json().catch(() => ({}));
      console.warn(
        "[Tandem] Save failed:",
        (body as Record<string, string>).message ?? resp.statusText,
      );
    }
  } catch (err) {
    console.warn("[Tandem] Save request failed:", err);
  } finally {
    inflight = false;
    saving = false;
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
      d.notify("warning", "Claude launcher not active in this Tandem build.");
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
    d.notify("warning", "Claude launcher not active in this Tandem build.");
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
      "Active document isn't saved to a folder. Set a working directory in Settings → Claude Code.",
    );
    return;
  }
  if (!confirm(`Restart Claude in:\n${cwd}\n\nYour current task may be interrupted.`)) return;
  launcherInflight = true;
  try {
    await postLauncherMutation(
      d,
      API_LAUNCHER_RELAUNCH,
      { cwd },
      {
        failPrefix: "Relaunch failed",
        requestFailPrefix: "Relaunch request failed",
        successMessage: `Claude restarting in ${cwd}.`,
      },
    );
  } finally {
    launcherInflight = false;
  }
}

async function startFreshConversation(d: ActionDeps): Promise<void> {
  if (!(await checkLauncherAvailable(d))) return;
  if (!confirm("Drop Claude's saved conversation and restart fresh. This cannot be undone.")) {
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
        successMessage: "Claude restarting with a fresh conversation.",
      },
    );
  } finally {
    launcherInflight = false;
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
      guardedRun("save", (d) => void triggerSave(d.getActiveTabId()));
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
    id: "settings-modal",
    label: "Open settings (new)",
    group: "view",
    shortcut: "Ctrl+Shift+,",
    run() {
      guardedRun("settings-modal", (d) => d.openSettingsModal());
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
    id: "launcher-relaunch-here",
    label: "Relaunch Claude in this folder",
    group: "claude",
    run() {
      guardedRun("launcher-relaunch-here", (d) => void relaunchHere(d));
    },
  },
  {
    id: "launcher-start-fresh",
    label: "Start fresh Claude conversation",
    group: "claude",
    run() {
      guardedRun("launcher-start-fresh", (d) => void startFreshConversation(d));
    },
  },
];

for (const action of BUILTINS) {
  registerAction(action);
}
