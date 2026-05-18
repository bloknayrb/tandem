import * as crypto from "node:crypto";
import fs from "fs/promises";
import path from "path";
import { Y_MAP_ANNOTATIONS } from "../../shared/constants.js";
import { extractText, populateYDoc } from "../mcp/document-model.js";
import { htmlToYDoc, loadDocx } from "./docx.js";
import {
  type DocxComment,
  extractDocxComments,
  injectCommentsAsAnnotations,
} from "./docx-comments.js";
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
 * The .docx adapter omits `save` — .docx is read-only by ADR-004. Callers
 * check `adapter.save` (truthy) before attempting to serialize.
 *
 *   - `parse` runs `loadDocx` + `extractDocxComments` in parallel; comment-
 *     extraction failures land as `LoadIssue { kind: "comments-failed" }`
 *     rather than being swallowed.
 *   - `apply` runs `htmlToYDoc` then `injectCommentsAsAnnotations`
 *     synchronously inside the caller's transact. The snapshot/undo dance
 *     around inject lives here because Yjs doesn't roll back inner-transact
 *     writes when a callback throws.
 */
const docxAdapter: FormatAdapter = {
  async parse(content): Promise<Prepared> {
    const buffer = content as Buffer;
    const issues: LoadIssue[] = [];
    const [html, comments] = await Promise.all([
      loadDocx(buffer),
      extractDocxComments(buffer).catch((err) => {
        console.error(
          "[docx-comments] Comment extraction failed; document will load without imported comments:",
          err,
        );
        issues.push({ kind: "comments-failed", error: err });
        return [] as DocxComment[];
      }),
    ]);
    return { format: "docx", html, comments, issues };
  },
  apply(doc, prepared, ctx) {
    if (prepared.format !== "docx") return [];
    htmlToYDoc(doc, prepared.html);
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
 * Produce a unique temp filename in the same directory as `filePath`. Uses a
 * random suffix so concurrent writers to the same directory cannot collide on
 * a shared `Date.now()` millisecond (the annotation store writes multiple
 * files in the same directory in parallel).
 */
function tempSiblingPath(filePath: string): string {
  const rand = crypto.randomBytes(6).toString("hex");
  return path.join(path.dirname(filePath), `.tandem-tmp-${Date.now()}-${rand}`);
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
