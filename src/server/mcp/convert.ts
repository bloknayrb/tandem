import fs from "fs/promises";
import path from "path";
import { getOrCreateDocument } from "../yjs/provider.js";
import { extractMarkdown } from "./document-model.js";
import { atomicWrite } from "../file-io/index.js";
import { openFileByPath } from "./file-opener.js";
import { getCurrentDoc } from "./document-service.js";

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
    } catch {
      // File doesn't exist — use it
      return candidate;
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

  // Determine output path
  const sourceDir = path.dirname(docState.filePath);
  let resolvedOutput: string;
  if (outputPath) {
    resolvedOutput = path.resolve(outputPath);
    // Reject UNC paths (Windows NTLM security)
    if (resolvedOutput.startsWith("\\\\") || resolvedOutput.startsWith("//")) {
      throw Object.assign(new Error("UNC paths are not supported for security reasons."), {
        code: "INVALID_PATH",
      });
    }
    // If they gave a directory, append the filename
    try {
      const stat = await fs.stat(resolvedOutput);
      if (stat.isDirectory()) {
        const baseName = path.basename(docState.filePath, path.extname(docState.filePath));
        resolvedOutput = path.join(resolvedOutput, `${baseName}.md`);
      }
    } catch {
      // Path doesn't exist yet — use as-is
    }
  } else {
    const baseName = path.basename(docState.filePath, path.extname(docState.filePath));
    resolvedOutput = path.join(sourceDir, `${baseName}.md`);
  }

  // Avoid overwriting existing files
  resolvedOutput = await findAvailablePath(resolvedOutput);

  // Write the markdown file
  await atomicWrite(resolvedOutput, markdown);

  // Open the new file in Tandem
  const openResult = await openFileByPath(resolvedOutput);

  return {
    outputPath: resolvedOutput,
    documentId: openResult.documentId,
    fileName: openResult.fileName,
  };
}
