import fs from "fs/promises";
import path from "path";
import type { FormatAdapter } from "./types.js";
import { loadMarkdown, saveMarkdown } from "./markdown.js";
import { htmlToYDoc, loadDocx } from "./docx.js";
import {
  extractDocxComments,
  injectCommentsAsAnnotations,
  type DocxComment,
} from "./docx-comments.js";
import { populateYDoc, extractText } from "../mcp/document-model.js";

export type { FormatAdapter } from "./types.js";
export {
  applyTrackedChanges,
  type AcceptedSuggestion,
  type ApplyOptions,
  type ApplyOutput,
} from "./docx-apply.js";

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
 * Atomic file write: write to a temp file, then rename.
 * Prevents partial writes on crash.
 */
export async function atomicWrite(filePath: string, content: string): Promise<void> {
  const tempPath = path.join(path.dirname(filePath), `.tandem-tmp-${Date.now()}`);
  await fs.writeFile(tempPath, content, "utf-8");
  await fs.rename(tempPath, filePath);
}

/**
 * Atomic binary file write: write Buffer to a temp file, then rename.
 * Used for .docx (ZIP) output where UTF-8 encoding would corrupt binary data.
 */
export async function atomicWriteBuffer(filePath: string, content: Buffer): Promise<void> {
  const tempPath = path.join(path.dirname(filePath), `.tandem-tmp-${Date.now()}`);
  await fs.writeFile(tempPath, content);
  try {
    await fs.rename(tempPath, filePath);
  } catch (err) {
    await fs.unlink(tempPath).catch(() => {});
    throw err;
  }
}
