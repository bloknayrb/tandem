# Stacked pull requests

GitHub shipped native stacked PRs to **public preview on 2026-07-30**. This is the working
guide for using them here instead of hand-chaining `--base` flags.

> **Verification status.** Every command below is transcribed from GitHub's docs. The
> `gh stack` extension was **not installed on this machine** when this was written, so nothing
> here has been run. Treat the command surface as accurate-as-documented and the *semantics*
> section as the part worth re-checking against `gh stack --help` on first use. The section on
> the manual workflow's failure mode **is** first-hand — it happened on 2026-08-14.

## Why bother

A stack is two or more PRs where the bottom one targets `master` and each one above targets the
branch below it. GitHub now models that chain as an object it understands, which buys three
things the manual version does not have:

- **Automatic retargeting.** Merge a lower PR and every PR above it is rebased and retargeted
  for you.
- **One-click cascade merge.** Merging PR *n* lands *n* and every unmerged layer below it as a
  single operation.
- **A stack map on each PR**, so a reviewer can see where a change sits in the larger work.

### The failure mode this replaces (first-hand, 2026-08-14)

The five-PR `#1448` fidelity chain was hand-stacked with `--base`. Merging the bottom one with
`gh pr merge --delete-branch` **closed** the PR above it instead of retargeting it, and the
recovery path is blocked in the obvious direction: `gh pr edit --base master` returns *"Cannot
change the base branch of a closed pull request"*, and reopening needs the deleted base ref back.

Recovery, if it happens again on a hand-chained stack:

```sh
git push origin <merge-commit-sha>^2:refs/heads/<deleted-base>   # restore the ref
gh pr reopen <child>
gh pr edit <child> --base master                                  # now allowed
git push origin --delete <deleted-base>                           # safe once base is master
```

This repository has **auto-delete-on-merge enabled**, so every merge in a hand-chained stack is
exposed to this — passing `--delete-branch` is not what arms it. The manual mitigation is to
retarget each child *before* its parent merges. Stacks exist so you don't have to remember that.

## Install

```sh
gh extension install github/gh-stack
```

Requires `gh` (2.89.0 is what's here). No repository setting to flip is documented; exit code
**9** means stacked PRs are not enabled for the repo, which is how you'd find out otherwise.

## A stack from scratch

```sh
gh stack init                  # names the first branch; -b/--base to target something != default
git add . && git commit -m "..."
gh stack add second-branch     # new branch on top of the current stack
git add . && git commit -m "..."
gh stack push                  # push the stack's branches
gh stack submit                # create/update the PRs and the stack object
```

`gh stack submit` sets each base correctly — the first targets `master`, each next targets the
one below.

## Adopting branches you already have

Two entry points, and the difference matters:

- **`gh stack init -b master branch-a branch-b branch-c`** — builds a locally tracked stack from
  existing branches.
- **`gh stack link <branch-or-pr> <branch-or-pr> ...`** — links *already-open PRs* into a stack
  on GitHub **without local tracking**. This is the one for a chain that's already pushed and
  under review. Takes `--base`.

## Daily operations

| Command | What it does |
|---|---|
| `gh stack view` | Show the stack. `-s` short, `--json` for scripting |
| `gh stack checkout <n \| pr# \| url \| branch>` | Check out a stack by any handle |
| `gh stack sync` | Fetch, rebase, push and sync PR state in one go. `--prune` |
| `gh stack rebase` | Cascading rebase. `--downstack` / `--upstack` / `--no-trunk` / `--continue` / `--abort` |
| `gh stack push` | Push the stack's active branches |
| `gh stack submit` | Create or update the PRs. `--auto`, `--open` |
| `gh stack modify` | Interactive restructure — `i`/`I` insert, `Shift+↑/↓` reorder, `x` drop |
| `gh stack up` / `down` / `top` / `bottom` / `trunk` / `switch` | Navigate |
| `gh stack unstack` | Unlink on GitHub. `--local` for local tracking only |

## Merge semantics — the part to get right

- Merge the **lowest unmerged** PR; it and every unmerged PR below it land together as one
  operation.
- After a merge, the next unmerged PR is **automatically rebased to target the stack base
  directly**. No manual retarget.
- A PR merges only when **it and every PR below it** meet all merge requirements *and* the stack
  has a **fully linear history**. A non-linear stack blocks the merge — fix with
  `gh stack rebase` then `gh stack push`.
- Branch protections and required checks still apply, per PR. Merge-queue support was rolling
  out progressively as of the preview announcement, so confirm it before relying on it here.
- `gh stack merge` takes `--merge` / `--squash` / `--rebase` (or `--merge-method`) and `-y`.
  **Use `--merge`.** Granular history is the house preference, and squashing a stack collapses
  the layering the stack existed to express.

## Failure modes

| Symptom | Fix |
|---|---|
| Rebase conflict | Resolve, `git add .`, `gh stack rebase --continue` (or `--abort`) |
| `gh stack sync` conflict left branches half-done | `gh stack rebase`, then `gh stack push` |
| `gh stack modify` won't start | Needs: active stack, clean tree, no rebase in progress, no queued PRs, linear history |
| Modify session interrupted | `gh stack modify --abort`, or resolve + `git add` + `--continue` |
| Merge blocked | A lower PR fails a requirement, or history isn't linear |
| Merge failed mid-stack | Lower PRs landed; fix the failing one and retry — the rest stay open |
| PR pulled from merge queue | **Ejects every PR above it too.** Re-add the stack after fixing |
| A PR in the middle got closed | Blocks everything above. Unstack on the web, or `gh stack modify` |
| Commits unsigned after a rebase | A rebase triggered *from the PR page* runs server-side and is **not signed**. Rebase locally with `gh stack rebase` + `gh stack push` |

**Exit codes:** 0 ok · 1 generic · 2 not in a stack · 3 rebase conflict · 4 API failure ·
5 bad args · 6 needs disambiguation · 7 rebase already running · 8 stack locked by another
process · 9 stacked PRs not enabled for repo · 10 modify session needs recovery.

## Constraints

- **Same repository only.** Cross-fork stacks are not supported, with no documented workaround.
- Linear history is a merge requirement, not a style preference.
- Merged or queued PRs stay in the stack when you unstack; open, draft and closed ones leave.

## Fit with this repo's workflow

The workflow in `CLAUDE.md` is unchanged — plan, adversarial agent review, implement,
`/simplify`, verify, PR. Stacks only replace the *mechanics* of chaining, and they matter most
where the work naturally layers: a harness PR under the fixes it enables, or a refactor under
the feature that needs it.

Two local cautions carry over regardless:

- **The pre-push hook runs biome + the full vitest suite + `cargo test`** on every push, and
  `gh stack push` pushes several branches. Expect it to be slow, and expect the working tree
  state at that moment to be what gets tested.
- **Checks on a rebased branch are checks on a new SHA.** After any cascading rebase, a green
  tick you saw before is stale — re-read the rollup before merging, and count completed checks
  against the expected total rather than trusting "zero failures" on a partial set.

## Sources

- [Stacked pull requests are now in public preview](https://github.blog/changelog/2026-07-30-stacked-pull-requests-are-now-in-public-preview/) — GitHub Changelog, 2026-07-30
- [Stacked pull requests](https://docs.github.com/en/pull-requests/how-tos/stacked-pull-requests) — docs hub
- [CLI command reference](https://docs.github.com/en/pull-requests/reference/stacked-prs-cli-commands)
- [Quickstart](https://docs.github.com/en/pull-requests/get-started/stacked-prs-quickstart) ·
  [Managing](https://docs.github.com/en/pull-requests/how-tos/create-pull-requests/managing-stacked-pull-requests) ·
  [Merging](https://docs.github.com/en/pull-requests/how-tos/merge-and-close-pull-requests/merging-stacked-pull-requests) ·
  [Troubleshooting](https://docs.github.com/en/pull-requests/how-tos/merge-and-close-pull-requests/troubleshooting-stacked-pull-requests)
