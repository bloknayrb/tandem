import * as Y from "yjs";
import { insertDeltaSegments, isHardBreakElement, TEXTBLOCK_NODES } from "../mcp/document-model.js";

/** One delta op, matching `insertDeltaSegments`' input shape. */
type Segment = { insert: string | object; attributes?: Record<string, unknown> };

/**
 * Flatten newlines out of a plaintext document's textblocks (#1460).
 *
 * Used at ONE point: Save-As promotion. `saveDocumentAsToDisk` promotes a
 * document in place — same docId, same Y.Doc, same provider, `format` swapped to
 * the target — so a `.md` scratchpad holding a hard break becomes a live `.txt`
 * document still holding it. Every later autosave then writes bytes whose line
 * count disagrees with the model, and the next open believes the bytes.
 *
 * The client guards (`extensions/plaintext-breaks.ts`, `utils/paste-breaks.ts`)
 * cannot cover this: nothing was typed or pasted. The content was legitimate
 * when it was created and only became unrepresentable when the destination
 * changed under it.
 *
 * **Why this is safe against a live document, when a save-time normalizer was
 * not.** Two properties, the first measured rather than assumed:
 *
 *   1. It is BYTE-NEUTRAL. `extractText` renders a hard break as `"\n"` and a
 *      block boundary as `"\n"`, so the flat projection is identical before and
 *      after. That is what makes annotations safe: when a `relRange` anchor dies
 *      with the replaced content, `refreshRange` re-anchors from the stored FLAT
 *      offsets (`positions.ts`, `repaired` branch) and those offsets still point
 *      at exactly the same characters. Verified against both split strategies —
 *      replacing the block wholesale and truncating it in place — and the
 *      annotation kept its text under both.
 *   2. It runs on a one-shot, deliberate action, not on the autosave timer. A
 *      normalizer inside `plaintextAdapter.save` would ALSO have fired from
 *      `serializeDocument`, which is documented as touching neither disk nor
 *      document state (it backs the browser's download fallback) — restructuring
 *      the document from a preview and broadcasting that to every open tab.
 *
 * Returns whether anything changed, and performs no Y.Doc write at all when
 * there is nothing to split, so promoting already-flat content cannot re-dirty
 * the document.
 *
 * The caller supplies the transaction and the origin tag (ADR-031); this does
 * bare Y operations and inherits whatever the caller is inside.
 */
export function flattenPlaintextBreaks(doc: Y.Doc): boolean {
  const fragment = doc.getXmlFragment("default");

  // Collect first, mutate second: splitting during the walk would shift indices
  // out from under it.
  const work: Array<{ index: number; name: string; lines: Segment[][] }> = [];
  for (let i = 0; i < fragment.length; i += 1) {
    const node = fragment.get(i);
    if (!(node instanceof Y.XmlElement)) continue;
    const lines = textblockLines(node);
    if (lines) work.push({ index: i, name: node.nodeName, lines });
  }
  if (work.length === 0) return false;

  // Descending, so an earlier replacement cannot invalidate a later index.
  for (const { index, name, lines } of work.reverse()) {
    fragment.delete(index, 1);

    // A heading COLLAPSES to one block; everything else splits into one per line.
    //
    // Not a stylistic choice — splitting a heading is not byte-neutral, and the
    // byte-neutrality assertion in the tests is what caught it. `extractText`
    // runs heading text through `flattenHeadingText`, which maps every newline to
    // a SPACE so a heading never presents as multiple lines. A heading holding a
    // break therefore already serializes as `# one two`, and splitting it would
    // write `# one\n# two` — inventing a heading, and a line, that were never in
    // the file. Collapsing reproduces what the bytes already say, which is also
    // what the next open parses.
    const collapse = name === "heading";
    const blocks = collapse ? 1 : lines.length;

    // ATTACH FIRST, then populate. A Y.XmlText that is still detached from the
    // doc reverses the order of successive inserts, so the heading branch below —
    // which inserts a separator between segment runs — silently produced
    // `# two one`. That is the documented Y.js invariant, and it only bites when
    // a node is filled by more than one call, which is why the split branch
    // appeared to work while the collapse branch did not.
    const created: Y.XmlElement[] = [];
    for (let b = 0; b < blocks; b += 1) created.push(new Y.XmlElement(name));
    fragment.insert(index, created);

    for (const [b, el] of created.entries()) {
      const text = new Y.XmlText();
      el.insert(0, [text]);
      if (!collapse) {
        insertDeltaSegments(text, lines[b]);
        continue;
      }
      for (const [i, segments] of lines.entries()) {
        // `{}` not `undefined` for the separator: Y.js inherits the preceding
        // character's formatting when attributes are omitted, so the joining
        // space would arrive bold after bold text.
        if (i > 0) text.insert(text.length, " ", {});
        insertDeltaSegments(text, segments, text.length);
      }
    }
  }
  return true;
}

/**
 * A textblock's content split into one delta-segment list per line, or `null`
 * when it holds no newline and needs no work.
 *
 * Marks are carried through rather than flattened. Bold in a `.txt` document is
 * already doomed at save — `extractText` keeps no marks — but destroying it
 * *here* would be a second, unrelated loss inflicted at promotion time, visible
 * immediately and for no benefit. `insertDeltaSegments` replays the attributes,
 * and clones embeds so nothing is moved out from under its original parent.
 *
 * Reads through `toDelta()`, never `toString()`: `toString()` renders inline
 * marks as literal XML tags, which would insert `<strong>` into the user's text
 * as characters.
 *
 * Both hard-break representations count. One lives as an EMBED inside a
 * `Y.XmlText` (a non-string `insert`), the other as a SIBLING `Y.XmlElement`.
 * `collectElementFlat` renders both as `"\n"`, so handling only one would leave
 * the invariant broken for content that arrived by the other route — and the two
 * routes are the markdown importer and the `.docx` importer respectively, which
 * are exactly what Save-As promotes from.
 *
 * A `codeBlock` is excluded: it declares `code: true`, a newline inside it is
 * genuinely a newline, and it is already stored as one `Y.XmlText` full of them.
 * Splitting one would shred it into unrelated paragraphs. Plaintext cannot
 * represent a code block either, but that is a loss the loader already takes;
 * manufacturing N paragraphs would be a larger one.
 *
 * A nested container (list, table) returns `null` — out of scope. `populateYDoc`
 * cannot reconstruct either from flat text, so such a document already loses that
 * structure on reload; splitting inside one would neither fix that nor worsen it.
 */
function textblockLines(node: Y.XmlElement): Segment[][] | null {
  if (!TEXTBLOCK_NODES.has(node.nodeName) || node.nodeName === "codeBlock") return null;

  const lines: Segment[][] = [[]];
  let sawBreak = false;
  const startLine = () => {
    sawBreak = true;
    lines.push([]);
  };

  for (let i = 0; i < node.length; i += 1) {
    const child = node.get(i);

    if (isHardBreakElement(child)) {
      startLine();
      continue;
    }
    if (!(child instanceof Y.XmlText)) return null; // nested container

    for (const op of child.toDelta() as Segment[]) {
      if (typeof op.insert !== "string") {
        // An embed. A hardBreak embed is a line break; any other embed (an
        // image, say) is content that has to ride on the current line.
        if (op.insert instanceof Y.XmlElement && isHardBreakElement(op.insert)) startLine();
        else lines[lines.length - 1].push(op);
        continue;
      }
      // A literal newline inside the text — a markdown soft wrap, representable
      // since #1448 and unrepresentable here.
      const pieces = op.insert.split("\n");
      for (const [p, piece] of pieces.entries()) {
        if (p > 0) startLine();
        if (piece.length > 0) {
          lines[lines.length - 1].push({ insert: piece, attributes: op.attributes });
        }
      }
    }
  }

  return sawBreak ? lines : null;
}
