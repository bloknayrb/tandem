# Pre-Push Biome Hook Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a pre-push git hook that runs `npx biome check src/ tests/` so formatting violations in untouched files are caught locally before they reach CI.

**Architecture:** A single `.husky/pre-push` shell script mirrors CI's `biome check` step but scopes to `src/` and `tests/` to avoid the nested-`biome.json` error caused by `.claude/worktrees/` subdirectories. No new dependencies — husky is already installed and configured.

**Tech Stack:** Husky (already installed), Biome (already installed), shell script

---

## Background

CI runs `npx biome check .` from a clean checkout (no `.claude/worktrees/`) and catches violations in any file. Locally, lint-staged only runs Biome on **staged files**, so pre-existing formatting issues in unstaged files pass the pre-commit hook and reach CI. A pre-push hook that checks all of `src/` and `tests/` closes this gap.

Why `src/ tests/` not `.`: the repo has nested `biome.json` files under `.claude/worktrees/` that cause Biome to exit with a config error when given `.` as the target. CI avoids this because CI checkouts never include those directories. Scoping to `src/ tests/` matches what CI verifies.

## Files

- **Create:** `.husky/pre-push`
- **Modify:** none

---

### Task 1: Write and verify the pre-push hook

**Files:**
- Create: `.husky/pre-push`

- [ ] **Step 1: Confirm Biome works with scoped paths**

Run from repo root to verify exit code 0:

```bash
npx biome check src/ tests/
```

Expected output ends with: `Checked N files in Xms. No fixes applied.`  
Expected exit code: `0`

If it prints formatting errors, fix them first with `npx biome check --write src/ tests/` before proceeding.

- [ ] **Step 2: Create `.husky/pre-push`**

```bash
#!/usr/bin/env sh
npx biome check src/ tests/
```

The file must be executable. On Windows (git-bash / husky), husky sets the executable bit automatically when it runs the hook — but set it explicitly anyway:

```bash
chmod +x .husky/pre-push
```

- [ ] **Step 3: Verify husky picks up the hook**

Run a dry-run push that won't actually push (push to a non-existent remote ref):

```bash
git push origin HEAD:refs/heads/__biome-hook-test__ --dry-run 2>&1
```

Expected: husky runs the pre-push hook and Biome output appears before the dry-run result. If the hook is not found, check that `.husky/pre-push` exists and is executable.

Delete the test ref if it was accidentally created:

```bash
git push origin --delete refs/heads/__biome-hook-test__ 2>/dev/null || true
```

- [ ] **Step 4: Stage and commit**

```bash
git add .husky/pre-push
git commit -m "ci: add pre-push biome check on src/ and tests/

Mirrors the CI 'npx biome check .' step but scopes to src/ and tests/
to avoid the nested biome.json config error from .claude/worktrees/.
lint-staged only checks staged files; this hook catches pre-existing
violations in untouched files before they reach CI."
```

- [ ] **Step 5: Verify the hook runs on real push**

Push the commit to the PR branch:

```bash
git push
```

Expected: Biome runs as part of the push, exits 0, push succeeds.

---

## Definition of Done

- `.husky/pre-push` exists and is executable
- `git push` triggers `npx biome check src/ tests/` before the push completes
- A file with a known Biome violation in `src/` (e.g. wrong import order) causes `git push` to be aborted with a non-zero exit
- A clean repo pushes without any Biome output errors
