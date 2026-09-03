import type { Root } from "mdast";
import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { loadMarkdown, mdParser, saveMarkdown } from "../../src/server/file-io/markdown.js";
import { buildListItemsFromTree } from "../../src/server/file-io/mdast-ydoc.js";
import { extractText, flatDocLength } from "../../src/server/mcp/document.js";
import {
  attachItems,
  findListTarget,
  listFormatRefusal,
  removeItemAndCollapse,
} from "../../src/server/mcp/list-edit.js";
import { toFlatOffset } from "../../src/shared/positions/types.js";
import { resolveToTextblock } from "../../src/shared/positions/ydoc.js";

/** The guard `tandem_editList` applies to `at`, mirrored for the table below. */
function isRejected(at: number, flatLength: number): boolean {
  return !Number.isInteger(at) || at < 0 || at > flatLength;
}

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
    const { items, deferred } = buildListItemsFromTree(mdParser.parse(markdown) as Root);
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

describe("out-of-range offsets", () => {
  // `resolveToElement` CLAMPS, so without a bounds check `remove` deletes an
  // item the caller never named and reports success. Measured before the guard,
  // on this 16-character document: `at: 999` removed "gamma", `at: -5` removed
  // "alpha".
  //
  // These assert the CLAMP — the thing the guard exists to defend against —
  // rather than re-typing the guard expression. An earlier draft did the latter
  // and was worthless: it asserted that a boolean it had just written was true,
  // never reached production code, and would have stayed green with the guard
  // deleted outright.
  it.each([
    [999, "gamma", 2],
    [-5, "alpha", 0],
  ])("offset %i silently resolves to the %s item without a bounds check", (at, _label, index) => {
    const doc = docFor("- alpha\n- beta\n- gamma\n");
    const frag = doc.getXmlFragment("default");
    const pos = resolveToTextblock(frag, toFlatOffset(at));
    expect(pos, "the resolver clamps rather than refusing").not.toBeNull();
    const target = findListTarget(frag, pos!.path);
    if ("error" in target) throw new Error(target.error);
    expect(target.index, "clamped to the wrong item — this is what the guard prevents").toBe(index);
    doc.destroy();
  });

  it("the guard rejects exactly the offsets the clamp would mis-resolve", () => {
    const doc = docFor("- alpha\n- beta\n- gamma\n");
    const flatLength = flatDocLength(doc);
    // `flatDocLength` must agree with the projection it is standing in for.
    // The full equivalence table lives in the describe below — #1752 makes
    // `flatDocLength` the bounds primitive for `validateRange` too, so a
    // disagreement now decides whether a real edit is accepted.
    expect(flatLength).toBe(extractText(doc).length);
    for (const bad of [999, -5, 1.5, Number.NaN]) {
      expect(isRejected(bad, flatLength), `${bad} must be rejected`).toBe(true);
    }
    for (const ok of [0, 1, flatLength]) {
      expect(isRejected(ok, flatLength), `${ok} must be accepted`).toBe(false);
    }
    doc.destroy();
  });
});

describe("hard breaks in an inserted item", () => {
  it("stores a break as a sibling element, not an embed", () => {
    // mdast emits a hard break as an EMBED inside the Y.XmlText, which
    // y-prosemirror cannot render — it surfaces as literal
    // `<hardbreak></hardbreak>`. `insertBlocks` normalizes after every other
    // build; this path has to as well.
    const doc = docFor("- alpha\n");
    const { target } = targetFor(doc, "alpha");
    if ("error" in target) throw new Error(target.error);
    const { items, deferred } = buildListItemsFromTree(mdParser.parse("- one\\\ntwo") as Root);
    doc.transact(() => attachItems(target.list, target.index + 1, items, deferred));

    let sawEmbed = false;
    let sawBreakElement = false;
    const walk = (el: Y.XmlElement): void => {
      for (let i = 0; i < el.length; i++) {
        const child = el.get(i);
        if (child instanceof Y.XmlText) {
          for (const op of child.toDelta()) {
            if (typeof op.insert !== "string") sawEmbed = true;
          }
        } else if (child instanceof Y.XmlElement) {
          if (child.nodeName === "hardBreak") sawBreakElement = true;
          else walk(child);
        }
      }
    };
    const frag = doc.getXmlFragment("default");
    for (let i = 0; i < frag.length; i++) {
      const n = frag.get(i);
      if (n instanceof Y.XmlElement) walk(n);
    }
    expect(sawEmbed, "a hardBreak embed survived normalization").toBe(false);
    expect(sawBreakElement).toBe(true);
    doc.destroy();
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
    const { items, deferred } = buildListItemsFromTree(mdParser.parse("- inserted") as Root);
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

/**
 * #1752: `flatDocLength` is now the length `validateRange`'s hoisted-`text`
 * guard compares against, so any block shape where it disagrees with
 * `extractText(doc).length` silently changes a bounds verdict.
 *
 * The four heading rows at the end are unreachable from today's writers
 * (`document-model.ts`, `mdast-ydoc.ts` and `docx-html.ts` all emit 1-6 or
 * `?? 1`), and the VITEST-only equality check inside `validateRange` compares
 * `extractText` to ITSELF and can never see them — so they are pinned here,
 * against the OTHER length function, or nothing checks them at all.
 */
describe("flatDocLength agrees with extractText over every block shape", () => {
  function para(text: string): Y.XmlElement {
    const el = new Y.XmlElement("paragraph");
    if (text.length > 0) el.insert(0, [new Y.XmlText(text)]);
    return el;
  }

  function heading(level: unknown, text: string): Y.XmlElement {
    const el = new Y.XmlElement("heading");
    // biome-ignore lint/suspicious/noExplicitAny: Tiptap heading levels are numeric attributes.
    el.setAttribute("level", level as any);
    el.insert(0, [new Y.XmlText(text)]);
    return el;
  }

  const cases: Array<[string, string]> = [
    ["paragraph", "just a paragraph\n"],
    ["empty paragraph", "one\n\n\ntwo\n"],
    ["bullet list", "- alpha\n- beta\n"],
    ["ordered list", "1. alpha\n2. beta\n"],
    ["nested list", "- alpha\n  - nested\n- beta\n"],
    ["table", "| a | b |\n|---|---|\n| 1 | 2 |\n"],
    ["blockquote", "> quoted text\n"],
    ["code block", "```js\nlet x = 1;\n```\n"],
    ["hard break", "line one  \nline two\n"],
    ["image-only paragraph", "![alt](x.png)\n"],
    ["trailing empty paragraph", "text\n\n\n"],
    ["heading level 1", "# One\n"],
    ["heading level 2", "## Two\n"],
    ["heading level 3", "### Three\n"],
    ["heading level 4", "#### Four\n"],
    ["heading level 5", "##### Five\n"],
    ["heading level 6", "###### Six\n"],
    ["mixed document", "# Title\n\nPara\n\n- a\n- b\n\n> q\n\n```\ncode\n```\n"],
  ];

  it.each(cases)("%s", (_label, md) => {
    const doc = docFor(md);
    expect(flatDocLength(doc)).toBe(extractText(doc).length);
    doc.destroy();
  });

  const oddLevels: Array<[string, unknown]> = [
    // headingPrefixLength(0) is 0 but headingPrefix(0) was `" "` — a 1-char
    // disagreement on every heading with a falsy level.
    ["level 0", 0],
    // `Number(attr)` of a non-numeric attribute is NaN: length 0, prefix `" "`.
    ["a non-numeric level", "abc"],
    // `"#".repeat(-1)` THROWS, while headingPrefixLength(-1) is 0.
    ["a negative level", -1],
    // headingPrefixLength(1.5) is 2.5, so flatDocLength went non-integer.
    ["a fractional level", 1.5],
  ];

  it.each(oddLevels)("heading with %s", (_label, level) => {
    // Built directly: no parser in the tree emits a level outside 1-6.
    const doc = new Y.Doc();
    doc.getXmlFragment("default").insert(0, [heading(level, "Title"), para("body")]);
    const text = extractText(doc);
    expect(flatDocLength(doc)).toBe(text.length);
    expect(Number.isInteger(flatDocLength(doc))).toBe(true);
    doc.destroy();
  });
});
