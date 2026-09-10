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

  Discriminating check, and it must be run: after `npm run build`,
  `rm dist/client/index.html && node scripts/check-font-assets.mjs --require-built` exits
  **non-zero**. That is the moved-path regression; the "insert `fonts.googleapis.com` into
  `dist/client/index.html` and watch it throw" check in `## Tests` exercises the present-file path
  only.
- `.husky/pre-push` — `npx biome check src/ tests/` → `npx biome check .`. The `files.includes` in
  `biome.json` is what bounds `.`; this makes the hook and CI the same command, which is the point.
  **Two tracked contributor docs state the old command and must change in the same commit**, or the
  hook and its documentation disagree in the file CLAUDE.md designates as the contract non-Claude
  agents read:
  - `AGENTS.md:17` — "`pre-push` runs `biome check src/ tests/`, the **full** Vitest suite, and
    `cargo test`" → `biome check .`.
  - `CONTRIBUTING.md:146-149` — the ordered list. Change item 1 to `npx biome check .`, **and while
    there add the missing `npm run typecheck:tests` step**: the hook has run four commands since
    #1616 and this list enumerates three, so it is already wrong about the order it claims to state
    "exactly".
  Note for the PR body, not a code change: on Bryan's main checkout `.` walks
  `.claude/worktrees/`, which holds full checkouts during this sweep. Nothing there is *checked* —
  `biome.json:20-30` bounds by positive includes (`src/**`, `tests/**`, `scripts/**`, `infra/**`,
  `packages/**`, root `*.{ts,json,html}`) and nothing under `.claude/` matches one — but the walk
  happens, and worktree `node_modules` are junctions on Windows. If the first run is slow, that is
  why; it is not a hang. `"!.claude/**"` in `files.includes` is the fix if it ever matters.
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

**None new.** Every one of these five is a config or comment line whose failure is visible in the
tool's own output on the next run, and the minimality rule is explicit that a batch of Lows is not
an invitation to build drift guards. Two of them are self-verifying by construction and the
implementer must show it rather than assert it:

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

The five fixed; `AGENTS.md:17` and `CONTRIBUTING.md:146-149` updated with the hook, the latter
gaining its missing `typecheck:tests` line; both `check-font-assets` runs recorded, including the
non-zero `--require-built` one; the five refuted/already-done recorded in the PR body with their
evidence; the three Playwright downstream configs stated as checked; `npm run lint`,
`npx biome check .`, `npm test` and a full `npm run build` green; the `Refs` paragraph names the
bullets and hands Tauri to E2-rust and Tests to K-tests **by name**.

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
