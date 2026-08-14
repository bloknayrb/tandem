/**
 * A heading never presents as two lines, through any reader (#1448).
 *
 * Since `paragraph` gained `whitespace: "pre"`, a soft-wrapped paragraph
 * promoted to a heading carries a literal newline with it — `setBlockType`
 * changes the node type without re-splitting content by the target type's
 * whitespace spec. That is ordinary editing (toolbar, `Mod-Alt-1`, slash
 * command), not an edge case.
 *
 * There are FOUR independent readers of heading text and fixing one is not
 * fixing the invariant: `yxmlToMdast` (disk), `extractText` (the flat-text
 * coordinate system and `tandem_getTextContent`), `getOutline` (what
 * `tandem_getOutline` hands the AI), and `getSection`. The last two are coupled
 * — the AI reads a name from one and passes it to the other — so a fix applied
 * to only one of THOSE is worse than none.
 */

import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { saveMarkdown } from "../../src/server/file-io/markdown.js";
import { getOutline, getSection } from "../../src/server/mcp/document.js";
import { extractText, getElementTextLength } from "../../src/server/mcp/document-model.js";

/** A document whose h2 holds a literal newline, plus a body paragraph. */
function docWithWrappedHeading(): Y.Doc {
  const doc = new Y.Doc();
  const fragment = doc.getXmlFragment("default");

  const heading = new Y.XmlElement("heading");
  heading.setAttribute("level", 2 as never);
  const body = new Y.XmlElement("paragraph");
  // Attach before populating — a detached Y.XmlText reverses segment order.
  fragment.insert(0, [heading, body]);

  const headingText = new Y.XmlText();
  heading.insert(0, [headingText]);
  headingText.insert(0, "first line\nsecond line");

  const bodyText = new Y.XmlText();
  body.insert(0, [bodyText]);
  bodyText.insert(0, "Section body.");

  return doc;
}

describe("every reader flattens a heading's newline", () => {
  it("the disk writer emits a single-line ATX heading", () => {
    const doc = docWithWrappedHeading();
    expect(saveMarkdown(doc)).toBe("## first line second line\n\nSection body.\n");
    doc.destroy();
  });

  it("extractText emits one line for the heading", () => {
    const doc = docWithWrappedHeading();
    const flat = extractText(doc);
    expect(flat.split("\n")[0]).toBe("## first line second line");
    doc.destroy();
  });

  it("getOutline hands the AI a single-line entry", () => {
    const doc = docWithWrappedHeading();
    expect(getOutline(doc.getXmlFragment("default"))).toEqual([
      { level: 2, text: "first line second line", index: 0 },
    ]);
    doc.destroy();
  });

  it("getSection finds the heading by the name getOutline reported", () => {
    // The coupling that matters: the AI reads a name from getOutline and passes
    // it straight to getSection. Flattening one and not the other would list a
    // section under a name that matches nothing.
    const doc = docWithWrappedHeading();
    const fragment = doc.getXmlFragment("default");
    const name = getOutline(fragment)[0].text;

    const section = getSection(fragment, name);
    expect(section.found).toBe(true);
    expect(section).toMatchObject({ text: "## first line second line\nSection body." });
    doc.destroy();
  });
});

describe("the other two ways a heading gets a line break", () => {
  // `formatHeadingAsSetext` fires on `node.type === "break"` OR on any node
  // whose `.value` holds a newline. Covering the literal-newline `text` case
  // alone left both of these emitting setext, which is the same corruption by a
  // different door: what lands on disk is a two-line heading, and every reader
  // then reports it as one line, so the file and the model disagree silently.

  it("an explicit hard break in a heading does not emit setext", () => {
    const doc = new Y.Doc();
    const fragment = doc.getXmlFragment("default");
    const heading = new Y.XmlElement("heading");
    heading.setAttribute("level", 1 as never);
    fragment.insert(0, [heading]);

    const first = new Y.XmlText();
    heading.insert(0, [first]);
    first.insert(0, "first line");
    heading.insert(1, [new Y.XmlElement("hardBreak")]);
    const second = new Y.XmlText();
    heading.insert(2, [second]);
    second.insert(0, "second line");

    expect(saveMarkdown(doc)).toBe("# first line second line\n");
    // And the disk form agrees with what every reader reports.
    expect(extractText(doc).split("\n")[0]).toBe("# first line second line");
    doc.destroy();
  });

  it("a code span holding a newline does not emit setext", () => {
    const doc = new Y.Doc();
    const fragment = doc.getXmlFragment("default");
    const heading = new Y.XmlElement("heading");
    heading.setAttribute("level", 2 as never);
    fragment.insert(0, [heading]);
    const text = new Y.XmlText();
    heading.insert(0, [text]);
    text.insert(0, "code\nspan", { code: {} });

    expect(saveMarkdown(doc)).toBe("## `code span`\n");
    doc.destroy();
  });
});

describe("flattening does not move any offset", () => {
  it("extractText's heading line is the same length as the raw text plus its prefix", () => {
    // extractText is the annotation coordinate system, and getElementTextLength
    // counts the RAW Y.XmlText. A flattening that changed the character count —
    // a trim, or collapsing runs — would desync every annotation after the
    // heading. Newline -> single space is 1:1; this is what pins that.
    const doc = docWithWrappedHeading();
    const heading = doc.getXmlFragment("default").get(0) as Y.XmlElement;

    const rawLength = getElementTextLength(heading);
    const headingLine = extractText(doc).split("\n")[0];
    expect(headingLine.length).toBe(rawLength + "## ".length);
    doc.destroy();
  });

  it("a CRLF becomes two spaces, not one", () => {
    const doc = new Y.Doc();
    const fragment = doc.getXmlFragment("default");
    const heading = new Y.XmlElement("heading");
    heading.setAttribute("level", 1 as never);
    fragment.insert(0, [heading]);
    const text = new Y.XmlText();
    heading.insert(0, [text]);
    text.insert(0, "first\r\nsecond");

    expect(extractText(doc).split("\n")[0]).toBe("# first  second");
    doc.destroy();
  });
});
