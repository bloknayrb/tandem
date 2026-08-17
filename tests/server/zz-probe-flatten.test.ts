import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { flattenPlaintextBreaks } from "../../src/server/file-io/plaintext-flatten.js";
import { extractText } from "../../src/server/mcp/document-model.js";

function mk(build: (f: Y.XmlFragment, d: Y.Doc) => void) {
  const doc = new Y.Doc();
  const f = doc.getXmlFragment("default");
  build(f, doc);
  return doc;
}
function el(name: string, attrs?: Record<string, unknown>) {
  const e = new Y.XmlElement(name);
  for (const [k, v] of Object.entries(attrs ?? {})) e.setAttribute(k, v as never);
  return e;
}

describe("probe", () => {
  it("h2 with hardBreak keeps its level", () => {
    const doc = mk((f) => {
      const h = el("heading", { level: 2 });
      f.insert(0, [h]);
      const t = new Y.XmlText();
      h.insert(0, [t]);
      t.insert(0, "one");
      t.insertEmbed(3, new Y.XmlElement("hardBreak"));
      t.insert(4, "two");
    });
    const before = extractText(doc);
    flattenPlaintextBreaks(doc);
    const after = extractText(doc);
    console.log("HEADING BEFORE", JSON.stringify(before), "AFTER", JSON.stringify(after));
    console.log(
      "attrs:",
      JSON.stringify((doc.getXmlFragment("default").get(0) as Y.XmlElement).getAttributes()),
    );
    expect(after).toBe(before);
  });

  it("paragraph attributes survive", () => {
    const doc = mk((f) => {
      const p = el("paragraph", { textAlign: "center" });
      f.insert(0, [p]);
      const t = new Y.XmlText();
      p.insert(0, [t]);
      t.insert(0, "a\nb");
    });
    flattenPlaintextBreaks(doc);
    const f = doc.getXmlFragment("default");
    console.log(
      "PARA attrs after:",
      JSON.stringify((f.get(0) as Y.XmlElement).getAttributes()),
      "count",
      f.length,
    );
  });

  it("sibling hardBreak element", () => {
    const doc = mk((f) => {
      const p = el("paragraph");
      f.insert(0, [p]);
      const t1 = new Y.XmlText();
      p.insert(0, [t1]);
      t1.insert(0, "a");
      p.insert(1, [new Y.XmlElement("hardBreak")]);
      const t2 = new Y.XmlText();
      p.insert(2, [t2]);
      t2.insert(0, "b");
    });
    const before = extractText(doc);
    flattenPlaintextBreaks(doc);
    const after = extractText(doc);
    console.log("SIB BEFORE", JSON.stringify(before), "AFTER", JSON.stringify(after));
    expect(after).toBe(before);
  });

  it("two blocks both needing work", () => {
    const doc = mk((f) => {
      for (const s of ["a\nb\nc", "d\ne"]) {
        const p = el("paragraph");
        f.insert(f.length, [p]);
        const t = new Y.XmlText();
        p.insert(0, [t]);
        t.insert(0, s);
      }
    });
    const before = extractText(doc);
    flattenPlaintextBreaks(doc);
    const after = extractText(doc);
    console.log(
      "MULTI BEFORE",
      JSON.stringify(before),
      "AFTER",
      JSON.stringify(after),
      "n=",
      doc.getXmlFragment("default").length,
    );
    expect(after).toBe(before);
  });

  it("leading and trailing breaks", () => {
    for (const s of ["\nb", "a\n", "\n"]) {
      const doc = mk((f) => {
        const p = el("paragraph");
        f.insert(0, [p]);
        const t = new Y.XmlText();
        p.insert(0, [t]);
        t.insert(0, s);
      });
      const before = extractText(doc);
      flattenPlaintextBreaks(doc);
      const after = extractText(doc);
      console.log("EDGE", JSON.stringify(s), JSON.stringify(before), "->", JSON.stringify(after));
      expect(after).toBe(before);
    }
  });
});
