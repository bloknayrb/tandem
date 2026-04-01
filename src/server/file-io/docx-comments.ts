// Extract Word comments from .docx ZIP and inject as Tandem annotations.
//
// Comments are parsed from word/comments.xml; anchor ranges are calculated
// by walking word/document.xml and tracking w:commentRangeStart/End markers
// alongside character offsets. Heading prefix offsets are accounted for so
// flat-text positions match Tandem's coordinate system after mammoth → htmlToYDoc.

import JSZip from "jszip";
import { parseDocument } from "htmlparser2";
import type { ChildNode, Element } from "domhandler";
import * as Y from "yjs";
import { Y_MAP_ANNOTATIONS } from "../../shared/constants.js";
import { headingPrefixLength } from "../../shared/offsets.js";
import { anchoredRange } from "../positions.js";
import { toFlatOffset } from "../../shared/types.js";
import { MCP_ORIGIN } from "../events/queue.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface DocxComment {
  commentId: string;
  authorName: string;
  bodyText: string;
  from: number; // flat character offset (includes heading prefixes)
  to: number;
  date?: string;
}

// ---------------------------------------------------------------------------
// Top-level extraction
// ---------------------------------------------------------------------------

/**
 * Extract comments and their document ranges from a .docx buffer.
 * Returns an empty array when the document has no comments.
 */
export async function extractDocxComments(buffer: Buffer): Promise<DocxComment[]> {
  const zip = await JSZip.loadAsync(buffer);

  const commentsXml = await zip.file("word/comments.xml")?.async("text");
  if (!commentsXml) return [];

  const documentXml = await zip.file("word/document.xml")?.async("text");
  if (!documentXml) return [];

  const commentMap = parseCommentMetadata(commentsXml);
  if (commentMap.size === 0) return [];

  const ranges = calculateCommentRanges(documentXml);

  const result: DocxComment[] = [];
  for (const [id, meta] of commentMap) {
    const range = ranges.get(id);
    if (!range) {
      console.error(
        `[docx-comments] Comment ${id} has no range markers in document.xml — skipping`,
      );
      continue;
    }
    result.push({
      commentId: id,
      authorName: meta.authorName,
      bodyText: meta.bodyText,
      from: range.from,
      to: range.to,
      date: meta.date,
    });
  }
  return result;
}

// ---------------------------------------------------------------------------
// Comment metadata (word/comments.xml)
// ---------------------------------------------------------------------------

interface CommentMeta {
  authorName: string;
  bodyText: string;
  date?: string;
}

/** Parse comment id, author, body text, and optional date from comments XML. */
export function parseCommentMetadata(xml: string): Map<string, CommentMeta> {
  const doc = parseDocument(xml, { xmlMode: true });
  const map = new Map<string, CommentMeta>();

  for (const comment of findAllByName("w:comment", doc.children)) {
    const id = getAttr(comment, "w:id");
    if (!id) continue;

    const author = getAttr(comment, "w:author") || "Unknown";
    const date = getAttr(comment, "w:date");

    // Collect text from <w:t> elements within the comment body
    const textNodes = findAllByName("w:t", comment.children);
    const bodyText = textNodes.map((t) => getTextContent(t)).join("");

    map.set(id, { authorName: author, bodyText, date });
  }
  return map;
}

// ---------------------------------------------------------------------------
// Range calculation (word/document.xml)
// ---------------------------------------------------------------------------

/**
 * Walk the document body, counting flat-text characters (including heading
 * prefixes), and record start/end offsets for each comment range marker.
 */
export function calculateCommentRanges(xml: string): Map<string, { from: number; to: number }> {
  const doc = parseDocument(xml, { xmlMode: true });
  const ranges = new Map<string, { from: number; to: number }>();
  const openRanges = new Map<string, number>(); // commentId → startOffset

  let offset = 0;
  let firstParagraph = true;

  function walk(nodes: ChildNode[]): void {
    for (const node of nodes) {
      if (!isElement(node)) continue;

      if (node.name === "w:p") {
        // Paragraph separator (except for first paragraph)
        if (!firstParagraph) offset += 1; // \n
        firstParagraph = false;

        // Detect heading style → add prefix length to offset
        const headingLevel = detectHeadingLevel(node);
        if (headingLevel > 0) {
          offset += headingPrefixLength(headingLevel);
        }

        walk(node.children);
      } else if (node.name === "w:commentRangeStart") {
        const id = getAttr(node, "w:id");
        if (id) openRanges.set(id, offset);
      } else if (node.name === "w:commentRangeEnd") {
        const id = getAttr(node, "w:id");
        if (id && openRanges.has(id)) {
          ranges.set(id, { from: openRanges.get(id)!, to: offset });
          openRanges.delete(id);
        }
      } else if (node.name === "w:t") {
        const text = getTextContent(node);
        offset += text.length;
      } else if (node.name === "w:tab" || node.name === "w:br") {
        offset += 1;
      } else {
        // Recurse into w:r, w:hyperlink, w:pPr children, etc.
        walk(node.children);
      }
    }
  }

  // Find <w:body> and walk its children
  const bodyElements = findAllByName("w:body", doc.children);
  if (bodyElements.length === 0) {
    console.error(
      "[docx-comments] No <w:body> found in document.xml — cannot calculate comment ranges",
    );
    return ranges;
  }
  walk(bodyElements[0].children);

  if (openRanges.size > 0) {
    console.error(
      `[docx-comments] ${openRanges.size} comment range(s) had start markers but no end markers: ${[...openRanges.keys()].join(", ")}`,
    );
  }

  return ranges;
}

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
function detectHeadingLevel(paragraph: Element): number {
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
// Annotation injection
// ---------------------------------------------------------------------------

/**
 * Inject extracted comments into a Y.Doc's annotation map.
 * Must be called AFTER htmlToYDoc has populated the document content,
 * so that anchoredRange can create CRDT-anchored positions.
 */
export function injectCommentsAsAnnotations(doc: Y.Doc, comments: DocxComment[]): number {
  if (comments.length === 0) return 0;

  const map = doc.getMap(Y_MAP_ANNOTATIONS);
  let injected = 0;

  doc.transact(() => {
    for (const comment of comments) {
      const result = anchoredRange(doc, toFlatOffset(comment.from), toFlatOffset(comment.to));
      if (!result.ok) {
        console.error(
          `[docx-comments] Skipping imported comment ${comment.commentId}: range [${comment.from}, ${comment.to}] — ${result.code}`,
        );
        continue;
      }

      const id = `import-${comment.commentId}-${Date.now()}`;
      const content =
        comment.authorName !== "Unknown"
          ? `[${comment.authorName}] ${comment.bodyText}`
          : comment.bodyText;

      const annotation: Record<string, unknown> = {
        id,
        author: "import" as const,
        type: "comment" as const,
        range: { from: result.range.from, to: result.range.to },
        content,
        status: "pending" as const,
        timestamp: comment.date ? new Date(comment.date).getTime() : Date.now(),
      };

      // Attach CRDT-anchored range when available
      if (result.fullyAnchored) {
        annotation.relRange = result.relRange;
      }

      map.set(id, annotation);
      injected++;
    }
  }, MCP_ORIGIN); // origin tag prevents channel event echo

  if (injected > 0 || comments.length > 0) {
    console.error(`[docx-comments] Imported ${injected}/${comments.length} Word comments`);
  }

  return injected;
}

// ---------------------------------------------------------------------------
// DOM helpers (lightweight — avoids adding domutils as a direct dependency)
// ---------------------------------------------------------------------------

function isElement(node: ChildNode): node is Element {
  return node.type === "tag";
}

function getAttr(el: Element, name: string): string | undefined {
  return el.attribs?.[name];
}

/** Recursively collect text content from a DOM node. */
function getTextContent(node: ChildNode): string {
  if (node.type === "text") return (node as { data: string }).data;
  if (!isElement(node)) return "";
  return node.children.map(getTextContent).join("");
}

/** Recursively find all elements with a given name. */
function findAllByName(name: string, nodes: ChildNode[]): Element[] {
  const results: Element[] = [];
  for (const node of nodes) {
    if (isElement(node)) {
      if (node.name === name) results.push(node);
      results.push(...findAllByName(name, node.children));
    }
  }
  return results;
}
