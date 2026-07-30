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
//   exposure — the annotation-reading surfaces (`tandem_getAnnotations`,
//   `tandem_exportAnnotations`, channel) are untouched by this module.
//
//   ONE Claude-visible datum does originate here (#1142 G3):
//   `commentExportDowngrades`' integrity line carries a COUNT of comments whose
//   location could not be found. That count is drawn from the candidate set
//   above, which by design includes imported private notes — so it discloses
//   "some comment was dropped" without disclosing which, who, or what. This is
//   the same channel, same derivation and same wording as the shipped
//   `integrityWarningLines` comment-loss advisory (docx-verify.ts), which is
//   already computed from this module's output; it is consistent with the
//   existing boundary rather than a new crossing. The flattened-reply count is
//   deliberately NOT returned in `SaveResult` at all — it would count private
//   imported replies, and it is a formatting downgrade, not a loss.
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

/**
 * The restore promise every integrity advisory ends with. ONE definition,
 * because the verifier's advisories and this module's land adjacent in a single
 * `integrityWarnings` list — two phrasings of the same promise in one list reads
 * as two different guarantees. Honest about WHAT is recoverable: the snapshot is
 * the file as first opened this session (0a), not the immediately-prior save.
 *
 * It lives here rather than in docx-verify.ts, its more natural home, only for
 * dependency direction: verify already imports this module, so defining it there
 * would close a cycle.
 */
export const BACKUP_RESTORE_TAIL =
  "the original version of this file is backed up and can be restored";

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
  /**
   * How many replies were flattened into `bodyParagraphs` for this comment
   * (#1142 G3). Set at the flattening site itself so the reported count can
   * never drift from what is actually written — deriving it by re-running the
   * privacy gate, or by counting `"Reply from "` prefixes in the body, would
   * both be wrong (the second false-positives on user text). Count only: it
   * feeds a count-only export-downgrade line and never names a replier.
   *
   * EXPORT-SIDE TELEMETRY ONLY — deliberately NOT part of round-trip identity.
   * A live comment carries `flattenedReplies: 2` while its reimported twin
   * carries 0 (the flattened text comes back as body paragraphs, not replies),
   * so a structural deep-equal between the two generations would false-fire as
   * comment loss. `commentKey` (docx-verify.ts) reads only `author` +
   * `bodyParagraphs` — keep it that way.
   */
  flattenedReplies: number;
}

/**
 * Why `prepareExportComments` dropped a comment. A CLOSED enum on purpose: the
 * three resolve-failure sites log `ann.id` and the raw `[from, to]` offsets to
 * stderr, and typing this as `string` would invite a caller to forward one of
 * those messages into a report line — flat offsets are positional metadata about
 * document content. The reasons are aggregated into a single undifferentiated
 * total by `commentExportDowngrades`; no reason is ever surfaced on its own.
 */
export type ExportSkipReason = "malformed" | "range-failed" | "invalid-range" | "out-of-bounds";

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
 *
 * `onSkip` makes those drops COUNTABLE (#1142 G3) — they were previously only a
 * stderr line, and Phase 0e structurally cannot see them (see
 * `commentExportDowngrades`). It is optional, so the three pre-existing call
 * sites are untouched. Supplying it also silences THIS MODULE'S stderr for the
 * call: a counting caller runs in addition to the export and verify calls, which
 * already log the same drops. (It does not silence everything — `refreshRange`
 * emits its own partial/inverted-range warnings independently — so net volume is
 * unchanged, not reduced.) The reason is a closed enum carrying no annotation id
 * and no offsets: it reaches a Claude-visible surface, so it must never become a
 * content oracle.
 */
export function prepareExportComments(
  doc: Y.Doc,
  onSkip?: (reason: ExportSkipReason) => void,
): ExportComment[] {
  // Counting call → stay quiet; the export + verify calls own the logging.
  const warn = onSkip ? () => {} : (msg: string): void => console.error(msg);
  const map = doc.getMap(Y_MAP_ANNOTATIONS);
  if (map.size === 0) return [];
  const repliesMap = doc.getMap(Y_MAP_ANNOTATION_REPLIES);

  const candidates: Annotation[] = [];
  map.forEach((value) => {
    if (!isAnnotationShaped(value)) {
      // A FOURTH drop, earlier and previously entirely silent (no log, no
      // counter): a durable record that lost or corrupted its id/content/range
      // is a real Word comment that will not be written. Counting it matters —
      // omitting it would under-report on the surface built to stop
      // under-reporting.
      onSkip?.("malformed");
      return;
    }
    const ann = sanitizeAnnotation(value, (event) => {
      warn(`[docx-comment-export] sanitize rewrote ${event.id}: ${event.kind}`);
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

  // AFTER the gate, not before: `extractText` walks the whole document, and a
  // .docx carrying only highlights or private notes has nothing to export. This
  // function runs twice per save on the live doc (the downgrade count, then the
  // export — the verifier is handed the first result rather than recomputing),
  // so a wasted walk here is a wasted walk twice over.
  const docLength = extractText(doc).length;

  // Resolve each candidate's CURRENT range: relRange first, flat fallback
  // (refreshRange does both, read-only without a map argument).
  const resolved: Array<{ ann: Annotation; from: number; to: number }> = [];
  for (const ann of candidates) {
    const refreshed = refreshRange(ann, doc);
    if (refreshed.kind === "failed") {
      warn(`[docx-comment-export] Skipping comment ${ann.id}: CRDT range resolution failed`);
      onSkip?.("range-failed");
      continue;
    }
    const { from, to } = refreshed.annotation.range;
    if (!Number.isInteger(from) || !Number.isInteger(to) || from < 0 || from > to) {
      warn(`[docx-comment-export] Skipping comment ${ann.id}: invalid range [${from}, ${to}]`);
      onSkip?.("invalid-range");
      continue;
    }
    if (to > docLength) {
      warn(
        `[docx-comment-export] Skipping comment ${ann.id}: range [${from}, ${to}] ` +
          `exceeds document length ${docLength}`,
      );
      onSkip?.("out-of-bounds");
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
    const replies = exportableReplies(repliesMap, ann.id);
    for (const reply of replies) {
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
      flattenedReplies: replies.length,
    });
  }
  return out;
}

/**
 * The comment half of a `.docx` save's fidelity reporting (#1142 G3). Two
 * previously-unreported outcomes, routed to DIFFERENT channels because they
 * mean different things to the user — `FidelityReport`'s channel contract
 * (shared/types.ts) splits on user meaning, not on provenance:
 *
 *   - `downgrades` — replies are FLATTENED into the parent comment body because
 *     docx@9.6 can't emit `commentsExtended.xml` (module header). ANNOUNCED and
 *     expected: the reply TEXT is still written, only the thread structure is
 *     lost. Persisted to the calm `exportDowngrades` notice and deliberately
 *     NOT returned in `SaveResult` — imported Word reply threads round-trip by
 *     design (#1000), so nearly every colleague-reviewed `.docx` has them, and
 *     a per-save toast for a non-loss would be pure fatigue.
 *   - `integrity` — a comment whose range no longer resolves is dropped from
 *     the file entirely, with only a stderr line. UNEXPECTED loss, and restore
 *     is the correct remedy, so it belongs in the louder channel that carries
 *     the restore on-ramp. Phase 0e cannot catch it: `verifyDocxRoundtrips`
 *     builds its `expectedComments` from this same already-reduced output, so
 *     the dropped comment is absent from BOTH sides of the comparison and the
 *     verify passes clean. Its wording matches `integrityWarningLines`' existing
 *     comment-loss advisory, which is derived from the same candidate set.
 *
 * Counts and fixed strings only — no replier names, no annotation ids, no skip
 * reasons. Both channels reach the persistent report, and `integrity` also
 * reaches Claude via `tandem_save`.
 */
export function commentExportDowngrades(
  comments: ExportComment[],
  skipped: { unresolved: number; malformed: number },
): { downgrades: string[]; integrity: string[] } {
  const downgrades: string[] = [];
  const integrity: string[] = [];
  const replies = comments.reduce((sum, c) => sum + c.flattenedReplies, 0);
  if (replies > 0) {
    downgrades.push(
      replies === 1
        ? "1 comment reply flattened into its parent comment (Word reply threads aren't supported)"
        : `${replies} comment replies flattened into their parent comments ` +
            "(Word reply threads aren't supported)",
    );
  }
  // Reported apart, because they are different claims. A comment whose RANGE
  // failed to resolve got past the ADR-027 gate — it was going to be written and
  // wasn't. A MALFORMED record is rejected before that gate, so we cannot even
  // tell whether it was a comment: it may well have been a highlight or a
  // private note that would never have been exported. Folding the two would tell
  // a user their comment vanished when nothing of the sort happened — on the one
  // surface built to be trustworthy about loss.
  if (skipped.unresolved > 0) {
    const n = skipped.unresolved;
    integrity.push(
      `${n === 1 ? "1 comment was" : `${n} comments were`} dropped because ` +
        `${n === 1 ? "its" : "their"} location could no longer be found — ` +
        BACKUP_RESTORE_TAIL,
    );
  }
  if (skipped.malformed > 0) {
    const n = skipped.malformed;
    integrity.push(
      `${n === 1 ? "1 damaged annotation record" : `${n} damaged annotation records`} could ` +
        `not be read, so anything ${n === 1 ? "it" : "they"} anchored was not written — ` +
        BACKUP_RESTORE_TAIL,
    );
  }
  return { downgrades, integrity };
}
