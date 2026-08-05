# Spike: GenOffice `docx-engine` as a byte-preserving `.docx` save path

**Run:** 2026-08-05, Windows 11, Node v24.2.0, `master` @ `b6360faf`.
**Upstream:** [`genspark-ai/genoffice`](https://github.com/genspark-ai/genoffice) @ `d1de6ac`, Apache-2.0.
**Status:** Investigation only. Nothing wired, nothing vendored, no code changed in `src/`.

**Question asked:** could the GenOffice engine be adapted to help Tandem with `.doc`/`.docx`?

**Answer: yes for `.docx`, no for `.doc` — but the durable finding is architectural, not a
dependency decision.** *Splice, don't rebuild* is the right shape for Tandem's `.docx` save
path, it fixes a fidelity problem Tandem measurably has today, and it can be done without
touching import, the Y.Doc shape, or any existing annotation offset. Whether the regeneration
logic comes from GenOffice (Option B) or from extending Tandem's own `docx-apply.ts`
(Option C) is **left open** — see §6. Adversarial review favoured C; the evidence supports the
architecture more strongly than it supports either supplier.

Four findings decide it, all measured rather than read:

1. Tandem's current `.docx` round-trip **silently discards indentation, shading and font
   specifications** (`w:ind` 2→0, `w:shd` 4→0, `w:rFonts` 4→0 on a real fixture). GenOffice
   preserves all three **even through an edit to the paragraph** (§3f) — the win is not
   confined to untouched content.
2. A flat-text coordinate bridge over GenOffice's block model lands **character-identical to
   Tandem's existing `extractText()`** on 3 of 4 fixtures. But Y.Doc elements do **not**
   correspond 1:1 to blocks (mammoth collapses 6 list paragraphs into 2 list elements), so
   mapping must go by **offset, gated on an exact flat-text match** — which is exact when the
   texts agree and garbage when they do not. That gate already exists in Tandem
   (`docx-apply.ts:507-512`) and turns the risk into a checkable precondition.
3. The engine is **not safe on untrusted input as configured**: a 400 KB file, inside its own
   sanctioned limits, OOM-kills an 8 GB heap.
4. Tandem **already owns** an offset-exact splice path (`docx-apply.ts` — `walkDocumentBody`,
   `buildOffsetMap`, and a `buildRun` that already clones `<w:rPr>` onto edited text). Extending
   it is a credible alternative to importing anything, and is what review recommended.

> **Prior art.** [#576](https://github.com/bloknayrb/tandem/issues/576) evaluated two write-back
> engines — [`docx` npm](docx-npm-spike.md) (GO, shipped) and
> [LibreOffice headless](docx-libreoffice-spike.md). Both *generate a new file from a document
> model*. GenOffice is a third architecture — *patch the original bytes* — that neither spike
> could consider, because GenOffice was open-sourced on 2026-08-03.

---

## 1. What GenOffice is

An AI-native office suite (Docs/Sheets/Slides/PDF; five Electron apps over a shared engine
layer) from Genspark, under Apache-2.0. Announcements date the open-sourcing to 2026-08-03;
nothing in the tree corroborates that, so treat it as press-sourced rather than verified. The
suite itself is irrelevant here.
`packages/docx-engine` is not.

| | |
|---|---|
| Source | 11,440 LOC across 20 files (`parse.ts` 3039, `generate.ts` 2162, `patch.ts` 1502) |
| Tests | 52 `*.test.ts` files, 8,053 LOC (8,300 incl. `tests/helpers/`) — **428 pass, 1 skipped**, 5.75 s |
| Dependencies | `fast-xml-parser` + `jszip`. **Nothing else.** |
| Coupling | Zero imports from other workspace packages or from `ee/` |
| License | Apache-2.0 (`ee/` holds only a LICENSE + README — no enterprise code exists yet) |
| Distribution | `"private": true`, `exports` points at raw `./src/index.ts` |

Tandem already depends on `jszip@^3.10.1` — the exact version the engine wants. `fast-xml-parser`
would be the only new dependency.

**Governance caveat.** The repository has **one commit**, `Sync snapshot (2026-08-05) (#34)`. It
is a code-drop mirror, not developed in public: no history, no blame, no incremental review. (The
`(#34)` implies upstream PR numbering that the mirror does not expose — which is the point: the
review trail exists somewhere we cannot see.) Combined with `private: true`, vendoring is the
only consumption model, and upstream fixes would arrive as opaque re-drops to diff by hand.

### `.doc` (legacy binary) — out of scope entirely

The engine parses `word/document.xml` out of an OOXML ZIP. Legacy binary `.doc` (OLE2
compound-file, pre-2007) shares no format surface with it, and nothing in the repo touches it.
GenOffice does not help with `.doc`, and neither does anything Tandem ships. That would remain a
LibreOffice-shaped problem.

---

## 2. The architectural difference that matters

Tandem's `.docx` save is a **full regeneration**. `exportYDocToDocx`
(`src/server/file-io/docx-export.ts:776`) walks the Y.Doc and constructs a brand-new `Document`
via the `docx` npm package. The original ZIP is never opened. Nothing that mammoth dropped on
import can possibly come back, because nothing retained it — `Prepared` for docx carries only
`{format, html, comments, footnoteBodies, issues}` (`src/server/file-io/types.ts:68-82`), and
the open-document registry holds no content at all (`src/server/documents/registry.ts:27-33`).

GenOffice instead treats the original bytes as the source of truth:

- `scanBody()` (`scan.ts:30`) is a **byte-offset scan, not an XML parse**, of `<w:body>`'s direct
  children. The header states why: *"parse->serialize would silently change untouched bytes:
  attribute order, self-closing forms, entity forms."*
- Every block records `docxIndex` (its ordinal) and `originalXml` (its exact byte slice),
  assigned before any classification branch (`parse.ts:510`) — so no block can exist without
  its original bytes.
- `saveDocx(parsed, finalBlocks)` rebuilds the body by **enumeration**: each `{kind:'original'}`
  block is spliced back as a raw substring; only `{kind:'generated'}` blocks are re-serialized.

Two escape hatches carry the fidelity that a document model normally loses:

- **`passthrough` blocks.** Content the parser refuses to model — section breaks, fields, TOCs,
  OLE objects, charts, SmartArt, display equations, anchored textboxes, and a catch-all for *any*
  non-`w:p`/`w:tbl` body child (`parse.ts:580-582`) — is preserved opaquely rather than dropped.
  The model is closed under unknown input.
- **`rawPPr` / `rawRPr`.** A *regenerated* paragraph starts from its original `<w:pPr>` slice and
  **merges** format-model changes into it (`generate.ts:894`, mutating it where the model
  disagrees, e.g. `pPrWithJc` at `:501`) rather than reusing it verbatim; and `mergeRPrModel`
  rebuilds a run property-group by property-group, keeping original bytes wherever the model
  agrees. So `caps`, `vanish`, `dstrike`, `bdr`, double underline, `themeColor` and all four
  `rFonts` slots survive an edit to a *different* property in the same run. One caveat that
  matters for any caller: a **split twin** — the second half of a paragraph the user split, whose
  anchor is already consumed — gets **no** `rawPPr` at all (`convert.ts:948-959`), deliberately,
  so revision records and section properties are not duplicated.

GenOffice decides `{kind:'original'}` vs `{kind:'generated'}` by **content signature comparison**
(`apps/docs/src/renderer/editor/convert.ts:940`, `signatureOfBlock(original) ===
signatureOfGenerated(generated)`). The *comparison* is derived from current content, not from an
event stream — which is the property that would make it indifferent to whether a Y.Doc was
mutated by `withBrowser`, `withMcp` or `withFileSync`.

**But the pairing is not.** Which original a node is compared *against* comes from
`node.attrs.docxIndex` (`convert.ts:935`) — a persisted per-node attribute — plus a mutable
`usedIndexes` set. That attribute is precisely the state a CRDT merge or a paragraph split could
disturb, so calling this design "stateless and therefore CRDT-safe" (as an earlier draft did)
assumes the conclusion. It is the reason §3e's mapping question is the real integration risk, and
the reason Option B pairs by flat-text offset instead of inheriting this attribute.

---

## 3. What I measured

Harness in the session scratchpad (`harness/{roundtrip,summary,floor,bridge,status-quo}.ts`),
engine source copied and run under `tsx` with its own `node_modules`.

### 3a. Byte-identity, no edits — 31/31, but partly tautological

All 31 documents round-tripped **byte-identical across every ZIP entry**.

That number is weaker than it looks, and the upstream test suite has the same problem.
`saveDocx` carries an `isUnchanged` short-circuit (`patch.ts:358-392`) that returns the input
object outright when every block is `original` and ~25 `SaveOptions` fields are `undefined`.
Upstream's headline assertion is `expect(saved).toBe(bytes)` (`roundtrip.test.ts:25`) —
**reference identity on a short-circuit return**, which proves the short-circuit fires, not that
the serializer can reproduce a file. The same pattern recurs at `comments.test.ts:154`,
`notes.test.ts:104` and `revisions.test.ts:213`. My scenario A hit the same path. Reported for
completeness, not as evidence.

### 3b. One-paragraph edit — the real patch test

Editing exactly one paragraph's text:

| Fixture | Entries changed | `document.xml` divergent window |
|---|---|---|
| `reviewer-comments.docx` | `word/document.xml` | 173 chars of 413 |
| `single-paragraph.docx` | `+ docProps/core.xml` | 159 chars of 1563 |
| `reference-with-comment.docx` | `+ docProps/core.xml` | 272 chars of 1860 |
| `01-simple-english.docx` | `word/document.xml` | **23 chars of 10,548** |
| `04-headings-keepnext.docx` | `word/document.xml` | **10 chars of 8,633** |

Every other ZIP entry stayed byte-identical. `docProps/core.xml` picks up a fresh
`dcterms:modified` when the body changes; three of the five fixtures above have no
`docProps/core.xml` part at all, which is why it appears in only two rows. (An earlier draft
offered "it stayed untouched in the no-edit case" as evidence of restraint — it is not: the
no-edit path returns the original bytes wholesale, so nothing *could* move.)

### 3c. The fidelity floor — worst case if everything is dirty

The measurement that matters for a CRDT integration, because Tandem cannot guarantee its
signature attributes survive every merge: **force every paragraph/heading/listItem to
regenerate from its parsed model with no semantic edit.**

Result across all 31 documents: **text-identical in every case**, and every ZIP part other than
`word/document.xml` and `docProps/core.xml` byte-identical (the harness excludes `core.xml` from
that comparison, so it is outside the claim's evidence). `document.xml` size drift ranged from
**−9.6% to +40.2%** — the high end is `reviewer-comments.docx`, a 413-char document where a
single regenerated paragraph dominates — entirely XML verbosity and entity-encoding
normalization, with no text change.

> **A self-correction worth recording.** My first run flagged `sample-output.docx` as losing 10
> characters of visible text. It had not. The original encoded `&quot;hello&quot;`; the
> regenerated XML emits a literal `"hello"` — identical text, valid XML, different encoding. My
> character counter was counting entity markup. This is precisely the drift `scan.ts:2-9` names
> as the reason never to re-serialize untouched content, showing up exactly where the design says
> it should: on a paragraph that *was* regenerated. The engine behaved correctly; my measurement
> was wrong.

### 3d. The coordinate bridge — the decisive integration question

Tandem anchors every annotation to a flat text offset over `extractText()`, and
`docx-walker.ts`'s stated invariant is that its walk of raw OOXML produces the same flat text.
Swapping parsers would rebuild that coordinate system from `Block[]`. So: how far apart are they?

I ran Tandem's **real** adapter (`getAdapter("docx").parse` → `apply` → `extractText`) against a
naive flat-text reconstruction from GenOffice's blocks using Tandem's own rules (heading
prefixes, `\n` joins):

| Fixture | Tandem | GenOffice | Result |
|---|---|---|---|
| `reviewer-comments.docx` | 26 | 26 | **identical** |
| `single-paragraph.docx` | 23 | 23 | **identical** |
| `reference-with-comment.docx` | 180 | 180 | **identical** |
| `sample-output.docx` | 483 | 484 | one leading `\n` before a table |

The one divergence is an off-by-one in my naive table join, not a structural incompatibility.
**A faithful bridge is achievable.** It is not free — `getElementText`'s rules would have to be
ported deliberately and every existing `.docx` annotation re-anchored — but there is no blocker.

> **Scope warning, flagged by review and worth stating plainly:** this measures *concatenation
> equality* of the whole flat text. It says nothing about **element-level correspondence**
> between two structurally different trees. An earlier draft of this spike cited it as evidence
> that blocks and Y.Doc elements are "close to 1:1"; that was a genuine error of reasoning, and
> §3e measures the actual question.

### 3e. Block ↔ Y.Doc mapping — where the naive integration breaks

Adversarial review challenged the assumption that Y.Doc top-level elements correspond 1:1 to
GenOffice blocks. **The challenge was right, and measuring it changed the recommendation.**

Mammoth renders a docx list as one `<ul>` containing many `<li>` — one Y.Doc `bulletList`
element. GenOffice emits **one `listItem` block per paragraph**:

| Fixture | Y.Doc elements | GenOffice blocks | 1:1? |
|---|---|---|---|
| `sample-output.docx` | 14 | 19 | **no** — first divergence at index 6 (`bulletList` vs `listItem`) |
| `08-multi-section-paper.docx` | 27 | 28 | **no** — index 16, a section-break paragraph is `passthrough` in GenOffice, `heading` in the Y.Doc |
| `16-numbered-list.docx` | 51 | 51 | yes |
| `05-long-table.docx` | 4 | 4 | yes |
| `13-english-report.docx` | 86 | 86 | yes |

**Order-based mapping is therefore unsafe.** Once the sequences diverge at index 6, every
subsequent pairing is wrong — and "regenerate the block I think changed" applied to a
misaligned pair is silent data corruption, not a safe fallback.

Mapping by **flat text offset** instead handles the N:1 collapse naturally (a `bulletList`
spanning `[a,b)` simply hosts the six `listItem` blocks that partition `[a,b)`). Testing whether
block ranges nest cleanly inside element ranges:

| Fixture | Y.Doc flat / block flat | Blocks nesting cleanly |
|---|---|---|
| `16-numbered-list.docx` | 1740 / 1740 | **51/51** |
| `05-long-table.docx` | 951 / 951 | **4/4** |
| `13-english-report.docx` | 17304 / 17304 | **86/86** |
| `sample-output.docx` | 483 / 484 | 16/19 |
| `08-multi-section-paper.docx` | 682 / 683 | 17/28 |

The pattern is sharp: **mapping is exact wherever the two flat texts agree exactly, and
collapses wherever they differ by even one character**, because a one-char drift cascades
through every subsequent offset. (Both failures are a single stray `\n` from my naive
reconstruction's table/section join rules — my code, not the engine.)

That is not a defect so much as a **checkable precondition**, which makes it the basis for a
real fail-safe rather than a hope. Tandem already uses exactly this guard: `applyTrackedChanges`
throws when `offsetMap.flatText !== options.ydocFlatText` (`src/server/file-io/docx-apply.ts:507-512`).

### 3f. Does the formatting win hold for *edited* paragraphs?

Review's strongest objection: an unchanged block trivially keeps its bytes, but Tandem's Y.Doc
holds **no** formatting for docx content (mammoth dropped it on import), so a regenerated
paragraph might synthesize an empty property set — reproducing today's bug, just scoped smaller.

Measured directly: take every block whose `rawPPr`/`rawRPr` actually carries formatting, change
its **text**, keep the original property bytes, save, and re-count.

| | `sample-output.docx` (6 edited) | `10-cn-official-doc.docx` (12 edited) |
|---|---|---|
| `w:pPr` | 11 → **11** | 15 → **15** |
| `w:ind` | 2 → **2** | 8 → **8** |
| `w:shd` | 4 → **4** | — |
| `w:rFonts` | 4 → **4** | — |
| `w:jc` / `w:sz` / `w:spacing` | — | 4→**4** / 1→**1** / 1→**1** |
| `w:rPr` | 40 → 34 | 1 → **1** |

The three constructs Tandem zeroes out — `w:ind`, `w:shd`, `w:rFonts` — **survive an edit
intact**. The lone `w:rPr` delta is not loss: `<w:r>` elements went 40 → 34 in lockstep, so six
adjacent runs with identical properties coalesced and took their redundant `w:rPr` with them.
Empty `<w:rPr/>` count was 0 before and after.

So `rawPPr`/`rawRPr` do what their design intends, and the win is real for the edited case, not
just the untouched one. The caller-side glue is still unbuilt — the model handed to
`generate.ts` must carry the original block's property bytes through, which is what this harness
does explicitly — but it is glue, not a missing capability.

### 3g. Status quo — what Tandem loses today

Tandem's real import→export round-trip vs. GenOffice's parse→save, counting OOXML constructs in
`word/document.xml` (`scripts/spikes/fixtures/sample-output.docx`):

| Construct | Original | **Tandem today** | GenOffice |
|---|---|---|---|
| `w:pPr` | 11 | **8** | 11 |
| `w:rPr` | 40 | **33** | 40 |
| `w:ind` (indentation) | 2 | **0** | 2 |
| `w:shd` (shading) | 4 | **0** | 4 |
| `w:rFonts` (fonts) | 4 | **0** | 4 |
| `w:tblPr`, `w:tblBorders`, `w:sectPr` | 1 each | 1 each | 1 each |

**Two caveats on this table, both found by fact-check and both worth stating loudly.**

1. **The GenOffice column is the `isUnchanged` short-circuit.** It was produced by
   parse → save-all-original, which returns `originalBytes` by reference (§3a). As a fidelity
   result it is tautological. **The non-tautological evidence is §3f**, which forces
   regeneration and still holds `w:ind` 2→2, `w:shd` 4→4, `w:rFonts` 4→4. Read this column as
   "nothing was touched", and §3f as "and it survives being touched."
2. **This fixture is not a Word document.** `docProps/app.xml` gives `dc:creator =
   "Tandem (spike-docx-export)"` — it is output from Tandem's *own* `docx`-npm spike exporter.
   Of my whole corpus, exactly one file (`single-paragraph.docx`, `Microsoft Office Word`
   AppVersion 14.0) is genuine Word output; `reference-with-comment.docx` is
   `LibreOffice/26.2.2.2`. So the headline loss below is **n=1 on a non-Word file.**

The *mechanism*, however, is verified and structural rather than sampled: mammoth's
`ignoreElements` list (`body-reader.js:706,714-719`) discards `w:pPr`, `w:rPr`, `w:tblPr`,
`w:tblGrid`, `w:trPr`, `w:tcPr` and `w:sectPr` before Tandem ever sees them, so the loss cannot
be an artifact of this particular file. On that basis — mechanism verified, magnitude sampled
once — opening a styled Word document in Tandem and saving it **reformats the user's file**, and
`detectExportFidelityIssues` (`docx-export.ts:702-725`) does not report it: it reports exactly
two things, unknown node names and images without embedded data. Confirming the magnitude on
real Word documents is follow-up #1, and this table is the reason that follow-up is first.

---

## 4. What adoption would fix

**Formatting**, per §3f and §3g — the best-evidenced win, and real for edited paragraphs, not
just untouched ones.

**The `applyChanges` → `save` data-loss cycle — deferred, not killed.** `tandem_applyChanges`
surgically writes `<w:ins>`/`<w:del>` into the original ZIP; the next `tandem_save` destroys
them, because `exportYDocToDocx` emits no revision marks. Tandem's own source documents this
(`docx-lost-features.ts:42-49`) — the marks it just created are counted as *losses* on the next
open. Under Option B a paragraph whose revision marks are untouched splices back verbatim and
survives. But the moment that paragraph is edited again — the normal case in an active review —
it reclassifies to `generated`, and Tandem has no per-character revision model to hand the
engine, so the marks die exactly as today. Honest claim: **survives until the next touch of that
paragraph.** Fully closing it needs a revision model on Tandem's side, which is a separate
project.

**The two things `docx-lost-features.ts` exists to report.** Tracked changes and page
headers/footers are both modeled by the engine (`SaveOptions.header/footer/headerFirst/
footerEven/sectionHf`, `HeaderFooter`, `blockRevision`), so that reporter could become narrower
— subject to the same caveat above.

**Comment reply threads — NOT included in Option B.** `CommentInfo` carries `parentId` (resolved
through `commentsExtended.xml`'s `paraId` relation) and `done`, a direct structural match for
Tandem's imported Word reply threads (#1000), which currently **flatten** into the parent body
on export (`docx-comment-export.ts:58-61`). But comments live in separate parts outside
`<w:body>`; Option B's mechanism only splices body blocks and does not touch them. Realizing
this would require a second, separately-scoped integration against `docx-comment-export.ts`.
Listed as available capability, not as a delivered benefit.

**Much of `docx-verify.ts`.** The post-write re-import verifier exists because a full rebuild can
silently produce a degenerate file. Byte-preserving patch removes most of that risk class at the
source.

---

## 5. What it would cost, and what blocks it

### Blocker — untrusted input

The engine's ZIP guard (`assertZipWithinLimits`, `parse.ts:71-94`; constants at `:62-64`) permits
**512 MiB per part / 1.5 GiB total / 10,000 parts**. A payload that *truthfully* declares 400 MiB
compresses to 399.2 KiB on the wire (**1026× amplification**), passes the guard, and **OOM-kills
a Node process started with `--max-old-space-size=8192`**. There is no cap on the input array
before `JSZip.loadAsync`.

The vector is the **honest** declaration, not a lie. A central directory that *lies* — declares
100 bytes, ships 200 MiB — is rejected, though incidentally: JSZip's own inflater catches it with
`"Bug : uncompressed data size mismatch"`, a third-party assertion that calls itself a bug rather
than an engine-level check. The guard reads attacker-controlled sizes, but that is not where it
fails; it fails by sanctioning limits far above what the parse can actually survive.

Tandem accepts `.docx` via `POST /api/upload` and supports LAN binding. This must be fixed before
the engine sees any untrusted bytes: an input byte cap far below the built-in ceilings, and
ideally out-of-process parsing.

Review argued Option B *widens* this exposure by re-parsing on "the autosave cadence." It does
not: `BINARY_SAVE_FORMATS = {docx}` is **deliberately disjoint** from `AUTO_SAVE_FORMATS`
(`src/shared/constants.ts:371-380`), and `document-service.ts:303` returns `EXPLICIT_ONLY` for
`isBinary && source === "auto-save"`. `.docx` saves only on explicit user action, so the
re-parse is per-save-click, not per-timer. The exposure still widens from once-per-open to
once-per-save, which is real but materially smaller than argued.

### Not a blocker — XXE and entity expansion (but not for the reason I first wrote)

Verified by live probe: a billion-laughs payload does not expand, and a
`SYSTEM "file:///C:/Windows/win.ini"` payload through `parseDocx` returns the literal string
`&xxe;` with no file read.

An earlier draft attributed this to `fast-xml-parser` "being configured without entity
processing." That is **false** — `xml-utils.ts:6-13` never sets `processEntities`, and FXP 5.x
defaults it to `true`; a DOCTYPE-declared internal entity does expand when fed to FXP directly.
(It has to decode entities, or §3c's `&quot;` self-correction could not have happened.) The real
protection is architectural: the byte-scan front end never hands a whole DOCTYPE-bearing document
to FXP, and FXP hard-throws `External entities are not supported`. Same conclusion, different
mechanism — and the difference matters, because architectural protection is the kind a future
refactor can remove without anyone noticing.

### Cost — unmeasured save latency

Parsing the whole of `word/document.xml` on every save is CPU and latency this harness never
benchmarked. Option C's targeted splice avoids most of it. Worth measuring before either path
is committed, on a large document rather than these fixtures.

### Cost — memory

`ParsedDocFull` retains `internal.originalBytes` (the whole file), `internal.documentXml` (the
full body as a JS string), **and** a per-block slice of that string (`Block.originalXml`), held
for the document's lifetime. The multiplier is **unmeasured**: `parse.ts:172` uses
`documentXml.slice(...)`, and V8 returns SlicedStrings that reference the parent rather than
copying, so the per-block slices may cost almost nothing and the true figure may be ~2× rather
than the 3–4× an earlier draft asserted. Measure before treating this as a cost input.

It matters regardless of the multiplier, because Tandem's server holds many documents open at
once — it is not a single-document Electron renderer. Note that **Option B sidesteps this
entirely** by parsing at save time and discarding immediately; only Option A would hold parsed
state resident.

### Cost — no staleness guard

Nothing links `blocks` ↔ `extras.elements` ↔ `internal.documentXml`: no version tag, hash or
nonce. `saveDocx`'s only check is a bounds test (`patch.ts:863`), which catches an out-of-range
`docxIndex` but not a *wrong in-range* one. A `ParsedDocFull` held while the file changes on disk
would silently splice new content at stale offsets. Tandem has the machinery to prevent this
(file watcher, `recordSelfWrite` fingerprints, external-conflict banner, mtime guard) but it must
be deliberately wired to invalidate the parse.

### Cost — maturity and provenance

- **Fixtures are 100% synthetic.** Every green test runs on XML the authors wrote to match their
  own parser: no `w:rsid*`, no `mc:Ignorable`, no `w:proofErr`, no `settings.xml`. (`w:lang`
  *does* appear, in `raw-rpr.test.ts` and `schema-order.test.ts`.) The single test that opens a
  real Word document (`raw-rpr.test.ts:121`) points at a **gitignored** file and is skipped by
  default. For a byte-preservation product this is the gap that matters most.
- **My corpus did not close that gap — it is worse than I first wrote.** Of my 31 documents, 23
  are GenOffice's own generated pagination corpus, several more are generated kitchen-sink
  fixtures, and `reviewer-comments.docx` comes from Tandem's
  `scripts/fixtures/make-reviewer-docx.mjs`. Reading `docProps/app.xml` rather than guessing from
  part names: **exactly one file in the corpus is genuine Word output** —
  `single-paragraph.docx` (`Microsoft Office Word`, AppVersion 14.0).
  `reference-with-comment.docx` is `LibreOffice/26.2.2.2$Windows_X86_64`, and
  `sample-output.docx` is `Tandem (spike-docx-export)`. **The byte-preservation claim remains
  unverified against a real-world corpus** — it is simply cheap for us to verify, since we would
  supply the corpus.
- Honest, documented degradations (zero `TODO`/`FIXME` in 11.4k LOC; gaps written as prose):
  nested-table outer-cell text editing unsupported (`generate.ts:363`); new hyperlinks **inside
  textboxes** degrade to plain text for want of rel allocation (`generate.ts:503` — note this is
  textbox-scoped, *not* an engine-wide limit; `patch.ts:397-407` allocates relationships for
  newly created hyperlinks and images on the normal path); only SHA-512 document protection
  (`protection.ts:75`); `UnsupportedOmml` thrown at ~10 sites in `math.ts`; SmartArt and OLE
  embeds are explicit degrades; trailing empty paragraphs in table cells dropped
  (`parse.ts:2028`).
- Two latent lossy paths on the caller's side: the body is rebuilt by **enumeration**, so a
  passthrough block the caller forgets to emit is **gone**; and inter-element whitespace plus
  body-level XML comments fall outside the enumeration (Word emits neither).

---

## 6. Options

**Option A — adopt the engine for import *and* export.** Maximum fidelity, maximum cost. Changes
the Y.Doc shape for `.docx` (Tandem's Tiptap schema has no node for `passthrough`/protected
content), which changes `extractText()` offsets, which forces a migration for **every existing
`.docx` annotation** and touches Critical Rules #4/#5. Not justified by the evidence yet.

**Option B — save-side only, gated on an exact flat-text match. ← recommended**

Leave import exactly as it is: mammoth → Y.Doc, unchanged offsets, unchanged annotations,
unchanged Y.Doc shape, zero migration. Change only what happens on save:

1. Re-read the original `.docx` from disk — Tandem's `applyChanges` pipeline already does exactly
   this at `src/server/mcp/docx-apply.ts:155` (`applyTrackedChanges` itself takes a `Buffer` and
   never touches the filesystem). §5's staleness problem largely dissolves, because the parse is
   then seconds old.
2. `parseDocx` it into `Block[]`, and compute each block's flat text under Tandem's coordinate
   rules.
3. **Hard equality gate:** compare that flat text against `extractText(doc)`. This is the same
   guard `applyTrackedChanges` already enforces at `docx-apply.ts:507-512`.
4. **On mismatch, fall back to today's `exportYDocToDocx`.** No regression, no corruption — the
   worst case is exactly current behaviour.
5. On match, map blocks to Y.Doc content **by offset**, never by order (§3e). Emit
   `{kind:'original'}` for every block whose flat slice is unchanged — the overwhelming majority
   in a review workflow — and `{kind:'generated'}` only for the rest.

The gate is what makes this safe. §3e shows offset mapping is *exact* when the flat texts agree
and *garbage* when they do not, so the design must verify agreement rather than assume it. The
earlier draft of this spike recommended order-based mapping with "an unmappable block falls back
to `generated`"; adversarial review correctly identified that as false comfort — a misaligned
pair regenerates the wrong paragraph with the wrong content.

Note what step 5 does **not** need: it never has to reproduce formatting the Y.Doc never held.
An unedited paragraph keeps its original bytes wholesale. An edited one regenerates through
`rawPPr`/`rawRPr`, which reuse the original property bytes for everything the edit did not
touch — which is the mechanism that recovers §3g's `w:ind`/`w:shd`/`w:rFonts`, and §3f measures
it actually doing so.

**Option C — architecture only, no vendoring. ← co-equal, and preferred by review**

Extend Tandem's own `walkDocumentBody` + `buildOffsetMap` + DOM-patch machinery
(`src/server/file-io/docx-apply.ts`) to cover normal save, using GenOffice as *design
documentation* for what to preserve rather than as vendored code.

Adversarial review argued this is underrated, and the argument is strong:

- `buildOffsetMap`/`walkDocumentBody` already map Tandem's **authoritative** flat-text coordinate
  space — the one every annotation is anchored to per Critical Rule #4 — directly onto XML DOM
  positions (run, text node, char index). That is a *better* mapping primitive than anything
  built over a foreign block model, because it walks the actual XML the file contains and has no
  arity mismatch to reconcile at all.
- Tandem **already does rPr-preserving surgical edits**: `buildRun` (`docx-apply.ts:216-258`)
  clones the source run's `<w:rPr>` onto new text. The "hard 2,000 LOC is `generate.ts`" framing
  in this spike's earlier draft undersold how much of that already exists.
- No dependency, no license question, no unversioned code drop, no indefinite security
  ownership of a foreign OOXML parser.

The work: diff current Y.Doc flat text against the last-loaded flat text to find changed spans,
leave unchanged spans' XML untouched, and extend `applySingleSuggestion`'s run-splice machinery
past its current `"Cross-paragraph suggestions not yet supported"` restriction
(`docx-apply.ts:299`) to cover paragraph and list-item insertion/deletion. Non-trivial, but
incremental extension of code Tandem owns and tests.

**Recommendation.** Both B and C are defensible and they share a spine — re-read the original,
map through flat-text offsets, splice rather than rebuild. They differ in who supplies the
regeneration logic. Review's verdict was **C over B**, on the grounds that importing a foreign
block model with different granularity adds a reconciliation problem Tandem does not otherwise
have, in exchange for capability Tandem partly already has.

That verdict is well-founded and I would not argue against it. The one thing that keeps B alive
is §3f: `rawPPr`/`rawRPr` preserve formatting through an edit *today*, whereas the equivalent
under C is work Tandem would write and own. **The honest position is that this spike does not
settle B vs C** — it settles that the *architecture* (splice, don't rebuild) is right and
achievable, and that the mapping must be offset-based and gated. Choosing between B and C should
be the first question of the `/plan`, with follow-up #4 (prototype the mapping on a real
edit-then-save) run against **both** before committing.

---

## 7. Follow-ups before any implementation

1. **Run the engine against a real-world corpus** — genuine Word output, ideally including files
   Bryan has on hand. This is the single highest-value cheap check, and it closes the gap that
   both upstream's tests and my corpus left open. Point `raw-rpr.test.ts`'s `REAL` at it.
2. **Decide the memory budget** for retaining parsed state, or confirm Option B's
   re-read-at-save-time avoids it entirely (it should).
3. **Fix the input cap** before any untrusted bytes reach `parseDocx`.
4. **Prototype the block↔Y.Doc mapping** on `sample-output.docx` and confirm the
   `w:ind`/`w:shd`/`w:rFonts` counts in §3g survive a real edit-then-save **driven from a Y.Doc**
   (§3f proves the engine preserves them; the untested half is Tandem's glue feeding it).
   Run this against **both** Option B and Option C before choosing.
6. **Benchmark save latency** on a large document — full re-parse per save is unmeasured.
5. This spike is input to `/plan`, not a substitute for it. Per `CLAUDE.md`, implementation
   starts with a plan and adversarial agent review.

## Reproducing

Harness lives in the session scratchpad, not the repo. To rebuild:

```bash
git clone --depth 1 https://github.com/genspark-ai/genoffice.git
cp -r genoffice/packages/docx-engine/src ./engine
npm install fast-xml-parser@^5.3.4 jszip@^3.10.1 tsx@^4.21.0
# then parseDocx() -> saveDocx(parsed, blocks.map(b => ({kind:'original', docxIndex: b.docxIndex})))
# and diff every zip entry.
```

Upstream's own suite: `npm install` at the repo root, then `npx vitest run` in
`packages/docx-engine` (428 pass / 1 skipped, ~6 s).
