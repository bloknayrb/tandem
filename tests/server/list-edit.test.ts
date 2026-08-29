import type { Root } from "mdast";
import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { loadMarkdown, mdParser, saveMarkdown } from "../../src/server/file-io/markdown.js";
import { extractText } from "../../src/server/mcp/document.js";
import {
  attachItems,
  buildItems,
  findListTarget,
  listFormatRefusal,
  removeItemAndCollapse,
} from "../../src/server/mcp/list-edit.js";
import { toFlatOffset } from "../../src/shared/positions/types.js";
import { resolveToTextblock } from "../../src/shared/positions/ydoc.js";

/**
 * `tandem_editList` — the structural half of list editing.
 *
 * Path-addressed rather than range-replacing, deliberately. A
 * `replaceBlock(from, to, markdown)` shape was drafted and withdrawn: it would
 * make the caller re-emit every block it touched, and `extractText` strips
 * inline marks with no per-block markdown reader anywhere in the tree, so every
 * call that meant to PRESERVE a sibling would silently delete that sibling's
 * bold, links and code spans. Ticking a checkbox would have rebuilt a
 * `listItem`, losing its marks, annotations and authorship.
 */

function docFor(md: string): Y.Doc {
  const doc = new Y.Doc();
  loadMarkdown(doc, md);
  return doc;
}

/** Resolve a flat offset inside the item containing `needle`. */
function targetFor(doc: Y.Doc, needle: string) {
  const fragment = doc.getXmlFragment("default");
  const at = extractText(doc).indexOf(needle);
  expect(at, `fixture must contain ${JSON.stringify(needle)}`).toBeGreaterThanOrEqual(0);
  const pos = resolveToTextblock(fragment, toFlatOffset(at));
  expect(pos).not.toBeNull();
  return { fragment, target: findListTarget(fragment, pos!.path) };
}

describe("findListTarget", () => {
  it("finds the item and its list", () => {
    const doc = docFor("- alpha\n- beta\n");
    const { target } = targetFor(doc, "beta");
    expect("error" in target).toBe(false);
    if (!("error" in target)) {
      expect(target.item.nodeName).toBe("listItem");
      expect(target.list.nodeName).toBe("bulletList");
      expect(target.index).toBe(1);
    }
    doc.destroy();
  });

  it("finds the INNER list for a nested item, not the outer one", () => {
    const doc = docFor("- parent\n  - child a\n  - child b\n");
    const { target } = targetFor(doc, "child b");
    if ("error" in target) throw new Error(target.error);
    expect(target.index).toBe(1); // second item of the SUBLIST
    expect(target.list.length).toBe(2);
    doc.destroy();
  });

  it("refuses a position that is not in a list, and says what to use instead", () => {
    const doc = docFor("just a paragraph\n");
    const { target } = targetFor(doc, "paragraph");
    expect("error" in target).toBe(true);
    if ("error" in target) {
      expect(target.error).toContain("not inside a list");
      expect(target.error).toContain("tandem_edit");
    }
    doc.destroy();
  });
});

describe("insert", () => {
  function insert(md: string, needle: string, markdown: string, after: boolean): string {
    const doc = docFor(md);
    const { target } = targetFor(doc, needle);
    if ("error" in target) throw new Error(target.error);
    // Build OUTSIDE the transaction, attach inside — a detached Y.XmlText
    // reverses segment order on attach, and a throw during the build would
    // otherwise land mid-transaction.
    const { items, deferred } = buildItems(mdParser.parse(markdown) as Root);
    doc.transact(() =>
      attachItems(target.list, after ? target.index + 1 : target.index, items, deferred),
    );
    const out = saveMarkdown(doc);
    doc.destroy();
    return out;
  }

  it("inserts after the target item", () => {
    expect(insert("- alpha\n- beta\n", "alpha", "- inserted", true)).toBe(
      "- alpha\n- inserted\n- beta\n",
    );
  });

  it("inserts before the target item", () => {
    expect(insert("- alpha\n- beta\n", "beta", "- inserted", false)).toBe(
      "- alpha\n- inserted\n- beta\n",
    );
  });

  it("inserts several items from one call", () => {
    expect(insert("- alpha\n", "alpha", "- one\n- two", true)).toBe("- alpha\n- one\n- two\n");
  });

  it("leaves the target item's inline formatting untouched", () => {
    // The property the withdrawn range-replace design could not hold: a sibling
    // that is merely preserved must keep its marks byte-for-byte.
    const out = insert("- see **bold** and [link](https://e.test)\n", "bold", "- plain new", true);
    expect(out).toBe("- see **bold** and [link](https://e.test)\n- plain new\n");
  });

  it("preserves a neighbouring item's checkbox state", () => {
    expect(insert("- [x] done\n", "done", "- new", true)).toBe("- [x] done\n- new\n");
  });

  it("wraps a non-list block as an item", () => {
    expect(insert("- alpha\n", "alpha", "just a paragraph", true)).toBe(
      "- alpha\n- just a paragraph\n",
    );
  });

  it("inserts into the inner list for a nested target", () => {
    expect(insert("- parent\n  - child a\n", "child a", "- child b", true)).toBe(
      "- parent\n  - child a\n  - child b\n",
    );
  });

  it("keeps an ordered list ordered", () => {
    expect(insert("1. alpha\n2. beta\n", "alpha", "- inserted", true)).toBe(
      "1. alpha\n2. inserted\n3. beta\n",
    );
  });
});

describe("remove, and the containers it empties", () => {
  function remove(md: string, needle: string): string {
    const doc = docFor(md);
    const { fragment, target } = targetFor(doc, needle);
    if ("error" in target) throw new Error(target.error);
    doc.transact(() => removeItemAndCollapse(fragment, target));
    const out = saveMarkdown(doc);
    doc.destroy();
    return out;
  }

  it("removes one item among several", () => {
    expect(remove("- alpha\n- beta\n- gamma\n", "beta")).toBe("- alpha\n- gamma\n");
  });

  it("removes the list entirely when its last item goes", () => {
    // `bulletList` is `listItem+`, so an emptied list is schema-invalid — and
    // invalid is not inert (#1664): the client deletes it out of the shared
    // Y.Doc and cascades. It would also contribute no text while still
    // consuming a FLAT_SEPARATOR, shifting every later offset by one.
    expect(remove("# T\n\n- only\n\ntail\n", "only")).toBe("# T\n\ntail\n");
  });

  it("removes a nested item without disturbing its parent", () => {
    expect(remove("- parent\n  - child a\n  - child b\n", "child a")).toBe(
      "- parent\n  - child b\n",
    );
  });

  it("collapses the sublist when its last item goes", () => {
    expect(remove("- parent\n  - only child\n- sibling\n", "only child")).toBe(
      "- parent\n- sibling\n",
    );
  });

  it("takes nested content with the item that holds it", () => {
    expect(remove("- alpha\n  - deep\n- beta\n", "alpha")).toBe("- beta\n");
  });

  it("leaves a document that is only the list empty rather than invalid", () => {
    expect(remove("- only\n", "only").trim()).toBe("");
  });
});

describe("format gate", () => {
  it("refuses plaintext formats and names the alternative", () => {
    const refusal = listFormatRefusal("txt");
    expect(refusal).toContain("no list structure");
    expect(refusal).toContain("tandem_edit");
  });

  it("allows markdown and .docx", () => {
    // .docx builds real bulletList/orderedList on import and docx-export writes
    // them back to Word, so refusing it would decline an operation the system
    // already performs correctly.
    expect(listFormatRefusal("md")).toBeNull();
    expect(listFormatRefusal("docx")).toBeNull();
  });

  it("refuses html and unknown extensions, which route to the plaintext adapter", () => {
    expect(listFormatRefusal("html")).not.toBeNull();
    expect(listFormatRefusal("csv")).not.toBeNull();
  });
});

describe("offsets stay usable after an edit", () => {
  it("re-resolves the neighbouring item after an insert", () => {
    const doc = docFor("- alpha\n- beta\n");
    const { target } = targetFor(doc, "alpha");
    if ("error" in target) throw new Error(target.error);
    const { items, deferred } = buildItems(mdParser.parse("- inserted") as Root);
    doc.transact(() => attachItems(target.list, target.index + 1, items, deferred));
    // The flat projection now carries the new item, and every item is still
    // addressable — the property a caller relies on for a follow-up call.
    const flat = extractText(doc);
    expect(flat).toBe("alpha\ninserted\nbeta");
    const again = targetFor(doc, "beta");
    if ("error" in again.target) throw new Error(again.target.error);
    expect(again.target.index).toBe(2);
    doc.destroy();
  });
});
