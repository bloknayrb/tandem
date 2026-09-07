# F-config — #1760 No CLI path removes the channel shim; `--target=claude-desktop` deletes a hand-registered one

Branch `fix/push-paths-config-1760`. Closes #1760. Ledger:
`docs/reviews/2026-09-02-v1-review/areas/shared-cli.md:15` (H, `[ran]`). Probe: the review's
scratch-`HOME` `setup --apply` run, transcript at
`docs/reviews/2026-09-02-v1-review/raw/manifests/shared-cli.md:400-460`.

## Problem

`resolveChannelShimIntent` (`src/server/integrations/apply.ts:2267-2275`) is

```ts
if (targetPushSupport(targetKind) === "none") return false;
if (override !== undefined) return override;
return await targetHasChannelEntry(configPath);
```

Two consequences, and the docs describe neither:

- **Claude Code, no flag → preserve.** `README.md:230`, `docs/architecture.md:577` and
  `CHANGELOG.md:340` all say re-running `tandem setup --apply` without the flag removes the shim.
  It does not; only `tandem uninstall` removes it. There is no `--without-channel-shim` — the
  comment at `setup.ts:191-192` says so explicitly ("there is deliberately no
  `--no-channel-shim`"), which is right about the old default-on hazard and wrong as the whole
  story: it leaves opt-in with no opt-out.
- **Claude Desktop, any flag or none → delete.** `targetPushSupport("claude-desktop") === "none"`,
  so the `none` arm answers `false` *before* the override is read, and `applyOpsForCli`
  (`apply.ts:276-281`) turns `false` into `remove: ["tandem-channel"]`. `setup --apply
  --target=claude-desktop` therefore deletes a hand-registered entry with no flag — **and
  `--with-channel-shim` deletes it too**, because the `none` arm swallows the override before it is
  read. The one flag that means "I want the shim" is the flag that destroys the entry.

The `none`-first ordering was deliberate (the docblock at `:2250-2258` calls the deletion "the
intended cleanup" of default-on-era entries). #1760 reverses that judgement for **every** case:
refusing to *register* and choosing to *delete* are different answers, and only the first is
justified by #1299. `docs/architecture.md:577` already states the project's rule against the
second — "Nothing on disk distinguishes a legacy artifact from a deliberate opt-in, so a prune
cannot delete the first without sometimes deleting the second." A `none` kind is a **ceiling on
creation**, never a licence to remove.

## Fix

- **`apply.ts#resolveChannelShimIntent`** — override first; `none` bounds only what may be
  *created*:

  ```ts
  if (override === true) {
    return targetPushSupport(targetKind) === "none"
      ? await targetHasChannelEntry(configPath)
      : true;
  }
  if (override === false) return false;
  return await targetHasChannelEntry(configPath);
  ```

  Rewrite the docblock's three-way list to match: (1) explicit `true` → honoured as a **ceiling on
  creation only**; on a kind with no push transport an existing entry is preserved and no entry is
  ever conjured, and `--with-channel-shim` never removes one; (2) explicit `false` → remove, on
  every kind — this is the only removal path; (3) no flag → preserve what is registered, on every
  kind, and a read failure still **throws** rather than answering `false` (an `EBUSY` must not
  become a deletion — both callers run this inside their per-target `try`).
  `shouldRegisterChannelShim` is a different question and is **not** touched.

  `targetHasChannelEntry`'s own docblock (`apply.ts:2229-2237`) says unreadable/oversized/malformed
  configs "all answer `false`: there is nothing to preserve in any of them, and `applyConfig` will
  start that file fresh anyway." The second clause is false after #1802 (`applyConfig` refuses a
  malformed file) and the first is only half true (an *unreadable* config throws out of
  `readConfigForMutation`, it does not answer `false`). Rewrite it in this half of the branch:
  oversize and malformed answer `false` because `applyConfig` will refuse the file before any op is
  applied, and an unreadable one propagates.

- **`resolveChannelShimIntent` now returns `true` for a `none` kind that holds an entry, so the two
  loops that consume it must split "preserve" from "write and announce."** Without this the
  resolver's new `true` (a) re-derives the hand-registered entry's `command`/`args`/`env` through
  `buildMcpEntries` (`apply.ts:475-487`, which is not target-gated) onto `resolveNodeBinary()` +
  `CHANNEL_DIST` — a path that may not exist in a Tauri bundle (`apply.ts:82-86`) — and (b) re-arms
  the #1299 false claim, `printPushStatus` announcing "Registered for: Claude Desktop" plus a
  Claude Code-only flag. In **both** `src/cli/setup.ts#writeTargets` (`:194-206`) and
  `apply.ts#applyConfigWithToken` (`:2314-2325`):

  ```ts
  const preserveShim = await resolveChannelShimIntent(t.kind, t.configPath, opts.withChannelShim);
  // A `none` kind may carry a hand-registered entry we preserve, but we never
  // write, refresh or announce one there.
  const writeShim = preserveShim && targetPushSupport(t.kind) !== "none";
  const entries = buildMcpEntries(CHANNEL_DIST, { withChannelShim: writeShim, targetKind: t.kind });
  await applyConfig(t.configPath, applyOpsForCli(entries, { withChannelShim: preserveShim }));
  ```

  `applyOpsForCli` keeps the **preserve** boolean, so `remove` stays `[]`; the entry is in neither
  `create` nor `remove` and survives byte-for-byte. In `writeTargets`, `shimRegisteredFor.push`
  (`setup.ts:206`) is gated on `writeShim`, not `preserveShim`. When `opts.withChannelShim === true`
  and the kind is `none`, print one `console.error` line naming the target
  (`  <label>: --with-channel-shim has no effect here (no channel transport); any existing entry
  was left alone.`) — the refusal is now visible instead of silent.

- **`src/cli/setup.ts`** — new exported pure parser beside `parseTargetArgs` (same precedent, same
  reason: testable without spawning the CLI):
  `export function parseChannelShimArgs(args: string[]): { intent?: boolean; conflict: boolean }`
  — `--with-channel-shim` → `true`, `--without-channel-shim` → `false`, both → `conflict: true`,
  neither → `{}`. Add `--without-channel-shim` to `printGuidance`'s "Honors …" line (`:76`).
- **`src/cli/index.ts:144`** — replace `withChannelShim: args.includes("--with-channel-shim") ||
  undefined` with the parser; on `conflict`, `console.error` a one-line refusal and `process.exit(1)`
  before any write. **stdout stays reserved for the CLI's product surface** — the refusal goes to
  `console.error` because it precedes `process.exit(1)`; the `--help` usage block at `:49` stays
  `console.log` (that stdout *is* the product, cf. `tandem doctor --json`; Critical Rule 3's
  redirect lives in `src/server/index.ts`). Add `--without-channel-shim` to the usage block.
- **Docs.** `README.md:230` and `docs/architecture.md:577`: "re-run `tandem setup --apply` without
  the flag" → "run `tandem setup --apply --without-channel-shim` (or `tandem uninstall`)".
  `docs/cli.md:32`: add the `--without-channel-shim` row. **`CHANGELOG.md:340` carries the same
  false sentence and is NOT edited** — the pipeline forbids touching that file and the entry is a
  shipped release record; listed for Bryan instead.
  `tests/docs/channel-shim-optin-claims.test.ts` scans `README.md`, `docs/cli.md` and
  `src/cli/setup.ts`: its patterns are wizard-anchored, so removal wording that names only the CLI
  does not trip it — keep it that way (no "from the wizard" phrasing).
- Nothing here adds a route, a tool, a Y.Doc write, a `data-testid` or a config writer, so
  Critical Rules 1/2/7/9, `NON_LOOPBACK_ALLOWED` and `tests/docs/config-writer-set-claims.test.ts`
  are untouched. `skills/tandem/SKILL.md` is not edited, so no version bump.

## Tests

New `describe` in `tests/server/integrations/apply.test.ts` driving the real function against a
scratch config file (never the real `HOME` — track rule):

1. `claude-desktop`, no override, entry **present** → `true`. Kills today's code (returns `false`
   → REMOVE) and is the issue's headline.
2. `claude-desktop`, override `true`: entry **present** → `true` (preserved, and the caller must
   emit no REMOVE); entry **absent** → `false` (no entry is conjured on a kind that cannot deliver,
   #1299). Kills both the naive reorder that lets a flag write an unusable entry *and* the
   delete-on-`--with-channel-shim` path that is the issue's own headline harm.
3. `claude-desktop`, override `false` → `false`; `claude-code`, override `false` → `false`. Pins
   `--without-channel-shim` as the single removal path on every kind. (This calls the resolver
   directly, so it does **not** discriminate an unwired CLI flag — the wiring hop is pinned in
   `run-setup-apply.test.ts` below.)
4. `claude-code`, no override, entry present → `true`; entry absent → `false`; config missing →
   `false`. Pins the preserve arm both ways.
5. Unreadable config with no override → **rejects**. A regression pin, not a kill: today's code
   already throws here (`readConfigForMutation` re-throws non-ENOENT read errors,
   `apply.ts:1252-1254`). It exists so a later "simplification" cannot fold a read error into
   `false` and turn an antivirus lock into a delete. **Induce the failure structurally — point
   `configPath` at a directory (EISDIR), the idiom already used at
   `tests/cli/setup.test.ts:509-517`.** `chmod 000` is not usable: this build environment runs as
   root (`docs/plans/2026-09-06-open-issues-sweep.md`, "Environment facts"), where `DAC_OVERRIDE`
   makes a `000` file readable and the case passes vacuously. Assert `rejects` only, not an errno.

`tests/cli/parse-targets.test.ts` (**not** `setup.test.ts` — `parseTargetArgs`'s only test-tree
home): `parseChannelShimArgs` for the four inputs, including `conflict` when both flags appear —
kills a silent-precedence implementation.

`tests/cli/run-setup-apply.test.ts` mocks `resolveChannelShimIntent` as a `vi.fn` (`:27`), which is
exactly what lets it pin the `opts → resolver` hop at zero cost. Two additions:

- After `runSetup({ apply: true, withChannelShim: false })`,
  `expect(resolveChannelShimIntent).toHaveBeenCalledWith("claude-code", <path>, false)`. Kills a fix
  that adds the flag to the parser but never threads it to the resolver.
- Push-status guard: `resolveChannelShimIntent` mocked `true`, `detectTargets` → `[CLAUDE_DESKTOP]`;
  assert the stripped stderr contains "Not registered" and **not** "Registered for:". This is the
  spec that keeps the resolver's new `true` from re-arming #1299 — the invariant at
  `run-setup-apply.test.ts:154-156` is being deliberately replaced, so its comment is rewritten in
  the same commit.

Only `src/cli/index.ts`'s argv hop then remains untested (entrypoint, by repo convention) — say so
in the PR body.

## Done when

`resolveChannelShimIntent` preserves on every target absent a flag; `--without-channel-shim` is the
only path that removes, and it removes on every kind; `--with-channel-shim` on a no-push target
neither creates nor deletes and says so out loud; a preserved Claude Desktop entry is byte-identical
after the run and is not announced as registered; the two live docs name a command that works;
typecheck + the touched suites green.

## Not in scope

`CHANGELOG.md:340` (Bryan). `shouldRegisterChannelShim` and the wizard's no-override call. Whether
the shim should exist at all. `tandem uninstall`'s scrub path.

## Review corrections (round 1)

**Adopted**

- *(blocking, twice)* `--with-channel-shim --target=claude-desktop` still deleted a hand-registered
  entry under the original resolver sketch, and the spec pinned that as correct. The `none` arm for
  an explicit `true` now returns `targetHasChannelEntry(configPath)` — preserve, never create,
  never delete. Test 2 is restated as two cases (present → `true`, absent → `false`), the docblock
  arm (1) is reworded from "honoured unless the kind has no push transport" to "a ceiling on
  creation only", and the Problem section names the deletion as a second headline path.
- *(blocking)* The new `true` on a `none` kind would have re-armed #1299 (`printPushStatus`
  announcing "Registered for: Claude Desktop") and would have rewritten the preserved entry's body
  through the un-target-gated `buildMcpEntries`. Added the `preserveShim` / `writeShim` split to
  **both** consuming loops (`writeTargets` and `applyConfigWithToken`), gated
  `shimRegisteredFor.push` on `writeShim`, and added the push-status spec to
  `run-setup-apply.test.ts`.
- Parser spec re-pointed from `tests/cli/setup.test.ts` to `tests/cli/parse-targets.test.ts`.
- Dropped the false claim that test 3 "kills a fix that never reaches the resolver" (it calls the
  resolver directly); added the `toHaveBeenCalledWith` assertion to `run-setup-apply.test.ts`, which
  does pin that hop through its existing mock.
- Dropped "like every other line in this file" from the `console.error` rationale — `src/cli/index.ts:49`
  is deliberately `console.log`; Critical Rule 3's redirect lives in `src/server/index.ts`.
- Test 5's `chmod 000` replaced with the EISDIR/directory idiom (root ignores `000`), and the case
  relabelled a regression pin rather than a kill.
- `targetHasChannelEntry`'s docblock (`apply.ts:2229-2237`) added to the docblock-rewrite bullet:
  its "`applyConfig` will start that file fresh anyway" is false after #1802, and unreadable
  propagates rather than answering `false`.

**Not adopted**

- None.
