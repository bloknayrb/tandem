/**
 * Parse a file path the user typed or pasted into the browser build's Open File
 * dialog (#1895).
 *
 * The server is the authority on everything that matters about the path:
 * whether it exists, whether its extension is openable, and whether it is a
 * refused prefix such as UNC (`assertSafePathPrefix` rejects that before any
 * filesystem call). This helper deliberately duplicates none of that policy. It
 * only refuses a path the server would silently misread: `/api/open` runs
 * `path.resolve`, which resolves a relative path against the SERVER process's
 * working directory and never expands `~`, so `notes.md` or `~/notes.md` would
 * open (or fail to find) some file the user never meant.
 *
 * Kept out of `server-paths.ts` on purpose: `FileOpenDialog.test.ts` mocks that
 * module with a factory exporting only `openServerPath`.
 */
export type TypedPathResult =
  | { ok: true; path: string }
  | { ok: false; reason: "empty" | "relative"; error: string };

const EMPTY_ERROR = "Enter the full path of a file.";
const RELATIVE_ERROR =
  "Enter a full path, such as /Users/you/notes.md or C:\\Users\\you\\notes.md.";

/** POSIX absolute, drive-absolute (`C:\` or `C:/`), or UNC (`\\server\share`). */
const ABSOLUTE_PATH = /^(?:\/|[A-Za-z]:[\\/]|\\\\)/;

/**
 * Strip ONE matching pair of surrounding quotes. Windows Explorer's "Copy as
 * path" wraps in double quotes; a Linux or macOS shell drag-and-drop often wraps
 * a path containing spaces in single quotes. A lone or mismatched quote is kept,
 * so it reaches the server (and its error) rather than being half-repaired here.
 */
function unquote(s: string): string {
  if (s.length >= 2) {
    const first = s[0];
    if ((first === '"' || first === "'") && s.at(-1) === first) return s.slice(1, -1);
  }
  return s;
}

export function parseTypedPath(raw: string): TypedPathResult {
  const path = unquote(raw.trim()).trim();
  if (path === "") return { ok: false, reason: "empty", error: EMPTY_ERROR };
  if (!ABSOLUTE_PATH.test(path)) return { ok: false, reason: "relative", error: RELATIVE_ERROR };
  return { ok: true, path };
}
