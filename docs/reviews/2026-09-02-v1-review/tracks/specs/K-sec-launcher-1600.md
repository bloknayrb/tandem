# K-sec-launcher — #1600 the npm uninstall scrub rewrites Cowork JSON without the Rust `with_locked_json` lock

Branch `fix/security-lows-launcher-half-confined-launcher-cwd-no-tandem-secrets-in-the-launched-env-no-plaintext-keychain-read-production-sidecar-and-a-locked-cowork-scrub-1822`. **Closes #1600.**

- **Both halves are settled.** The fix half: a real, interoperating lock lands, CI checks it on a required Windows leg, and no work is left against it. The policy half: the sweep ledger lists a "#1600 policy half" in its DECIDE bucket (`docs/plans/2026-09-06-open-issues-sweep.md:54`), whose options were accept-and-document versus fix. The measured interoperating lock settles it as **fix**, so nothing is owed to Bryan on #1600.
- **Ledger:** `docs/security.md:485` ("What is NOT accepted here", item (i)).
- **Probe:** a standalone fs2 0.4.3 program replicating `with_locked_json`'s open and lock, run against a Node probe on Windows (scratchpad; results below). It becomes a CI test here.

**Files:**
- `src/cli/uninstall-scrub.ts`: `rewriteJson`, a new `ScrubLockError`, and a new exported `scrubCoworkWorkspace` extracted from `runUninstallScrub`.
- `src-tauri/src/cowork_atomic_json.rs`: lock acquisition, plus unit and Windows interop tests.
- `tests/cli/uninstall-scrub.test.ts`, `tests/docs/config-writer-set-claims.test.ts` and `docs/security.md`.

## Problem

`rewriteJson` (`src/cli/uninstall-scrub.ts:336`) does read → parse → mutate → tmp → rename with no lock. `runUninstallScrub` calls it inside `if (isWindows)` at `:662`, `:667` and `:672` on `installed_plugins.json`, `known_marketplaces.json` and `cowork_settings.json`, one try/catch around all three per workspace.

The Rust writers of those files all go through `with_locked_json` (`src-tauri/src/cowork_atomic_json.rs:130`). It opens a SIBLING `.<file_name>.tandem-lock` read+write+create, then takes `try_lock_exclusive` with a 200/500/1500/5000 ms backoff inside a 30 s budget.

**The desktop uninstaller's scrub is already locked** (`uninstall_scrub.rs` → `uninstall_tandem_plugin_from_workspace` → `with_locked_json`). The npm CLI's `tandem --uninstall-scrub` (`src/cli/index.ts:108`) is the only unlocked writer. A scrub racing a Cowork install or remove in a running desktop app silently loses one of the two updates.

## Measurement

fs2's Windows lock is `LockFileEx(handle, LOCKFILE_EXCLUSIVE_LOCK | LOCKFILE_FAIL_IMMEDIATELY, 0, !0, !0)` (`fs2-0.4.3/src/windows.rs:94,111`). Node has no API that takes it. `fs.constants` does not export `UV_FS_O_EXLOCK` (checked on Node v24.2.0), but libuv still honours the raw flag `0x10000000` (`UV_FS_O_EXLOCK` in `uv/win.h`), which opens the file with share mode 0. **This is an undocumented libuv flag.** Probe results:

| Holder | Contender | Result |
|---|---|---|
| Rust (`open` + `try_lock_exclusive`) | Node `open(O_RDWR\|O_CREAT\|0x10000000)` | **`EBUSY`** |
| Rust | Node plain `open("r+")`, then `write` | open OK, write `EBUSY` (so a marker-file lock would not exclude) |
| Node EXLOCK handle | Rust `with_locked_json`-style `open` | **fails, `raw_os_error = 32`** (sharing violation) |
| Nobody | Node EXLOCK / Rust lock | acquired |

So an exclusive-share open of the same sibling file excludes in both directions, with no native addon. That is option 1 of the plan.

## Fix

**`src/cli/uninstall-scrub.ts`.**

`rewriteJson(filePath, mutate, logger, opts = {})`:
1. **Unlocked pre-check, which creates nothing.** `readFile` the data file.
   - ENOENT → `return false` silently, exactly as today. No `open`, no lockfile, no warn.
   - Parse or shape failure → today's path-only warn and `return false`.
   - Otherwise run `mutate` on this pre-read copy. If it returns `false`, `return false` with no lock taken.
   - **Why:** a workspace where Tandem was never installed, or whose files hold no Tandem entry, gets no `.<file>.tandem-lock` residue and no new warnings. The pre-check is race-safe: an entry Rust adds after it is an install-after-scrub ordering, not a lost update. It matches Rust's own uninstall, which skips an absent file before locking (`cowork_installer.rs:413-436`, `if !path.exists()`).
2. **Acquire the lock.**
   - Path: `lockPath = path.join(path.dirname(filePath), `.${path.basename(filePath)}.tandem-lock`)`, byte-identical to Rust's `format!(".{file_name}.tandem-lock")`.
   - Open it with `fsPromises.open(lockPath, O_RDWR | O_CREAT | exlock)`, where **`exlock` is computed at call time inside `rewriteJson`**: `const exlock = process.platform === "win32" ? UV_FS_O_EXLOCK : 0`. The module-level constant is only the literal `const UV_FS_O_EXLOCK = 0x10000000`, with a comment: not exported by Node, undocumented, measured, and checked in CI by the Rust Windows test below. A module-scope platform test would be baked in at the test file's first import and would defeat the per-case platform stub.
   - On POSIX the flag is `0`, since it means something else to POSIX libuv. All callers are Windows-only anyway.
   - **EBUSY:** retry on Rust's schedule (200, 500, 1500, then 5000 ms repeated) through `opts.sleep ?? realSleep`, until the cumulative sleep reaches 30000 ms. Summing the sleeps instead of reading a wall clock keeps the tests deterministic.
   - **ENOENT on the lock open** (the directory vanished after the pre-check) → `return false` silently.
   - **Timeout, or any other open error** (`EACCES`, `EPERM`, …) → `throw new ScrubLockError(filePath)`. The message is `cannot lock <path> — skipped`, with the path only and no errno text. **Never write without the lock.** It throws rather than returning `false` because `false` already means "absent or unchanged". A skipped scrub can leave a token-bearing `installed_plugins.json` entry behind (the #1599 credential-remanence shape), so it must count as a failure.
3. **Under the lock:** re-read, re-parse and re-`mutate` the data file, using the same ENOENT, invalid-JSON and not-an-object handling. Then tmp write and rename. `close()` the handle in a `finally` wrapped around all of step 3. The tmp and rename target the data file, not the lockfile, so the sibling design keeps the rename legal (the Rust docblock's os error 33 rationale).
4. The lockfile is left in place, as Rust leaves it.
5. Replace the docblock sentence "trusts its callers (consistent with `with_locked_json` on the Rust side)". Keep the path-trust meaning, and add the cross-language lock contract: the same sibling name, and a share-mode exclusion that interoperates with fs2's `LockFileEx`, relying on an undocumented libuv flag.

**`scrubCoworkWorkspace(ws, logger, opts = {}): Promise<number>`**, extracted from `runUninstallScrub`'s per-workspace body and exported for tests:
- It loops over the three `[file, mutator]` pairs with **one try/catch per file**, so a locked `installed_plugins.json` no longer skips the other two files.
- Each catch runs `logger.error(`scrub failed for ${file}: ${message}`)` and counts one failure.
- It returns the count, and `runUninstallScrub` adds it to `failures`.
- Exit code: `runUninstallScrub` already returns 1 when `failures > 0` (`:714`). This is the npm CLI's own exit code. NSIS runs the desktop exe's Rust scrub (`installer-hook.nsi:58`), not this one.

**`src-tauri/src/cowork_atomic_json.rs`: the Rust side now waits instead of failing.**
- Today `.open(&lock_path)?` (`:153-158`) sits outside the backoff loop, and only `WouldBlock` is retried (`:165-189`). While Node holds its share-mode handle, Rust's open fails with os error 32 and surfaces as `WriteStatus::Failed` (`write_status_from`, `cowork_installer.rs:883-890`). The install and remove flows write the three files in separate `with_locked_json` calls (`cowork_installer.rs:336/353/362`, `:416/425/434`), and nothing rolls back. So a mid-sequence `Failed` would leave a partial registration, which is the inconsistent state #1600 describes, only reported this time.
- Move the lockfile open **into** the loop. Add `fn is_lock_contention(e: &io::Error) -> bool`, true for `e.kind() == io::ErrorKind::WouldBlock || (cfg!(windows) && e.raw_os_error() == Some(32))`, and apply it to both the open error and the `try_lock_exclusive` error.
- Contention runs through the same backoff and 30 s budget and ends as `CoworkError::LockTimeout` → `WriteStatus::Locked`. The `cfg!(windows)` term matters: raw 32 is `EPIPE` on Linux.
- Factor the open into `fn open_lock_file(lock_path: &Path) -> io::Result<File>` so the Windows test can call it directly.
- Docblock beside the sibling-lock comment: the npm scrub's `rewriteJson` takes the same file by exclusive-share open, and **renaming the lockfile on either side silently removes that exclusion**. Explain why os error 32 counts as contention.

**Docs.**
- `docs/security.md:485`: take (i) out of "What is NOT accepted here" and state #1600 as fixed. Name the mechanism: the same sibling lockfile, fs2 `LockFileEx` on the Rust side, and an exclusive-share open on the Node side.
- In the same entry, state the contention outcome in both directions: Rust waits in its budget; Node throws and the scrub counts a failure.
- Also record **the named residual**: the Node half depends on the undocumented libuv flag `0x10000000`. The Rust Windows test checks it, but only against the Node preinstalled on the GitHub `windows-latest` image. A user's own Node version is not checked.
- `tests/docs/config-writer-set-claims.test.ts:182`: rewrite the `why` string, which says the writer does not take the lock. Keep `sites: 2`. The rewritten `why` must **name the lockfile open explicitly**: it is `fsPromises.open(lockPath, …)`, never written to, and the census skips it only because the site regex `\b(?:fs|promises)\.open\s*\(` is case-sensitive (capital `P`, no word boundary). A refactor to `fs.promises.open` would take the count to 3, and that is a lockfile open, not a new config writer. **Run the test to confirm the count rather than trusting this.** #1599's accepted set is not widened.

## Tests

**vitest, `tests/cli/uninstall-scrub.test.ts`.**

Add `open: _openSpy` to the `node:fs` `promises` mock. In `rewriteJson`'s `beforeEach`, reset it to resolve `{ close: _closeSpy }`. The existing three cases stay green: ENOENT still returns `false` with no open, malformed JSON still warns once, and the write case reads the same content twice. Stub `process.platform` to `"win32"` per case (unless stated otherwise) and restore it afterwards. Pass `{ sleep }`, a `vi.fn` resolving immediately.

1. **Name and flags.** The first `open` call gets `path.join("/fake", ".installed_plugins.json.tandem-lock")` and `O_RDWR | O_CREAT | 0x10000000`. Kills: no lock, a wrong name, a missing EXLOCK bit.
2. **Call-time platform.** With `process.platform` stubbed to `"linux"`, the flags are `O_RDWR | O_CREAT` without the bit. Together with case 1 on the same module instance, this kills a module-scope constant on any host.
3. **Order** (`invocationCallOrder`): pre-check `readFile` < `open` < locked `readFile` < `writeFile` < `rename` < `close`. Kills: releasing before the write, and writing from the unlocked read.
4. **EBUSY, EBUSY, then success** writes and renames, with `sleep` called with `200` then `500`. Kills: no retry.
5. **EBUSY forever** rejects with `ScrubLockError`, whose message contains the path. `readFile` is called exactly once (the pre-check); `writeFile`, `rename` and `close` never are; the sleeps sum to at least 30000. Kills: proceeding unlocked after a timeout, and returning `false`.
6. **Non-EBUSY lock error.** `_openSpy.mockRejectedValueOnce(Object.assign(new Error("EPERM"), { code: "EPERM" }))` rejects with `ScrubLockError`. `readFile` is called exactly once, and `writeFile`, `rename` and `sleep` never are. Kills: the fail-open fall-through (`catch { warn }` then carrying on), and a best-effort try around the lock.
7. **ENOENT on the lock open** resolves `false` with no `warn`, no `writeFile` and no `rename`.
8. **Absent data file.** Pre-check `readFile` ENOENT → `false`, **zero `open` calls**, no `warn`. Kills: locking before the existence check (lockfile residue).
9. **Nothing to remove.** The data file parses but `mutate` returns `false` → `false`, zero `open` calls. Kills: creating a lockfile in a workspace Tandem never touched.
10. **A rejecting `rename`** still calls `close` (the `finally`).
11. **`scrubCoworkWorkspace` per-file accounting.** The first file's lock times out; the other two files parse, change and succeed. The result is `1`; `logger.error` is called once and names the first file; `rename` runs twice. Kills: the old all-three try/catch, and not counting the failure.
12. **Rust name pin.** `src-tauri/src/cowork_atomic_json.rs` still contains `format!(".{file_name}.tandem-lock")`, and `uninstall-scrub.ts` still contains `.tandem-lock`. Without this, a rename on either side leaves both suites green.

**Rust, `src-tauri/src/cowork_atomic_json.rs` `#[cfg(test)]`.**

- **R1, `is_lock_contention` (all three `rust-test` legs):**
  - `io::ErrorKind::WouldBlock` → `true`;
  - `io::Error::from_raw_os_error(32)` → `cfg!(windows)`;
  - `io::ErrorKind::NotFound` → `false`.
- **R2, `#[cfg(windows)] node_exclusive_share_open_interoperates_with_with_locked_json`** (the `windows-latest` `rust-test` leg, a required check). It spawns `node -e` with a script using the literal `0x10000000`. If `node` cannot be spawned, **the test panics**, naming the missing binary: it must never skip, per the Windows-gated-spec gotcha.
  - *Node holds, Rust waits.* The Node child opens the lockfile with `O_RDWR | O_CREAT | 0x10000000`, prints `held`, and waits on stdin. Rust asserts `open_lock_file(&lock)` fails with `raw_os_error() == Some(32)`. It then starts `with_locked_json` on a thread, closes the child's stdin after ~300 ms, and asserts the thread returns `Ok`.
  - *Rust holds, Node is refused.* `with_locked_json` runs on a thread whose `mutate` blocks on a channel. A Node child attempts the same open and prints `err.code`. Rust asserts `EBUSY`, then releases the channel.
  - This is the CI form of the probe table. It checks both the libuv flag and the fs2 interop, against the image's Node.

**Mutation-test**, restoring from a file copy and never with `git checkout`:

| Mutation | Must go red |
|---|---|
| The EXLOCK bit | Case 1 |
| A module-scope platform test | Case 2 |
| The lock name | Cases 1, 12 |
| The retry | Case 4 |
| The timeout throw, changed to `return false` | Case 5 |
| The non-EBUSY fall-through | Case 6 |
| The pre-check ordering | Cases 8, 9 |
| The per-file try/catch | Case 11 |
| The raw-32 arm of `is_lock_contention` | R1, and R2's "Rust waits" half |

## CI coverage, stated honestly

- The vitest cases run on ubuntu `check`.
- R1 runs on all three `rust-test` legs.
- **R2 is the only execution of the real `LockFileEx`-versus-share-mode interop**, and it runs on the `windows-latest` `rust-test` leg only. That leg has no `setup-node` step (`ci.yml:54-109`), so R2 uses whatever Node the runner image preinstalls. It proves the flag on that Node version, not on the user's. The first CI run is also the first proof that `node` is on that leg's PATH. If it is not, R2 goes red by design, and the fix is a `setup-node` step, never a skip.
- A local Windows run of R2 is the builder's pre-push evidence and does not verify anything cross-platform.
- The PR body reproduces the probe table and names these legs.

## Done when

- Cases 1-12, R1 and R2 are green and mutation-checked.
- `security.md` and the config-writer `why` are updated.
- `tests/docs/config-writer-set-claims.test.ts` and `security-findings-claims.test.ts` pass.
- The PR body carries the probe table, the libuv-flag residual and the CI legs above.

## Not in scope

- **Not pursued: option 2, dropping the npm scrub's Cowork writes.** It became unnecessary once option 1 measured real, and it would change what `tandem --uninstall-scrub` cleans.
- The MCP-config writers under #1599 (accepted).
- The `rotate-token.ts:160-169` Cowork re-walk gap.

## Review corrections (round 1)

**Adopted**
- **BLOCKING: taking the lock before the read changed behaviour in untouched workspaces** (lockfile residue, new warnings); raised three times. Fix: an unlocked pre-check with a silent ENOENT and a no-change early return before any `open`; ENOENT on the lock open is silent; Rust uninstall parity is cited. Cases 7-9 were added.
- **BLOCKING: nothing tested "never write without the lock".** Case 6 (EPERM) now asserts no write, no rename and no sleep, and the fall-through is in the mutation list. The result is a `ScrubLockError` rejection rather than `false` plus a warn, per the adopted counted-failure finding below.
- **Lock timeout reported as success.** Timeouts and non-ENOENT lock errors now throw `ScrubLockError`. `scrubCoworkWorkspace` counts them per file with `logger.error`, the exit code becomes 1, and case 11 was added.
- **Declined Rust retry on os error 32** (raised twice, with the partial-install consequence). The decline is reversed: the open moves into the backoff loop behind `is_lock_contention`, with R1. This also supersedes the "loud, not lost untested" finding, because contention now waits instead of failing.
- **The libuv flag was proven only by a scratchpad probe** (raised twice). R2 now runs on the required Windows `rust-test` leg, fails closed without `node`, and the flag dependency is a named residual in `security.md`. The "no Windows job runs it" sentence was wrong and has been removed.
- **EXLOCK was not specified as call-time** (raised twice). It is now specified, and case 2 kills a module-scope constant on any host.
- **The config-writer census relied on regex case-sensitivity.** The `why` string now names the lockfile open and the blind spot.
- **Policy half.** The Closes derivation now states that the DECIDE-bucket "#1600 policy half" is settled as fix.

**Not adopted**
- **The Node-only Windows spec in the `windows-acl-proof` job.** R2 covers it instead. That job's gate script and wiring drift guard are scoped to real-`icacls` specs (`scripts/ci/windows-acl-proof.mjs` header), and a Node-only spec would test the libuv flag without fs2. R2 tests both directions against the real `with_locked_json` on a required leg.
- **Case 7 as written ("result false, one warn").** The test is adopted, but it now expects a `ScrubLockError` rejection, because the counted-failure finding changed what a non-ENOENT lock error does. A `false` plus warn would make the skipped scrub report success.
