import { Extension } from "@tiptap/core";

/**
 * The fence info string's meta half (#1799).
 *
 * A fence is ```` ```ts title="x.ts" {1,3} ````: the first token is the
 * language, the rest is mdast's `meta` — the Docusaurus/MkDocs/Shiki tail.
 * The server stores them as two Y.Doc attributes, `language` and `meta`.
 *
 * `meta` needs a schema declaration for the same reason `spread` does: without
 * one, `computeAttrs` discards it when the ProseMirror doc is built from the
 * Y.Doc and `updateYFragment` then prunes it from the Y.Doc on the next write,
 * so the value is gone from disk on the user's first edit.
 *
 * It is a SEPARATE attribute rather than a suffix on `language`, and that is
 * the whole point of this file. Tiptap's CodeBlock renders `language` into the
 * code element's `class` (`language-<value>`) and parses it back off
 * `classList`, so a value containing a space becomes several classes and reads
 * back as its first token: storing the combined info string means copying a
 * fence inside the editor and pasting it — a clipboard HTML round trip —
 * silently truncates ```` ```js title="x.ts" {1,3} ```` to ```` ```js ````.
 *
 * Round-trips through the DOM, like `spread` and unlike the `markdownRaw` /
 * `markdownHtml` markers next door: the copy/paste path IS the case this
 * exists for, so `parseHTML: () => null` would give back the bug. Forged HTML
 * can therefore put arbitrary text in `meta`, which is why the value is
 * normalised to a single line at the mdast boundary (`mdast-ydoc.ts`,
 * `case "codeBlock"`) before it can be written onto a fence line.
 */
export const CodeBlockFenceMeta = Extension.create({
  name: "codeBlockFenceMeta",

  addGlobalAttributes() {
    return [
      {
        types: ["codeBlock"],
        attributes: {
          meta: {
            default: null,
            parseHTML: (element: HTMLElement) => element.getAttribute("data-meta") || null,
            renderHTML: (attributes: Record<string, unknown>) =>
              attributes.meta ? { "data-meta": String(attributes.meta) } : {},
          },
        },
      },
    ];
  },
});
