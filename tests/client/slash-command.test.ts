import { Editor } from "@tiptap/core";
import Table from "@tiptap/extension-table";
import TableCell from "@tiptap/extension-table-cell";
import TableHeader from "@tiptap/extension-table-header";
import TableRow from "@tiptap/extension-table-row";
import StarterKit from "@tiptap/starter-kit";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
    extensions: [
      StarterKit.configure({ history: false }),
      Table,
      TableRow,
      TableCell,
      TableHeader,
      SlashCommandExtension,
    ],
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

  it("finds the table command by label and keyword (#995)", () => {
    expect(filterSlashCommands("table").map((command) => command.id)).toEqual(["table"]);
    expect(filterSlashCommands("grid").map((command) => command.id)).toEqual(["table"]);
  });
});

describe("table slash command (#995)", () => {
  // Fixed 3x3 with header row -- alignment/row-col ops/header toggle/merge
  // are deferred scope, not implemented here.
  it("inserts a fixed 3x3 table with a header row via the chain", () => {
    const insertTable = vi.fn().mockReturnThis();
    const fakeChain = {
      focus: vi.fn().mockReturnThis(),
      insertTable,
      run: vi.fn(),
    };
    const fakeEditor = { chain: () => fakeChain } as unknown as Editor;

    const tableCommand = SLASH_COMMANDS.find((command) => command.id === "table");
    expect(tableCommand).toBeDefined();
    tableCommand?.run(fakeEditor);

    expect(insertTable).toHaveBeenCalledWith({ rows: 3, cols: 3, withHeaderRow: true });
    expect(fakeChain.run).toHaveBeenCalled();
  });

  it("inserts a real table node into the document", () => {
    const { editor, container } = makeEditor();
    try {
      const tableCommand = SLASH_COMMANDS.find((command) => command.id === "table");
      tableCommand?.run(editor);

      let tableNode: { type: { name: string }; childCount: number } | null = null;
      editor.state.doc.descendants((node) => {
        if (node.type.name === "table") tableNode = node as typeof tableNode & object;
      });
      expect(tableNode).not.toBeNull();
      // 1 header row + 2 body rows = 3 total rows.
      expect((tableNode as unknown as { childCount: number }).childCount).toBe(3);
    } finally {
      editor.destroy();
      container.remove();
    }
  });
});

describe("paragraph slash command", () => {
  let editor: Editor;
  let container: HTMLDivElement;

  beforeEach(() => {
    ({ editor, container } = makeEditor());
  });

  afterEach(() => {
    editor.destroy();
    container.remove();
  });

  function runParagraph() {
    const command = SLASH_COMMANDS.find((c) => c.id === "paragraph");
    if (!command) throw new Error("paragraph command missing");
    command.run(editor);
  }

  // Revert-pin for the KEYWORD set.
  it("is the only match for its own label", () => {
    expect(filterSlashCommands("paragraph").map((c) => c.id)).toEqual(["paragraph"]);
  });

  // "para" is NOT unique, which is genuinely surprising and worth pinning
  // rather than leaving for the next person to rediscover: horizontal-rule
  // carries the keyword "se-para-tor", so a substring match on "para" catches
  // it too. Paragraph still wins on order. If that ever flips, `/para` + Enter
  // silently inserts a horizontal rule.
  it("still ranks first for the ambiguous 'para' prefix", () => {
    expect(filterSlashCommands("para").map((c) => c.id)).toEqual(["paragraph", "horizontal-rule"]);
  });

  // Revert-pin for PLACEMENT, which is the load-bearing half. `hint` is not in
  // the filter haystack, so the "p" alias contributes nothing — only array
  // order decides. Moving Paragraph later makes `/p` + Enter insert a code
  // block (keyword "pre"), which this catches.
  it("is what '/p' resolves to first", () => {
    expect(filterSlashCommands("p")[0]?.id).toBe("paragraph");
  });

  it("resets a list item to a top-level paragraph", () => {
    editor.commands.setContent("<ul><li><p>hello</p></li></ul>");
    editor.commands.setTextSelection(4);
    runParagraph();
    expect(editor.getHTML()).toBe("<p>hello</p>");
  });

  // Documents SHIPPED behaviour, and it is the inverse of what you may expect:
  // the wrapper survives only when the block is NOT already a paragraph. A
  // blockquoted paragraph unwraps completely; a blockquoted heading keeps its
  // quote and only retypes the block. Unwrapping that second case needs two
  // SEPARATE command calls, not a longer chain — see the throw test below.
  it("unwraps a blockquoted paragraph but only retypes a blockquoted heading", () => {
    editor.commands.setContent("<blockquote><p>hello</p></blockquote>");
    editor.commands.setTextSelection(4);
    runParagraph();
    expect(editor.getHTML()).toBe("<p>hello</p>");

    editor.commands.setContent("<blockquote><h2>hello</h2></blockquote>");
    editor.commands.setTextSelection(4);
    runParagraph();
    expect(editor.getHTML()).toBe("<blockquote><p>hello</p></blockquote>");
  });

  // THE regression pin. `chain().clearNodes().setParagraph().run()` throws
  // `RangeError: Invalid content for node type hardBreak` on this exact
  // document: the explicit clearNodes lifts the block, then setNode's INTERNAL
  // clearNodes fallback re-runs over stale mapped positions and
  // contentMatchAt().defaultType resolves to hardBreak.
  //
  // Plain setParagraph() does not throw, which is why the command is written
  // that way. This test is what stops someone "hardening" it back.
  it("does not throw on a heading that follows a paragraph inside a list item", () => {
    editor.commands.setContent("<ul><li><p>x</p><h2>hello</h2></li></ul>");
    editor.commands.setTextSelection(8);
    expect(() => runParagraph()).not.toThrow();
  });

  it("does not throw on a code block inside a list item", () => {
    editor.commands.setContent("<ul><li><p>x</p><pre><code>hello</code></pre></li></ul>");
    editor.commands.setTextSelection(8);
    expect(() => runParagraph()).not.toThrow();
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
    // "checkbox"/"checklist"), and paragraph — whose LABEL ends in "h", which
    // is easy to miss when scanning keywords. Substring match on label +
    // keywords, so a match can come from either.
    //
    // This is a counter, not a behavioural pin: it goes red for any new command
    // containing "h" anywhere in its label or keywords. Bump it knowingly.
    expect(filterSlashCommands("h")).toHaveLength(6);
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
