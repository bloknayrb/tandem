/**
 * GET /api/document/compare?documentId=<id>&against=disk|<backup name> — the
 * editor's compare view (ADR-057, PR 4): a document's text as the next save
 * would write it, beside the file on disk or one of its backups.
 *
 * Loopback-only by hand (as `GET /api/document/raw`): `enforceLoopbackMutation`
 * passes every GET. The check comes first, before any id is validated or
 * looked up, so a non-loopback peer cannot probe which documents or backups
 * exist. The DNS-rebinding defence for this read is `mw`'s Host check
 * (`createApiMiddleware`), not the socket check: a rebinding page runs in the
 * user's own browser, so its socket is loopback.
 *
 * Within the documented trust model (docs/security.md): an origin the CORS
 * allowlist admits (any `127.0.0.1:*` page) can read, silently, the text of an
 * open document's backups and of its file on disk, as it can already read the
 * document itself.
 *
 * Every read is bounded before it happens (`readTextBounded`): a file that grew
 * after it was opened is read only up to the cap, and the response says it was
 * cut. Messages are fixed strings; no filesystem error text (which can carry an
 * absolute path) is echoed.
 */

import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";

import type { Request, Response } from "express";
import { canCompareWithDisk } from "../../../shared/constants.js";
import { isLoopback } from "../../auth/middleware.js";
import { getOpenDocs } from "../../documents/registry.js";
import { docBackupSnapshotPath, listDocBackups } from "../../file-io/doc-backup.js";
import { getAdapter } from "../../file-io/index.js";
import { stripBom, toLf } from "../../file-io/line-endings.js";
import { resolveAppDataDir } from "../../platform.js";
import { getOrCreateDocument } from "../../yjs/provider.js";
import { isValidDocumentId } from "./_shared.js";

/** Each side is compared up to this many bytes (UTF-8 on disk, UTF-16 code units for the document). */
export const COMPARE_MAX_BYTES = 2 * 1024 * 1024;

/**
 * Read at most `max` bytes of the regular file at `filePath`, as UTF-8 with
 * any BOM removed. Opened non-blocking and checked on the handle, so a FIFO
 * swapped in at the path cannot park a thread; the size comes from that same
 * handle, so the cap holds however the file has grown. ENOENT rejects.
 */
async function readTextBounded(
  filePath: string,
  max: number,
): Promise<{ text: string; truncated: boolean } | "not-a-file"> {
  // O_NONBLOCK is undefined on Windows, where FIFOs at a path do not arise.
  const flags = fsConstants.O_RDONLY | (fsConstants.O_NONBLOCK ?? 0);
  const handle = await fs.open(filePath, flags);
  try {
    const st = await handle.stat();
    if (!st.isFile()) return "not-a-file";
    const length = Math.min(st.size, max);
    const buf = Buffer.alloc(length);
    const { bytesRead } = await handle.read(buf, 0, length, 0);
    return {
      text: stripBom(buf.subarray(0, bytesRead).toString("utf-8")),
      truncated: st.size > max,
    };
  } finally {
    await handle.close();
  }
}

/** Cut `text` at the cap without splitting a surrogate pair. */
function capText(text: string, max: number): { text: string; truncated: boolean } {
  if (text.length <= max) return { text, truncated: false };
  let end = max;
  const code = text.charCodeAt(end - 1);
  if (code >= 0xd800 && code <= 0xdbff) end -= 1;
  return { text: text.slice(0, end), truncated: true };
}

/**
 * When either side was cut at the cap, cut both at the same place: the last
 * line break within the shorter side. The two caps are in different units (raw
 * bytes before CRLF folding on disk, UTF-16 code units for the document), so
 * left alone they stop at different points of the same text and the diff
 * reports the longer side's tail as only on that side.
 */
function alignCuts(a: string, b: string): [string, string] {
  const limit = Math.min(a.length, b.length);
  const cut = (text: string): string => {
    const nl = text.lastIndexOf("\n", limit - 1);
    return nl >= 0 ? text.slice(0, nl + 1) : capText(text, limit).text;
  };
  return [cut(a), cut(b)];
}

function isEnoent(err: unknown): boolean {
  return (err as NodeJS.ErrnoException | null)?.code === "ENOENT";
}

export async function handleGetDocumentCompare(req: Request, res: Response): Promise<void> {
  if (!isLoopback(req.socket.remoteAddress)) {
    res.status(403).json({ error: "FORBIDDEN", message: "Loopback only." });
    return;
  }
  const { documentId, against } = req.query;
  if (!isValidDocumentId(documentId)) {
    res.status(400).json({ error: "BAD_REQUEST", message: "documentId is invalid." });
    return;
  }
  if (typeof against !== "string" || against.length === 0 || against.length > 255) {
    res.status(400).json({ error: "BAD_REQUEST", message: "against must be a single name." });
    return;
  }
  // The house CodeQL sanitizer after the shape check. The registry entry is
  // found by comparing ids over its values rather than looked up by the
  // caller's key, so nothing derived from the request reaches the paths read
  // below (CodeQL js/path-injection, alert 252).
  const safeId = path.basename(documentId);
  const docState = [...getOpenDocs().values()].find((d) => d.id === safeId);
  if (!docState) {
    res.status(404).json({ error: "NOT_FOUND", message: "Document is not open." });
    return;
  }
  if (!canCompareWithDisk(docState)) {
    res
      .status(400)
      .json({ error: "BAD_REQUEST", message: "Compare is available for .md and .txt files." });
    return;
  }

  const adapter = getAdapter(docState.format);
  if (!adapter.save) {
    // Every compared format has a serializer; comparing against "" would
    // report the whole other side as removed.
    res.status(500).json({ error: "INTERNAL", message: "Couldn't read the document." });
    return;
  }

  let other: { text: string; truncated: boolean } | "not-a-file";
  let otherLabel: "disk" | "unsaved" | "disk-backup";
  try {
    if (against === "disk") {
      otherLabel = "disk";
      // `docState.filePath` is the server-owned registry's (docs/security.md,
      // "Paths from the server-owned OpenDoc registry"), never request input.
      other = await readTextBounded(docState.filePath, COMPARE_MAX_BYTES);
    } else {
      // Matched by equality against the folder's own listing, and the path
      // joined from the listing's entry (a `readdir` result), never from the
      // caller's text, which reaches no filesystem call.
      const appDataDir = resolveAppDataDir();
      const entry = (await listDocBackups(docState.filePath, appDataDir)).find(
        (b) => b.name === against,
      );
      const snapshotPath = entry
        ? docBackupSnapshotPath(docState.filePath, appDataDir, entry.name)
        : null;
      if (!entry || snapshotPath === null) {
        res.status(404).json({ error: "NOT_FOUND", message: "That backup no longer exists." });
        return;
      }
      otherLabel = entry.kind === "unsaved" ? "unsaved" : "disk-backup";
      other = await readTextBounded(snapshotPath, COMPARE_MAX_BYTES);
    }
  } catch (err) {
    if (isEnoent(err)) {
      res.status(404).json({
        error: "NOT_FOUND",
        message:
          against === "disk" ? "The file is no longer on disk." : "That backup no longer exists.",
      });
      return;
    }
    console.error("[Compare] could not read the version to compare:", err);
    res.status(500).json({ error: "INTERNAL", message: "Couldn't read that version." });
    return;
  }
  if (other === "not-a-file") {
    res.status(400).json({ error: "BAD_REQUEST", message: "That version is not a plain file." });
    return;
  }

  // Serialized only once the other side is known to exist.
  const current = capText(
    toLf(stripBom(adapter.save(getOrCreateDocument(safeId)))),
    COMPARE_MAX_BYTES,
  );
  // A byte cut can split a multi-byte character, which decodes as U+FFFD.
  const otherText = toLf(other.truncated ? other.text.replace(/\uFFFD+$/, "") : other.text);
  const truncated = current.truncated || other.truncated;
  const [currentShown, otherShown] = truncated
    ? alignCuts(current.text, otherText)
    : [current.text, otherText];
  res.json({ data: { current: currentShown, other: otherShown, otherLabel, truncated } });
}
