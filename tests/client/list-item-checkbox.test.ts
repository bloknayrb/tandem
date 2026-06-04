/**
 * GFM task lists (#982), client side: the extended `listItem` carries a
 * `checked` tri-state attribute and a widget decoration renders an interactive
 * checkbox when `checked !== null`. These jsdom guards catch the schema/attr
 * contract and the decoration rendering before manual QA. (Live two-way
 * y-prosemirror sync of `checked` is exercised by E2E / manual editor testing.)
 */

import { Editor } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import { afterEach, describe, expect, it } from "vitest";
import { ListItemCheckbox } from "../../src/client/editor/extensions/list-item-checkbox";
import { SLASH_COMMANDS } from "../../src/client/editor/slash-menu";

let editor: Editor | null = null;
afterEach(() => {
  editor?.destroy();
  editor = null;
  document.body.innerHTML = "";
});

function makeEditor(): Editor {
  const container = document.createElement("div");
  document.body.appendChild(container);
  editor = new Editor({
    element: container,
    extensions: [StarterKit.configure({ history: false, listItem: false }), ListItemCheckbox],
    content: "",
  });
  return editor;
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
