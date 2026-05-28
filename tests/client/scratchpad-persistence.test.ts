import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import {
  extractFragmentText,
  scratchpadStorageKey,
} from "../../src/client/hooks/useScratchpadPersistence.svelte";

/** Build a Y.Doc whose "default" fragment holds the given paragraph lines. */
function docWithParagraphs(lines: string[]): Y.Doc {
  const doc = new Y.Doc();
  const fragment = doc.getXmlFragment("default");
  const paragraphs = lines.map((line) => {
    const p = new Y.XmlElement("paragraph");
    if (line.length > 0) p.insert(0, [new Y.XmlText(line)]);
    return p;
  });
  doc.transact(() => fragment.insert(0, paragraphs));
  return doc;
}

describe("scratchpadStorageKey", () => {
  it("namespaces by uuid so distinct scratchpads never collide", () => {
    expect(scratchpadStorageKey("uuid-a")).toBe("tandem:scratchpad:uuid-a");
    expect(scratchpadStorageKey("uuid-a")).not.toBe(scratchpadStorageKey("uuid-b"));
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
    doc.transact(() => fragment.insert(0, [list]));
    expect(extractFragmentText(fragment)).toBe("item text");
  });
});
