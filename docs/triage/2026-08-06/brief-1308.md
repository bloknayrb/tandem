# Two expired pilots — and one of them was killed on a false premise

**Issues:** #1308 (open PR #1311 carries the removal)   **Decision needed:** Merge the knowledge-graph retirement but **restore `/diverge`** from PR #1311, and adopt the kill-date-as-issue convention — yes or no?

## What these are

Both pilots are still live on `master` (`c279f02`) and on this branch. The removal is staged in **open PR #1311**, commit `767b7d1` (2026-08-06).

**Knowledge graph — the criterion is met.** `node scripts/kg-lint.mjs` today: 27 nodes loaded, **27 warnings**, every node past the 60-day staleness threshold (81 days for most, 74 for the ADR-031 cluster). Highest ADR node present is `adr-038.md`; **ADR-039 through ADR-046 have no nodes** (`ls .claude/knowledge-graph/nodes/`). Last content commit to the directory was `dd39e8f`, 2026-05-25 — 73 days ago. Worth noting the linter **exits 0** and prints `Knowledge graph OK ✓` under all 27 warnings, so it could never have failed a gate anyway.

**`/diverge` — the criterion is NOT met.** The gate was "delete if not invoked within 30 days" (added `066096c`, 2026-05-28). It was invoked at least twice:

1. `9657de1` (2026-05-29) — a first-use validation run against two known-answer past decisions, whose findings were committed back into `diverge.md`.
2. `.claude/plans/diverge/solo-defer-and-release.md`, dated **2026-07-20** — a full 12-proposal run designing the WS-A2 Solo hold/release mechanism, which shipped as #1212 in v0.19.0. That is 23 days *after* the kill date, on load-bearing work.

## Why they stalled

For the knowledge graph, the honest answer is in the retirement commit itself: nobody ran the linter, because running it was part of the habit that lapsed. A self-check inside the artifact can't detect the artifact's own abandonment.

For `/diverge`, the cause is sharper and more useful: **`.claude/plans/` is gitignored (`.gitignore:28`).** The retirement swept `.github/workflows/`, `.claude/settings.json`, `.husky/`, `knip.json`, `tests/`, skills and commands — a thorough sweep of *tracked* files — and the pilot's entire evidence of use sat in the one directory git cannot see. The verdict was reached correctly against the wrong corpus.

## Options

**A. Merge #1311 as-is.** Cheapest. Deletes a command that demonstrably earned its keep, on a factually wrong finding. Forecloses nothing technically (it's restorable from git), but it teaches the wrong lesson.

**B. Split the PR: keep the KG deletion, restore `.claude/commands/diverge.md` + the seven `diverge-*` agents, re-date the gate.** One commit of work on an open PR. Costs a round-trip.

**C. Restore both, re-date both.** Ignores 27/27 measured staleness and 8 missing ADR nodes. The KG criterion fired correctly; overriding it just re-arms the same silent expiry.

## Recommendation

**B.** The knowledge graph failed its criterion on measured evidence — let it go. `/diverge` passed its criterion and was killed by a search that couldn't reach the evidence; restore it and re-date the gate to 2026-11-01 with the clause rewritten to something a tracked-file search *can* evaluate (e.g. "delete if no run has been cited in a merged PR description by <date>").

The convention worth adopting is #1308's own third suggestion, and it fixes exactly the failure that happened here: **when a pilot ships, open a GitHub issue titled `Pilot kill-gate: <name> — review <YYYY-MM-DD>`, labelled `kill-gate`, and put the criterion in the body.** No new machinery, and it lands the date in the triage flow rather than inside the artifact it governs. Add one line to the criterion template: *state the evidence source, and confirm it is git-tracked.*

## If yes / If no

**If yes:** amend PR #1311 to restore the `/diverge` files; open two `kill-gate` issues (one closing immediately with the KG verdict recorded, one dated 2026-11-01 for `/diverge`); add the convention to `CLAUDE.md`. Then close #1308 pointing at both.

**If no (merge as-is):** `/diverge` is gone and the decision is recorded on a premise the repo contradicts. If you take this path, at minimum correct the commit-message claim before merge — a future reader will otherwise take "40 days past, never invoked" as fact, and `.claude/plans/diverge/` will still be sitting on disk saying otherwise.
