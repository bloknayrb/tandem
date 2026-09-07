# F-config — #1760 No CLI path removes the channel shim; `--target=claude-desktop` deletes a hand-registered one

Branch `fix/push-paths-config-1760`. Closes #1760. Ledger:
`docs/reviews/2026-09-02-v1-review/areas/shared-cli.md:15` (H, `[ran]`).

## Problem

`resolveChannelShimIntent` (`src/server/integrations/apply.ts:2267-2275`) is `if
(targetPushSupport(kind) === "none") return false; if (override !== undefined) return override;
return await targetHasChannelEntry(configPath);`. Two consequences:

- **Claude Code, no flag → preserve.** `README.md:230` and `docs/architecture.md:577` say re-running
  `tandem setup --apply` without the flag removes the shim. It does not, and no flag removes it —
  `setup.ts:191-192` says so explicitly. The only removal command is `tandem --uninstall-scrub`
  (`src/cli/index.ts:103`, `docs/cli.md:45`), a whole-scrub that also removes `mcpServers.tandem`,
  the installed skill and the Cowork registration, so it is not a shim-only path.
- **Claude Desktop, any flag or none → delete.** `targetPushSupport("claude-desktop") === "none"`,
  so the `none` arm answers `false` before the override is read and `applyOpsForCli`
  (`apply.ts:276-281`) turns that into `remove: ["tandem-channel"]`. Even `--with-channel-shim`
  deletes the entry.

A `none` kind is a ceiling on **creation**, never a licence to remove — `docs/architecture.md:577`
already states the rule ("Nothing on disk distinguishes a legacy artifact from a deliberate
opt-in").

## Fix

- **`apply.ts#resolveChannelShimIntent`** — override first; `none` bounds only creation:

  ```ts
  if (override === true) {
    return targetPushSupport(targetKind) === "none"
      ? await targetHasChannelEntry(configPath)
      : true;
  }
  if (override === false) return false;
  return await targetHasChannelEntry(configPath);
  ```

  Rewrite the docblock's three-way list to match: explicit `true` is a ceiling on creation (an
  existing entry is preserved, none is conjured, none is deleted); explicit `false` removes on every
  kind and is the only removal path; no flag preserves on every kind, and a read failure still
  throws rather than answering `false`. `shouldRegisterChannelShim` is not touched.
  `targetHasChannelEntry`'s docblock (`:2229-2237`) claims a malformed config answers `false`
  because "`applyConfig` will start that file fresh anyway" — false after #1802; correct that clause
  to "because `applyConfig` refuses the file before any op is applied".
- **Split "preserve" from "write" in both consuming loops** — `src/cli/setup.ts#writeTargets`
  (`:194-206`) and `apply.ts#applyConfigWithToken` (`:2314-2325`). Without it the resolver's new
  `true` on a `none` kind re-derives the hand-registered entry's body through `buildMcpEntries`
  (`apply.ts:452-487`, not target-gated) and re-arms #1299's "Registered for: Claude Desktop":

  ```ts
  const preserveShim = await resolveChannelShimIntent(t.kind, t.configPath, opts.withChannelShim);
  const writeShim = preserveShim && targetPushSupport(t.kind) !== "none";
  const entries = buildMcpEntries(CHANNEL_DIST, { withChannelShim: writeShim, targetKind: t.kind });
  await applyConfig(t.configPath, applyOpsForCli(entries, { withChannelShim: preserveShim }));
  ```

  Illustrative for `writeTargets`; only the `withChannelShim` arguments change.
  `applyConfigWithToken` keeps its `token: token ?? undefined` (dropping it breaks
  `tandem rotate-token`, `tests/cli/setup.test.ts:625-638`). `shimRegisteredFor.push`
  (`setup.ts:206`) is gated on `writeShim`. `targetPushSupport` comes from
  `../shared/integrations/contract.js` — a new import in `setup.ts`; `apply.ts` has it at `:53`.
  Deliberate consequence, recorded in `applyConfigWithToken`'s docblock and the PR body: a preserved
  `none`-kind entry is never refreshed, so it keeps a rotated-away `TANDEM_AUTH_TOKEN` where today
  it is deleted — the price of not destroying a hand-registered entry.
- **`src/cli/setup.ts`** — new exported pure parser beside `parseTargetArgs`:
  `parseChannelShimArgs(args: string[]): { intent?: boolean; conflict: boolean }` —
  `--with-channel-shim` → `true`, `--without-channel-shim` → `false`, both → `conflict`, neither
  → `{}`. Add the flag to `printGuidance`'s "Honors …" line (`:76`).
- **`src/cli/index.ts:144`** — use the parser instead of `args.includes(...) || undefined`; on
  `conflict`, `console.error` a one-line refusal and `process.exit(1)` before any write. Add
  `--without-channel-shim` to the usage block at `:49`.
- **Docs.** `README.md:230` and `docs/architecture.md:577`: "re-run `tandem setup --apply` without
  the flag" → "run `tandem setup --apply --without-channel-shim`", naming no second command. Add
  the flag to the enumerations at `docs/architecture.md:829` and `:1060` and a row to
  `docs/cli.md:32`. `CHANGELOG.md:340` carries the same false sentence and is **not** edited
  (pipeline rule) — listed for Bryan.
- No route, tool, Y.Doc write, `data-testid` or config writer; `skills/tandem/SKILL.md` is not
  edited, so no version bump.

## Tests

`tests/server/integrations/apply.test.ts`, new `describe` driving the real resolver against a
scratch config file:

1. `claude-desktop`, no override, entry present → `true` (today `false` → REMOVE; the headline).
2. `claude-desktop`, override `true`: entry present → `true`; entry absent → `false` (nothing is
   conjured on a kind that cannot deliver, #1299).
3. `claude-desktop` and `claude-code`, override `false` → `false`. The single removal path.
4. `claude-code`, no override: entry present → `true`; absent → `false`; config missing → `false`.

`tests/cli/parse-targets.test.ts` (`parseTargetArgs`'s home): `parseChannelShimArgs` for the four
inputs, including `conflict`.

**`tests/cli/setup.test.ts:601-623` asserts the behaviour this issue reverses and is inverted, not
deleted.** `it("does not conjure a shim into a config that lacks one, on any target kind")` is
misnamed — its Claude Desktop fixture (`:606-611`) *holds* `mcpServers["tandem-channel"]` and it
asserts `toBeUndefined()` at `:622`, citing #1299. Rename to `"preserves a hand-registered shim on a
no-push target"`, give the fixture a distinctive body
(`{"command":"/opt/custom/node","args":["/hand/rolled/shim.js"],"env":{"X":"1"}}`), run
`applyConfigWithToken` once with no flag and once with `withChannelShim: true`, and after each
assert `desktop.mcpServers["tandem-channel"]` `toEqual`s that object — scoped to that key, because
`buildMcpEntries` always also writes `mcpServers.tandem`. That assertion is the only thing that can
observe the no-re-derive rule. Add a sibling keeping the original invariant: a Claude Desktop
fixture with **no** `tandem-channel`, no flag, still absent.

`tests/cli/run-setup-apply.test.ts` mocks `resolveChannelShimIntent` (`:27`). Two changes: assert
`toHaveBeenCalledWith("claude-code", <path>, false)` after `runSetup({ apply: true, withChannelShim:
false })`; and re-point the two targets of `it("does not credit a target whose config write
failed")` (`:202-226`) at two **push-capable** targets, or the `writeShim` gate excludes Claude
Desktop before the write outcome is known and that spec passes vacuously.

## Done when

No flag preserves on every target; `--without-channel-shim` is the only removal path and works on
every kind; `--with-channel-shim` on a no-push target neither creates nor deletes nor announces a
registration; a preserved entry's **value** is unchanged after both runs (the file's bytes always
change — `applyConfig` re-serialises the whole root); the four live doc sites name
`tandem setup --apply --without-channel-shim`; typecheck + the touched suites green.

## Not in scope

`CHANGELOG.md:340` (Bryan). `shouldRegisterChannelShim` and the wizard's no-override call.
`tandem --uninstall-scrub`'s scrub path.

## Review corrections (scope cut)

Rounds 1–3 are superseded; their findings survive only where the code change still needs them.

**Removed**

- The `console.error` "`--with-channel-shim` has no effect here" line on `none` kinds and the
  `run-setup-apply.test.ts` push-status case pinning it — new user-facing copy the issue did not ask
  for, and `printPushStatus` already reports "Not registered".
- Resolver tests 2c and 5 (unreadable-config `rejects`, EISDIR fixtures): one pinned behaviour that
  already exists, the other an error path the issue does not describe. The throw-rather-than-`false`
  rule stays stated in the docblock.
- Long-form rationale (rotate-token remanence, the `channel-shim-optin-claims.test.ts`
  thirteen-surface census, byte-identical vs value) compressed to a line each. No scanner, drift
  guard or new gate is added.

**Kept, because a finding targeted it**

- `tandem uninstall` does not exist. The Problem section and the docs bullet name
  `tandem --uninstall-scrub`, and the docs bullet prescribes no second command — naming a
  whole-scrub as a shim-only removal path would repeat the defect this issue closes.
