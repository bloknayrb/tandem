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
- **A different, unrelated plan (card-density / margin-view "plan C2" / "V2 plan") — declare
  acceptable, no tracked issue substitute exists for this UI-geometry design note (3 sites):**
  - `src/client/panels/cardDensity.ts:31` — `divergence from plan §5 "stub click → full in
    place"` (and `:7`, `plan C2`, same document).
  - `tests/e2e/margin-view.spec.ts:1097` — `the resolved divergence from plan §5 "stub click →`.
  - `tests/client/MarginColumn.import-author.test.ts:9` — `Closes the gap from the V2 plan
    §4.1b —`.

  These are genuinely a different, untracked internal plan from the local-model M2b one — no
  GitHub issue names "plan C2" or "V2 plan" anywhere in this repo's history that a `gh issue
  list`/grep could find, and inlining the rationale each stands in for is exactly the
  disproportionate transcription-of-an-absent-document work the issue's own body and the
  detector's docblock both warn against. Declared acceptable per the issue's third option.

## Fix

**Inline (3 sites, small, well-understood from surrounding code):**

- `license-state.ts:13` → `// an unknown major is rejected rather than silently honored — a
  future schema bump must be handled explicitly here, never fall through as if it were v1.`
- `license.ts:137` → `* not \`assertLoopbackForMutation\` — this GET degrades to a scrubbed
  response for a non-loopback caller rather than refusing one, and that helper 403s instead of
  scrubbing).` (verified: `assertLoopbackForMutation`, `src/server/integrations/api-routes.ts:321`,
  responds 403 to a non-loopback caller outright — wrong behavior for a route whose own next line
  is `if (isLoopback(...)) full else scrubbed`.)
- `kv-store.ts:76` → `// Log the id only, never the email — the id is opaque and safe to log; the
  email is PII and must never land in a server log.`

**Re-label with `#1123` (6 sites, mechanical, matches the 2 already-correct sibling sites
exactly):** prefix `plan` with `#1123 plan` (or `#1123's plan` for `index.ts:14`'s possessive
phrasing) at each of the six local-model sites above. No other wording change.

**Declare acceptable (3 sites, no code change):** update `tests/build/dangling-citations.ts`'s
"WHAT THIS DETECTOR DOES NOT COVER" section — the `plan §N` bullet currently reads "Tracked in
#1584 rather than half-done here." Replace with the decision outcome now that #1584 is closed:
state plainly that the local-model M2b sites were re-labeled with `#1123` and the remaining
card-density/margin "plan C2"/"V2 plan" sites are accepted as-is (untracked internal design note,
no GitHub issue exists to point at, inlining costs more than the citation is worth), so a future
reader does not re-open a closed decision. Same edit updates the `review §N` and trailing-token
bullets to say "fixed by #1584" rather than leaving them as open scope statements.

## Tests

No new detector tests — `DANGLING_CITATION_RE` is unchanged, so `invariant-citations.test.ts`'s
existing positive control and repo-wide sweep are the discriminating check: they must stay green
before and after (proving the regex genuinely never matched any of these 11 sites, consistent with
the issue's own framing that they are OUTSIDE the detector, not failures of it). Grep-verify after
editing that none of the 3 inlined sites still contains a bare `§12` with no document name, and
that all 6 re-labeled sites now contain the literal substring `#1123`.

## Done when

All 3 "review"/trailing-token sites carry real inline rationale instead of a dangling `§12`
citation; all 6 local-model "plan §N" sites are prefixed with `#1123`, matching the 2 sites that
already were; `dangling-citations.ts`'s docblock reflects the closed decision for all three
families instead of "tracked in #1584"; `npx vitest run tests/build/invariant-citations.test.ts`
green; `npm run typecheck` green (touches only comments/strings, but two of the six sites are in
`.ts` files under `src/server/local-model/`, which is behind the dark `BYO_MODELS_ENABLED` flag —
comment-only edits, no behavior change, confirmed by re-reading each diff before commit).

## Not in scope

Widening `DANGLING_CITATION_RE` to catch `review §N` or the trailing-token shape going forward —
the issue's own menu is resolve-the-known-sites, not extend-the-scanner, and the detector's
docblock already states why extending is not worth it. The `plan §N` sites that already cite
`#1123` (`first-run-model-picker.test.ts`, `model-edit-modal.test.ts`) — untouched, already
correct. Any change to `src/server/local-model/` behavior — comment/doc-string edits only, this
group owns no `src/` behaviour.
