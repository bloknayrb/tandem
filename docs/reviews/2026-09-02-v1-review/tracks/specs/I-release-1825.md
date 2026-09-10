# I-release — #1825 the CI/build section only (Lows batch)

Branch `fix/release-and-ci-hygiene-1856`. **REFS ONLY — #1825 stays open.** It is a five-section
batch; this PR touches the **CI / build** section and nothing else. Its **Tauri** section belongs to
E2-rust and its **Tests** remainder to K-tests, both later in wave 7; its **Infra** section and the
CI/build `infra/` bullet already landed in #1944 (`d2cc5e08`). Ledger:
`areas/ci-build.md` rows 9–10. The PR body's `## Refs` paragraph must name **these bullets by
name** and say which sections are somebody else's — wave 6 shipped a `Refs` paragraph naming the
wrong section of this same issue.

## Problem — the CI/build bullets, each re-checked against `origin/master` fff8e312

**Fixing here (five):**

- `lint-staged` JSON key matches nothing. `package.json`'s key is the literal string
  `"**/*.json !package-lock.json"`. lint-staged keys are single micromatch patterns; a
  space-separated negation is not one, so **no JSON file is ever formatted on commit**.
- `check-font-assets` inspects a path the build never writes. `scripts/check-font-assets.mjs:5`
  filters `[dist/index.html, index.html]` by `existsSync`; `vite.config.ts:29` sets
  `outDir: "dist/client"`, so `dist/index.html` never exists and the check only ever reads the
  **source** `index.html` — never the shipped artifact it exists to check.
- Pre-push biome scope is narrower than CI's. `.husky/pre-push` runs `npx biome check src/ tests/`;
  `ci.yml:349-350` runs `npx biome check .`. `scripts/`, `infra/` and root files can fail CI after a
  green push.
- Playwright `retries: 1` with no trace. `playwright.config.ts:44` retries; its `use` block
  (`:53-56`) sets only `baseURL` and `headless` — **no `trace`, `screenshot` or `video` at all**.
- The claim about it is false. `ci.yml:506-509` says `test-results/` carries trace/video/screenshot
  artifacts "configured in playwright.config.ts via trace/screenshot/video". Nothing is configured,
  so the upload is empty on every CI-only flake.

**Refuted or already done (record in the PR body, change nothing):**

- "`publish.yml` has no `v*` tag guard" — **stale.** `publish.yml:101-111` asserts the tag equals
  `v$(package.json version)` for both the `release` and `workflow_dispatch` triggers.
- "`rust-toolchain@stable` floating" — **stale.** SHA-pinned by #1745
  (`dtolnay/rust-toolchain@4360b525… # stable`, four sites, each pinned by
  `workflow-action-pin.test.ts:240-265`).
- The CodeQL bullet duplicates **#1748 item 4** and is fixed there (config file deleted), not twice.
- The `infra/` bullet's biome/tsconfig/wrangler halves landed in #1944; its `2024-09-23` compat-date
  and `./crypto.js` esbuild-rewrite halves need a deployed Worker and are Bryan's.
- "MSI/WiX rejects non-numeric prerelease" — informational; it *bounds* #1748 item 1 rather than
  asking for a change.

## Fix

- `package.json` — `"**/*.json !package-lock.json"` → `"**/*.json"`. Safe because
  `biome.json:19-28` already carries `"!package-lock.json"` in `files.includes`, so the excluded
  file stays excluded by the tool rather than by an inert key. Verify by staging a `.json` edit and
  watching biome touch it.
- `scripts/check-font-assets.mjs:5` — `path.join("dist", "index.html")` →
  `path.join("dist", "client", "index.html")`, keeping the root `index.html` entry. **That path fix
  alone re-creates the bug it closes, and the reason the original spec text gave for why it does not
  is false.** `TARGETS` is `[…].filter(existsSync)` and the throw fires only at
  `TARGETS.length === 0`; the repo-root `index.html` is the client entry and exists in every
  checkout, so the array is never empty and **that throw is unreachable**. If the output path moves
  again, `TARGETS` becomes `["index.html"]`, length 1, and the script exits 0 having inspected only
  the source file — precisely the finding. So the fix must **assert the built file was inspected**,
  not merely offer it as a candidate:

  - Add a `--require-built` flag. Under it, the script throws when `dist/client/index.html` is
    absent. `package.json`'s `build` script passes it (`check:fonts` is also run standalone with no
    `dist/` present, so it cannot be unconditional).
  - Keep the `TARGETS.length === 0` throw as a second layer, but **stop describing it as the
    anti-vacuity guard** — it catches only the impossible zero case.
  - **Pin the flag itself.** `--require-built` *is* the anti-vacuity mechanism, and nothing reads
    `package.json`'s `build` script: drop the flag from it and `TARGETS` falls back to
    `["index.html"]`, the script exits 0 having inspected only the source file, and no test goes
    red — the exact regression the round-1 correction was written to close. This group is already
    landing `tests/scripts/release-ci-hygiene.test.ts` (#1832 owns the file), so add one assertion
    there: `JSON.parse(readFileSync("package.json", "utf8")).scripts.build` contains
    `check-font-assets.mjs --require-built`, with a comment naming it as the half that makes the
    check non-vacuous. Same delegated-half precedent this spec already invokes for `scripts.test`.

  Discriminating check, and it must be run: after `npm run build`,
  `rm dist/client/index.html && node scripts/check-font-assets.mjs --require-built` exits
  **non-zero**. That is the moved-path regression; the "insert `fonts.googleapis.com` into
  `dist/client/index.html` and watch it throw" check in `## Tests` exercises the present-file path
  only.
- `.husky/pre-push` — `npx biome check src/ tests/` → `npx biome check .`. The `files.includes` in
  `biome.json` is what bounds `.`; this makes the hook and CI the same command, which is the point.

  **This change does NOT ship alone: `biome.json` must gain two exclusions in the same commit, or
  the hook breaks every push from Bryan's main checkout.** Round 1 filed this as a possible slowness
  ("if the first run is slow, that is why; it is not a hang") and named `"!.claude/**"` as "the fix
  if it ever matters". Measured on 2026-09-10, from `C:/Users/blokn/Documents/Github/tandem` with
  biome 2.4.8, it is not slowness — it is a hard refusal:

  ```
  $ npx biome check .
  C:\...\tandem\.claude\worktrees\wt-g8\biome.json configuration ━━━
    × Found a nested root configuration, but there's already a root configuration.
  … (same for wt-i-release, and for .worktrees/tiptap-v3)
    × Biome exited because the configuration resulted in errors. Please fix them.
  ```

  Exit non-zero, **zero files checked**, in ~1.8s. Every `git worktree` checkout carries the
  repo's own tracked `biome.json`, and biome 2.x treats a nested root config under the scanned
  directory as a configuration error rather than ignoring it. CI is green only because a runner has
  no worktrees. Both directories are involved and both are needed —
  `.claude/worktrees/{wt-ci-trust,wt-g8,wt-i-release}` (this sweep's) and
  `.worktrees/{tiptap-v3,ui-refinement}` (older). Fix, verified against a minimal reproduction:
  adding the exclusions to `files.includes` suppresses the nested-config discovery and the run
  proceeds normally.

  - `biome.json` `files.includes` — add `"!.claude"` and `"!.worktrees"`. Bare directory names, not
    `"!.claude/**"`: since biome 2.2 the trailing `/**` is redundant and its own
    `lint/suspicious/useBiomeIgnoreFolder` rule flags it (observed in the reproduction). The repo's
    existing `"!dist/**"`-style entries pre-date that and are not this commit's business.
  - **Run `npx biome check .` from the main checkout, with worktrees present, before committing**,
    and paste the result in the PR body. That is the only run that exercises the condition; a run
    from inside a worktree sees no nested config and proves nothing.

  **Two tracked contributor docs state the old command and must change in the same commit**, or the
  hook and its documentation disagree in the file CLAUDE.md designates as the contract non-Claude
  agents read. **Three, in fact — and all three are also wrong about the hook in a second way:** it
  has run four commands since #1616 and every one of these enumerates three.
  - `AGENTS.md:17` — "`pre-push` runs `biome check src/ tests/`, the **full** Vitest suite, and
    `cargo test`" → `biome check .`, **and add `npm run typecheck:tests` to the list**.
  - `CONTRIBUTING.md:146-149` — the ordered list. Change item 1 to `npx biome check .`, add the
    missing `npm run typecheck:tests` item, **and change the trailing sentence "A delete-only push
    (branch pruning) skips all three." to "all four"** — otherwise the fix leaves the sentence
    counting the list it just lengthened.
  - `CLAUDE.md`, the Hooks section: "**The pre-push hook runs biome + the full vitest suite + `cargo
    test`.**" → "biome + the test-tree typecheck + the full vitest suite + `cargo test`". It is the
    auto-loaded contract and the file most likely to be read as authoritative; leaving it stating
    three of four while two other docs are corrected is the drift this bullet exists to stop.
- `playwright.config.ts` `use` — add `trace: "on-first-retry"` and `screenshot: "only-on-failure"`.
  **Not `video`**: it is the expensive one, the issue does not ask for it, and adding it would
  leave the corrected ci.yml comment naming something we chose not to enable.
  **Two downstream configs inherit this block and one does not — checked, not assumed:**
  `scripts/screenshots/playwright.config.ts:62-63` spreads `...baseConfig.use` explicitly, and
  `scripts/design-baselines/playwright.config.ts:43` spreads `...baseConfig` and defines no `use`
  of its own, so it inherits the whole object wholesale. Neither is harmed: `only-on-failure` does
  not affect explicit `page.screenshot()` calls (the screenshots pipeline) and design-baselines
  compares via `toHaveScreenshot`. `tests/perf/playwright.config.ts:142` defines its own `use` block
  and inherits **nothing** — which is the one that would have mattered, since trace capture on a
  retry inside a timing gate is exactly the overhead that shifts a perf measurement. Say all three
  in the PR body.
- `ci.yml:506-509` — rewrite the comment to name trace and screenshot only, and drop `video`.

## Tests

**One assertion, added to a file this group is already landing; nothing else.** The exception is
`--require-built` (see the Fix bullet): it is the whole anti-vacuity mechanism for
`check-font-assets`, it lives in a `package.json` script no test reads, and dropping it silently
restores the finding — so it gets one line in `tests/scripts/release-ci-hygiene.test.ts` asserting
`scripts.build` contains `check-font-assets.mjs --require-built`. Everything else here is a config
or comment line whose failure is visible in the tool's own output on the next run, and the
minimality rule is explicit that a batch of Lows is not an invitation to build drift guards. Two of
them are self-verifying by construction and the implementer must show it rather than assert it:

- `check-font-assets`: **two runs, not one.** (a) After `npm run build`, insert
  `fonts.googleapis.com` into `dist/client/index.html` and watch the script throw — before the fix
  it exits 0, which is the whole finding. (b) Then `rm dist/client/index.html` and run
  `node scripts/check-font-assets.mjs --require-built`: it must exit **non-zero**. (b) is the
  moved-path regression, which (a) does not exercise and which the `TARGETS.length === 0` throw does
  not catch.
- `lint-staged`: stage a formatting-broken `.json` under `src/` and confirm the commit rewrites it.

**No experiment in `docs/reviews/2026-09-02-v1-review/experiments/` covers any of these bullets**;
there is no still-broken-when output to convert into an assertion.

## Done when

The five fixed; `biome.json` carrying `"!.claude"` and `"!.worktrees"` in the **same commit** as the
`.husky/pre-push` change, with `npx biome check .` run **from the main checkout with worktrees
present** and its output in the PR body; `AGENTS.md:17`, `CONTRIBUTING.md:146-152` and CLAUDE.md's
Hooks bullet all updated to the hook's **four** commands (CONTRIBUTING's "skips all three" → "all
four"); `--require-built` pinned by the assertion in `tests/scripts/release-ci-hygiene.test.ts`;
both `check-font-assets` runs recorded, including the non-zero `--require-built` one; the five
refuted/already-done recorded in the PR body with their evidence; the three Playwright downstream
configs stated as checked; `npm run lint`, `npx biome check .`, `npm test` and a full
`npm run build` green; the `Refs` paragraph names the bullets and hands Tauri to E2-rust and Tests
to K-tests **by name**.

## Not in scope — and these stay tracked in the still-open #1825, which is why it is not closed

Sourcemaps shipped in the npm package (~18 MB); the dependency diet (~393 production packages vs
~148, 44 movable to `devDependencies`); `src/cli` typechecked with the DOM lib; knip's 22 unused
files; the `ci.yml` port list hand-copied from `scripts/test-ports.ts`; the Windows Authenticode
subject-pin TODO. Each is a real finding and each is a bigger change than any other item in this
group — the dependency move alone can change what `dist/cli` resolves at runtime. Leaving #1825
open is their tracked home; do not write "tracked separately" about any of them.

## Review corrections (round 1)

**Adopted.**

- **BLOCKING — the `check-font-assets` justification was factually wrong, so the fix re-created the
  bug it closes.** Verified at `scripts/check-font-assets.mjs:5-11`: `TARGETS` is
  `[…].filter(existsSync)` and the throw fires only at length 0, but the repo-root `index.html`
  exists in every checkout (it is the client entry; `vite.config.ts` sets
  `outDir: "dist/client"`), so the throw is unreachable and a moved output path silently degrades
  the check to source-only — exactly the finding. Replaced with a `--require-built` flag that
  throws when `dist/client/index.html` is absent, passed by `package.json`'s `build` (not by the
  standalone `check:fonts`), the empty-array throw demoted to a second layer, and a second
  discriminating run added: `rm dist/client/index.html && node scripts/check-font-assets.mjs
  --require-built` must exit non-zero. (Two review findings raised this; one rewrite covers both.)
- **`.husky/pre-push` change left two tracked docs stating the old command.** `AGENTS.md:17` — the
  file CLAUDE.md designates as the non-Claude-agent contract — and `CONTRIBUTING.md:146-149`, whose
  "in order" list is *already* missing `npm run typecheck:tests` (the hook runs four commands, the
  list enumerates three). Both added to the Fix bullet.
- **The Playwright bullet named one downstream config and there are three.** Checked:
  `scripts/screenshots/playwright.config.ts:62-63` spreads `...baseConfig.use`;
  `scripts/design-baselines/playwright.config.ts:43` spreads `...baseConfig` with **no own `use`**,
  so it inherits wholesale (the review finding that claimed it defines its own `use` is wrong on
  this point and is corrected here); `tests/perf/playwright.config.ts:142` defines its own and
  inherits nothing — which is the one that mattered, since trace-on-retry inside a timing gate
  shifts measurements. All three now stated, with why none is harmed.
- **`npx biome check .` walks `.claude/worktrees/` on Bryan's main checkout.** Noted for the PR
  body with the mechanism (positive `files.includes` means nothing there is *checked*; the walk
  still happens; Windows junctions) and `"!.claude/**"` named as the fix if it ever matters. Not a
  correctness change.
- **No experiment covers these bullets** — stated in `## Tests`.

**Not adopted.**

- *"`tests/perf/` and `scripts/design-baselines/` each define their own `use` and do NOT inherit."*
  Half wrong on measurement: `scripts/design-baselines/playwright.config.ts` spreads
  `...baseConfig` at `:43` and defines no `use` key, so it **does** inherit trace/screenshot. The
  correct half (perf defines its own) is adopted above; the incorrect half is not.

**File set changed** — added: `AGENTS.md`, `CONTRIBUTING.md`, `package.json` (the `build` script
gains `--require-built`, alongside the already-planned `lint-staged` key). Already present:
`scripts/check-font-assets.mjs`, `.husky/pre-push`, `playwright.config.ts`, `.github/workflows/ci.yml`.

## Review corrections (round 2)

**Adopted.**

- **The `npx biome check .` change was filed as a possible slowdown; measured, it is a hard break —
  and the fix moves into the same commit.** Round 1 said "if the first run is slow, that is why; it
  is not a hang" and named `"!.claude/**"` as the fix "if it ever matters". Measured 2026-09-10 from
  the main checkout with biome 2.4.8: `npx biome check .` exits **non-zero having checked zero
  files**, with `× Found a nested root configuration, but there's already a root configuration` for
  `.claude/worktrees/wt-g8`, `.claude/worktrees/wt-i-release` and `.worktrees/tiptap-v3` — every
  worktree carries the repo's own tracked `biome.json`, and biome 2.x refuses rather than ignoring
  it. So the round-1 text would have shipped a hook that blocks every push from Bryan's checkout
  while any worktree exists (CI stays green: a runner has no worktrees). Verified against a minimal
  reproduction that the exclusions suppress nested-config discovery and the run then proceeds.
  `biome.json` joins the file set with `"!.claude"` and `"!.worktrees"` — bare names, since biome
  ≥2.2 flags the trailing `/**` via `lint/suspicious/useBiomeIgnoreFolder` — and Done-when requires
  the main-checkout run with its output in the PR body.
- **The two contributor docs stayed wrong about the hook in a second way, and a third doc was
  missed.** `.husky/pre-push` runs four commands; `AGENTS.md:17` names three, `CONTRIBUTING.md`'s
  list has three items plus "skips all three", and CLAUDE.md's Hooks bullet says "biome + the full
  vitest suite + `cargo test`". All three now change in the same commit: the `typecheck:tests`
  entry added to `AGENTS.md` and `CONTRIBUTING.md`, "all three" → "all four", and CLAUDE.md's
  bullet rewritten to name the test-tree typecheck.
- **`--require-built` was the anti-vacuity mechanism and was pinned by nothing.** Dropping it from
  `package.json`'s `build` leaves `TARGETS` at `["index.html"]` and the script exits 0 having
  inspected only the source file, with no test red. One assertion added to
  `tests/scripts/release-ci-hygiene.test.ts` (the file #1832 lands for this group): `scripts.build`
  contains `check-font-assets.mjs --require-built`. The `## Tests` section's "None new" is corrected
  to name that one exception.

**Not adopted.** None.

**File set changed** — added: `biome.json` (the two exclusions, same commit as `.husky/pre-push`),
`CLAUDE.md` (Hooks bullet), and one assertion in `tests/scripts/release-ci-hygiene.test.ts` (the
file itself is #1832's). Already present: `package.json`, `scripts/check-font-assets.mjs`,
`.husky/pre-push`, `playwright.config.ts`, `.github/workflows/ci.yml`, `AGENTS.md`,
`CONTRIBUTING.md`.
