import { SUPPORTED_EXTENSIONS } from "../../shared/constants.js";
import { resolveDefaultDirectory } from "./default-directory.js";
import { addRecentFile, loadRecentFiles, saveRecentFiles } from "./recentFiles.js";
import { openServerPath } from "./server-paths.js";

const filterExtensions = Array.from(SUPPORTED_EXTENSIONS)
  .sort()
  .map((ext) => ext.replace(/^\./, ""));

/**
 * Open the native OS file picker (Tauri only) and return the chosen absolute
 * path, or `null` if the user cancelled. Throws if the dialog plugin is
 * unavailable — callers handle that.
 */
export async function pickNativeFilePath(): Promise<string | null> {
  const { open } = await import("@tauri-apps/plugin-dialog");
  // Smart default (#1023): start the picker in the user's configured save
  // folder, else the Claude working dir, else home — the same precedence the
  // Save-As dialog uses, so "where my files live" is one notion. `undefined`
  // (no tier resolved) lets the OS pick its own default starting directory.
  const defaultPath = (await resolveDefaultDirectory()) ?? undefined;
  const selected = await open({
    multiple: false,
    directory: false,
    title: "Open file in Tandem",
    defaultPath,
    filters: [{ name: "Documents", extensions: filterExtensions }],
  });
  return typeof selected === "string" ? selected : null;
}

/**
 * Tauri-only: pick a file via the native dialog, open it on the server, and
 * record it in the recent-files list. Errors are surfaced through `onError`
 * (the caller decides how — e.g. a toast) since this runs fire-and-forget from
 * the tab menu / shortcut, with no modal to host inline error text.
 *
 * The try/catch is scoped to `pickNativeFilePath()` because that's the only
 * call that can throw a true "plugin unavailable" failure. `openServerPath`
 * returns `{ok:false}` cleanly; `saveRecentFiles` / `loadRecentFiles` swallow
 * localStorage errors internally. Scoping keeps the "File picker unavailable"
 * label factually accurate.
 */
export async function browseNativeFile(
  opts: { onError?: (message: string) => void } = {},
): Promise<void> {
  let selected: string | null;
  try {
    selected = await pickNativeFilePath();
  } catch (err) {
    console.error("[tandem] native file picker unavailable:", err);
    opts.onError?.(`File picker unavailable: ${err instanceof Error ? err.message : err}`);
    return;
  }
  if (!selected) return;
  const result = await openServerPath(selected);
  if (!result.ok) {
    opts.onError?.(result.error);
    return;
  }
  saveRecentFiles(addRecentFile(loadRecentFiles(), selected));
}

/**
 * Runtime-branching open-file action: Tauri uses the native picker;
 * the browser distribution falls back to a host-supplied modal opener.
 *
 * Extracted from App.svelte so the branch logic is unit-testable without a
 * component mount. The host passes `isTauri` (typically `isTauriRuntime()`)
 * and an `openModal` callback that flips its own modal state.
 */
export async function openFileForRuntime(deps: {
  isTauri: boolean;
  openModal: () => void;
  onError?: (message: string) => void;
}): Promise<void> {
  if (deps.isTauri) {
    await browseNativeFile({ onError: deps.onError });
  } else {
    deps.openModal();
  }
}
