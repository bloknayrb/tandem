/**
 * Reject Windows path prefixes that can leak NTLM credentials or bypass UNC
 * filtering. Cross-platform string check (no syscalls) so it's safe to run on
 * every platform — defense-in-depth against a Windows client supplying a
 * crafted path to a Linux/macOS server (the path string still reaches code
 * that may eventually run on Windows via shared state).
 *
 * **This is the canonical copy of this rule**, and it lives in `src/shared/`
 * rather than with the server's file IO because client, CLI and server all need
 * it while `src/client/` must not import from `src/server/`. A hand-rolled
 * `startsWith("\\\\")` elsewhere is a weaker duplicate: it misses the
 * device-namespace forms below. Four such copies survive at the time of writing
 * (`cli/win-path-guard.ts`, `server/file-io/docx-export.ts`, its spike twin, and
 * `server/launcher/supervisor.ts`) — see #1417, which also covers the ordering
 * defect where a filesystem call runs *before* the check.
 *
 * Rejected forms (all case-insensitive):
 *  - `\\?\…`        — Windows extended-length prefix. `\\?\UNC\server\share`
 *                     is a documented bypass of plain `\\` UNC rejection
 *                     because `path.resolve` does NOT normalise it back to
 *                     `\\server\share`.
 *  - `\\?\UNC\…`    — extended UNC; SMB auth on Windows leaks NTLM hashes.
 *  - `\\…` / `//…`  — bare UNC paths.
 *  - Forward-slash variants `//?/…` since Node normalises some forms.
 *
 * Returns null on success, an error string on rejection.
 */
export function rejectUnsafeWindowsPrefix(p: string): string | null {
  // Normalise just enough to catch mixed separators without resolving.
  const lower = p.toLowerCase();

  // Extended-length / extended-UNC prefixes. These must be tested before the
  // bare UNC check because `\\?\` also starts with `\\`.
  if (
    lower.startsWith("\\\\?\\") ||
    lower.startsWith("//?/") ||
    lower.startsWith("\\\\.\\") ||
    lower.startsWith("//./")
  ) {
    return "Extended-length / device-namespace paths (\\\\?\\, \\\\.\\) are not supported for security reasons.";
  }

  // Bare UNC.
  if (lower.startsWith("\\\\") || lower.startsWith("//")) {
    return "UNC paths are not supported for security reasons.";
  }

  return null;
}
