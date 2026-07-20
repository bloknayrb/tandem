import path from "path";
import * as Y from "yjs";
import {
  FLAT_SEPARATOR,
  headingPrefix,
  headingPrefixLength as sharedHeadingPrefixLength,
} from "../../shared/offsets.js";
import { saveMarkdown } from "../file-io/markdown.js";

/**
 * Detect file format from extension.
 */
export function detectFormat(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  switch (ext) {
    case ".md":
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
 * True when a node is a sibling `hardBreak` inline-leaf element — the only inline
 * leaf a textblock holds. It occupies exactly 1 flat char and REPLACES the
 * between-block separator (matches the client, which counts every hardBreak as 1;
 * `src/client/positions.ts`). Container children (list items, table cells) instead
 * get a FLAT_SEPARATOR between siblings.
 */
export function isHardBreakElement(node: unknown): boolean {
  return node instanceof Y.XmlElement && node.nodeName === "hardBreak";
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
  const parts: string[] = [];
  let hasPriorContent = false;
  for (let i = 0; i < element.length; i++) {
    const child = element.get(i);
    if (child instanceof Y.XmlText) {
      for (const op of child.toDelta()) {
        if (typeof op.insert === "string") {
          parts.push(op.insert);
        } else {
          // Embed (hardBreak, etc.) — emit \n to keep flat offset aligned
          // with Y.XmlText internal index (embeds count as 1 in xmlText.length)
          parts.push("\n");
        }
      }
      hasPriorContent = true;
    } else if (child instanceof Y.XmlElement) {
      if (isHardBreakElement(child)) {
        // Inline-leaf break: always contributes exactly one "\n" and REPLACES the
        // between-block separator (never additive). Matches the client, which counts
        // every hardBreak as 1 unconditionally (client/positions.ts) — so a
        // paragraph-leading break counts 1 here too, even if a browser write-back
        // later strips the empty leading Y.XmlText normalizeHardBreaks preserves.
        parts.push("\n");
      } else {
        if (hasPriorContent) parts.push(FLAT_SEPARATOR);
        parts.push(getElementText(child));
      }
      hasPriorContent = true;
    }
  }
  return parts.join("");
}

/**
 * Compute the flat text length of a Y.XmlElement without building the string.
 * Uses the same one-character separator invariant as getElementText().
 */
export function getElementTextLength(element: Y.XmlElement): number {
  let len = 0;
  let hasPriorContent = false;
  for (let i = 0; i < element.length; i++) {
    const child = element.get(i);
    if (child instanceof Y.XmlText) {
      len += child.length;
      hasPriorContent = true;
    } else if (child instanceof Y.XmlElement) {
      if (isHardBreakElement(child)) {
        len += 1; // inline-leaf: exactly 1, replaces the separator (see getElementText)
      } else {
        if (hasPriorContent) len += 1;
        len += getElementTextLength(child);
      }
      hasPriorContent = true;
    }
  }
  return len;
}

/**
 * Find the Y.XmlText that contains a given flat text offset within a Y.XmlElement.
 * Returns the XmlText and the offset within it, or null if the offset falls on a
 * separator character or cannot be resolved.
 */
export function findXmlTextAtOffset(
  element: Y.XmlElement,
  textOffset: number,
): { xmlText: Y.XmlText; offsetInXmlText: number } | null {
  let accumulated = 0;
  let hasPriorContent = false;
  for (let i = 0; i < element.length; i++) {
    const child = element.get(i);
    if (child instanceof Y.XmlText) {
      const len = child.length;
      if (accumulated + len > textOffset) {
        return { xmlText: child, offsetInXmlText: textOffset - accumulated };
      }
      accumulated += len;
      hasPriorContent = true;
    } else if (child instanceof Y.XmlElement) {
      if (isHardBreakElement(child)) {
        // Inline-leaf break: 1 flat char, unaddressable like a separator. An offset
        // landing ON it returns null so the caller's assoc fallback re-anchors.
        if (textOffset === accumulated) return null;
        accumulated += 1;
        hasPriorContent = true;
      } else {
        if (hasPriorContent) {
          if (textOffset === accumulated) {
            // Offset lands ON the separator — return null (between-element gap)
            return null;
          }
          accumulated += 1;
        }
        const childTextLen = getElementTextLength(child);
        if (accumulated + childTextLen > textOffset) {
          return findXmlTextAtOffset(child, textOffset - accumulated);
        }
        accumulated += childTextLen;
        hasPriorContent = true;
      }
    }
  }
  // Handle end-of-element: offset equals total length
  if (textOffset === accumulated) {
    // Walk backwards to find the last XmlText
    for (let i = element.length - 1; i >= 0; i--) {
      const child = element.get(i);
      if (child instanceof Y.XmlText) {
        return { xmlText: child, offsetInXmlText: child.length };
      } else if (child instanceof Y.XmlElement) {
        return findXmlTextAtOffset(child, getElementTextLength(child));
      }
    }
  }
  return null;
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
  const fragment = doc.getXmlFragment("default");
  const lines: string[] = [];

  for (let i = 0; i < fragment.length; i++) {
    const node = fragment.get(i);
    if (node instanceof Y.XmlElement) {
      const text = getElementText(node);
      if (node.nodeName === "heading") {
        const level = Number(node.getAttribute("level") ?? 1);
        lines.push(headingPrefix(level) + text);
      } else {
        lines.push(text);
      }
    }
  }

  return lines.join(FLAT_SEPARATOR);
}

/**
 * Extract readable markdown from a Y.Doc via remark serialization.
 * NOT used by resolveToElement or tandem_edit (those use extractText).
 */
export function extractMarkdown(doc: Y.Doc): string {
  return saveMarkdown(doc).trimEnd();
}

/**
 * Get the heading prefix length for a Y.XmlElement.
 * Delegates to shared headingPrefixLength for the actual math.
 */
export function getHeadingPrefixLength(node: Y.XmlElement): number {
  if (node.nodeName === "heading") {
    const level = Number(node.getAttribute("level") ?? 1);
    return sharedHeadingPrefixLength(level);
  }
  return 0;
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
