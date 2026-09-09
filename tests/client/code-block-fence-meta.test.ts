/**
 * Fence meta survives a clipboard HTML round trip (#1799).
 *
 * The server stores a fence's info string as two Y.Doc attributes, `language`
 * and `meta`. The first cut stored the WHOLE info string in `language`, which
 * looks right in every server-side round-trip test and is lossy in the editor:
 * Tiptap's CodeBlock renders `language` into the code element's class
 * (`language-<value>`) and its `parseHTML` reads back the first
 * `language-`-prefixed class, so `js title="x.ts" {1,3}` becomes three classes
 * and parses back as `js`. Copying a fence and pasting it inside the editor
 * silently dropped the meta the fix exists to preserve.
 *
 * These drive the REAL production schema from `buildSchemaExtensions()` through
 * ProseMirror's own clipboard serialize/parse pair, so a `meta` attribute that
 * never reached the schema, or one declared with `parseHTML: () => null`, shows
 * up here rather than being papered over by asserting on the Y.Doc.
 */

import { Editor } from "@tiptap/core";
import { DOMParser, DOMSerializer } from "@tiptap/pm/model";
import { afterEach, describe, expect, it } from "vitest";
import { buildSchemaExtensions } from "../../src/client/editor/editor-extensions";

let open: { editor: Editor; container: HTMLDivElement } | null = null;

function makeEditor(content: string): Editor {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const editor = new Editor({
    element: container,
    extensions: buildSchemaExtensions(),
    content,
  });
  open = { editor, container };
  return editor;
}

afterEach(() => {
  open?.editor.destroy();
  open?.container.remove();
  open = null;
});

/**
 * Serialize the whole document to clipboard HTML and parse it straight back —
 * the copy/paste pair, minus the system clipboard.
 */
function roundTrip(editor: Editor): Record<string, unknown> {
  const { schema, doc } = editor.state;
  const html = document.createElement("div");
  html.appendChild(DOMSerializer.fromSchema(schema).serializeFragment(doc.content));
  const reparsed = DOMParser.fromSchema(schema).parse(html);
  return reparsed.firstChild?.attrs ?? {};
}

describe("code-block fence meta through the clipboard", () => {
  it("keeps language AND meta across a copy/paste round trip", () => {
    const editor = makeEditor(
      '<pre data-meta="title=&quot;x.ts&quot; {1,3}"><code class="language-js">const a = 1;</code></pre>',
    );
    expect(editor.state.doc.firstChild?.attrs).toMatchObject({
      language: "js",
      meta: 'title="x.ts" {1,3}',
    });
    expect(roundTrip(editor)).toMatchObject({
      language: "js",
      meta: 'title="x.ts" {1,3}',
    });
  });

  it("a combined info string in `language` is what the split storage avoids", () => {
    // Documents the mechanism rather than a behaviour we want: with the meta
    // appended to `language`, the class-based parse gives back only `js`. If
    // this ever stops being lossy, the split storage could be reconsidered.
    const editor = makeEditor('<pre><code class="language-js">const a = 1;</code></pre>');
    editor.commands.updateAttributes("codeBlock", { language: 'js title="x.ts" {1,3}' });
    expect(roundTrip(editor).language).toBe("js");
  });

  it("a fence with no meta round-trips with meta null, not an empty string", () => {
    const editor = makeEditor('<pre><code class="language-js">const a = 1;</code></pre>');
    expect(roundTrip(editor)).toMatchObject({ language: "js", meta: null });
  });

  it("foreign HTML with no data-meta parses to meta null", () => {
    const editor = makeEditor("<pre><code>plain</code></pre>");
    expect(editor.state.doc.firstChild?.attrs.meta).toBeNull();
  });
});
