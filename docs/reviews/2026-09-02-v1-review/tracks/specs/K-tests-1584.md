# K-tests — #1584 The three citation families #1531's detector does not cover

Branch `fix/test-suite-integrity-silent-greens-fragile-assertions-and-an-unimplemented-perf-decision-1861`.
Closes #1584. Ledger: `docs/plans/2026-09-06-open-issues-sweep.md:459`. Probe:
`npx vitest run tests/build/invariant-citations.test.ts` before and after (must stay green
throughout — this fix never touches `DANGLING_CITATION_RE`, only the cited sites and the
detector's own docblock).

## Problem

`tests/build/dangling-citations.ts`'s docblock names three families its `DANGLING_CITATION_RE`
deliberately does not cover: `plan §N` into gitignored `.claude/plans/`, `review §N` naming an ad
hoc review pass, and a parenthesised trailing-token citation. The issue's own menu: inline the
rationale, re-label with a tracked document, or declare acceptable — per family. Verified against
current master, per site:

**"review §N" / trailing-token — inline, no tracked document exists for either:**
- `src/server/license/license-state.ts:13`, `src/server/mcp/routes/license.ts:137`,
  `src/server/license/kv-store.ts:76` — all cite an ad hoc `§12` review pass; grepped
  `docs/plans/2026-08-24-ai-assisted-maintainability-remediation.md` (the one tracked plan whose
  numbering could plausibly match) for a `§12` section: none.

**"plan §N" — local-model M2b plan, re-label with `#1123`** (matches two sibling sites that
already do this correctly: `tests/client/first-run-model-picker.test.ts`,
`tests/client/model-edit-modal.test.ts`):
- `src/server/local-model/collaborator.ts:11,151`, `src/server/local-model/index.ts:14`,
  `src/server/local-model/ollama-client.ts:286`,
  `tests/client/integration-wizard-models.test.ts:12`, `tests/client/use-models-loading.test.ts:8`.

**"plan §N" — card-density plan (different, untracked plan) — declare acceptable:**
- `src/client/panels/cardDensity.ts:7,31`, `tests/e2e/margin-view.spec.ts:1097`. Searched
  `docs/design-system-impl/`, `docs/plans/archived/`, and `gh issue list` for "plan C2"/"stub
  click" — not found in any; `docs/design-system-impl/3.5-coordination-handoff.md:7` confirms this
  citation resolves to a gitignored local plan file, never committed to this repo.

**"plan §N" — the V2 plan, re-label with a tracked document (not "declare acceptable"):**
- `tests/client/MarginColumn.import-author.test.ts:9` — "V2 plan §4.1b". This one **is** tracked:
  `docs/plans/archived/2026-05-28-stage-c3-bezier-leaders-anchor-dots.md` is a committed file
  titled "… (V2)" whose own `### 4.1b NEW: tests/client/MarginColumn.import-author.test.ts` section
  header (`:232`) is a byte-for-byte match to this citation. Re-label rather than declare
  acceptable.

## Fix

- Inline rationale at the three "review §N"/trailing-token sites — replace `(§12 L…)` with a plain
  sentence explaining the check in place (e.g. `license-state.ts:13`: "an unknown major is rejected
  rather than silently honored — a future schema bump must be handled explicitly here").
- Prefix `plan` with `#1123 plan` (or `#1123's plan` for the possessive phrasing at `index.ts:14`)
  at the six local-model sites — mechanical, matching the two already-correct sibling sites. Two of
  these six are under `tests/client/`, comment-only; re-read both lines against current master
  before editing (this group's coordination note carves that directory out to #1966 except where a
  named bullet requires it — this one does, comment-only).
- `MarginColumn.import-author.test.ts:9` — cite
  `docs/plans/archived/2026-05-28-stage-c3-bezier-leaders-anchor-dots.md §4.1b` in place of the bare
  "V2 plan §4.1b".
- Update `dangling-citations.ts`'s "WHAT THIS DETECTOR DOES NOT COVER" docblock: replace "Tracked in
  #1584" with the decision outcome for all three families, **keeping the NOT-COVERED framing** — a
  future site of this shape is still invisible to `DANGLING_CITATION_RE` by design, so say that
  explicitly rather than implying the detector now covers these.

## Tests

No new detector tests — `DANGLING_CITATION_RE` is unchanged; `invariant-citations.test.ts`'s
existing sweep must stay green before and after. Grep-verify after editing: none of the three
inlined sites contains a bare `§12` citation; all six re-labeled sites contain the literal
`#1123`; the `MarginColumn.import-author.test.ts` site contains
`2026-05-28-stage-c3-bezier-leaders-anchor-dots.md`.

## Done when

All ten sites above are resolved per family; the docblock reflects the closed decision for all
three families with NOT-COVERED framing kept; `npx vitest run tests/build/invariant-citations.test.ts`
green; `npm run typecheck` AND `npm run typecheck:tests` green (comment-only edits, but two sites
are `tests/client/`, reached only by `typecheck:tests`).

## Not in scope

Widening `DANGLING_CITATION_RE` — the issue's menu is resolve-the-known-sites, not
extend-the-scanner. The two `plan §N` sites that already cite `#1123` — untouched, already correct.
Any change to `src/server/local-model/`, `src/server/license/` *behavior* — every touch here is
comment/doc-string only.

## Review corrections (round 2 — code review cr-1)

**The "re-label with `#1123 plan §N`" fix for the six local-model sites was wrong for four of
them, and shipped anyway.** Round-1 verified only that `first-run-model-picker.test.ts` and
`model-edit-modal.test.ts` (the "two sibling sites") cite real M2b §3.3/§3.4/§3.5 headers, then
assumed the same `#1123 plan §N` shape would resolve for the six M1.2 sites without checking
each numeral against a real doc. It doesn't: `docs/plans/archived/1123-*.md` starts at
`1123-m1a-*` — **M1.1/M1.2 (#1159/#1160) shipped before any `1123-*` plan doc existed**, so no
tracked plan document covers the content these four sites describe at all, at any section number.
Checked directly: M1a's own §3/§3.2/§3.5/§3.6/§3.7 cover the resolver, transport-derivation
sub-decisions and the one-time client migration — not M1.2's single-flight controller, streaming
hardening or structural-redaction rule. `#1123 plan §3.5b`/`§3.2`/`§3.7`/`§3`/`§3.6` at
`ollama-client.ts:286`, `index.ts:14`, `collaborator.ts:11,151` were therefore re-labeled from
"dangling to everyone without `.claude/plans/`" to "dangling to everyone, period" — a strictly
worse citation, because it now *reads* resolvable.

**Corrected fix:** those four sites cite the actual tracked record for M1.2 — the merged PR body
`#1160` — by its section *title* in prose (`"Streaming transport"`, `"Stays byte-identical to
today when dark"`, `"Product decisions wired in"`, and `classifyFailure`'s redaction cites
#1160's "structured-failure-no-raw-leak" test line), since PR bodies carry no `§`-numbered
sections to cite. The two already-correct M2b §3.8 sites
(`integration-wizard-models.test.ts`, `use-models-loading.test.ts`) are untouched — verified
against `docs/plans/archived/1123-m2b-models-ui-mount.md`'s real §3.8 header
("Flag-ON test coverage") and left as `#1123's plan §3.8` / `#1123's M2b plan §3.8`.
`dangling-citations.ts`'s own docblock is corrected to describe this outcome rather than the
wrong one.

## Review corrections (scope cut)

- Kept the direct correctness fix for the blocking finding: `MarginColumn.import-author.test.ts:9`
  moved from "declare acceptable" to "re-label with a tracked document," with the exact section-
  header match as evidence.
- Removed the round-1 additions found via a repo-wide grep beyond #1584's own site list
  (`src/server/annotations/sync.ts:515`, and the verbatim `docs/licensing-operations.md:116` twin of
  `kv-store.ts:76`) — neither is one of the sites #1584 tracks; fixing them here would be scope
  growth into a fourth, self-discovered site list rather than closing out the issue's own three
  families. Left untouched; not a tracked deferral, since neither is a defect, only an unpolished
  comment of the same low-severity shape the issue's own detector already declines to chase.
- Removed the "Coordination-boundary note" essay (scanner-clearance walkthrough for
  `loopback-gate-claims.test.ts`) — the two-line summary above ("comment-only, re-read before
  editing") covers what a reviewer needs.
