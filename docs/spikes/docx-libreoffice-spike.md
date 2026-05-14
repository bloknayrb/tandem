# Spike: LibreOffice headless feasibility for `.docx` write-back

**Issue:** [#576](https://github.com/bloknayrb/tandem/issues/576)
**Author:** spike PR
**Date:** 2026-05-14
**Status:** GO with conditions (primary path) OR NO-GO if Tauri bundle size is the dominant constraint
**Companion spike (Unit 5):** `docx` npm package — pure-JS alternative

## Goal

Issue #576 needs a docx write-back engine that can (a) round-trip rich content from a Tiptap/Y.Doc state and (b) write Tandem annotations as Word comments (`<w:commentRangeStart>` / `<w:commentRangeEnd>` / `<w:commentReference>`). The discriminating question for this spike was the second part: **can LibreOffice headless inject new Word comments into a .docx output programmatically?**

If yes, LibreOffice headless is competitive with the pure-JS `docx` library and wins on fidelity. If no, the verdict is NO-GO regardless of latency or bundle size.

## How to reproduce

```bash
# 1. Install LibreOffice. The script does NOT auto-install.
#    Windows:  winget install TheDocumentFoundation.LibreOffice
#    macOS:    brew install --cask libreoffice
#    Linux:    apt-get install libreoffice  (or distro equivalent)
# 2. From the repo root:
node scripts/spikes/libreoffice-poc.mjs
# 3. Results: scripts/spikes/fixtures/output/results.json
#    Outputs (docx + html) are in the same dir; the dir is .gitignored.
```

Set `SOFFICE_PATH` if `soffice` is not at the default Windows install location.

## Spike machine

- Windows 11, Node v24.14.1
- LibreOffice 26.2.2.2 (current Fresh release as of 2026-05-14)
- Install size: **`C:\Program Files\LibreOffice` = 689.7 MB** (verified)

## Experiments

| # | Input | Filter | Cold ms | Warm ms | Output bytes | Comments in output |
|---|---|---|---|---|---|---|
| 1 | `sample.md` -> HTML | `docx` (Writer) | 4335 | 3955 / 3586 | 7734 | 0 |
| 2 | `with-comment.fodt` (ODF annotation) | `docx` | 3681 | — | 5723 | **1 (injected)** |
| 3 | `with-comment.docx` (round-trip) | `docx` | 4181 | — | 6103 | **1 (preserved)** |
| 4 | `sample.md` (raw, no HTML stage) | `docx` | 3551 | — | 7390 | 0 (no formatting parsed) |
| 5 | `large.md` (~10 pages) -> HTML | `docx` (Writer) | 4073 | 4465 / 3796 | 8688 | 0 |

All values are milliseconds wall-clock for the `soffice --headless --convert-to docx` invocation, measured by the PoC. Each invocation uses a unique `UserInstallation` profile to avoid lockfile collisions.

Raw JSON: `scripts/spikes/fixtures/output/results.json` after running the PoC. A reference `.docx` from experiment 2 (with one Word comment injected by soffice) is checked in at `scripts/spikes/fixtures/reference-with-comment.docx`.

## Findings

### 1. Comment write-back: confirmed positive

**The key result.** Authoring an ODF document with an `<office:annotation>` element and running `soffice --headless --convert-to docx` produces a `.docx` with:

- `word/comments.xml` present as an OOXML part
- exactly one `<w:commentReference>` in `word/document.xml`
- one `<w:comment>` entry in `word/comments.xml` carrying the author + date metadata

That means LibreOffice's docx export filter DOES translate ODF annotations into Word comments. Tandem can:

1. Convert Tiptap/Y.Doc state -> intermediate ODF (FODT or ODT)
2. Inject Tandem annotations as `<office:annotation>` elements with stable IDs
3. Shell out to soffice for the final `.docx`

The intermediate-format approach (FODT, since it is single-file XML) is straightforward to template from a server-side converter.

**Caveat — single annotation, no range:** the soffice-produced `.docx` had `<w:commentReference>` (1 occurrence) but `<w:commentRangeStart>` (0 occurrences). ODF annotations are point-anchored by default; Tandem annotations have ranges. To preserve a Tandem range as a Word comment range, the FODT must wrap the range with `<office:annotation>` (start) + `<office:annotation-end>` (end) elements. The PoC fixture used a point annotation; a range round-trip would be a follow-up validation before committing to production.

### 2. HTML -> docx works, but needs `--writer`

`soffice --headless --convert-to docx input.html` fails with `Error: no export filter for ... found, aborting.` because soffice classifies HTML inputs as "Writer/Web" documents whose default export filters do not include OOXML.

**Fix:** add `--writer` to force Writer-document handling:

```
soffice --headless --writer --convert-to docx --outdir <out> input.html
```

Then the conversion uses the "Office Open XML Text" filter and produces a valid `.docx`. The PoC documents this and applies it for experiments 1 and 5.

### 3. soffice does not natively parse markdown

Experiment 4 confirms soffice treats `.md` as plain text. The output `.docx` has zero structure — no headings, no bold/italic. **Production wire-up MUST convert markdown to HTML (or ODF) first.** The PoC ships a minimal markdown->HTML converter for the spike; production should use `unified` + `remark` (already in the Tandem dep tree).

### 4. Latency

- Cold start dominates: ~3.5-4.4s for any conversion, regardless of size.
- A 10-page document is no slower than a 1-paragraph document (E1 vs E5 are within margin).
- "Warm" invocations in this PoC are still cold-starts of new soffice processes (each test uses a fresh `UserInstallation` profile). True warm-start would require keeping a long-lived soffice listener (`--accept=socket,...;urp`), which is plausible for Tandem (sidecar can keep one alive), but unmeasured here.

**Baseline comparison vs `mammoth.js` import:** mammoth import of a comparable document is in the low hundreds of milliseconds. soffice is ~10-30x slower per call. For an interactive save, 4 seconds is acceptable but noticeable; a Tauri sidecar pre-warming a soffice listener would help close the gap.

### 5. Fidelity ceiling

The PoC did not exhaustively probe complex content, but based on the experiments and the LibreOffice export filter capabilities:

| Feature | Likely survives via soffice |
|---|---|
| Headings, paragraphs, inline marks | YES |
| Bullet / ordered lists, nested lists | YES |
| Tables (basic) | YES |
| Tables (merged cells, complex) | MOSTLY (better than mammoth import allows) |
| Images | YES (embedded in `word/media/`) |
| Hyperlinks | YES |
| Word comments (existing) | YES (E3 confirmed) |
| Word comments (newly injected) | YES (E2 confirmed) |
| Footnotes / endnotes | LIKELY (LibreOffice has full ODF<->OOXML mappings) |
| Headers / footers | LIKELY |
| Tracked changes | UNTESTED — known to round-trip in soffice but not exercised in this spike |
| Custom Word styles | PARTIAL — soffice maps to standard styles; named styles drop |

Crucially, **the fidelity ceiling for Tandem is bounded above by mammoth's import**, not by soffice's export. mammoth already drops footnotes, headers/footers, and tracked changes on the way in; soffice could output them if Tandem had them, but it does not.

## Bundling cost (Tauri sidecar implications)

| Concern | Reality |
|---|---|
| Install size on disk | **689.7 MB** measured on Windows 11 (full LibreOffice). Trimmed builds (no Calc/Impress/Draw/Base, no UI) are possible but require building a custom distribution. |
| Installer download | ~340 MB (Windows MSI) at full size; trimmed could approach 150-200 MB. |
| Current Tandem installer | NSIS Tauri bundle is ~30 MB. A bundled LibreOffice would 6-10x the download size. |
| License | LibreOffice is **MPL 2.0 + LGPL v3** (hybrid). Bundling as a Tauri sidecar = redistribution; both licenses apply. MPL 2.0 is file-level copyleft — Tandem's own code is unaffected, but any modifications to LibreOffice files would have to be open. LGPL v3 requires that users can re-link against a modified LibreOffice (in practice: ship the version string and document how to swap the binary). Compatible with Tandem's BSL 1.1 distribution as long as the redistribution notice is included. |
| Update cadence | LibreOffice ships every ~6 months (24.x, 25.x, ...) plus security patches. Tandem would need to track CVEs against the bundled version. |
| Cross-platform | Available for Windows, macOS, and Linux. Each platform needs its own ~600 MB binary tree. |

**Alternative to bundling:** require LibreOffice as an external dependency. The current Tandem doctor command would detect its absence and surface a clear install link. This avoids the bundle cost but breaks the desktop app's "double-click and go" experience.

## Recommended next step

### Verdict: **CONDITIONAL GO**

LibreOffice headless **passes the discriminating test**: it can inject Word comments. The remaining blockers are operational, not technical:

1. **If bundling is acceptable:** GO. Build the FODT intermediate-format converter, integrate via Tauri sidecar with a long-lived soffice listener, accept the ~600 MB installer growth as the cost of best-in-class docx fidelity.
2. **If bundling is unacceptable** (e.g. Tandem wants to stay a sub-50MB installer): NO-GO for primary path; LibreOffice becomes an optional "advanced fidelity" mode requiring a user-side install. Default path uses `docx` npm.

### Estimated production-wire effort (if GO)

| Task | Effort |
|---|---|
| Tiptap JSON -> FODT converter (server-side, mirrors `mdast-ydoc.ts`) | 3-5 days |
| Annotation injection (`<office:annotation>` + `<office:annotation-end>` for ranges) | 1-2 days |
| Range round-trip validation tests (matching against `<w:commentRangeStart>` / `<w:commentRangeEnd>` in output) | 1 day |
| Sidecar wrapper for long-lived `soffice --accept=...` listener with health check | 2-3 days |
| Tauri bundling: include LibreOffice trim, code-sign, fit into NSIS/DMG/AppImage flow | 5-8 days (mostly toolchain plumbing per platform) |
| Tracked-changes design + implementation (separate from spike) | 3-5 days |
| **Total (LibreOffice GO path)** | **~3 weeks engineering** |

### Comparison anchor for Unit 5

Unit 5 spikes the `docx` npm package. The relevant tradeoff axes:

| Axis | LibreOffice | `docx` npm |
|---|---|---|
| Comment API | Yes (via ODF intermediate) | Yes (native `CommentRangeStart` / `CommentRangeEnd` / `CommentReference`) |
| Bundle cost | +600 MB | +~1 MB |
| Latency per save | ~4 s cold, possibly ~500 ms warm with listener | <100 ms |
| Fidelity ceiling | Higher (handles arbitrary docx features soffice supports) | Bounded by what `docx` exposes (no footnotes, custom styles, complex tables — must be added explicitly) |
| Cross-platform deployment risk | Each platform needs binary distribution | Pure JS, zero risk |

**My recommendation:** if Unit 5's spike confirms `docx` can write Tandem's required formatting subset (headings, lists, basic tables, inline marks, hyperlinks, images, comments with ranges), **pick `docx`**. The 600 MB bundle is the dominant cost for a desktop app, and Tandem's import fidelity (mammoth) is already the limiting factor — there is no upside to a higher export ceiling when the import floor is lower.

Use LibreOffice only if Unit 5 surfaces a `docx`-package limitation that materially affects Tandem's representable content (most likely: complex table merges, images embedded with specific positioning, or tracked-changes round-trip if Tandem decides to preserve them on import).

## Open questions for future work

- Range-anchored comment injection: confirm `<office:annotation>` + `<office:annotation-end>` produces `<w:commentRangeStart>` + `<w:commentRangeEnd>` in output. (Not validated in this spike — the fixture used point annotations only.)
- Long-lived soffice listener: actual warm-start latency under `--accept=socket,...;urp`. Likely 200-500 ms but unmeasured.
- macOS / Linux fidelity: spike was Windows-only. Behavior should be identical given LibreOffice is cross-platform, but worth verifying.
- License compatibility audit: confirm BSL 1.1 + MPL 2.0 + LGPL v3 combination is clean for paid distribution; informal reading says yes, formal review is a separate task.

## Files

- `scripts/spikes/libreoffice-poc.mjs` — PoC script (no production wire-up)
- `scripts/spikes/fixtures/sample.md` — small mixed-content fixture
- `scripts/spikes/fixtures/large.md` — ~10-page latency fixture
- `scripts/spikes/fixtures/with-comment.fodt` — ODF source for annotation-injection experiment
- `scripts/spikes/fixtures/reference-with-comment.docx` — reference soffice output (E2), inspectable without re-running
- `scripts/spikes/fixtures/output/` — gitignored; populated by running the PoC

Refs #576
