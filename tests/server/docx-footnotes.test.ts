/**
 * Footnote/endnote DETECTION (import honesty layer, #1123 Tier-A #3 PR 1).
 *
 * The load-bearing risk is a FALSE POSITIVE: Word (and the docx package) embed
 * structural separator notes in word/footnotes.xml / word/endnotes.xml for EVERY
 * document, so a naive "the part exists / has any <w:footnote>" check would warn
 * "footnotes flattened" on literally every .docx — trust-destroying. These tests
 * gate the separator-exclusion filter from both real docx-package output and an
 * isolated separators-only fixture, and pin endnotes POSITIVELY so a copy-paste
 * bug reading footnotes.xml for the endnote count can't pass silently.
 */

import JSZip from "jszip";
import { describe, expect, it } from "vitest";
import { detectDocxFootnotes, footnoteLossLines } from "../../src/server/file-io/docx-footnotes.js";
import { buildEndnote, buildFootnote, buildHeadings } from "../helpers/docx-corpus.js";

const WML = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";

/** Minimal .docx-shaped zip carrying only the named parts. detectDocxFootnotes
 * reads word/footnotes.xml / word/endnotes.xml directly (no rels/content-types
 * traversal), so a bare zip with just those parts exercises the real path. */
async function zipWith(files: Record<string, string>): Promise<Buffer> {
  const zip = new JSZip();
  for (const [p, c] of Object.entries(files)) zip.file(p, c);
  return (await zip.generateAsync({ type: "nodebuffer" })) as Buffer;
}

/** word/footnotes.xml with the two structural separators Word always emits, plus
 * whatever `realNotes` markup is appended. */
const footnotesXml = (realNotes = ""): string =>
  `<?xml version="1.0"?><w:footnotes xmlns:w="${WML}">` +
  `<w:footnote w:type="separator" w:id="-1"><w:p/></w:footnote>` +
  `<w:footnote w:type="continuationSeparator" w:id="0"><w:p/></w:footnote>` +
  `${realNotes}</w:footnotes>`;

const realFootnote = (id: number, body: string): string =>
  `<w:footnote w:id="${id}"><w:p><w:r><w:t>${body}</w:t></w:r></w:p></w:footnote>`;

describe("detectDocxFootnotes", () => {
  it("counts a real footnote from docx-package output (separators excluded)", async () => {
    expect(await detectDocxFootnotes(await buildFootnote())).toEqual({ footnotes: 1, endnotes: 0 });
  });

  it("counts a real endnote and does NOT mistake it for a footnote", async () => {
    // Guards the copy-paste hazard: a detector reading footnotes.xml for the
    // endnote count would report {footnotes:1} or {endnotes:0} here.
    expect(await detectDocxFootnotes(await buildEndnote())).toEqual({ footnotes: 0, endnotes: 1 });
  });

  it("reports 0 for a real docx whose notes parts hold ONLY separators", async () => {
    // buildHeadings has no footnotes, but the docx package still ships
    // footnotes.xml + endnotes.xml with the two separators — the exact
    // false-positive case, from real library output.
    expect(await detectDocxFootnotes(await buildHeadings())).toEqual({ footnotes: 0, endnotes: 0 });
  });

  it("reports 0 for an isolated separators-only footnotes.xml", async () => {
    const buf = await zipWith({ "word/footnotes.xml": footnotesXml() });
    expect(await detectDocxFootnotes(buf)).toEqual({ footnotes: 0, endnotes: 0 });
  });

  it("counts multiple real footnotes alongside the separators", async () => {
    const buf = await zipWith({
      "word/footnotes.xml": footnotesXml(realFootnote(1, "One") + realFootnote(2, "Two")),
    });
    expect(await detectDocxFootnotes(buf)).toEqual({ footnotes: 2, endnotes: 0 });
  });

  it("treats an unknown w:type as a real note (over-warn, not silent miss)", async () => {
    // Deliberate fail-honest bias: a non-structural/unknown type counts as real.
    const buf = await zipWith({
      "word/footnotes.xml": footnotesXml(
        `<w:footnote w:type="normal" w:id="1"><w:p/></w:footnote>`,
      ),
    });
    expect((await detectDocxFootnotes(buf)).footnotes).toBe(1);
  });

  it("degrades to {0,0} on a non-ZIP buffer without throwing", async () => {
    await expect(detectDocxFootnotes(Buffer.from("not a zip at all"))).resolves.toEqual({
      footnotes: 0,
      endnotes: 0,
    });
  });
});

describe("footnoteLossLines", () => {
  it("returns no lines when there are no real notes", () => {
    expect(footnoteLossLines({ footnotes: 0, endnotes: 0 })).toEqual([]);
  });

  it("emits a singular footnote line carrying the count but NO user content", () => {
    const lines = footnoteLossLines({ footnotes: 1, endnotes: 0 });
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/footnote/i);
    expect(lines[0]).toContain("1 footnote");
    // Privacy-by-construction: the line is built from a count, never from the
    // footnote body, so document text can't leak into the persistent report.
    expect(lines[0]).not.toContain("body");
  });

  it("emits plural footnote + endnote lines for mixed notes", () => {
    const lines = footnoteLossLines({ footnotes: 3, endnotes: 2 });
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain("3 footnotes");
    expect(lines[1]).toContain("2 endnotes");
  });

  it("never echoes real footnote body text (end-to-end privacy guard)", async () => {
    const summary = await detectDocxFootnotes(await buildFootnote());
    const joined = footnoteLossLines(summary).join(" ");
    expect(joined).not.toContain("The footnote body text.");
  });
});
