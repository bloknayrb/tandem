# Track D — Word and markdown fidelity

**Tier:** Opus builds; Fable reviews the docx walker plan. **Decisions needed:** [A](../decisions.md)
(Obsidian vaults in scope?) gates #1753; [B](../decisions.md) (`tandem_applyChanges` a v1 surface?)
gates the size of #1754; [C](../decisions.md) (keep the envelope on force-open?) gates #1813.
**Do not hold the next minor for it.** Starts after tracks A and B are planned, because the
markdown items touch the same `mdast-ydoc.ts` paths as #1751 and the docx items depend on how
[B](B-anchors.md) treats re-anchoring after import.

## Issues

| Issue | What | Decision | Experiment (before / after) |
|---|---|---|---|
| [#1751](https://github.com/bloknayrb/tandem/issues/1751) | Marks inside frontmatter, footnote definitions, HTML and code blocks serialize as literal `<bold>` XML. Either refuse marks in raw-carrier blocks at edit time or serialize them as text. | none | `exp2.ts`, `exp8.ts` |
| [#1753](https://github.com/bloknayrb/tandem/issues/1753) | `[[wikilinks]]` escaped and user escapes stripped on save. In scope: a wikilink node and a round-trip test; out of scope: say so in the README and warn once on open. | A | `exp5.ts` |
| [#1754](https://github.com/bloknayrb/tandem/issues/1754) | The docx walker's flat text must match mammoth's: drop empty paragraphs the way mammoth does (or set `ignoreEmptyParagraphs: false` and count them), emit nothing for `w:br type="page"`, handle `w:tab`, `w:br`, `w:sym`, footnote refs and headings in cells. The largest single item in the review. | B | `e1-docx.ts`, `exp6.ts`, `exp7.ts` |
| [#1755](https://github.com/bloknayrb/tandem/issues/1755) | Body images dropped on import with no banner and export overwrites image-less; `file:` and `data:image/svg+xml` sources replaced by alt text on save. Minimum: refuse to export a document whose import lost images, and say so. | none | `exp4.ts` |
| [#1799](https://github.com/bloknayrb/tandem/issues/1799) | Inline image splits its paragraph; fence meta dropped. | none | add to `rt.ts` |
| [#1813](https://github.com/bloknayrb/tandem/issues/1813) | Force-open and source-view commit unlink the envelope. Option 2 (clear the in-memory map only, re-anchor from `textSnapshot` on next open) is the safer of the two. | C | none; write one |

Area ledger: [server-data](../areas/server-data.md). Lows to fold in from
[#1823](https://github.com/bloknayrb/tandem/issues/1823): `atomicWrite` temp leak and mode loss,
BOM, the code-span pipe, the setext hard break, inherited marks on `tandem_edit`.

## Order

1. #1813 and #1751 need no decision and are independent of the walker: do them first.
2. #1755's banner-and-refuse half needs no decision either.
3. #1754 waits on decision B. If the answer is "ship it experimental", the tool description, the
   skill and `docs/mcp-tools.md` change and the walker fix moves to post-v1.0. If "fix it", plan
   it with Fable and run `e1-docx.ts` on real documents from Bryan, not only the synthetic ones.
4. #1753 waits on decision A.

## Regression corpus

`experiments/rt.ts` is the 107-construct markdown round-trip corpus; every markdown change in
this track runs it before and after, and any new construct joins it. The docx fidelity suite is
`tests/server/docx-roundtrip-fidelity.test.ts`, which already marks the image case as "breaks":
flip that assertion when #1755 lands.

## Reviewer agents

`crdt-reviewer` on #1754 (it changes what offsets mean for imported comments) and #1751 (cross-block
edits); `security-reviewer` on #1755's export refusal (it is a write-path change) and #1813.

## Done when

- Each experiment shows the round-trip identical, and `rt.ts` stays idempotent.
- `e1-docx.ts` cases 1 and 2b match; `exp6.ts` and `exp7.ts` print no "Flat text mismatch".
- Decisions A, B and C are recorded in #1827 and in the three issues.
- `docx-walker.ts:4`'s contract comment is true.

## Status

_(empty)_
