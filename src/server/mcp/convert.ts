import fs from "fs/promises";
import path from "path";
import { rejectUnsafeWindowsPrefix } from "../../shared/windows-path-safety.js";
import { openFromDisk } from "../documents/open.js";
import { snapshotBeforeFirstWrite } from "../file-io/doc-backup.js";
import { atomicWrite } from "../file-io/index.js";
import { resolveAppDataDir } from "../platform.js";
import { getOrCreateDocument } from "../yjs/provider.js";
import { extractMarkdown } from "./document-model.js";
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

  // `fs.access` follows symlinks, so a dangling link at `candidate` reports
  // ENOENT and this returns it as "available". That is safe HERE and it is
  // worth writing down why, because the rule this file's other fix established
  // is that `fs.access` as an existence probe is a symlink-follow wherever the
  // answer decides what gets written: `atomicWrite` writes a temp sibling and
  // RENAMES, and rename replaces a symlink rather than writing through it. The
  // barrier is the write mechanism, not this check — so if `atomicWrite` ever
  // stops being rename-based, this needs an `lstat`.
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
      // ENOENT here means the LEAF does not exist yet — which is the normal
      // case for an export, and was therefore the one case this whole block
      // never ran on. Swallowing it left `resolvedOutput` uncanonicalized and
      // skipped the post-realpath prefix re-check above, so a symlinked or
      // junctioned parent was never followed on exactly the create-new path
      // the check exists to guard. Canonicalize the parent instead.
      //
      // The parent, not the deepest existing ancestor: `atomicWrite` does no
      // mkdir, so an export into a missing directory already fails, and
      // walking further up has no caller.
      const parent = path.dirname(resolvedOutput);
      try {
        const realParent = await fs.realpath(parent);
        const parentReason = rejectUnsafeWindowsPrefix(realParent);
        if (parentReason) {
          throw Object.assign(new Error(parentReason), { code: "INVALID_PATH" });
        }
        // Safe to rejoin: `resolvedOutput` is already `path.resolve`d, so its
        // basename is normalised and separator-free and cannot reintroduce the
        // prefix just screened off `realParent`.
        resolvedOutput = path.join(realParent, path.basename(resolvedOutput));
      } catch (parentErr: unknown) {
        if ((parentErr as NodeJS.ErrnoException).code !== "ENOENT") throw parentErr;
        // The parent is missing too. This already failed downstream in
        // `atomicWrite`, but as a raw ENOENT surfacing as a 500 / INTERNAL —
        // a caller-fixable path mistake reported as a server fault.
        throw Object.assign(new Error(`Output directory does not exist: ${parent}`), {
          code: "FILE_NOT_FOUND",
        });
      }
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
    const openResult = await openFromDisk(resolvedOutput);
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
