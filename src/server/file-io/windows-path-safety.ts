/**
 * Reject Windows path prefixes that can leak NTLM credentials or bypass UNC
 * filtering. Cross-platform string check (no syscalls) so it's safe to run on
 * every platform — defense-in-depth against a Windows client supplying a
 * crafted path to a Linux/macOS server (the path string still reaches code
 * that may eventually run on Windows via shared state).
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
