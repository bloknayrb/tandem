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
import { type DocxNotes, footnoteLossLines, parseDocxFootnotes } from "./docx-footnotes.js";
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
    return { format: "md", content: content as string, issues: [] };
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
    populateYDoc(doc, prepared.content);
    return [];
  },
  save(doc) {
    return extractText(doc);
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
 *   - `parse` runs `loadDocxWithWarnings` + `extractDocxComments` in parallel.
 *     mammoth import-fidelity warnings land as a `LoadIssue { kind: "other" }`
 *     so the UI can tell the user what formatting mammoth dropped (and thus
 *     what the round-trip cannot recover). Comment-extraction failures land as
 *     `LoadIssue { kind: "comments-failed" }` rather than being swallowed.
 *   - `apply` runs `htmlToYDoc` then `injectCommentsAsAnnotations`
 *     synchronously inside the caller's transact. The snapshot/undo dance
 *     around inject lives here because Yjs doesn't roll back inner-transact
 *     writes when a callback throws.
 *   - `saveBinary` serializes the current Y.Doc body + pending comment
 *     annotations to a `.docx` buffer via `exportYDocToDocx`
 *     (trust-boundary-gated). NOT wired into auto-save.
 */
const docxAdapter: FormatAdapter = {
  async parse(content): Promise<Prepared> {
    const buffer = content as Buffer;
    const issues: LoadIssue[] = [];
    const [loaded, comments, notes] = await Promise.all([
      loadDocxWithWarnings(buffer),
      extractDocxComments(buffer).catch((err) => {
        console.error(
          "[docx-comments] Comment extraction failed; document will load without imported comments:",
          err,
        );
        issues.push({ kind: "comments-failed", error: err });
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
    ]);
    // Note losses lead (the named, higher-impact loss). mammoth's per-occurrence
    // warnings are already deduped + capped inside summarizeMammothMessages; the
    // note lines are a bounded fixed set (≤3), so they ride on top of that cap
    // without re-flooding — and crucially this guard fires when EITHER source is
    // non-empty, because mammoth emits zero warnings for notes. The honesty line
    // is driven off the RECONCILED partition (same inputs `htmlToYDoc` reconciles
    // in `apply` → identical result), so a footnote that won't reconstruct (an
    // orphaned definition, or a mammoth-format drift) is reported as a loss, not
    // silently claimed "preserved".
    const reconciliation = reconcileFootnoteIds(loaded.html, notes.footnotes);
    const importLosses = [...footnoteLossLines(notes, reconciliation), ...loaded.warnings];
    if (importLosses.length > 0) {
      issues.push({
        kind: "other",
        error: undefined,
        message:
          "Some Word formatting couldn't be imported and won't be preserved on save: " +
          `${importLosses.join("; ")}.`,
        // Granular list for the persistent fidelity report (#1145); the joined
        // `message` above drives the transient open-time toast.
        importLosses,
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
        injectCommentsAsAnnotations(doc, prepared.comments, ctx?.fileName);
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
