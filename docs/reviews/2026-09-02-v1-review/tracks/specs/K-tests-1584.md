# K-tests — #1584 The three citation families #1531's detector does not cover

Branch `fix/test-suite-integrity-silent-greens-fragile-assertions-and-an-unimplemented-perf-decision-1861`.
Closes #1584. Ledger: `docs/plans/2026-09-06-open-issues-sweep.md:459`. Probe:
`npx vitest run tests/build/invariant-citations.test.ts` before and after (must stay green
throughout — this issue's fix never touches `DANGLING_CITATION_RE`, only the cited sites and the
detector's own documentation of what it does not cover).

## Problem

`tests/build/dangling-citations.ts`'s docblock names three families of dangling-citation habit its
`DANGLING_CITATION_RE` deliberately does not match, all tracked here by #1584: `plan §N` into
gitignored `.claude/plans/` (11 sites), `review §N` naming an ad hoc review conversation rather
than a document (2 sites), and a parenthesised citation with a trailing token, `(§12 L1)` (1 site,
outside branch 3's `)` must-follow-the-numeral requirement). The issue's own menu is "decide per
family: inline the rationale, re-label with a tracked document, or declare it acceptable" — this is
a documentation/decision issue, not a request to widen the regex (the detector's own docblock
already argues against that: "the limit is deliberate because widening to reach them costs more
than it buys").

Verified against current master (line numbers drift; sites re-grepped rather than trusted from the
issue body):

**Family "review §N" — inline, 2 sites, no tracked document exists for either:**
- `src/server/license/license-state.ts:13` — `// an unknown major is rejected rather than silently
  honored (review §12 L3).`
- `src/server/mcp/routes/license.ts:137` — `* not the mutation helper — review §12 M1).`

Both "L3"/"M1" numerals point at an ad hoc review pass, not any file in the repo — checked
`docs/plans/2026-08-24-ai-assisted-maintainability-remediation.md` (the one tracked plan whose own
`§12`/Unit numbering could plausibly match, since #1599 cites its "Unit 4") for a `§12` section:
none exists. Confirmed as "review names a review conversation, not a document," per the issue.

**Family "parenthesised trailing token" — inline, 1 site:**
- `src/server/license/kv-store.ts:76` — `// Log id only — never the email (§12 L1). The id is
  opaque.` Same non-existent `§12` document; same resolution.

**Family "plan §N" — SPLITS further on inspection, which the issue's flat file list did not
distinguish:**

Two of the issue's originally-listed sites already cite a tracked issue and are NOT dangling —
this is drift since the issue was filed, verified by re-reading both files:
- `tests/client/first-run-model-picker.test.ts:4,9,12` — `(#1123 M2b §3.3 + §3.5)`.
- `tests/client/model-edit-modal.test.ts:4` — `(#1123 M2b §3.4)`.

Both already name `#1123` (the tracked, OPEN local-model feature issue — confirmed via
`gh issue view 1123`: "v1.0 local models: outbound LLM client + tool-use loop"). These are FINE
as-is; no change.

The remaining plan-§N sites split by WHICH plan they cite, verified by reading each:

- **Local-model M2b plan — re-label with `#1123`, matching the two sites above exactly (6
  sites, cheapest correct fix):**
  - `src/server/local-model/collaborator.ts:11` — `Design (see plan §3):`
  - `src/server/local-model/collaborator.ts:151` — `redaction, per plan §3.6.`
  - `src/server/local-model/index.ts:14` — `... See the plan's §3.2/§3.7.`
  - `src/server/local-model/ollama-client.ts:286` — `// boilerplate; see the plan §3.5b.`
  - `tests/client/integration-wizard-models.test.ts:12` — `the plan §3.8 — the constant stays...`
  - `tests/client/use-models-loading.test.ts:8` — `see the M2b plan §3.8).`
- **A different, unrelated plan (card-density "plan C2" / "plan §5 stub click") — declare
  acceptable, no tracked document substitute exists (2 sites, re-verified round-1 — see below):**
  - `src/client/panels/cardDensity.ts:31` — `divergence from plan §5 "stub click → full in
    place"` (and `:7`, `plan C2`, same document).
  - `tests/e2e/margin-view.spec.ts:1097` — `the resolved divergence from plan §5 "stub click →`.

  Verified round-1 by grepping `docs/design-system-impl/` and `docs/plans/archived/` for the
  section this cites, before accepting: `grep -rn "stub click" docs/` returns nothing outside this
  spec file itself. `docs/design-system-impl/3.5-coordination-handoff.md:7` names what "plan §12
  C2"/"plan §5" actually is — `~/.claude/plans/the-current-way-we-compiled-thimble.md`, a
  genuinely gitignored, untracked local plan file, never committed to this repo. Searched: `docs/`
  (repo-wide grep for "stub click"), `docs/design-system-impl/`, `docs/plans/archived/`, `gh issue
  list`/`gh issue view` for "plan C2" or "stub click" — not found in any. Declared acceptable per
  the issue's third option, on that basis.

- **The V2 plan family — RE-LABEL with a tracked document, not "declare acceptable" (1 site,
  corrected round-1):**
  - `tests/client/MarginColumn.import-author.test.ts:9` — `Closes the gap from the V2 plan
    §4.1b —`.

  **Round-0 of this spec wrongly declared this acceptable, asserting "no GitHub issue names … 'V2
  plan' anywhere in this repo's history."** That is false: `docs/plans/archived/2026-05-28-stage-
  c3-bezier-leaders-anchor-dots.md` is a TRACKED, committed file — verified by reading it — titled
  `# Stage C-3 — Bezier leaders + anchor dots (V2)` (`:1`), explicitly self-identified as "V2" in
  its own status line (`:3`, "Status: V2, post-adversarial-review. Replaces V1 …"), and its own
  `### 4.1b NEW: tests/client/MarginColumn.import-author.test.ts` section header (`:232`) is a
  byte-for-byte match to the exact test file and section number the citation names. This is not
  the same document as the "plan C2"/"stub click" family above — that one is the gitignored thimble
  plan; this one is a tracked, archived plan doc in this repo. Re-label rather than declare
  acceptable.

## Fix

**Inline (4 sites, small, well-understood from surrounding code — one added round-1):**

- `license-state.ts:13` → `// an unknown major is rejected rather than silently honored — a
  future schema bump must be handled explicitly here, never fall through as if it were v1.`
- `license.ts:137` → `* not \`assertLoopbackForMutation\` — this GET degrades to a scrubbed
  response for a non-loopback caller rather than refusing one, and that helper 403s instead of
  scrubbing).` (verified: `assertLoopbackForMutation`, `src/server/integrations/api-routes.ts:321`,
  responds 403 to a non-loopback caller outright — wrong behavior for a route whose own next line
  is `if (isLoopback(...)) full else scrubbed`.)
- `kv-store.ts:76` → `// Log the id only, never the email — the id is opaque and safe to log; the
  email is PII and must never land in a server log.` **Its verbatim twin** —
  `docs/licensing-operations.md:116` (`> **id** only, never the email (§12 L1). The issuance
  Worker already does this.`) — carries the same dangling `§12 L1` and is not code, so
  `dangling-citations.ts` never scans it, but it is the same citation habit in the same repo;
  round-1 addition, same replacement wording (adapted to the doc's own prose).
- `sync.ts:515` (`src/server/annotations/sync.ts`) — round-1 addition, found by a repo-wide grep
  for `plan §` this spec's original site list missed: `* Algorithm (see the Phase 1 plan
  §"Merge rules" for background):`. Same family as the "review §N" sites (a quoted section name
  rather than a numeral, citing an ad hoc plan pass with no tracked document) → `* Algorithm
  (merge precedence: newest-wins per record id, with tombstones taking priority over any surviving
  content — see the function body below for the per-field detail):`.

**Re-label with `#1123` (6 sites, mechanical, matches the 2 already-correct sibling sites
exactly):** prefix `plan` with `#1123 plan` (or `#1123's plan` for `index.ts:14`'s possessive
phrasing) at each of the six local-model sites above. No other wording change. **Two of these six
sites are under `tests/client/` — `integration-wizard-models.test.ts:12`,
`use-models-loading.test.ts:8`.** The group's coordination note carves `tests/client/**` out to
#1966 ("touch those only if a named bullet requires it, and re-read them first"); this bullet does
require it (comment-only, exactly matches the mechanical re-label applied to the other four
sites), and both files were re-read against current master (`09d304e2`) before this spec was
finalized — verify the two lines still exist at those offsets before editing.

**Re-label with a tracked document (1 site, corrected round-1 — was "declare acceptable"):**
- `tests/client/MarginColumn.import-author.test.ts:9` → cite
  `docs/plans/archived/2026-05-28-stage-c3-bezier-leaders-anchor-dots.md §4.1b` in place of the
  bare "V2 plan §4.1b" — e.g. `// Closes the gap from docs/plans/archived/2026-05-28-stage-c3-
  bezier-leaders-anchor-dots.md §4.1b — \`leaderColorForAuthor\` is unit-tested`.

**Declare acceptable (2 sites, no code change — corrected round-1 to exclude the V2-plan site
above):** update `tests/build/dangling-citations.ts`'s "WHAT THIS DETECTOR DOES NOT COVER" section
— the `plan §N` bullet currently reads "Tracked in #1584 rather than half-done here." Replace with
the decision outcome now that #1584 is closed, **keeping the section's existing NOT-COVERED
framing rather than implying the detector now covers these** (a future new site of this shape is
still invisible to `DANGLING_CITATION_RE` by design — say so explicitly, don't just report the old
sites as "fixed"): state that the local-model M2b sites were re-labeled with `#1123`, the
`MarginColumn.import-author.test.ts` V2-plan site was re-labeled with its tracked archived-plan
citation, and the remaining card-density/margin "plan C2"/"plan §5 stub click" sites are accepted
as-is (searched `docs/design-system-impl/`, `docs/plans/archived/` and `gh issue list` for a
tracked equivalent — not found; genuinely a gitignored, untracked local plan file, inlining costs
more than the citation is worth). Same edit updates the `review §N` and trailing-token bullets to
record "resolved under #1584 (inlined)" — again keeping the NOT-COVERED framing rather than
implying regex coverage changed. **When rewriting, re-derive the `plan §N` file list by grep rather
than editing the existing sentence** — the current docblock (`:47-50`) undercounts (says "four
`tests/client/*` files"; a grep finds five, plus `tests/e2e/margin-view.spec.ts`, which the
existing sentence omits entirely) and a straight edit would carry that miscount forward.

## Tests

No new detector tests — `DANGLING_CITATION_RE` is unchanged, so `invariant-citations.test.ts`'s
existing positive control and repo-wide sweep are the discriminating check: they must stay green
before and after (proving the regex genuinely never matched any of these 12 sites, consistent with
the issue's own framing that they are OUTSIDE the detector, not failures of it). Grep-verify after
editing that none of the 4 inlined sites still contains a bare `§12`/`§"…"` citation with no
document name, that all 6 re-labeled-with-`#1123` sites now contain the literal substring `#1123`,
and that the `MarginColumn.import-author.test.ts` site now contains
`2026-05-28-stage-c3-bezier-leaders-anchor-dots.md`.

**Coordination-boundary note (round-1):** this fix touches six `src/` files
(`license-state.ts`, `license.ts`, `kv-store.ts`, `sync.ts`, `local-model/collaborator.ts`,
`local-model/index.ts`, `local-model/ollama-client.ts`) and two `tests/client/` files, all
comment/doc-string only, crossing the group's usual `tests/**`-only ownership deliberately. Verified
safe against the two scanners that would otherwise object: `tests/docs/loopback-gate-claims.test.ts:79`
requires `\s*\(` after a matched token (the proposed wording does not match its pattern) and its
`claimsInert` regex (`:166-176`) does not match the proposed wording either;
`tests/build/invariant-citations.test.ts` self-excludes `dangling-citations.ts` itself (`:53-56`)
so editing that file's own docblock cannot trip its own scan.

## Done when

All 4 "review"/trailing-token/doc-twin sites carry real inline rationale instead of a dangling
`§12`/`§"…"` citation; all 6 local-model "plan §N" sites are prefixed with `#1123`, matching the 2
sites that already were; the `MarginColumn.import-author.test.ts` site cites the tracked archived
plan doc instead of being silently declared acceptable; `dangling-citations.ts`'s docblock reflects
the closed decision for all three families (re-derived file list, NOT-COVERED framing kept)
instead of "tracked in #1584"; `npx vitest run tests/build/invariant-citations.test.ts` green;
`npm run typecheck` AND `npm run typecheck:tests` green (touches only comments/strings, but two of
the six `#1123` sites are in `.ts` files under `src/server/local-model/`, which is behind the dark
`BYO_MODELS_ENABLED` flag, and two more are under `tests/client/`, which only `typecheck:tests`
reaches — comment-only edits, no behavior change, confirmed by re-reading each diff before commit).

## Not in scope

Widening `DANGLING_CITATION_RE` to catch `review §N` or the trailing-token shape going forward —
the issue's own menu is resolve-the-known-sites, not extend-the-scanner, and the detector's
docblock already states why extending is not worth it. The `plan §N` sites that already cite
`#1123` (`first-run-model-picker.test.ts`, `model-edit-modal.test.ts`) — untouched, already
correct. Any change to `src/server/local-model/`, `src/server/license/` or
`src/server/annotations/sync.ts` *behavior* — every touch in this fix is comment/doc-string only,
this group owns no `src/` behaviour, and each edit is re-read against the current diff before
commit to confirm it changed nothing but prose.

## Review corrections (round 1)

**Adopted:**
- `MarginColumn.import-author.test.ts:9`'s "V2 plan §4.1b" was wrongly declared acceptable ("no
  tracked document exists") — `docs/plans/archived/2026-05-28-stage-c3-bezier-leaders-anchor-
  dots.md` is a tracked, committed file literally titled "… (V2)" whose own §4.1b section matches
  the citation exactly. Moved from "declare acceptable" to "re-label with a tracked document."
- Before accepting the remaining "plan C2"/"plan §5 stub click" sites, grepped
  `docs/design-system-impl/` and `docs/plans/archived/` for the cited section — not found; the
  citation resolves to a genuinely gitignored local plan file
  (`~/.claude/plans/the-current-way-we-compiled-thimble.md`, named explicitly in a tracked
  coordination doc). Recorded as "searched X, Y, Z — not found" rather than an unqualified claim.
- Added `src/server/annotations/sync.ts:515` (`plan §"Merge rules"`) to the "review §N" family — a
  repo-wide grep for `plan §` in round-0 missed it; it was outside both the detector and the
  spec's own site list.
- Added `docs/licensing-operations.md:116`, the verbatim documentation twin of `kv-store.ts:76`'s
  `(§12 L1)` citation, to the inline-rationale list.
- Reworded the `dangling-citations.ts` docblock instruction so it keeps the section's NOT-COVERED
  framing rather than reading as "the detector now covers these families" — a new site of this
  shape remains invisible to `DANGLING_CITATION_RE` by design, and the docblock must keep saying so.
- Noted the docblock's existing `plan §N` file-list undercounts (says four `tests/client/*` files;
  a grep finds five, plus `tests/e2e/margin-view.spec.ts` entirely omitted) and instructed
  re-deriving the list by grep rather than editing the existing sentence in place.
- Added an explicit coordination-boundary note acknowledging the `src/` and `tests/client/` touches
  cross the group's usual `tests/**` ownership, with the two scanner clearances that make it safe
  (`loopback-gate-claims.test.ts`, `invariant-citations.test.ts`'s self-exclusion).
- "Done when" named only `npm run typecheck`, which does not reach `tests/client/`. Added
  `npm run typecheck:tests`.

**Not adopted:** none — all findings touching this spec were adopted as described above.
