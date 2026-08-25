# Audit: what Tandem should take from the AI-debugging blind-spots study

**Date:** 2026-08-25
**Source:** Nhu Hoang, *Bug Detection Blind Spots in AI Coding Harnesses (GStack and Beyond)*, Towards Data Science, 2026-08-23 — 28 blind-scored debugging runs against three real, post-cutoff upstream fixes (`ky` [#867](https://github.com/sindresorhus/ky/pull/867), `immer` [#1255](https://github.com/immerjs/immer/pull/1255), `decimal.js` [#260](https://github.com/MikeMcl/decimal.js/pull/260)).
**Kind:** external-evidence audit — no experiment was run here. Every in-repo claim below is a file reference you can check.
**Produced:** [#1602](https://github.com/bloknayrb/tandem/issues/1602), [#1603](https://github.com/bloknayrb/tandem/issues/1603), [#1604](https://github.com/bloknayrb/tandem/issues/1604), [#1605](https://github.com/bloknayrb/tandem/issues/1605), [#1606](https://github.com/bloknayrb/tandem/issues/1606).

## The result

The study's finding is not "AI is bad at hard bugs." It is the opposite, and the inversion is the whole point.

| Bug | Expected | Result |
|---|---|---|
| `immer` — base state mutated after `reverse()`/`sort()` under the array-methods plugin; a structural-sharing invariant across two files of proxy internals | hard | **8/8 correct** |
| `decimal.js` — `asin()` loses digits near ±1 to catastrophic cancellation; the fix is an algebraic reformulation, not the precision bump the reporter suggested | hard | **8/8 correct** |
| `ky` — a numeric `retry` shorthand silently dropped by `.extend()`; the fix is one merge rule | easy | **0/12 correct** |

Both "hard" bugs had an in-repo signpost: `decimal.js`'s sibling `acos()` already used the cancellation-free form, and `immer`'s plugin sets a flag marking the array reordered. Every run found and used it. Six of eight `decimal.js` runs independently rediscovered the maintainer's reformulation; none took the precision bump that passes all 22,624 visible assertions.

The `ky` fix depended on a fact that appears in no artifact: **users can put arbitrary keys in their JSON payloads**, and the same generic deep-merge that handles options also walks request bodies. Normalizing `retry: 3` to `{limit: 3}` at every nesting depth repairs the reported bug, passes the whole 84-test retry suite, and silently injects a `limit` field into a user's request body whose JSON happened to contain `retry`. A human contributor made exactly this mistake in the real PR; a human reviewer caught it, and the narrowed fix plus its regression test became the study's hidden grader.

All 12 runs reproduced the human's mistake. None reached the reviewed fix. Model tier did not matter (Haiku 4.5, Sonnet 5, Opus 4.8 failed identically). Workflow did not matter (naive single agent, a structured investigate-and-enumerate-impact process, and a four-agent diagnose→implement→review pipeline all failed).

**Difficulty did not predict failure. Missing information did.**

## Why this lands hard on Tandem specifically

The `ky` shape is: *a generic, name-keyed transform collides with arbitrary caller data, because "callers can put anything there" is a fact about the world rather than about the code.*

In Tandem the arbitrary caller data is **the user's document**. Which makes this class not an exotic import but the repo's dominant historical bug class. The roll call is already in `CLAUDE.md`:

- **#1534** — an all-decimal hex in prose (`label: "Toggle authorship colors (#1364)"`) reported as a raw color by the token scanner. Fixed *position*-gated, not value-gated. `scripts/check-semantic-tokens.ts` carries the reasoning in full, including that adding `border`/`background`/`color` to `CSS_VALUE_WORDS` would re-open it, and that `CSS_KEYWORDS` and `CSS_VALUE_WORDS` "must not be merged."
- **Critical Rule 1** — Y.Map keys from constants only. A raw string literal is this collision pre-empted.
- **`tandem_edit` rejects heading markup ranges** — user text vs. structural markup, the same boundary.
- **`CTRL_ROOM` is reserved as a document ID.**
- **The file-watcher self-write fingerprint must be a content hash, not size+mtime** (`src/server/file-watcher.ts`) — a false match silently drops a real external edit.
- **`tandem_applyChanges` is deliberately *not* fingerprinted**, because its reload is semantic rather than an identical-bytes echo. A blanket rule would have been wrong.

Every one of those is Tandem discovering, the hard way, a fact about user data that no type signature encodes. The study says this is the one class current models cannot infer — which reframes `CLAUDE.md` from "helpful context" to "the reason agents succeed in this repo at all."

## Finding 1 — the class is live in `src/`, and one instance is undocumented

Two recursive name-keyed transforms exist today. They differ only in whether the safety argument is written down.

**`src/server/mcp/schema-dialect.ts` — `stripSchemaDialect()`.** Strips `$schema` at every depth, and says why that is safe:

> "Recursive rather than root-only: `zod-to-json-schema` emits it at the root today, but its `definitions` bucket is a plausible second home… **Nothing in a `tools/list` result is user data** — it is schemas and strings — so there is no value-shaped `$schema` to preserve."

That sentence is the study's entire prescription, already discharged. It is the reference form.

**`src/server/integrations/storage.ts` — `normalizeLocalhostUrls()`.** Rewrites any key named `url` at any depth. Not a bug today: `IntegrationsFileSchema` is closed — `schemaVersion`, `integrations[]`, `defaultIntegrationId`, and integration records with no free-form nested object. But the function runs **before** Zod validation, on raw parsed JSON from disk, so the closed schema is not what protects it *at the moment it runs*; and the rewrite is semantically live rather than cosmetic, since `localhost` and `127.0.0.1` differ under IPv6. Nothing in the file records any of this, so the next free-form field added to that schema arrives with no warning attached.

Tracked as **#1603**, which also asks for a sweep of the shape across `src/` and a triage note for the docx walkers (structurally similar, but keyed on OOXML element names inside a closed vocabulary).

## Finding 2 — the reviewers have no verdict

This is the one worth acting on first.

The study's sharpest result is not 0/12. It is the single pipeline run where the reviewer agent **found** the corruption and wrote it out verbatim:

> "the fix keys on the string 'retry' at every nesting depth… `deepMerge({json:{retry:3}}, {json:{retry:{foo:1}}})` → `{json:{retry:{limit:3,foo:1}}}` (user request-body corruption)."

and then approved the merge — reasoning that the collision was unlikely in practice, that the coupling was a pre-existing class of problem, and that a clean fix needed a broader refactor. Ship it, note a follow-up. Every clause is defensible. The verdict was still wrong.

**Detection worked. Judgment shipped it.** In 12 runs the failure surfaced exactly once, and the process converted that one catch into a merge.

Tandem is exposed at the same joint. All four reviewer agents — `.claude/agents/security-reviewer.md`, `crdt-reviewer.md`, `annotation-model-reviewer.md`, `svelte-migration-reviewer.md` — end with an identical block:

```
For each finding:
- **Severity**: Critical / High / Medium / Low / Info
- Location / Description / Proof / Recommendation
```

Severity, no disposition. `CLAUDE.md`'s workflow says to "spawn adversarial agents to review the plan from multiple angles before writing any code" and then proceeds to "implement"; what a Critical finding *obliges* is written nowhere. The ship decision falls back to the orchestrating session's judgment, unconstrained — which is precisely the layer the study watched fail.

The fix is a rule, not a better model: a finding in the blocking set stops the change, with no weighing of likelihood and no "pre-existing class." `CLAUDE.md` already holds the general form for dated gates — *"a gate that can be deferred indefinitely is not a gate."* Tracked as **#1602**.

## Finding 3 — the corollary to a good rulebook

The near-miss run is the instructive one. It wondered whether a nested user key named `retry` could gain a `limit`, checked ky's option types, found no such field, and dismissed the risk. It did the right investigation, consulted the authoritative in-repo artifact, got a clean answer, and drew the wrong conclusion. It searched the library's vocabulary; the answer lived in users' data.

The Tandem analogue writes itself: an agent greps `CLAUDE.md` and `docs/gotchas.md`, finds no rule covering its change, and treats silence as clearance. This repo's docs are good enough to feel exhaustive, which makes the misreading *more* available here, not less. And the un-ruled areas are by construction the ones where nothing else will object either — every rule in `CLAUDE.md` exists because the failure was silent.

Hence: **the absence of a rule is not evidence of safety.** These files record failures already survived; they do not enumerate how the system can break. Tracked as **#1604**.

## Finding 4 — route by information, not difficulty

The study's practical output is a routing question:

> Is everything needed to produce the correct fix visible in the code and the ticket, or does correctness depend on how the system is actually used?

Tandem already owns this test, for a different purpose. From the dated-gates rule in `CLAUDE.md`:

> **The criterion must be answerable from tracked files** — one whose evidence lives where the judge cannot look fails silently, and **it fails toward deletion**.

Same criterion, applied at gate-review time only. Applied at routing time it sorts the work:

- **Derivable from tracked files** — CRDT coordinate math, `src/server/positions.ts` range invariants, the docx walkers, schema and migration work. The 16/16 result is evidence to trust agents here *more* than the current workflow's caution implies.
- **Depends on the world** — and the current v1.0 blockers all live here, unmarked as a class: **#1596** (verify #1118's post-update banner against a real upgrade; §1 Windows unrun for two releases), **#316** (Cowork macOS/Linux), the cross-platform install matrix. None is *hard*; each is unknowable from inside the repo.

The corollary matters more than the sort: when work lands in the second bucket, the first move is to make the missing fact tracked, not to attempt the change with better prompting. That is what converts a 12/12-failure shape into a 16/16 one. Tracked as **#1606**.

The ticket-side half of the same lever — nothing in `.github/` currently asks the question at filing or review time — is **#1605**.

## What Tandem already does right, and should not do more of

The study's thesis is this repo's existing religion, occasionally word for word.

- *"A gate that reports success when it could not evaluate is worse than no gate"* — `CLAUDE.md`, on why the acceptance-harness CI step carries no `if:`, no `continue-on-error` and no `|| true`. That is the study's conclusion, reached independently.
- **#1529** — a Windows-gated spec that no Windows job runs is green forever and reads exactly like a pass. Same failure as green CI on a corrupting fix; already fixed with the `windows-acl-proof` job, which refuses on a non-Windows platform and requires each named describe to report ≥1 passed / 0 skipped.
- `tests/docs/loopback-gate-claims.test.ts` and the `testid-set.snap.txt` snapshot are Tandem's version of the study's held-out grader: tests that fail when a *claim* drifts, not merely when behavior breaks.
- **#1547** is the honest asterisk — `check` is not yet a required status check, so every CI gate is currently advisory.

The study is evidence that this investment pays. It is not an argument for more of it. The five issues above are all cheap, and none of them adds a test.

## How much weight this deserves

Less than the numbers suggest, and the author says so plainly:

- The headline 12/12 rests on **one bug**. Three model tiers and three workflows make it notable, not general.
- Hard/easy labels were assigned by the author's intuition before the runs, not by an independent measure. "Discoverable from the code" may partly reflect patterns the models had already seen.
- Sample sizes are 1–3 seeds per configuration; Haiku was never run against the two hard bugs.
- The scoring is asymmetric: for `immer` and `decimal.js` the hidden test fails before the fix, while for `ky` the decisive hidden test detects damage the agent's own fix introduced.
- All three libraries are well-tested JS/TS projects; nothing here transfers automatically to weaker test ecosystems.

The mechanism it describes, though, matches this repo's own bug history closely enough that #1602 and #1605 are worth doing on that basis alone.
