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
 * the message.
 *
 * **The inventory of surviving hand-rolled copies is not here.** It is the
 * `ALLOWED` map in `tests/shared/unc-check-duplication.test.ts`, which `npm
 * test` and the pre-push hook enforce in both directions: a `startsWith`-shaped
 * copy with no entry fails, and an entry whose file no longer holds one fails
 * too. A prose list beside it would be the same drift #1417 is about, one level
 * up — the previous version of this paragraph already disagreed with the map on
 * both the count and which files were in it.
 *
 * **That map is not a proof that no other copy exists**, and neither is this
 * pointer. The detector matches a spelling, so a copy written as a regex walks
 * straight past it — `WIN_EXTENDED_DRIVE_RE` in `server/integrations/node-binary.ts`
 * is exactly that, and is unlisted for that reason rather than by decision. So
 * is `is_unc_or_network_path` in `src-tauri/src/lib.rs`, which *was* listed
 * until it was rewritten from a `starts_with` into a two-char `matches!` and
 * fell out of the detector's sight without anything failing. What is worth
 * stating here, because no test can:
 *
 *  - The loose variants are **deliberate, not defects.** `cli/win-path-guard.ts`
 *    and its Rust twin `is_unc_path` allow `\\?\C:\…` on purpose and confine it
 *    by realpath'd containment instead. Do not "fix" them into calling this.
 *  - Both are written as an **allowlist** of that one permitted shape rather
 *    than an enumeration of bad ones. The enumeration they replaced let
 *    `\\?\unc\…` and `\\?\GLOBALROOT\…` through. An allowlist has no such tail.
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
 *  - Every separator spelling of the above, including the MIXED ones
 *    (`/\host\share`, `\/host/share`). Windows treats `/` and `\` as
 *    interchangeable and Node hands all four spellings to the SMB redirector.
 *
 * Returns null on success, an error string on rejection.
 */
export function rejectUnsafeWindowsPrefix(p: string): string | null {
  // **Separators are normalised, not enumerated.** Windows treats `/` and `\`
  // as interchangeable, so `/\host\share` and `\/host/share` are UNC exactly
  // like `\\host\share`: `path.toNamespacedPath` turns all four into
  // `\\?\UNC\host\share`, and `existsSync` on any of them reaches the
  // redirector — verified on Windows, not reasoned about. Testing only the
  // homogeneous pairs made the two mixed spellings a two-character bypass of
  // this entire guard. Enumerating pairs is the trap; normalising first is what
  // makes the set closed.
  //
  // Bounded to the first 8 characters — the length of the longest prefix that
  // matters, `\\?\UNC\` — so this stays allocation-cheap where it sits in front
  // of a syscall.
  const head = p.slice(0, 8).toLowerCase().replace(/\//g, "\\");

  // Extended-length / device-namespace prefixes. Tested before the bare UNC
  // check because `\\?\` also starts with `\\`.
  if (head.startsWith("\\\\?\\") || head.startsWith("\\\\.\\")) {
    return "Extended-length / device-namespace paths (\\\\?\\, \\\\.\\) are not supported for security reasons.";
  }

  // Bare UNC.
  if (head.startsWith("\\\\")) {
    return "UNC paths are not supported for security reasons.";
  }

  return null;
}
