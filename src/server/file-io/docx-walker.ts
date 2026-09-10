// Walk word/document.xml counting flat-text offsets.
//
// Shared between comment extraction (docx-comments.ts) and suggestion
// application (docx-apply.ts). The walker's flat-text output must match
// `extractText(htmlToYDoc(mammoth(docx)))` for any document.
//
// Key invariant: <w:del> and both <w:moveFrom>/<w:moveTo> subtrees are skipped
// (mammoth excludes all three), while <w:ins> subtrees are traversed normally
// (mammoth includes inserted text).

import { hex as dingbatHex } from "dingbat-to-unicode";
import type { ChildNode, Element } from "domhandler";
import { parseDocument } from "htmlparser2";
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

/**
 * The local part of a possibly-prefixed OOXML name (`w:del` → `del`).
 *
 * `w:` is a convention, not a guarantee: OOXML binds WordprocessingML by URI, so
 * a producer may declare `xmlns:x="…/wordprocessingml/2006/main"` and emit
 * `<x:del>`. Measured (see `docx-lost-features.ts`): mammoth canonicalizes by
 * URI and imports such a package identically. Any reader whose WRONG answer is
 * fabrication or an offset shift must therefore match local names.
 */
export function localName(name: string): string {
  return name.slice(name.lastIndexOf(":") + 1);
}

/** Recursively collect text content from a DOM node. */
export function getTextContent(node: ChildNode): string {
  if (node.type === "text") return (node as { data: string }).data;
  if (!isElement(node)) return "";
  return node.children.map(getTextContent).join("");
}

// Subtrees whose text mammoth does NOT surface. Kept adjacent to the walker
// below, which skips the same two for the same reason — any reader that
// extracts "the text a user would see" must agree with the importer or it
// invents content that is not in the document.
const INVISIBLE_TEXT_ELEMENTS = new Set([
  "del", // deleted tracked-change text — already removed from the document
  "delInstrText", // deleted field instruction
  "instrText", // field instruction (e.g. ` HYPERLINK "https://…" `), not body text
  // Both halves of a Word "move". Measured: mammoth recognizes neither, so it
  // drops both subtrees — the moved text is simply absent from the import.
  "moveFrom",
  "moveTo",
]);

// mammoth's `ignoreElements` (body-reader.js:700-720), restricted to the
// property containers. An ignored element returns `emptyResult()` with NO
// recursion (:45-56), so nothing inside one reaches a reader — while this
// walker's catch-all used to recurse and count every `<w:tab/>` inside
// `<w:pPr><w:tabs>`, a tab-STOP DEFINITION, as a body character. Matched by
// `localName` like `INVISIBLE_TEXT_ELEMENTS` is, for the reason in that
// function's docblock.
//
// `detectHeadingLevel` reads `<w:pPr>` DIRECTLY off the paragraph element
// rather than through `walk`, so skipping the subtree here does not blind
// heading detection.
const SKIPPED_SUBTREE_ELEMENTS = new Set([
  "pPr",
  "rPr",
  "sectPr",
  "tblPr",
  "tblGrid",
  "trPr",
  "tcPr",
]);

/**
 * Like `getTextContent`, but skipping the subtrees mammoth drops.
 *
 * NOT a full model of what the import produces — `walkDocumentBody` additionally
 * resolves `flatTextForElement` elements (tab, break, symbol, both hyphens) and
 * separates paragraphs with `\n`, neither of which this does. It is exactly
 * `getTextContent` minus the
 * invisible subtrees, which is what a body-capture caller needs.
 *
 * Use this — not `getTextContent` — whenever the result will be written back
 * into a document. `getTextContent` recurses into `<w:del>` and `<w:instrText>`,
 * so using it to capture body text RESURRECTS deleted text and splices raw
 * field instructions in as literal prose. That is silent fabrication into a
 * file the user shares, strictly worse than a silent loss: it can restore
 * something an author deliberately removed, and it routes a `HYPERLINK` field's
 * URL around the export trust boundary as plain text.
 */
export function getVisibleTextContent(node: ChildNode): string {
  if (node.type === "text") return (node as { data: string }).data;
  if (!isElement(node)) return "";
  if (INVISIBLE_TEXT_ELEMENTS.has(localName(node.name))) return "";
  return node.children.map(getVisibleTextContent).join("");
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

/**
 * A span the walker produced from a NON-`<w:t>` element (`<w:tab>`, `<w:br>`,
 * `<w:sym>`, either hyphen) — i.e. flat text `buildRun("w:t", …)` cannot
 * reproduce.
 *
 * Fired for the ZERO-LENGTH cases too (an unrecognised `w:br w:type`, an
 * unmapped `w:sym`): the run-keyed half of the apply-side fence is
 * length-independent and is the only thing that can see them (#1754).
 */
export interface SpecialCharSpan {
  offsetStart: number;
  /** UTF-16 units the element contributed. May be 0. */
  length: number;
  paragraph: Element;
  /** The enclosing `<w:r>`, or undefined for an element directly under `<w:p>`. */
  run: Element | undefined;
}

export interface WalkerCallbacks {
  onText?(hit: TextHit): void;
  onCommentStart?(hit: CommentStartHit): void;
  onCommentEnd?(commentId: string, offset: number): void;
  onSpecialChar?(span: SpecialCharSpan): void;
}

export interface WalkerResult {
  totalLength: number;
  flatText: string;
}

// ---------------------------------------------------------------------------
// Non-<w:t> elements that contribute flat text
// ---------------------------------------------------------------------------

/**
 * The flat text a non-`<w:t>` element contributes, or `null` for "not one of
 * mine" (the caller then recurses). Transcribed from mammoth, not paraphrased:
 * `body-reader.js:315-327,360-368` + `readSymbol` (:233-249), and
 * `document-to-html.js:337-352,373`.
 *
 * Deliberately keeps the `w:`-PREFIXED name matching the walker has always used
 * on this arm. Widening it to `localName` is a namespace change (it would newly
 * count DrawingML text-box characters and an unbound-prefix `x:tab`, neither of
 * which mammoth reads) and belongs to the deferred half of #1754.
 */
function flatTextForElement(el: Element): string | null {
  switch (el.name) {
    case "w:tab":
      return "\t";
    // Written as escapes on purpose: U+2011 is easy to mistake for ASCII "-" and
    // U+00AD is INVISIBLE in a diff, so a mis-transcription would ship silently.
    case "w:noBreakHyphen":
      return "\u2011";
    case "w:softHyphen":
      return "\u00AD";
    case "w:br": {
      const type = getAttr(el, "w:type");
      if (type === undefined || type === "textWrapping") return "\n";
      // DEFERRED (#1754, decision B): a page/column break keeps the historical
      // one-character placeholder, which the real import does NOT produce. Do
      // not "finish the table" here — the reconciliation for these is a
      // separate, larger piece of work and #1754 stays open for it.
      if (type === "page" || type === "column") return " ";
      // mammoth's `else` arm warns and emits nothing. An unknown type must NOT
      // route to the placeholder above.
      return "";
    }
    case "w:sym": {
      const font = getAttr(el, "w:font");
      const char = getAttr(el, "w:char");
      // Bail BEFORE calling hex(): dingbat-to-unicode's codePoint() calls
      // typeface.toUpperCase(), so hex(undefined, char) throws — and this walker
      // also runs at apply time against bytes re-read from disk, with mammoth
      // nowhere in the path to have screened them.
      if (font === undefined || char === undefined) return "";
      const resolved =
        dingbatHex(font, char) ??
        (/^F0..$/.test(char) ? dingbatHex(font, char.slice(2)) : undefined);
      return resolved?.string ?? "";
    }
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------
// Walker
// ---------------------------------------------------------------------------

/**
 * Walk `<w:body>` children in document.xml, counting flat-text offsets and
 * firing callbacks for text nodes and comment range markers.
 *
 * Skips `<w:del>` and both move halves (mammoth excludes all three).
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
      } else if (node.name === "w:moveFrom" || node.name === "w:moveTo") {
        // Skip BOTH halves of a Word "move" — mammoth recognizes neither
        // element (they are in neither its reader map nor its ignore list), so
        // it discards both subtrees. Measured: a document whose moveTo carries
        // 15 characters made this walker's flat text 15 chars longer than the
        // import, shifting every comment anchor after the move onto unrelated
        // text. The invariant at the top of this file is not optional.
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
      } else if (node.name === "w:r") {
        // Track current run for onText callback
        const prevRun = currentRun;
        currentRun = node;
        walk(node.children);
        currentRun = prevRun;
      } else if (SKIPPED_SUBTREE_ELEMENTS.has(localName(node.name))) {
        // A property container. mammoth ignores it WITHOUT recursing, so a
        // <w:tab/> declaring a tab stop inside <w:pPr><w:tabs> is not a body
        // character. Descending here is what made every tabbed Word document
        // fail the apply-time flat-text guard (#1754).
      } else {
        const special = flatTextForElement(node);
        if (special === null) {
          // Recurse into w:ins, w:hyperlink, w:tbl, etc.
          walk(node.children);
          continue;
        }
        // Fire for the "" cases too — the apply-side run-keyed fence is
        // length-independent and is the only half that can see them.
        callbacks.onSpecialChar?.({
          offsetStart: offset,
          length: special.length,
          paragraph: currentParagraph!,
          run: currentRun,
        });
        offset += special.length;
        if (special.length > 0) textParts.push(special);
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
