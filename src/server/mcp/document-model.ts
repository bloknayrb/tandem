import path from "path";
import * as Y from "yjs";
import { FLAT_SEPARATOR, flattenHeadingText, headingPrefix } from "../../shared/offsets.js";
import {
  findXmlTextAtOffset,
  getElementTextLength,
  getHeadingPrefixLength,
  isHardBreakElement,
} from "../../shared/positions/ydoc.js";
import { saveMarkdown } from "../file-io/markdown.js";

// These four moved to `src/shared/positions/ydoc.ts` so the client can reach
// them without pulling this module's `node:path` and `saveMarkdown` imports —
// and with them the whole remark pipeline — into the browser bundle. Re-exported
// from here because ~20 call sites and a dozen test files import them from this
// path, and a refactor that forces test edits cannot demonstrate it was
// behaviour-preserving.
export { findXmlTextAtOffset, getElementTextLength, getHeadingPrefixLength, isHardBreakElement };

/**
 * Detect file format from extension.
 */
export function detectFormat(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  switch (ext) {
    case ".md":
    // `.markdown` is the long-form spelling, registered as an OS file
    // association alongside `.md`. It MUST fold to "md" here — the default
    // branch below is the plaintext fallback, which would render the syntax
    // literally and save back through `extractText` (#1306).
    case ".markdown":
      return "md";
    case ".txt":
      return "txt";
    case ".html":
    case ".htm":
      return "html";
    case ".docx":
      return "docx";
    default:
      return "txt";
  }
}

/**
 * Generate a stable, readable document ID from a file path.
 * Used as both the map key and the Hocuspocus room name.
 */
export function docIdFromPath(filePath: string): string {
  const normalized = filePath.replace(/\\/g, "/").toLowerCase();
  let hash = 0;
  for (let i = 0; i < normalized.length; i++) {
    hash = ((hash << 5) - hash + normalized.charCodeAt(i)) | 0;
  }
  const name = path
    .basename(normalized, path.extname(normalized))
    .replace(/[^a-zA-Z0-9]/g, "-")
    .replace(/-+/g, "-")
    .slice(0, 16);
  return `${name}-${Math.abs(hash).toString(36).slice(0, 6)}`;
}

/** Insert text content into a Y.Doc's XmlFragment as paragraphs */
export function populateYDoc(doc: Y.Doc, text: string): void {
  const fragment = doc.getXmlFragment("default");

  if (fragment.length > 0) {
    fragment.delete(0, fragment.length);
  }

  if (text === "") return;

  const lines = text.split("\n");
  for (const line of lines) {
    if (line === "") {
      const empty = new Y.XmlElement("paragraph");
      empty.insert(0, [new Y.XmlText("")]);
      fragment.insert(fragment.length, [empty]);
      continue;
    }

    let element: Y.XmlElement;

    if (line.startsWith("### ")) {
      element = new Y.XmlElement("heading");
      element.setAttribute("level", 3 as any);
      element.insert(0, [new Y.XmlText(line.slice(4))]);
    } else if (line.startsWith("## ")) {
      element = new Y.XmlElement("heading");
      element.setAttribute("level", 2 as any);
      element.insert(0, [new Y.XmlText(line.slice(3))]);
    } else if (line.startsWith("# ")) {
      element = new Y.XmlElement("heading");
      element.setAttribute("level", 1 as any);
      element.insert(0, [new Y.XmlText(line.slice(2))]);
    } else {
      element = new Y.XmlElement("paragraph");
      element.insert(0, [new Y.XmlText(line)]);
    }

    fragment.insert(fragment.length, [element]);
  }
}

/**
 * Extract plain text from a Y.XmlElement by recursively collecting Y.XmlText content.
 * Inserts FLAT_SEPARATOR between nested XmlElement children so offsets are consistent
 * with the document-level separator convention (e.g., list items and table cells
 * get \n between them).
 *
 * Separator contract (must stay in sync with getElementTextLength):
 * every gap between nested block/container XmlElement children contributes one
 * FLAT_SEPARATOR character. Offset helpers account for that as a one-character
 * between-element gap.
 */
export function getElementText(element: Y.XmlElement): string {
  const acc = newFlatAcc();
  collectElementFlat(element, acc);
  return acc.parts.join("");
}

/**
 * What a `"\n"` in the flat projection actually WAS in the document.
 *
 * The flat text spells three different structures the same way, and undo has to
 * put back the one that was there (#1486). Restoring the wrong one is a real
 * edit to the file: a hard break serializes as a trailing `\`, a block boundary
 * as a blank line, and a literal newline as a soft wrap.
 *
 * `"literal"` is not in the union deliberately — it is the DEFAULT, recorded by
 * absence. Soft-wrapped prose is the common case (paragraphs are
 * `whitespace: "pre"` since #1448), so listing those would make the record
 * large for the shape that needs no help.
 */
export type FlatBreakKind = "block" | "block-opaque" | "hard";

/**
 * The only node type a restore can rebuild, so the only one `"block"` covers.
 *
 * Undo puts a block boundary back by SPLITTING the receiving block, which yields
 * two blocks of the same type. That is right for a paragraph pair and wrong for
 * every mixed pair, and the mixed pairs are reachable: `validateRange` checks a
 * heading prefix only at the two range ENDPOINTS, so a range may legally run
 * from one block through the next block's `"## "` and out the far side. Accepting
 * it merges the two, and PM's join keeps the FIRST block's type — so a
 * paragraph+heading pair merges to a paragraph and the receiving type tells you
 * nothing about what was consumed. `"block-opaque"` records "there was a
 * boundary here and I cannot rebuild it", and the client declines rather than
 * inventing a paragraph where a heading was (#1486).
 */
const RESTORABLE_BLOCK = "paragraph";

/** A non-literal `"\n"` at flat offset `at`. */
export interface FlatBreak {
  at: number;
  kind: FlatBreakKind;
}

interface FlatAcc {
  parts: string[];
  /** Running flat offset — the index the NEXT pushed character will occupy. */
  len: number;
  breaks: FlatBreak[];
}

function newFlatAcc(): FlatAcc {
  return { parts: [], len: 0, breaks: [] };
}

function pushFlatText(acc: FlatAcc, text: string): void {
  acc.parts.push(text);
  acc.len += text.length;
}

function pushFlatBreak(acc: FlatAcc, kind: FlatBreakKind): void {
  acc.breaks.push({ at: acc.len, kind });
  acc.parts.push(FLAT_SEPARATOR);
  acc.len += FLAT_SEPARATOR.length;
}

/**
 * The single traversal behind `getElementText`, `extractText` and
 * `extractTextWithBreaks`.
 *
 * One function rather than a text walker plus a parallel break walker, because
 * a parallel walker is a copy of the separator contract and the two would drift
 * — and a break list that disagrees with the text it describes points undo at
 * the wrong offsets, which is worse than having no break list at all.
 */
function collectElementFlat(element: Y.XmlElement, acc: FlatAcc): void {
  let hasPriorContent = false;
  // What preceded the next boundary, for the `"block"` vs `"block-opaque"` call.
  // `null` covers both "inline text came first" (mixed content, unrebuildable)
  // and "nothing yet".
  let priorBlockName: string | null = null;
  for (let i = 0; i < element.length; i++) {
    const child = element.get(i);
    if (child instanceof Y.XmlText) {
      for (const op of child.toDelta()) {
        if (typeof op.insert === "string") {
          // May itself contain "\n" — a LITERAL newline, e.g. a markdown soft
          // wrap. Deliberately unrecorded: absence from `breaks` means literal.
          pushFlatText(acc, op.insert);
        } else {
          // Embed (hardBreak, etc.) — emit \n to keep flat offset aligned
          // with Y.XmlText internal index (embeds count as 1 in xmlText.length)
          pushFlatBreak(acc, "hard");
        }
      }
      hasPriorContent = true;
      priorBlockName = null;
    } else if (child instanceof Y.XmlElement) {
      if (isHardBreakElement(child)) {
        // Inline-leaf break: always contributes exactly one "\n" and REPLACES the
        // between-block separator (never additive). Matches the client, which counts
        // every hardBreak as 1 unconditionally (client/positions.ts) — so a
        // paragraph-leading break counts 1 here too, even if a browser write-back
        // later strips the empty leading Y.XmlText normalizeHardBreaks preserves.
        pushFlatBreak(acc, "hard");
        priorBlockName = null;
      } else {
        if (hasPriorContent) {
          const rebuildable =
            priorBlockName === RESTORABLE_BLOCK && child.nodeName === RESTORABLE_BLOCK;
          pushFlatBreak(acc, rebuildable ? "block" : "block-opaque");
        }
        collectElementFlat(child, acc);
        priorBlockName = child.nodeName;
      }
      hasPriorContent = true;
    }
  }
}

/**
 * Collect all Y.XmlText nodes in a Y.XmlElement with their flat offsets from the
 * element's start. Uses the same one-character separator invariant as getElementText().
 */
export function collectXmlTexts(
  element: Y.XmlElement,
): Array<{ xmlText: Y.XmlText; offsetFromStart: number }> {
  const results: Array<{ xmlText: Y.XmlText; offsetFromStart: number }> = [];
  let accumulated = 0;
  let hasPriorContent = false;
  for (let i = 0; i < element.length; i++) {
    const child = element.get(i);
    if (child instanceof Y.XmlText) {
      results.push({ xmlText: child, offsetFromStart: accumulated });
      accumulated += child.length;
      hasPriorContent = true;
    } else if (child instanceof Y.XmlElement) {
      if (isHardBreakElement(child)) {
        accumulated += 1; // inline-leaf: 1 flat char, no nested XmlText to collect
      } else {
        if (hasPriorContent) accumulated += 1;
        for (const nested of collectXmlTexts(child)) {
          results.push({
            xmlText: nested.xmlText,
            offsetFromStart: accumulated + nested.offsetFromStart,
          });
        }
        accumulated += getElementTextLength(child);
      }
      hasPriorContent = true;
    }
  }
  return results;
}

/** Extract plain text from a Y.Doc's XmlFragment */
export function extractText(doc: Y.Doc): string {
  return extractTextWithBreaks(doc).text;
}

/**
 * `extractText`, plus the structure the flat string throws away.
 *
 * `breaks` lists every `"\n"` in `text` that is a block boundary or a hard
 * break; any other `"\n"` is a literal newline inside one textblock. Callers
 * that only need the string use `extractText` — this exists for `captureSnapshot`,
 * whose consumer (undo) has to rebuild the structure rather than the characters.
 */
export function extractTextWithBreaks(doc: Y.Doc): { text: string; breaks: FlatBreak[] } {
  const fragment = doc.getXmlFragment("default");
  const acc = newFlatAcc();
  let emitted = 0;
  let priorBlockName: string | null = null;

  for (let i = 0; i < fragment.length; i++) {
    const node = fragment.get(i);
    if (!(node instanceof Y.XmlElement)) continue;
    // Counted separately from `i`: a non-element child must not consume a
    // separator, or every offset after it shifts. This mirrors the old
    // `lines.push(...)` + `join` exactly — `lines` only ever held elements.
    if (emitted > 0) {
      const rebuildable = priorBlockName === RESTORABLE_BLOCK && node.nodeName === RESTORABLE_BLOCK;
      pushFlatBreak(acc, rebuildable ? "block" : "block-opaque");
    }
    if (node.nodeName === "heading") {
      const level = Number(node.getAttribute("level") ?? 1);
      // Pushed as flat TEXT, not traversed: `flattenHeadingText` rewrites every
      // newline to a space, so a heading contributes no breaks at all. It is
      // length-preserving (character class, not `/\r?\n/`), so offsets hold.
      pushFlatText(acc, headingPrefix(level) + flattenHeadingText(getElementText(node)));
    } else {
      collectElementFlat(node, acc);
    }
    priorBlockName = node.nodeName;
    emitted++;
  }

  return { text: acc.parts.join(""), breaks: acc.breaks };
}

/**
 * One leaf textblock, with the flat range it occupies and the structure the flat
 * projection throws away.
 */
export interface BlockInfo {
  /** Flat offset of the block's text (AFTER any top-level heading prefix). */
  from: number;
  /** Flat offset just past the block's text. */
  to: number;
  /** paragraph | heading | codeBlock. */
  node: string;
  /** Child indices from the fragment root to this block. */
  path: number[];
  /** Container nesting depth: 0 for a top-level block. */
  depth: number;
  /** Immediate container's node name, when nested (e.g. "listItem", "blockquote"). */
  container?: string;
  /** Enclosing list kind, when inside one. */
  listType?: "bullet" | "ordered";
  /** 1-based position of the enclosing item within its list. */
  listItemIndex?: number;
  /** GFM task tri-state of the enclosing item. Absent = plain bullet. */
  checked?: boolean;
  /** Heading level, for a heading block. */
  headingLevel?: number;
}

/**
 * Enumerate the document's leaf textblocks with their flat ranges.
 *
 * Exists because the flat projection is structurally blind: `- [ ] task item`
 * reads as bare `task item`, so an MCP caller cannot tell a list item from a
 * paragraph, cannot see nesting depth or ordered-ness, and cannot see checkbox
 * state. Without this the list-editing tools are undiscoverable — the AI has no
 * way to know a line is a list item in the first place.
 *
 * Shares this module's traversal rather than restating it, because the offsets
 * it reports must agree with `extractText` exactly. Two subtleties that a
 * hand-rolled walker gets wrong, both already encoded here:
 *
 *  - A TOP-LEVEL heading contributes `headingPrefix(level)` and has its newlines
 *    flattened to spaces; a NESTED heading is traversed by `collectElementFlat`
 *    and contributes neither. `from` therefore points past the prefix at top
 *    level and at the text itself when nested.
 *  - A zero-text top-level element (`image`, `horizontalRule`) still consumes a
 *    separator, so the cursor must advance for it even though it emits no block.
 */
export function collectBlocks(doc: Y.Doc): BlockInfo[] {
  const fragment = doc.getXmlFragment("default");
  const blocks: BlockInfo[] = [];
  let cursor = 0;
  let emitted = 0;

  for (let i = 0; i < fragment.length; i++) {
    const node = fragment.get(i);
    if (!(node instanceof Y.XmlElement)) continue;
    if (emitted > 0) cursor += FLAT_SEPARATOR.length;

    if (node.nodeName === "heading") {
      // Mirrors extractTextWithBreaks: prefix, then flattened text, no traversal.
      const level = Number(node.getAttribute("level") ?? 1);
      const prefixLen = headingPrefix(level).length;
      const textLen = flattenHeadingText(getElementText(node)).length;
      blocks.push({
        from: cursor + prefixLen,
        to: cursor + prefixLen + textLen,
        node: "heading",
        path: [i],
        depth: 0,
        headingLevel: level,
      });
      cursor += prefixLen + textLen;
    } else {
      cursor = collectBlocksIn(node, cursor, [i], 0, undefined, blocks);
    }
    emitted++;
  }
  return blocks;
}

/**
 * Recurse a container, mirroring `collectElementFlat`'s separator contract.
 * Returns the flat cursor just past `element`.
 */
function collectBlocksIn(
  element: Y.XmlElement,
  start: number,
  path: number[],
  depth: number,
  inherited: Pick<BlockInfo, "container" | "listType" | "listItemIndex" | "checked"> | undefined,
  out: BlockInfo[],
): number {
  if (TEXTBLOCK_NODES.has(element.nodeName)) {
    const len = getElementTextLength(element);
    out.push({
      from: start,
      to: start + len,
      node: element.nodeName,
      path,
      depth,
      ...(inherited ?? {}),
      ...(element.nodeName === "heading"
        ? { headingLevel: Number(element.getAttribute("level") ?? 1) }
        : {}),
    });
    return start + len;
  }

  const isList = element.nodeName === "bulletList" || element.nodeName === "orderedList";
  const listType: "bullet" | "ordered" | undefined = isList
    ? element.nodeName === "orderedList"
      ? "ordered"
      : "bullet"
    : undefined;

  let cursor = start;
  let hasPriorContent = false;
  let itemOrdinal = 0;

  for (let i = 0; i < element.length; i++) {
    const child = element.get(i);
    if (child instanceof Y.XmlText) {
      cursor += child.length;
      hasPriorContent = true;
      continue;
    }
    if (!(child instanceof Y.XmlElement)) continue;
    if (isHardBreakElement(child)) {
      cursor += 1;
      hasPriorContent = true;
      continue;
    }
    if (hasPriorContent) cursor += FLAT_SEPARATOR.length;

    let next = inherited;
    if (child.nodeName === "listItem") {
      itemOrdinal++;
      // Cast for the same reason `yDocToMdast` does: yjs stores the tri-state as
      // a real boolean (ContentAny), but `getAttribute` is typed `string`, and
      // the value round-trips as a string on some paths. Read both spellings.
      const checkedAttr = child.getAttribute("checked") as boolean | string | undefined;
      next = {
        container: "listItem",
        ...(listType ? { listType } : {}),
        listItemIndex: itemOrdinal,
        // Stored only when set, and tolerantly read: mdast-ydoc writes a real
        // boolean, but the attribute round-trips as a string on some paths.
        ...(checkedAttr === true || checkedAttr === "true"
          ? { checked: true }
          : checkedAttr === false || checkedAttr === "false"
            ? { checked: false }
            : {}),
      };
    } else if (!TEXTBLOCK_NODES.has(child.nodeName)) {
      next = { ...(inherited ?? {}), container: child.nodeName };
    } else if (inherited === undefined) {
      next = { container: element.nodeName };
    }

    cursor = collectBlocksIn(child, cursor, [...path, i], depth + 1, next, out);
    hasPriorContent = true;
  }
  return cursor;
}

/**
 * Extract readable markdown from a Y.Doc via remark serialization.
 * NOT used by resolveToElement or tandem_edit (those use extractText).
 */
export function extractMarkdown(doc: Y.Doc): string {
  return saveMarkdown(doc).trimEnd();
}

// -- Range staleness detection ------------------------------------------------

export type RangeVerifyResult =
  | { valid: true }
  | { valid: false; gone: true }
  | { valid: false; gone: false; resolvedFrom: number; resolvedTo: number };

/**
 * Check whether [from, to] still contains textSnapshot. If not, search the
 * full document and return the relocated range or { gone: true }.
 */
export function verifyAndResolveRange(
  doc: Y.Doc,
  from: number,
  to: number,
  textSnapshot: string | undefined,
): RangeVerifyResult {
  if (!textSnapshot) return { valid: true };
  const fullText = extractText(doc);
  if (fullText.slice(from, to) === textSnapshot) return { valid: true };
  const candidates: number[] = [];
  let searchFrom = 0;
  while (true) {
    const idx = fullText.indexOf(textSnapshot, searchFrom);
    if (idx === -1) break;
    candidates.push(idx);
    searchFrom = idx + 1;
  }
  if (candidates.length === 0) return { valid: false, gone: true };
  const best = candidates.reduce((a, b) => (Math.abs(a - from) <= Math.abs(b - from) ? a : b));
  return { valid: false, gone: false, resolvedFrom: best, resolvedTo: best + textSnapshot.length };
}

/**
 * Find the first Y.XmlText child of a Y.XmlElement (read-only).
 * Returns null if no XmlText child exists.
 */
export function findXmlText(element: Y.XmlElement): Y.XmlText | null {
  for (let i = 0; i < element.length; i++) {
    const child = element.get(i);
    if (child instanceof Y.XmlText) {
      return child;
    }
  }
  return null;
}

export const TEXTBLOCK_NODES = new Set(["paragraph", "heading", "codeBlock"]);

type DeltaSegment = { insert: string | object; attributes?: Record<string, unknown> };

/**
 * Insert delta `segments` into an attached Y.XmlText starting at `pos`, preserving
 * inline formatting and cloning XmlElement embeds (e.g. hardBreak) so attached nodes
 * aren't moved out of their source. Pass {} (not undefined) for attributes — Y.js
 * `insert(pos, str, undefined)` inherits formatting from the preceding character,
 * while `insert(pos, str, {})` terminates it. The single home for this invariant.
 */
export function insertDeltaSegments(
  target: Y.XmlText,
  segments: Iterable<DeltaSegment>,
  pos = 0,
): void {
  for (const seg of segments) {
    if (typeof seg.insert === "string") {
      target.insert(pos, seg.insert, seg.attributes ?? {});
      pos += seg.insert.length;
    } else {
      const embed = seg.insert instanceof Y.XmlElement ? seg.insert.clone() : { ...seg.insert };
      target.insertEmbed(pos, embed, seg.attributes ?? {});
      pos += 1;
    }
  }
}

/**
 * Merge all delta segments from `source` into `target` at `offset`,
 * preserving inline formatting and embeds.
 */
export function mergeXmlTextDelta(target: Y.XmlText, source: Y.XmlText, offset: number): void {
  insertDeltaSegments(target, source.toDelta(), offset);
}

/**
 * Return the XmlText child of a textblock element, creating one if empty.
 * Throws on non-textblock nodes (containers like blockquote, bulletList, etc.).
 */
export function getOrCreateXmlText(element: Y.XmlElement): Y.XmlText {
  if (!TEXTBLOCK_NODES.has(element.nodeName)) {
    throw new Error(
      `Cannot create XmlText on "${element.nodeName}" — only textblock elements ` +
        `(paragraph, heading, codeBlock) should have direct XmlText children. ` +
        `Edit a specific paragraph or list item instead.`,
    );
  }
  return (
    findXmlText(element) ??
    (() => {
      const textNode = new Y.XmlText("");
      element.insert(0, [textNode]);
      return textNode;
    })()
  );
}

/**
 * Flat layout of a textblock's *immediate* children. A hardBreak-bearing paragraph
 * has multiple Y.XmlText children interleaved with sibling `hardBreak` elements
 * (see hardbreak-normalize.ts), so an element-relative flat offset can span several
 * children. This walk gives each direct child its flat `[start, start+len)` range —
 * text children by `length`, a `hardBreak` as the single flat char it occupies.
 * Unlike `collectXmlTexts`, it does NOT recurse (a textblock's children are inline
 * leaves) and it carries the child `index` needed to `element.delete(index, 1)`.
 */
type ChildSpan = {
  index: number;
  kind: "text" | "break" | "other";
  start: number;
  len: number;
  child: Y.XmlText | Y.XmlElement;
};

function directChildSpans(element: Y.XmlElement): ChildSpan[] {
  const spans: ChildSpan[] = [];
  let acc = 0;
  for (let i = 0; i < element.length; i++) {
    const child = element.get(i);
    if (child instanceof Y.XmlText) {
      spans.push({ index: i, kind: "text", start: acc, len: child.length, child });
      acc += child.length;
    } else if (isHardBreakElement(child)) {
      spans.push({ index: i, kind: "break", start: acc, len: 1, child });
      acc += 1;
    } else if (child instanceof Y.XmlElement) {
      // Not expected inside a textblock, but account for its flat length so offsets
      // stay aligned and never delete it on a partial overlap.
      const len = getElementTextLength(child);
      spans.push({ index: i, kind: "other", start: acc, len, child });
      acc += len;
    }
  }
  return spans;
}

/**
 * Insert `text` at an element-relative flat `offset`, tolerating a boundary that
 * lands on a hardBreak. `findXmlTextAtOffset` returns null on a break gap, so fall
 * back to the text child ending at `offset` (the always-flush empties from
 * normalizeHardBreaks guarantee such a child exists next to every break). A text
 * child *starting* at `offset` never needs a separate case: if non-empty,
 * `findXmlTextAtOffset` already resolved it; if empty, it also ends at `offset` and
 * the first fallback catches it. Last resort: splice a fresh Y.XmlText.
 *
 * The inserted text INHERITS the inline formatting open at `offset` — `Y.Text.insert`
 * with the attributes arg omitted copies the position's `currentAttributes`, whereas
 * an explicit `{}` would terminate it. This preserves the pre-#1206 `tandem_edit`
 * behavior (old path was a bare `textNode.insert(offset, newText)`): replacing text
 * inside a bold/italic run keeps the replacement in that run's formatting.
 */
function insertPlainTextAtOffset(element: Y.XmlElement, offset: number, text: string): void {
  const loc = findXmlTextAtOffset(element, offset);
  if (loc) {
    loc.xmlText.insert(loc.offsetInXmlText, text);
    return;
  }
  const spans = directChildSpans(element);
  for (const s of spans) {
    if (s.kind === "text" && s.start + s.len === offset) {
      (s.child as Y.XmlText).insert(s.len, text);
      return;
    }
  }
  // No adjacent text child (e.g. a break with no surrounding text run). Splice a new
  // Y.XmlText before the first child that starts at/after `offset`.
  let childIndex = element.length;
  for (const s of spans) {
    if (s.start >= offset) {
      childIndex = s.index;
      break;
    }
  }
  const t = new Y.XmlText();
  element.insert(childIndex, [t]);
  t.insert(0, text); // fresh node: no open formatting to inherit, but stay consistent
}

/**
 * Replace the element-relative flat range `[from, to)` in a textblock with `newText`,
 * correctly spanning multiple Y.XmlText children and the sibling `hardBreak` elements
 * between them. Replaces the old first-XmlText-only edit path (`getOrCreateXmlText` +
 * raw offset), which corrupted or threw once a paragraph held more than one XmlText.
 * Deletes children back-to-front so `element.delete(index, 1)` on a break never
 * invalidates a not-yet-processed index.
 */
export function replaceFlatRangeInElement(
  element: Y.XmlElement,
  from: number,
  to: number,
  newText: string,
): void {
  if (to > from) {
    const spans = directChildSpans(element);
    for (let k = spans.length - 1; k >= 0; k--) {
      const s = spans[k];
      const lo = Math.max(from, s.start);
      const hi = Math.min(to, s.start + s.len);
      if (lo >= hi) continue; // no overlap with [from, to)
      if (s.kind === "text") {
        (s.child as Y.XmlText).delete(lo - s.start, hi - lo);
      } else if (s.kind === "break") {
        element.delete(s.index, 1); // atomic 1-char leaf, fully covered
      } else if (lo === s.start && hi === s.start + s.len) {
        element.delete(s.index, 1); // unexpected nested element, fully covered
      } else {
        replaceFlatRangeInElement(s.child as Y.XmlElement, lo - s.start, hi - s.start, "");
      }
    }
  }
  if (newText.length > 0) {
    insertPlainTextAtOffset(element, from, newText);
  }
}

/** Append a fresh Y.XmlText to `target` carrying a copy of `source`'s delta. */
function appendClonedXmlText(target: Y.XmlElement, source: Y.XmlText): void {
  const t = new Y.XmlText();
  target.insert(target.length, [t]);
  mergeXmlTextDelta(t, source, 0);
}

/**
 * Fold `source`'s surviving inline children onto the end of `target`, preserving
 * marks and sibling `hardBreak` elements. Used by the cross-element `tandem_edit`
 * merge to join the tail of the end paragraph onto the start paragraph.
 *
 * If both the join-adjacent children are Y.XmlText, their deltas are merged into ONE
 * text node (canonical: y-prosemirror never leaves two adjacent Y.XmlText siblings),
 * so a break-free merge stays a single XmlText exactly as before #1206. Any hardBreak
 * siblings and later runs in the tail are then appended in order — which
 * `mergeXmlTextDelta` alone (single-XmlText) could not carry.
 */
export function mergeInlineTail(target: Y.XmlElement, source: Y.XmlElement): void {
  if (source.length === 0) return;
  let startIdx = 0;
  const targetLast = target.length > 0 ? target.get(target.length - 1) : undefined;
  const sourceFirst = source.get(0);
  if (targetLast instanceof Y.XmlText && sourceFirst instanceof Y.XmlText) {
    mergeXmlTextDelta(targetLast, sourceFirst, targetLast.length);
    startIdx = 1;
  }
  for (let i = startIdx; i < source.length; i++) {
    const child = source.get(i);
    if (child instanceof Y.XmlText) {
      appendClonedXmlText(target, child);
    } else if (child instanceof Y.XmlElement) {
      target.insert(target.length, [child.clone()]);
    }
  }
}
