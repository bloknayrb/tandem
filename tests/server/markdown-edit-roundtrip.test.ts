/**
 * Markdown fidelity audit (#981) — the EDIT leg of the round-trip.
 *
 * The pre-existing fidelity suites assert `open → save → reopen`. The acceptance
 * criteria for #981 is the fuller cycle `open → render → EDIT → save → reopen`:
 * a construct must survive a user mutation in the middle, not just a passive
 * load/save. y-prosemirror writes user edits straight into the block's Y.XmlText
 * (text insert/delete) and toggles structural attributes (e.g. a task `checked`
 * flag), so these tests mutate the Y.Doc the same way and assert the edited
 * content round-trips while neighbouring constructs stay intact.
 *
 * It also pins several CommonMark/GFM shapes the audit confirmed but that were
 * not previously covered by a test: loose→tight list normalization (documented),
 * multi-line and comment HTML blocks, three-level nested lists, an autolink and
 * a footnote ref inside a table cell, and an inline code span containing a
 * literal backtick. Each asserts "no silent drop" — the construct's essential
 * source survives — not byte-identity to hand-authored input (per ADR-042's
 * documented normalizations).
 */

import { afterEach, describe, expect, it } from "vitest";
import * as Y from "yjs";
import { loadMarkdown, saveMarkdown } from "../../src/server/file-io/markdown.js";
import { extractText } from "../../src/server/mcp/document-model.js";

const docs: Y.Doc[] = [];
afterEach(() => {
  for (const d of docs.splice(0)) d.destroy();
});

function load(md: string): Y.Doc {
  const d = new Y.Doc();
  loadMarkdown(d, md);
  docs.push(d);
  return d;
}

function roundTrip(md: string): string {
  return saveMarkdown(load(md));
}

/** Depth-first walk of every Y.XmlElement under the default fragment. */
function walkElements(doc: Y.Doc, visit: (el: Y.XmlElement) => void): void {
  const recur = (node: Y.XmlElement | Y.XmlText) => {
    if (!(node instanceof Y.XmlElement)) return;
    visit(node);
    for (let i = 0; i < node.length; i++) recur(node.get(i) as Y.XmlElement | Y.XmlText);
  };
  const frag = doc.getXmlFragment("default");
  for (let i = 0; i < frag.length; i++) recur(frag.get(i) as Y.XmlElement | Y.XmlText);
}

/** First Y.XmlText found under an element of nodeName, in document order. */
function firstText(doc: Y.Doc, nodeName: string): Y.XmlText {
  let found: Y.XmlText | undefined;
  walkElements(doc, (el) => {
    if (found || el.nodeName !== nodeName) return;
    for (let i = 0; i < el.length; i++) {
      const child = el.get(i);
      if (child instanceof Y.XmlText) {
        found = child;
        return;
      }
    }
  });
  if (!found) throw new Error(`no Y.XmlText under <${nodeName}>`);
  return found;
}

describe("markdown fidelity — edit leg of the round-trip (#981)", () => {
  it("editing a paragraph's text round-trips the new content", () => {
    const doc = load("# Title\n\nOriginal body.\n\n- bullet\n");
    // Mutate the paragraph the way y-prosemirror does: append into its XmlText.
    const para = firstText(doc, "paragraph");
    para.insert(para.length, " Appended.");
    const out = saveMarkdown(doc);
    expect(out).toContain("Original body. Appended.");
    // Neighbouring constructs are untouched.
    expect(out).toContain("# Title");
    expect(out).toContain("- bullet");
    // Reopen → re-save is a stable fixed point.
    expect(saveMarkdown(load(out))).toBe(out);
  });

  it("editing a heading's text preserves its level", () => {
    const doc = load("## Heading two\n\nbody\n");
    const text = firstText(doc, "heading");
    text.insert(text.length, " edited");
    const out = saveMarkdown(doc);
    expect(out).toContain("## Heading two edited");
  });

  it("editing inside a table cell round-trips and keeps the table shape", () => {
    const doc = load("| H1 | H2 |\n| -- | -- |\n| a | b |\n");
    // Find the LAST body-cell paragraph XmlText and append to it.
    let lastCellText: Y.XmlText | undefined;
    walkElements(doc, (el) => {
      if (el.nodeName !== "tableCell") return;
      for (let i = 0; i < el.length; i++) {
        const para = el.get(i);
        if (para instanceof Y.XmlElement && para.nodeName === "paragraph") {
          const t = para.get(0);
          if (t instanceof Y.XmlText) lastCellText = t;
        }
      }
    });
    if (!lastCellText) throw new Error("no body cell found");
    lastCellText.insert(lastCellText.length, "Z");
    const out = saveMarkdown(doc);
    expect(out).toContain("bZ");
    expect(out).toContain("| H1 | H2 |");
    expect(saveMarkdown(load(out))).toBe(out);
  });

  it("toggling a task item's checked attribute round-trips the new state", () => {
    const doc = load("- [ ] todo\n- [x] done\n");
    // Flip the first item to checked and the second to unchecked, mirroring
    // what y-prosemirror writes when a user clicks the checkbox.
    const items: Y.XmlElement[] = [];
    walkElements(doc, (el) => {
      if (el.nodeName === "listItem") items.push(el);
    });
    expect(items).toHaveLength(2);
    items[0].setAttribute("checked", true as any);
    items[1].setAttribute("checked", false as any);
    const out = saveMarkdown(doc);
    expect(out).toContain("- [x] todo");
    expect(out).toContain("- [ ] done");
    expect(saveMarkdown(load(out))).toBe(out);
  });

  it("editing text adjacent to an inline raw run keeps the run and stays flat-stable", () => {
    const doc = load("Intro ref[^1] tail.\n\n[^1]: body\n");
    const para = firstText(doc, "paragraph");
    // Insert at offset 0 (before "Intro"), the most offset-sensitive edit.
    para.insert(0, "EDIT ");
    const out = saveMarkdown(doc);
    expect(out).toContain("EDIT Intro ref[^1] tail.");
    expect(out).toContain("[^1]: body");
    // The footnote-ref raw run is intact in flat text and re-loads stably.
    const reopened = load(out);
    expect(extractText(reopened)).toContain("[^1]");
    expect(saveMarkdown(reopened)).toBe(out);
  });
});

describe("markdown fidelity — un-pinned construct coverage (#981)", () => {
  it("a loose list is normalized to tight (documented normalization, not loss)", () => {
    // CommonMark "loose" list (blank lines between items) → mdast spread:true.
    // yDocToMdast always emits spread:false, so the on-disk form is tight. The
    // item TEXT must survive; the spacing change is the documented normalization.
    const out = roundTrip("- one\n\n- two\n\n- three\n");
    expect(out).toContain("- one");
    expect(out).toContain("- two");
    expect(out).toContain("- three");
    // Idempotent fixed point after normalization.
    expect(saveMarkdown(load(out))).toBe(out);
  });

  it("three-level nested bullets round-trip with increasing indentation", () => {
    const input = "- L1\n  - L2\n    - L3\n";
    const out = roundTrip(input);
    expect(out).toContain("- L1");
    expect(out).toMatch(/\n {2}- L2/);
    expect(out).toMatch(/\n {4}- L3/);
    expect(saveMarkdown(load(out))).toBe(out);
  });

  it("a multi-line HTML block is preserved verbatim", () => {
    const input = '<div class="card">\n  <p>line one</p>\n  <p>line two</p>\n</div>\n';
    const out = roundTrip(input);
    expect(out).toContain('<div class="card">');
    expect(out).toContain("<p>line one</p>");
    expect(out).toContain("<p>line two</p>");
    expect(out).toContain("</div>");
  });

  it("an HTML comment block survives the round-trip", () => {
    const out = roundTrip("Before.\n\n<!-- a comment -->\n\nAfter.\n");
    expect(out).toContain("<!-- a comment -->");
    expect(out).toContain("Before.");
    expect(out).toContain("After.");
  });

  it("an autolink and a footnote ref inside a table cell survive", () => {
    const out = roundTrip(
      "| Link | Note |\n| - | - |\n| https://example.com | x[^1] |\n\n[^1]: body\n",
    );
    expect(out).toContain("https://example.com");
    expect(out).toContain("[^1]");
    expect(out).toContain("[^1]: body");
  });

  it("inline code containing a literal backtick round-trips its content", () => {
    // CommonMark uses double-backtick fencing to embed a literal backtick. The
    // backtick char and surrounding prose must survive; remark may re-pick the
    // fence width, so this asserts content preservation, not byte-identity.
    const out = roundTrip("Use `` ` `` for a backtick.\n");
    expect(out).toContain("`");
    expect(out).toContain("for a backtick");
    // The literal backtick is carried as an inlineCode value (a `code` mark),
    // so it re-loads stably on a second pass.
    expect(extractText(load(out))).toContain("`");
  });

  it("a bare URL and an email autolink canonicalize to angle form", () => {
    const out = roundTrip("See https://example.com and mail user@example.org today.\n");
    expect(out).toContain("<https://example.com>");
    expect(out).toContain("<user@example.org>");
  });
});
