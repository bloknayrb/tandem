import { describe, expect, it } from "vitest";
import { initProseMirrorDoc } from "y-prosemirror";
import * as Y from "yjs";
import { loadMarkdown, saveMarkdown } from "../../src/server/file-io/markdown.js";
import { extractText } from "../../src/server/mcp/document.js";
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
 * Shapes that were already valid. They are the half that proves a fix is a fix
 * rather than a blanket "stop validating" — a schema widened too far would keep
 * these green while a regression in the paragraph-first path went unnoticed.
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

/** markdown → Y.Doc → (bind the production schema) → Y.Doc, as the editor does. */
function bindEditor(md: string): {
  beforeMd: string;
  afterMd: string;
  beforeFlat: string;
  afterFlat: string;
} {
  const doc = new Y.Doc();
  try {
    loadMarkdown(doc, md);
    const beforeMd = saveMarkdown(doc);
    const beforeFlat = extractText(doc);
    // The same call `ySyncPlugin` makes on bind, through the real schema.
    initProseMirrorDoc(doc.getXmlFragment("default"), productionSchema());
    return { beforeMd, afterMd: saveMarkdown(doc), beforeFlat, afterFlat: extractText(doc) };
  } finally {
    doc.destroy();
  }
}

describe("Y.Doc → ProseMirror list corpus (#1664)", () => {
  describe("a list item whose first child is not a paragraph survives the bind", () => {
    it.each(FIRST_CHILD_NOT_PARAGRAPH)("%s", (_label, md) => {
      const { beforeMd, afterMd } = bindEditor(md);

      // The document is not emptied. Asserted separately from the equality
      // below because "" === "" is what the bug looked like when the cascade
      // reached the fragment root, and a corpus entry that itself serialized
      // empty would pass the equality check while proving nothing.
      expect(afterMd, "document was emptied by the editor bind").not.toBe("");
      expect(afterMd).toBe(beforeMd);
    });

    it.each(FIRST_CHILD_NOT_PARAGRAPH)("%s — flat offsets do not move", (_label, md) => {
      // The fix must not move the annotation coordinate system. The rejected
      // alternative (injecting an empty leading paragraph server-side) would
      // add one FLAT_SEPARATOR per normalized item and silently re-anchor every
      // annotation after it.
      const { beforeFlat, afterFlat } = bindEditor(md);
      expect(afterFlat).toBe(beforeFlat);
    });
  });

  describe("shapes that were already valid stay valid", () => {
    it.each(ALREADY_VALID)("%s", (_label, md) => {
      const { beforeMd, afterMd } = bindEditor(md);
      expect(afterMd).toBe(beforeMd);
    });
  });

  it("keeps the whole document when only one item among many is affected", () => {
    // The partial case: the cascade removed just the offending item here, so a
    // corpus keyed only on "document is non-empty" would miss it.
    const md = "# Notes\n\n- keep me\n- > quoted\n- keep me too\n\nTail.\n";
    const { beforeMd, afterMd } = bindEditor(md);
    expect(afterMd).toBe(beforeMd);
    expect(afterMd).toContain("keep me too");
    expect(afterMd).toContain("> quoted");
  });
});
