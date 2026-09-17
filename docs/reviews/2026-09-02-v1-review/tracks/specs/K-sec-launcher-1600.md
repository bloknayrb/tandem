# K-sec-launcher — #1600: the npm uninstall scrub rewrites Cowork JSON without the Rust `with_locked_json` lock

**Refs #1600 by default. Closes #1600 only if R2 (below) passes on the Windows `rust-test` leg AND Bryan confirms, in the `bryan` item below, that this PR resolves the #1600 policy half.** If R2 cannot be made green, ship nothing for #1600: move the options into `bryan` and list it as Refs.

**Files:**
- `src/cli/uninstall-scrub.ts` (`rewriteJson`)
- `src-tauri/src/cowork_atomic_json.rs` (the lock-open loop)
- `tests/cli/uninstall-scrub.test.ts`
- `docs/security.md:485`
- the `why` string at `tests/docs/config-writer-set-claims.test.ts:182`

## Problem

`rewriteJson` (`src/cli/uninstall-scrub.ts:336`) reads, mutates, writes a tmp file and renames it, all with no lock. It is called inside `if (isWindows)` at `:662/:667/:672`, for `installed_plugins.json`, `known_marketplaces.json` and `cowork_settings.json`, under one try/catch per workspace.

Every Rust writer of those files goes through `with_locked_json` (`cowork_atomic_json.rs:130`). That function opens a sibling `.<file>.tandem-lock` and takes fs2's `try_lock_exclusive` with backoff inside a 30 s budget. The desktop uninstaller's Rust scrub is locked too. The npm `tandem --uninstall-scrub` is therefore the only unlocked writer, and a scrub racing a desktop Cowork install silently loses one of the two updates.

## Measurement (Windows, scratchpad probe; R2 makes it a CI test)

fs2 on Windows calls `LockFileEx(EXCLUSIVE | FAIL_IMMEDIATELY)` (`fs2-0.4.3/src/windows.rs`). Node exposes no such call. libuv does honour the **undocumented** raw open flag `0x10000000` (`UV_FS_O_EXLOCK`, which opens with share mode 0). Node v24.2.0 does not export it in `fs.constants`.

| Holder | Contender | Result |
|---|---|---|
| Rust lock | Node `open(O_RDWR\|O_CREAT\|0x10000000)` | `EBUSY` |
| Rust lock | Node plain `open` + `write` | the write fails with `EBUSY`, but a marker-file lock would still not exclude |
| Node EXLOCK handle | Rust `OpenOptions::open` | `raw_os_error = 32` |

The exclusion works in both directions with no native addon. That makes this option 1.

**Option 2 (drop the npm Cowork writes) is rejected on evidence.** `tauri.conf.json` has `"targets": "all"`, so Windows also ships an MSI, and an MSI uninstall never runs the NSIS hook. `docs/data-locations.md:173` promises that `tandem --uninstall-scrub` removes the Cowork registration.

## Fix

**`rewriteJson`. The minimum that locks without changing behaviour in untouched workspaces:**
1. **An unlocked pre-check that creates nothing.** Keep today's code: `readFile` (ENOENT returns `false` silently), parse (the path-only warns) and `mutate`. If `mutate` returns `false`, return `false`. **No `open` call and no lockfile happens before this point**, so a workspace without a Tandem entry gets no residue and no new warnings. This is race-safe: an entry Rust adds afterwards is install-after-scrub, not a lost update.
2. **Lock.**
   - Call `fsPromises.open(lockPath, O_RDWR | O_CREAT | UV_FS_O_EXLOCK)`.
   - Build `lockPath` as `path.join(dirname, \`.${basename}.tandem-lock\`)`, byte-identical to Rust's `format!(".{file_name}.tandem-lock")`.
   - `const UV_FS_O_EXLOCK = 0x10000000`, commented as undocumented and checked by R2.
   - The function is Windows-only (its only caller is inside `if (isWindows)`). Say so in its docblock rather than adding a platform branch.
   - **`EBUSY`:** sleep on Rust's schedule (200, 500, 1500, then 5000 ms) through an injectable `opts.sleep`, until the sleeps sum to 30 000 ms, then `throw new Error(\`cannot lock ${filePath} — skipped\`)`.
   - **`ENOENT`** (the directory vanished since the pre-check): return `false` silently.
   - **Any other error** (`EPERM`, `EACCES`, …): throw the same path-only error. **Never write without the lock.**
   - The throw lands in the existing per-workspace catch (`:676`), which logs and counts `failures++`.
3. **Under the lock:** re-read, re-parse and re-`mutate`, with the same handling as step 1. Then write the tmp file and rename it. `close()` the handle in a `finally`. The lockfile stays in place, as Rust leaves it.
4. Replace the docblock's "trusts its callers (consistent with `with_locked_json`)" with the cross-language contract: the same sibling name, a share-mode exclusion against fs2's `LockFileEx`, and the undocumented flag.

**`cowork_atomic_json.rs`. This change is required, not polish.**
- **Why:** `.open(&lock_path)?` sits outside the backoff loop (`:153-158`). While Node holds its handle, Rust fails immediately with os error 32 (`WriteStatus::Failed`) instead of waiting. The install flow writes the three files in separate calls with no rollback, so that failure would leave a partial registration.
- **Change:** move the open into the loop, and add `fn is_lock_contention(e: &io::Error) -> bool`.
  - It is true for `WouldBlock`, or for `cfg!(windows) && raw_os_error() == Some(32)`. Raw 32 is `EPIPE` on Linux, hence the `cfg!`.
  - Apply it to both the open error and the lock error, so contention ends as `LockTimeout` within the same budget.
  - Comment beside the lock name that renaming the lockfile on either side silently removes the exclusion.

**Docs.**
- `docs/security.md:485`: remove (i) from "What is NOT accepted here". State #1600 as fixed and name the mechanism. Name the residual: the Node half rests on an undocumented libuv flag, checked only against the Node on the `windows-latest` image.
- The config-writer `why` string: the writer now takes the lock. Keep `sites: 2`, and run the test to confirm the new `fsPromises.open` does not change the count.

## Tests

**vitest, `tests/cli/uninstall-scrub.test.ts` (runs on ubuntu `check`).** Add `open: _openSpy` to the `node:fs` promises mock, defaulting to resolve `{ close: _closeSpy }`, and pass `{ sleep: vi.fn() }`. The existing `rewriteJson` cases stay green.
1. **Lock name and flags.** The `open` call receives `path.join("/fake", ".installed_plugins.json.tandem-lock")` and `O_RDWR | O_CREAT | 0x10000000`.
2. **Order** (`invocationCallOrder`): pre-check `readFile` < `open` < locked `readFile` < `writeFile` < `rename` < `close`.
3. **`EBUSY`, `EBUSY`, then success.** It writes, and `sleep` is called with `200` and then `500`.
4. **`EBUSY` forever.** It rejects with a message containing the path. `readFile` runs exactly once, `writeFile` and `rename` never run, and the sleeps sum to at least 30 000.
5. **`EPERM` on the lock open** (`_openSpy.mockRejectedValueOnce(Object.assign(new Error("EPERM"), { code: "EPERM" }))`). It rejects, `readFile` runs exactly once, and `writeFile`, `rename` and `sleep` are never called. This kills a fail-open fall-through and a best-effort try around the lock.
6. **`ENOENT` on the lock open.** It resolves `false`, with no `warn`, no `writeFile` and no `rename`.
7. **The data file is absent.** It returns `false` with **zero `open` calls** and no `warn`.
8. **`mutate` returns `false`.** It returns `false` with zero `open` calls.

**Rust, `cowork_atomic_json.rs` `#[cfg(test)]`.**
- **R1 (all three `rust-test` legs):** `WouldBlock` → `true`; `from_raw_os_error(32)` → `cfg!(windows)`; `NotFound` → `false`.
- **R2, `#[cfg(windows)]`** (the required `windows-latest` `rust-test` leg). It spawns `node -e` with the literal `0x10000000`. **If `node` cannot be spawned it panics and names the binary. It never skips.**
  - *Node holds:* Rust's `OpenOptions` open fails with 32. `with_locked_json` started on a thread returns `Ok` once the child releases.
  - *Rust holds* (`mutate` blocks on a channel): the Node child's open prints `EBUSY`.
  - The windows leg has no `setup-node` step, so the first CI run is also the first proof that `node` is on PATH. If it is missing, the fix is a `setup-node` step, never a skip.

**Mutation-test**, restoring from a file copy and never `git checkout`:

| Mutation | Must go red |
|---|---|
| the EXLOCK bit, or the lock name | 1 |
| writing from the unlocked read | 2 |
| the retry | 3 |
| the timeout throw changed to `return false` | 4 |
| the non-EBUSY fall-through | 5 |
| `open` moved before the pre-check | 7, 8 |
| the raw-32 arm | R1, and R2's "Node holds" half |

## CI legs, stated honestly

- The vitest cases run on ubuntu `check`, against mocks only.
- R1 runs on all three `rust-test` legs.
- **R2 is the only execution of the real interop**, on `windows-latest`, against that image's Node and not the user's.
- A local Windows run of R2 is pre-push evidence only.

## Done when

- Cases 1-8, R1 and R2 are green and mutation-checked.
- `config-writer-set-claims` and `security-findings-claims` pass.
- The PR body carries the probe table, the libuv-flag residual and the legs above.
- **Build `## Closes` last.** It includes #1600 only if R2 ran green on CI, the `bryan` note records that the #1600 policy half is resolved by this PR (Bryan confirmed lock-over-accept-or-route-through-Rust and accepted the undocumented-flag residual), and no remaining work against #1600 is named anywhere. Otherwise #1600 is Refs, and the ledger's `#1600 policy half` DECIDE entry (`docs/plans/2026-09-06-open-issues-sweep.md:54`) stays in place.

## bryan

- **The #1600 policy half.** The sweep ledger (`docs/plans/2026-09-06-open-issues-sweep.md:54`) holds `#1600 policy half` as an open DECIDE item, and scopes this group to the fix half only (`:99`). The issue offered three routes: take the lock, route the npm scrub's writes through Rust, or document an acceptance next to #1599. Landing option 1 **picks the first route**, so it resolves the policy half only if Bryan agrees with that pick.
  - **Residual to accept:** the Node side of the lock rests on libuv's **undocumented** raw open flag `0x10000000` (`UV_FS_O_EXLOCK`, share mode 0), not exported in `fs.constants`. It is checked only by R2, against the Node on the `windows-latest` image, not the user's Node. A future libuv that drops or renumbers the flag would turn the lock into one that excludes nothing; R2 is the only thing that would notice.
  - **Ask:** confirm lock-over-accept-or-route-through-Rust, and accept the residual. With that confirmation recorded here, #1600 may go in `## Closes`. Without it, #1600 is Refs and the ledger's DECIDE entry stays.

## Not in scope

The MCP-config writers under #1599 (accepted). The `rotate-token.ts:160-169` Cowork re-walk gap. Per-file failure accounting within a workspace.

## Review corrections (scope cut)

- **Removed:**
  - the `scrubCoworkWorkspace` extraction and per-file try/catch, with its test. The existing per-workspace catch already counts the thrown lock failure.
  - the `ScrubLockError` class. A plain path-only `Error` does the same job.
  - the call-time platform computation of the EXLOCK bit, with its test. The function is Windows-only by its sole caller, so the flag is constant.
  - the Rust/TS lock-name source pin (a drift guard). Case 1 and R2's hard-coded name cover the name.
  - the rejecting-`rename`-still-closes case.
  - the census regex blind-spot essay in the `why` string.
- **Kept, because the fix is unsafe without them:** the Rust open-inside-loop (without it, the Node lock turns a Rust install into a partial registration), and R2 (the only proof of an undocumented flag).
- **Blocking finding 2** (lock before read leaves residue and adds warnings): fixed directly by the pre-check, with cases 6-8.
- **Blocking finding 3** (nothing tests "never write without the lock"): fixed directly by case 5, which is in the mutation table.
- **Option 2 re-examined and rejected on evidence:** the MSI target skips the NSIS hook, and `data-locations.md:173` promises the npm scrub removes Cowork registration.

## Review corrections (post-cut)

- **Finding: `Closes #1600` silently dropped the ledger's `#1600 policy half` DECIDE item.** Adopted as given. The header now defaults to Refs; a `bryan` item states that option 1 resolves the policy half by picking the lock route, names the undocumented-`0x10000000` residual, and asks Bryan to confirm; `Done when` puts #1600 in `## Closes` only if that note records the confirmation, otherwise Refs with the ledger entry left in place. No mechanism, test or file list changed.

## Orchestrator correction (2026-09-15, after PR #2006 opened)

- **`UV_FS_O_EXLOCK` is not undocumented.** It is public libuv API: `include/uv/win.h` defines it as `0x10000000`, and libuv's `docs/src/fs.rst` documents it as supported on macOS and Windows. What is true is narrower: Node does not export it in `fs.constants`. The comments and `docs/security.md` now say that.
- **The policy half is resolved in this PR, not left to Bryan.** Real interop was measured in both directions and a hand security review found it sound. That was the condition the launch notes set for keeping the decision off Bryan's list. Of the issue's three routes, sending the npm scrub's writes through Rust is impossible for an npm-only install, which has no desktop binary. An acceptance next to #1599 would keep a lost-update race that a working fix now closes. The lock route dominates both, and with the flag being public API, its residual is ordinary dependency risk. `Closes #1600` is gated on the required windows `rust-test` leg running `lock_interop_tests` green.
