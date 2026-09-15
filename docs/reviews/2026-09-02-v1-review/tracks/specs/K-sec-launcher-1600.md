# K-sec-launcher — #1600 the npm uninstall scrub rewrites Cowork JSON without the Rust `with_locked_json` lock

Branch `fix/security-lows-launcher-half-confined-launcher-cwd-no-tandem-secrets-in-the-launched-env-no-plaintext-keychain-read-production-sidecar-and-a-locked-cowork-scrub-1822`. **Closes #1600 (the fix half).** A real, interoperating lock lands and no work is left against it. Ledger: `docs/security.md:485` ("What is NOT accepted here", item (i)). Probe: a standalone fs2 0.4.3 program replicating `with_locked_json`'s open and lock, against a Node probe, run on Windows (scratchpad, results below).

## Problem

`rewriteJson` (`src/cli/uninstall-scrub.ts:336`) does read → parse → mutate → tmp → rename with no lock. `runUninstallScrub` calls it inside `if (isWindows)` at `:662`, `:667` and `:672`, on `installed_plugins.json`, `known_marketplaces.json` and `cowork_settings.json`. The Rust writers of those files all go through `with_locked_json` (`src-tauri/src/cowork_atomic_json.rs:130`). That function opens a SIBLING `.<file_name>.tandem-lock` read+write+create and takes `try_lock_exclusive` with a 200/500/1500/5000 ms backoff inside a 30 s budget. **The desktop uninstaller's scrub is already locked** (`uninstall_scrub.rs` → `uninstall_tandem_plugin_from_workspace` → `with_locked_json`). The npm CLI's `tandem --uninstall-scrub` (`src/cli/index.ts:108`) is the only unlocked writer, so a scrub racing a Cowork install or remove in a running desktop app loses one of the two updates silently.

## Measurement

fs2's Windows lock is `LockFileEx(handle, LOCKFILE_EXCLUSIVE_LOCK | LOCKFILE_FAIL_IMMEDIATELY, 0, !0, !0)` (`fs2-0.4.3/src/windows.rs:94,111`). Node has no API for it, and `fs.constants` does not export `UV_FS_O_EXLOCK` (checked on Node v24.2.0). libuv still honours the raw flag `0x10000000` (`UV_FS_O_EXLOCK` in `uv/win.h`), which opens the file with share mode 0. Probe results:

| Holder | Contender | Result |
|---|---|---|
| Rust (`open` + `try_lock_exclusive`) | Node `open(O_RDWR\|O_CREAT\|0x10000000)` | **`EBUSY`** |
| Rust | Node plain `open("r+")`, then `write` | open OK, write `EBUSY` (so a marker-file lock would not exclude) |
| Node EXLOCK handle | Rust `with_locked_json`-style `open` | **fails, `raw_os_error = 32`** (sharing violation) |
| Nobody | Node EXLOCK / Rust lock | acquired |

So an exclusive-share open of the same sibling file excludes in both directions, with no native addon. That is option 1 of the plan.

## Fix

**`src/cli/uninstall-scrub.ts`, `rewriteJson` only.**
- Before `readFile`, acquire `lockPath = path.join(path.dirname(filePath), `.${path.basename(filePath)}.tandem-lock`)`. It must be byte-identical to the Rust `format!(".{file_name}.tandem-lock")`.
- Open it with `fsPromises.open(lockPath, O_RDWR | O_CREAT | EXLOCK)`, where `const UV_FS_O_EXLOCK = 0x10000000`. Comment why it is a literal (not exported by Node, measured). Apply it only when `process.platform === "win32"`; otherwise use `0`, since the flag means something else to POSIX libuv. All callers are Windows-only anyway.
- On `EBUSY`, retry on Rust's schedule (200, 500, 1500, then 5000 ms repeated) until the cumulative sleep reaches 30000 ms. Summing the sleeps rather than reading a wall clock keeps the tests deterministic.
- On timeout, `logger.warn("… locked by another Tandem process — skipping")` with the path only, and return `false`.
- Any other open error (`EACCES`, `EPERM`, `ENOENT` for a missing dir) logs a warn and returns `false`. **Never write without the lock.**
- Hold the handle across read, mutate, tmp write and rename, and `close()` it in a `finally`. The tmp and rename target the data file, not the lockfile, so the sibling design keeps the rename legal (the Rust docblock's os error 33 rationale).
- Add an optional 4th parameter `opts: { sleep?: (ms: number) => Promise<void> } = {}` as a test seam. Callers are unchanged.
- The lockfile is left in place, as Rust leaves it.
- Replace the docblock sentence "trusts its callers (consistent with `with_locked_json` on the Rust side)". Keep the path-trust meaning, and add the cross-language lock contract: the same sibling name, and share-mode exclusion that interoperates with fs2's `LockFileEx`, as measured.

**`src-tauri/src/cowork_atomic_json.rs`: docblock only.** Beside the sibling-lock comment, say the npm scrub's `rewriteJson` takes the same file by exclusive-share open. **Renaming the lockfile silently removes that exclusion.** While the Node writer holds it, this function's `open` fails with os error 32. That error is not `WouldBlock`, so it is not retried: it surfaces as `WriteStatus::Failed` through `write_status_from` (`cowork_installer.rs:883-890`). It is loud, not lost.

**Docs.**
- `docs/security.md:485`: take (i) out of "What is NOT accepted here" and state #1600 as fixed. Name the mechanism, and the Rust-side loud-failure outcome under contention.
- `tests/docs/config-writer-set-claims.test.ts:182`: rewrite the `why` string, which says the writer does not take the lock. Keep `sites: 2`: `fsPromises.open(` does not match the site regex `\b(?:fs|promises)\.open\s*\(` (capital `P`, no word boundary). **Run the test to confirm the count rather than trusting this.** A lockfile open is not a config write, and #1599's accepted set is not widened.

## Tests

In `tests/cli/uninstall-scrub.test.ts`, add `open: _openSpy` to the `node:fs` mock. It resolves `{ close: _closeSpy }` by default in `rewriteJson`'s `beforeEach`, so the three existing cases keep passing. Stub `process.platform` to `"win32"` per case and restore it after.

1. The first `open` call gets `path.join("/fake", ".installed_plugins.json.tandem-lock")` and flags `O_RDWR | O_CREAT | 0x10000000`. This kills no lock, a wrong name (`installed_plugins.json.lock`) and a missing EXLOCK bit.
2. Order: `open` happens before `readFile`, and `close` after `rename` (`invocationCallOrder`). This kills releasing before the write.
3. `EBUSY`, `EBUSY`, then success writes and renames, with `sleep` called with `200` then `500`. This kills no-retry.
4. `EBUSY` forever returns `false` with one warn naming the path. `readFile`, `writeFile`, `rename` and `close` are never called, and the sleeps sum to at least 30000. This kills proceeding unlocked after a timeout.
5. A rejecting `rename` still calls `close` (the `finally`).
6. The Rust source `src-tauri/src/cowork_atomic_json.rs` still contains `format!(".{file_name}.tandem-lock")`. Without this assertion a rename on either side leaves both suites green and the lock excluding nothing.

Mutation-test cases 1-4 by reverting the flag, the lock name, the retry and the timeout return. Restore from a file copy.

**CI coverage, stated honestly.** vitest runs on ubuntu, so these mocked cases execute in CI. **No CI leg exercises the real `LockFileEx`-versus-share-mode interop.** That rests on the Windows probe above, which the PR body reproduces with commands and output. Do not add a `win32`-skipped spec: no Windows job runs it, and it would read as a pass forever (the CLAUDE.md Testing gotcha).

## Done when

Six cases are green and mutation-checked. `security.md` and the config-writer `why` are updated, and `tests/docs/config-writer-set-claims.test.ts` and `security-findings-claims.test.ts` pass. The PR body carries the probe table.

## Not in scope

- **Declined:** making `with_locked_json` retry on os error 32. A Cowork install that runs while the user is hand-running an uninstall scrub fails loudly, and closing the lost update does not need it. No work remains.
- **Not pursued:** option 2, dropping the npm scrub's Cowork writes. It was unnecessary once option 1 measured real, and it would change what `tandem --uninstall-scrub` cleans.
- The MCP-config writers under #1599 (accepted).
- The `rotate-token.ts:160-169` Cowork re-walk gap.
