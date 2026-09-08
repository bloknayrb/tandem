// @vitest-environment happy-dom

/**
 * #1775 — the slash-command menu opened inside code blocks, and Enter then
 * converted the block or deleted the typed text.
 *
 * A `/` in a code block is literal: a path, a regex, a URL, a comment. The
 * resolver never asked what kind of block the caret was in, so the menu opened
 * offering Paragraph / Heading 1 / … and the plugin's `handleKeyDown` claimed
 * Enter — running a block conversion and eating the `/query` on the way.
 *
 * These are the E1 harness cases from the v1 review
 * (`docs/reviews/2026-09-02-v1-review/experiments/harness/e-keys.test.ts`) with
 * their assertions inverted, so the reproduction has a permanent home.
 */

import { Editor } from "@tiptap/core";
import { afterEach, describe, expect, it } from "vitest";
import { buildSchemaExtensions } from "../../src/client/editor/editor-extensions";
import { SlashCommandExtension, slashCommandPluginKey } from "../../src/client/editor/slash-menu";

let editor: Editor | null = null;

afterEach(() => {
  editor?.destroy();
  editor = null;
});

function makeEditor(content: string): Editor {
  editor = new Editor({
    extensions: [...buildSchemaExtensions(), SlashCommandExtension],
    content,
  });
  return editor;
}

/** Type a slash query at the very end of the document. */
function typeAtEnd(ed: Editor, query: string): void {
  ed.commands.setTextSelection(ed.state.doc.content.size - 1);
  for (const ch of query) ed.commands.insertContent(ch);
}

function pressEnter(ed: Editor): KeyboardEvent {
  const ev = new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true });
  ed.view.dom.dispatchEvent(ev);
  return ev;
}

function codeText(ed: Editor): string {
  let text = "";
  ed.state.doc.descendants((node) => {
    if (node.type.spec.code) text += node.textContent;
  });
  return text;
}

describe("slash menu inside a code block (#1775)", () => {
  it("never activates on '/e' typed in a code block", () => {
    const ed = makeEditor("<pre><code>echo hi\n</code></pre>");
    typeAtEnd(ed, "/e");
    // Not merely "Enter does nothing" — the menu must never open, which is what
    // a fix at the plugin's Enter branch alone would leave broken.
    expect(slashCommandPluginKey.getState(ed.state)?.active).toBeNull();
  });

  it("Enter after '/e' leaves the code block a code block with its text intact", () => {
    const ed = makeEditor("<pre><code>echo hi\n</code></pre>");
    typeAtEnd(ed, "/e");
    pressEnter(ed);
    expect(ed.getHTML()).toContain("<pre>");
    // `contains`, not equality: with the slash plugin declining, ProseMirror's
    // base Enter chain reaches `newlineInCode` and appends a literal newline.
    // That is the behaviour the user asked for, not a failure.
    expect(codeText(ed)).toContain("echo hi");
    expect(codeText(ed)).toContain("/e");
  });

  it("Enter after 'cd /t' keeps the typed path (the space-then-slash match path)", () => {
    const ed = makeEditor("<pre><code>cd </code></pre>");
    typeAtEnd(ed, "/t");
    expect(slashCommandPluginKey.getState(ed.state)?.active).toBeNull();
    pressEnter(ed);
    expect(ed.getHTML()).toContain("<pre>");
    expect(codeText(ed)).toContain("cd /t");
  });

  it("still activates on '/e' in a plain paragraph (the feature is not disabled)", () => {
    const ed = makeEditor("<p></p>");
    typeAtEnd(ed, "/e");
    const active = slashCommandPluginKey.getState(ed.state)?.active;
    expect(active).not.toBeNull();
    expect(active?.query).toBe("e");
  });
});
