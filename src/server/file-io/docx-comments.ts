// Extract Word comments from .docx ZIP and inject as Tandem annotations.
//
// Comments are parsed from word/comments.xml; anchor ranges are calculated
// by walking word/document.xml and tracking w:commentRangeStart/End markers
// alongside character offsets. Heading prefix offsets are accounted for so
// flat-text positions match Tandem's coordinate system after mammoth → htmlToYDoc.

import * as crypto from "node:crypto";
import { parseDocument } from "htmlparser2";
import JSZip from "jszip";
import * as Y from "yjs";
import { Y_MAP_ANNOTATION_REPLIES, Y_MAP_ANNOTATIONS } from "../../shared/constants.js";
import { withInternal } from "../../shared/origins.js";
import type { Annotation, AnnotationReply, FlatOffset } from "../../shared/types.js";
import { toFlatOffset } from "../../shared/types.js";
import { IMPORT_AUTHOR_MAX, IMPORT_REPLY_BODY_CAP, nextRev } from "../annotations/schema.js";
import { anchoredRange } from "../positions.js";
import { isCanonicalWordId } from "./docx-comment-id.js";
import {
  findAllByName,
  getAttr,
  getTextContent,
  isElement,
  walkDocumentBody,
} from "./docx-walker.js";

/**
 * Tag opening every NON-canonical hash pre-image, and the whole
 * domain-separation argument in one constant.
 *
 * A canonical pre-image starts with `commentId`, which the gates below admit
 * only through `isCanonicalWordId` — decimal digits. So a canonical pre-image
 * ALWAYS begins with a digit and a fallback pre-image NEVER does. That single
 * character is what makes the two branches disjoint, and
 * `docx-comments.test.ts` asserts it on the builders directly rather than
 * inferring it from digests.
 *
 * It is a tag on the *pre-image*, deliberately not on the id. A fallback id
 * keeps the plain `import-<hash>` shape because `docx-apply.test.ts` pins that
 * a post-#337 import id is a bare hash with no dash after the prefix — #337
 * deleted a parse of the id's shape and that spec is what stops it returning.
 */
const NON_CANONICAL_TAG = "nc:";

/**
 * The exact bytes hashed for an annotation id. Exported so the
 * domain-separation invariant above is testable as a property of the
 * *pre-image*, which is where it actually lives — a test over digests can only
 * observe that two ids happen to differ.
 */
export function annotationPreImage(
  commentId: string,
  from: number,
  to: number,
  bodyText: string,
): string {
  // Canonical: today's exact bytes, so every real document's ids are unmoved.
  if (isCanonicalWordId(commentId)) return `${commentId}\0${from}\0${to}\0${bodyText}`;
  // Fallback: JSON is injective over these fields — it renders a raw NUL as the
  // six characters `\u0000`, never a byte, so no field can forge the delimiter.
  return `${NON_CANONICAL_TAG}${JSON.stringify([commentId, from, to, bodyText])}`;
}

/** The exact bytes hashed for a reply id. Exported for the same reason. */
export function replyPreImage(
  rootCommentId: string,
  replyCommentId: string,
  bodyText: string,
): string {
  if (isCanonicalWordId(rootCommentId) && isCanonicalWordId(replyCommentId)) {
    return `${rootCommentId} ${replyCommentId} ${bodyText}`;
  }
  return `${NON_CANONICAL_TAG}${JSON.stringify([rootCommentId, replyCommentId, bodyText])}`;
}

/**
 * Deterministic annotation id for an imported Word comment.
 *
 * Inputs (commentId + range + comment body) are stable across repeated imports
 * of the same .docx, so re-opening or force-reloading the file produces the
 * same id — which lets the injection loop dedupe against the existing map
 * instead of accumulating duplicates in the durable annotation store.
 *
 * **The delimiter is load-bearing and the fields are untrusted.** Concatenating
 * them under one separator lets a token shift across a field boundary: two
 * different comments produce one id, the second is dropped as a duplicate, and
 * the loss persists into the re-saved .docx. `\0` alone does not prevent that —
 * a literal NUL byte in `comments.xml` survives htmlparser2 into both the
 * attribute and the text node (a `&#0;` reference does not; that folds to
 * U+FFFD), so `("1\0" + "2", 3, 4, "x")` and `("1", 2, 3, "4\0x")` hashed the
 * same id before the gate below. `isCanonicalWordId` is what closes it:
 * digits-only admits neither a NUL nor a space, `from`/`to` are numeric, and
 * `bodyText` is last and therefore free to contain anything.
 */
export function importAnnotationId(
  commentId: string,
  from: number,
  to: number,
  bodyText: string,
): string {
  const hash = crypto
    .createHash("sha256")
    .update(annotationPreImage(commentId, from, to, bodyText))
    .digest("hex")
    .slice(0, 12);
  return `import-${hash}`;
}

/**
 * Deterministic id for an imported Word comment reply (#1000). Stable across
 * re-imports of the same .docx (root id + reply id + body), so re-opening or
 * force-reloading dedupes against the existing replies map rather than
 * accumulating duplicates. Distinct prefix from `importAnnotationId` so a reply
 * id can never collide with a note id.
 *
 * **This one was the easier collision of the two**, because its separator is an
 * ordinary space and two of its three fields are free text: `("1", "2", "x y")`
 * and `("1", "2 x", "y")` minted the same id, needing only a `w:id` containing
 * a space rather than a NUL. Both ids are gated for that reason. The separator
 * itself is deliberately unchanged — changing it would rewrite every existing
 * reply id and duplicate every reply on the next import.
 */
export function importReplyId(
  rootCommentId: string,
  replyCommentId: string,
  bodyText: string,
): string {
  const hash = crypto
    .createHash("sha256")
    .update(replyPreImage(rootCommentId, replyCommentId, bodyText))
    .digest("hex")
    .slice(0, 12);
  return `import-reply-${hash}`;
}

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
  /**
   * Threaded Word comment replies (#1000), reconstructed from
   * `commentsExtended.xml`. Present only on root comments that have replies;
   * absent for non-threaded documents (backward compatible). Replies inherit
   * the root's anchor range and are injected as private import replies.
   */
  replies?: DocxReply[];
}

/** A threaded Word comment reply. Inherits its root comment's anchor range. */
export interface DocxReply {
  commentId: string;
  authorName: string;
  bodyText: string;
  date?: string;
}

/**
 * Cycle/runaway guard for the thread-parent walk. Word comment threads are flat
 * (one root + N replies), so this is generous; a crafted `commentsExtended.xml`
 * with a deep/cyclic `paraIdParent` chain degrades to treating the node as a
 * root rather than hanging (#1000 security review R3).
 */
const MAX_THREAD_DEPTH = 64;

/**
 * Length cap for the original Word `w:id` stored in `importSource.commentId`
 * (#1068). Real Word ids are short decimal strings; the cap only bounds a
 * crafted/hostile attribute. Export-side reuse additionally validates the
 * stored value is a canonical non-negative decimal before emitting it.
 */
export const IMPORT_COMMENT_ID_MAX = 32;

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

  // Zero-comment guard BEFORE the throw below: a package can carry an empty
  // <w:comments/> left over after every comment was deleted, and failing loudly
  // for a file with nothing to import would be its own false alarm.
  const commentMap = parseCommentMetadata(commentsXml);
  if (commentMap.size === 0) return [];

  const documentXml = await zip.file("word/document.xml")?.async("text");
  if (!documentXml) {
    // The package HAS comments but no conventionally-named body part, so we
    // cannot anchor them. `word/document.xml` is a convention, not a rule — OPC
    // names the main part in `_rels/.rels` and mammoth resolves it that way, so
    // such a package imports its text perfectly while every Word comment
    // vanishes here. Throw rather than `return []`: the adapter turns this into
    // a visible `comments-failed` issue, and silently returning "no comments"
    // for a document that has them is exactly the class of loss #1142 exists to
    // close. (Resolving the part properly — see `resolveRevisionParts` in
    // docx-lost-features.ts — is the real fix; this makes the gap loud
    // meanwhile.)
    throw new Error("Missing word/document.xml in .docx archive; cannot anchor Word comments");
  }

  const ranges = calculateCommentRanges(documentXml);

  // Thread reconstruction (#1000). Absent commentsExtended.xml ⇒ empty threading
  // ⇒ every comment resolves to itself as a root ⇒ identical to pre-#1000.
  const extendedXml = await zip.file("word/commentsExtended.xml")?.async("text");
  const threading = extendedXml ? parseCommentThreading(extendedXml) : new Map<string, string>();

  // paraId (lowercased) → commentId, to resolve a reply's parent paraId back to
  // a comment.
  const paraIdToCommentId = new Map<string, string>();
  for (const [id, meta] of commentMap) {
    if (meta.lastParaId) paraIdToCommentId.set(meta.lastParaId, id);
  }

  // Walk up paraIdParent links to the thread root. Cycle/self-parent/unresolved/
  // over-depth all terminate by treating the current node as a root.
  const resolveRoot = (startId: string): string => {
    let currentId = startId;
    const visited = new Set<string>();
    for (let depth = 0; depth < MAX_THREAD_DEPTH; depth++) {
      if (visited.has(currentId)) {
        console.error(`[docx-comments] Comment thread cycle at ${currentId}; treating as root`);
        return currentId;
      }
      visited.add(currentId);
      const paraId = commentMap.get(currentId)?.lastParaId;
      if (!paraId) return currentId;
      const parentParaId = threading.get(paraId);
      if (!parentParaId) return currentId;
      const parentId = paraIdToCommentId.get(parentParaId);
      if (!parentId || parentId === currentId) {
        if (!parentId) {
          console.error(
            `[docx-comments] Reply ${currentId} references unresolved parent paraId ${parentParaId}; treating as root`,
          );
        }
        return currentId;
      }
      currentId = parentId;
    }
    console.error(
      `[docx-comments] Comment thread exceeded depth ${MAX_THREAD_DEPTH} at ${startId}; treating as root`,
    );
    return currentId;
  };

  // Partition into roots and reply buckets (document order preserved by Map
  // iteration, which is the parse/document order).
  const rootIds: string[] = [];
  const replyBuckets = new Map<string, DocxReply[]>();
  for (const [id, meta] of commentMap) {
    const root = resolveRoot(id);
    if (root === id) {
      rootIds.push(id);
    } else {
      const bucket = replyBuckets.get(root) ?? [];
      bucket.push({
        commentId: id,
        authorName: meta.authorName,
        bodyText: meta.bodyText,
        date: meta.date,
      });
      replyBuckets.set(root, bucket);
    }
  }

  const result: DocxComment[] = [];
  for (const id of rootIds) {
    const meta = commentMap.get(id)!;
    const range = ranges.get(id);
    if (!range) {
      console.error(
        `[docx-comments] Comment ${id} has no range markers in document.xml — skipping`,
      );
      continue;
    }
    const replies = replyBuckets.get(id);
    if (replies) {
      // Order replies chronologically; stable sort keeps document order for
      // equal/absent dates.
      replies.sort((a, b) => (a.date ? Date.parse(a.date) : 0) - (b.date ? Date.parse(b.date) : 0));
    }
    result.push({
      commentId: id,
      authorName: meta.authorName,
      bodyText: meta.bodyText,
      from: range.from,
      to: range.to,
      date: meta.date,
      ...(replies && replies.length > 0 ? { replies } : {}),
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
  /**
   * Lowercased `w14:paraId` of the LAST `<w:p>` in the comment. This is what
   * `commentsExtended.xml`'s `w15:commentEx/@paraId` references (OOXML
   * CT_CommentEx §2.5.39), so it is the join key for thread reconstruction.
   */
  lastParaId?: string;
}

/** Parse comment id, author, body text, optional date, and last-paragraph paraId. */
export function parseCommentMetadata(xml: string): Map<string, CommentMeta> {
  const doc = parseDocument(xml, { xmlMode: true });
  const metaMap = new Map<string, CommentMeta>();

  for (const comment of findAllByName("w:comment", doc.children)) {
    const id = getAttr(comment, "w:id");
    if (!id) continue;

    const author = getAttr(comment, "w:author") || "Unknown";
    const date = getAttr(comment, "w:date");

    // Collect text from <w:t> elements within the comment body
    const textNodes = findAllByName("w:t", comment.children);
    const bodyText = textNodes.map((t) => getTextContent(t)).join("");

    // The comment's last paragraph paraId is the thread join key.
    // Shallow filter — only direct children of <w:comment>; a recursive
    // `findAllByName` would include <w:p> inside embedded tables, picking the
    // wrong last paraId. CT_CommentEx @paraId references the last top-level
    // paragraph (OOXML §2.5.39).
    const paragraphs = comment.children.filter(isElement).filter((c) => c.name === "w:p");
    const lastParaId =
      paragraphs.length > 0
        ? getAttr(paragraphs[paragraphs.length - 1], "w14:paraId")?.toLowerCase()
        : undefined;

    metaMap.set(id, { authorName: author, bodyText, date, lastParaId });
  }
  return metaMap;
}

/**
 * Parse `word/commentsExtended.xml` into a `childParaId → parentParaId` map
 * (both lowercased). Only entries with a `paraIdParent` (i.e. replies) are
 * included. Absent file ⇒ empty map ⇒ every comment is treated as a root
 * (backward compatible with non-threaded documents). #1000.
 */
export function parseCommentThreading(xml: string): Map<string, string> {
  const doc = parseDocument(xml, { xmlMode: true });
  const threadMap = new Map<string, string>();
  for (const ex of findAllByName("w15:commentEx", doc.children)) {
    const paraId = getAttr(ex, "w15:paraId")?.toLowerCase();
    const parent = getAttr(ex, "w15:paraIdParent")?.toLowerCase();
    if (paraId && parent) threadMap.set(paraId, parent);
  }
  return threadMap;
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
 * The ONLY way an imported annotation reaches the Y.Doc, and the reason is the
 * same one behind `writeReply` in `annotations/lifecycle.ts`: a rule about who
 * may write a record rots when it lives in prose, so it is spent as a named
 * symbol a test can count instead.
 *
 * **It stamps the author rather than trusting one.** An earlier draft of this
 * guard defended only against the writer *gaining* an author parameter, and
 * review supplied the one-line defeat that needs no such parameter: a call site
 * builds the record with `author: "claude"` and hands it straight through,
 * leaving every file-set and call-count check green. Typing the parameter to a
 * literal was the first answer and it is the weaker one — a cast satisfies a
 * type, and three of the call sites spread an existing record whose inferred
 * author is the broad union anyway. Overwriting the field means a caller cannot
 * express the wrong author at all, checked or not.
 *
 * Pinned by `tests/server/docx-import-write-seam.test.ts`.
 */
function writeImportAnnotation(map: Y.Map<unknown>, id: string, record: Annotation): void {
  map.set(id, { ...record, author: "import" } satisfies Annotation);
}

/** The reply half of the same funnel. See `writeImportAnnotation`. */
function writeImportReply(repliesMap: Y.Map<unknown>, id: string, record: AnnotationReply): void {
  repliesMap.set(id, { ...record, author: "import" } satisfies AnnotationReply);
}

/**
 * Inject extracted comments into a Y.Doc's annotation map.
 * Must be called AFTER htmlToYDoc has populated the document content,
 * so that anchoredRange can create CRDT-anchored positions.
 *
 * Imports land as **private notes** (`type: "note"`, `audience: "private"`,
 * `author: "import"`) per the v7 W8 batch-promote flow. They carry the
 * reviewer attribution in `importSource: { author, file }` rather than
 * inlining `[author]` in the content body, so the UI can render a "From:
 * <author>" byline. The user batch-promotes notes to comments via
 * `BatchPromoteBar`, which flips `audience: "private"` → `"outbound"`,
 * `author: "import"` → `"user"`, and `type: "note"` → `"comment"`. Only
 * after that promotion do they surface to Claude via channel events or
 * `tandem_getAnnotations`.
 *
 * The fileName argument is best-effort — uploads and force-reload paths
 * that don't have a meaningful file name fall back to "unknown".
 */
export function injectCommentsAsAnnotations(
  doc: Y.Doc,
  comments: DocxComment[],
  fileName?: string,
): number {
  if (comments.length === 0) return 0;

  const map = doc.getMap(Y_MAP_ANNOTATIONS);
  const repliesMap = doc.getMap(Y_MAP_ANNOTATION_REPLIES);
  const sourceFile = fileName ?? "unknown";
  let injected = 0;
  let migrated = 0;
  let reanchored = 0;
  let injectedReplies = 0;

  // Secondary dedup axis (#1150): index existing imported records by their stable
  // Word `commentId`, so a comment whose flat offsets drifted between imports is
  // updated in place instead of duplicated under a new offset-derived key. One
  // read-only O(n) pass before the transact. Two record kinds are indexed:
  //   - `author: "import"` notes → candidates for in-place drift-update.
  //   - promoted-from-import records (`promotedFrom: "note"`, which keep their
  //     `importSource` per annotation-actions.ts) → candidates for SKIP, so a
  //     drifted comment the user already promoted doesn't re-inject a ghost note
  //     (which would double-write the .docx on the next export). The update filter
  //     is `author === "import"` exactly — NOT `importSource != null`, which
  //     survives promotion (ADR-027: a blind rewrite would silently un-promote).
  // Only canonical-decimal ids are trusted (see isCanonicalWordId). Two stored
  // records can legitimately share one `commentId` only as a legacy duplicate
  // (e.g. a pre-#1150 ghost note alongside its promoted record). When that
  // happens, deterministically prefer the PROMOTED record so the skip branch
  // wins regardless of Y.Map iteration order, and log the collision — it's a
  // real inconsistency, not something to silently iteration-order away.
  const byCommentId = new Map<string, { key: string; ann: Annotation }>();
  for (const [key, val] of map as Iterable<[string, Annotation]>) {
    const cid = val?.importSource?.commentId;
    if (!isCanonicalWordId(cid)) continue;
    const isPromoted = val.promotedFrom === "note";
    if (val.author !== "import" && !isPromoted) continue;
    const existing = byCommentId.get(cid);
    if (!existing) {
      byCommentId.set(cid, { key, ann: val });
    } else if (isPromoted && existing.ann.promotedFrom !== "note") {
      byCommentId.set(cid, { key, ann: val });
      console.error(
        `[docx-comments] Duplicate imported commentId ${cid}: preferred promoted record ${key} over import note ${existing.key}.`,
      );
    } else {
      console.error(
        `[docx-comments] Duplicate imported commentId ${cid}: kept ${existing.key}, ignored ${key}.`,
      );
    }
  }

  // `withInternal` here is the authoritative origin. When callers invoke
  // this function inside an outer `withInternal` or `withReload` transact
  // (`documents/open.ts` and `documents/populate.ts` use `withInternal`;
  // `documents/watcher.ts` uses `withReload`), Y.js nested transactions inherit the outermost
  // origin — so the effective origin becomes whatever the outer call used.
  // This is intentional: a reload path calling this inside `withReload` wants
  // reload semantics (durable-sync persists, channel skips).
  withInternal(doc, () => {
    for (const comment of comments) {
      const result = anchoredRange(doc, toFlatOffset(comment.from), toFlatOffset(comment.to));
      if (!result.ok) {
        console.error(
          `[docx-comments] Skipping imported comment ${comment.commentId}: range [${comment.from}, ${comment.to}] — ${result.code}`,
        );
        continue;
      }

      const offsetId = importAnnotationId(
        comment.commentId,
        comment.from,
        comment.to,
        comment.bodyText,
      );

      // The map key under which this comment's root note lives — the offset id on
      // the stable/new paths, or an existing key when offsets drifted (#1150). The
      // reply loop below anchors `annotationId` to this so replies follow the root.
      let effectiveKey = offsetId;

      // Provenance written on every fresh/updated note for this comment. Built
      // once per iteration; only one map.set branch below runs, so no two records
      // ever alias it.
      const importSource = {
        author: comment.authorName,
        file: sourceFile,
        commentId: comment.commentId.slice(0, IMPORT_COMMENT_ID_MAX),
      };

      // Dedup: idempotent re-import. Same .docx → same id → leave the existing
      // note as-is. Legacy records stored under the pre-W8 model as
      // `type: "comment"` with content prefix `[author] ` are migrated in place
      // to the new private-note shape. Unlike the pre-#1000 code we do NOT early
      // `continue` here — reply injection below must run for existing/migrated
      // roots too (dedup is per-reply), so a pre-#1000 imported note picks up
      // its threaded replies on the next open.
      if (map.has(offsetId)) {
        const existing = map.get(offsetId) as Annotation | undefined;
        if (
          existing &&
          existing.author === "import" &&
          (existing.type === "comment" || existing.audience !== "private")
        ) {
          // `color` and `suggestedText` are stripped, not carried: the record
          // becomes a note, and the note variant of `Annotation` admits
          // neither. Nothing enforced that before — this write went into
          // `Y.Map.set(id, unknown)`, so a migrated highlight kept its `color`
          // and the stored record was simply not a valid note. Routing the
          // write through a typed writer is what surfaced it.
          const { color: _dropColor, suggestedText: _dropSuggested, ...priorFields } = existing;
          writeImportAnnotation(map, offsetId, {
            ...priorFields,
            author: "import" as const,
            type: "note" as const,
            audience: "private" as const,
            content: comment.bodyText,
            importSource,
            rev: nextRev(existing),
          });
          migrated++;
        } else if (
          existing &&
          existing.author === "import" &&
          existing.importSource &&
          existing.importSource.commentId === undefined
        ) {
          // #1068 backfill: pre-commentId import notes (already note-shaped,
          // so the migration branch above skipped them) gain the original
          // Word id so a later promote → save reuses it. One-shot write —
          // guarded on the field being absent.
          writeImportAnnotation(map, offsetId, {
            ...existing,
            author: "import" as const,
            importSource: { ...existing.importSource, commentId: importSource.commentId },
            rev: nextRev(existing),
          });
        }
      } else {
        // Offset-id miss. Before injecting, consult the commentId index — a miss
        // here may be drift (same Word comment, moved/edited), not a new comment.
        const drift = isCanonicalWordId(comment.commentId)
          ? byCommentId.get(comment.commentId)
          : undefined;

        if (drift && drift.ann.author === "import") {
          // Drift: re-anchor the existing note IN PLACE under its existing key
          // instead of duplicating. Destructure out the stale `relRange` (a
          // RelativePosition into pre-reload content htmlToYDoc just deleted) and
          // re-add it ONLY when the fresh anchor is fully anchored — otherwise the
          // record would carry a fresh flat range glued to a dead CRDT anchor,
          // which refreshRange can resolve to garbage offsets (#1150 C1). Strip a
          // stale `textSnapshot` for the same reason and by the same symmetry —
          // it's a pre-reload anchor the reload's relocation pass would chase
          // against the old text. Import notes don't carry one today, so this is
          // defense-in-depth against a future writer.
          effectiveKey = drift.key;
          // `textSnapshotTruncated` and `textSnapshotBreaks` both DESCRIBE the
          // snapshot being dropped on the line above, so they go with it (#1486).
          // Left behind, the flag would sit on a record with no snapshot at all
          // and a later writer that sets `textSnapshot` without touching it
          // would inherit a stale "this is a prefix" claim about text that is
          // actually complete; the breaks would be offsets into a string that no
          // longer exists. Same defense-in-depth rationale as the snapshot
          // itself — no import note carries either field today.
          //
          // `color` and `suggestedText` join that list for a different reason:
          // this record becomes a note, and the note variant admits neither.
          // See the migration branch above — the same unchecked shape, found
          // the same way.
          const {
            relRange: _staleRel,
            textSnapshot: _staleSnap,
            textSnapshotTruncated: _staleTrunc,
            textSnapshotBreaks: _staleBreaks,
            color: _staleColor,
            suggestedText: _staleSuggested,
            ...existingRest
          } = drift.ann;
          writeImportAnnotation(map, drift.key, {
            ...existingRest,
            type: "note" as const,
            audience: "private" as const,
            content: comment.bodyText,
            range: { from: result.range.from, to: result.range.to },
            importSource,
            rev: nextRev(drift.ann),
            ...(result.fullyAnchored ? { relRange: result.relRange } : {}),
          });
          reanchored++;
        } else if (drift && drift.ann.promotedFrom === "note") {
          // The user already promoted this Word comment to an outbound comment.
          // Re-injecting a private note for it would create a ghost that
          // double-writes the .docx on export, so we write no note and leave the
          // promotion (its content, range, and anchor) untouched. But DON'T skip
          // the reply loop: an import reply is private by its own durable property
          // regardless of its root, so a Word reply added AFTER promotion must
          // still land — point it at the promoted record via effectiveKey so it
          // threads correctly and round-trips. (An edited body is intentionally
          // not applied; promotion makes the content user-owned.)
          effectiveKey = drift.key;
        } else {
          const annotation: Annotation = {
            id: offsetId,
            author: "import" as const,
            type: "note" as const,
            audience: "private" as const,
            range: { from: result.range.from, to: result.range.to },
            content: comment.bodyText,
            status: "pending" as const,
            timestamp: comment.date ? new Date(comment.date).getTime() : Date.now(),
            rev: nextRev(),
            importSource,
            ...(result.fullyAnchored ? { relRange: result.relRange } : {}),
          };

          writeImportAnnotation(map, offsetId, annotation);
          injected++;
        }
      }

      // Inject threaded Word replies as PRIVATE import replies (#1000). They
      // inherit the root note's anchor (no separate range) and never reach
      // Claude (private + the channel/read-path guards). Deterministic
      // `importReplyId` dedupes on the replies map itself — independent of the
      // parent note's existence — so re-import after a cascade delete recreates
      // them without duplicates. Untrusted body/author are length-bounded.
      for (const reply of comment.replies ?? []) {
        const replyId = importReplyId(comment.commentId, reply.commentId, reply.bodyText);
        const clash = repliesMap.get(replyId) as AnnotationReply | undefined;
        if (clash) {
          // Normally a re-import of a reply already present — the dedup this id
          // exists for, and silence is right. But the same `continue` also
          // swallowed a genuine id COLLISION, and that path drops a reply the
          // user still has in their .docx, with the loss carrying through to the
          // re-saved file because export reads off this map. `importReplyId`'s
          // gate makes distinct inputs collide only via SHA-256 itself, so this
          // is now near-unreachable; it is logged rather than assumed away
          // because the failure is invisible from the document. Keyed on the
          // stored body differing, so the ordinary re-import stays quiet.
          if (clash.text !== reply.bodyText.slice(0, IMPORT_REPLY_BODY_CAP)) {
            console.error(
              `[docx-comments] reply id collision on ${replyId}: a different reply is already stored under this id, so this one was not imported (root=${comment.commentId})`,
            );
          }
          continue;
        }
        const replyRecord: AnnotationReply = {
          id: replyId,
          annotationId: effectiveKey,
          author: "import",
          text: reply.bodyText.slice(0, IMPORT_REPLY_BODY_CAP),
          timestamp: reply.date ? new Date(reply.date).getTime() : Date.now(),
          rev: nextRev(),
          private: true,
          importAuthor: reply.authorName.slice(0, IMPORT_AUTHOR_MAX),
        };
        writeImportReply(repliesMap, replyId, replyRecord);
        injectedReplies++;
      }
    }
  });

  if (injected > 0 || migrated > 0 || reanchored > 0 || injectedReplies > 0) {
    console.error(
      `[docx-comments] Imported ${injected}/${comments.length} Word comments as private notes` +
        (injectedReplies > 0 ? ` + ${injectedReplies} threaded replies` : "") +
        (migrated > 0 ? ` (migrated ${migrated} legacy records to note shape)` : "") +
        (reanchored > 0 ? ` (re-anchored ${reanchored} drifted notes)` : ""),
    );
  }

  return injected;
}
