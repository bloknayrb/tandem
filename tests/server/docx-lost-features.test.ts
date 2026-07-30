/**
 * Silent-loss detection for tracked changes + headers/footers (#1142, gate G3).
 *
 * `scanDocxLostFeatures` exists because mammoth emits ZERO warnings for either
 * family (measured), so without it a reviewed `.docx` imports with every
 * insertion silently accepted and every deletion silently discarded.
 *
 * The load-bearing risk differs per half, and the tests are shaped around that:
 *
 *   - HEADERS/FOOTERS — the risk is a FALSE POSITIVE. Word emits empty
 *     even-page/first-page parts whenever "different first page / odd & even"
 *     is on, so an existence check would warn on documents with nothing in the
 *     header. That is trust-destroying on a "no surprise loss" surface.
 *   - REVISIONS — the risk is a FALSE NEGATIVE. A missed `w:moveFrom`, an
 *     unconventional main-part path, or a non-`w:` namespace prefix each yields
 *     a confident all-clear on a document that IS losing content.
 *
 * Every behaviour asserted here was measured against the real mammoth import
 * first; where a claim drove a design decision, the test names say so.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  type DocxLostFeatures,
  lostFeatureLossLines,
  scanDocxLostFeatures,
  structuralLossLines,
} from "../../src/server/file-io/docx-lost-features.js";
import {
  buildFormatRevision,
  buildHeaderFooter,
  buildHeadings,
  buildMovedPassage,
  buildPageNumberFooter,
  buildTrackedChange,
  rawDocx,
  zipWith,
} from "../helpers/docx-corpus.js";

const WML = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
const REL_NS = "http://schemas.openxmlformats.org/package/2006/relationships";
const REV = 'w:id="1" w:author="A" w:date="2020-01-01T00:00:00Z"';

/** Root rels pointing at an arbitrary main part — the OPC-correct way to name it. */
const rootRels = (mainPart: string): string =>
  `<?xml version="1.0"?><Relationships xmlns="${REL_NS}">` +
  `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="${mainPart}"/>` +
  `</Relationships>`;

const documentXml = (body: string, ns = "w"): string =>
  `<?xml version="1.0"?><${ns}:document xmlns:${ns}="${WML}"><${ns}:body>${body}</${ns}:body></${ns}:document>`;

const headerXml = (inner: string): string =>
  `<?xml version="1.0"?><w:hdr xmlns:w="${WML}">${inner}</w:hdr>`;

const footerXml = (inner: string): string =>
  `<?xml version="1.0"?><w:ftr xmlns:w="${WML}">${inner}</w:ftr>`;

/** A package with a conventional main part plus whatever extra parts are given.
 * `rawDocx` is the shared corpus assembler; the raw `zipWith` below is reserved
 * for the degenerate packages it can't express (unconventional or absent main
 * part, unparseable rels, a non-`w` namespace prefix). */
const pkg = (body: string, extra: Record<string, string> = {}): Promise<Buffer> =>
  rawDocx({ body, parts: extra });

const scan = scanDocxLostFeatures;

/** Stubbed so expected stderr doesn't drown the run. Restored after EVERY test —
 * an assertion that throws before an inline `mockRestore()` would otherwise
 * leave console.error stubbed for the rest of the file. */
const silenceErrors = (): void => void vi.spyOn(console, "error").mockImplementation(() => {});
afterEach(() => vi.restoreAllMocks());

/** A package whose only extra part is one header. */
const withHeader = (inner: string): Promise<Buffer> =>
  pkg("<w:p/>", { "word/header1.xml": headerXml(inner) });

describe("scanDocxLostFeatures — revision marks", () => {
  it("counts an insertion and a deletion apart (they mean different things)", async () => {
    const out = await scan(await buildTrackedChange());
    expect(out.revisions.insertions).toBe(1);
    expect(out.revisions.deletions).toBe(1);
    expect(out.revisions.formatting).toBe(0);
    expect(out.revisionScanFailed).toBe(false);
  });

  it("counts a move as a MOVE, never as an insertion (mammoth discards both halves)", async () => {
    const out = await scan(await buildMovedPassage());
    // Measured: mammoth recognizes neither w:moveTo nor w:moveFrom, so the moved
    // text is ABSENT. Calling the moveTo an "insertion accepted" would tell the
    // user text is present and about to be made permanent when it is already
    // gone — a false claim in the dangerous direction.
    expect(out.revisions.insertions).toBe(0);
    expect(out.revisions.deletions).toBe(0);
    expect(out.revisions.moveTo).toBe(1);
    expect(out.revisions.moveFrom).toBe(1);
    const lines = lostFeatureLossLines(out);
    // One move, not two halves.
    expect(lines).toContain(
      '1 moved passage (Word "move" revisions) wasn\'t imported — the moved text is missing from this document',
    );
    expect(lines.some((l) => /insertion|deletion/.test(l))).toBe(false);
  });

  it("counts formatting revisions separately from content revisions", async () => {
    const out = await scan(await buildFormatRevision());
    expect(out.revisions.formatting).toBe(1);
    expect(out.revisions.insertions).toBe(0);
    expect(out.revisions.deletions).toBe(0);
  });

  it("matches the *Change FAMILY, so an unknown future revision still counts", async () => {
    // The over-warn contract: an allow-list would silently swallow this.
    const out = await scan(
      await pkg(`<w:p><w:r><w:rPr><w:futurePrChange ${REV}/></w:rPr><w:t>x</w:t></w:r></w:p>`),
    );
    expect(out.revisions.formatting).toBe(1);
  });

  it("counts cellIns/cellDel/cellMerge, which don't carry the *Change suffix", async () => {
    const out = await scan(
      await pkg(
        `<w:tbl><w:tr><w:trPr><w:cellIns ${REV}/></w:trPr>` +
          `<w:tc><w:tcPr><w:cellMerge ${REV}/></w:tcPr><w:p/></w:tc></w:tr></w:tbl>`,
      ),
    );
    expect(out.revisions.formatting).toBe(2);
  });

  it("does not double-count the payload inside a deletion", async () => {
    // w:delText is the text INSIDE a w:del — counting it would multiply one
    // deletion by its run count.
    const out = await scan(
      await pkg(
        `<w:p><w:del ${REV}>` +
          `<w:r><w:delText>a</w:delText></w:r><w:r><w:delText>b</w:delText></w:r>` +
          `</w:del></w:p>`,
      ),
    );
    expect(out.revisions.deletions).toBe(1);
  });

  it("ignores the range bookkeeping markers around already-counted content", async () => {
    const out = await scan(
      await pkg(
        `<w:p><w:moveFromRangeStart ${REV}/><w:moveToRangeStart ${REV}/>` +
          `<w:customXmlInsRangeStart ${REV}/><w:customXmlDelRangeStart ${REV}/>` +
          `<w:r><w:t>plain</w:t></w:r></w:p>`,
      ),
    );
    expect(out.revisions).toMatchObject({
      insertions: 0,
      deletions: 0,
      moveTo: 0,
      moveFrom: 0,
      formatting: 0,
    });
  });

  it("counts a nested ins-inside-del in BOTH buckets (both revisions are real)", async () => {
    const out = await scan(
      await pkg(
        `<w:p><w:del ${REV}><w:ins ${REV}><w:r><w:delText>x</w:delText></w:r></w:ins></w:del></w:p>`,
      ),
    );
    expect(out.revisions.deletions).toBe(1);
    expect(out.revisions.insertions).toBe(1);
  });

  it("finds revisions when the main part is NOT word/document.xml", async () => {
    // Measured: mammoth resolves the main part through _rels/.rels and imports
    // such a package perfectly — silently applying the deletion. A hardcoded
    // path would report a confident "no tracked changes" here.
    const out = await scan(
      await zipWith({
        "_rels/.rels": rootRels("word/document2.xml"),
        "word/document2.xml": documentXml(
          `<w:p><w:del ${REV}><w:r><w:delText>gone</w:delText></w:r></w:del></w:p>`,
        ),
      }),
    );
    expect(out.revisions.deletions).toBe(1);
    expect(out.revisionScanFailed).toBe(false);
  });

  it("finds revisions under a non-`w` namespace prefix bound to the WML URI", async () => {
    // Measured: mammoth maps namespace URIs to canonical prefixes, so <x:del>
    // imports identically. Prefix-matching would be a false all-clear.
    const out = await scan(
      await zipWith({
        "_rels/.rels": rootRels("word/document.xml"),
        "word/document.xml": documentXml(
          `<x:p><x:del x:id="1" x:author="A"><x:r><x:delText>gone</x:delText></x:r></x:del></x:p>`,
          "x",
        ),
      }),
    );
    expect(out.revisions.deletions).toBe(1);
  });

  it("scans footnote and endnote bodies too (their revisions are equally silent)", async () => {
    const out = await scan(
      await pkg("<w:p/>", {
        "word/_rels/document.xml.rels":
          `<?xml version="1.0"?><Relationships xmlns="${REL_NS}">` +
          `<Relationship Id="r1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/footnotes" Target="footnotes.xml"/>` +
          `<Relationship Id="r2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/endnotes" Target="endnotes.xml"/>` +
          `</Relationships>`,
        "word/footnotes.xml":
          `<?xml version="1.0"?><w:footnotes xmlns:w="${WML}"><w:footnote w:id="1"><w:p>` +
          `<w:del ${REV}><w:r><w:delText>gone</w:delText></w:r></w:del></w:p></w:footnote></w:footnotes>`,
        "word/endnotes.xml":
          `<?xml version="1.0"?><w:endnotes xmlns:w="${WML}"><w:endnote w:id="1"><w:p>` +
          `<w:ins ${REV}><w:r><w:t>added</w:t></w:r></w:ins></w:p></w:endnote></w:endnotes>`,
      }),
    );
    expect(out.revisions.deletions).toBe(1);
    expect(out.revisions.insertions).toBe(1);
  });

  it("does NOT count revisions inside header/footer parts (already reported whole)", async () => {
    const out = await scan(
      await pkg("<w:p/>", {
        "word/header1.xml": headerXml(`<w:p><w:ins ${REV}><w:r><w:t>hdr</w:t></w:r></w:ins></w:p>`),
      }),
    );
    expect(out.revisions.insertions).toBe(0);
    expect(out.headers).toBe(1); // reported as a whole-part loss instead
  });

  it("finds note revisions when the main part is at the package ROOT", async () => {
    // baseDir is "" here, so a naive `${baseDir}/footnotes.xml` builds
    // "/footnotes.xml" — which JSZip never matches, silently losing the count.
    const out = await scan(
      await zipWith({
        "_rels/.rels": rootRels("document.xml"),
        "document.xml": documentXml("<w:p/>"),
        "footnotes.xml":
          `<?xml version="1.0"?><w:footnotes xmlns:w="${WML}"><w:footnote w:id="1"><w:p>` +
          `<w:del ${REV}><w:r><w:delText>gone</w:delText></w:r></w:del></w:p></w:footnote></w:footnotes>`,
      }),
    );
    expect(out.revisions.deletions).toBe(1);
  });

  it("falls back per-kind when a rels target doesn't name a real entry", async () => {
    // An unresolvable target must not ALSO suppress the fallback that would
    // have found the part sitting right there.
    const out = await scan(
      await pkg("<w:p/>", {
        "word/_rels/document.xml.rels":
          `<?xml version="1.0"?><Relationships xmlns="${REL_NS}">` +
          `<Relationship Id="r1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/footnotes" Target="../word/footnotes.xml"/>` +
          `</Relationships>`,
        "word/footnotes.xml":
          `<?xml version="1.0"?><w:footnotes xmlns:w="${WML}"><w:footnote w:id="1"><w:p>` +
          `<w:del ${REV}><w:r><w:delText>gone</w:delText></w:r></w:del></w:p></w:footnote></w:footnotes>`,
      }),
    );
    expect(out.revisions.deletions).toBe(1);
  });

  it("finds header/footer parts BESIDE the main part, not just under word/", async () => {
    // The resolver follows the rels wherever the main part lives; assuming
    // `word/` here would hand a `doc/`-laid-out package a false all-clear.
    const out = await scan(
      await zipWith({
        "_rels/.rels": rootRels("doc/document.xml"),
        "doc/document.xml": documentXml("<w:p/>"),
        "doc/header1.xml": headerXml("<w:p><w:r><w:t>ACME letterhead</w:t></w:r></w:p>"),
      }),
    );
    expect(out.headers).toBe(1);
  });

  it("reports 'couldn't check' rather than a silent zero when the main part is missing", async () => {
    silenceErrors();
    const out = await scan(await zipWith({ "docProps/app.xml": "<a/>" }));
    expect(out.revisionScanFailed).toBe(true);
    expect(lostFeatureLossLines(out)).toContain(
      "Tandem couldn't check this file for tracked changes — if it has any, they won't be preserved on save",
    );
  });

  it("falls back to word/document.xml when the root rels are unreadable", async () => {
    silenceErrors();
    const out = await scan(
      await zipWith({
        "_rels/.rels": "!!! not xml <<<",
        "word/document.xml": documentXml(
          `<w:p><w:del ${REV}><w:r><w:delText>gone</w:delText></w:r></w:del></w:p>`,
        ),
      }),
    );
    expect(out.revisions.deletions).toBe(1);
    expect(out.revisionScanFailed).toBe(false);
  });

  it("never follows an External relationship target", async () => {
    silenceErrors();
    const out = await scan(
      await zipWith({
        "_rels/.rels":
          `<?xml version="1.0"?><Relationships xmlns="${REL_NS}">` +
          `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="https://evil.example/doc.xml" TargetMode="External"/>` +
          `</Relationships>`,
      }),
    );
    // No usable main part → honest "couldn't check", never a fetch.
    expect(out.revisionScanFailed).toBe(true);
  });
});

describe("scanDocxLostFeatures — headers / footers", () => {
  it("counts parts with literal text", async () => {
    const out = await scan(await buildHeaderFooter());
    expect(out.headers).toBe(1);
    expect(out.footers).toBe(1);
  });

  it("counts a footer whose ONLY content is a PAGE field (no <w:t> at all)", async () => {
    // The load-bearing case: a text-only predicate would miss precisely the
    // loss this feature exists to surface.
    const out = await scan(await buildPageNumberFooter());
    expect(out.footers).toBe(1);
  });

  it("counts a logo-only header (w:drawing) and a symbol-only header (w:sym)", async () => {
    const drawing = await scan(await withHeader("<w:p><w:r><w:drawing/></w:r></w:p>"));
    expect(drawing.headers).toBe(1);
    const sym = await scan(
      await pkg("<w:p/>", {
        "word/header1.xml": headerXml(
          '<w:p><w:r><w:sym w:font="Wingdings" w:char="F0A7"/></w:r></w:p>',
        ),
      }),
    );
    expect(sym.headers).toBe(1);
  });

  it("counts a header whose only text sits inside a tracked deletion", async () => {
    const out = await scan(
      await pkg("<w:p/>", {
        "word/header1.xml": headerXml(
          `<w:p><w:del ${REV}><w:r><w:delText>Old letterhead</w:delText></w:r></w:del></w:p>`,
        ),
      }),
    );
    expect(out.headers).toBe(1);
  });

  it("does NOT count an empty part — the false positive that would destroy trust", async () => {
    // Word emits these routinely for "different first page / odd & even".
    const out = await scan(
      await pkg("<w:p/>", {
        "word/header1.xml": headerXml("<w:p/>"),
        "word/footer1.xml": footerXml(""),
      }),
    );
    expect(out.headers).toBe(0);
    expect(out.footers).toBe(0);
    expect(lostFeatureLossLines(out)).toEqual([]);
  });

  it("does NOT count a whitespace-only part", async () => {
    const out = await scan(
      await pkg("<w:p/>", {
        "word/header1.xml": headerXml('<w:p><w:r><w:t xml:space="preserve">   </w:t></w:r></w:p>'),
      }),
    );
    expect(out.headers).toBe(0);
  });

  it("matches every part-name form: no-digit, multi-digit, and mixed case", async () => {
    // OPC part names compare case-insensitively.
    const out = await scan(
      await pkg("<w:p/>", {
        "word/header.xml": headerXml("<w:p><w:r><w:t>a</w:t></w:r></w:p>"),
        "word/header2.xml": headerXml("<w:p><w:r><w:t>b</w:t></w:r></w:p>"),
        "word/Header10.xml": headerXml("<w:p><w:r><w:t>c</w:t></w:r></w:p>"),
      }),
    );
    expect(out.headers).toBe(3);
  });

  it("does not match nested or lookalike paths", async () => {
    const out = await scan(
      await pkg("<w:p/>", {
        "word/media/header1.xml": headerXml("<w:p><w:r><w:t>a</w:t></w:r></w:p>"),
        "word/header1.xml.bak": headerXml("<w:p><w:r><w:t>b</w:t></w:r></w:p>"),
        "header1.xml": headerXml("<w:p><w:r><w:t>c</w:t></w:r></w:p>"),
      }),
    );
    expect(out.headers).toBe(0);
  });

  it("counts an unreadable part as content-bearing (never conflates can't-read with empty)", async () => {
    silenceErrors();
    const out = await scan(await pkg("<w:p/>", { "word/header1.xml": "  not xml" }));
    expect(out.headers).toBe(1);
  });

  it("caps the number of parts it will inflate, and counts the remainder unread", async () => {
    // The one read in the docx path whose COUNT is attacker-controlled. Parts
    // past the cap are still COUNTED, so the resource guard can never hide a loss.
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const many: Record<string, string> = {};
    for (let i = 1; i <= 200; i++) {
      many[`word/header${i}.xml`] = headerXml("<w:p/>"); // EMPTY — would not count if read
    }
    const out = await scan(await pkg("<w:p/>", many));
    // 32 read (empty → not counted) + 168 unread (counted, over-warn).
    expect(out.headers).toBe(168);
    expect(err).toHaveBeenCalledWith(expect.stringContaining("exceeds the 32 cap"));
  });
});

describe("scanDocxLostFeatures — robustness", () => {
  it("degrades to all-zeros on a non-ZIP buffer and never throws", async () => {
    silenceErrors();
    const out = await scan(Buffer.from("this is not a zip archive"));
    expect(out).toEqual({
      revisions: { insertions: 0, deletions: 0, moveTo: 0, moveFrom: 0, formatting: 0 },
      headers: 0,
      footers: 0,
      revisionScanFailed: false,
    });
    expect(lostFeatureLossLines(out)).toEqual([]);
  });

  it("reports nothing for a clean document (no false positives)", async () => {
    const out = await scan(await buildHeadings());
    expect(lostFeatureLossLines(out)).toEqual([]);
  });

  it("reports nothing for Tandem's OWN export (guards verify + scoreboard gen2)", async () => {
    const { exportYDocToDocx } = await import("../../src/server/file-io/docx-export.js");
    const { getAdapter } = await import("../../src/server/file-io/index.js");
    const Y = await import("yjs");
    const doc = new Y.Doc();
    const prepared = await getAdapter("docx").parse(await buildHeadings());
    doc.transact(() => getAdapter("docx").apply(doc, prepared, {}));
    const out = await scan(await exportYDocToDocx(doc));
    expect(lostFeatureLossLines(out)).toEqual([]);
    doc.destroy();
  });
});

describe("lostFeatureLossLines — content contract", () => {
  // Every line this module can emit, as an allowlist of shapes. A future line
  // that interpolates ANYTHING beyond an integer fails here by construction —
  // which is the whole reason these lines may bypass summarizeMammothMessages'
  // redaction and the MAX_WARNING_LINE_LENGTH clamp.
  const ALLOWED: RegExp[] = [
    /^Tandem couldn't check this file for tracked changes — if it has any, they won't be preserved on save$/,
    /^\d+ tracked deletions? (was|were) applied automatically — the deleted text is already missing, and saving drops it from the file$/,
    /^\d+ tracked insertions? (was|were) accepted automatically — saving makes that permanent$/,
    /^\d+ moved passages? \(Word "move" revisions\) (wasn't|weren't) imported — the moved text is missing from this document$/,
    /^\d+ tracked formatting changes? (was|were) applied automatically — the revision record isn't preserved on save$/,
    /^\d+ page headers? \(letterhead, logos, or running titles\) (wasn't|weren't) imported and will be dropped from the file on save$/,
    /^\d+ page footers? \(page numbers or confidentiality notices\) (wasn't|weren't) imported and will be dropped from the file on save$/,
  ];

  it("never leaks a revision author or header text (the privacy invariant)", async () => {
    const out = await scan(
      await pkg(
        `<w:p><w:ins w:id="1" w:author="Alice Q Reviewer" w:date="2020-01-01T00:00:00Z">` +
          `<w:r><w:t>BODY-SECRET</w:t></w:r></w:ins>` +
          `<w:del w:id="2" w:author="Bob T Counsel" w:date="2020-01-01T00:00:00Z">` +
          `<w:r><w:delText>DELETED-SECRET</w:delText></w:r></w:del></w:p>`,
        {
          "word/header1.xml": headerXml("<w:p><w:r><w:t>ACME CONFIDENTIAL FY26</w:t></w:r></w:p>"),
        },
      ),
    );
    const blob = JSON.stringify(lostFeatureLossLines(out));
    for (const secret of [
      "Alice",
      "Bob",
      "Reviewer",
      "Counsel",
      "ACME",
      "CONFIDENTIAL",
      "BODY-SECRET",
      "DELETED-SECRET",
    ]) {
      expect(blob).not.toContain(secret);
    }
  });

  it("emits only allowlisted line shapes — counts and fixed strings, nothing else", async () => {
    const everything: DocxLostFeatures = {
      revisions: { insertions: 2, deletions: 1, moveTo: 3, moveFrom: 3, formatting: 4 },
      headers: 1,
      footers: 5,
      revisionScanFailed: true,
    };
    const lines = lostFeatureLossLines(everything);
    expect(lines).toHaveLength(7);
    for (const line of lines) {
      expect(ALLOWED.some((re) => re.test(line))).toBe(true);
    }
  });

  it("pluralizes every line correctly at 1 and at N", async () => {
    const one = lostFeatureLossLines({
      revisions: { insertions: 1, deletions: 1, moveTo: 1, moveFrom: 1, formatting: 1 },
      headers: 1,
      footers: 1,
      revisionScanFailed: false,
    });
    const many = lostFeatureLossLines({
      revisions: { insertions: 2, deletions: 2, moveTo: 2, moveFrom: 2, formatting: 2 },
      headers: 2,
      footers: 2,
      revisionScanFailed: false,
    });
    for (const line of [...one, ...many]) {
      expect(ALLOWED.some((re) => re.test(line))).toBe(true);
    }
    expect(one.every((l) => !/\d+ \w+s (was|wasn't)/.test(l))).toBe(true);
  });

  it("keeps 'couldn't check' OUT of the structural loss lines", async () => {
    // structuralLossLines drives the save-time overwrite warning, whose copy
    // asserts the backed-up original HAS features this file doesn't. A failed
    // scan is not an existence claim.
    const failed: DocxLostFeatures = {
      revisions: { insertions: 0, deletions: 0, moveTo: 0, moveFrom: 0, formatting: 0 },
      headers: 0,
      footers: 0,
      revisionScanFailed: true,
    };
    expect(structuralLossLines(failed)).toEqual([]);
    // ...but the user is still told the check didn't run.
    expect(lostFeatureLossLines(failed)).toHaveLength(1);
    expect(lostFeatureLossLines(failed)[0]).toContain("couldn't check");
  });

  it("orders lines most-destructive first", async () => {
    const lines = lostFeatureLossLines({
      revisions: { insertions: 1, deletions: 1, moveTo: 1, moveFrom: 1, formatting: 1 },
      headers: 1,
      footers: 1,
      revisionScanFailed: false,
    });
    // A deletion means text is ALREADY missing — it leads.
    expect(lines[0]).toMatch(/tracked deletion/);
    expect(lines[1]).toMatch(/tracked insertion/);
    expect(lines.at(-2)).toMatch(/page header/);
    expect(lines.at(-1)).toMatch(/page footer/);
  });
});
