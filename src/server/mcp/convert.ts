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
 * Classify a "no permission on the output directory" failure, whichever syscall
 * happened to trip on it.
 *
 * `fs.realpath`, `findAvailablePath`'s `fs.access` probe and `atomicWrite`'s
 * write are three mouths of ONE funnel: the caller cannot write where it asked
 * us to write. Which of them fails first is ACL-shape- and platform-dependent,
 * so classifying only one leaves the others reporting the same user-visible
 * cause as something else. Measured on Windows 11 (26200), unprivileged, with
 * `icacls <dir> /deny <sid>:…`:
 *
 *   /deny (W)      → `fs.realpath` itself fails EPERM.
 *   /deny (WD,AD)  → realpath OK, `fs.stat` OK, `fs.access` ENOENT, and the
 *                    failure lands on `atomicWrite`'s writeFile as EPERM.
 *
 * The second shape is the ORDINARY read-but-not-write directory, and it is the
 * one that was reported WRONGLY rather than merely vaguely: unclassified, an
 * MCP caller saw `INTERNAL_ERROR`, and an `/api` caller fell into `_shared.ts`'s
 * shared `EBUSY`/`EPERM` → 423 arm, whose detail `sendApiError` OVERRIDES with
 * "File is locked by another program." Nothing is locked, so the user closes
 * Word, retries, and fails forever.
 *
 * Fixed at the throw site rather than in `_shared.ts`: that 423 arm is right for
 * its other producers, where `EPERM` really does mean a Windows sharing
 * violation on an open `.docx`. POSIX reports `EACCES` for these same
 * conditions and already mapped correctly (403); this makes Windows agree
 * rather than changing POSIX.
 *
 * Returns the error to THROW: anything that is not a permission errno comes back
 * untouched, so the caller's `throw` re-raises the original unchanged.
 */
function asOutputPermissionError(err: unknown, outputDir: string): unknown {
  const code = (err as NodeJS.ErrnoException).code;
  if (code !== "EACCES" && code !== "EPERM") return err;
  return Object.assign(new Error(`Permission denied writing to output directory: ${outputDir}`), {
    code: "PERMISSION_DENIED",
  });
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

  while (counter < MAX_ATTEMPTS) {
    try {
      await fs.access(candidate);
      // File exists, try next
      counter++;
      candidate = path.join(dir, `${name}-${counter}${ext}`);
    } catch (err: unknown) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "ENOENT") return candidate;
      // Second mouth of the funnel (see `asOutputPermissionError`). "Permission
      // errors should propagate" was right that this must not be swallowed —
      // but propagating it UNCLASSIFIED is what produced the wrong `/api`
      // answer, so classify on the way out. Everything else re-raises as-is.
      throw asOutputPermissionError(err, dir);
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
    throw Object.assign(
      new Error("No document is open, or documentId names a document that is not open."),
      { code: "NO_DOCUMENT" },
    );
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
    // `outputPath` names a DIRECTORY, never a file. The leaf is always derived
    // from the source document (`<docBasename>.md`), so a caller cannot name the
    // file that gets created.
    //
    // This is the #1654 narrowing. The surviving target of that finding is a
    // project `CLAUDE.md` written into a repo that lacks one, and creation --
    // not overwrite -- is the capability it needs: `findAvailablePath` below
    // refuses to clobber, but the file being absent is precisely the case.
    // Screening the extension does not help, because `.md` is the extension a
    // legitimate conversion emits. Removing the caller-named leaf is what
    // closes it, and it costs nothing real: the default and directory forms
    // both already derived the name, and no first-party caller passes
    // `outputPath` at all.
    //
    // The directory must EXIST. There is deliberately no "create the parent"
    // branch and no caller-named-leaf branch: with the leaf derived, the
    // ENOENT-on-leaf case this block used to canonicalize cannot arise.
    // A symlinked output directory still resolves through `realpath`, which is
    // what keeps the #1650 canonicalization guarantee alive here.
    let realDir: string;
    try {
      realDir = await fs.realpath(resolvedOutput);
    } catch (err: unknown) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "ENOENT") {
        // A caller-fixable path mistake, not a server fault. FILE_NOT_FOUND
        // rather than INVALID_PATH so an AI caller creates the directory instead
        // of reformatting a path that was never malformed.
        throw Object.assign(new Error(`Output directory does not exist: ${resolvedOutput}`), {
          code: "FILE_NOT_FOUND",
        });
      }
      // Same realpath call, same caller-fixable family as ENOENT above.
      // ENOTDIR (a path component isn't a directory), ELOOP (symlink cycle)
      // and ENAMETOOLONG are all malformed `outputPath` values, not server
      // faults — INVALID_PATH, naming the path the CALLER supplied
      // (`resolvedOutput`, pre-realpath), never anything realpath expanded.
      if (code === "ENOTDIR" || code === "ELOOP" || code === "ENAMETOOLONG") {
        throw Object.assign(
          new Error(`Output directory is not a valid path (${code}): ${resolvedOutput}`),
          { code: "INVALID_PATH" },
        );
      }
      // EACCES/EPERM here mean the caller lacks permission to resolve the
      // output directory itself. Both arms are load-bearing, on different
      // platforms, and NEITHER is speculative: POSIX answers EACCES (real-fs
      // non-root spec in export-path-canonicalization.test.ts) and Windows
      // answers EPERM (real-`icacls` spec in convert-output-acl-win.test.ts,
      // run by the `windows-acl-proof` job). Deleting the EPERM half as
      // redundant would break Windows permission reporting only — the one
      // platform ubuntu `check` cannot catch.
      //
      // `realpath` is only the FIRST of three syscalls this same cause can trip;
      // see `asOutputPermissionError` for the other two and for why all three
      // are classified here rather than in `_shared.ts`.
      if (code === "EACCES" || code === "EPERM") {
        throw Object.assign(
          new Error(`Permission denied resolving output directory: ${resolvedOutput}`),
          { code: "PERMISSION_DENIED" },
        );
      }
      throw err;
    }
    const realReason = rejectUnsafeWindowsPrefix(realDir);
    if (realReason) {
      throw Object.assign(new Error(realReason), { code: "INVALID_PATH" });
    }
    const stat = await fs.stat(realDir);
    if (!stat.isDirectory()) {
      throw Object.assign(
        new Error(
          "outputPath must be an existing directory. The .md filename is derived from the source document and cannot be chosen by the caller.",
        ),
        { code: "INVALID_PATH" },
      );
    }
    const baseName = path.basename(docState.filePath, path.extname(docState.filePath));
    resolvedOutput = path.join(realDir, `${baseName}.md`);
  } else {
    const baseName = path.basename(docState.filePath, path.extname(docState.filePath));
    resolvedOutput = path.join(sourceDir, `${baseName}.md`);
  }

  // Avoid overwriting existing files
  resolvedOutput = await findAvailablePath(resolvedOutput);

  // findAvailablePath is best-effort TOCTOU — a file created between its check
  // and this write would be clobbered. The snapshot no-ops when the path is
  // (still) free, so this only costs anything in exactly the racy case.
  try {
    await snapshotBeforeFirstWrite(resolvedOutput, { appDataDir: resolveAppDataDir() });
    await atomicWrite(resolvedOutput, markdown);
  } catch (err: unknown) {
    // Third mouth of the funnel, and the most reachable one: an output
    // directory the caller can read but not write reaches the write with
    // `realpath`, `stat` and `access` all having succeeded. See
    // `asOutputPermissionError`. Non-permission write failures (ENOSPC, EROFS,
    // …) re-raise unchanged and stay INTERNAL_ERROR / 500, which is right.
    throw asOutputPermissionError(err, path.dirname(resolvedOutput));
  }

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
