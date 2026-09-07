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
  It does not. The only removal command that exists today is **`tandem --uninstall-scrub`**
  (`src/cli/index.ts:103`, documented at `docs/cli.md:45`) — and that is a whole-scrub, not a
  shim-only path: it also removes `mcpServers.tandem`, the installed skill and (Windows) the Cowork
  registration. So there is no way to remove the shim alone. There is no `--without-channel-shim` — the
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

  **The snippet is illustrative for `writeTargets`, not a literal patch for both loops.** Only the
  `withChannelShim`/`targetKind` arguments change. `applyConfigWithToken` (`apply.ts:2318-2322`)
  **keeps its `token: token ?? undefined`** — drop it and `buildMcpEntries` (`apply.ts:452-487`)
  emits no `headers.Authorization` and no `env.TANDEM_AUTH_TOKEN`, breaking `tandem rotate-token`
  (caught by `tests/cli/setup.test.ts:625-638`, "rewrites the token either way"). `writeTargets`
  keeps its `✓` print and its `shimRegisteredFor.push`.

  `targetPushSupport` is **not** exported from `apply.ts` — add
  `import { targetPushSupport } from "../shared/integrations/contract.js";` to `src/cli/setup.ts`
  (which today imports only from `../server/integrations/apply.js`, `setup.ts:1-18`); `apply.ts`
  already imports it at `:53`.

  `applyOpsForCli` keeps the **preserve** boolean, so `remove` stays `[]`; the entry is in neither
  `create` nor `remove`, so its **value** survives unchanged. (Not the file's bytes: `applyConfig`
  re-serialises the whole root through `JSON.stringify(…, null, 2)` on every run regardless.) In
  `writeTargets`, `shimRegisteredFor.push`
  (`setup.ts:206`) is gated on `writeShim`, not `preserveShim`. When `opts.withChannelShim === true`
  and the kind is `none`, print one `console.error` line naming the target
  (`  <label>: --with-channel-shim has no effect here (no channel transport); any existing entry
  was left alone.`) — the refusal is now visible instead of silent.

  **Consequence, deliberate and stated out loud:** on a `none` kind the preserved entry's body is
  never refreshed, so a hand-registered Claude Desktop `tandem-channel` entry survives
  `tandem rotate-token` still carrying the **old, now-revoked `TANDEM_AUTH_TOKEN`**, where today it
  is deleted. `rotate-token.ts:152-159` prints only `result.errors` and this is not an error, so the
  user sees nothing. That is the price of not destroying a hand-registered entry, and it is the
  right trade — a dead token in an inert entry on a target with no channel transport is not a
  credential leak, and #1299's own rule is that nothing on disk distinguishes a legacy artifact
  from a deliberate opt-in. Record it in `applyConfigWithToken`'s docblock and in the PR body. No
  behaviour beyond what the resolver change already implies.

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
  the flag" → "run `tandem setup --apply --without-channel-shim`". **No parenthetical naming a
  second command.** `tandem uninstall` does not exist — the only removal subcommand is
  `tandem --uninstall-scrub` (`src/cli/index.ts:103`; the usage block at `:67` and `docs/cli.md:45`
  both spell it that way), and even that is a whole-scrub rather than a shim-only removal, so naming
  it here would prescribe the wrong command for the stated purpose. Writing a nonexistent command
  into the same sentence that fixes a nonexistent command is the defect this issue closes, and
  nothing in the suite would catch it (see the `channel-shim-optin-claims` note below).
  `docs/cli.md:32`: add the `--without-channel-shim` row. **Two more live enumerations of the flags
  `setup --apply` honors go stale the moment `--without-channel-shim` lands and are easy to miss:**
  `docs/architecture.md:829` ("non-interactive; honors `--force`, `--target=<kind>`,
  `--with-channel-shim`") and `docs/architecture.md:1060` (`tandem setup --apply [--force]
  [--target=<kind>] [--with-channel-shim]`). Both take the new flag. **`CHANGELOG.md:340` carries the same
  false sentence and is NOT edited** — the pipeline forbids touching that file and the entry is a
  shipped release record; listed for Bryan instead.
  `tests/docs/channel-shim-optin-claims.test.ts` scans **thirteen** surfaces
  (`tests/docs/channel-shim-optin-claims.test.ts:62-75`), not three: `README.md`,
  `docs/troubleshooting.md`, `docs/user-guide.md`, `docs/cli.md`, `skills/tandem/SKILL.md`,
  `src/cli/doctor.ts`, `src/cli/setup.ts`, `src/server/integrations/apply.ts`,
  `src/server/integrations/api-routes.ts`, `IntegrationWizardModal.svelte`, `PushRoutesInfo.svelte`
  and `SettingsClaudeCodeTab.svelte`. Its patterns are wizard-anchored (`APP_REGISTERS`, `:82-86`),
  so removal wording that names only the CLI does not trip it — keep it that way (no "from the
  wizard" phrasing). **It validates no CLI verb**, which is why the `tandem uninstall` correction
  above has to be made by reading rather than by the suite. `skills/tandem/SKILL.md` is on that
  surface list but is **not** edited by this spec, so the "no version bump" claim below stays true;
  if a later revision does add removal wording there, the frontmatter `version` bump and the literal
  in `tests/skill-instruction-contract.test.ts` come with it.
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
   #1299); config **unreadable** → **rejects**. Kills both the naive reorder that lets a flag write
   an unusable entry *and* the delete-on-`--with-channel-shim` path that is the issue's own headline
   harm. The third case exists because the reorder introduces I/O on a path that has none today:
   the `none` arm at `apply.ts:2272` returns `false` before `targetHasChannelEntry` is ever called,
   so after the fix a transient `EBUSY`/`EISDIR` turns a previously-succeeding
   `--with-channel-shim --target=claude-desktop` into a per-target failure. Pin that as the intended
   outcome (failing a target you could not read beats deleting its entry), using the same
   EISDIR/directory idiom as test 5.
3. `claude-desktop`, override `false` → `false`; `claude-code`, override `false` → `false`. Pins
   `--without-channel-shim` as the single removal path on every kind. (This calls the resolver
   directly, so it does **not** discriminate an unwired CLI flag — the wiring hop is pinned in
   `run-setup-apply.test.ts` below.)
4. `claude-code`, no override, entry present → `true`; entry absent → `false`; config missing →
   `false`. Pins the preserve arm both ways.
5. **Kind `claude-code`**, unreadable config, no override → **rejects**. The kind is load-bearing:
   on today's code only `claude-code` reaches the read at all (the `none` arm at `apply.ts:2272`
   short-circuits first), so a `claude-desktop` fixture here would be green today for the wrong
   reason and would pin nothing. A regression pin, not a kill: today's code
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

**`tests/cli/setup.test.ts:601-623` asserts exactly the behaviour this issue reverses and is
INVERTED, not deleted.** `it("does not conjure a shim into a config that lacks one, on any target
kind")` is misnamed: its Claude Desktop fixture (`:606-611`) **does** hold
`mcpServers["tandem-channel"]`, it runs the real `applyConfigWithToken(…, { homeOverride: home })`
with no flag, and it asserts `toBeUndefined()` at `:622` under the comment "Claude Desktop has no
push transport at all, so a shim there is removed regardless of what the file said (#1299)". That
comment is the judgement #1760 reverses. Under the new resolver the read returns `true`,
`applyOpsForCli` emits `remove: []`, and the entry survives — so the spec goes red and the obvious
"repair" is to revert the fix. Do this instead:

- Rename to `"preserves a hand-registered shim on a no-push target"` and assert `toBeDefined()`.
  Rewrite the `:617-619` comment: a `none` kind is a **ceiling on creation**, not a licence to
  delete.
- **Give the fixture a distinctive body and assert the entry's VALUE back verbatim, twice** — this
  is the only test in the repo that can observe the no-re-derive clause in "Done when". Write
  `{"tandem-channel":{"command":"/opt/custom/node","args":["/hand/rolled/shim.js"],"env":{"X":"1"}}}`,
  run `applyConfigWithToken` **once with no flag and once with `withChannelShim: true`**, and after
  each assert
  `expect(desktop.mcpServers["tandem-channel"]).toEqual({command:"/opt/custom/node",args:["/hand/rolled/shim.js"],env:{X:"1"}})`.
  **Scope the `toEqual` to that one key, never to `mcpServers` as a whole**: `buildMcpEntries`
  (`apply.ts:452-487`) always emits a `tandem` entry — a stdio one for `claude-desktop` — and
  `applyConfig` merges `ops.create` into `mcpServers`, so `mcpServers.tandem` is *expected* to appear
  alongside the preserved key and a whole-object `toEqual` is red for the wrong reason. Without this
  case, a lazy implementation that gates only
  `shimRegisteredFor.push` on `writeShim` while still passing `preserveShim` into `buildMcpEntries`
  passes every other named test and silently rewrites the user's entry onto `resolveNodeBinary()` +
  `CHANNEL_DIST`. Nothing existing covers it: `setup.test.ts:566-580` asserts only `toBeDefined()`,
  `run-setup-apply.test.ts:19` mocks `buildMcpEntries` to `() => ({})`, and `applyConfigWithToken`'s
  docblock (`apply.ts:2288-2292`) says the entry BODY is deliberately re-derived **today** — so the
  new no-re-derive rule for `none` kinds is asserted by nobody until this case exists.
- **Keep the original invariant under its own name**: add a sibling whose Claude Desktop fixture has
  **no** `tandem-channel`, run with no flag, assert it is still absent. That is what "does not
  conjure" was supposed to say.

`tests/cli/run-setup-apply.test.ts` mocks `resolveChannelShimIntent` as a `vi.fn` (`:27`), which is
exactly what lets it pin the `opts → resolver` hop at zero cost. Three changes:

- After `runSetup({ apply: true, withChannelShim: false })`,
  `expect(resolveChannelShimIntent).toHaveBeenCalledWith("claude-code", <path>, false)`. Kills a fix
  that adds the flag to the parser but never threads it to the resolver.
- Push-status guard, run with **`runSetup({ apply: true, withChannelShim: true })`**:
  `resolveChannelShimIntent` mocked `true`, `detectTargets` → `[CLAUDE_DESKTOP]`; assert the
  stripped stderr contains "Not registered", **not** "Registered for:", **and** the new
  `"has no effect here"` line. This is the spec that keeps the resolver's new `true` from re-arming
  #1299 — the invariant at `run-setup-apply.test.ts:154-156` is being deliberately replaced, so its
  comment is rewritten in the same commit. The `withChannelShim: true` argument is load-bearing:
  the `console.error` is gated on `opts.withChannelShim === true`, so a case that passes no flag (or
  `false`) cannot observe it, and "Done when"'s *"says so out loud"* clause would be pinned by
  nothing.
- **Repair `it("does not credit a target whose config write failed")` (`:202-226`), which the
  `writeShim` gate silently defangs.** It mocks the resolver `true` for both targets, uses
  `[CLAUDE_CODE, CLAUDE_DESKTOP]`, fails the *second* `applyConfig`, and asserts the status line
  excludes "Claude Desktop"; its own comment states the invariant ("Hoisting that line above the
  await would make this pass"). Once `shimRegisteredFor.push` is gated on
  `writeShim = preserveShim && targetPushSupport(t.kind) !== "none"`, Claude Desktop is excluded
  **before the write outcome is known** (`targetPushSupport("claude-desktop") === "none"`,
  `src/shared/integrations/contract.ts:203`) and the assertion passes for the wrong reason — it
  would pass whether or not the push stays after the `await`. Re-point its two targets at two
  **push-capable** targets (a second `claude-code` `DetectedTarget` with a distinct `label` and
  `configPath`) so the failing write is again the only thing that can drop a label from the line.

Only `src/cli/index.ts`'s argv hop then remains untested (entrypoint, by repo convention) — say so
in the PR body.

## Done when

`resolveChannelShimIntent` preserves on every target absent a flag; `--without-channel-shim` is the
only path that removes, and it removes on every kind; `--with-channel-shim` on a no-push target
neither creates nor deletes and says so out loud (pinned by the `withChannelShim: true`
push-status case in `run-setup-apply.test.ts`); **a preserved Claude Desktop `tandem-channel`
entry's VALUE is unchanged after a no-flag run and after a `--with-channel-shim` run** — pinned by
the inverted `tests/cli/setup.test.ts:601-623`, whose `toEqual` against the hand-rolled
`{command,args,env}` fixture is the only thing that can observe it. (Not "byte-identical": every
`applyConfig` run re-serialises the whole file through `JSON.stringify(…, null, 2)`, so the file's
bytes change either way; what is preservable, and what the test observes, is the entry's value.)
The entry is not announced as registered; the four live doc sites (`README.md:230`,
`docs/architecture.md:577`, `:829`, `:1060`, plus the `docs/cli.md` row) name commands that exist —
`tandem setup --apply --without-channel-shim`, and `tandem --uninstall-scrub` wherever the scrub is
already named; typecheck + the touched suites green.

## Not in scope

`CHANGELOG.md:340` (Bryan). `shouldRegisterChannelShim` and the wizard's no-override call. Whether
the shim should exist at all. `tandem --uninstall-scrub`'s scrub path.

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

## Review corrections (round 2)

**Adopted**

- *(blocking, twice — same finding from two reviewers)* `tests/cli/setup.test.ts:601-623`
  (`"does not conjure a shim into a config that lacks one, on any target kind"`) was missing from
  the test ledger and asserts exactly the behaviour this fix reverses: its Claude Desktop fixture
  **holds** `tandem-channel` and it asserts `toBeUndefined()`, citing #1299. Under the new resolver
  it goes red with the fix's own reversion as the obvious repair. The Tests section now specifies
  the inversion (rename, `toBeDefined()`, rewritten `:617-619` comment) plus a sibling case that
  keeps the original "does not conjure" invariant under its own name.
- *(blocking)* "Done when" required a preserved Claude Desktop entry to be **byte-identical** and no
  named test could observe it — `apply.test.ts` reaches only the resolver's return value,
  `parse-targets.test.ts` the parser, `run-setup-apply.test.ts` mocks `buildMcpEntries` to
  `() => ({})`, and `setup.test.ts:566-580` asserts only `toBeDefined()`. A lazy implementation that
  gates `shimRegisteredFor.push` on `writeShim` while still passing `preserveShim` into
  `buildMcpEntries` would pass everything and silently rewrite the user's entry. The inverted case
  now carries a distinctive `{command,args,env}` body, runs `applyConfigWithToken` twice (no flag,
  then `withChannelShim: true`), and `toEqual`s that object each time; "Done when" cites it.
- *(blocking)* Gating `shimRegisteredFor.push` on `writeShim` defangs
  `run-setup-apply.test.ts:202-226` (`"does not credit a target whose config write failed"`):
  `targetPushSupport("claude-desktop") === "none"` excludes Claude Desktop before the write outcome
  is known, so the assertion holds whether or not the push stays after the `await`. Its two targets
  are re-pointed at two push-capable targets.
- *(non-blocking)* The single snippet given for "both" consuming loops omitted
  `token: token ?? undefined`, which `applyConfigWithToken` really passes; copied literally it
  breaks `tandem rotate-token`. The snippet is now annotated as illustrative for `writeTargets`,
  with the token field and the `✓`/`push` lines called out as retained.
- *(non-blocking)* `targetPushSupport` is exported from `src/shared/integrations/contract.ts:203`,
  not from `apply.ts`; the import line `setup.ts` must add is now stated.
- *(non-blocking)* Recorded the deliberate consequence that a preserved `none`-kind entry keeps a
  rotated-away `TANDEM_AUTH_TOKEN` after `tandem rotate-token`, with the reason it is the right
  trade, to be repeated in the docblock and the PR body.
- *(non-blocking)* Test 2 gains a third case — `claude-desktop`, override `true`, unreadable config
  → rejects — because the reorder introduces a config read on a path that today does none, so a
  transient `EBUSY`/`EISDIR` newly fails a target that used to succeed.
- *(non-blocking)* Test 5 now names kind `claude-code`: only that kind reaches the read on today's
  code, so a `claude-desktop` fixture would be vacuously green and pin nothing.
- *(non-blocking)* `docs/architecture.md:829` and `:1060` added to the docs bullet — both enumerate
  the flags `setup --apply` honors and would silently go incomplete.

**Not adopted**

- None.

**File-set change:** this spec now also touches `tests/cli/setup.test.ts`,
`docs/architecture.md:829` and `docs/architecture.md:1060`, and adds a
`src/shared/integrations/contract.js` import to `src/cli/setup.ts`.

## Review corrections (round 3)

**Adopted**

- *(blocking)* The docs bullet prescribed writing **`tandem uninstall`** into `README.md:230` and
  `docs/architecture.md:577` as a removal path, and the Problem section rested on the same command.
  That command does not exist: `src/cli/index.ts:103` dispatches only on `--uninstall-scrub`, the
  usage block at `:67` and `docs/cli.md:45` both spell it `tandem --uninstall-scrub`, and
  `tests/docs/channel-shim-optin-claims.test.ts` validates no CLI verb — so a fix whose "Done when"
  is *"the four live doc sites name a command that works"* would have shipped a second nonexistent
  command in the same sentence, silently. The parenthetical is **dropped** rather than corrected:
  `--uninstall-scrub` also removes `mcpServers.tandem`, the skill and the Cowork registration, so it
  is not a shim-only removal path and naming it there prescribes the wrong command. The Problem
  section (`:24`) and "Not in scope" are corrected to the real spelling in the same edit.
- *(non-blocking)* `"assert it back verbatim … toEqual that exact object"` was ambiguous in a way
  that fails as written: `applyConfigWithToken` also writes `mcpServers.tandem` (a stdio entry for
  `claude-desktop`, `apply.ts:452-487`), so a literal `toEqual` on `mcpServers` is red. The
  assertion is now scoped to `desktop.mcpServers["tandem-channel"]`, with `mcpServers.tandem`
  called out as expected to appear alongside it.
- *(non-blocking)* "Done when" promised a **byte-identical** preserved entry, which no test can
  observe — `applyConfig` re-serialises the whole file through `JSON.stringify(…, null, 2)` on every
  run. Reworded to the claim the `toEqual` actually pins: the `tandem-channel` entry's **value** is
  unchanged after a no-flag run and after a `--with-channel-shim` run.
- *(non-blocking)* "Done when" required `--with-channel-shim` on a no-push target to "say so out
  loud" and no named test could observe the line — the `console.error` is gated on
  `opts.withChannelShim === true` and none of the three `run-setup-apply.test.ts` changes passed it.
  The push-status guard case now runs `runSetup({ apply: true, withChannelShim: true })` and asserts
  `"has no effect here"` alongside the existing "Not registered" / not-"Registered for:" pair.
- *(non-blocking)* The `tests/docs/channel-shim-optin-claims.test.ts` surface list was described as
  three files; it is **thirteen** (`:62-75`), including `skills/tandem/SKILL.md`, `doctor.ts`,
  `api-routes.ts` and three Svelte components. Corrected, with the conclusion kept (the
  `APP_REGISTERS` patterns at `:82-86` are wizard-anchored and do not fire on CLI-only removal
  wording) and the `SKILL.md` consequence stated explicitly, so the "no version bump" claim in the
  Fix section stays true by construction rather than by luck.

**Not adopted**

- None.

**File-set change:** unchanged from round 2 — the corrections are to wording and assertions within
the already-listed files.
