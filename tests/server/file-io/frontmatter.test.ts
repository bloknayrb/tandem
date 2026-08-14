/**
 * YAML/TOML frontmatter round-trip (#1457).
 *
 * Before `remark-frontmatter` was wired in, CommonMark rules applied to a
 * frontmatter block and destroyed it: the opening `---` is a thematic break and
 * the closing `---` a setext underline for the line above. The block survived
 * as text but stopped being frontmatter, which for an Obsidian vault means every
 * note's tags, aliases and dates stop existing as metadata while the note still
 * looks roughly right.
 *
 * The regression these tests exist to catch is subtler than "frontmatter
 * broke": it is the block silently ceasing to be *frontmatter* while its bytes
 * still round-trip, or the two halves of the pipeline being configured with
 * different flavour lists.
 */

import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { loadMarkdown, mdParser, saveMarkdown } from "../../../src/server/file-io/markdown.js";

function roundTrip(input: string): string {
  const doc = new Y.Doc();
  try {
    loadMarkdown(doc, input);
    return saveMarkdown(doc);
  } finally {
    doc.destroy();
  }
}

const YAML = "---\ntitle: My Note\ntags: [a, b]\n---\n\nBody text.\n";

describe("frontmatter survives a round trip", () => {
  it("a YAML block comes back byte-identical", () => {
    expect(roundTrip(YAML)).toBe(YAML);
  });

  it("and is still parsed AS frontmatter, not as prose that looks like it", () => {
    // The assertion that matters. Byte-identity alone would also hold for a
    // block that had degenerated into a thematic break plus a setext heading,
    // since that shape is a stable fixed point once reached.
    const tree = mdParser.parse(roundTrip(YAML));
    expect(tree.children[0]).toMatchObject({ type: "yaml" });
    expect(tree.children[0]).not.toMatchObject({ type: "thematicBreak" });
  });

  it("the old failure mode is gone", () => {
    const out = roundTrip(YAML);
    expect(out).not.toContain("------");
    expect(out).not.toMatch(/^---\n\n/);
  });

  it("a TOML block round-trips too", () => {
    // The stringifier must be given the same flavour list as the parser. If
    // only the parser knew `toml`, this would parse and then fail to serialize.
    const toml = '+++\ntitle = "My Note"\n+++\n\nBody text.\n';
    expect(roundTrip(toml)).toBe(toml);
    expect(mdParser.parse(roundTrip(toml)).children[0]).toMatchObject({ type: "toml" });
  });

  it("an empty frontmatter block survives", () => {
    const empty = "---\n---\n\nBody.\n";
    expect(roundTrip(empty)).toBe(empty);
  });

  it("frontmatter containing a line of dashes is not confused for the fence", () => {
    const tricky = "---\ntitle: A\nrule: ---\n---\n\nBody.\n";
    expect(roundTrip(tricky)).toBe(tricky);
  });

  it("survives a second pass unchanged", () => {
    expect(roundTrip(roundTrip(YAML))).toBe(YAML);
  });
});

describe("a `---` that is NOT frontmatter still behaves as a thematic break", () => {
  it("mid-document dashes stay a thematic break", () => {
    // Frontmatter is position-sensitive: only a block at the very start counts.
    // If the plugin were misconfigured to match anywhere, this document's rule
    // would be silently swallowed into a metadata block.
    const withRule = "Intro paragraph.\n\n---\n\nAfter the rule.\n";
    const tree = mdParser.parse(roundTrip(withRule));
    expect(tree.children.some((n) => n.type === "thematicBreak")).toBe(true);
    expect(tree.children.some((n) => n.type === "yaml")).toBe(false);
  });
});

describe("frontmatter is carried as a raw block, not as prose", () => {
  it("is stored with both the raw and frontmatter markers", () => {
    // `markdownRaw` is what makes it serialize verbatim; the frontmatter marker
    // is what lets the client present it as metadata instead of body text.
    // Losing the first corrupts the file; losing the second only looks wrong.
    const doc = new Y.Doc();
    loadMarkdown(doc, YAML);
    const first = doc.getXmlFragment("default").get(0) as Y.XmlElement;

    expect(first.nodeName).toBe("paragraph");
    expect(first.getAttribute("markdownRaw")).toBeTruthy();
    expect(first.getAttribute("markdownFrontmatter")).toBeTruthy();
    doc.destroy();
  });

  it("keeps its fences in the stored source", () => {
    // The `default:` branch of the mdast->Y mapping would match a yaml node
    // (it has a `.value`) and store the body WITHOUT the fences. That reads as
    // working — the text is all there — and silently stops it being frontmatter.
    const doc = new Y.Doc();
    loadMarkdown(doc, YAML);
    const first = doc.getXmlFragment("default").get(0) as Y.XmlElement;
    const stored = first.toString();

    expect(stored).toContain("---");
    expect(stored).toContain("title: My Note");
    doc.destroy();
  });

  it("an ordinary raw block does NOT get the frontmatter marker", () => {
    const doc = new Y.Doc();
    loadMarkdown(doc, "[spec]: https://example.com\n");
    const first = doc.getXmlFragment("default").get(0) as Y.XmlElement;

    expect(first.getAttribute("markdownRaw")).toBeTruthy();
    expect(first.getAttribute("markdownFrontmatter")).toBeFalsy();
    doc.destroy();
  });
});
