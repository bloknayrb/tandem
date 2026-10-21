# Contributing to Tandem

Tandem is a small project (two maintainers). There is no CLA and no committee — the bar is that a
change is correct, tested, and does not silently break an invariant.

Start with [README.md](README.md) for what Tandem is. Read [AGENTS.md](AGENTS.md) before writing
code: it lists the invariants that fail *silently* — code that type-checks, passes tests, and is
wrong at runtime. If you are working with Claude Code, [CLAUDE.md](CLAUDE.md) is the long form.

The rest of the documentation is indexed from the [docs hub](docs/README.md). The
[Contributing map](docs/maps/contributing.md) lists the pages that matter for code work: the rules
that fail silently and the reasons behind them, the design system and the review tooling.

## Prerequisites

- **Node.js 22.12.0 or newer**, and npm. This is the floor `package.json`'s `engines` field
  declares. In practice it's a build-toolchain constraint — once you're on Node 22, Vite / rolldown
  (devDependencies) require 22.12 specifically — not a runtime one; `tandem doctor` checks against
  this same declared value. See
  [#1533](https://github.com/bloknayrb/tandem/issues/1533) for whether that's the number this
  project should keep asserting. Check `node --version` yourself.
- **Rust and the Tauri toolchain**, if you will touch `src-tauri/` — or if you will push at all.
  The pre-push hook runs `cargo test`. See "Before your first push" below.
- **Python 3.10 or newer**, on `PATH` as either `python3` or `python` — and, like Rust, it is
  needed *whether or not* you touch the code that uses it. `tests/scripts/acceptance-harness-wiring.test.ts`
  is an ordinary vitest test that spawns `scripts/spikes/run_acceptance_tests.py` against
  deliberately broken fixture suites, and it **fails rather than skips** when no interpreter is
  found — an absent interpreter must not quietly void the only coverage that runner's decisions
  have. So `npm test`, and therefore the pre-push hook, need Python: without it 9 of those tests go
  red and you cannot push. (`npm run test:acceptance-harness` — the 82-test harness itself — is a
  separate command that is *not* part of `npm test`; see [docs/cli.md](docs/cli.md#testing).)

## Development setup

```bash
git clone https://github.com/bloknayrb/tandem.git
cd tandem
npm install
npm run dev:standalone   # backend (:3478, :3479) + frontend (:5173)
```

`npm install` runs `husky` and installs the git hooks into `.husky/_`.

Open <http://127.0.0.1:5173>. To point Claude Code at your checkout, copy `.mcp.json.example` to
`.mcp.json` in the repo root — the real `.mcp.json` is **gitignored and developer-local**, so a
fresh clone has no MCP config until you make that copy. (It is deliberately not shipped: the
plugin's own `.claude-plugin/plugin.json` is authoritative for what installed users see.)

Verify the server is up:

```bash
curl http://127.0.0.1:3479/health
# → {"status":"ok","version":"x.y.z","transport":"http","hasSession":false,
#    "push":{"subscribers":0,"lastEventAt":null,"eventCount":0}}
```

The server listens on this computer only. A non-loopback `TANDEM_BIND_HOST` is refused at
start: the LAN bind ships dark behind `LAN_BIND_ENABLED` in `src/shared/constants.ts`
([ADR-056](docs/decisions.md#adr-056-the-non-loopback-bind-ships-dark)). See
[docs/security.md](docs/security.md) for the full network posture.

Start the server *before* connecting Claude Code. Vite hot-reloads client code; server changes need
a `dev:server` restart and then `/mcp` in Claude Code.

## Running it

| Command | What it does |
|---|---|
| `npm run dev:standalone` | Vite (:5173) + server watcher (Hocuspocus :3478, MCP HTTP :3479) |
| `npm run dev:server` | Backend only |
| `npm run dev` / `npm run dev:client` | Vite only |
| `npm run build` | typecheck + vite build + font-asset check + tsup |
| `cargo tauri dev` | The desktop shell |
| `cargo tauri dev --features ui-inspector` | Desktop shell + the element picker (see below) |
| `npm run doctor` | Diagnose ports, Node version, MCP config, server health |

See [docs/cli.md](docs/cli.md#npm-run-scripts-source-checkouts-only) for the full list of npm
scripts.

### UI element inspector (optional, dev-only)

[`tauri-plugin-ui-inspector`](https://github.com/mathematic-inc/tauri-plugin-ui-inspector) turns a
clicked element in the running desktop app into a durable `@ui_<ULID>` reference — DOM/ARIA
metadata, ranked locators, the `.svelte` source location, and a native window + element screenshot.
Hand the id to an agent and it works from the recorded element instead of your description of it.
`.claude/skills/ui-inspector/SKILL.md` is the agent-facing half.

One-time, per machine:

```sh
cargo install tauri-ui-inspector    # the CLI; not a repo dependency
rustup update stable                # the plugin needs rustc >= 1.97
```

Then `cargo tauri dev --features ui-inspector`, and either press `Ctrl+Shift+C` (`Cmd+Shift+C` on
macOS) or run `ui-inspector pick` in a second terminal.

Three things about it that are easy to get wrong:

- **It is off by default and gated in three places that must agree** — the cargo feature (adds the
  plugin + grants `ui-inspector:default` at runtime), `import.meta.env.DEV` (keeps the two
  `@tauri-ui-inspector/*` devDependencies out of the production bundle), and `isTauriRuntime()` (the
  npm global install serves the same client into a plain browser). A `cargo tauri dev` *without*
  the feature still installs the frontend bridge, so every capture is then rejected by the ACL and
  the CLI reports only a timeout — the WebView console names the flag.
- **Screenshots are off, and that is what makes it work.** `capture_screenshots(false)` is set in
  `src/lib.rs`. Native capture is broken on Windows: measured against the same live pid at the same
  moment with the same xcap 0.9.8, `xcap::Window::all()` returns Tandem's windows when called from
  *outside* the process and returns **zero** windows matching the pid when called from *inside* it.
  The plugin's `find_window` filters that list by `std::process::id()`, so the match set is always
  empty and every capture fails with `no native window matched the Tauri process and window title`
  — and a failed capture aborts the whole capture, writing no reference at all. Everything else
  (metadata, locators, Svelte source, persistence, live `resolve`) works with it off. Tracked in
  #1633; upstream's E2E evidence is macOS-only.
- **The reference store is sensitive.** `.ui-inspector/` at the repo root holds a record of
  whatever document was open. It is gitignored; never attach one to an issue or PR. The path is
  pinned to the repo root via `CARGO_MANIFEST_DIR` rather than left at the plugin's CWD-relative
  default — the CLI finds a store by walking *up* from where you invoke it, and the app's CWD under
  `cargo tauri dev` is `src-tauri/`, a descendant. Left at the default, every CLI call from the repo
  root fails with exit 3, which reads as "the app isn't running".
- **Two upstream version floors sit above ours**: the crate declares `rust-version = 1.97` (ours is
  1.77.2) and the npm packages declare `engines.node >= 26` (ours is >= 22.12.0). The crate is an
  optional dependency, so a default `cargo build`/`cargo test` never resolves it and the Rust floor
  applies only when you pass the feature. The Node floor is an `npm install` warning only — nothing
  in this repo sets `engine-strict`, and CI on Node 22 warns and passes.

## Checks

| Command | Scope |
|---|---|
| `npm run typecheck` | tsc server + client + `svelte-check --fail-on-warnings` |
| `npm test` | Vitest — unit and integration |
| `npm run typecheck:tests` | tsc over `tests/` (three configs). `npm run typecheck` does not chain it |
| `npm run test:e2e` | Playwright — starts its own servers on reserved harness ports, so it runs alongside a live Tandem (see [Running E2E tests](#running-e2e-tests)) |
| `npm run check:tokens` | Raw hex/rgba scan over `src/client/` |
| `npm run check:links` | Relative Markdown links, anchors and images across the repo, plus docs-vault reachability. Runs in CI's `check` job, not in the hooks |
| `npm run audit:origins` / `npm run audit:ymap-keys` | Static walks for the Y.Doc origin-tagging and Y.Map-key invariants |
| `cargo test --manifest-path src-tauri/Cargo.toml` | The Rust/Tauri layer |

`npm run check:links` is the one to run after moving or renaming any Markdown file, since nothing
else will catch the dangling links before CI does. It reads relative links only; `docs/workflows.md`
opens inside the app and uses absolute GitHub URLs instead, which
`tests/docs/shipped-doc-links.test.ts` checks.

**`docs/` is a linked vault.** [docs/README.md](docs/README.md) is its hub, and every live doc must
be reachable from it by relative links — `check:links` reports an unlinked doc as an orphan, so a
new doc needs an inbound link from the hub, a map or a neighbouring doc. Dated records (plans,
spikes, reviews, archive; the `HISTORICAL` list in `scripts/check-doc-links.mjs`) are exempt from
reachability and anchor checks but not from path checks. The repo root opens as an Obsidian vault:
the tracked `.obsidian/app.json` makes Obsidian write relative Markdown links (never `[[wikilinks]]`,
which GitHub and the checker cannot follow) and rewrite them when a file moves. The checker reads
files from `git ls-files`, plus untracked files that are not ignored, so it needs a git checkout.

### What CI requires

`.github/workflows/ci.yml` runs on every pull request, on pushes to `master` and on the merge
queue. The checks a PR needs before it can merge are `check`, the three `rust-test` legs (Ubuntu,
macOS and Windows, each running `cargo test`) and `windows-acl-proof`; `coverage` and CodeQL report
but do not block. `check` is the broad one. On Ubuntu it runs ESLint (`npm run lint`), the Biome
check, the doc-link check, the client, server, root and test typechecks, the build, the full vitest
suite, the acceptance harness and the Playwright E2E suite, plus a few smaller verification steps.
`master` merges through a GitHub merge queue: CI runs again on a temporary branch holding `master`,
your PR and everything queued ahead of it, and the PR merges only if the required checks pass
there. The queue's merge method is not recorded in any tracked file, and the required-check list
was last measured on 2026-08-28, so re-measure branch protection before relying on either (the
"Required checks" note in [CLAUDE.md](CLAUDE.md#status) says how).

## What the git hooks actually run

This trips up every new clone, so it is stated exactly:

- **`pre-commit`** runs `lint-staged` — ESLint `--fix` and Biome `check --write` on staged sources,
  `scripts/check-semantic-tokens.ts` on staged `src/client/**`, and an EOL normalizer on staged
  markdown/YAML. **It does not typecheck and does not run tests.**
- **`pre-push`** runs, in order:
  1. `npx biome check .`
  2. `npm run typecheck:tests` — the test-tree typecheck, which `npm run typecheck` does not run
  3. `npm test -- --run --reporter=dot` — the **full** Vitest suite, not a subset
  4. `cargo test --manifest-path src-tauri/Cargo.toml`

  A delete-only push (branch pruning) skips all four.

Two consequences worth internalising. The suite that runs at push time is the *whole* suite, so
budget minutes, not seconds. And whatever is in your working tree while the hook runs is what gets
tested — do not edit during a push.

## Before your first push

**A fresh clone cannot push.** `cargo test` requires GTK development libraries and the two sidecar
binaries that `tauri_build::build()` checks for existence, neither of which is in the repo. Do this
once:

```sh
TRIPLE=$(rustc -vV | sed -n 's/host: //p')
mkdir -p src-tauri/binaries dist/{channel,server,client,stdio-bridge,desktop}
touch dist/desktop/THIRD_PARTY_NOTICES.txt
touch src-tauri/binaries/{node-sidecar,tandem-reaper}-$TRIPLE{,.exe}
```

(`npm run build` also writes `dist/desktop/THIRD_PARTY_NOTICES.txt`, as a placeholder; the desktop
build replaces it with the full third-party notices.)

On Debian/Ubuntu also install:

```sh
apt-get install -y libwebkit2gtk-4.1-dev libappindicator3-dev librsvg2-dev patchelf libxdo-dev
```

`libxdo-dev` is the one people miss. It is pulled in by a Cargo feature, so omitting it surfaces as
a bare `rust-lld: error: unable to find library -lxdo` thousands of lines into linker output, long
after the GTK packages everyone remembers are already installed.

The `dist/` list must stay in sync with `bundle.resources` in `src-tauri/tauri.conf.json`, not with
whatever happens to be in `dist/`.

`cargo test` is not the only prerequisite the hook drags in: it also runs the full vitest suite,
and `tests/scripts/acceptance-harness-wiring.test.ts` needs **Python 3.10+** on `PATH` (see
Prerequisites). Debian and Ubuntu ship it as `python3` only, which is fine — both that test and
`npm run test:acceptance-harness` accept either name.

**In a fresh `git worktree`, `.husky/_` is gitignored and therefore absent — zero hooks run,
silently.** Run `npx husky` in the new worktree before your first commit there, or you will push
unchecked.

## If a hook blocks you

Don't route around it. If a hook complains, fix the complaint — that is the whole reason it exists.

If you have a genuine reason (the hook itself is broken), the sanctioned escape is
`HUSKY=0 git push`, which disables husky for that one invocation.

<!-- Deliberately NOT printing the git flag that skips hooks as a literal token here.
     `.claude/hooks/block-no-verify.sh` matches that flag as a substring ANYWHERE in a bash
     command string and fails closed — including in prose that merely quotes it. Spelling it
     out would make this paragraph unquotable in a commit message, PR body or heredoc from any
     agent session. `HUSKY=0` is the sanctioned bypass; the git-level skip flag is not. -->

Git's own per-invocation hook-skip flag (the long `--no`-prefixed one, and its single-letter
alias) is **hard-blocked** in agent sessions for exactly that reason. Use `HUSKY=0` or fix the hook.

## Style

`.editorconfig` and `biome.json` are authoritative: UTF-8, LF, final newline, two-space indent,
100 columns, double quotes, semicolons, trailing commas.

- Svelte components: `PascalCase.svelte`
- Rune-based hooks/modules: `camelCase.svelte.ts`
- Tests: `*.test.ts` / `*.spec.ts`, under the owning `tests/<area>/`
- Route/service files: kebab-case where the surrounding directory already is

On Windows: if `biome check .` fails locally with only CRLF errors while CI is green, check
`git ls-files --eol | grep "w/crlf"` before blaming your change. The fix is
`git add --renormalize .` as its own commit — never `core.autocrlf=false`.

## Tests

Vitest covers unit and integration; Playwright covers browser workflows. Put a test in the owning
`tests/<area>/` directory and name it after the behaviour or the regression
(`document-offset.test.ts`, `annotation-lifecycle.spec.ts`). Run one file with
`npm test -- tests/server/document-service.test.ts`.

E2E specs select on `data-testid`. Those values are a contract — you may add, but never remove or
rename without regenerating `tests/design-system-impl/__snapshots__/testid-set.snap.txt`.

### Running E2E tests

Playwright drives the real editor against a real server, so an E2E spec covers the whole annotation
path: MCP call → Y.Doc → Hocuspocus → browser → ProseMirror.

```bash
npm run test:e2e      # run every spec; starts its own servers
npm run test:e2e:ui   # Playwright UI mode, for debugging
```

The harness never touches the product's ports (:3478/:3479) or the dev Vite port (:5173). It runs on
reserved ports defined in `scripts/test-ports.ts` — currently Vite 4573 with a backend on 4728/4729
for E2E, and 4378/4379 for the perf gate — and starts its backend with `reuseExistingServer: false`.
So a running Tandem or `npm run dev:server` keeps running through a test run. Two consequences:

- **Anything else holding the reserved pair is refused or killed.** Before the suite starts,
  `scripts/e2e-guard.ts` refuses a server on the reserved MCP port that is not a live E2E server, and
  the harness backend's boot kills whatever still holds the pair. Don't park anything there.
- **One run per machine.** The ports and the app-data dir are fixed, so two people (or two agent
  sessions) cannot run the suite at the same time on one machine.

Each spec follows the same shape: `beforeEach` connects an `McpTestClient` (`tests/e2e/helpers.ts`)
and copies fixture files to a temp dir; the test body drives MCP calls and asserts browser state with
Playwright; `afterEach` closes every open document and removes the temp dir. Annotation assertions
typically wait up to 10 s, because a change crosses several hops before it renders.

## Commits and pull requests

- Conventional Commits: `type(scope): description`, imperative, ≤72 chars. Explain *why*; the diff
  already shows *what*.
- Branch as `type/short-description`. Never commit to `master`.
- One PR per concern. Include a problem/solution summary, the commands you ran, screenshots for
  visible UI changes, and `Closes #N` where it applies.
- Before opening the PR, verify. The hooks cover only part of this, so run it yourself:
  - [ ] `npm run typecheck` and `npm run typecheck:tests`
  - [ ] `npm test`
  - [ ] `npm run test:e2e` if you changed the client or anything a browser reaches
  - [ ] `npm run check:links` if you moved, renamed or relinked Markdown
  - [ ] Whatever manual testing is possible: the app itself, or MCP calls against a running server
  - [ ] If you work with Claude Code, `/simplify` on the change before the final run
- Call out configuration, security, or migration impact explicitly.
- Work that layers — a harness under the fixes it enables, a refactor under the feature needing
  it — belongs in a **stack**, not a hand-chain of `--base` flags. See
  [docs/stacked-prs.md](docs/stacked-prs.md); this repo auto-deletes merged branches, which
  silently *closes* a hand-chained child PR rather than retargeting it.

## Security

Do not commit secrets or local MCP credentials; start from `.env.example` and `.mcp.json.example`.

**Reviewing a Dependabot `github-actions` bump takes two commands, and they are not optional.**
Every action in `.github/workflows/` is pinned to a full commit SHA (#1745) because those steps run
with the release signing material in scope. But a 40-hex ref is a *shape*, not an identity: GitHub
resolves `owner/repo@<sha>` against the whole **fork network**, so a SHA that exists only in a fork
of `actions/checkout` resolves and runs. No check in CI can detect that —
`tests/scripts/workflow-action-pin.test.ts` validates the shape and the owner/repo set, and stops
there. So for each bumped action, confirm the new SHA is reachable in the *upstream* repo and is
what the trailing comment claims:

```bash
gh api repos/<owner>/<repo>/git/ref/tags/<tag> --jq .object.sha   # annotated tags: follow .object.sha through /git/tags/<sha>
gh api repos/<owner>/<repo>/commits/<new-sha> --jq .sha
```

This is why the `github-actions` ecosystem is deliberately **ungrouped** in
`.github/dependabot.yml`: a grouped PR mutating a dozen 40-hex strings is exactly the artifact in
which one wrong SHA is invisible. **Nothing automated covers a Dependabot bump, so the two commands
above are human-only.** The repo has no working automated reviewer: `claude-code-review.yml` has not
completed a run since 2026-05-27 — it passes `secrets.ANTHROPIC_API_KEY`, which does not exist, so
every run since has failed — and its `if:` excludes bot-authored PRs in any case (#1831).

If a change touches network posture, CORS, authentication, or the `/api` surface, read
[docs/security.md](docs/security.md) first — several invariants there are enforced by review
rather than by CI, and the enumerated route lists in [CLAUDE.md](CLAUDE.md) *are* that review. Do
not condense them.

Report a suspected vulnerability privately to the maintainers rather than opening a public issue.

## Related

- [Contributing map](docs/maps/contributing.md): every contributor doc, grouped by task.
- [AGENTS.md](AGENTS.md): the invariants that fail silently, for any coding agent.
- [CLAUDE.md](CLAUDE.md): Claude Code's project memory, whose rules apply to anyone.
- [Gotchas](docs/gotchas.md): the mechanism and evidence behind each silent-failure rule.
- [Architecture](docs/architecture.md): how the editor, server and AI fit together.
- [Stacked PRs](docs/stacked-prs.md): chaining dependent pull requests safely.
- [Glossary → Claim tests](docs/glossary.md#claim-tests): why some doc edits fail CI.
