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
  `path.join("dist", "client", "index.html")`. Keep the root `index.html` entry and keep the
  `TARGETS.length === 0` throw: the script runs inside `npm run build` **after**
  `scripts/build-client.mjs`, so the built file exists by then, and the throw is what stops the
  check going vacuous if the output path moves again.
- `.husky/pre-push` — `npx biome check src/ tests/` → `npx biome check .`. The `files.includes` in
  `biome.json` is what bounds `.`; this makes the hook and CI the same command, which is the point.
- `playwright.config.ts` `use` — add `trace: "on-first-retry"` and `screenshot: "only-on-failure"`.
  **Not `video`**: it is the expensive one, the issue does not ask for it, and adding it would
  leave the corrected ci.yml comment naming something we chose not to enable.
  `scripts/screenshots/playwright.config.ts` spreads this whole object; `only-on-failure` does not
  affect explicit `page.screenshot()` calls, so the capture pipeline is unaffected.
- `ci.yml:506-509` — rewrite the comment to name trace and screenshot only, and drop `video`.

## Tests

**None new.** Every one of these five is a config or comment line whose failure is visible in the
tool's own output on the next run, and the minimality rule is explicit that a batch of Lows is not
an invitation to build drift guards. Two of them are self-verifying by construction and the
implementer must show it rather than assert it:

- `check-font-assets`: after `npm run build`, `node scripts/check-font-assets.mjs` must now read two
  files. Prove it by temporarily inserting `fonts.googleapis.com` into `dist/client/index.html` and
  watching the script throw — before the fix it exits 0, which is the whole finding.
- `lint-staged`: stage a formatting-broken `.json` under `src/` and confirm the commit rewrites it.

## Done when

The five fixed; the five refuted/already-done recorded in the PR body with their evidence; `npm run
lint`, `npx biome check .`, `npm test` and a full `npm run build` green; the `Refs` paragraph names
the bullets and hands Tauri to E2-rust and Tests to K-tests **by name**.

## Not in scope — and these stay tracked in the still-open #1825, which is why it is not closed

Sourcemaps shipped in the npm package (~18 MB); the dependency diet (~393 production packages vs
~148, 44 movable to `devDependencies`); `src/cli` typechecked with the DOM lib; knip's 22 unused
files; the `ci.yml` port list hand-copied from `scripts/test-ports.ts`; the Windows Authenticode
subject-pin TODO. Each is a real finding and each is a bigger change than any other item in this
group — the dependency move alone can change what `dist/cli` resolves at runtime. Leaving #1825
open is their tracked home; do not write "tracked separately" about any of them.
