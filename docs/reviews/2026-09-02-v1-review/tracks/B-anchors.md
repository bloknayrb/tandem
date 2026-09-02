# Track B — Anchors

**Tier:** Fable plans, Opus builds, `crdt-reviewer` on every PR. **Decisions needed:** none, but
the fix is a coordinate-system change and needs a plan reviewed adversarially before code
(the repo's own workflow rule). **Do not hold the next minor for it.**

Four issues, one root: the server persists whatever `refreshRange` returns, and it returns
collapsed, inverted or stale-re-anchored ranges as if they were updates.

## Issues

| Issue | What | Experiment (before / after) |
|---|---|---|
| [#1764](https://github.com/bloknayrb/tandem/issues/1764) | Block split, heading toggle and paragraph join collapse both RelativePositions; `listAnnotationsRefreshed` (a read) persists the collapse; the `repaired` arm re-anchors from stale flat offsets with no `textSnapshot` check; undo after a re-anchor trips the inverted-range guard and freezes `failed`. | `crdt-verify.ts`; harness `f-undo`, `f2-undo`, `f3-undo` |
| [#1765](https://github.com/bloknayrb/tandem/issues/1765) | Cross-block `tandem_edit` merge (`mergeInlineTail`) deletes the tail element and every anchor in it; the read path reports `repaired` on unrelated text. Upstream of #1632. | `e5-merge.ts`, `e5b.ts` |
| [#1766](https://github.com/bloknayrb/tandem/issues/1766) | Critical Rule 6 is endpoint-only; a spanning range deletes a heading. | `crdt-verify.ts` (the `validateRange(4,9)` section) |
| [#1767](https://github.com/bloknayrb/tandem/issues/1767) | `textSnapshot` slice at the 200-char cap has no surrogate guard; U+FFFD after any Yjs round-trip makes relocation RANGE_GONE and `snapshotContradicts` true. | `e6-snapshot.ts`, `e6b.ts` |

Area ledger: [crdt](../areas/crdt.md), including the design notes. Related Lows to fold in from
[#1823](https://github.com/bloknayrb/tandem/issues/1823): zero-length ranges, the hardBreak `from`
drift on the ±1 retry, surfacing the refresh `kind` on `tandem_getAnnotations`, the heading-prefix
exclusive-`to` asymmetry, `OutlinePanel` attributing by stale flat `from`.

## Plan shape (for the planning session, not a decision)

- Decide what a collapsed or inverted `refreshRange` result *is*. Today it is `updated`. It should
  probably be `degraded` with the previous range kept, and only the watcher-reload relocation
  (which has the `textSnapshot`) may mint a new `relRange`.
- The `repaired` arm must verify against `textSnapshot` before writing, or return `failed`.
- `mergeInlineTail` should move the tail's anchors before deleting the element (Yjs cannot do it
  after), or the edit should refuse when a live annotation sits in the deleted block.
- Surface `kind` on `tandem_getAnnotations` first; it is what makes every other change here
  observable, and it is what the Playwright and harness specs will assert on.
- Read #1632, #1693 and #1737 in full before planning; the review only checked them for overlap.

## Reviewer agents

`crdt-reviewer` (mandatory), `annotation-model-reviewer` (the record's `status` and `range`
fields change meaning), `security-reviewer` only if a new MCP error code or route appears.

## Done when

- `crdt-verify.ts` prints the original ranges in every section, or the documented `degraded`
  state, never `{4,4}`.
- The three `f-undo` harness files are rewritten as real specs under `tests/client/` with the
  assertions inverted, and pass.
- `e5-merge.ts` and `e6-snapshot.ts` show the annotation intact after the edit.
- `validateRange` with `rejectHeadingOverlap` refuses a range whose interior contains a heading
  prefix, and Critical Rule 6 in CLAUDE.md says "start, end or interior".
- `docs/architecture.md`'s coordinate-system section carries the paragraph-split caveat and
  ADR-032's "MCP errors switch on kind" is true or rewritten.

## Status

_(empty)_
