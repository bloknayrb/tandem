import { Editor } from "@tiptap/core";
import Collaboration from "@tiptap/extension-collaboration";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ySyncPluginKey } from "y-prosemirror";
import * as Y from "yjs";
import { buildSchemaExtensions } from "../../src/client/editor/editor-extensions";
import {
  filterSlashCommands,
  findSlashCommandMatch,
  SLASH_COMMANDS,
  SlashCommandExtension,
  slashCommandPluginKey,
} from "../../src/client/editor/slash-menu";
import { loadMarkdown, saveMarkdown } from "../../src/server/file-io/markdown";

/**
 * THE PRODUCTION SCHEMA, and that is the point of this helper (#1720).
 *
 * This suite used to build `StarterKit.configure({ history: false })` plus the
 * four stock Table extensions. The shipped editor (`Editor.svelte`) builds
 * `buildSchemaExtensions()`, which configures StarterKit
 * `{ listItem: false, paragraph: false }` and substitutes `ListItemCheckbox`
 * (content `block+`, widened for #1664) and `SoftWrapParagraph`, and registers
 * the table nodes itself. Stock `listItem` is `paragraph block*`.
 *
 * That one difference produced a wrong bug report. `<li><h2>x</h2></li>` is
 * ILLEGAL under `paragraph block*`, so ProseMirror repairs it at PARSE time —
 * inserting an empty paragraph and pushing the heading out to the parent item —
 * and #1720 read the repair as slash-command corruption. Under `block+` the
 * shape is legal, parses intact, and the command retypes it in place. A suite
 * that measures a schema production does not use has already cost one wrong
 * diagnosis; it does not get to cost a second.
 *
 * The `Y.Doc` is not incidental either: `Collaboration` is what puts a real
 * `ySyncPlugin` in the state, which the remote-insertion spec below needs in
 * order to be testing anything.
 */
function makeEditor() {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const ydoc = new Y.Doc();
  const editor = new Editor({
    element: container,
    extensions: [
      ...buildSchemaExtensions(),
      Collaboration.configure({ document: ydoc }),
      SlashCommandExtension,
    ],
  });
  return { editor, container, ydoc };
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

  function runParagraphOn(target: Editor) {
    const command = SLASH_COMMANDS.find((c) => c.id === "paragraph");
    if (!command) throw new Error("paragraph command missing");
    command.run(target);
  }

  function runParagraph() {
    runParagraphOn(editor);
  }

  /** First position inside the text node containing `needle`. */
  function posOf(target: Editor, needle: string): number {
    let found = -1;
    target.state.doc.descendants((node, pos) => {
      if (found >= 0) return false;
      if (node.isText && node.text?.includes(needle)) {
        found = pos + node.text.indexOf(needle) + 1;
        return false;
      }
      return true;
    });
    if (found < 0) throw new Error(`"${needle}" not found in ${target.getHTML()}`);
    return found;
  }

  // Pins ARRAY POSITION 0, which is the one thing the source comment calls
  // load-bearing and which every filter assertion below fails to cover: they
  // pin RELATIVE order inside a filtered result, so moving Paragraph to index 1
  // leaves them all green while `/` + Enter — the bare-menu flow, no query —
  // silently inserts Heading 1. The E2E did not cover it either: with
  // [heading-1, paragraph, heading-2] two ArrowDowns still land on heading-2.
  it("sits at index 0 so the bare menu defaults to it", () => {
    expect(SLASH_COMMANDS[0]?.id).toBe("paragraph");
  });

  it("is the only match for its own label", () => {
    expect(filterSlashCommands("paragraph").map((c) => c.id)).toEqual(["paragraph"]);
  });

  // The label match above exercises NO keyword, so without this the whole
  // keyword set could be deleted and the suite would stay green. These four are
  // the discoverability aliases — the words someone types when they do not know
  // the command is called "Paragraph".
  it.each([
    "normal",
    "body",
    "text",
    "plain",
    "reset",
  ])("is reachable by the '%s' alias", (alias) => {
    expect(filterSlashCommands(alias).map((c) => c.id)).toContain("paragraph");
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
  // the filter haystack, so the "p" alias contributes nothing to matching —
  // array order is what puts Paragraph first. Moving it later makes `/p`
  // resolve to a code block, which this catches.
  it("is what '/p' resolves to first", () => {
    expect(filterSlashCommands("p")[0]?.id).toBe("paragraph");
  });

  // The filter order above is only half the story, and the half that is easy to
  // mistake for the whole. The plugin carries the PREVIOUS selectedIndex across
  // a query change rather than resetting to 0, so "first in the filtered list"
  // and "what Enter runs" coincide only on the arrow-free path. Measured here
  // both ways so the source comment's claim is pinned rather than asserted:
  // type `/p` and Enter runs paragraph; press ArrowDown twice first and the
  // carried index 2 runs horizontal-rule instead. Not a defect — sticky
  // selection is deliberate — but a reader who believes the index resets will
  // not think to test this path.
  it("carries the previous selectedIndex across a query change", () => {
    editor.chain().focus().insertContent("/").run();
    for (let i = 0; i < 2; i++) {
      const active = slashCommandPluginKey.getState(editor.state)?.active;
      if (!active) throw new Error("menu closed unexpectedly");
      const next = (active.selectedIndex + 1) % filterSlashCommands(active.query).length;
      editor.view.dispatch(
        editor.state.tr.setMeta(slashCommandPluginKey, { type: "select", selectedIndex: next }),
      );
    }
    editor.chain().focus().insertContent("p").run();

    const active = slashCommandPluginKey.getState(editor.state)?.active;
    expect(active?.query).toBe("p");
    expect(active?.selectedIndex).toBe(2);
    expect(filterSlashCommands("p")[active?.selectedIndex ?? 0]?.id).toBe("horizontal-rule");
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
  // `RangeError: Invalid content for node type hardBreak` here. The explicit
  // clearNodes lifts the block correctly; it is setNode's INTERNAL clearNodes
  // fallback that breaks, reading a position from the already-mutated chained
  // doc and re-mapping it through the transaction's accumulated mapping. The
  // double-mapped position lands inside the paragraph's inline content, where
  // contentMatchAt().defaultType is hardBreak.
  //
  // The trigger is BROADER than these two fixtures: measured against
  // @tiptap/core 2.27.2 the hardened form throws on any block that is not the
  // first child of its wrapper — an ordered list, a blockquote, and a plain
  // paragraph as readily as a heading. So the leading `<p>x</p>` is
  // load-bearing in both fixtures; drop it and neither form throws. Two cases
  // are pinned rather than the whole matrix because the matrix belongs to
  // Tiptap, not to us — these are the two a maintainer would hit.
  //
  // Plain setParagraph() does not throw, which is why the command is written
  // that way. This test is what stops someone "hardening" it back.
  // Asserting the OUTPUT, not merely `not.toThrow()`. A throw still fails the
  // test (the expectation never runs), so this keeps the full crash pin AND
  // additionally pins the correct conversion — strictly stronger at no cost.
  it("converts a heading that follows a paragraph inside a list item", () => {
    editor.commands.setContent("<ul><li><p>x</p><h2>hello</h2></li></ul>");
    editor.commands.setTextSelection(8);
    runParagraph();
    expect(editor.getHTML()).toBe("<ul><li><p>x</p><p>hello</p></li></ul>");
  });

  it("converts a code block that follows a paragraph inside a list item", () => {
    editor.commands.setContent("<ul><li><p>x</p><pre><code>hello</code></pre></li></ul>");
    editor.commands.setTextSelection(8);
    runParagraph();
    expect(editor.getHTML()).toBe("<ul><li><p>x</p><p>hello</p></li></ul>");
  });

  /**
   * #1720 reported that a heading or code block in a DOUBLY-nested list item
   * comes out corrupted — an orphan empty `<li>` plus the converted block
   * re-parented into the outer item. It does not, under the schema this editor
   * actually has. The report was measured against a stock-StarterKit harness,
   * where `listItem` is `paragraph block*` and `<li><h2>` is illegal, so the
   * damage is done by ProseMirror's PARSE-TIME repair before any command runs.
   *
   * Each case therefore asserts TWICE, and the first assertion is the load-
   * bearing one. Pinning only the post-command HTML would go red under a
   * revert of `ListItemCheckbox`'s `block+` — but it would read as a slash-
   * command regression, sending the next person into `commands.ts` and its
   * `clearNodes` docblock. The parse assertion says where the break is.
   */
  const DEEP_CASES: Array<[string, string, string]> = [
    [
      "a heading",
      "<ul><li><p>a</p><ul><li><h2>deep</h2></li></ul></li></ul>",
      "<ul><li><p>a</p><ul><li><p>deep</p></li></ul></li></ul>",
    ],
    [
      "a code block",
      "<ul><li><p>a</p><ul><li><pre><code>deep</code></pre></li></ul></li></ul>",
      "<ul><li><p>a</p><ul><li><p>deep</p></li></ul></li></ul>",
    ],
    [
      "a heading that follows a paragraph in the same item",
      "<ul><li><p>a</p><ul><li><p>x</p><h2>deep</h2></li></ul></li></ul>",
      "<ul><li><p>a</p><ul><li><p>x</p><p>deep</p></li></ul></li></ul>",
    ],
    [
      "a heading in an ordered list",
      "<ol><li><p>a</p><ol><li><h2>deep</h2></li></ol></li></ol>",
      "<ol><li><p>a</p><ol><li><p>deep</p></li></ol></li></ol>",
    ],
  ];

  it.each(
    DEEP_CASES,
  )("parses %s in a doubly-nested item intact, then retypes it in place (#1720)", (_label, input, expected) => {
    editor.commands.setContent(input);
    // Parse-time. A `paragraph block*` listItem reports HERE, naming the
    // schema rather than the command.
    expect(editor.getHTML()).toBe(input);

    editor.commands.setTextSelection(posOf(editor, "deep"));
    runParagraph();
    expect(editor.getHTML()).toBe(expected);
  });

  /**
   * The behaviour #1720 got right, pinned as CURRENT behaviour rather than as
   * desired behaviour.
   *
   * `/p` on a block that is ALREADY a paragraph has nothing to retype, so
   * `setNode` falls through to `clearNodes()`, which lifts out of EVERY
   * wrapper. At depth 1 with no siblings that is the documented reset above
   * ("resets a list item to a top-level paragraph"). With siblings it must
   * split the list — you cannot have a paragraph in the middle of one — and at
   * depth 2 the lift goes all the way to the document root, taking the OUTER
   * list apart as well. The issue's own table calls the sibling-free version of
   * this "lifts correctly".
   *
   * Whether the lift should stop at the nearest list item instead is a design
   * question, tracked separately. These pins exist so that changing it is a
   * deliberate act with a visible diff, and so nobody re-derives the current
   * shape from scratch the way #1720 did.
   */
  const LIFT_CASES: Array<[string, string, string]> = [
    [
      "splits the list when the item has siblings",
      "<ul><li><p>x</p></li><li><p>deep</p></li></ul>",
      "<ul><li><p>x</p></li></ul><p>deep</p>",
    ],
    [
      "lifts to the document ROOT from depth 2, taking the outer list apart",
      "<ul><li><p>a</p><ul><li><p>x</p></li><li><p>deep</p></li></ul></li></ul>",
      "<ul><li><p>a</p></li></ul><ul><li><p>x</p></li></ul><p>deep</p>",
    ],
  ];

  it.each(LIFT_CASES)("/p on an already-paragraph item %s", (_label, input, expected) => {
    editor.commands.setContent(input);
    editor.commands.setTextSelection(posOf(editor, "deep"));
    runParagraph();
    expect(editor.getHTML()).toBe(expected);
  });

  it("leaves the nesting alone when the target is NOT already a paragraph", () => {
    // The discriminator for the two blocks above, and the reason the
    // precondition is "already a paragraph" rather than "nested": the same
    // shape with a heading in it retypes in place and keeps both lists. Without
    // this, "nesting is what breaks it" survives every other spec here.
    editor.commands.setContent(
      "<ul><li><p>a</p><ul><li><p>x</p></li><li><h2>deep</h2></li></ul></li></ul>",
    );
    editor.commands.setTextSelection(posOf(editor, "deep"));
    runParagraph();
    expect(editor.getHTML()).toBe(
      "<ul><li><p>a</p><ul><li><p>x</p></li><li><p>deep</p></li></ul></li></ul>",
    );
  });

  it("round-trips a doubly-nested heading through markdown (#1720)", () => {
    // The user-facing statement of the same fact, and the surface a schema
    // regression reaches first: what lands on disk. `setContent` above proves
    // the command; this proves the whole chain the user actually drives —
    // markdown -> Y.Doc -> ProseMirror -> command -> Y.Doc -> markdown.
    const { editor: bound, container: boundContainer, ydoc } = makeEditor();
    try {
      loadMarkdown(ydoc, "- a\n\n  - ## deep\n");
      bound.commands.setTextSelection(posOf(bound, "deep"));
      runParagraphOn(bound);
      expect(saveMarkdown(ydoc)).toBe("- a\n\n  - deep\n");
    } finally {
      // The suite's own afterEach only owns the beforeEach editor, so this
      // second one cleans up after itself — `makeEditor` appends to
      // document.body, and a discarded handle leaks the node for the rest of
      // the run.
      bound.destroy();
      boundContainer.remove();
      ydoc.destroy();
    }
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
    // Asserting ids rather than a length: same revert-protection, but a failure
    // names WHAT changed instead of reporting `6 !== 7`, and it pins order too.
    expect(filterSlashCommands("h").map((command) => command.id)).toEqual([
      "paragraph",
      "heading-1",
      "heading-2",
      "heading-3",
      "task-list",
      "horizontal-rule",
    ]);
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
    // The forged meta is `{ isChangeOrigin: true }` and NOT a bare `true`, and
    // the difference is the whole spec. The slash menu itself only checks
    // truthiness, so a boolean satisfies its gate and this assertion passes
    // either way — but the REAL `ySyncPlugin.apply` reads `change.isChangeOrigin`
    // off the meta value, gets `undefined` from a boolean, and treats the
    // transaction as an ordinary LOCAL edit. Under a boolean this spec silently
    // tests local-insertion suppression while claiming to test remote.
    //
    // The plugin-state read is the assertion that can actually fail, and it is
    // NOT the more obvious "the text never reached the Y.Doc" — that one is
    // false, which measuring it is how I found out. `ySyncPlugin`'s view update
    // diffs the PM doc into the CRDT outside the origin check, so a forged
    // remote transaction propagates either way; `isChangeOrigin` governs
    // re-entrancy, and the plugin's own state is the only place a bare `true`
    // is visibly discarded.
    editor.chain().focus().run();
    const pos = editor.state.selection.from;
    const tr = editor.state.tr.insertText("/h", pos);
    tr.setMeta("y-sync$", { isChangeOrigin: true });
    editor.view.dispatch(tr);

    expect(active()).toBeNull();
    expect(ySyncPluginKey.getState(editor.state)?.isChangeOrigin).toBe(true);
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
