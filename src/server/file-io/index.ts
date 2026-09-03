import * as crypto from "node:crypto";
import fs from "fs/promises";
import path from "path";
import {
  Y_MAP_ANNOTATIONS,
  Y_MAP_DOCUMENT_META,
  Y_MAP_FOOTNOTE_BODIES,
} from "../../shared/constants.js";
import { extractText, populateYDoc } from "../mcp/document-model.js";
import { htmlToYDoc, loadDocxWithWarnings, reconcileFootnoteIds } from "./docx.js";
import {
  type DocxComment,
  extractDocxComments,
  injectCommentsAsAnnotations,
} from "./docx-comments.js";
import { exportYDocToDocx } from "./docx-export.js";
import {
  type DocxNotes,
  footnoteDowngradeLines,
  footnoteStructuralLines,
  parseDocxFootnotes,
} from "./docx-footnotes.js";
import {
  moveCount,
  noLostFeatures,
  scanDocxLostFeatures,
  scanFailureLines,
  structuralLossLines,
} from "./docx-lost-features.js";
import { assertDocxWithinSizeLimits } from "./docx-size-gate.js";
import { normalizeAndRecordLineEnding, restoreLineEndings } from "./line-endings.js";
import { loadMarkdown, saveMarkdown } from "./markdown.js";
import type { FormatAdapter, LoadIssue, Prepared } from "./types.js";

export {
  type AcceptedSuggestion,
  type ApplyOptions,
  type ApplyOutput,
  applyTrackedChanges,
} from "./docx-apply.js";
export type { ApplyContext, FormatAdapter, LoadIssue, Prepared } from "./types.js";

// -- Adapter implementations (ADR-036 two-phase parse/apply) --

const markdownAdapter: FormatAdapter = {
  async parse(content): Promise<Prepared> {
    // Decode here, not at the consumer. `unified().parse` accepts a Buffer
    // (it is VFile-compatible), so a Buffer used to flow all the way through
    // and only surfaced once something did real string work on it. Mirrors
    // `plaintextAdapter.parse` below.
    return {
      format: "md",
      content: typeof content === "string" ? content : content.toString("utf-8"),
      issues: [],
    };
  },
  apply(doc, prepared) {
    if (prepared.format !== "md") return [];
    loadMarkdown(doc, prepared.content);
    return [];
  },
  save(doc) {
    return saveMarkdown(doc);
  },
};

const plaintextAdapter: FormatAdapter = {
  async parse(content): Promise<Prepared> {
    const text = typeof content === "string" ? content : content.toString("utf-8");
    return { format: "other", content: text, issues: [] };
  },
  apply(doc, prepared) {
    if (prepared.format !== "other") return [];
    populateYDoc(doc, normalizeAndRecordLineEnding(doc, prepared.content));
    return [];
  },
  save(doc) {
    // Restoring here rather than inside `extractText` is deliberate: that
    // function is also the flat-offset coordinate system every annotation range
    // is expressed in (Critical Rule 5), and a `\r` there would shift every
    // offset past it. Only the disk-bound copy gets the file's own endings.
    return restoreLineEndings(doc, extractText(doc));
  },
};

/**
 * The .docx adapter provides `saveBinary` (#576) — .docx write-back holds edits
 * in the Y.Doc and serializes to a `.docx` buffer on EXPLICIT save only. This
 * supersedes ADR-004's read-only default; the protective layer is now "never
 * overwrite without an explicit save" rather than `contenteditable=false`.
 * Exports body + Word comments (#1068): user/Claude `comment`-type annotations
 * AND imported Word comments written back to their source file (private notes
 * that round-trip but stay Claude-invisible), per the gate in
 * `docx-comment-export.ts` — tracked changes stay deferred.
 *
 *   - `parse` runs four readers in parallel: `loadDocxWithWarnings`,
 *     `extractDocxComments`, `parseDocxFootnotes`, and `scanDocxLostFeatures`.
 *     The last two exist because mammoth is SILENT about its highest-stakes
 *     losses — it emits zero warnings for footnotes, headers/footers or tracked
 *     changes — so the only way to be honest about them is to read the package
 *     directly. Their count-only lines join mammoth's own into a single
 *     `LoadIssue { kind: "other" }` carrying `importLosses`, which drives both
 *     the open-time toast and the persistent fidelity report. Comment-extraction
 *     failures land as `LoadIssue { kind: "comments-failed" }` rather than being
 *     swallowed.
 *   - `apply` runs `htmlToYDoc` then `injectCommentsAsAnnotations`
 *     synchronously inside the caller's transact. The snapshot/undo dance
 *     around inject lives here because Yjs doesn't roll back inner-transact
 *     writes when a callback throws.
 *   - `saveBinary` serializes the current Y.Doc body + pending comment
 *     annotations to a `.docx` buffer via `exportYDocToDocx`
 *     (trust-boundary-gated). NOT wired into auto-save.
 */
const docxAdapter: FormatAdapter = {
  async parse(content, options): Promise<Prepared> {
    const buffer = content as Buffer;

    // #1310: refuse an over-expanding archive BEFORE any reader sees the buffer.
    //
    // This has to sit ahead of the fan-out rather than inside the readers, because the first entry
    // below is mammoth, which loads its own zip and reads more parts than the other three combined.
    // Nothing added to our own `.async("text")` call sites can reach it. Throwing here also means a
    // reader added later inherits the guard instead of having to remember it.
    //
    // Deliberately a throw rather than a `LoadIssue`: every issue kind below describes a document
    // that DID import with something lost, and the fidelity-report banner reads them that way.
    // "We refused to open this" is not a fidelity loss, and dressing it as one would render a
    // banner about a document that isn't on screen.
    await assertDocxWithinSizeLimits(buffer);

    const issues: LoadIssue[] = [];
    let commentsFailed = false;
    const [loaded, comments, notes, lost] = await Promise.all([
      loadDocxWithWarnings(buffer),
      extractDocxComments(buffer).catch((err) => {
        console.error(
          "[docx-comments] Comment extraction failed; document will load without imported comments:",
          err,
        );
        issues.push({ kind: "comments-failed", error: err });
        commentsFailed = true;
        return [] as DocxComment[];
      }),
      // Footnote/endnote capture (#1123 Tier-A #3): mammoth flattens these to a
      // trailing list and emits NO warning. Read the real notes directly from
      // the ZIP so the import can BOTH surface an honest loss line AND capture
      // footnote bodies for reconstruction. parseDocxFootnotes never throws (it
      // catches per-part + per-archive); this .catch is last-resort defense.
      parseDocxFootnotes(buffer).catch((err) => {
        console.error("[docx-footnotes] parse failed unexpectedly:", err);
        return { footnotes: {}, endnotes: 0 } satisfies DocxNotes;
      }),
      // Tracked changes + headers/footers (#1142 G3): mammoth emits ZERO
      // warnings for either — measured, not assumed — so without this scan a
      // reviewed document imports with every insertion silently accepted and
      // every deletion silently discarded. Counts only; never reads w:author or
      // header text. scanDocxLostFeatures never throws; this is last-resort.
      options?.scanLostFeatures === false
        ? noLostFeatures()
        : scanDocxLostFeatures(buffer).catch((err) => {
            console.error("[docx-lost-features] scan failed unexpectedly:", err);
            return noLostFeatures();
          }),
    ]);
    // Ordered MOST-DESTRUCTIVE FIRST. Tracked changes lead: they are the only
    // entry in the whole report where the text the user reads is not the text
    // the author wrote (an insertion is silently accepted, a deletion silently
    // discarded). Headers/footers next — total destruction of visible page
    // furniture. Footnote lines follow (mostly reconstructed now, so only the
    // degraded subset reports). mammoth's style-level long tail rides last,
    // already deduped + capped inside summarizeMammothMessages.
    //
    // The fixed-set lines are bounded at 10 — up to 5 revision-family (the
    // "couldn't check" line CAN coexist with counts, since the notes parts are
    // still tallied after the main part fails), 2 header/footer, 3 note — and
    // ride on TOP of mammoth's MAX_FIDELITY_WARNINGS cap. mammoth's move bucket
    // is partitioned out of that cap and is itself bounded at 6 distinct
    // messages, so the true worst case is 10 + 8 + 6 = 24 lines for a
    // pathological document. No re-flooding, no new cap needed. Note the counts INSIDE each
    // line are unbounded, deliberately: "47 tracked deletions" is materially
    // different from "3", and these lines never reach Claude (see the note in
    // docx-lost-features.ts), so there is no oracle to bound.
    // Crucially the guard below fires when ANY source is non-empty,
    // because mammoth emits zero warnings for revisions, headers/footers OR
    // notes. The footnote line is driven off the RECONCILED partition (same
    // inputs `htmlToYDoc` reconciles in `apply` → identical result), so a
    // footnote that won't reconstruct (an orphaned definition, or a
    // mammoth-format drift) is reported as a loss, not silently claimed
    // "preserved".
    const reconciliation = reconcileFootnoteIds(loaded.html, notes.footnotes);
    // mammoth is the ONE revision family it isn't silent about: it emits
    // "unrecognised element was ignored: w:move…" for both halves of a move and
    // their range markers. `loadDocxWithWarnings` keeps those OUT of the capped
    // general set (see `partitionMammothMessages`) so they can't crowd out real
    // style warnings; here we decide whether to surface them at all. Our own
    // move line says strictly more, so it supersedes them — but ONLY when we
    // actually emitted it, so a failed scan can never leave the move loss
    // unreported by BOTH sources.
    const mammothWarnings =
      moveCount(lost.revisions) > 0
        ? loaded.warnings
        : [...loaded.warnings, ...(loaded.moveWarnings ?? [])];
    // `structural` = things that ARE gone, and only those: it drives the
    // save-time overwrite warning, whose copy asserts the backed-up original has
    // features this file doesn't. The scan-failure line rides in the banner but
    // stays out of that count — "couldn't check" is not "is missing".
    const structural = [
      ...structuralLossLines(lost),
      ...footnoteStructuralLines(notes, reconciliation),
      // A comment-extraction failure is a STRUCTURAL loss like any other: the
      // file's Word comments are not in the model and the save writes a .docx
      // without them. It previously produced only an open-time toast via the
      // `comments-failed` issue, so it was silent at the moment of overwrite —
      // the half of G3 that matters most. Count-only, like every other line.
      ...(commentsFailed
        ? ["this file's Word comments couldn't be read and won't be in the saved file"]
        : []),
    ];
    // A footnote that reconstructs but lost its bold is NOT structural loss —
    // the line literally says "preserved". Counting it would fire the overwrite
    // warning for a footnote the exporter re-emits intact, and formatted
    // footnotes are near-universal in reviewed Word files.
    const importLosses = [
      ...scanFailureLines(lost),
      ...structural,
      ...footnoteDowngradeLines(notes, reconciliation),
      ...mammothWarnings,
    ];
    if (importLosses.length > 0) {
      issues.push({
        kind: "other",
        error: undefined,
        message:
          // "features", not "formatting": a tracked change is neither formatting
          // nor merely dropped — it was APPLIED, which the lines themselves say.
          "Some Word features in this file weren't imported and won't be preserved on save: " +
          `${importLosses.join("; ")}.`,
        // Granular list for the persistent fidelity report (#1145); the joined
        // `message` above drives the transient open-time toast.
        importLosses,
        structuralLosses: structural.length,
      });
    }
    return { format: "docx", html: loaded.html, comments, footnoteBodies: notes.footnotes, issues };
  },
  async saveBinary(doc): Promise<Buffer> {
    return exportYDocToDocx(doc);
  },
  apply(doc, prepared, ctx) {
    if (prepared.format !== "docx") return [];
    const reconciledFootnotes = htmlToYDoc(doc, prepared.html, prepared.footnoteBodies);
    // Persist the reconstructed footnote bodies off-fragment so the exporter can
    // re-emit real <w:footnote> parts (#1123 Tier-A #3 PR 2). WHOLE-VALUE replace
    // (a reload with fewer footnotes must not leave stale ids). The caller's
    // transact is already origin-tagged; this documentMeta key has no observer
    // (server write-only, client/Claude-invisible) and sits OUTSIDE the comment-
    // inject rollback zone below, which only deletes newly-added annotation keys.
    doc.getMap(Y_MAP_DOCUMENT_META).set(Y_MAP_FOOTNOTE_BODIES, reconciledFootnotes);
    const out: LoadIssue[] = [];
    if (prepared.comments.length > 0) {
      // Snapshot-and-rollback: Yjs does NOT roll back inner-transact writes
      // when a callback throws, so we capture the key set before inject and
      // delete any newly-added keys on throw. Without this, a partial inject
      // would commit half the comments and re-open would hit importAnnotationId
      // dedup, permanently dropping the failing comment.
      const annotMap = doc.getMap(Y_MAP_ANNOTATIONS);
      const before = new Set(annotMap.keys());
      try {
        // The `onClamp` callback fires at most once, and only when a comment's
        // range had to be clamped to the document end. One aggregate LoadIssue,
        // not one per comment: the per-comment detail is already on stderr, and
        // what the user needs to know is "some of your Word comments did not
        // land where Word put them", once (#1752).
        injectCommentsAsAnnotations(
          doc,
          prepared.comments,
          ctx?.fileName,
          ({ count, maxClamp }) => {
            out.push({ kind: "comments-clamped", count, maxClamp });
          },
        );
      } catch (err) {
        for (const k of annotMap.keys()) {
          if (!before.has(k)) annotMap.delete(k);
        }
        console.error(
          "[docx-comments] inject failed mid-transact; document loads without imported comments:",
          err,
        );
        out.push({ kind: "inject-failed", error: err });
      }
    }
    return out;
  },
};

// -- Registry --

const adapters: Record<string, FormatAdapter> = {
  md: markdownAdapter,
  other: plaintextAdapter, // covers txt, html, and any other plaintext-routed format
  docx: docxAdapter,
};

/** Look up the adapter for a given format string. Unknown formats fall back
 * to the plaintext adapter. */
export function getAdapter(format: string): FormatAdapter {
  return adapters[format] ?? plaintextAdapter;
}

// -- Shared helpers --

/**
 * Atomic rename retry constants. Windows can throw EPERM/EACCES when another
 * process (AV scanner, file indexer, or a stale handle) is briefly holding the
 * destination file. A handful of short retries with exponential backoff clears
 * virtually all such contention in practice.
 */
const RENAME_MAX_RETRIES = 3;
const RENAME_RETRY_BASE_MS = 50;

async function renameWithRetry(tempPath: string, filePath: string): Promise<void> {
  for (let attempt = 0; attempt < RENAME_MAX_RETRIES; attempt++) {
    try {
      await fs.rename(tempPath, filePath);
      return;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if ((code === "EPERM" || code === "EACCES") && attempt < RENAME_MAX_RETRIES - 1) {
        await new Promise((r) => setTimeout(r, RENAME_RETRY_BASE_MS * 2 ** attempt));
        continue;
      }
      await fs.unlink(tempPath).catch(() => {});
      throw err;
    }
  }
}

/**
 * Filename prefix for atomic-write temp siblings. Exported so the startup
 * reaper (`reaper.ts`) can build the exact same name shape it sweeps for.
 */
export const ATOMIC_TEMP_PREFIX = ".tandem-tmp-";

/**
 * Produce a unique temp filename in the same directory as `filePath`. Uses a
 * random suffix so concurrent writers to the same directory cannot collide on
 * a shared `Date.now()` millisecond (the annotation store writes multiple
 * files in the same directory in parallel).
 */
export function tempSiblingPath(filePath: string): string {
  const rand = crypto.randomBytes(6).toString("hex");
  return path.join(path.dirname(filePath), `${ATOMIC_TEMP_PREFIX}${Date.now()}-${rand}`);
}

/**
 * Atomic file write: write to a temp file, then rename.
 * Prevents partial writes on crash. Retries the rename up to 3 times on
 * EPERM/EACCES (Windows file-handle contention) with exponential backoff.
 */
export async function atomicWrite(filePath: string, content: string): Promise<void> {
  const tempPath = tempSiblingPath(filePath);
  await fs.writeFile(tempPath, content, "utf-8");
  await renameWithRetry(tempPath, filePath);
}

/**
 * Atomic binary file write: write Buffer to a temp file, then rename.
 * Used for .docx (ZIP) output where UTF-8 encoding would corrupt binary data.
 * Shares the same EPERM/EACCES retry behaviour as `atomicWrite`.
 */
export async function atomicWriteBuffer(filePath: string, content: Buffer): Promise<void> {
  const tempPath = tempSiblingPath(filePath);
  await fs.writeFile(tempPath, content);
  await renameWithRetry(tempPath, filePath);
}
