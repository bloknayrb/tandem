import { Editor } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  filterSlashCommands,
  findSlashCommandMatch,
  SLASH_COMMANDS,
  SlashCommandExtension,
  slashCommandPluginKey,
} from "../../src/client/editor/extensions/slash-command";

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
    expect(filterSlashCommands("h")).toHaveLength(2);
    expect(state?.active?.selectedIndex).toBeLessThan(filterSlashCommands("h").length);
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
