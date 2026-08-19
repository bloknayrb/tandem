# Contributing to Tandem

Tandem is a small project (two maintainers). There is no CLA and no committee — the bar is that a
change is correct, tested, and does not silently break an invariant.

Start with [README.md](README.md) for what Tandem is. Read [AGENTS.md](AGENTS.md) before writing
code: it lists the invariants that fail *silently* — code that type-checks, passes tests, and is
wrong at runtime. If you are working with Claude Code, [CLAUDE.md](CLAUDE.md) is the long form.

## Prerequisites

- **Node.js 22.12.0 or newer**, and npm. This is the floor `package.json`'s `engines` field
  declares. In practice it's a build-toolchain constraint — once you're on Node 22, Vite / rolldown
  (devDependencies) require 22.12 specifically — not a runtime one; `tandem doctor` checks against
  this same declared value. See
  [#1533](https://github.com/bloknayrb/tandem/issues/1533) for whether that's the number this
  project should keep asserting. Check `node --version` yourself.
- **Rust and the Tauri toolchain**, if you will touch `src-tauri/` — or if you will push at all.
  The pre-push hook runs `cargo test`. See "Before your first push" below.

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

For exposing the server on a LAN, set `TANDEM_BIND_HOST`. LAN peers holding the auth token can
**read** `/api` but not write to it — `/api` is loopback-only for non-GET methods, so
`tandem rotate-token` has to be run on the machine hosting the server. See
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
| `npm run doctor` | Diagnose ports, Node version, MCP config, server health |

See [docs/cli.md](docs/cli.md#npm-run-scripts-source-checkouts-only) for the full list of npm
scripts.

## Checks

| Command | Scope |
|---|---|
| `npm run typecheck` | tsc server + client + `svelte-check --fail-on-warnings` |
| `npm test` | Vitest — unit and integration |
| `npm run test:e2e` | Playwright — **refuses to run while Tandem or `dev:server` holds :3479**, and frees :3478/:3479 when it starts its own |
| `npm run check:tokens` | Raw hex/rgba scan over `src/client/` |
| `npm run check:links` | Relative markdown links across the repo. Runs in neither CI nor the hooks |
| `npm run audit:origins` / `npm run audit:ymap-keys` | Static walks for the Y.Doc origin-tagging and Y.Map-key invariants |
| `cargo test --manifest-path src-tauri/Cargo.toml` | The Rust/Tauri layer |

`npm run test:e2e` starts its own servers and frees the two ports first, so do not run it while
`dev:server` is up — and two people (or two agent sessions) cannot run it concurrently on one
machine: the ports and the app-data dir are fixed.

## What the git hooks actually run

This trips up every new clone, so it is stated exactly:

- **`pre-commit`** runs `lint-staged` — ESLint `--fix` and Biome `check --write` on staged sources,
  `scripts/check-semantic-tokens.ts` on staged `src/client/**`, and an EOL normalizer on staged
  markdown/YAML. **It does not typecheck and does not run tests.**
- **`pre-push`** runs, in order:
  1. `npx biome check src/ tests/`
  2. `npm test -- --run --reporter=dot` — the **full** Vitest suite, not a subset
  3. `cargo test --manifest-path src-tauri/Cargo.toml`

  A delete-only push (branch pruning) skips all three.

Two consequences worth internalising. The suite that runs at push time is the *whole* suite, so
budget minutes, not seconds. And whatever is in your working tree while the hook runs is what gets
tested — do not edit during a push.

## Before your first push

**A fresh clone cannot push.** `cargo test` requires GTK development libraries and the two sidecar
binaries that `tauri_build::build()` checks for existence, neither of which is in the repo. Do this
once:

```sh
TRIPLE=$(rustc -vV | sed -n 's/host: //p')
mkdir -p src-tauri/binaries dist/{channel,server,client,stdio-bridge}
touch src-tauri/binaries/{node-sidecar,tandem-reaper}-$TRIPLE{,.exe}
```

On Debian/Ubuntu also install:

```sh
apt-get install -y libwebkit2gtk-4.1-dev libappindicator3-dev librsvg2-dev patchelf libxdo-dev
```

`libxdo-dev` is the one people miss. It is pulled in by a Cargo feature, so omitting it surfaces as
a bare `rust-lld: error: unable to find library -lxdo` thousands of lines into linker output, long
after the GTK packages everyone remembers are already installed.

The `dist/` list must stay in sync with `bundle.resources` in `src-tauri/tauri.conf.json`, not with
whatever happens to be in `dist/`.

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

## Commits and pull requests

- Conventional Commits: `type(scope): description`, imperative, ≤72 chars. Explain *why*; the diff
  already shows *what*.
- Branch as `type/short-description`. Never commit to `master`.
- One PR per concern. Include a problem/solution summary, the commands you ran, screenshots for
  visible UI changes, and `Closes #N` where it applies.
- Call out configuration, security, or migration impact explicitly.
- Work that layers — a harness under the fixes it enables, a refactor under the feature needing
  it — belongs in a **stack**, not a hand-chain of `--base` flags. See
  [docs/stacked-prs.md](docs/stacked-prs.md); this repo auto-deletes merged branches, which
  silently *closes* a hand-chained child PR rather than retargeting it.

## Security

Do not commit secrets or local MCP credentials; start from `.env.example` and `.mcp.json.example`.

If a change touches network posture, CORS, authentication, or the `/api` surface, read
[docs/security.md](docs/security.md) first — several invariants there are enforced by review
rather than by CI, and the enumerated route lists in [CLAUDE.md](CLAUDE.md) *are* that review. Do
not condense them.

Report a suspected vulnerability privately to the maintainers rather than opening a public issue.
