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

/** A `"\n"` that was structure rather than text. Mirrors `FlatBreak` server-side. */
export interface RestoreBreak {
  at: number;
  kind: "block" | "block-opaque" | "hard";
}

/**
 * Rebuild the document structure a flat snapshot came from (#1486).
 *
 * `literalInlineContent` above answers "what did the AI mean to type", where
 * every newline is a hard break because that is the one thing a suggestion
 * string can mean. This answers a different question — "what was actually
 * THERE" — and the answer has three cases, not one:
 *
 *   block boundary  -> a new block           serializes as a blank line
 *   hard break      -> a `hardBreak` node    serializes as a trailing `\`
 *   anything else   -> a literal newline     serializes as a soft wrap
 *
 * The flat string spells all three `"\n"`, so `breaks` is the only thing that
 * can tell them apart. Restoring the wrong one is not a cosmetic slip: it
 * writes a change to the file that the user never made, which is the whole
 * reason undo needed structure rather than characters.
 *
 * `breaks` empty or absent ⇒ every newline is literal, which is what the code
 * before this did and what records written before it imply.
 *
 * Returns `blocks: false` when the content stays inside one block — the caller
 * then inserts inline and the surrounding block is untouched, which is both the
 * common case and the conservative one.
 *
 * Returns `opaque: true` when the snapshot spans a boundary the server marked
 * unrebuildable — a `"block-opaque"` kind, meaning the two blocks were not both
 * plain paragraphs. This function only knows how to emit paragraphs, so a
 * heading on either side would come back demoted to body text: a change to the
 * file the user never made, which is the defect this whole field exists to stop.
 * The caller must DECLINE on `opaque`, not fall back to an inline restore —
 * falling back would put a literal newline where the boundary was, which the
 * markdown serializer writes as a setext underline or an `&#xA;` entity.
 */
export function literalRestoreContent(
  text: string,
  breaks: readonly RestoreBreak[] = [],
  marks: JSONContent["marks"] = undefined,
): { content: JSONContent[]; blocks: boolean; opaque: boolean } {
  const textNode = (value: string): JSONContent =>
    marks?.length ? { type: "text", text: value, marks } : { type: "text", text: value };

  // Defensive sort + bounds filter: these offsets come off a stored record and
  // are used as slice indices. An out-of-range or unordered entry would produce
  // silently mangled content rather than an error.
  //
  // The `"\n"` check is the one that matters in practice. A break's whole job is
  // to say what a newline WAS, and the code below steps over one character at
  // each recorded position — so an offset pointing at anything else eats a real
  // character. That is reachable without any corruption: `textSnapshot` and
  // `textSnapshotBreaks` are captured together but the range can be relocated
  // afterwards, at which point the offsets describe text that has moved on.
  const usable = [...breaks]
    .filter((b) => Number.isInteger(b.at) && b.at >= 0 && b.at < text.length && text[b.at] === "\n")
    .sort((a, b) => a.at - b.at);

  const opaque = usable.some((b) => b.kind === "block-opaque");
  const blockAt = usable.filter((b) => b.kind === "block").map((b) => b.at);
  const hardAt = usable.filter((b) => b.kind === "hard").map((b) => b.at);

  /** Inline content for one block's slice, splitting only at hard breaks. */
  const inlineFor = (start: number, end: number): JSONContent[] => {
    const out: JSONContent[] = [];
    let cursor = start;
    for (const at of hardAt) {
      if (at < start || at >= end) continue;
      if (at > cursor) out.push(textNode(text.slice(cursor, at)));
      out.push({ type: "hardBreak" });
      cursor = at + 1; // step over the "\n" the break itself occupies
    }
    if (cursor < end) out.push(textNode(text.slice(cursor, end)));
    return out;
  };

  if (blockAt.length === 0) {
    return { content: inlineFor(0, text.length), blocks: false, opaque };
  }

  const content: JSONContent[] = [];
  let start = 0;
  for (const at of [...blockAt, text.length]) {
    const inline = inlineFor(start, at);
    // `content` omitted rather than `[]` for an empty block: an empty array is
    // not valid paragraph content in ProseMirror, while an absent one is.
    content.push(
      inline.length > 0 ? { type: "paragraph", content: inline } : { type: "paragraph" },
    );
    start = at + 1; // step over the boundary "\n"
  }
  return { content, blocks: true, opaque };
}
