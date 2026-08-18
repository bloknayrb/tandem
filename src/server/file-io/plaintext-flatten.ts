import * as Y from "yjs";
import { insertDeltaSegments, isHardBreakElement, TEXTBLOCK_NODES } from "../mcp/document-model.js";
import { FRONTMATTER_ATTR, MARKDOWN_HTML_ATTR, MARKDOWN_RAW_ATTR } from "./mdast-ydoc.js";

/** One delta op, matching `insertDeltaSegments`' input shape. */
type Segment = { insert: string | object; attributes?: Record<string, unknown> };

/**
 * Attributes deliberately NOT carried onto the blocks a flatten produces.
 *
 * All three mark a paragraph as a verbatim markdown carrier (raw HTML block,
 * footnote/reference definition, YAML frontmatter — #981, #1457). A flatten only
 * runs when the document has just become plaintext, where none of those
 * constructs exists: the txt adapter ignores attributes entirely, so keeping
 * them would change nothing on disk but WOULD duplicate the marker across every
 * block the split produced — N frontmatter blocks in the editor's styling where
 * there was one. The construct is gone; its marker should go with it.
 */
const DROPPED_ON_FLATTEN = new Set([MARKDOWN_RAW_ATTR, MARKDOWN_HTML_ATTR, FRONTMATTER_ATTR]);

/**
 * A line ending in any of its three spellings. Matches `document.ts`'s
 * `tandem_edit` guard and `useAnnotationReview`'s — a lone `\r` is collapsed by
 * `toLf` on the way to disk, so it is a break there too.
 */
const LINE_BREAK = /\r\n|[\r\n]/;

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
 *      annotation kept its text under both, for offsets that sit on a real
 *      character. **Caveat: an offset sitting exactly ON the break itself is
 *      not one of those** — `flatOffsetToRelPos`'s boundary fallback has to
 *      round it to the nearest real character, and which character counts as
 *      nearest differs before and after this flatten (pre-flatten it rounds
 *      forward into the second paragraph; post-flatten the break offset is a
 *      genuine paragraph edge and resolves exactly). An anchor minted at that
 *      one offset therefore lands in a different `Y.XmlText`, at a different
 *      flat offset, depending on which side of the flatten it's asked from.
 *      Not fixed here — it would mean redesigning the shared
 *      `flatOffsetToRelPos` tie-break rule for every caller, not just this
 *      one. See `tests/server/plaintext-flatten.test.ts`'s boundary test.
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
  const work: Array<{
    index: number;
    name: string;
    attrs: Record<string, unknown>;
    lines: Segment[][];
  }> = [];
  const unfixable: string[] = [];
  for (let i = 0; i < fragment.length; i += 1) {
    const node = fragment.get(i);
    if (!(node instanceof Y.XmlElement)) continue;
    const lines = textblockLines(node);
    if (lines) {
      work.push({ index: i, name: node.nodeName, attrs: node.getAttributes(), lines });
      continue;
    }
    // Skipped AND holding a break: a nested container. Reported rather than
    // passed over silently, because the boolean return and the call-site comment
    // otherwise read as "the invariant now holds" — and for this document it does
    // not. Nothing here can make it hold: `populateYDoc` cannot rebuild a list or
    // a table from flat text, so the structure is lost on the next reload anyway.
    if (holdsBreak(node)) unfixable.push(node.nodeName);
  }
  if (unfixable.length > 0) {
    console.warn(
      `[plaintext-flatten] left a break inside ${unfixable.join(", ")} — a plaintext file ` +
        "cannot represent these containers at all, so their structure will not survive the next reload",
    );
  }
  if (work.length === 0) return false;

  // Descending, so an earlier replacement cannot invalidate a later index.
  for (const { index, name, attrs, lines } of work.reverse()) {
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
    for (let b = 0; b < blocks; b += 1) {
      const el = new Y.XmlElement(name);
      // Attributes must be CARRIED, and this is not a nicety: a fresh
      // `Y.XmlElement("heading")` has no `level`, and `collectElementFlat` reads
      // `level` to choose the `#` run — so a flattened `## Title` serialized as
      // `# Title`. Dropping one heading level is a visible byte change, i.e.
      // exactly the corruption class this function exists to remove, and it was
      // found by a throwaway probe rather than by the suite, which is why the
      // heading-attribute case is now a test.
      for (const [key, value] of Object.entries(attrs)) {
        if (DROPPED_ON_FLATTEN.has(key)) continue;
        // `as never`: Y.js types the value as string, but the real store holds
        // numbers (`heading.level`) — the same cast `mdast-ydoc.ts` uses.
        el.setAttribute(key, value as never);
      }
      created.push(el);
    }
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
 * **A `codeBlock` is INCLUDED**, and an earlier cut of this excluded it on the
 * argument that "a newline in a code block is genuinely a newline, splitting would
 * shred it". That argument is right for markdown and irrelevant here: this runs
 * only for a document that has just become plaintext, and `collectElementFlat`
 * emits a code block's text with **no fences**, so the bytes of a three-line code
 * block are three lines. The reopen parses them as three paragraphs whatever we do
 * — the fences are already gone from the file — so splitting is byte-neutral and
 * makes the model's block count match the file's line count, while excluding it
 * left the divergence in place for exactly the content most likely to be
 * multi-line. It splits into N blocks of the SAME type, so the monospace display
 * survives until the next reload.
 *
 * A nested container (list, table, blockquote) still returns `null`. Not a
 * judgement call: `populateYDoc` cannot rebuild any of them from flat text, so the
 * structure is lost on the next reload no matter what happens here, and there is no
 * achievable invariant to align to. The caller reports these rather than implying
 * it fixed them.
 */
/** Does this subtree hold a break in any of its three spellings, at any depth? */
function holdsBreak(node: Y.XmlElement): boolean {
  for (let i = 0; i < node.length; i += 1) {
    const child = node.get(i);
    if (isHardBreakElement(child)) return true;
    if (child instanceof Y.XmlElement && holdsBreak(child)) return true;
    if (!(child instanceof Y.XmlText)) continue;
    for (const op of child.toDelta() as Segment[]) {
      if (typeof op.insert === "string") {
        if (LINE_BREAK.test(op.insert)) return true;
      } else if (op.insert instanceof Y.XmlElement && isHardBreakElement(op.insert)) {
        return true;
      }
    }
  }
  return false;
}

function textblockLines(node: Y.XmlElement): Segment[][] | null {
  if (!TEXTBLOCK_NODES.has(node.nodeName)) return null;

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
      // since #1448 and unrepresentable here. Split on all THREE spellings, not
      // just `\n`: `restoreLineEndings` runs `toLf` first, so a lone `\r` reaches
      // the file as a break exactly like `\n`, and the other four guards in this
      // fix already match `[\r\n]`. One commit should not hold three notions of
      // "line break". Found in review — latent rather than demonstrated, because
      // both loaders normalize, but `docx` HTML text nodes are not normalized.
      const pieces = op.insert.split(LINE_BREAK);
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
