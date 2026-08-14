/**
 * Whitespace escaping under `whitespace: "pre"` paragraphs (#1448).
 *
 * Declaring `whitespace: "pre"` on the paragraph node keeps soft wraps as
 * literal newlines instead of hard breaks. The obvious objection is that it
 * reintroduces the very bug it fixes by a different route, because in markdown
 * two trailing spaces before a newline ARE a hard break and four leading spaces
 * ARE an indented code block. Preserved whitespace would then change meaning.
 *
 * It does not happen: `remark-stringify`'s `safe()` escapes both to `&#x20;`
 * before they can be re-parsed as syntax. These tests pin that, because the
 * guarantee lives in a dependency rather than in our code — an upgrade could
 * remove it, and the failure would be silent corruption of user documents
 * rather than an error.
 *
 * They also pin idempotency, since an escape that is not a fixed point would
 * grow entities on every save.
 */

import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { loadMarkdown, saveMarkdown } from "../../../src/server/file-io/markdown.js";

function roundTrip(input: string): string {
  const doc = new Y.Doc();
  try {
    loadMarkdown(doc, input);
    return saveMarkdown(doc);
  } finally {
    doc.destroy();
  }
}

/**
 * Build a paragraph holding exactly `text` as one run, bypassing the markdown
 * parser. The parser would strip the whitespace we are testing before it ever
 * reached the serializer, so parsing the input first would test nothing.
 */
function serializeParagraphText(text: string): string {
  const doc = new Y.Doc();
  try {
    const fragment = doc.getXmlFragment("default");
    const para = new Y.XmlElement("paragraph");
    // Attach before populating — inserting into a detached Y.XmlText reverses
    // segment order.
    fragment.insert(0, [para]);
    const content = new Y.XmlText();
    para.insert(0, [content]);
    content.insert(0, text);
    return saveMarkdown(doc);
  } finally {
    doc.destroy();
  }
}

describe("preserved whitespace cannot become markdown syntax", () => {
  it("trailing spaces before a newline do not become a hard break", () => {
    const out = serializeParagraphText("first line  \nsecond line");
    expect(out).not.toMatch(/ {2}\n/);
    expect(out).toContain("&#x20;");
    // The line break itself survives as a soft wrap, which is the whole point.
    expect(out).toContain("\nsecond line");
  });

  it("leading spaces after a newline do not become an indented code block", () => {
    const out = serializeParagraphText("first line\n    second line");
    expect(out).toContain("&#x20;");
    // Re-reading it must still be one paragraph, not a paragraph plus code.
    const doc = new Y.Doc();
    loadMarkdown(doc, out);
    expect(saveMarkdown(doc)).toBe(out);
    doc.destroy();
  });

  it("a tab after a newline does not become an indented code block", () => {
    const out = serializeParagraphText("first line\n\tsecond line");
    expect(roundTrip(out)).toBe(out);
  });

  it("the escaping is a fixed point, so saves do not accumulate entities", () => {
    // Without this, each save would escape the previous save's output again and
    // the file would grow on every edit.
    const once = serializeParagraphText("first line  \n    second line");
    expect(roundTrip(once)).toBe(once);
    expect(roundTrip(roundTrip(once))).toBe(once);
  });
});

describe("ordinary soft wraps stay ordinary", () => {
  const WRAPPED =
    "At work I kept asking Claude to draft a report for me. I had it write into\na scratch file in my vault, and it updated the instant Claude touched it.\n";

  it("a plain soft wrap round-trips with no escaping at all", () => {
    const out = roundTrip(WRAPPED);
    expect(out).toBe(WRAPPED);
    expect(out).not.toContain("&#x20;");
    expect(out).not.toContain("\\\n");
  });
});
