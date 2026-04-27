import path from "path";
import * as Y from "yjs";
import {
  FLAT_SEPARATOR,
  headingPrefix,
  headingPrefixLength as sharedHeadingPrefixLength,
} from "../../shared/offsets.js";
import type { ElementPosition } from "../../shared/positions/index.js";
import { MCP_ORIGIN } from "../events/origins.js";
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
      const empty = new Y.XmlElement(NODE_NAMES.PARAGRAPH);
      empty.insert(0, [new Y.XmlText("")]);
      fragment.insert(fragment.length, [empty]);
      continue;
    }

    let element: Y.XmlElement;

    if (line.startsWith("### ")) {
      element = new Y.XmlElement(NODE_NAMES.HEADING);
      element.setAttribute("level", 3 as any);
      element.insert(0, [new Y.XmlText(line.slice(4))]);
    } else if (line.startsWith("## ")) {
      element = new Y.XmlElement(NODE_NAMES.HEADING);
      element.setAttribute("level", 2 as any);
      element.insert(0, [new Y.XmlText(line.slice(3))]);
    } else if (line.startsWith("# ")) {
      element = new Y.XmlElement(NODE_NAMES.HEADING);
      element.setAttribute("level", 1 as any);
      element.insert(0, [new Y.XmlText(line.slice(2))]);
    } else {
      element = new Y.XmlElement(NODE_NAMES.PARAGRAPH);
      element.insert(0, [new Y.XmlText(line)]);
    }

    fragment.insert(fragment.length, [element]);
  }
}

/**
 * Extract plain text from a Y.XmlElement by recursively collecting Y.XmlText content.
 * Inserts FLAT_SEPARATOR between nested XmlElement children so offsets are consistent
 * with the document-level separator convention (e.g., list items get \n between them).
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
      if (hasPriorContent) parts.push(FLAT_SEPARATOR);
      parts.push(getElementText(child));
      hasPriorContent = true;
    }
  }
  return parts.join("");
}

/**
 * Compute the flat text length of a Y.XmlElement without building the string.
 * Uses the same separator predicate as getElementText() so lengths are consistent.
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
      if (hasPriorContent) len += 1;
      len += getElementTextLength(child);
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
 * element's start. Uses the same separator predicate as getElementText().
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
      if (hasPriorContent) accumulated += 1;
      for (const nested of collectXmlTexts(child)) {
        results.push({
          xmlText: nested.xmlText,
          offsetFromStart: accumulated + nested.offsetFromStart,
        });
      }
      accumulated += getElementTextLength(child);
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
      if (node.nodeName === NODE_NAMES.HEADING) {
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
  if (node.nodeName === NODE_NAMES.HEADING) {
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

/**
 * Tiptap node names used by the server. Single source of truth for nodeName
 * predicate checks — constructor sites that pass these strings to
 * `new Y.XmlElement(...)` may also reference these constants.
 *
 * Mirrors the Tiptap schema in src/server/file-io/{mdast-ydoc,docx-html}.ts
 * and src/client/editor/Editor.tsx. Update here when adding nodes.
 */
export const NODE_NAMES = {
  // Textblocks — may have direct Y.XmlText children.
  PARAGRAPH: "paragraph",
  HEADING: "heading",
  CODE_BLOCK: "codeBlock",
  // Containers — children must be Y.XmlElement.
  BLOCKQUOTE: "blockquote",
  BULLET_LIST: "bulletList",
  ORDERED_LIST: "orderedList",
  LIST_ITEM: "listItem",
  TABLE: "table",
  TABLE_ROW: "tableRow",
  TABLE_CELL: "tableCell",
  TABLE_HEADER: "tableHeader",
  // Embeds — live inside Y.XmlText, never as fragment children.
  HARD_BREAK: "hardBreak",
  IMAGE: "image",
  HORIZONTAL_RULE: "horizontalRule",
} as const;

/**
 * Textblock element names — only these may have direct Y.XmlText children.
 */
export const TEXTBLOCK_NODE_NAMES = new Set<string>([
  NODE_NAMES.PARAGRAPH,
  NODE_NAMES.HEADING,
  NODE_NAMES.CODE_BLOCK,
]);

/**
 * Returns the first Y.XmlText child, creating one if missing.
 * Throws on non-textblock elements — containers must hold XmlElement children only.
 */
export function getOrCreateXmlText(element: Y.XmlElement): Y.XmlText {
  if (!TEXTBLOCK_NODE_NAMES.has(element.nodeName)) {
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
 * Soft cap on the number of CRDT nodes a single embed may carry. The merge
 * loop in `applyTextEdit` clones embeds via `Y.AbstractType.clone()`, which
 * recurses through children. A tampered Y.Doc with deeply-nested embeds
 * could blow the stack or eat memory mid-clone.
 */
const MAX_EMBED_NODES = 1024;

/**
 * Walk a Y.Doc's default fragment and check that every fragment-child is a
 * textblock (or a recognized container/embed) with the expected child shape.
 * Returns a list of human-readable invariant violations — empty when sound.
 *
 * Used as a defensive sanity check after Hocuspocus loads a doc — catches
 * tampered session files or malformed updates planted by a localhost client.
 * Does NOT mutate the doc; callers decide whether to log, reject, or repair.
 */
export function validateDocStructure(doc: Y.Doc): string[] {
  const errors: string[] = [];
  const fragment = doc.getXmlFragment("default");
  for (let i = 0; i < fragment.length; i++) {
    const node = fragment.get(i);
    if (!(node instanceof Y.XmlElement)) {
      errors.push(`fragment[${i}]: expected XmlElement, got ${typeof node}`);
      continue;
    }
    const isTextblock = TEXTBLOCK_NODE_NAMES.has(node.nodeName);
    for (let j = 0; j < node.length; j++) {
      const child = node.get(j);
      if (child instanceof Y.XmlText && !isTextblock) {
        errors.push(`fragment[${i}] "${node.nodeName}": holds XmlText but is not a textblock`);
        break;
      }
    }
  }
  return errors;
}

/**
 * Iteratively count the AbstractType nodes inside an embed (root + descendants).
 * Returns early once the count exceeds `max`, so cost is bounded.
 */
function embedExceedsCap(root: Y.AbstractType<any>, max: number): boolean {
  let count = 0;
  const stack: Y.AbstractType<any>[] = [root];
  while (stack.length > 0) {
    const cur = stack.pop()!;
    count++;
    if (count > max) return true;
    if (cur instanceof Y.XmlElement || cur instanceof Y.XmlFragment) {
      for (let i = 0; i < cur.length; i++) {
        const child = cur.get(i);
        if (child instanceof Y.AbstractType) stack.push(child);
      }
    }
  }
  return false;
}

/**
 * Apply a text edit to a Y.Doc fragment. Caller must have already validated
 * the range and resolved start/end positions; this function performs the CRDT
 * mutations inside Y.Doc transactions tagged with `origin`.
 *
 * Atomicity: in the cross-element branch, both XmlText nodes are resolved
 * (via getOrCreateXmlText, which may throw) AND embed sizes are validated
 * BEFORE any destructive mutation. Yjs transactions do not roll back on
 * throw — doing the throw-eligible work first is what keeps the doc whole.
 */
export function applyTextEdit(
  doc: Y.Doc,
  fragment: Y.XmlFragment,
  startPos: ElementPosition,
  endPos: ElementPosition,
  newText: string,
  origin: symbol | string = MCP_ORIGIN,
): void {
  if (startPos.elementIndex !== endPos.elementIndex) {
    doc.transact(() => {
      const startNode = fragment.get(startPos.elementIndex) as Y.XmlElement;
      const endNode = fragment.get(endPos.elementIndex) as Y.XmlElement;

      // Resolve both XmlTexts FIRST. getOrCreateXmlText is the only operation
      // here that can throw — keep it ahead of any mutation.
      const startText = getOrCreateXmlText(startNode);
      const endText = getOrCreateXmlText(endNode);

      // Validate every embed in the soon-to-be-merged delta before mutating.
      // Cap the recursion clone() will perform so a tampered doc cannot DoS.
      const preDelta = endText.toDelta();
      for (const seg of preDelta) {
        if (seg.insert instanceof Y.AbstractType && embedExceedsCap(seg.insert, MAX_EMBED_NODES)) {
          throw new Error(
            `Embed at edit boundary exceeds clone-size cap (${MAX_EMBED_NODES} nodes).`,
          );
        }
      }

      const startLen = startText.length;
      if (startPos.textOffset < startLen) {
        startText.delete(startPos.textOffset, startLen - startPos.textOffset);
      }
      if (endPos.textOffset > 0) {
        endText.delete(0, endPos.textOffset);
      }

      const remaining = endText.toDelta();
      let mergeOffset = startPos.textOffset;
      for (const seg of remaining) {
        const attrs = seg.attributes ? { ...seg.attributes } : undefined;
        if (typeof seg.insert === "string") {
          if (attrs) startText.insert(mergeOffset, seg.insert, attrs);
          else startText.insert(mergeOffset, seg.insert);
          mergeOffset += seg.insert.length;
        } else {
          // Detach embeds before re-inserting. AbstractType covers
          // Y.XmlElement (hardBreak in practice) plus Y.XmlText / Y.Map /
          // Y.Array embed types a malicious update could plant.
          const embed = seg.insert instanceof Y.AbstractType ? seg.insert.clone() : seg.insert;
          if (attrs) startText.insertEmbed(mergeOffset, embed, attrs);
          else startText.insertEmbed(mergeOffset, embed);
          mergeOffset += 1;
        }
      }

      const removeCount = endPos.elementIndex - startPos.elementIndex;
      fragment.delete(startPos.elementIndex + 1, removeCount);

      startText.insert(startPos.textOffset, newText);
    }, origin);
  } else {
    doc.transact(() => {
      const node = fragment.get(startPos.elementIndex) as Y.XmlElement;
      const textNode = getOrCreateXmlText(node);
      const deleteLen = endPos.textOffset - startPos.textOffset;
      if (deleteLen > 0) {
        textNode.delete(startPos.textOffset, deleteLen);
      }
      if (newText.length > 0) {
        textNode.insert(startPos.textOffset, newText);
      }
    }, origin);
  }
}
