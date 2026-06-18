// Post-write verification for .docx saves (#1123 Phase 0e). Closes release gate
// G1 ("no silent corruption") for the regen-only regime: AFTER the export
// regenerates the .docx bytes but BEFORE they overwrite the user's file, re-import
// the produced buffer into a throwaway Y.Doc and check it round-trips the CONTENT
// the user has on screen. A file that won't open or that silently dropped content
// must not be written silently; an honest, announced flatten must pass.
//
// SCOPE: this verifies CONTENT retention (visible text, exported comments,
// footnote bodies) — NOT structural-fidelity parity. A structural-only change
// (lost colspan, demoted heading) is a fidelity matter owned by the 0d scoreboard
// and Phases 2-3, not silent content loss; and a strict tree deep-eq would
// false-fire on benign mammoth normalization (whitespace, footnote renumbering).
//
// FAILURE CONTRACT (the asymmetry): the BLOCK path is a RETURNED verdict, never a
// thrown error. Tier-1's reimport is wrapped in a local try/catch that converts a
// parse/apply throw into a `{ kind: "blocked" }` value. The outer never-throw
// wrapper catches only UNEXPECTED errors (a bug in the verifier itself) and maps
// them to ADVISORY (allow-with-warning) — a broken verifier must never become a
// denial-of-save. Because the block is a value, the wrapper's catch can't swallow
// it. The ONLY thing that aborts a save is a confirmed-broken reimport.
//
// PRIVACY: every field of VerifyVerdict is a scalar/enum — it CANNOT carry
// document text by construction, so logging the verdict (or the advisory string,
// which is Claude-visible via the tandem_save MCP result) can't leak comment /
// footnote / body content. Match logic that touches body text runs internally and
// emits only counts. Mirrors the counts-only contract of footnoteLossLines.

import * as Y from "yjs";
import { withInternal } from "../../shared/origins.js";
import { type Capture, captureModel, EMBED_PLACEHOLDER } from "./docx-capture.js";
import { type ExportComment, prepareExportComments } from "./docx-comment-export.js";
import { getAdapter } from "./index.js";

// --- Thresholds (pinned in docx-verify.test.ts with negative controls) --------

/** Produced-buffer size above which verify skips the reimport entirely and relies
 * on the pre-overwrite snapshot (0a/0b) as the recovery floor. .docx is
 * explicit-save-only, so verify never runs on autosave — the cost is one mammoth
 * reparse per user-initiated save, making a generous ceiling affordable. */
const MAX_VERIFY_BYTES = 25 * 1024 * 1024;

/** A doc with fewer blocks than this can never trip the degenerate-collapse
 * block (a legitimate one-line .docx must always save). */
const MIN_BLOCKS_FOR_DEGENERATE = 4;
/** Reimport block count below this fraction of the live count (and live above the
 * floor above) = the doc was gutted on save. */
const DEGENERATE_BLOCK_RATIO = 0.25;
/** Visible-text retention below this = gross content loss → BLOCK. Generous so an
 * honest flatten (which retains text — unsupported blocks export AS plain text)
 * never false-blocks. */
const GROSS_RETENTION = 0.5;
/** Retention below this (but at/above gross) = soft loss → ADVISORY. */
const SOFT_RETENTION = 0.85;

// --- Verdict (scalar/enum only — structurally incapable of holding text) ------

export type BlockReason = "reimport-failed" | "degenerate-model" | "gross-text-loss";
export type AdvisoryReason = "comment-loss" | "footnote-loss" | "soft-text-loss" | "verifier-error";

/** All scalars. Safe to `console.error`/`warn` and to surface to the client. */
export interface VerifyMetrics {
  /** Visible-text multiset containment, 0..1 (1 when the live doc had no text). */
  retentionRatio: number;
  liveBlockCount: number;
  reimportBlockCount: number;
  commentsExpected: number;
  commentsResolved: number;
  footnoteIdsExpected: number;
  footnoteIdsResolved: number;
  bufferBytes: number;
  /** True when the size ceiling skipped the reimport. */
  skipped: boolean;
}

export type VerifyVerdict =
  | { kind: "ok"; metrics: VerifyMetrics }
  | { kind: "blocked"; reason: BlockReason; metrics: VerifyMetrics }
  | { kind: "advisory"; reasons: AdvisoryReason[]; metrics: VerifyMetrics };

export interface VerifyContext {
  /** Opaque doc hash for log correlation — never an absolute path (PII). */
  docId: string;
  /** Override the produced-buffer size ceiling (default MAX_VERIFY_BYTES).
   * Test-only lever so the skip path is exercisable without a 25 MB fixture. */
  maxBytes?: number;
}

// --- Internal helpers ---------------------------------------------------------

/** Concatenated visible text across the tree, excluding embed placeholders. */
function visibleText(capture: Capture): string {
  let out = "";
  for (const node of capture.tree) {
    for (const run of node.runs) {
      if (run.text !== EMBED_PLACEHOLDER) out += run.text;
    }
  }
  return out;
}

function tokenize(text: string): string[] {
  return text.toLowerCase().split(/\s+/).filter(Boolean);
}

/**
 * Order-insensitive multiset containment: the fraction of the baseline's tokens
 * that reappear in the candidate (counting multiplicity). Catches both deletion
 * (fewer tokens) and substitution (mismatched tokens). Robust to whitespace
 * normalization, O(n), and leak-proof (only the ratio escapes).
 */
function containmentRatio(baseline: string, candidate: string): number {
  const baseTokens = tokenize(baseline);
  if (baseTokens.length === 0) return 1; // nothing to lose
  const bag = new Map<string, number>();
  for (const t of tokenize(candidate)) bag.set(t, (bag.get(t) ?? 0) + 1);
  let matched = 0;
  for (const t of baseTokens) {
    const n = bag.get(t) ?? 0;
    if (n > 0) {
      matched++;
      bag.set(t, n - 1);
    }
  }
  return matched / baseTokens.length;
}

/** Normalized comment identity that survives the round-trip's author/type rewrite
 * (reimported comments all return as author:"import"/type:"note"): author display
 * name + normalized body text. Computed internally; never logged. */
function commentKey(c: ExportComment): string {
  const body = c.bodyParagraphs.join("\n").replace(/\s+/g, " ").trim().toLowerCase();
  return `${c.author.trim().toLowerCase()} ${body}`;
}

/** Count how many of `expected` reappear in `actual` (multiset match by key). */
function matchByKey<T>(expected: T[], actual: T[], keyOf: (t: T) => string): number {
  const bag = new Map<string, number>();
  for (const a of actual) {
    const k = keyOf(a);
    bag.set(k, (bag.get(k) ?? 0) + 1);
  }
  let resolved = 0;
  for (const e of expected) {
    const k = keyOf(e);
    const n = bag.get(k) ?? 0;
    if (n > 0) {
      resolved++;
      bag.set(k, n - 1);
    }
  }
  return resolved;
}

/** Footnote survival by body-text presence + cardinality (NOT OOXML-id equality:
 * the export lib may renumber ids, so id-equality would false-advisory). */
function footnoteBodyTexts(bodies: Record<string, { text: string }>): string[] {
  return Object.values(bodies)
    .map((b) => b.text.replace(/\s+/g, " ").trim().toLowerCase())
    .filter(Boolean);
}

/** Error label with NO message body — mammoth/jszip messages could embed a
 * content snippet (cf. JSON.parse leaking source). Class name only. */
function errLabel(err: unknown): string {
  return err instanceof Error ? err.name : typeof err;
}

function isDegenerate(
  liveVisible: string,
  reimportVisible: string,
  liveBlocks: number,
  reimportBlocks: number,
): boolean {
  // Live had text but the reimport is empty — the save gutted the body.
  if (liveVisible.trim().length > 0 && reimportVisible.trim().length === 0) return true;
  // Block structure collapsed (only fires above the floor, so tiny docs are safe).
  if (
    liveBlocks >= MIN_BLOCKS_FOR_DEGENERATE &&
    reimportBlocks < liveBlocks * DEGENERATE_BLOCK_RATIO
  ) {
    return true;
  }
  return false;
}

function diffContent(
  live: Capture,
  reimport: Capture,
  expectedComments: ExportComment[],
  reimportComments: ExportComment[],
  bufferBytes: number,
  ctx: VerifyContext,
): VerifyVerdict {
  const liveVisible = visibleText(live);
  const reimportVisible = visibleText(reimport);
  const retentionRatio = containmentRatio(liveVisible, reimportVisible);
  const liveBlockCount = live.tree.length;
  const reimportBlockCount = reimport.tree.length;

  const commentsResolved = matchByKey(expectedComments, reimportComments, commentKey);
  const expectedFootnotes = footnoteBodyTexts(live.footnoteBodies);
  const footnoteIdsResolved = matchByKey(
    expectedFootnotes,
    footnoteBodyTexts(reimport.footnoteBodies),
    (t) => t,
  );

  const metrics: VerifyMetrics = {
    retentionRatio,
    liveBlockCount,
    reimportBlockCount,
    commentsExpected: expectedComments.length,
    commentsResolved,
    footnoteIdsExpected: expectedFootnotes.length,
    footnoteIdsResolved,
    bufferBytes,
    skipped: false,
  };

  // Tier 1 — degenerate model → BLOCK.
  if (isDegenerate(liveVisible, reimportVisible, liveBlockCount, reimportBlockCount)) {
    console.error(`[docx-verify ${ctx.docId}] degenerate reimport (blocking save):`, metrics);
    return { kind: "blocked", reason: "degenerate-model", metrics };
  }
  // Tier 2 — gross content loss → BLOCK (protects in-session edits; the snapshot
  // is once-per-run = original-at-open, so writing over it could strand the user).
  if (retentionRatio < GROSS_RETENTION) {
    console.error(`[docx-verify ${ctx.docId}] gross text loss (blocking save):`, metrics);
    return { kind: "blocked", reason: "gross-text-loss", metrics };
  }
  // Tier 3 — soft signals → ADVISORY (write + warn; may be benign anchor drift).
  const reasons: AdvisoryReason[] = [];
  if (commentsResolved < expectedComments.length) reasons.push("comment-loss");
  if (footnoteIdsResolved < expectedFootnotes.length) reasons.push("footnote-loss");
  if (retentionRatio < SOFT_RETENTION) reasons.push("soft-text-loss");
  if (reasons.length > 0) {
    console.error(`[docx-verify ${ctx.docId}] integrity advisory (allowing save):`, {
      reasons,
      ...metrics,
    });
    return { kind: "advisory", reasons, metrics };
  }
  // Passing verify leaves a breadcrumb so "we verified this save" is provable.
  console.warn(`[docx-verify ${ctx.docId}] ok:`, metrics);
  return { kind: "ok", metrics };
}

// --- Public API ---------------------------------------------------------------

/**
 * Verify that `buffer` (the just-regenerated .docx) round-trips the CONTENT of
 * `liveDoc`. Returns a verdict; NEVER throws (a verifier-internal failure
 * degrades to an advisory, not a block). `liveDoc` is touched read-only (only via
 * captureModel + prepareExportComments); the reimport target is a throwaway Y.Doc
 * destroyed in `finally`.
 */
export async function verifyDocxRoundtrips(
  buffer: Buffer,
  liveDoc: Y.Doc,
  ctx: VerifyContext,
): Promise<VerifyVerdict> {
  const bufferBytes = buffer.length;

  // Capture the live doc + the EXACT set the export gate emitted (recomputed on
  // the unchanged liveDoc → byte-identical to what saveBinary wrote; avoids
  // rippling the adapter signature). Read-only on liveDoc.
  let live: Capture;
  let expectedComments: ExportComment[];
  try {
    live = captureModel(liveDoc);
    expectedComments = prepareExportComments(liveDoc);
  } catch (err) {
    console.error(`[docx-verify ${ctx.docId}] live capture failed (allowing save):`, errLabel(err));
    return { kind: "advisory", reasons: ["verifier-error"], metrics: emptyMetrics(bufferBytes) };
  }

  // Size ceiling — skip the reimport, rely on the pre-overwrite snapshot. NOT a
  // detected-discrepancy event, so no user-facing advisory (a per-large-save nag
  // would cry wolf); a server breadcrumb keeps the skip traceable, not silent.
  const ceiling = ctx.maxBytes ?? MAX_VERIFY_BYTES;
  if (bufferBytes > ceiling) {
    console.warn(
      `[docx-verify ${ctx.docId}] skipped: buffer ${bufferBytes} bytes > ceiling ${ceiling}; relying on pre-overwrite snapshot`,
    );
    return {
      kind: "ok",
      metrics: {
        ...emptyMetrics(bufferBytes),
        retentionRatio: 1,
        liveBlockCount: live.tree.length,
        skipped: true,
      },
    };
  }

  const reimportDoc = new Y.Doc();
  try {
    let reimport: Capture;
    let reimportComments: ExportComment[];
    try {
      // Reimport through the REAL adapter (parse + apply, not parse alone — apply
      // populates Y_MAP_FOOTNOTE_BODIES + injects comments, else those checks are
      // vacuous). withInternal supplies the outer transaction htmlToYDoc needs.
      const adapter = getAdapter("docx");
      const prepared = await adapter.parse(buffer);
      withInternal(reimportDoc, () =>
        adapter.apply(reimportDoc, prepared, { fileName: "verify-reimport.docx" }),
      );
      reimport = captureModel(reimportDoc);
      reimportComments = prepareExportComments(reimportDoc);
    } catch (err) {
      // Confirmed-broken output: the bytes we'd write don't re-open. BLOCK — but
      // as a RETURNED value, so the outer catch can't downgrade it to advisory.
      console.error(`[docx-verify ${ctx.docId}] reimport failed (blocking save):`, errLabel(err));
      return {
        kind: "blocked",
        reason: "reimport-failed",
        metrics: { ...emptyMetrics(bufferBytes), liveBlockCount: live.tree.length },
      };
    }
    return diffContent(live, reimport, expectedComments, reimportComments, bufferBytes, ctx);
  } catch (err) {
    // Verifier-internal error (a bug in the diff logic) → allow-with-warning. A
    // broken verifier must never deny a save.
    console.error(
      `[docx-verify ${ctx.docId}] unexpected verification error (allowing save):`,
      errLabel(err),
    );
    return {
      kind: "advisory",
      reasons: ["verifier-error"],
      metrics: { ...emptyMetrics(bufferBytes), liveBlockCount: live.tree.length },
    };
  } finally {
    // Swallow a destroy() throw. A throw out of `finally` overrides the verdict
    // already returned above and propagates as a save-error — inverting the
    // asymmetry (a verifier-internal fault denying a save, the one direction
    // that must never happen). The throwaway doc has no observers today
    // (it never goes through attachObservers/Hocuspocus, where destroy
    // listeners attach), so destroy() can't throw — this keeps the asymmetry
    // UNCONDITIONAL rather than contingent on that remaining true.
    try {
      reimportDoc.destroy();
    } catch (err) {
      console.error(`[docx-verify ${ctx.docId}] reimport doc destroy failed:`, errLabel(err));
    }
  }
}

function emptyMetrics(bufferBytes: number): VerifyMetrics {
  return {
    retentionRatio: 0,
    liveBlockCount: 0,
    reimportBlockCount: 0,
    commentsExpected: 0,
    commentsResolved: 0,
    footnoteIdsExpected: 0,
    footnoteIdsResolved: 0,
    bufferBytes,
    skipped: false,
  };
}

/** Fixed, content-free advisory strings for `FidelityReport.integrityWarnings`
 * and the save toast. Counts only — never document text. Honest about WHAT is
 * recoverable: the snapshot is the file as first opened this session (0a),
 * not the immediately-prior save. */
export function integrityWarningLines(verdict: VerifyVerdict): string[] {
  if (verdict.kind !== "advisory") return [];
  const lines: string[] = [];
  const m = verdict.metrics;
  if (verdict.reasons.includes("comment-loss")) {
    const n = m.commentsExpected - m.commentsResolved;
    lines.push(
      `${n === 1 ? "1 comment" : `${n} comments`} may not have been preserved on this save — ` +
        `the original version of this file is backed up and can be restored`,
    );
  }
  if (verdict.reasons.includes("footnote-loss")) {
    const n = m.footnoteIdsExpected - m.footnoteIdsResolved;
    lines.push(
      `${n === 1 ? "1 footnote" : `${n} footnotes`} may not have been preserved on this save — ` +
        `the original version of this file is backed up and can be restored`,
    );
  }
  if (verdict.reasons.includes("soft-text-loss")) {
    lines.push(
      "This save may have changed more text than expected — " +
        "the original version of this file is backed up and can be restored",
    );
  }
  if (verdict.reasons.includes("verifier-error")) {
    lines.push(
      "Tandem couldn't fully verify this save — " +
        "the original version of this file is backed up and can be restored",
    );
  }
  return lines;
}

/** Fixed, content-free message for the blocked-save error notification. Always
 * reassures that the on-disk file was left untouched — a block aborts BEFORE the
 * write, and the user's edits remain in the live session. */
export function blockReasonMessage(reason: BlockReason): string {
  const tail = " — your original file was left unchanged";
  switch (reason) {
    case "reimport-failed":
      return `the regenerated file did not re-open cleanly${tail}`;
    case "degenerate-model":
      return `the regenerated file was missing most of its content${tail}`;
    case "gross-text-loss":
      return `the regenerated file was missing a large amount of text${tail}`;
  }
}
