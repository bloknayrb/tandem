import * as Y from "yjs";
import { insertDeltaSegments, isHardBreakElement } from "../mcp/document-model.js";

/**
 * Rewrite every `hardBreak` embed that lives INSIDE a Y.XmlText into a standalone
 * sibling `Y.XmlElement("hardBreak")` child of the block, splitting the surrounding
 * text into separate Y.XmlText siblings.
 *
 * Why: the importers (`docx-html.ts`, `mdast-ydoc.ts`) create a hard break as
 * `xmlText.insertEmbed(len, new Y.XmlElement("hardBreak"))`. y-prosemirror's
 * `createTextNodesFromYText` has no branch for embed inserts — it feeds the embed
 * into `schema.text(...)`, which stringifies the Y.XmlElement (lowercased) to the
 * literal text `<hardbreak></hardbreak>`. y-prosemirror only renders a hardBreak as
 * a standalone sibling element (the shape user-typed Shift+Enter produces). This
 * pass converts the imported (embed) shape into that sibling shape.
 *
 * Flat text and flat length are byte-invariant: an inline-leaf `hardBreak` sibling
 * contributes exactly one `\n` (see `getElementText`/`getElementTextLength` in
 * `mcp/document-model.ts`), the same single `\n` the embed produced.
 *
 * MUST run inside the caller's origin-tagged transaction (`withInternal` /
 * `withReload` / `withMcp`) — it performs Y.Doc structural writes. Pass the freshly
 * attached top-level elements (NOT the whole fragment) so `appendMdast` only touches
 * newly inserted content and existing offsets stay put.
 */
export function normalizeHardBreaks(elements: Iterable<Y.XmlElement>): void {
  for (const element of elements) {
    normalizeElement(element);
  }
}

type DeltaOp = { insert: string | object; attributes?: Record<string, unknown> };
type Piece = { kind: "text"; segments: DeltaOp[] } | { kind: "break" };

/**
 * Recurse into container children (blockquote/listItem/tableCell/...) and rewrite
 * hardBreak embeds found in any direct Y.XmlText child. Mutates in place with an
 * explicit index because the child list changes as we split.
 */
function normalizeElement(element: Y.XmlElement): void {
  let i = 0;
  while (i < element.length) {
    const child = element.get(i);

    if (child instanceof Y.XmlElement) {
      normalizeElement(child); // containers AND textblocks; codeBlock has no breaks
      i += 1;
      continue;
    }

    if (!(child instanceof Y.XmlText)) {
      i += 1;
      continue;
    }

    const delta = child.toDelta() as DeltaOp[];
    if (!delta.some((op) => isHardBreakElement(op.insert))) {
      i += 1;
      continue;
    }

    const pieces = splitDeltaOnHardBreak(delta);
    element.delete(i, 1); // drop the original XmlText

    let insertAt = i;
    for (const piece of pieces) {
      if (piece.kind === "break") {
        element.insert(insertAt, [new Y.XmlElement("hardBreak")]);
      } else {
        const text = new Y.XmlText();
        element.insert(insertAt, [text]); // ATTACH before populating (ordering gotcha)
        insertDeltaSegments(text, piece.segments);
      }
      insertAt += 1;
    }

    i = insertAt; // resume after the rewritten run
  }
}

/**
 * Split a delta into text/break pieces. ALWAYS flush a (possibly empty) text piece
 * around every break — the empty text piece before a leading break preserves an
 * empty leading Y.XmlText, which keeps `getElementTextLength` byte-identical to the
 * embed representation for a paragraph-leading break.
 */
function splitDeltaOnHardBreak(delta: DeltaOp[]): Piece[] {
  const pieces: Piece[] = [];
  let current: DeltaOp[] = [];
  const flush = () => {
    pieces.push({ kind: "text", segments: current });
    current = [];
  };
  for (const op of delta) {
    if (isHardBreakElement(op.insert)) {
      flush();
      pieces.push({ kind: "break" });
    } else {
      current.push(op);
    }
  }
  flush();
  return pieces;
}
