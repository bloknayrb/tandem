# Spike: `docx` npm package as Tandem's docx write-back engine

**Issue:** #576 (Spike B)
**Branch:** `spike/576-docx-npm`
**Status:** Spike prototype only. NOT wired into MCP tools or the production
save path. Verdict: **GO with caveats.**

**Scope of validation:** this spike evaluates a file-format engine (docx write-back) and is independent of MCP-client integration. Listed alongside the integration spikes for completeness per [ADR-038](../decisions.md#adr-038-mcp-first-integration-policy-claude-as-default-integration), which scopes the **Claude default integration** for the other spike reports.

## Goal

Evaluate whether the [`docx`](https://www.npmjs.com/package/docx) npm package
(v9.6.1) can serve as Tandem's docx write-back engine. Tandem currently uses
`mammoth` for `.docx` -> HTML import; the write-back direction (Tiptap nodes
-> `.docx` bytes) has no implementation. This spike builds a prototype
converter, evaluates fidelity, and reports a GO/NO-GO verdict.

## Prototype

- Converter: `src/server/file-io/spike-docx-export.ts` (~360 lines)
- Runner: `scripts/spikes/run-docx-export.mjs` + `.runner.ts`
- Verifier: `scripts/spikes/verify-output.runner.ts` (mammoth roundtrip)
- Fixtures: `scripts/spikes/fixtures/sample-input.md` and `sample-output.docx`

The converter walks `Y.Doc.getXmlFragment("default")`, mapping Tiptap node
names (`heading`, `paragraph`, `bulletList`, `orderedList`, `listItem`,
`blockquote`, `codeBlock`, `horizontalRule`, `image`, `table`/`tableRow`/
`tableCell`/`tableHeader`) onto the `docx` package's `Paragraph` / `Table`
constructors, and flattens `Y.XmlText` deltas into `TextRun`s with marks
(`bold`, `italic`, `strike`, `code`, `link`).

### How to run

```bash
npm install            # docx is in devDependencies
node scripts/spikes/run-docx-export.mjs                      # default fixture
node scripts/spikes/run-docx-export.mjs path/to/in.md out.docx
```

The verifier opens the output via mammoth (same library Tandem uses for
import) and prints the resulting HTML, confirming that the output is a
well-formed docx that round-trips through Tandem's own importer.

## Trust-boundary checklist

Tandem's threat model treats imported `.docx` files as semi-trusted (see
`docs/decisions.md` ADR-014 plus the "Security" section of CLAUDE.md). On the
export side, the equivalent rule is: a `.docx` Tandem produces must never
carry hostile-looking relationships back out into the user's filesystem or
the network. The spike enforces this via three runtime gates and verifies
them against the sample output.

| # | Rule | Spike enforcement | Verification |
|---|------|-------------------|--------------|
| 1 | No `r:link` external image references in output. | `safeImageEmbed()` only accepts inline `data:image/(png|jpe?g|gif|bmp);base64,...` URIs and passes the decoded bytes via `ImageRun({ data: Buffer })`. Any other src (http(s), file, UNC, relative) is dropped and replaced with `[image: alt]` text. | `grep r:link sample-output.docx` -> 0 hits; no `word/media/*` parts in the output zip. |
| 2 | No `<w:object>` embedded objects. | `docx` v9.6 has no public OLE-object API. The spike never calls any embed-object method. | `grep '<w:object' word/document.xml` -> 0 hits. |
| 3 | No `targetMode="External"` relationships pointing to `file://` or UNC paths. | `safeHyperlinkUrl()` parses every link via `new URL(...)`; only `http:`, `https:`, and `mailto:` survive. Windows drive paths (`C:\\...`) and UNC paths (`\\\\server\\share`) are rejected before reaching `new URL`. | `word/_rels/document.xml.rels` after running the spike contains exactly one external relationship (`https://example.com/`); the `file://...` and `\\\\server\\share\\secret.txt` links in the fixture are scrubbed. |

### Sanitization gates any future production wiring must satisfy

Any future production wiring **must**:

1. Re-use `safeHyperlinkUrl()` (or an equivalent allow-list of `http`,
   `https`, `mailto`) on every hyperlink before it reaches `docx`.
   Tandem's import code already accepts arbitrary `link.href` from
   mammoth-converted HTML; export must not be a re-emission channel for
   those.
2. Re-use `safeImageEmbed()` (or an equivalent inline-only embed). The
   `docx` package will happily accept any `Buffer`, but it will also accept
   an `r:link`-style remote URL through `ImageRun({ link })` overloads --
   the production wiring must NOT use that overload.
3. Reject all `Y.XmlElement` node names not on a known allow-list (the
   spike's `blockToDocx` switch is the starting point). An unknown node
   name should fall through to a text-only paragraph, never to a passthrough
   that could inject markup.
4. Run the existing UNC / drive-path checks (`apiMiddleware`) on the output
   path before writing, identical to `tandem_save`.
5. Strip authorship marks and tracked-change attributes when serializing;
   the spike already does this implicitly (no marks except those in
   `MarkState` survive the flatten).

## Bundle size impact

`docx@9.6.1` adds **3.5 MB** to `node_modules` and a **~800 KB** ESM bundle
(`dist/index.mjs`). Transitive dependencies are small: `jszip` (already a
transitive dep of mammoth and Tiptap-related packages) plus a few formatters.
Net new size to a server bundle is around **800 KB-1 MB** depending on
tree-shaking.

For context: the existing `mammoth` dep is ~1.5 MB on disk. Adding `docx`
roughly doubles the file-IO surface area.

## Feature fidelity

| Capability | Spike status | Production notes |
|------------|--------------|------------------|
| Headings (1-6) | Works | Maps to docx `HeadingLevel.HEADING_N`. |
| Paragraphs | Works | `<br>` from mdast `break` -> `TextRun({ break: 1 })`. |
| Inline marks (bold/italic/strike/code) | Works | `code` is approximated with `font: "Consolas"` + light fill (the `docx` package has no first-class inline-code style). |
| Hyperlinks | Works with sanitization | Only `http`/`https`/`mailto` survive; unsafe links drop the hyperlink but keep the text. |
| Lists (bullet + ordered, nested) | Works | Uses `Paragraph({ numbering: { reference, level } })` with a numbering config defined at the `Document` level. |
| Blockquote | Works (approximated) | Rendered as indented paragraphs (720 twentieths-of-a-point per nesting level). `docx` has no first-class blockquote style; Tandem could ship a custom style if visual parity matters. |
| Code blocks | Works (approximated) | Each line becomes its own `Paragraph` with `Consolas` + fill. Production should ship a `Code` paragraph style and reference it instead of inlining shading on every run. |
| Horizontal rule | Works | Paragraph with bottom border. |
| Tables (header + body) | Works | First row -> header cells, subsequent rows -> body. Column alignment is not yet plumbed through. |
| Images | Conditional | `docx` supports `ImageRun({ data: Buffer })` cleanly. **However**, Tandem's current `mdast-ydoc` import path turns image syntax into *inline phrasing content* inside a `paragraph`, not into a top-level `<image>` Tiptap node. As a result, even safe `data:` images currently degrade to alt text on round-trip. Fixing this requires changes to `mdast-ydoc.ts` AND a paired inline-image walker in the exporter. Tracked as v0.12.0 follow-up. |

### Tracked changes (`<w:ins>` / `<w:del>`)

`docx@9.6` **supports** insertions and deletions via the `InsertedTextRun`
/ `DeletedTextRun` constructors and the `TrackChanges` setting on
`Document`. The spike does not exercise this path because Tandem has no
tracked-changes data model on the editor side yet; the existing annotation
model (highlight / comment / note) is the closest analog.

If Tandem wants to surface "Claude's edit since last save" as Word tracked
changes, the production wiring would need:

1. An authorship-aware diff between the last-saved Y.Doc snapshot and the
   current Y.Doc (Tandem already has `Y_MAP_AUTHORSHIP` per the ADR-026
   decoration model; this could be re-used).
2. Mapping each diff span to `InsertedTextRun({ author, date, ... })` or
   `DeletedTextRun({ ... })`.

Effort: estimated 3-5 days for the diff infrastructure, plus 1-2 days for
the export plumbing. Out of scope for the spike.

### Comment fidelity

`docx@9.6` ships a public comment API:

- `CommentRangeStart` / `CommentRangeEnd` are inserted as inline children.
- `CommentReference` marks where the comment balloon attaches.
- `Document({ comments: { children: [Comment({ id, author, date, children })] } })`
  defines the comments themselves.

The spike does NOT exercise comments — see Tandem's privacy rule (ADR-027):
notes are user-private and must not be surfaced to Claude or to exported
files; only `comment` annotations would qualify, and even those may carry
user-private text. A production wiring must filter aggressively before
emitting any `<w:commentRangeStart>`.

A future spike (or v0.12.0 follow-up) should round-trip Word comments
imported via `docx-comments.ts` (mammoth + custom parser) through the
`docx` export. Open questions:

- Does `docx@9.6` preserve the exact `<w:id>` mapping needed for
  comment-to-range anchoring after re-export?
- Are comment-range anchors preserved when text inside the range is
  reformatted?

Until verified, **comment round-trip is unproven for this spike**.

## Output validation

The spike produces `scripts/spikes/fixtures/sample-output.docx` (9.5 KB).

Verification performed:

1. `python -m zipfile -l sample-output.docx` -- valid OOXML zip structure
   (`word/document.xml`, `word/_rels/document.xml.rels`, `[Content_Types].xml`
   present).
2. **mammoth round-trip** (`scripts/spikes/verify-output.runner.ts`):
   the file opens cleanly via the same library Tandem uses for import. Zero
   error messages. HTML round-trip preserves headings, marks, lists, blocks,
   table, and the safe `https://example.com/` hyperlink. The two unsafe
   hyperlinks (`file://etc/passwd`, `\\\\server\\share\\secret.txt`) are
   correctly stripped to plain text.
3. Trust-boundary grep: `r:link=0`, `<w:object=0`, `TargetMode="External"=1`
   (the safe https link).

LibreOffice / Word visual verification: not performed in CI (manual gate
for the production wiring PR).

## Bundle / dependency posture

- Added to `devDependencies` only (per spike charter).
- `docx` is **not** added to production `dependencies`. If production
  wiring proceeds, it should be promoted at that time and re-bundled
  through `tsup`'s `selfContained` config.

## GO / NO-GO verdict

**GO with caveats.**

Rationale:

- Core fidelity (headings, paragraphs, marks, lists, tables, hyperlinks) is
  good and round-trips cleanly through mammoth.
- The package is actively maintained, ESM-first, and has a typed API.
- Bundle impact (~800 KB ESM) is acceptable for a server-only feature.
- Trust-boundary gates are easy to implement and verifiable by static
  grep over the output zip.

Caveats / required follow-up before production wiring:

1. **Image round-trip is broken upstream of the spike.** `mdast-ydoc.ts`
   degrades image syntax to inline alt text. Fix that first, OR scope the
   v1 docx export to "no image support."
2. **Code-block + blockquote styling is approximated.** Ship `Code` and
   `Quote` paragraph styles in a Tandem-side `styles.xml` template instead
   of inlining shading on every run.
3. **Comment round-trip is unverified.** Build a second spike covering
   `docx-comments.ts` -> `docx@9.6` comment API before claiming feature
   parity with Word's review workflow.
4. **Tracked changes require a Y.Doc diff layer.** Out of scope for
   v0.12.0 unless authorship-diff infrastructure lands first.

### Estimated effort (GO path)

| Phase | Effort |
|-------|--------|
| Port spike to `src/server/file-io/docx-export.ts`; promote `docx` to prod deps; add trust-boundary unit tests; add `tandem_save` wiring for `.docx` outputs. | 3-4 days |
| Image inline support (fix `mdast-ydoc` + paired exporter walker; cover with vitest + Playwright). | 2-3 days |
| Comment round-trip spike + production wiring. | 4-6 days |
| Tracked-changes diff layer (deferred). | 5-7 days |

Total to "feature-parity write-back, no tracked changes": **~10-13 days**.

## Refs

- Issue: #576
- Related lessons: feedback_yjs_populate_needs_transact, feedback_yjs_numeric_attrs.
- Trust-boundary precedent: ADR-014 (`.docx` import), ADR-027 (annotation privacy).
