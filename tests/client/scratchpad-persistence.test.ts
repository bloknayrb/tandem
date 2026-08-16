import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import {
  decodeScratchpadBlocks,
  encodeScratchpadBlocks,
  extractFragmentBlocks,
  extractFragmentText,
  scratchpadStorageKey,
} from "../../src/client/hooks/useScratchpadPersistence.svelte";

/** Build a Y.Doc whose "default" XmlFragment holds the given paragraph lines. */
function docWithParagraphs(lines: string[]): Y.Doc {
  const doc = new Y.Doc();
  const fragment = doc.getXmlFragment("default");
  const paragraphs = lines.map((line) => {
    const p = new Y.XmlElement("paragraph");
    if (line.length > 0) p.insert(0, [new Y.XmlText(line)]);
    return p;
  });
  fragment.insert(0, paragraphs);
  return doc;
}

describe("scratchpadStorageKey", () => {
  it("namespaces by uuid so distinct scratchpads never collide", () => {
    expect(scratchpadStorageKey("inst1", "uuid-a")).toBe("tandem:scratchpad:inst1:uuid-a");
    expect(scratchpadStorageKey("inst1", "uuid-a")).not.toBe(
      scratchpadStorageKey("inst1", "uuid-b"),
    );
  });

  it("namespaces by install so two servers never read each other's recovery (#1387)", () => {
    // The whole fix in one assertion. Every Tandem server on a machine shares
    // one browser origin, so without this segment a scratchpad opened on any
    // server can restore content persisted while talking to another one.
    expect(scratchpadStorageKey("inst1", "uuid-a")).not.toBe(
      scratchpadStorageKey("inst2", "uuid-a"),
    );
  });

  it("keeps the `tandem:scratchpad:` prefix that the E2E cleanup matches on", () => {
    // The E2E cleanups clear recovery with a prefix match. If the install
    // segment were prepended instead of inserted, that cleanup would silently
    // stop matching and the suite would leak state between tests.
    expect(scratchpadStorageKey("inst1", "uuid-a").startsWith("tandem:scratchpad:")).toBe(true);
  });
});

describe("extractFragmentText", () => {
  it("returns empty string for an empty fragment", () => {
    const doc = new Y.Doc();
    expect(extractFragmentText(doc.getXmlFragment("default"))).toBe("");
  });

  it("joins top-level blocks with newlines", () => {
    const doc = docWithParagraphs(["first line", "second line"]);
    expect(extractFragmentText(doc.getXmlFragment("default"))).toBe("first line\nsecond line");
  });

  it("trims trailing blank blocks", () => {
    const doc = docWithParagraphs(["content", "", ""]);
    expect(extractFragmentText(doc.getXmlFragment("default"))).toBe("content");
  });

  it("flattens nested block children (e.g. list items)", () => {
    const doc = new Y.Doc();
    const fragment = doc.getXmlFragment("default");
    const list = new Y.XmlElement("bulletList");
    const item = new Y.XmlElement("listItem");
    const para = new Y.XmlElement("paragraph");
    para.insert(0, [new Y.XmlText("item text")]);
    item.insert(0, [para]);
    list.insert(0, [item]);
    fragment.insert(0, [list]);
    expect(extractFragmentText(fragment)).toBe("item text");
  });
});

describe("the persisted form survives a paragraph that holds its own newline", () => {
  // Since #1448 a paragraph's text can contain a literal newline — that is what
  // keeps a soft wrap a soft wrap. The persisted form used `\n` as the BLOCK
  // separator too, so restore could not tell the two apart and crash recovery
  // came back with one paragraph per wrapped line: the recovery path silently
  // reformatting the content it exists to preserve.

  it("round-trips a soft-wrapped paragraph as ONE block", () => {
    const doc = docWithParagraphs(["first line\nsecond line", "another paragraph"]);
    const blocks = extractFragmentBlocks(doc.getXmlFragment("default"));
    expect(blocks).toEqual(["first line\nsecond line", "another paragraph"]);
    expect(decodeScratchpadBlocks(encodeScratchpadBlocks(blocks))).toEqual(blocks);
  });

  it("reads a pre-#1448 newline-delimited value rather than discarding it", () => {
    // An upgrade must not be the thing that loses a user's unsaved text. The old
    // form cannot represent an intra-block newline, so splitting it is the
    // correct reading of it.
    expect(decodeScratchpadBlocks("first\nsecond")).toEqual(["first", "second"]);
  });

  it("reads a legacy value that merely STARTS with a bracket as legacy text", () => {
    expect(decodeScratchpadBlocks("[draft] notes\nmore")).toEqual(["[draft] notes", "more"]);
  });

  it("keeps extractFragmentText as the plain-text view for the emptiness check", () => {
    const doc = docWithParagraphs(["a", "b"]);
    expect(extractFragmentText(doc.getXmlFragment("default"))).toBe("a\nb");
  });
});
