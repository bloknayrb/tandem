# Agent Isolation Research

How to run 5–15 parallel Claude Code agents on Tandem without cross-worktree
contention, stash bleed, port collisions, `node_modules` corruption, or
`src-tauri/target` clashes.

**Audience:** Bryan (Windows 11, two-person project). Drafted 2026-05-15.

## TL;DR

If you only do one thing, **stop running the full vitest + cargo test suite
in `pre-push`.** Replace it with:

1. `vitest related --run` (only tests whose source files changed in the push)
2. `vitest run tests/cli/mcp-stdio.test.ts tests/server/file-opener-lifecycle.test.ts`
   gated behind `CI=1` (i.e. don't run locally; let GitHub Actions catch them)
3. `cargo check` instead of `cargo test` locally; full `cargo test` in CI only

That single change removes symptoms 3 and 6 entirely and makes symptom 5
non-fatal (cargo check serialises on the lockfile cleanly; cargo test does not
because it links binaries and races on `target/debug/deps/`).

After that, keep using `git worktree` (it's what Anthropic ships and what the
desktop app uses), but add three guardrails: a stash-name convention, a
worktree-aware `node_modules` setup, and per-worktree port allocation for the
server tests that *do* need TCP. Devcontainers/Docker/Codespaces are
**not recommended for Tandem** because Tauri builds + Azure Trusted Signing +
the Windows-host sidecar workflow all want to live on the Windows host.

The rest of this doc is the evidence.

---

## Symptom → root cause map

| # | Symptom | Root cause | Fixable without changing isolation model? |
|---|---|---|---|
| 1 | Agent writes to main repo instead of its worktree | Agent CWD drift; bash tool resets CWD between calls (CLAUDE.md note: "use absolute paths") | Yes — agent prompt discipline + a `cd` guard hook |
| 2 | `git stash pop` resurfaces another agent's WIP | `refs/stash` is global across all worktrees in a repo | Yes — ban `git stash` for agents; use named branches instead |
| 3 | mcp-stdio + file-opener tests flake under parallel pre-push | Spawned subprocess binds fixed 3478/3479; mammoth fixture missing from hoisted `node_modules` | Yes — move to CI; parameterise port; fix hoisting |
| 4 | `node_modules` install costs 3min per worktree, junction symlink corrupts on main `npm install` | Each worktree is a fresh tree; junction shares a single physical directory which main repo mutates | Yes — pnpm content-addressable store, or copy-on-write reflink, or yarn PnP |
| 5 | `cargo check` agents fight over `src-tauri/target/` | Cargo locks `target/` per invocation but not per worktree | Yes — `CARGO_TARGET_DIR` env per worktree |
| 6 | Sidecar binary stub clobbering | Stubs live in tracked path `src-tauri/binaries/`; multiple worktrees write at once | Yes — stubs in worktree-local cache dir, not repo-tracked path |

Every symptom is fixable without abandoning worktrees. None of them are
inherent to the worktree model — they're all knobs we haven't turned yet.

---

## Option comparison

### 1. Stronger git worktrees (status quo, tuned)

**Description.** Keep `.claude/worktrees/agent-*` per Anthropic's recommended
pattern. The CLI ships first-class `--worktree` flag support; the desktop app
creates one per session automatically. Worktrees share `.git/`, `refs/`,
hooks, and the object database; only `HEAD` and the index are per-worktree.
Stash and reflog are shared.

**Setup cost.** ~0 (already in use). One-time additions: `.worktreeinclude`
file, `CARGO_TARGET_DIR` shim, pnpm migration (optional but recommended), an
"agents shall not stash" convention enforced via a PreToolUse hook.

**Per-agent overhead.** ~50MB disk (working tree) + node_modules (see below).
RAM/CPU: only what each Claude Code process uses. Time to ready: ~5s for
`git worktree add` + 3min for `npm install` (or ~10s with pnpm + content store).

**Solves:** 1 (with `cd` discipline), 2 (with stash ban), 5 (with
`CARGO_TARGET_DIR`), 6 (with cache-dir relocation).
**Doesn't solve alone:** 3 (port collisions in tests — needs pre-push scope
reduction), 4 (node_modules — needs pnpm or reflink).

**Tandem-specific blockers.** None. This is what the official Claude Code
desktop redesign already does.

### 2. Per-agent Docker containers (Docker Desktop + WSL2)

**Description.** Each agent runs in its own Linux container with a bind-mount
of the repo (or a clone inside the container's overlay FS). Each container
can bind its own loopback `127.0.0.1:3478/3479` because container network
namespaces are isolated.

**Setup cost.** Multi-hour. Need a Dockerfile that mirrors Tandem's toolchain
(Node 24, Rust, GTK build deps for `cargo test`, Playwright browsers). Need a
launcher script that spawns containers with the right mounts.

**Per-agent overhead.** ~2–4GB RAM per container with Node + Vite + Rust
toolchain loaded. ~5–10s cold start. ~10GB disk per image layer cache.

**Solves:** 3 (independent network namespace = no port collision), 5 (each
container has its own `target/`), 6 (each its own `binaries/`).
**Doesn't solve:** 1, 2 (still same shared `.git` if you bind-mount).

**Tandem-specific blockers.** Major. (a) **Tauri builds**: Linux containers
can produce a Windows installer only via slow cross-compile, and the official
Tauri docs say cross-compile is "last resort". (b) **Azure Trusted Signing**:
the signing flow assumes a Windows host with the signing CLI present;
running it from inside a Linux container is unproven. (c) **File-watcher
performance**: bind-mounting `C:\Users\blokn\GitHub\tandem` into a Linux
container goes through the 9P file share, which kills inotify performance —
this would hurt Vite HMR significantly. The Docker docs explicitly recommend
keeping watched code inside the WSL2 ext4 FS, which means cloning the repo
*into* WSL2 — a separate physical checkout that defeats the purpose.

**Verdict.** Heavy lift, breaks Tauri workflow, no clear win over tuned
worktrees. **Reject.**

### 3. GitHub Codespaces / Microsoft Dev Box

**Description.** Cloud VM per agent, ~$0.18/hr compute + $0.07/GB-month
storage on Codespaces.

**Setup cost.** ~1hr to write a `.devcontainer/devcontainer.json` that
provisions Node + Rust + Playwright. Codespaces has a `claude-cli` devcontainer
feature.

**Per-agent overhead.** Cloud-billed. 5–15 agents × 8h/day × $0.18/hr ≈
**$8–$22/day** for a single dev's spawn rate. Plus 30–60s cold start unless
prewarmed.

**Solves:** All 6 symptoms — total isolation.
**Doesn't solve:** Tauri Windows installer testing still requires a local
Windows host. macOS bundle still requires a local Mac. So this only isolates
the *non-platform-bound* work, which is the majority but not the polish phase.

**Tandem-specific blockers.** Tauri build inside a Linux Codespace produces
only Linux bundles cleanly. Bryan still needs the local Windows host for
installer + Azure Trusted Signing validation, and the Mac for #428. So
Codespaces would be a *parallel-work pool*, not a primary dev environment.

**Verdict.** Worth keeping in pocket for the day Bryan wants to run a
"feature factory" batch overnight. Not the daily driver. **Defer.**

### 4. Hyper-V / Windows Sandbox / Multipass VMs

**Description.** Full Windows VMs cloned from a golden snapshot.

**Setup cost.** Hours. Building the golden image, scripting clone/spinup.

**Per-agent overhead.** 4–8GB RAM, ~30s boot, ~20GB disk per VM.

**Solves:** All 6 symptoms.
**Doesn't solve:** Filesystem sharing back to the host (for Bryan to look at
output) requires SMB or vmconnect — clunky.

**Verdict.** Way too heavy for a two-person project. **Reject.**

### 5. Devcontainers (VS Code spec)

Same engine as Option 2 (Docker under the hood) with a VS Code UX layer.
Anthropic does ship a `claude-cli` devcontainer feature, but each devcontainer
is still a Docker container with the same Tauri/Windows-host blockers. Useful
if Bryan wants a one-command "spin up a clean Linux env to triage a Linux-only
bug" — not useful as the default agent isolation strategy. **Defer / niche.**

### 6. Sandboxed test runners (no isolation change; just smaller blast radius)

**Description.** Stop running heavy tests in `pre-push`. Keep husky doing
biome + `npm test -- --changed` + `cargo check`, and push the rest to CI.
Parameterise the few tests that need real TCP via env vars
(`TANDEM_WS_PORT`, `TANDEM_MCP_PORT`).

**Setup cost.** ~30 minutes. Edit `.husky/pre-push`, add `--changed` invocation,
add `CI=1`-gated heavy tests, audit `tests/cli/mcp-stdio.test.ts` for fixed
ports.

**Per-agent overhead.** Reduces pre-push wall time from ~3min to ~10s for a
typical change, and removes the parallel-vitest port collision window entirely
because most agents won't bind any ports during their push.

**Solves:** 3 directly. Makes 5 and 6 much less likely to fire because cargo
tests stop running locally.

**Verdict.** **Highest leverage change. Do this first regardless of which
isolation strategy wins long-term.**

### 7. Bazel / Nx remote build cache

Overkill. Tandem's build is fast enough that the cache lookup overhead would
match the build savings. **Reject.**

### 8. Process-level isolation (Job Objects, sandbox-exec)

Sandboxes the *process*, not the *filesystem*. Doesn't solve any of the six
symptoms; they're all filesystem/network/state issues, not "agent escapes
its CPU bucket" issues. **Reject.**

---

## Recommended setup for Tandem

A four-part plan, ordered by leverage:

### Part 1 — Pre-push diet (fixes symptom 3, 5, 6) — **do today**

Edit `.husky/pre-push`:

```sh
#!/usr/bin/env sh
set -e
npx biome check src/ tests/
# Only tests whose sources changed since origin/master
git fetch origin master --quiet || true
BASE=$(git merge-base HEAD origin/master 2>/dev/null || git rev-parse HEAD~1)
npx vitest related --run $(git diff --name-only "$BASE"...HEAD | tr '\n' ' ')
cargo check --manifest-path src-tauri/Cargo.toml
```

Move the full `npm test` + `cargo test` into a `pre-merge` GitHub Action
(already exists for cargo per CLAUDE.md). The two flaky tests
(`mcp-stdio.test.ts`, `file-opener-lifecycle.test.ts`) become CI-only.

### Part 2 — Worktree hygiene (fixes symptoms 1, 2, 5, 6) — **do this week**

1. **Stash ban.** Add a PreToolUse Bash hook that blocks `git stash` (or
   `git stash push`) when CWD contains `.claude/worktrees/`. Force agents to
   commit-to-branch instead — branches are per-worktree, stashes are global.
2. **`CARGO_TARGET_DIR` per worktree.** In each agent's working dir set
   `CARGO_TARGET_DIR=.cargo-target` (a path relative to the worktree). Cargo
   honours it everywhere. Add a one-line `.envrc` template that
   `WorktreeCreate` writes when the agent boots.
3. **Sidecar stubs out of the tracked tree.** Move the
   `src-tauri/binaries/node-sidecar-<triple>[.exe]` stub-creation logic into a
   `scripts/cargo-test-prep.mjs` that writes into `$CARGO_TARGET_DIR/stubs/`
   and points `tauri.conf.json`'s `bundle.externalBin` at that path via env
   substitution. (Or simpler: keep the current location but skip `cargo test`
   in pre-push entirely per Part 1 — clobbering only matters if two agents
   actually run cargo test simultaneously.)
4. **`.worktreeinclude`.** Add `.env`, `.env.local`, and any local-only
   config so Anthropic's worktree creator copies them into each new worktree.
   Without this, agents will silently fall back to default config.
5. **Add `.claude/worktrees/` to `.gitignore`** (if not already — quick check
   needed) so worktree contents never appear as untracked files in the main
   checkout.

### Part 3 — node_modules deduplication (fixes symptom 4) — **do this month**

Three options, in order of preference:

1. **pnpm with content-addressable store.** Migrate from npm to pnpm. Every
   worktree gets a real `node_modules/` but all package files are hard-links
   into a single global content store. Install in a fresh worktree takes
   ~10s after the first time, costs ~zero extra disk. Main repo running `npm
   install` no longer affects sibling worktrees because they each link from
   the store, not from a shared `node_modules/`. **This is the right answer
   for parallel-agent Node projects in 2026.** Risk: husky scripts and any
   `node node_modules/...` references need a small audit.
2. **Reflinks / dev drive.** Windows 11 Dev Drive (ReFS) supports
   copy-on-write reflinks. `robocopy /MIR` with reflink semantics is fast.
   More fragile than pnpm.
3. **Status quo (junction).** Document the rule: "do not run `npm install` in
   main repo while worktrees exist." Cheapest but error-prone.

### Part 4 — Port parameterisation (cleanup) — **nice to have**

For the rare case where two pre-push runs *do* both want to bind 3478/3479
(e.g. CI=0 power user runs full suite locally):

- Make `DEFAULT_WS_PORT` / `DEFAULT_MCP_PORT` read from
  `process.env.TANDEM_WS_PORT` / `TANDEM_MCP_PORT` first.
- In the test setup that spawns the server subprocess, pass
  `TANDEM_WS_PORT=0` to let the OS assign, capture from server stdout/health
  endpoint.

This is the same pattern the current `tests/cli/mcp-stdio.test.ts` *already
uses for its in-process TCP probes* (`listen(0, "127.0.0.1", ...)`). The bug
is that the spawned `tsx src/server/index.ts` child reverts to the fixed
constants. Closing that gap eliminates the last source of port flakes.

---

## What this plan does NOT do

- **Does not give you bulletproof cross-platform sandboxing.** An agent that
  decides to `rm -rf /` in its worktree can still walk up and rm the parent.
  If you need that, Codespaces (Option 3) is the right escape hatch — defer
  until a clear need.
- **Does not parallelise Tauri release builds.** Those still need to run on
  the Windows host with the Azure Trusted Signing CLI present. That's
  acceptable: release builds are 1-2× per week, not 5-15× per day.
- **Does not solve the "agent forgot it was in a worktree" problem fully.**
  CWD drift in the bash tool is fundamental. The mitigation is the user-level
  rule already in CLAUDE.md ("only use absolute file paths"), plus a hook
  that warns when an `Edit`/`Write` tool targets a path outside the agent's
  declared worktree root. Worth filing as a follow-up if symptom 1 recurs
  after Parts 1-3.

---

## One-thing recommendation

**Ship Part 1 today.** It removes 3 of the 6 symptoms in a 30-minute edit,
costs no architecture change, and is independently valuable (faster local
push loop for solo work too). Then come back for Parts 2 and 3 in the next
quiet day.

Everything else — containers, Codespaces, VMs — is more setup than the
problem warrants for a two-person project where the only reason for the
isolation is to run 5-15 Claude agents per day. Worktrees are the right tool
when their sharp edges are filed down, and Anthropic has been investing
heavily in making them sharper-edge-free (the May 2026 desktop redesign,
`--worktree` flag, `.worktreeinclude`, `WorktreeCreate` hooks all landed in
the past two months). Ride that wave.

---

## Sources

- [Claude Code — Run parallel sessions with worktrees](https://code.claude.com/docs/en/worktrees)
- [GitHub Copilot CLI uses global git stash in worktrees (issue #1725)](https://github.com/github/copilot-cli/issues/1725)
- [Docker Desktop — WSL 2 best practices](https://docs.docker.com/desktop/features/wsl/best-practices/)
- [INOTIFY events not supported in WSL2 (docker/for-win #12898)](https://github.com/docker/for-win/issues/12898)
- [Tauri v2 — Windows Code Signing (Azure Trusted Signing)](https://v2.tauri.app/distribute/sign/windows/)
- [Tauri v1 — Cross-Platform Compilation (signCommand caveats)](https://v1.tauri.app/v1/guides/building/cross-platform/)
- [Vitest CLI — `--changed` and `related`](https://vitest.dev/guide/cli)
- [Vitest #1113 — `--changed` only considers source files](https://github.com/vitest-dev/vitest/issues/1113)
- [GitHub Codespaces pricing](https://github.com/pricing/calculator)
- [Claude Code devcontainer feature (centminmod/claude-code-devcontainers)](https://github.com/centminmod/claude-code-devcontainers)
