import { Editor } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  filterSlashCommands,
  findSlashCommandMatch,
  SLASH_COMMANDS,
  SlashCommandExtension,
  slashCommandPluginKey,
} from "../../src/client/editor/slash-menu";

function makeEditor() {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const editor = new Editor({
    element: container,
    extensions: [StarterKit.configure({ history: false }), SlashCommandExtension],
    content: "",
  });
  return { editor, container };
}

describe("slash command parsing", () => {
  it("finds a slash command at the start of a textblock", () => {
    expect(findSlashCommandMatch("/h1")).toEqual({ fromOffset: 0, query: "h1" });
  });

  it("finds a slash command after whitespace", () => {
    expect(findSlashCommandMatch("Draft /quote")).toEqual({ fromOffset: 6, query: "quote" });
  });

  it("ignores slash text that is not command-like", () => {
    expect(findSlashCommandMatch("https://example.com/")).toBeNull();
  });
});

describe("slash command filtering", () => {
  it("returns every command for an empty query", () => {
    expect(filterSlashCommands("")).toHaveLength(SLASH_COMMANDS.length);
  });

  it("matches labels and aliases", () => {
    expect(filterSlashCommands("h2").map((command) => command.id)).toEqual(["heading-2"]);
    expect(filterSlashCommands("ordered").map((command) => command.id)).toEqual(["numbered-list"]);
  });
});

describe("slash command display metadata", () => {
  // Guards against a future command shipping without the icon/hint the B3
  // re-skin renders. Display-only fields, so this lives outside the filter
  // contract above.
  it.each(SLASH_COMMANDS)("$id has a non-empty hint and a well-formed icon", (command) => {
    expect(command.hint).not.toBe("");
    if (command.icon.kind === "glyph") {
      expect(command.icon.glyph).not.toBe("");
    } else {
      expect(command.icon.els.length).toBeGreaterThan(0);
    }
  });
});

describe("slash command plugin state", () => {
  let editor: Editor;
  let container: HTMLDivElement;

  beforeEach(() => {
    ({ editor, container } = makeEditor());
  });

  afterEach(() => {
    editor.destroy();
    container.remove();
  });

  it("sets active state when '/' is typed at cursor with empty selection", () => {
    editor.chain().focus().insertContent("/").run();
    const state = slashCommandPluginKey.getState(editor.state);
    expect(state?.active).not.toBeNull();
    expect(state?.active?.query).toBe("");
  });

  it("clears active state on close meta", () => {
    editor.chain().focus().insertContent("/").run();
    editor.view.dispatch(editor.state.tr.setMeta(slashCommandPluginKey, { type: "close" }));
    const state = slashCommandPluginKey.getState(editor.state);
    expect(state?.active).toBeNull();
  });

  it("updates selectedIndex on select meta", () => {
    editor.chain().focus().insertContent("/").run();
    const before = slashCommandPluginKey.getState(editor.state);
    expect(before?.active).not.toBeNull();
    editor.view.dispatch(
      editor.state.tr.setMeta(slashCommandPluginKey, { type: "select", selectedIndex: 3 }),
    );
    const state = slashCommandPluginKey.getState(editor.state);
    expect(state?.active?.selectedIndex).toBe(3);
  });

  it("returns null active when selection is non-empty", () => {
    editor.commands.setContent("<p>hello /world</p>");
    editor.commands.setTextSelection({ from: 1, to: 5 });
    const state = slashCommandPluginKey.getState(editor.state);
    expect(state?.active).toBeNull();
  });

  it("filters items by query and clamps selectedIndex", () => {
    editor.chain().focus().insertContent("/h").run();
    const state = slashCommandPluginKey.getState(editor.state);
    expect(state?.active?.query).toBe("h");
    // h1, h2, h3, horizontal-rule (via "horizontal"), task-list (via
    // "checkbox"/"checklist") — substring match on label + keywords.
    expect(filterSlashCommands("h")).toHaveLength(5);
    expect(state?.active?.selectedIndex).toBeLessThan(filterSlashCommands("h").length);
  });
});

describe("slash command open gating (#998)", () => {
  let editor: Editor;
  let container: HTMLDivElement;

  beforeEach(() => {
    ({ editor, container } = makeEditor());
  });

  afterEach(() => {
    editor.destroy();
    container.remove();
  });

  const active = () => slashCommandPluginKey.getState(editor.state)?.active ?? null;

  it("opens when '/' is typed (control)", () => {
    editor.chain().focus().insertContent("/").run();
    expect(active()).not.toBeNull();
  });

  it("does NOT re-open when the caret merely lands after an existing '/token'", () => {
    // Type "/h" -> menu opens. Doc is "<p>/h</p>": caret after "/h" is pos 3.
    editor.chain().focus().insertContent("/h").run();
    expect(active()).not.toBeNull();

    // Move the caret before the "/" -> menu closes (no trailing match).
    editor.commands.setTextSelection(1);
    expect(active()).toBeNull();

    // Click/arrow back to immediately after the "/h" (selection-only tr).
    // Pre-fix this re-derived a match and re-opened; the gate must keep it shut.
    editor.commands.setTextSelection(3);
    expect(active()).toBeNull();
  });

  it("does NOT open from a paste that contains a slash token", () => {
    editor.chain().focus().run();
    const pos = editor.state.selection.from;
    // "/h" matches real commands, so absent the gate resolveActiveSlashCommand
    // would return active -- this asserts the paste meta blocks the open.
    const tr = editor.state.tr.insertText("/h", pos);
    tr.setMeta("uiEvent", "paste");
    tr.setMeta("paste", true);
    editor.view.dispatch(tr);
    expect(active()).toBeNull();
  });

  it("does NOT open from a drop that contains a slash token", () => {
    editor.chain().focus().run();
    const pos = editor.state.selection.from;
    const tr = editor.state.tr.insertText("/h", pos);
    tr.setMeta("uiEvent", "drop");
    editor.view.dispatch(tr);
    expect(active()).toBeNull();
  });

  it("does NOT open from a remote (y-sync) insertion", () => {
    editor.chain().focus().run();
    const pos = editor.state.selection.from;
    const tr = editor.state.tr.insertText("/h", pos);
    tr.setMeta("y-sync$", true);
    editor.view.dispatch(tr);
    expect(active()).toBeNull();
  });

  it("opens when '/' is typed over a non-empty selection", () => {
    editor.chain().focus().insertContent("world").run();
    editor.commands.setTextSelection({ from: 1, to: 6 });
    expect(active()).toBeNull();
    editor.chain().insertContent("/").run();
    expect(active()).not.toBeNull();
    expect(active()?.query).toBe("");
  });

  it("does NOT re-open when backspacing the query after Escape-dismiss", () => {
    // Type "/h1" (opens; matches heading-1), Escape (dismiss), then backspace
    // the "1". The delete changes the token to "/h" (a different dismissedKey,
    // still matching commands), so only the typed-insertion gate -- not
    // dismissedKey -- keeps the menu closed.
    editor.chain().focus().insertContent("/h1").run();
    expect(active()).not.toBeNull();
    editor.view.dispatch(editor.state.tr.setMeta(slashCommandPluginKey, { type: "close" }));
    expect(active()).toBeNull();
    editor.commands.deleteRange({ from: 3, to: 4 }); // delete "1" -> token "/h"
    expect(active()).toBeNull();
  });
});

describe("slash command plugin keyboard handling", () => {
  let editor: Editor;
  let container: HTMLDivElement;

  beforeEach(() => {
    ({ editor, container } = makeEditor());
    editor.chain().focus().insertContent("/").run();
  });

  afterEach(() => {
    editor.destroy();
    container.remove();
  });

  it("ArrowDown wraps selectedIndex modulo item count", () => {
    const before = slashCommandPluginKey.getState(editor.state);
    expect(before?.active).not.toBeNull();

    for (let i = 0; i < SLASH_COMMANDS.length; i++) {
      editor.view.dom.dispatchEvent(
        new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true, cancelable: true }),
      );
    }

    const state = slashCommandPluginKey.getState(editor.state);
    expect(state?.active?.selectedIndex).toBe(0);
  });

  it("Enter executes the selected command and closes the menu", () => {
    const before = slashCommandPluginKey.getState(editor.state);
    expect(before?.active).not.toBeNull();

    editor.view.dom.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }),
    );

    const state = slashCommandPluginKey.getState(editor.state);
    expect(state?.active).toBeNull();
  });
});
