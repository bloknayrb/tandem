/**
 * The corpus of hostile Windows path spellings, in one place (#1417).
 *
 * **Every test that uses this must assert the SYSCALL, not the return value.**
 * This is the one rule the corpus cannot enforce and the one most likely to be
 * "simplified" away, so it is stated here rather than five times over: a UNC
 * path naming a host that does not answer already produced the rejection value
 * — `null`, `false`, `true`, `[]`, a throw — *before* any of these guards were
 * fixed, because the syscall threw. So `expect(...).toBeNull()` passes against
 * the vulnerable code and proves nothing. The vulnerability is that the call
 * was made at all; the fix is that it isn't. Spy on the syscall and assert
 * `not.toHaveBeenCalled()`.
 *
 * This is not theoretical. The first test written for one of these guards
 * asserted the return value, and the mutant — the original broken ordering,
 * restored — survived it.
 *
 * **Why this is shared rather than restated per test.** The premise of #1417 is
 * that bypass spellings get discovered *after* the guard ships — `\\?\unc\…`,
 * `\\?\GLOBALROOT\Device\Mup\…` and every forward-slash form were all found
 * later than the checks they walked past. When each guard's test carries its own
 * hand-typed list, the next discovery has to be remembered in six files, and the
 * ones that get missed are silently weaker than the ones that don't. That is the
 * same drift the fix itself is about, re-created in the tests.
 *
 * Add a newly-found spelling HERE and every guard's test picks it up.
 *
 * The Rust guards keep their own copies — no cross-language sharing is
 * available — so `src-tauri/src/cowork_workspace_scan.rs` and `lib.rs` must be
 * updated by hand when this list grows.
 */

/**
 * Paths that reach SMB. Every guard in the codebase must refuse all of these,
 * strict and loose variants alike, before performing any filesystem call.
 */
export const NETWORK_PATHS: ReadonlyArray<readonly [label: string, path: string]> = [
  ["classic UNC", "\\\\attacker\\share\\x"],
  ["forward-slash UNC", "//attacker/share/x"],
  ["extended UNC", "\\\\?\\UNC\\attacker\\share\\x"],
  ["forward-slash extended UNC", "//?/UNC/attacker/share/x"],
  // Windows prefixes are case-insensitive; a literal `UNC` comparison was a
  // one-character bypass.
  ["lowercase extended UNC", "\\\\?\\unc\\attacker\\share\\x"],
  ["mixed-case extended UNC", "\\\\?\\Unc\\attacker\\share\\x"],
  // Two more routes to the same handshake under the `\\?\` / `\\.\` namespaces.
  ["GLOBALROOT via Mup", "\\\\?\\GLOBALROOT\\Device\\Mup\\attacker\\share"],
  ["device namespace", "\\\\.\\UNC\\attacker\\share\\x"],
  ["device namespace, forward slash", "//./unc/attacker/share/x"],
];

/**
 * Extended-length paths naming a LOCAL drive. These are NOT network paths, and
 * the two families of guard disagree about them **on purpose**:
 *
 *  - `src/cli/win-path-guard.ts` and its Rust twin PERMIT them — Tauri's path
 *    APIs hand these back, and realpath'd containment is what confines them.
 *  - `rejectUnsafeWindowsPrefix` and everything built on it REFUSE them, because
 *    its allowed-roots comparison is against `realpath`'d roots that an
 *    extended-length spelling would never match.
 *
 * So this list is exported separately rather than folded into the one above:
 * each site has to choose, and a single "all bad paths" array would quietly
 * force one answer on both.
 */
export const LOCAL_EXTENDED_PATHS: ReadonlyArray<readonly [label: string, path: string]> = [
  ["extended-length local", "\\\\?\\C:\\Users\\someone\\x"],
  ["lowercase drive", "\\\\?\\c:\\Users\\someone\\x"],
  ["forward-slash form", "//?/C:/Users/someone/x"],
];
