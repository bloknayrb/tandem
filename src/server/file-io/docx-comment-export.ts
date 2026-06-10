// Annotation → Word-comment export gate (#1068, #576 v1.1).
//
// Decides WHICH annotations become Word comments on .docx save and resolves
// their current document ranges. The OOXML emission itself (CommentRangeStart/
// End markers + comments.xml) lives in `docx-export.ts`; this module is the
// privacy and correctness boundary in front of it.
//
// ADR-027 HARD GATE (must be preserved by any future change):
//   - ONLY `type === "comment"` annotations are exported. `note` annotations
//     are user-private and must NEVER appear in any generated XML part — not
//     their content, not their author, not their existence. `highlight`
//     annotations are likewise private visual markers and are never exported.
//   - `audience === "private"` records are excluded even if comment-typed
//     (defense-in-depth; comments should always be outbound).
//   - Replies marked `private` (note-authored replies and imported Word
//     replies, #1000) are never exported. Privacy is a durable property of
//     the reply, so a comment's exported body can only carry replies that
//     were already Claude-visible.
//   - Only `status === "pending"` comments are exported: accepting or
//     dismissing a comment in Tandem resolves it, and Word has no public
//     "resolved" channel in docx@9.x (no commentsExtended.xml support), so a
//     resolved comment is dropped from the saved file rather than resurrected.
//
// Range resolution mirrors the read paths: `refreshRange` resolves the CRDT
// `relRange` first and falls back to flat offsets (read-only here — no Y.Map
// writes, no transactions; a .docx save must not mutate the Y.Doc). Ranges
// that no longer resolve are skipped with a stderr warning instead of
// failing the save.
//
// Threaded replies: docx@9.6 cannot emit `commentsExtended.xml` (the part
// Word uses for reply threading), so exportable replies are FLATTENED into
// the comment body as attributed paragraphs. See the #1068 PR for the
// empirical evidence and trade-offs.

import type * as Y from "yjs";
import { Y_MAP_ANNOTATION_REPLIES, Y_MAP_ANNOTATIONS } from "../../shared/constants.js";
import { sanitizeAnnotation } from "../../shared/sanitize.js";
import type { Annotation, AnnotationReply } from "../../shared/types.js";
import { extractText } from "../mcp/document-model.js";
import { refreshRange } from "../positions.js";

/** A privacy-gated, range-resolved comment ready for OOXML emission. */
export interface ExportComment {
  /** Numeric Word `w:id`. Unique within one export. */
  id: number;
  /** Word comment author display name. */
  author: string;
  /** Word comment initials (derived from `author`). */
  initials: string;
  /** Comment creation date (from the annotation timestamp). */
  date: Date;
  /** Resolved flat-offset range start (current Y.Doc coordinates). */
  from: number;
  /** Resolved flat-offset range end (current Y.Doc coordinates). */
  to: number;
  /**
   * Comment body, one entry per Word comment paragraph. The FIRST entries are
   * always the annotation content verbatim (split on newlines) so a promoted
   * import without suggestion/replies round-trips to an identical
   * `importAnnotationId` body hash. Suggestion text and flattened replies
   * append AFTER the content.
   */
  bodyParagraphs: string[];
}

/** Word `w:id` is an OOXML decimal; stay comfortably inside int32. */
const MAX_WORD_COMMENT_ID = 0x7ffffff0;

/**
 * Returns the original Word comment id as a number when it can be reused
 * verbatim (canonical non-negative decimal, no leading zeros, in range), else
 * null. Reusing the original id keeps `importAnnotationId` stable across a
 * promote → save → re-open cycle.
 */
function reusableCommentId(raw: string | undefined): number | null {
  if (!raw || !/^\d{1,9}$/.test(raw)) return null;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0 || n > MAX_WORD_COMMENT_ID) return null;
  // Reject non-canonical forms ("01") — the re-imported id would be the
  // emitted canonical string and the hash would differ anyway.
  if (String(n) !== raw) return null;
  return n;
}

function authorLabel(ann: Annotation): string {
  const imported = ann.importSource?.author?.trim();
  if (imported) return imported;
  if (ann.author === "claude") return "Claude";
  if (ann.author === "user") return "User";
  return "Imported";
}

function initialsFor(label: string): string {
  const initials = label
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 3)
    .map((part) => part[0].toUpperCase())
    .join("");
  return initials || "T";
}

function replyAuthorLabel(reply: AnnotationReply): string {
  if (reply.author === "claude") return "Claude";
  if (reply.author === "user") return "User";
  return reply.importAuthor?.trim() || "Imported";
}

/** Minimal structural guard for raw Y.Map values before sanitize/refresh. */
function isAnnotationShaped(value: unknown): value is Annotation {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  const range = v.range as Record<string, unknown> | undefined;
  return (
    typeof v.id === "string" &&
    typeof v.content === "string" &&
    typeof range === "object" &&
    range !== null &&
    typeof range.from === "number" &&
    typeof range.to === "number"
  );
}

/**
 * Collect exportable (non-private) replies for an annotation, oldest first.
 */
function exportableReplies(repliesMap: Y.Map<unknown>, annotationId: string): AnnotationReply[] {
  const out: AnnotationReply[] = [];
  repliesMap.forEach((value) => {
    if (typeof value !== "object" || value === null) return;
    const reply = value as AnnotationReply;
    if (reply.annotationId !== annotationId) return;
    // ADR-027/#1000: private replies (note-authored, imported Word replies)
    // never leave Tandem. Treat anything not explicitly public-shaped as
    // private (fail closed).
    if (reply.private === true) return;
    if (typeof reply.text !== "string" || reply.text.length === 0) return;
    out.push(reply);
  });
  out.sort((a, b) => (a.timestamp ?? 0) - (b.timestamp ?? 0) || a.id.localeCompare(b.id));
  return out;
}

/** Split annotation/reply text into Word comment paragraphs. */
function toParagraphLines(text: string): string[] {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  return lines.length > 0 ? lines : [""];
}

/**
 * Build the privacy-gated, range-resolved Word comment list for a .docx save.
 *
 * READ-ONLY on the Y.Doc: range resolution uses `refreshRange` without a map
 * argument, so no Y.Map writes and no transactions occur during export.
 *
 * Annotations whose ranges no longer resolve (CRDT anchors dead AND flat
 * offsets out of bounds/inverted) are skipped with a stderr warning — a save
 * must never fail because one annotation went stale.
 */
export function prepareExportComments(doc: Y.Doc): ExportComment[] {
  const map = doc.getMap(Y_MAP_ANNOTATIONS);
  if (map.size === 0) return [];
  const repliesMap = doc.getMap(Y_MAP_ANNOTATION_REPLIES);
  const docLength = extractText(doc).length;

  const candidates: Annotation[] = [];
  map.forEach((value) => {
    if (!isAnnotationShaped(value)) return;
    const ann = sanitizeAnnotation(value, (event) => {
      console.error(`[docx-comment-export] sanitize rewrote ${event.id}: ${event.kind}`);
    });
    // ADR-027 hard gate — see module header. Order matters for clarity, not
    // correctness: every clause is independently sufficient to exclude.
    if (ann.type !== "comment") return; // never notes, never highlights
    if (ann.audience === "private") return; // defense-in-depth
    if (ann.status !== "pending") return; // resolved comments drop from the file
    candidates.push(ann);
  });
  if (candidates.length === 0) return [];

  // Resolve each candidate's CURRENT range: relRange first, flat fallback
  // (refreshRange does both, read-only without a map argument).
  const resolved: Array<{ ann: Annotation; from: number; to: number }> = [];
  for (const ann of candidates) {
    const refreshed = refreshRange(ann, doc);
    if (refreshed.kind === "failed") {
      console.error(
        `[docx-comment-export] Skipping comment ${ann.id}: CRDT range resolution failed`,
      );
      continue;
    }
    const { from, to } = refreshed.annotation.range;
    if (!Number.isInteger(from) || !Number.isInteger(to) || from < 0 || from > to) {
      console.error(
        `[docx-comment-export] Skipping comment ${ann.id}: invalid range [${from}, ${to}]`,
      );
      continue;
    }
    if (to > docLength) {
      console.error(
        `[docx-comment-export] Skipping comment ${ann.id}: range [${from}, ${to}] ` +
          `exceeds document length ${docLength}`,
      );
      continue;
    }
    resolved.push({ ann: refreshed.annotation, from, to });
  }
  if (resolved.length === 0) return [];

  // Stable output order: document position, then id.
  resolved.sort((a, b) => a.from - b.from || a.to - b.to || a.ann.id.localeCompare(b.ann.id));

  // Allocate w:id values. Promoted imports reuse their original Word id
  // (importAnnotationId stability); everything else gets the next free id.
  const usedIds = new Set<number>();
  const reserved = new Map<string, number>();
  for (const { ann } of resolved) {
    const original = reusableCommentId(ann.importSource?.commentId);
    if (original !== null && !usedIds.has(original)) {
      usedIds.add(original);
      reserved.set(ann.id, original);
    }
  }
  let nextId = 1;
  const allocate = (): number => {
    while (usedIds.has(nextId)) nextId++;
    usedIds.add(nextId);
    return nextId;
  };

  const out: ExportComment[] = [];
  for (const { ann, from, to } of resolved) {
    const label = authorLabel(ann);
    const bodyParagraphs = toParagraphLines(ann.content);
    if (ann.type === "comment" && ann.suggestedText) {
      bodyParagraphs.push("", `Suggested replacement: ${ann.suggestedText}`);
    }
    for (const reply of exportableReplies(repliesMap, ann.id)) {
      const replyLines = toParagraphLines(reply.text);
      bodyParagraphs.push("", `Reply from ${replyAuthorLabel(reply)}: ${replyLines[0]}`);
      bodyParagraphs.push(...replyLines.slice(1));
    }
    out.push({
      id: reserved.get(ann.id) ?? allocate(),
      author: label,
      initials: initialsFor(label),
      date: new Date(Number.isFinite(ann.timestamp) ? ann.timestamp : Date.now()),
      from,
      to,
      bodyParagraphs,
    });
  }
  return out;
}
