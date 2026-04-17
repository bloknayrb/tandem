import * as crypto from "node:crypto";
import fs from "fs/promises";
import path from "path";
import { extractText, populateYDoc } from "../mcp/document-model.js";
import { htmlToYDoc, loadDocx } from "./docx.js";
import {
  type DocxComment,
  extractDocxComments,
  injectCommentsAsAnnotations,
} from "./docx-comments.js";
import { loadMarkdown, saveMarkdown } from "./markdown.js";
import type { FormatAdapter } from "./types.js";

export {
  type AcceptedSuggestion,
  type ApplyOptions,
  type ApplyOutput,
  applyTrackedChanges,
} from "./docx-apply.js";
export type { FormatAdapter } from "./types.js";

// -- Adapter implementations --

const markdownAdapter: FormatAdapter = {
  canSave: true,
  load(doc, content) {
    loadMarkdown(doc, content as string);
  },
  save(doc) {
    return saveMarkdown(doc);
  },
};

const plaintextAdapter: FormatAdapter = {
  canSave: true,
  load(doc, content) {
    populateYDoc(doc, content as string);
  },
  save(doc) {
    return extractText(doc);
  },
};

const docxAdapter: FormatAdapter = {
  canSave: false,
  async load(doc, content) {
    const buffer = content as Buffer;
    const [html, comments] = await Promise.all([
      loadDocx(buffer),
      extractDocxComments(buffer).catch((err) => {
        console.error(
          "[docx-comments] Comment extraction failed; document will load without imported comments:",
          err,
        );
        return [] as DocxComment[];
      }),
    ]);
    htmlToYDoc(doc, html);
    if (comments.length > 0) {
      injectCommentsAsAnnotations(doc, comments);
    }
  },
  save() {
    return null;
  },
};

// -- Registry --

const adapters: Record<string, FormatAdapter> = {
  md: markdownAdapter,
  txt: plaintextAdapter,
  docx: docxAdapter,
};

/** Look up the adapter for a given format string */
export function getAdapter(format: string): FormatAdapter {
  return adapters[format] ?? plaintextAdapter;
}

// -- Shared helpers --

/**
 * Atomic rename retry constants. Windows can throw EPERM/EACCES when another
 * process (AV scanner, file indexer, or a stale handle) is briefly holding the
 * destination file. A handful of short retries with exponential backoff clears
 * virtually all such contention in practice. See session manager history for
 * the original rationale (formerly duplicated there).
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
