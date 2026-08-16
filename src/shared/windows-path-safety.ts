/**
 * Reject Windows path prefixes that can leak NTLM credentials or bypass UNC
 * filtering. Cross-platform string check (no syscalls) so it's safe to run on
 * every platform — defense-in-depth against a Windows client supplying a
 * crafted path to a Linux/macOS server (the path string still reaches code
 * that may eventually run on Windows via shared state).
 *
 * **This is the canonical copy of this rule**, and it lives in `src/shared/`
 * rather than with the server's file IO because client, CLI and server all need
 * it while `src/client/` must not import from `src/server/`.
 *
 * **What this function is worth is one definition and a specific message — NOT
 * a wider verdict.** Every prefix in the first branch also starts with `\\` or
 * `//`, so as a boolean this is equivalent to a bare
 * `startsWith("\\\\") || startsWith("//")` on every input. A test that asserts
 * only "rejected" therefore does not pin the extended-length branch; assert on
 * the message. Four hand-rolled copies survive, and their gaps differ — do not
 * assume they are all "the weak one":
 *
 *  - `server/file-io/docx-export.ts` and its spike twin — bare `\\` only, so
 *    they genuinely miss the forward-slash forms.
 *  - `server/launcher/supervisor.ts` — names `\\?\` and `\\.\` explicitly, and
 *    its `//` gap is now covered because `rejectedSyntactically` calls this
 *    function first; the local check survives only as the shape filter.
 *  - `cli/win-path-guard.ts` and its Rust twin `is_unc_path` in
 *    `src-tauri/src/cowork_workspace_scan.rs` — deliberately LOOSER, because
 *    they allow `\\?\C:\…` on purpose and confine it by realpath'd
 *    containment instead. They are not defects; do not "fix" them. They are
 *    written as an allowlist of that one shape rather than a blacklist of the
 *    bad ones, which is the only form that has no bypass tail.
 *
 * See #1417, which also covers the ordering defect where a filesystem call runs
 * *before* the check — a class this string test cannot detect.
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
