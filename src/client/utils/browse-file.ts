import { SUPPORTED_EXTENSIONS } from "../../shared/constants.js";
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
  const selected = await open({
    multiple: false,
    directory: false,
    title: "Open file in Tandem",
    filters: [{ name: "Documents", extensions: filterExtensions }],
  });
  return typeof selected === "string" ? selected : null;
}

/**
 * Tauri-only: pick a file via the native dialog, open it on the server, and
 * record it in the recent-files list. Errors are surfaced through `onError`
 * (the caller decides how — e.g. a toast) since this runs fire-and-forget from
 * the tab menu / shortcut, with no modal to host inline error text.
 */
export async function browseNativeFile(
  opts: { onError?: (message: string) => void } = {},
): Promise<void> {
  try {
    const selected = await pickNativeFilePath();
    if (!selected) return;
    const result = await openServerPath(selected);
    if (!result.ok) {
      opts.onError?.(result.error);
      return;
    }
    saveRecentFiles(addRecentFile(loadRecentFiles(), selected));
  } catch (err) {
    opts.onError?.(`File picker unavailable: ${err instanceof Error ? err.message : err}`);
  }
}
