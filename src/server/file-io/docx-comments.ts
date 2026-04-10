// Extract Word comments from .docx ZIP and inject as Tandem annotations.
//
// Comments are parsed from word/comments.xml; anchor ranges are calculated
// by walking word/document.xml and tracking w:commentRangeStart/End markers
// alongside character offsets. Heading prefix offsets are accounted for so
// flat-text positions match Tandem's coordinate system after mammoth → htmlToYDoc.

import { parseDocument } from "htmlparser2";
import JSZip from "jszip";
import * as Y from "yjs";
import { Y_MAP_ANNOTATIONS } from "../../shared/constants.js";
import type { FlatOffset } from "../../shared/types.js";
import { toFlatOffset } from "../../shared/types.js";
import { MCP_ORIGIN } from "../events/queue.js";
import { anchoredRange } from "../positions.js";
import { findAllByName, getAttr, getTextContent, walkDocumentBody } from "./docx-walker.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface DocxComment {
  commentId: string;
  authorName: string;
  bodyText: string;
  from: FlatOffset;
  to: FlatOffset;
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
 *
 * Delegates to the shared `walkDocumentBody` walker which also skips
 * `<w:del>` subtrees (mammoth excludes deleted tracked-change text).
 */
export function calculateCommentRanges(
  xml: string,
): Map<string, { from: FlatOffset; to: FlatOffset }> {
  const ranges = new Map<string, { from: FlatOffset; to: FlatOffset }>();
  const openRanges = new Map<string, number>(); // commentId → startOffset

  walkDocumentBody(xml, {
    onCommentStart({ commentId, offset }) {
      openRanges.set(commentId, offset);
    },
    onCommentEnd(commentId, offset) {
      if (openRanges.has(commentId)) {
        ranges.set(commentId, {
          from: toFlatOffset(openRanges.get(commentId)!),
          to: toFlatOffset(offset),
        });
        openRanges.delete(commentId);
      }
    },
  });

  if (openRanges.size > 0) {
    console.error(
      `[docx-comments] ${openRanges.size} comment range(s) had start markers but no end markers: ${[...openRanges.keys()].join(", ")}`,
    );
  }

  return ranges;
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
