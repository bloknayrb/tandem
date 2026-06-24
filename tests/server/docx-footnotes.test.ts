/**
 * Footnote/endnote CAPTURE (#1123 Tier-A #3). `parseDocxFootnotes` reads the
 * real notes from the .docx ZIP, returning footnote BODIES (keyed by OOXML id,
 * PR 2 reconstruction) + the endnote count (still degrades, PR 1 honesty).
 *
 * The load-bearing risk is a FALSE POSITIVE: Word (and the docx package) embed
 * structural separator notes in word/footnotes.xml / word/endnotes.xml for EVERY
 * document, so a naive "the part exists / has any <w:footnote>" check would treat
 * literally every .docx as having footnotes — trust-destroying. These tests gate
 * the separator-exclusion filter from both real docx-package output and an
 * isolated separators-only fixture, and pin endnotes POSITIVELY so a copy-paste
 * bug reading footnotes.xml for the endnote count can't pass silently.
 */

import JSZip from "jszip";
import { describe, expect, it } from "vitest";
import { footnoteLossLines, parseDocxFootnotes } from "../../src/server/file-io/docx-footnotes.js";
import { reconcileFootnoteIds } from "../../src/server/file-io/docx-html.js";
import type { FootnoteBody } from "../../src/shared/types.js";
import { buildEndnote, buildFootnote, buildHeadings } from "../helpers/docx-corpus.js";

const WML = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";

/** Minimal .docx-shaped zip carrying only the named parts. parseDocxFootnotes
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

/** Build a FootnoteBody map the way `footnoteLossLines` consumes it. */
const bodies = (entries: Array<[string, boolean]>): Record<string, FootnoteBody> =>
  Object.fromEntries(
    entries.map(([id, hadFormatting]) => [id, { text: `body-${id}`, hadFormatting }]),
  );

describe("parseDocxFootnotes", () => {
  it("captures a real footnote body from docx-package output (separators excluded)", async () => {
    const notes = await parseDocxFootnotes(await buildFootnote());
    expect(Object.keys(notes.footnotes)).toEqual(["1"]);
    expect(notes.footnotes["1"].text).toBe("The footnote body text.");
    expect(notes.footnotes["1"].hadFormatting).toBe(false);
    expect(notes.endnotes).toBe(0);
  });

  it("counts a real endnote and does NOT mistake it for a footnote", async () => {
    // Guards the copy-paste hazard: a parser reading footnotes.xml for the
    // endnote count would report a footnote body or endnotes:0 here.
    const notes = await parseDocxFootnotes(await buildEndnote());
    expect(notes.footnotes).toEqual({});
    expect(notes.endnotes).toBe(1);
  });

  it("reports nothing for a real docx whose notes parts hold ONLY separators", async () => {
    // buildHeadings has no footnotes, but the docx package still ships
    // footnotes.xml + endnotes.xml with the two separators — the exact
    // false-positive case, from real library output.
    const notes = await parseDocxFootnotes(await buildHeadings());
    expect(notes.footnotes).toEqual({});
    expect(notes.endnotes).toBe(0);
  });

  it("reports nothing for an isolated separators-only footnotes.xml", async () => {
    const notes = await parseDocxFootnotes(await zipWith({ "word/footnotes.xml": footnotesXml() }));
    expect(notes.footnotes).toEqual({});
  });

  it("captures multiple real footnotes keyed by id, alongside the separators", async () => {
    const buf = await zipWith({
      "word/footnotes.xml": footnotesXml(realFootnote(1, "One") + realFootnote(2, "Two")),
    });
    const notes = await parseDocxFootnotes(buf);
    expect(Object.keys(notes.footnotes).sort()).toEqual(["1", "2"]);
    expect(notes.footnotes["1"].text).toBe("One");
    expect(notes.footnotes["2"].text).toBe("Two");
  });

  it("treats an unknown w:type as a real note (over-warn, not silent miss)", async () => {
    const buf = await zipWith({
      "word/footnotes.xml": footnotesXml(
        `<w:footnote w:type="normal" w:id="1"><w:p/></w:footnote>`,
      ),
    });
    expect(Object.keys((await parseDocxFootnotes(buf)).footnotes)).toEqual(["1"]);
  });

  it("flags hadFormatting for a bold body and a multi-paragraph body", async () => {
    const bold = `<w:footnote w:id="1"><w:p><w:r><w:rPr><w:b/></w:rPr><w:t>strong</w:t></w:r></w:p></w:footnote>`;
    const multiPara = `<w:footnote w:id="2"><w:p><w:r><w:t>one</w:t></w:r></w:p><w:p><w:r><w:t>two</w:t></w:r></w:p></w:footnote>`;
    const plain = realFootnote(3, "plain");
    const notes = await parseDocxFootnotes(
      await zipWith({ "word/footnotes.xml": footnotesXml(bold + multiPara + plain) }),
    );
    expect(notes.footnotes["1"].hadFormatting).toBe(true); // <w:b>
    expect(notes.footnotes["2"].hadFormatting).toBe(true); // >1 <w:p>
    expect(notes.footnotes["3"].hadFormatting).toBe(false);
  });

  it("degrades to empty on a non-ZIP buffer without throwing", async () => {
    await expect(parseDocxFootnotes(Buffer.from("not a zip at all"))).resolves.toEqual({
      footnotes: {},
      endnotes: 0,
    });
  });
});

/** A reconciliation partition (from `reconcileFootnoteIds`). */
const recon = (reconstructed: string[], dropped: string[] = []) => ({ reconstructed, dropped });

describe("footnoteLossLines", () => {
  it("returns no lines when there are no notes", () => {
    expect(footnoteLossLines({ footnotes: {}, endnotes: 0 }, recon([]))).toEqual([]);
  });

  it("emits NO footnote line when a footnote reconstructs with a plain body (HIGH-2)", () => {
    // Post-PR-2: a plain-bodied footnote that reconstructs has no loss to report —
    // the PR-1 "markers and links aren't preserved" line is now false.
    expect(
      footnoteLossLines({ footnotes: bodies([["1", false]]), endnotes: 0 }, recon(["1"])),
    ).toEqual([]);
  });

  it("emits a count-only body-formatting line for a reconstructed footnote whose body had formatting", () => {
    const lines = footnoteLossLines(
      {
        footnotes: bodies([
          ["1", true],
          ["2", false],
        ]),
        endnotes: 0,
      },
      recon(["1", "2"]),
    );
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("1 footnote");
    expect(lines[0]).toMatch(/plain text/i);
    // Privacy-by-construction: built from a count + flag, never the body text.
    expect(lines[0]).not.toContain("body-1");
  });

  it("emits a STRUCTURAL loss line for a captured footnote that did NOT reconstruct (honesty fix)", () => {
    // An orphaned footnote definition (or a mammoth-format drift) is captured but
    // fails reconciliation — it must be reported as a loss, not silently claimed
    // preserved. No body text in the line (privacy).
    const lines = footnoteLossLines(
      { footnotes: bodies([["1", false]]), endnotes: 0 },
      recon([], ["1"]),
    );
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("1 footnote");
    expect(lines[0]).toMatch(/couldn't be reconstructed/i);
    expect(lines[0]).not.toContain("body-1");
  });

  it("still reports endnotes (which degrade to a list) alongside a footnote loss", () => {
    const lines = footnoteLossLines(
      {
        footnotes: bodies([
          ["1", true],
          ["2", true],
        ]),
        endnotes: 3,
      },
      recon(["1", "2"]),
    );
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain("2 footnotes");
    expect(lines[1]).toContain("3 endnotes");
  });

  it("never echoes real footnote body text (end-to-end privacy guard)", async () => {
    const notes = await parseDocxFootnotes(await buildFootnote());
    const joined = footnoteLossLines(notes, recon(["1"])).join(" ");
    expect(joined).not.toContain("The footnote body text.");
  });
});

describe("reconcileFootnoteIds", () => {
  const FN_INLINE = '<p>A<sup><a href="#footnote-1" id="footnote-ref-1">[1]</a></sup>.</p>';
  const FN_LIST = '<ol><li id="footnote-1"><p>Body. <a href="#footnote-ref-1">↑</a></p></li></ol>';

  it("reconstructs a footnote present as both inline ref AND trailing list item", () => {
    expect(reconcileFootnoteIds(FN_INLINE + FN_LIST, bodies([["1", false]]))).toEqual({
      reconstructed: ["1"],
      dropped: [],
    });
  });

  it("drops an ORPHANED footnote — captured body but no inline ref / list item", () => {
    // The under-reporting trigger the silent-failure review caught: a footnote
    // defined in footnotes.xml but never referenced in the body. mammoth renders
    // no [N] and no <li>, so reconciliation must drop it (→ honest loss line).
    expect(reconcileFootnoteIds("<p>no footnotes here</p>", bodies([["1", false]]))).toEqual({
      reconstructed: [],
      dropped: ["1"],
    });
  });

  it("drops a half-state — inline ref present but no trailing list item", () => {
    expect(reconcileFootnoteIds(FN_INLINE, bodies([["1", false]]))).toEqual({
      reconstructed: [],
      dropped: ["1"],
    });
  });

  it("partitions a mix of reconstructable and dropped ids", () => {
    const html =
      '<p>A<sup><a href="#footnote-1" id="footnote-ref-1">[1]</a></sup>.</p>' +
      '<ol><li id="footnote-1"><p>One <a href="#footnote-ref-1">↑</a></p></li></ol>';
    // id 1 has ref+list+body → reconstructed; id 2 has a body but no ref/list → dropped.
    expect(
      reconcileFootnoteIds(
        html,
        bodies([
          ["1", false],
          ["2", false],
        ]),
      ),
    ).toEqual({
      reconstructed: ["1"],
      dropped: ["2"],
    });
  });

  it("returns empty for no captured bodies (the common no-footnote doc)", () => {
    expect(reconcileFootnoteIds("<p>plain</p>", {})).toEqual({ reconstructed: [], dropped: [] });
  });
});
