# I-release — #1825 the CI/build section only (Lows batch)

Branch `fix/release-and-ci-hygiene-1856`. **REFS ONLY — #1825 stays open.** It is a five-section
batch; this PR touches the **CI / build** section and nothing else. Its **Tauri** section belongs to
E2-rust and its **Tests** remainder to K-tests, both later in wave 7; its **Infra** section and the
CI/build `infra/` bullet already landed in #1944 (`d2cc5e08`). Ledger: `areas/ci-build.md` rows 9–10.
The PR body's `## Refs` paragraph must name **these bullets by name** and say which sections are
somebody else's — wave 6 shipped a `Refs` paragraph naming the wrong section of this same issue.

## Problem — re-checked against `origin/master` fff8e312

**Fixing here (five):**

- `lint-staged`'s JSON key is the literal `"**/*.json !package-lock.json"`; lint-staged keys are
  single micromatch patterns, so a space-separated negation is not one and **no JSON file is ever
  formatted on commit**.
- `check-font-assets` inspects a path the build never writes: `scripts/check-font-assets.mjs:5`
  filters `[dist/index.html, index.html]` by `existsSync`, but `vite.config.ts:29` sets
  `outDir: "dist/client"`, so `dist/index.html` never exists and the check only ever reads the
  **source** `index.html` — never the shipped artifact it exists to check.
- Pre-push biome scope is narrower than CI's: `.husky/pre-push` runs `npx biome check src/ tests/`,
  `ci.yml:349-350` runs `npx biome check .`, so `scripts/`, `infra/` and root files can fail CI after
  a green push.
- Playwright `retries: 1` with no trace: `playwright.config.ts:44` retries; its `use` block
  (`:53-56`) sets only `baseURL` and `headless`.
- `ci.yml:506-509` claims `test-results/` carries trace/video/screenshot artifacts "configured in
  playwright.config.ts". Nothing is configured, so the upload is empty on every CI-only flake.

**Refuted or already done — record in the PR body, change nothing:** the "`publish.yml` has no `v*`
tag guard" bullet is stale (`:101-111` asserts tag == `v$(package.json version)` for both triggers);
"`rust-toolchain@stable` floating" is stale (SHA-pinned by #1745, four sites, pinned by
`workflow-action-pin.test.ts:240-265`); the CodeQL bullet duplicates **#1748 item 4** and is fixed
there, not twice; the `infra/` bullet's biome/tsconfig/wrangler halves landed in #1944 while its
compat-date and `./crypto.js` halves need a deployed Worker and are Bryan's; "MSI/WiX rejects
non-numeric prerelease" is informational and *bounds* #1748 item 1.

## Fix

- `package.json` — `"**/*.json !package-lock.json"` → `"**/*.json"`. Safe because `biome.json:19-28`
  already carries `"!package-lock.json"` in `files.includes`, so the excluded file stays excluded by
  the tool rather than by an inert key.
- `scripts/check-font-assets.mjs` — target `dist/client/index.html`, and **make its absence a hard
  error rather than a silent skip**. The path fix alone re-creates the bug: `TARGETS` is
  `[…].filter(existsSync)` and the throw fires only at `TARGETS.length === 0`, but the repo-root
  `index.html` is the client entry and exists in every checkout, so that throw is unreachable and a
  future output-path move degrades the check to source-only again.

  ```js
  const BUILT = path.join("dist", "client", "index.html");
  if (!fs.existsSync(BUILT)) {
    throw new Error(`${BUILT} not found — run \`npm run build\` first.`);
  }
  const TARGETS = [BUILT, "index.html"];
  ```

  No flag and no `package.json` change: `npm run build` already runs `build-client.mjs` immediately
  before this script (`package.json:46`), so the built file is always present on the path that
  matters, and the only other caller is the standalone `check:fonts`, which nothing in CI or any hook
  invokes. Update `docs/cli.md:175` in the same commit to say it requires a prior
  `npm run build` — that row is the only description of the standalone contract.
- `.husky/pre-push` — `npx biome check src/ tests/` → `npx biome check .`, making the hook and CI the
  same command. **This does NOT ship alone: `biome.json` gains two exclusions in the same commit, or
  the hook breaks every push from Bryan's checkout.** Measured 2026-09-10 from the main checkout with
  biome 2.4.8, `npx biome check .` exits **non-zero having checked zero files** in ~1.8s, with
  `× Found a nested root configuration, but there's already a root configuration` for
  `.claude/worktrees/wt-g8`, `.claude/worktrees/wt-i-release` and `.worktrees/tiptap-v3`: every
  worktree carries the repo's own tracked `biome.json` and biome 2.x refuses rather than ignoring it
  (CI is green only because a runner has no worktrees). Fix, verified against a minimal reproduction:
  add `"!.claude"` and `"!.worktrees"` to `files.includes` — bare directory names, since biome ≥2.2
  flags a trailing `/**` via `lint/suspicious/useBiomeIgnoreFolder`. **Superseded in PR review:** that
  enumeration only ever covered the two worktree roots this repo's own tooling uses, so a `git
  worktree` at any other path (`../tandem-wt`, `./tmp-wt`) aborted every push with an error that
  never named the worktree as the cause. What shipped instead is
  `vcs: {enabled, clientKind: "git", useIgnoreFile: true}` with **no** per-path negations — biome
  skips whatever `.gitignore` already skips, and both worktree roots are gitignored. Do not re-add
  `"!.claude"` / `"!.worktrees"`: `tests/scripts/biome-worktree-scope.test.ts` fails on either.
  **Run `npx biome check .` from
  the main checkout, with worktrees present, before committing** and paste the result in the PR body;
  a run from inside a worktree sees no nested config and proves nothing. Two tracked docs quote the
  old command and must change in the same commit — `AGENTS.md:17` and `CONTRIBUTING.md:146-149` item
  1, **the command string only**.
- `playwright.config.ts` `use` — add `trace: "on-first-retry"` and `screenshot: "only-on-failure"`.
  **Not `video`**: it is the expensive one, the issue does not ask for it, and it would leave the
  corrected `ci.yml` comment naming something we chose not to enable. Three downstream configs,
  checked rather than assumed: `scripts/screenshots/playwright.config.ts:62-63` spreads
  `...baseConfig.use`; `scripts/design-baselines/playwright.config.ts:43` spreads `...baseConfig` and
  defines no `use`, so it inherits wholesale; `tests/perf/playwright.config.ts:142` defines its own
  and inherits **nothing** — the one that would have mattered, since trace capture on a retry inside
  a timing gate shifts the measurement. Neither of the first two is harmed: `only-on-failure` does
  not affect explicit `page.screenshot()` calls, and design-baselines compares via `toHaveScreenshot`.
  Say all three in the PR body.
- `ci.yml:506-509` — rewrite the comment to name trace and screenshot only, and drop `video`.

## Tests

**None.** Every bullet is a config or comment line whose failure is visible in the tool's own output
on the next run, and the minimality rule is explicit that a batch of Lows is not an invitation to
build drift guards. The one that previously earned an assertion — `check-font-assets` — no longer
needs one: the required-built check is unconditional inside the script, so there is no flag in a
`package.json` script for a later edit to drop. Two bullets are self-verifying and the implementer
must show it rather than assert it:

- `check-font-assets`, two runs. (a) After `npm run build`, insert `fonts.googleapis.com` into
  `dist/client/index.html` and watch the script throw — before the fix it exits 0, which is the whole
  finding. (b) `rm dist/client/index.html && node scripts/check-font-assets.mjs` must exit
  **non-zero**: the moved-path regression, which (a) does not exercise.
- `lint-staged`: stage a formatting-broken `.json` under `src/` and confirm the commit rewrites it.

No experiment in `docs/reviews/2026-09-02-v1-review/experiments/` covers any of these bullets.

## Done when

The five fixed; `biome.json` carrying the worktree exclusion in the **same commit** as the
`.husky/pre-push` change (shipped as `vcs.useIgnoreFile`, not the `"!.claude"` / `"!.worktrees"`
enumeration this spec first named — see the superseding note above), with `npx biome check .` run
from the main checkout with worktrees present
and its output in the PR body; `AGENTS.md:17`, `CONTRIBUTING.md:146-149` and `docs/cli.md:175`
updated; both `check-font-assets` runs recorded, including the non-zero one; the refuted/already-done
set recorded with its evidence; the three Playwright configs stated as checked; `npm run lint`,
`npx biome check .`, `npm test` and a full `npm run build` green; the `Refs` paragraph naming the
bullets and handing Tauri to E2-rust and Tests to K-tests **by name**.

## Not in scope — tracked in the still-open #1825, which is why it is not closed

Sourcemaps shipped in the npm package (~18 MB); the dependency diet (~393 production packages vs
~148, 44 movable to `devDependencies`); `src/cli` typechecked with the DOM lib; knip's 22 unused
files; the `ci.yml` port list hand-copied from `scripts/test-ports.ts`; the Windows Authenticode
subject-pin TODO. Each is a bigger change than anything in this group. #1825 staying open is their
tracked home; do not write "tracked separately" about any of them.

## Review corrections (scope cut)

**Removed.**

- The `--require-built` flag, its `package.json` `build`-script plumbing and the
  `release-ci-hygiene.test.ts` assertion pinning it. A flag in a script no test reads needed a new
  gate to hold; making the built-file check unconditional inside the script removes flag, plumbing
  and gate together and closes the same vacuity by construction.
- The CLAUDE.md Hooks-bullet edit, the `npm run typecheck:tests` additions to `AGENTS.md` /
  `CONTRIBUTING.md`, and "skips all three" → "all four". That is pre-existing doc drift this change
  does not create; only the command string we are changing gets corrected. It stays a real finding
  under the still-open #1825 rather than an unfiled deferral.
- The round-1/round-2 logs, folded into the body — including the "design-baselines defines its own
  `use`" claim, which was measured false and is stated correctly above.

**Kept, with reasons.** The `biome.json` exclusions — measured, and without them the pre-push change
blocks every push from the main checkout. The three-config Playwright check — a cross-reference the
PR body asserts, so it must be verified rather than assumed.

**File set:** `package.json` (lint-staged key only), `scripts/check-font-assets.mjs`, `docs/cli.md`,
`.husky/pre-push`, `biome.json`, `AGENTS.md`, `CONTRIBUTING.md`, `playwright.config.ts`,
`.github/workflows/ci.yml`. Dropped from the round-2 set: `CLAUDE.md`, and any assertion in
`tests/scripts/release-ci-hygiene.test.ts`.

## Review corrections (post-cut)

**Adopted.** *"The spec tells the implementer to write `npm run build:client` into a thrown error
message and into `docs/cli.md`; no such script exists, so the fix ships a run-this-command
instruction that fails with `Missing script`."* Measured: `package.json` has `build`, `build:server`,
`build:reaper`, `build:tauri` and `check:fonts` — no `build:client`; the client build is
`node scripts/build-client.mjs`, invoked from the `build` script. Both occurrences now read
`npm run build`, which is the only script that produces `dist/client/index.html` and already runs
`check-font-assets.mjs` immediately after `build-client.mjs`.
