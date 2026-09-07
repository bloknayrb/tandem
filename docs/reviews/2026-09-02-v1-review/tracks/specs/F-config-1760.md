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
- **Claude Desktop, no flag → delete.** `targetPushSupport("claude-desktop") === "none"`, so the
  `none` arm answers `false` *before* the override is read, and `applyOpsForCli`
  (`apply.ts:276-281`) turns `false` into `remove: ["tandem-channel"]`. `setup --apply
  --target=claude-desktop` therefore deletes a hand-registered entry with no flag, and no flag can
  keep it.

The `none`-first ordering was deliberate (the docblock at `:2250-2258` calls the deletion "the
intended cleanup" of default-on-era entries). #1760 reverses that judgement for the *no-flag* case
only: a silent delete is not a cleanup a user asked for. The refusal to honour
`--with-channel-shim` on a `none` target stays — no flag conjures a transport.

## Fix

- **`apply.ts#resolveChannelShimIntent`** — override first, `none` only as a ceiling on `true`:

  ```ts
  if (override === true) return targetPushSupport(targetKind) !== "none";
  if (override === false) return false;
  return await targetHasChannelEntry(configPath);
  ```

  Rewrite the docblock's three-way list to match: (1) explicit `true` → honoured unless the kind
  has no push transport; (2) explicit `false` → remove, on every kind; (3) no flag → preserve
  what is registered, on every kind, and a read failure still **throws** rather than answering
  `false` (an `EBUSY` must not become a deletion — both callers run this inside their per-target
  `try`). `shouldRegisterChannelShim` is a different question and is **not** touched.
- **`src/cli/setup.ts`** — new exported pure parser beside `parseTargetArgs` (same precedent, same
  reason: testable without spawning the CLI):
  `export function parseChannelShimArgs(args: string[]): { intent?: boolean; conflict: boolean }`
  — `--with-channel-shim` → `true`, `--without-channel-shim` → `false`, both → `conflict: true`,
  neither → `{}`. Add `--without-channel-shim` to `printGuidance`'s "Honors …" line (`:76`).
  `writeTargets` is unchanged; it already passes `opts.withChannelShim` straight through.
- **`src/cli/index.ts:144`** — replace `withChannelShim: args.includes("--with-channel-shim") ||
  undefined` with the parser; on `conflict`, `console.error` a one-line refusal and `process.exit(1)`
  before any write. **stdout stays reserved** (Critical Rule 3) — `console.error`, like every other
  line in this file. Add `--without-channel-shim` to the usage block at `:58`.
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
2. `claude-desktop`, override `true` → `false`. Kills the naive reorder that puts the override
   first and lets a flag write an entry that cannot deliver.
3. `claude-desktop`, override `false` → `false`; `claude-code`, override `false` → `false`. Kills
   a fix that adds the flag to the CLI but never reaches the resolver.
4. `claude-code`, no override, entry present → `true`; entry absent → `false`; config missing →
   `false`. Pins the preserve arm both ways.
5. Unreadable config (chmod `000` on POSIX, skip on win32) with no override → **rejects**. Kills a
   "simplification" that folds a read error into `false` and turns an antivirus lock into a delete.

`tests/cli/setup.test.ts`, beside the `parseTargetArgs` specs: `parseChannelShimArgs` for the four
inputs, including `conflict` when both flags appear — kills a silent-precedence implementation.

`tests/cli/run-setup-apply.test.ts` mocks `resolveChannelShimIntent`, so it cannot pin the wiring
and is not extended; state that in the PR body rather than adding a mock-asserting test.

## Done when

`resolveChannelShimIntent` preserves on every target absent a flag; `--without-channel-shim`
removes on every target; `--with-channel-shim` still refuses on a no-push target; the two live
docs name a command that works; typecheck + the touched suites green.

## Not in scope

`CHANGELOG.md:340` (Bryan). `shouldRegisterChannelShim` and the wizard's no-override call. Whether
the shim should exist at all. `tandem uninstall`'s scrub path.
