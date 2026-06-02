import { Schema } from "@tiptap/pm/model";
import { describe, expect, it } from "vitest";
import { buildPlainTextSlice } from "../../src/client/editor/utils/plain-paste";

// Minimal real schema so the slice builder exercises actual ProseMirror nodes.
const schema = new Schema({
  nodes: {
    doc: { content: "paragraph+" },
    paragraph: { content: "text*", toDOM: () => ["p", 0] },
    text: {},
  },
});

describe("buildPlainTextSlice", () => {
  it("splits blank-line groups into separate paragraphs", () => {
    const slice = buildPlainTextSlice("one\n\ntwo\n\n\nthree", schema, []);
    const paras: string[] = [];
    slice.content.forEach((node) => paras.push(node.textContent));
    expect(paras).toEqual(["one", "two", "three"]);
  });

  it("treats single newlines as paragraph breaks too (matches PM plain paste)", () => {
    const slice = buildPlainTextSlice("a\nb", schema, []);
    expect(slice.content.childCount).toBe(2);
  });

  it("produces an empty paragraph for empty input without throwing", () => {
    const slice = buildPlainTextSlice("", schema, []);
    expect(slice.content.childCount).toBe(1);
    expect(slice.content.firstChild?.textContent).toBe("");
  });
});
