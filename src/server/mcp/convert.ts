import fs from "fs/promises";
import path from "path";
import { snapshotBeforeFirstWrite } from "../file-io/doc-backup.js";
import { atomicWrite } from "../file-io/index.js";
import { rejectUnsafeWindowsPrefix } from "../file-io/windows-path-safety.js";
import { resolveAppDataDir } from "../platform.js";
import { getOrCreateDocument } from "../yjs/provider.js";
import { extractMarkdown } from "./document-model.js";
import { getCurrentDoc } from "./document-service.js";
import { openFileByPath } from "./file-opener.js";

export interface ConvertResult {
  outputPath: string;
  documentId: string;
  fileName: string;
}

/**
 * Find an available output path, appending `-1`, `-2`, etc. if the base already exists.
 */
async function findAvailablePath(basePath: string): Promise<string> {
  const dir = path.dirname(basePath);
  const ext = path.extname(basePath);
  const name = path.basename(basePath, ext);

  const MAX_ATTEMPTS = 1000;
  let candidate = basePath;
  let counter = 0;

  while (counter <= MAX_ATTEMPTS) {
    try {
      await fs.access(candidate);
      // File exists, try next
      counter++;
      candidate = path.join(dir, `${name}-${counter}${ext}`);
    } catch (err: unknown) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "ENOENT") return candidate;
      throw err; // Permission errors should propagate
    }
  }
  throw Object.assign(new Error("Could not find an available filename after 1000 attempts."), {
    code: "CONFLICT",
  });
}

/**
 * Convert an open .docx document to Markdown, write it to disk, and open it as a new tab.
 * Shared by both the HTTP `/api/convert` endpoint and the `tandem_convertToMarkdown` MCP tool.
 */
export async function convertToMarkdown(
  documentId?: string,
  outputPath?: string,
): Promise<ConvertResult> {
  const docState = getCurrentDoc(documentId);
  if (!docState) {
    throw Object.assign(new Error("Document not found."), { code: "FILE_NOT_FOUND" });
  }
  if (docState.format !== "docx") {
    throw Object.assign(new Error("Only .docx documents can be converted to Markdown."), {
      code: "UNSUPPORTED_FORMAT",
    });
  }

  // Uploaded files don't have a real disk path
  if (docState.source === "upload") {
    throw Object.assign(
      new Error(
        "Uploaded .docx files cannot be converted — no disk location to write the .md file.",
      ),
      { code: "INVALID_PATH" },
    );
  }

  const doc = getOrCreateDocument(docState.id);
  const markdown = extractMarkdown(doc);

  // Guard against empty conversion (corrupt .docx or unpopulated Y.Doc)
  if (!markdown.trim()) {
    throw Object.assign(
      new Error("Conversion produced empty output — the .docx may not contain extractable text."),
      { code: "EMPTY_CONVERSION" },
    );
  }

  // Determine output path
  const sourceDir = path.dirname(docState.filePath);
  let resolvedOutput: string;
  if (outputPath) {
    // Reject relative paths — they'd silently resolve against the server's CWD,
    // never the caller's intent (mirrors tandem_exportAnnotations' schema
    // refine). The isAbsolute guard also lets static analysis prove the
    // downstream fs.realpath sink is fed an explicitly-validated path
    // (CodeQL js/path-injection — the sibling export tool's identical realpath
    // is unflagged precisely because its outputPath carries this guard).
    if (!path.isAbsolute(outputPath)) {
      throw Object.assign(
        new Error(
          "outputPath must be an absolute path (a relative path would silently resolve to the server's CWD).",
        ),
        { code: "INVALID_PATH" },
      );
    }
    // Reject UNC + `\\?\` extended-length prefixes pre- and post-resolve.
    // `path.resolve` does NOT normalise `\\?\UNC\…` back to `\\…`, so the
    // bare `\\` check missed that bypass — shared helper closes it.
    const rawReason = rejectUnsafeWindowsPrefix(outputPath);
    if (rawReason) {
      throw Object.assign(new Error(rawReason), { code: "INVALID_PATH" });
    }
    resolvedOutput = path.resolve(outputPath);
    const resolvedReason = rejectUnsafeWindowsPrefix(resolvedOutput);
    if (resolvedReason) {
      throw Object.assign(new Error(resolvedReason), { code: "INVALID_PATH" });
    }
    // If they gave a directory, append the filename. Use realpath to follow
    // symlinked export dirs and re-check the resolved location's prefix.
    try {
      const real = await fs.realpath(resolvedOutput);
      const realReason = rejectUnsafeWindowsPrefix(real);
      if (realReason) {
        throw Object.assign(new Error(realReason), { code: "INVALID_PATH" });
      }
      const stat = await fs.stat(real);
      if (stat.isDirectory()) {
        const baseName = path.basename(docState.filePath, path.extname(docState.filePath));
        resolvedOutput = path.join(real, `${baseName}.md`);
      } else {
        resolvedOutput = real;
      }
    } catch (err: unknown) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== "ENOENT") throw err; // Only swallow "doesn't exist"
    }
  } else {
    const baseName = path.basename(docState.filePath, path.extname(docState.filePath));
    resolvedOutput = path.join(sourceDir, `${baseName}.md`);
  }

  // Avoid overwriting existing files
  resolvedOutput = await findAvailablePath(resolvedOutput);

  // findAvailablePath is best-effort TOCTOU — a file created between its check
  // and this write would be clobbered. The snapshot no-ops when the path is
  // (still) free, so this only costs anything in exactly the racy case.
  await snapshotBeforeFirstWrite(resolvedOutput, { appDataDir: resolveAppDataDir() });
  await atomicWrite(resolvedOutput, markdown);

  // Open the new file in Tandem — include outputPath in error if this fails
  try {
    const openResult = await openFileByPath(resolvedOutput);
    return {
      outputPath: resolvedOutput,
      documentId: openResult.documentId,
      fileName: openResult.fileName,
    };
  } catch (err) {
    throw Object.assign(
      new Error(
        `Markdown written to ${resolvedOutput} but failed to open: ${(err as Error).message}`,
      ),
      { code: "OPEN_FAILED" },
    );
  }
}
