// Walk word/document.xml counting flat-text offsets.
//
// Shared between comment extraction (docx-comments.ts) and suggestion
// application (docx-apply.ts). The walker's flat-text output must match
// `extractText(htmlToYDoc(mammoth(docx)))` for any document.
//
// Key invariant: <w:del> subtrees are skipped (mammoth excludes deleted
// tracked-change text), while <w:ins> subtrees are traversed normally
// (mammoth includes inserted text).

import { parseDocument } from "htmlparser2";
import type { ChildNode, Element } from "domhandler";
import { headingPrefixLength } from "../../shared/offsets.js";

// ---------------------------------------------------------------------------
// DOM helpers (lightweight — avoids adding domutils as a direct dependency)
// ---------------------------------------------------------------------------

export function isElement(node: ChildNode): node is Element {
  return node.type === "tag";
}

export function getAttr(el: Element, name: string): string | undefined {
  return el.attribs?.[name];
}

/** Recursively collect text content from a DOM node. */
export function getTextContent(node: ChildNode): string {
  if (node.type === "text") return (node as { data: string }).data;
  if (!isElement(node)) return "";
  return node.children.map(getTextContent).join("");
}

/** Recursively find all elements with a given name. */
export function findAllByName(name: string, nodes: ChildNode[]): Element[] {
  const results: Element[] = [];
  for (const node of nodes) {
    if (isElement(node)) {
      if (node.name === name) results.push(node);
      results.push(...findAllByName(name, node.children));
    }
  }
  return results;
}

// ---------------------------------------------------------------------------
// Heading detection
// ---------------------------------------------------------------------------

/**
 * Detect whether a <w:p> has a heading paragraph style.
 * Returns the heading level (1–6) or 0 if not a heading.
 *
 * Word heading styles appear as:
 *   <w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr>...</w:p>
 *
 * mammoth maps these to <h1>–<h6>, and htmlToYDoc maps those to
 * Y.XmlElement("heading") with a `level` attribute.
 */
export function detectHeadingLevel(paragraph: Element): number {
  for (const child of paragraph.children) {
    if (!isElement(child) || child.name !== "w:pPr") continue;
    for (const prop of child.children) {
      if (!isElement(prop) || prop.name !== "w:pStyle") continue;
      const val = getAttr(prop, "w:val") || "";
      // Match "Heading1" through "Heading6" (case-insensitive)
      const match = val.match(/^heading\s*(\d)$/i);
      if (match) {
        const level = parseInt(match[1], 10);
        if (level >= 1 && level <= 6) return level;
      }
    }
  }
  return 0;
}

// ---------------------------------------------------------------------------
// Walker types
// ---------------------------------------------------------------------------

export interface TextHit {
  /** The <w:r> run element containing this text node. */
  run: Element;
  /** The <w:t> element itself. */
  textNode: Element;
  /** Flat-text offset where this text node starts. */
  offsetStart: number;
  /** The text content of this node. */
  text: string;
  /** The enclosing <w:p> paragraph element. */
  paragraph: Element;
  /** w14:paraId attribute from the paragraph, if present. */
  paragraphId: string | undefined;
}

export interface CommentStartHit {
  commentId: string;
  offset: number;
  paragraph: Element;
  paragraphId: string | undefined;
}

export interface WalkerCallbacks {
  onText?(hit: TextHit): void;
  onCommentStart?(hit: CommentStartHit): void;
  onCommentEnd?(commentId: string, offset: number): void;
}

export interface WalkerResult {
  totalLength: number;
  flatText: string;
}

// ---------------------------------------------------------------------------
// Single-character elements that mammoth maps to one character
// ---------------------------------------------------------------------------

const SINGLE_CHAR_ELEMENTS = new Set(["w:tab", "w:br", "w:noBreakHyphen", "w:softHyphen", "w:sym"]);

// ---------------------------------------------------------------------------
// Walker
// ---------------------------------------------------------------------------

/**
 * Walk `<w:body>` children in document.xml, counting flat-text offsets and
 * firing callbacks for text nodes and comment range markers.
 *
 * Skips `<w:del>` subtrees (mammoth excludes deleted tracked-change text).
 * Traverses `<w:ins>` subtrees normally (mammoth includes inserted text).
 * Skips `<w:instrText>` (field instruction text).
 */
export function walkDocumentBody(xml: string, callbacks: WalkerCallbacks = {}): WalkerResult {
  const doc = parseDocument(xml, { xmlMode: true });

  let offset = 0;
  let firstParagraph = true;
  const textParts: string[] = [];

  // Current paragraph context — set when entering a <w:p>
  let currentParagraph: Element | undefined;
  let currentParagraphId: string | undefined;

  // Current run context — set when entering a <w:r>
  let currentRun: Element | undefined;

  function walk(nodes: ChildNode[]): void {
    for (const node of nodes) {
      if (!isElement(node)) continue;

      if (node.name === "w:p") {
        // Paragraph separator (except for first paragraph)
        if (!firstParagraph) {
          offset += 1; // \n
          textParts.push("\n");
        }
        firstParagraph = false;

        // Set paragraph context
        const prevParagraph = currentParagraph;
        const prevParagraphId = currentParagraphId;
        currentParagraph = node;
        currentParagraphId = getAttr(node, "w14:paraId");

        // Detect heading style → add prefix length to offset
        const headingLevel = detectHeadingLevel(node);
        if (headingLevel > 0) {
          const prefixLen = headingPrefixLength(headingLevel);
          offset += prefixLen;
          textParts.push("#".repeat(headingLevel) + " ");
        }

        walk(node.children);

        // Restore paragraph context
        currentParagraph = prevParagraph;
        currentParagraphId = prevParagraphId;
      } else if (node.name === "w:del") {
        // Skip deleted tracked-change text — mammoth excludes it
      } else if (node.name === "w:commentRangeStart") {
        const id = getAttr(node, "w:id");
        if (id) {
          callbacks.onCommentStart?.({
            commentId: id,
            offset,
            paragraph: currentParagraph!,
            paragraphId: currentParagraphId,
          });
        }
      } else if (node.name === "w:commentRangeEnd") {
        const id = getAttr(node, "w:id");
        if (id) {
          callbacks.onCommentEnd?.(id, offset);
        }
      } else if (node.name === "w:instrText") {
        // Skip field instruction text
      } else if (node.name === "w:t") {
        const text = getTextContent(node);
        if (callbacks.onText && currentRun && currentParagraph) {
          callbacks.onText({
            run: currentRun,
            textNode: node,
            offsetStart: offset,
            text,
            paragraph: currentParagraph,
            paragraphId: currentParagraphId,
          });
        }
        offset += text.length;
        textParts.push(text);
      } else if (SINGLE_CHAR_ELEMENTS.has(node.name)) {
        offset += 1;
        textParts.push(" "); // placeholder character
      } else if (node.name === "w:r") {
        // Track current run for onText callback
        const prevRun = currentRun;
        currentRun = node;
        walk(node.children);
        currentRun = prevRun;
      } else {
        // Recurse into w:ins, w:hyperlink, w:pPr children, etc.
        walk(node.children);
      }
    }
  }

  // Find <w:body> and walk its children
  const bodyElements = findAllByName("w:body", doc.children);
  if (bodyElements.length === 0) {
    return { totalLength: 0, flatText: "" };
  }
  walk(bodyElements[0].children);

  const flatText = textParts.join("");
  return { totalLength: offset, flatText };
}
