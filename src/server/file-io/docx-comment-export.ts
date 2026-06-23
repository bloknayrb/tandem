// Annotation → Word-comment export gate (#1068, #576 v1.1).
//
// Decides WHICH annotations become Word comments on .docx save and resolves
// their current document ranges. The OOXML emission itself (CommentRangeStart/
// End markers + comments.xml) lives in `docx-export.ts`; this module is the
// privacy and correctness boundary in front of it.
//
// ADR-027 GATE (must be preserved by any future change):
//   ADR-027 governs CLAUDE visibility, not the .docx file round-trip. Two kinds
//   of annotation reach this file: (A) user/Claude comments destined for Claude,
//   and (B) imports — Word comments that CAME FROM the source .docx, stored as
//   private notes (Claude-invisible) but written back to the same file on save.
//   Writing an import back to its own file is content preservation, NOT Claude
//   exposure — the Claude-facing surfaces (`tandem_getAnnotations`,
//   `tandem_exportAnnotations`, channel) are untouched by this module.
//
//   - An ANNOTATION is exported when EITHER:
//       (A) `type === "comment"` AND `audience !== "private"` AND
//           `status === "pending"`  (the user/Claude comment path), OR
//       (B) it is an IMPORT ROUND-TRIP — `isImportRoundtrip(ann)`: `author ===
//           "import"` AND a populated `importSource` (see the predicate). Imports
//           bypass the type, audience, AND status gates: they are file content,
//           not Claude-facing, and Bryan's directive is "imported comments
//           should not be dropped" — even an accepted/dismissed import round-trips
//           (status is Tandem's review state, not the file's content). Only an
//           explicit DELETE (removal from the annotation map) drops an import.
//   - The import predicate (annotations AND replies) keys on `author ===
//     "import"` AND a corroborating field (`importSource` / `importAuthor`),
//     never on `author` alone: the `.passthrough()` durable envelope
//     enum-validates `author` but does NOT cross-validate it against the import
//     metadata, so `author:"import"` alone must not bypass the gate. A genuine
//     import always populates the corroborating field.
//   - User-authored `note`/`highlight` and user-authored `private` replies
//     NEVER satisfy the import predicate, so they are never exported.
//   - Replies: `private` replies are exported ONLY when they are import replies
//     (`author === "import"` AND a populated `importAuthor`) — imported Word
//     reply threads round-trip back to the file; note-authored and other private
//     replies never export. Privacy is a durable property of the reply.
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
import { isCanonicalWordId } from "./docx-comment-id.js";

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

/**
 * Import round-trip predicate: an annotation that ORIGINATED from the source
 * .docx (a Word comment) and must be written back to it on save.
 *
 * Keyed on `author === "import"` AND a populated `importSource.author`, never on
 * `author` alone. The durable store's `.passthrough()` envelope (annotations/
 * schema.ts) enum-validates `author` but does NOT cross-validate it against
 * `importSource`, so a tampered/legacy `<hash>.json` record carrying
 * `author:"import"` + user content but no `importSource` must not be enough to
 * bypass the privacy gate and leak into a shared file. A genuine import always
 * populates `importSource` (docx-comments.ts injection); requiring it restores
 * belt-and-suspenders alongside the (now import-bypassed) type and audience
 * gates. (A determined local attacker who hand-edits the at-rest JSON can forge
 * both fields — but that is not an escalation: they can already edit the target
 * .docx directly.) `importSource.commentId` is deliberately NOT required — it is
 * about w:id stability, not provenance, and pre-#1068 import notes lack it.
 */
function isImportRoundtrip(ann: Annotation): boolean {
  return (
    ann.author === "import" &&
    typeof ann.importSource?.author === "string" &&
    ann.importSource.author.length > 0
  );
}

/**
 * Reply analogue of `isImportRoundtrip`: an imported Word reply that round-trips
 * back to its source file. Same corroboration rationale — `author === "import"`
 * alone is insufficient under the `.passthrough()` envelope; require a populated
 * `importAuthor`, which the genuine injection path always sets (reply author
 * defaults to "Unknown", never empty — `parseCommentMetadata`). This keeps the
 * reply gate symmetric with the annotation gate.
 */
function isImportReply(reply: AnnotationReply): boolean {
  return (
    reply.author === "import" &&
    typeof reply.importAuthor === "string" &&
    reply.importAuthor.length > 0
  );
}

/**
 * Returns the original Word comment id as a number when it can be reused
 * verbatim, else null. Reusing the original id keeps `importAnnotationId`
 * stable across a promote → save → re-open cycle. The canonical-form check
 * (which also rejects "01", whose re-imported id would differ) is the shared
 * `isCanonicalWordId` predicate — the import drift-dedup index (#1150) trusts
 * the same gate.
 */
function reusableCommentId(raw: string | undefined): number | null {
  return isCanonicalWordId(raw) ? Number(raw) : null;
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
    // ADR-027/#1000: private replies never reach Claude. The .docx file
    // round-trip is a separate boundary: an imported Word reply (isImportReply)
    // is written back to the file it came from even though it's private. A
    // user-authored private reply (note-authored, or a private reply on an
    // imported comment) never exports, and an `author:"import"` reply lacking
    // the corroborating `importAuthor` is treated as untrusted (fail closed).
    if (reply.private === true && !isImportReply(reply)) return;
    if (typeof reply.id !== "string") return;
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
    // ADR-027 gate — see module header. Import round-trips (author:"import" +
    // importSource) bypass the type/audience/status gates: they are file content
    // written back to their own .docx, Claude-invisible throughout. User notes/
    // highlights and user-private content never satisfy the predicate, so they
    // stay excluded by every clause. Sanitize runs FIRST (above) so this sees
    // the canonicalized record; the admitted import set is exactly
    // {author:"import" + importSource} × {note, private-comment}.
    const importRoundtrip = isImportRoundtrip(ann);
    if (ann.type !== "comment" && !importRoundtrip) return; // never user notes/highlights
    if (ann.audience === "private" && !importRoundtrip) return; // defense-in-depth
    if (ann.status !== "pending" && !importRoundtrip) return; // resolved user comments drop
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
