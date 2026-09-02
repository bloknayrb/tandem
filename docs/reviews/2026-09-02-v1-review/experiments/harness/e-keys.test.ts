// @vitest-environment happy-dom
import { Editor } from "@tiptap/core";
import { describe, expect, it } from "vitest";
import { buildSchemaExtensions } from "../../../../../src/client/editor/editor-extensions";
import { SlashCommandExtension, slashCommandPluginKey } from "../../../../../src/client/editor/slash-menu";
import { matchShortcut } from "../../../../../src/client/hooks/useAppShortcuts";

function keydown(view: { dom: HTMLElement }, init: KeyboardEventInit) {
  const ev = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init });
  view.dom.dispatchEvent(ev);
  return ev;
}

describe("E1: slash menu inside a code block", () => {
  it("opens on '/' typed at the start of a code-block line and Enter runs a block command", () => {
    const editor = new Editor({
      extensions: [...buildSchemaExtensions(), SlashCommandExtension],
      content: "<pre><code>echo hi\n</code></pre>",
    });
    // Caret at the end of the code block, after the newline.
    editor.commands.setTextSelection(editor.state.doc.content.size - 1);
    editor.commands.insertContent("/");
    editor.commands.insertContent("e"); // "/e" -> matches "Heading 1" (label contains 'e') etc.
    const st = slashCommandPluginKey.getState(editor.state);
    console.log("slash active in codeBlock:", st?.active, "parent:", editor.state.selection.$from.parent.type.name);
    expect(st?.active).not.toBeNull();
    // Simulate Enter as the plugin's handleKeyDown sees it.
    const ev = keydown(editor.view, { key: "Enter" });
    console.log("after Enter, doc:", JSON.stringify(editor.getHTML()), "prevented:", ev.defaultPrevented);
    editor.destroy();
  });
  it("opens on '/' after a space inside a code block too", () => {
    const editor = new Editor({
      extensions: [...buildSchemaExtensions(), SlashCommandExtension],
      content: "<pre><code>cd </code></pre>",
    });
    editor.commands.setTextSelection(editor.state.doc.content.size - 1);
    editor.commands.insertContent("/");
    editor.commands.insertContent("t");
    const st = slashCommandPluginKey.getState(editor.state);
    console.log("slash active after 'cd /t':", st?.active);
    keydown(editor.view, { key: "Enter" });
    console.log("after Enter, doc:", JSON.stringify(editor.getHTML()));
    editor.destroy();
  });
});

describe("E2: AltGr (Ctrl+Alt on Windows) letters match Ctrl shortcuts", () => {
  const altgr = (key: string, code: string) => ({ key, code, ctrlKey: true, altKey: true, metaKey: false, shiftKey: false });
  it("Polish ś / ń / ó (AltGr+S/N/O) fire save / new-scratchpad / open-file", () => {
    console.log("ś:", matchShortcut(altgr("ś", "KeyS")));
    console.log("ń:", matchShortcut(altgr("ń", "KeyN")));
    console.log("ó:", matchShortcut(altgr("ó", "KeyO")));
    console.log("ą:", matchShortcut(altgr("ą", "KeyA")));
    console.log("Romanian ț (AltGr+T):", matchShortcut(altgr("ț", "KeyT")));
    console.log("German € (AltGr+E):", matchShortcut(altgr("€", "KeyE")));
    console.log("German @ (AltGr+Q):", matchShortcut(altgr("@", "KeyQ")));
    console.log("German { (AltGr+7):", matchShortcut(altgr("{", "Digit7")));
    console.log("German [ (AltGr+8):", matchShortcut(altgr("[", "Digit8")));
    expect(matchShortcut(altgr("ś", "KeyS"))?.id).toBe("save");
    expect(matchShortcut(altgr("ń", "KeyN"))?.id).toBe("new-scratchpad");
    expect(matchShortcut(altgr("ó", "KeyO"))?.id).toBe("open-file");
    expect(matchShortcut(altgr("{", "Digit7"))?.id).toBe("pick-tab");
  });
});

describe("E3: Ctrl+Enter is also Tiptap's hard-break chord", () => {
  it("inserts a hardBreak in the editor on Ctrl+Enter (before App's accept handler sees it)", () => {
    const editor = new Editor({ extensions: buildSchemaExtensions(), content: "<p>abc</p>" });
    editor.commands.setTextSelection(2);
    const ev = keydown(editor.view, { key: "Enter", code: "Enter", ctrlKey: true });
    console.log("Ctrl+Enter -> html:", editor.getHTML(), "defaultPrevented:", ev.defaultPrevented);
    expect(editor.getHTML()).toContain("<br");
    console.log("App matcher for the same event:", matchShortcut({ key: "Enter", code: "Enter", ctrlKey: true, altKey: false, metaKey: false, shiftKey: false }));
    editor.destroy();
  });
});
