/**
 * GFM task lists (#982), client side: the extended `listItem` carries a
 * `checked` tri-state attribute and a widget decoration renders an interactive
 * checkbox when `checked !== null`. These jsdom guards catch the schema/attr
 * contract and the decoration rendering before manual QA. (Live two-way
 * y-prosemirror sync of `checked` is exercised by E2E / manual editor testing.)
 */

import { type AnyExtension, type Content, Editor } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import { afterEach, describe, expect, it } from "vitest";
import { buildSchemaExtensions } from "../../src/client/editor/editor-extensions";
import { ListItemCheckbox } from "../../src/client/editor/extensions/list-item-checkbox";
import { SLASH_COMMANDS } from "../../src/client/editor/slash-menu";

let editor: Editor | null = null;
afterEach(() => {
  editor?.destroy();
  editor = null;
  document.body.innerHTML = "";
});

/**
 * A DELIBERATELY partial extension set — `StarterKit` minus its `listItem`,
 * plus ours — because these specs are about `ListItemCheckbox` itself and want
 * nothing else in the way.
 *
 * Stated because it is not the production schema (no `SoftWrapParagraph`, no
 * tables, no `ListSpreadExtension`), and a suite that measures a schema
 * production does not use has already cost one wrong bug report: #1720 was
 * diagnosed as slash-command corruption when it was stock StarterKit's
 * `paragraph block*` listItem repairing an illegal shape at parse time. That is
 * safe here only because nothing in this file drives a block-type conversion —
 * `setNode`/`clearNodes` never run. Anything added here that DOES should pass
 * `buildSchemaExtensions()` via `opts.extensions`, as the Enter-key block near
 * the bottom of this file already does.
 */
function makeEditor(opts: { extensions?: AnyExtension[]; content?: Content } = {}): Editor {
  const container = document.createElement("div");
  document.body.appendChild(container);
  editor = new Editor({
    element: container,
    extensions: opts.extensions ?? [
      StarterKit.configure({ history: false, listItem: false }),
      ListItemCheckbox,
    ],
    content: opts.content ?? "",
  });
  return editor;
}

/**
 * Dispatch a real Enter keydown through the ProseMirror keymap chain — the
 * same path `EditorView`'s internal key handling uses (`someProp` +
 * `handleKeyDown`) — rather than calling a command directly, so this
 * exercises the actual keymap priority/fallthrough (our override, then
 * StarterKit's built-in `liftEmptyBlock`/`splitBlock` fallback).
 */
function pressEnter(ed: Editor): boolean {
  const event = new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true });
  return !!ed.view.someProp("handleKeyDown", (f) => f(ed.view, event));
}

/** Locate the flat doc position of an exact text node's start, for cursor placement. */
function findTextPos(ed: Editor, text: string): number {
  let found = -1;
  ed.state.doc.descendants((node, pos) => {
    if (found >= 0) return false;
    if (node.isText && node.text === text) {
      found = pos;
    }
    return true;
  });
  if (found < 0) throw new Error(`text node not found: ${JSON.stringify(text)}`);
  return found;
}

/** Collect every `listItem`'s `checked` attr, in document order. */
function checkedValues(ed: Editor): unknown[] {
  const values: unknown[] = [];
  ed.state.doc.descendants((node) => {
    if (node.type.name === "listItem") values.push(node.attrs.checked);
  });
  return values;
}

const CHECKBOX_LIST = {
  type: "doc",
  content: [
    {
      type: "bulletList",
      content: [
        {
          type: "listItem",
          attrs: { checked: false },
          content: [{ type: "paragraph", content: [{ type: "text", text: "task" }] }],
        },
        {
          type: "listItem",
          content: [{ type: "paragraph", content: [{ type: "text", text: "plain" }] }],
        },
      ],
    },
  ],
};

describe("ListItemCheckbox (#982)", () => {
  it("registers a `listItem` node with a `checked` attribute defaulting to null", () => {
    const ed = makeEditor();
    const listItem = ed.schema.nodes.listItem;
    expect(listItem).toBeDefined();
    expect(listItem.spec.attrs?.checked).toBeDefined();
    expect(listItem.spec.attrs?.checked.default).toBe(null);
  });

  it("renders a checkbox only for items whose `checked` is non-null", () => {
    const ed = makeEditor();
    ed.commands.setContent(CHECKBOX_LIST);
    // data-checked attribute on the checkbox item, not on the plain one.
    expect(ed.getHTML()).toContain('data-checked="false"');
    // Exactly one checkbox widget — the plain item gets none.
    const boxes = ed.view.dom.querySelectorAll('input[type="checkbox"]');
    expect(boxes).toHaveLength(1);
    expect((boxes[0] as HTMLInputElement).checked).toBe(false);
  });

  it("reflects the checked state on the rendered input", () => {
    const ed = makeEditor();
    ed.commands.setContent({
      type: "doc",
      content: [
        {
          type: "bulletList",
          content: [
            {
              type: "listItem",
              attrs: { checked: true },
              content: [{ type: "paragraph", content: [{ type: "text", text: "done" }] }],
            },
          ],
        },
      ],
    });
    const box = ed.view.dom.querySelector('input[type="checkbox"]') as HTMLInputElement | null;
    expect(box).not.toBeNull();
    expect(box?.checked).toBe(true);
    expect(ed.getHTML()).toContain('data-checked="true"');
  });

  it("clicking the checkbox widget dispatches a transaction that flips the checked attr", () => {
    // Regression test for the `doc.nodeAt` → `doc.resolve().nodeAfter` fix:
    // `nodeAt` only searches direct children of doc, so it returned null for a
    // listItem (always nested inside bulletList), silently skipping the dispatch.
    const ed = makeEditor();
    ed.commands.setContent(CHECKBOX_LIST);
    // The checkbox item is the first list item (checked: false).
    const box = ed.view.dom.querySelector('input[type="checkbox"]') as HTMLInputElement;
    expect(box).not.toBeNull();
    expect(box.checked).toBe(false);

    // Simulate a user checking the box.
    box.checked = true;
    box.dispatchEvent(new Event("change", { bubbles: true }));

    // The ProseMirror model should now reflect checked: true.
    expect(ed.getHTML()).toContain('data-checked="true"');
  });

  it("the /task-list slash command turns a paragraph into an unchecked checkbox item", () => {
    const ed = makeEditor();
    ed.commands.setContent("<p>buy milk</p>");
    ed.commands.focus();
    const cmd = SLASH_COMMANDS.find((c) => c.id === "task-list");
    expect(cmd).toBeDefined();
    cmd?.run(ed);
    expect(ed.getHTML()).toContain('data-checked="false"');
    expect(ed.view.dom.querySelectorAll('input[type="checkbox"]')).toHaveLength(1);
  });
});

describe("ListItemCheckbox Enter continuation (#982 A3)", () => {
  it("Enter mid-text in a checked:true item leaves it checked:true and starts a checked:false second item", () => {
    const ed = makeEditor();
    ed.commands.setContent({
      type: "doc",
      content: [
        {
          type: "bulletList",
          content: [
            {
              type: "listItem",
              attrs: { checked: true },
              content: [{ type: "paragraph", content: [{ type: "text", text: "done task" }] }],
            },
          ],
        },
      ],
    });
    ed.commands.setTextSelection(findTextPos(ed, "done task") + 4); // "done|task"
    expect(pressEnter(ed)).toBe(true);

    expect(checkedValues(ed)).toEqual([true, false]);
    // Cursor lands in the second (new) item.
    const { $from } = ed.state.selection;
    let inItem: unknown;
    for (let d = $from.depth; d > 0; d--) {
      if ($from.node(d).type.name === "listItem") {
        inItem = $from.node(d).attrs.checked;
        break;
      }
    }
    expect(inItem).toBe(false);
  });

  it("Enter mid-text in a checked:false item starts a checked:false second item", () => {
    const ed = makeEditor();
    ed.commands.setContent(CHECKBOX_LIST); // first item checked:false, text "task"
    ed.commands.setTextSelection(findTextPos(ed, "task") + 2);
    expect(pressEnter(ed)).toBe(true);
    expect(checkedValues(ed)[0]).toBe(false);
    expect(checkedValues(ed)[1]).toBe(false);
  });

  it("Enter mid-text in a plain (checked:null) item starts a plain second item", () => {
    const ed = makeEditor();
    ed.commands.setContent(CHECKBOX_LIST); // second item is plain, text "plain"
    ed.commands.setTextSelection(findTextPos(ed, "plain") + 2);
    expect(pressEnter(ed)).toBe(true);
    // Original checkbox item untouched; the split plain item stays null on both sides.
    expect(checkedValues(ed)).toEqual([false, null, null]);
  });

  it("Enter in an empty checkbox item at the end of the list exits the list, same as a plain empty item", () => {
    const ed = makeEditor();
    ed.commands.setContent({
      type: "doc",
      content: [
        {
          type: "bulletList",
          content: [
            { type: "listItem", attrs: { checked: false }, content: [{ type: "paragraph" }] },
          ],
        },
      ],
    });
    // Cursor inside the empty paragraph (doc=0, bulletList open=0, listItem open=1, paragraph open=2, content=3).
    ed.commands.setTextSelection(3);
    expect(pressEnter(ed)).toBe(true);

    // The keymap chain fell through our Enter handler (splitListItem returns
    // false on an empty item) to StarterKit's liftEmptyBlock: the list is
    // gone and the item became a bare paragraph, exactly like a plain list.
    expect(ed.state.doc.childCount).toBe(1);
    expect(ed.state.doc.firstChild?.type.name).toBe("paragraph");
    expect(ed.state.doc.textContent).toBe("");
  });

  it("Tab/Shift-Tab still sink/lift list items (parent keyboard shortcuts preserved)", () => {
    const ed = makeEditor();
    ed.commands.setContent({
      type: "doc",
      content: [
        {
          type: "bulletList",
          content: [
            {
              type: "listItem",
              attrs: { checked: false },
              content: [{ type: "paragraph", content: [{ type: "text", text: "outer" }] }],
            },
            {
              type: "listItem",
              attrs: { checked: false },
              content: [{ type: "paragraph", content: [{ type: "text", text: "inner" }] }],
            },
          ],
        },
      ],
    });
    ed.commands.setTextSelection(findTextPos(ed, "inner") + 1);

    const sunk = ed.view.someProp("handleKeyDown", (f) =>
      f(ed.view, new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true })),
    );
    expect(sunk).toBe(true);
    // Sinking nests the second item's listItem inside the first item's bulletList.
    let nestedBulletLists = 0;
    ed.state.doc.descendants((node) => {
      if (node.type.name === "bulletList") nestedBulletLists++;
    });
    expect(nestedBulletLists).toBe(2);

    const lifted = ed.view.someProp("handleKeyDown", (f) =>
      f(
        ed.view,
        new KeyboardEvent("keydown", {
          key: "Tab",
          shiftKey: true,
          bubbles: true,
          cancelable: true,
        }),
      ),
    );
    expect(lifted).toBe(true);
    nestedBulletLists = 0;
    ed.state.doc.descendants((node) => {
      if (node.type.name === "bulletList") nestedBulletLists++;
    });
    expect(nestedBulletLists).toBe(1);
  });

  it("accepted deviation: Enter at position 0 of a checked item leaves the empty first item checked:true and moves the content into a checked:false second item", () => {
    const ed = makeEditor();
    ed.commands.setContent({
      type: "doc",
      content: [
        {
          type: "bulletList",
          content: [
            {
              type: "listItem",
              attrs: { checked: true },
              content: [{ type: "paragraph", content: [{ type: "text", text: "hello" }] }],
            },
          ],
        },
      ],
    });
    // Cursor immediately before "hello" (offset 0 within the paragraph).
    ed.commands.setTextSelection(findTextPos(ed, "hello"));
    expect(pressEnter(ed)).toBe(true);

    expect(checkedValues(ed)).toEqual([true, false]);
    // The first item is now empty; the second carries the original text.
    const paragraphs: string[] = [];
    ed.state.doc.descendants((node) => {
      if (node.type.name === "paragraph") paragraphs.push(node.textContent);
    });
    expect(paragraphs).toEqual(["", "hello"]);
  });
});

/**
 * Enter inside a code block in a list item (#1664).
 *
 * These are keymap tests, not schema tests, and the distinction is the point.
 * Widening `listItem` to `block+` made `canSplit` succeed with the cursor in a
 * code block, so this extension's `Enter` override began consuming a key that
 * used to fall through to `newlineInCode`. Nothing caught it: the document
 * involved (`- text` plus an indented fence) was already valid before the
 * widening, so a corpus that only asserts documents still BIND cannot see that
 * one stopped being EDITABLE.
 *
 * Uses the production extension set rather than the `StarterKit + ListItemCheckbox`
 * pair the rest of this file builds, because the fallthrough target
 * (`newlineInCode`) comes from StarterKit's own keymap and the ordering between
 * the two is exactly what regressed.
 */
describe("Enter in a code block inside a list item (#1664)", () => {
  const ITEM_WITH_CODE = {
    type: "doc",
    content: [
      {
        type: "bulletList",
        content: [
          {
            type: "listItem",
            content: [
              { type: "paragraph", content: [{ type: "text", text: "text" }] },
              { type: "codeBlock", content: [{ type: "text", text: "abcdef" }] },
            ],
          },
        ],
      },
    ],
  };

  /** Text of the FIRST code block — same first-match convention as `findTextPos`. */
  function codeText(ed: Editor): string {
    let code: string | null = null;
    ed.state.doc.descendants((n) => {
      if (code === null && n.type.name === "codeBlock") code = n.textContent;
      return true;
    });
    if (code === null) throw new Error("no codeBlock found");
    return code;
  }

  /** Every listItem's block child type names, in document order. */
  function itemShapes(ed: Editor): string[][] {
    const shapes: string[][] = [];
    ed.state.doc.descendants((node) => {
      if (node.type.name === "listItem") {
        const kids: string[] = [];
        node.forEach((child) => kids.push(child.type.name));
        shapes.push(kids);
      }
      return true;
    });
    return shapes;
  }

  it("inserts a newline mid-block instead of tearing the code block into two items", () => {
    const ed = makeEditor({ extensions: buildSchemaExtensions(), content: ITEM_WITH_CODE });
    ed.commands.setTextSelection(findTextPos(ed, "abcdef") + 3); // after "abc"
    pressEnter(ed);

    // One item, still holding one code block — not two items each holding half.
    expect(itemShapes(ed)).toEqual([["paragraph", "codeBlock"]]);
    expect(codeText(ed)).toBe("abc\ndef");
  });

  it("inserts a newline at the end of the block instead of starting a new bullet", () => {
    const ed = makeEditor({ extensions: buildSchemaExtensions(), content: ITEM_WITH_CODE });
    ed.commands.setTextSelection(findTextPos(ed, "abcdef") + 6); // after "abcdef"
    pressEnter(ed);

    expect(itemShapes(ed)).toEqual([["paragraph", "codeBlock"]]);
    expect(codeText(ed)).toBe("abcdef\n");
  });

  it("still splits the item normally when the cursor is in a paragraph", () => {
    // The bail must be scoped to code blocks — ordinary Enter is unchanged.
    const ed = makeEditor({ extensions: buildSchemaExtensions(), content: ITEM_WITH_CODE });
    ed.commands.setTextSelection(findTextPos(ed, "text") + 4); // end of "text"
    pressEnter(ed);
    expect(itemShapes(ed).length).toBe(2);
  });

  it("keeps `paragraph` as the type a split list item is filled with", () => {
    // `splitListItem` takes `contentMatchAt(0).defaultType`. Under
    // `paragraph block*` that was `paragraph` structurally; under `block+` it is
    // whichever `block`-group node the schema registers first, so it holds by
    // extension ordering rather than by contract. Pin it: a reordering that made
    // this `blockquote` would have Enter create bullets containing quotes.
    const ed = makeEditor({ extensions: buildSchemaExtensions(), content: ITEM_WITH_CODE });
    expect(ed.schema.nodes.listItem.contentMatch.defaultType?.name).toBe("paragraph");
  });
});
