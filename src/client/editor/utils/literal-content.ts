// Literal text → ProseMirror inline content (#1477).
//
// `insertContentAt(pos, someString)` does NOT insert that string. Tiptap routes
// a string through `createNodeFromContent`, which wraps it in `<body>` and runs
// `DOMParser` — so the argument is parsed as HTML. Measured through a LIVE
// editor, which is the only instrument that answers this correctly (see below):
//
//     "use <div> for layout"  -> "use " + a PARAGRAPH node (the block splits)
//     "<b>bold</b> text"      -> text carrying a bold mark
//     "one\ntwo"              -> one text node holding a LITERAL newline
//
// Both failure modes are live in the suggestion-accept path. A suggestion that
// merely MENTIONS a tag rewrote the document structure. And `suggestedText` /
// `textSnapshot` render every hard break as "\n" (the `getElementText()`
// convention), while a literal newline inside a paragraph is how this editor
// represents a SOFT wrap — so accepting over a break-bearing paragraph
// downgraded every hard break to a soft one, silently.
//
// Passing JSON content instead takes `createNodeFromContent`'s `Fragment.fromJSON`
// branch, which never parses.
//
// MEASUREMENT NOTE: calling `createNodeFromContent` in ISOLATION reports a
// collapsed space and decoded entities. Neither happens on the shipping path,
// whose paragraph carries `whitespace: "pre"` (#1461) — those readings put two
// wrong claims in #1477's original body. Measure through the Editor.

import type { JSONContent } from "@tiptap/core";

/** Matches a line ending in any of the three conventions. */
const LINE_ENDING = /\r\n|[\r\n]/;

/**
 * Build inline content that inserts `text` verbatim.
 *
 * `asCodeText` selects how a newline is represented, and the distinction is
 * real rather than defensive: `codeBlock` declares `code: true` and its content
 * expression does NOT admit `hardBreak`, so emitting break nodes there builds
 * schema-invalid content. Inside a code block a newline is genuinely a newline
 * and survives as one; everywhere else the editor models it as a `hardBreak`,
 * which is what the markdown serializer reads back as a hard break.
 *
 * `marks` must be the marks spanning the range being replaced, and passing them
 * is NOT optional polish — see `MARKS` below.
 *
 * Returns an EMPTY array for empty text. Callers must skip the insert in that
 * case — `insertContentAt` with `[]` logs a Tiptap warning and inserts an empty
 * fragment rather than being a clean no-op.
 *
 * MARKS. `insertContentAt` branches on `isOnlyTextContent`: a single unmarked
 * text node goes through `tr.insertText`, which inherits `$from.marksAcross($to)`
 * for free, while anything else goes through `tr.replaceWith`, which does not.
 * Since a newline is exactly what pushes this function from the first shape to
 * the second, leaving marks off would make the SAME suggestion keep its bold on
 * one line and lose it on two — a silent formatting change that reaches disk.
 * Stamping them explicitly makes both branches agree.
 */
export function literalInlineContent(
  text: string,
  asCodeText = false,
  marks: JSONContent["marks"] = undefined,
): JSONContent[] {
  if (text.length === 0) return [];
  const textNode = (value: string): JSONContent =>
    marks?.length ? { type: "text", text: value, marks } : { type: "text", text: value };

  if (asCodeText) return [textNode(text)];

  const content: JSONContent[] = [];
  const segments = text.split(LINE_ENDING);
  for (const [i, segment] of segments.entries()) {
    // The break goes BETWEEN segments, so a leading/trailing newline still
    // produces its break even though the segment beside it is empty.
    if (i > 0) content.push({ type: "hardBreak" });
    // A zero-length text node is invalid in ProseMirror.
    if (segment.length > 0) content.push(textNode(segment));
  }
  return content;
}
