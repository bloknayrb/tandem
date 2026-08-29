import { describe, expect, it } from "vitest";
import { initProseMirrorDoc } from "y-prosemirror";
import * as Y from "yjs";
import { exportYDocToDocx } from "../../src/server/file-io/docx-export.js";
import { htmlToYDoc } from "../../src/server/file-io/docx-html.js";
import { loadMarkdown, saveMarkdown } from "../../src/server/file-io/markdown.js";
import { extractText } from "../../src/server/mcp/document.js";
import { anchoredRange } from "../../src/server/positions.js";
import { Y_MAP_ANNOTATIONS } from "../../src/shared/constants.js";
import { toFlatOffset } from "../../src/shared/positions/types.js";
import { productionSchema } from "./editor-roundtrip-harness.js";

/**
 * Y.Doc → ProseMirror corpus gate for lists (#1664).
 *
 * The direction nothing else drives. `tests/client/list-item-checkbox.test.ts`
 * is entirely PM-side (schema shape, widget rendering, Enter/Tab, input rule);
 * `editor-roundtrip-harness.ts` drives Y → PM → DOM → re-parse → Y but carries
 * no nested-list corpus; and `tests/e2e/` has no list spec at all. So the
 * `updateYFragment` half was covered by proxy and the `createNodeFromYElement`
 * half by nothing — which is how #1664 shipped.
 *
 * What made it invisible is worth stating, because it defeats the obvious
 * assertions: a schema-invalid node is not rendered wrong, it is DELETED out of
 * the shared Y.Doc. `createNodeFromYElement`'s catch treats
 * `NodeType.createChecked`'s throw as a concurrency artifact and runs
 * `(el._item).delete(tr)` under the `ySyncPluginKey` origin. That write is
 * origin-tagged (so `installUntaggedWriteWarning` stays quiet), non-`browser`
 * (so no channel event), and unlogged. It then CASCADES: an emptied `listItem`
 * leaves its list failing `listItem+`, evicting the list, up to the root.
 *
 * Hence the assertion shape. `expect(after).toBe(before)` on the Y.Doc itself —
 * not on rendered output, and not idempotency (`pass2 === pass1`), which a
 * first-pass wipe satisfies trivially because `"" === ""`.
 */

/** Shapes whose list item's FIRST child is not a paragraph — all legal CommonMark. */
const FIRST_CHILD_NOT_PARAGRAPH: Array<[string, string]> = [
  ["item is only an image", "- ![shot](a.png)\n- ![shot2](b.png)\n"],
  ["item is only a nested list", "- - deep a\n  - deep b\n"],
  ["text-less parent carrying a sub-list", "-\n  - child one\n  - child two\n"],
  ["item is only a blockquote", "- > note this\n- normal\n"],
  ["item is only a heading", "- # Section\n- normal\n"],
  ["item is only a fenced code block", "- ```\n  code\n  ```\n- normal\n"],
  ["ordered item is only a nested list", "1. 1. deep\n"],
  ["item is only a table", "- | a | b |\n  | - | - |\n  | 1 | 2 |\n"],
];

/**
 * Containers with NO children — the other half of the same eviction (#1664),
 * and the half a schema widening cannot reach: `block+` still requires one
 * child. Fixed at the loader instead (`ensureBlockChild` in `mdast-ydoc.ts`).
 *
 * The empty blockquote is here deliberately: it is not a list bug at all, which
 * is why "widening `listItem` closes the class" was the wrong claim to make.
 */
const EMPTY_CONTAINERS: Array<[string, string]> = [
  ["empty item between two others", "- a\n-\n- b\n"],
  ["empty ordered item", "1.\n2. b\n"],
  ["empty item among other blocks", "# T\n\n-\n\nTail.\n"],
  ["document that is only an empty item", "-\n"],
  ["empty blockquote", ">\n"],
  ["empty blockquote among other blocks", "# T\n\n>\n\nTail.\n"],
];

/**
 * Regression controls for the paragraph-first path — items that were already
 * valid and must stay valid.
 *
 * They cannot detect over-widening, and it would be wrong to imply otherwise:
 * every row here passes under `paragraph block*`, under `block+`, and under any
 * wider expression. Over-widening is bounded by the schema instead — `listItem`
 * is not in the `block` group, so `listItem > listItem` stays inexpressible —
 * and by the round-trip assertions above.
 */
const ALREADY_VALID: Array<[string, string]> = [
  ["paragraph then code block", "- text\n\n  ```\n  code\n  ```\n"],
  ["ordinary nested list", "- parent\n  - child\n"],
  ["task list", "- [ ] a\n- [x] b\n"],
  ["ordered list with start", "5. five\n6. six\n"],
  ["loose list", "- a\n\n- b\n"],
  ["mixed plain and checkbox items", "- plain\n- [x] done\n- [ ] todo\n"],
  ["list inside a blockquote", "> - a\n> - b\n"],
  ["deeply nested list", "- a\n  - b\n    - c\n"],
  ["item with inline marks", "- see **bold** and [link](https://e.test)\n"],
];

// Built once: the schema is immutable and `productionSchema()` is unmemoized,
// so calling it per test was ~15% of this file's runtime.
const SCHEMA = productionSchema();

/** Load `md`, hand the doc to `read`, and always destroy it. */
function loadDoc<T>(md: string, read: (doc: Y.Doc) => T): T {
  const doc = new Y.Doc();
  try {
    loadMarkdown(doc, md);
    return read(doc);
  } finally {
    doc.destroy();
  }
}

/**
 * Assert a shape survives the editor bind unchanged.
 *
 * The `not.toBe("")` guard is not redundant with the equality below it: `""`
 * is what the bug looked like once the cascade reached the fragment root, so a
 * fixture that itself serialized empty would satisfy `toBe(beforeMd)` as
 * `"" === ""` and prove nothing.
 */
function expectSurvivesBind(md: string): void {
  loadDoc(md, (doc) => {
    const beforeMd = saveMarkdown(doc);
    // The same call `ySyncPlugin` makes on bind, through the real schema.
    initProseMirrorDoc(doc.getXmlFragment("default"), SCHEMA);
    const afterMd = saveMarkdown(doc);
    expect(afterMd, "document was emptied by the editor bind").not.toBe("");
    expect(afterMd).toBe(beforeMd);
  });
}

describe("Y.Doc → ProseMirror list corpus (#1664)", () => {
  describe("a list item whose first child is not a paragraph survives the bind", () => {
    it.each(FIRST_CHILD_NOT_PARAGRAPH)("%s", (_label, md) => expectSurvivesBind(md));
  });

  describe("a container with no children survives the bind", () => {
    it.each(EMPTY_CONTAINERS)("%s", (_label, md) => expectSurvivesBind(md));

    it.each(EMPTY_CONTAINERS)("%s — normalization rewrites no bytes", (_label, md) => {
      // `ensureBlockChild` runs at LOAD, so it must be invisible on the way back
      // out: an item holding one empty paragraph has to re-serialize as the same
      // bare `-` that was read, or every open would rewrite the user's file.
      expect(loadDoc(md, saveMarkdown)).toBe(md);
    });
  });

  /**
   * The coordinate system, pinned against fixed values.
   *
   * Deliberately NOT a before/after comparison across the bind: both sides of
   * that would come from the same `loadMarkdown`, so a loader that injected
   * characters would shift them together and the assertion would stay green
   * while every annotation silently re-anchored. Only a literal expected string
   * can catch that, so `ensureBlockChild`'s "contributes no characters" claim is
   * asserted rather than assumed.
   *
   * Driven off the corpora above rather than its own copy of the fixtures — a
   * second copy of a shape drifts from the first, which is the failure the
   * corpora exist to prevent.
   */
  describe("flat offsets", () => {
    const EXPECTED_FLAT = new Map<string, string>([
      ["empty item between two others", "a\n\nb"],
      ["document that is only an empty item", ""],
      ["empty blockquote", ""],
      ["empty item among other blocks", "# T\n\nTail."],
      ["item is only an image", "\n"],
      ["item is only a blockquote", "note this\nnormal"],
    ]);
    const rows = [...FIRST_CHILD_NOT_PARAGRAPH, ...EMPTY_CONTAINERS].filter(([label]) =>
      EXPECTED_FLAT.has(label),
    );
    // Fails loudly if a label above is renamed, rather than silently testing less.
    it("covers every pinned label", () => {
      expect(rows.length).toBe(EXPECTED_FLAT.size);
    });
    it.each(rows)("%s", (label, md) => {
      expect(loadDoc(md, extractText)).toBe(EXPECTED_FLAT.get(label));
    });
  });

  describe("shapes that were already valid stay valid", () => {
    it.each(ALREADY_VALID)("%s", (_label, md) => expectSurvivesBind(md));
  });

  /**
   * The `.docx` loader is the OTHER producer of these Y.Docs, and it was still
   * building the invalid shapes after the markdown side was fixed — `case "ul"`,
   * `case "ol"` and `case "table"` in `docx-html.ts` insert only the children
   * they find, so a childless Word list or table was built and then evicted by
   * the same `createNodeFromYElement` path.
   *
   * `<li>` is absent here on purpose: `collectBlockChildren` has always given an
   * empty list item a paragraph, which is why the `.docx` path never had the
   * markdown side's bug and why only the containers ABOVE the item needed a guard.
   */
  describe("the .docx loader builds no empty containers (#1664)", () => {
    it.each([
      ["empty <ul>", "<p>keep</p><ul></ul><p>tail</p>"],
      ["empty <ol>", "<p>keep</p><ol></ol><p>tail</p>"],
      ["empty <table>", "<p>keep</p><table></table><p>tail</p>"],
      ["empty <li> (already guarded)", "<p>keep</p><ul><li></li></ul><p>tail</p>"],
      ["control: a real list", "<p>keep</p><ul><li><p>x</p></li></ul><p>tail</p>"],
    ])("%s", (_label, html) => {
      const doc = new Y.Doc();
      try {
        htmlToYDoc(doc, html);
        const beforeMd = saveMarkdown(doc);
        initProseMirrorDoc(doc.getXmlFragment("default"), SCHEMA);
        expect(saveMarkdown(doc)).toBe(beforeMd);
      } finally {
        doc.destroy();
      }
    });
  });

  /**
   * Exported Word-comment anchors (#1664 fallout).
   *
   * `blockToDocx` charged `getHeadingPrefixLength` for every heading, but the
   * flat projection carries a `"## "` prefix only for a TOP-LEVEL one — so a
   * nested heading walked 2-4 characters the document does not contain and
   * displaced every comment anchor after it. Reachable before as `> # Quoted`;
   * the widening made the everyday `- # Section` spelling loadable.
   */
  describe("docx export cursor tracks the flat projection (#1664)", () => {
    it.each([
      ["heading inside a list item", "- # Section\n- tail text\n"],
      ["heading inside a blockquote", "> # Quoted\n\ntail text\n"],
      ["top-level heading (control: prefix IS charged)", "# Top\n\ntail text\n"],
    ])("%s", async (_label, md) => {
      const doc = new Y.Doc();
      const drift: string[] = [];
      const warn = console.warn;
      const error = console.error;
      console.warn = console.error = (...a: unknown[]) => {
        if (String(a[0]).includes("cursor drift")) drift.push(String(a[0]));
      };
      try {
        loadMarkdown(doc, md);
        const flat = extractText(doc);
        const at = flat.indexOf("tail");
        const anchored = anchoredRange(doc, toFlatOffset(at), toFlatOffset(at + 4));
        expect(anchored.ok).toBe(true);
        if (anchored.ok) {
          doc.getMap(Y_MAP_ANNOTATIONS).set("c1", {
            id: "c1",
            author: "claude",
            type: "comment",
            content: "x",
            status: "pending",
            timestamp: 1,
            range: anchored.range,
            relRange: anchored.fullyAnchored ? anchored.relRange : undefined,
          });
        }
        await exportYDocToDocx(doc);
        expect(drift, drift[0] ?? "").toEqual([]);
      } finally {
        console.warn = warn;
        console.error = error;
        doc.destroy();
      }
    });
  });

  it("keeps the whole document when only one item among many is affected", () => {
    // The partial case: the cascade removed just the offending item here, so a
    // corpus keyed only on "document is non-empty" would miss it.
    const md = "# Notes\n\n- keep me\n- > quoted\n- keep me too\n\nTail.\n";
    expectSurvivesBind(md);
    expect(loadDoc(md, saveMarkdown)).toContain("keep me too");
    expect(loadDoc(md, saveMarkdown)).toContain("> quoted");
  });
});
