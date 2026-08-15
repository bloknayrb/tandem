// @vitest-environment happy-dom

import { Editor } from "@tiptap/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildSchemaExtensions } from "../../src/client/editor/editor-extensions";
import { AUTHORSHIP_ORIGIN_META } from "../../src/client/editor/extensions/authorship";
import { insertChatMarkdown } from "../../src/client/panels/chat-insert";

describe("chat insertion", () => {
  let editor: Editor;
  beforeEach(() => {
    editor = new Editor({ extensions: buildSchemaExtensions(), content: "<p>hello world</p>" });
  });
  afterEach(() => editor.destroy());

  it("replaces the selection through one undoable sanitized transaction", () => {
    editor.commands.setTextSelection({ from: 7, to: 12 });
    const dispatch = vi.spyOn(editor.view, "dispatch");
    insertChatMarkdown(editor, "**safe** [link](javascript:evil)", "claude");
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(dispatch.mock.calls[0][0].getMeta("addToHistory")).toBe(true);
    // Attribution rides the same transaction as the content, so an insertion
    // can never be committed under the wrong author by a partial dispatch.
    expect(dispatch.mock.calls[0][0].getMeta(AUTHORSHIP_ORIGIN_META)).toBe("claude");
    expect(editor.getText()).toContain("hello safe [link](javascript:evil)");
    expect(JSON.stringify(editor.getJSON())).not.toContain('"href":"javascript:');
  });
});
