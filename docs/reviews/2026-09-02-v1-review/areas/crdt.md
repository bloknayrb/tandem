# Area: CRDT anchors and coordinate systems

**Raw:** [`../raw/findings-crdt.txt`](../raw/findings-crdt.txt) (Fable, resumed, 6 calls) and
[`../raw/gapfill-E.txt`](../raw/gapfill-E.txt) (Opus experiments).
**Manifest:** [`../raw/manifests/crdt.md`](../raw/manifests/crdt.md).
**Track:** [B anchors](../tracks/B-anchors.md); the schema and asymmetry Lows are in [K](../tracks/K-tests-and-lows.md).
**Spot-check:** the orchestrator re-ran `experiments/crdt-verify.ts` (every section reproduces),
`e5-merge.ts` and `e6-snapshot.ts`. The `f-undo` harness results are the agent's.

Spawn `crdt-reviewer` on every change in this area; the invariants are in
`docs/architecture.md` under the three coordinate systems.

## Findings

| Sev | Where | Finding | Evidence | Status | Issue |
|---|---|---|---|---|---|
| H | `src/server/positions.ts:276-289`; `mcp/document-store.ts:228` | Enter before or inside an annotation in the same paragraph (y-prosemirror split = delete tail + insert element) collapses both RelativePositions; `refreshRange` returns `kind: updated {4,4}` and **persists** it through `map.set`, destroying the flat fallback, with no warning. The persisting caller is `listAnnotationsRefreshed`, a *read* path. Toolbar heading toggle (XmlElement rebuild) and paragraph join are the second and third doors. Only Enter after the annotation is safe. `textSnapshot` relocation runs only on the watcher reload path. | [ran] | Reproduced (`crdt-verify.ts`: `{4,4}`, `{4,5}`, `{1,1}`) | [#1764](https://github.com/bloknayrb/tandem/issues/1764) |
| M | `positions.ts:254-275`; `documents/watcher.ts:210-270` | The `repaired` arm re-anchors from stale flat offsets with no `textSnapshot` check; after delete-paragraph plus insert-above the range covers `"\non"` across a separator and mints a fresh `relRange` silently. Possibly extends #1632. | [ran] | Reproduced | [#1764](https://github.com/bloknayrb/tandem/issues/1764) |
| M | harness `f2-undo`, `f3-undo` | Plain undo recovers the block-split collapse (`relRange` kept), but after a re-anchor (reload or restart) undo trips the inverted-range guard at `positions.ts:276-282`: `failed`, frozen collapsed. | [ran] | Agent-ran | [#1764](https://github.com/bloknayrb/tandem/issues/1764) |
| H | `src/server/mcp/document.ts:702-740`; `document-model.ts:803-819` (`mergeInlineTail`); `positions.ts:254-269` | A cross-block `tandem_edit` clones the tail block then deletes the emptied element, so every RelativePosition in it dies; the read path re-anchors from stale pre-edit offsets and reports `repaired`, no clamp. An annotation on the last word of the merged paragraph ends up empty or on unrelated text, status pending. Upstream of #1632. | [ran] | Reproduced (`e5-merge.ts`, `e5b.ts`; controls stay right) | [#1765](https://github.com/bloknayrb/tandem/issues/1765) |
| M | `positions.ts:154-169`; `document-model.ts:147-156` | The heading check is endpoint-only: `validateRange(4,9)` with `rejectHeadingOverlap` passes on `"para\n## Head\nnext"`, so `tandem_edit` can delete a heading and merge its tail. Critical Rule 6 as written omits spanning ranges. | [ran] | Reproduced (`crdt-verify.ts`; deletion path read, not run) | [#1766](https://github.com/bloknayrb/tandem/issues/1766) |
| M | `src/server/mcp/annotations.ts:186-187` (`SNAPSHOT_CAP` 200) | The snapshot slice has no surrogate guard; a lone high surrogate at the cap becomes U+FFFD through any Yjs update (session persist, doc swap, client sync), so watcher relocation is RANGE_GONE forever and `snapshotContradicts` flips true, refusing accept. The JSON disk path is lossless; only the CRDT path corrupts. | [ran] | Reproduced (`e6-snapshot.ts`, `e6b.ts`) | [#1767](https://github.com/bloknayrb/tandem/issues/1767) |
| L | `positions.ts:121,276-282`; `shared/positions/ydoc.ts`; tool schemas; `OutlinePanel.svelte:148`; `document-store.ts` | Zero-length ranges accepted by MCP (first insert inverts → permanent `failed`); `flatOffsetToRelPos` ±1 retry drifts `from` on a hardBreak offset; `from`/`to` bare `z.number()`; OutlinePanel attributes by stale flat `from`; refresh `kind` discarded by every MCP consumer except docx export; `to` equal to the first char of a heading prefix rejected (undocumented asymmetry). | [ran]/[read] | Reproduced where marked in `crdt-verify.ts` | [#1823](https://github.com/bloknayrb/tandem/issues/1823) |

## Design notes for the fix

- The collapse is *persisted by a read*. Any fix that keeps `refreshRange`'s write must first decide
  that a collapsed or inverted result is not an update.
- Surfacing `kind` on `tandem_getAnnotations` (a #1823 item) is what gives #1764 and #1765 a
  visible symptom; do it in the same track.
- `refreshRange`'s `map.set` is wrapped by `refreshAllRanges`' `withMcp` (`positions.ts:315`), so
  there is no untagged write; the origin is right, the decision to write is wrong.
- Related open issues to read before planning: #1632, #1693, #1737 (bodies were checked for overlap
  only, not read in full).

## Doc drift (in [#1821](https://github.com/bloknayrb/tandem/issues/1821))

ADR-032 says MCP errors switch on `kind` (only docx export does); `architecture.md:310-389` and
Critical Rule 6 omit spanning ranges; CLAUDE.md's "lazy re-attachment recovery" re-attaches from
unverified stale flat offsets; the "survive concurrent edits" claim needs the paragraph-split
caveat.

## Verified fine

`assoc` pair consistent; separator accounting agrees across ten sites; heading prefix top-level
only; XmlText identity; attach-before-populate; all creation paths go through `anchoredRange`
under the right origin helper; no raw `transact` in the files read; `extractText` for
`getTextContent`; PM↔flat mapping byte-identical to the server on 24 corpus shapes
(`experiments/harness/d-flat.test.ts`).
