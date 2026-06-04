/**
 * GFM task lists (#982) — mdast ⇄ Y.Doc mapping for the per-item `checked`
 * tri-state on the ordinary `listItem` node (the mdast-native model; no separate
 * taskList/taskItem nodes). Covers both directions, the tolerant reverse read,
 * and flat-offset invariance (the `checked` attribute must be invisible to the
 * annotation coordinate system).
 */

import { afterEach, describe, expect, it } from "vitest";
import * as Y from "yjs";
import { loadMarkdown, saveMarkdown } from "../../../src/server/file-io/markdown.js";
import { extractText } from "../../../src/server/mcp/document.js";

let doc: Y.Doc;
afterEach(() => doc?.destroy());

function load(md: string): Y.Doc {
  const d = new Y.Doc();
  loadMarkdown(d, md);
  return d;
}

function roundTrip(md: string): string {
  doc = new Y.Doc();
  loadMarkdown(doc, md);
  return saveMarkdown(doc);
}

/** Collect every `listItem` Y.XmlElement in document order. */
function listItems(d: Y.Doc): Y.XmlElement[] {
  const out: Y.XmlElement[] = [];
  const walk = (node: Y.XmlElement | Y.XmlText) => {
    if (!(node instanceof Y.XmlElement)) return;
    if (node.nodeName === "listItem") out.push(node);
    for (let i = 0; i < node.length; i++) walk(node.get(i) as Y.XmlElement | Y.XmlText);
  };
  const frag = d.getXmlFragment("default");
  for (let i = 0; i < frag.length; i++) walk(frag.get(i) as Y.XmlElement | Y.XmlText);
  return out;
}

describe("task list mapping (#982)", () => {
  it("forward: maps mdast `checked` tri-state onto the listItem attribute", () => {
    doc = load("- [ ] a\n- [x] b\n- c");
    const items = listItems(doc);
    expect(items).toHaveLength(3);
    // Stored as real booleans (the representation y-prosemirror writes); the
    // plain item carries NO attribute so PM's default `null` reconciles cleanly.
    expect(items[0].getAttribute("checked")).toBe(false);
    expect(items[1].getAttribute("checked")).toBe(true);
    expect(items[2].getAttribute("checked")).toBeUndefined();
  });

  it("reverse: emits `- [ ]` / `- [x]` / plain `-` per the attribute", () => {
    const out = roundTrip("- [ ] a\n- [x] b\n- c");
    expect(out).toContain("- [ ] a");
    expect(out).toContain("- [x] b");
    expect(out).toContain("- c");
    expect(out).not.toContain("- [ ] c");
  });

  it("reverse read is tolerant of a string `checked` attribute", () => {
    // A non-y-prosemirror writer could store the attribute as a string; the
    // reverse mapping must still emit a checkbox.
    doc = new Y.Doc();
    const frag = doc.getXmlFragment("default");
    const ul = new Y.XmlElement("bulletList");
    frag.insert(0, [ul]);
    const li = new Y.XmlElement("listItem");
    ul.insert(0, [li]);
    const p = new Y.XmlElement("paragraph");
    li.insert(0, [p]);
    const t = new Y.XmlText();
    p.insert(0, [t]);
    t.insert(0, "done");
    li.setAttribute("checked", "true");
    expect(saveMarkdown(doc)).toContain("- [x] done");
  });

  it("mixed and ordered task lists are idempotent fixed points", () => {
    const mixed = roundTrip("- a\n- [ ] b\n- [x] c");
    expect(mixed).toContain("- a");
    expect(mixed).toContain("- [ ] b");
    expect(mixed).toContain("- [x] c");
    // Second pass is a no-op.
    doc.destroy();
    doc = new Y.Doc();
    loadMarkdown(doc, mixed);
    expect(saveMarkdown(doc)).toBe(mixed);

    const ordered = roundTrip("1. [ ] x\n2. [x] y");
    expect(ordered).toContain("1. [ ] x");
    expect(ordered).toContain("2. [x] y");
  });

  it("the `checked` attribute is invisible to flat text (offset invariance)", () => {
    const checked = load("- [ ] abc");
    const plain = load("- abc");
    try {
      // Annotation coordinate system keys on flat text; a checkbox item must
      // produce byte-identical flat text to the same plain bullet.
      expect(extractText(checked)).toBe(extractText(plain));
      expect(extractText(checked)).toBe("abc");
    } finally {
      checked.destroy();
      plain.destroy();
    }
  });
});
