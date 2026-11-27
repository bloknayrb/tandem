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
import { getDocument } from "../../yjs/provider.js";
import { isValidDocumentId } from "./_shared.js";

/**
 * The bound on each side: this many bytes of a file read from disk, and this
 * many UTF-16 code units (characters) of the document, which as UTF-8 can be
 * up to three times as many bytes.
 */
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
    // One read may return short (network filesystems, interrupted reads).
    let bytesRead = 0;
    while (bytesRead < length) {
      const r = await handle.read(buf, bytesRead, length - bytesRead, bytesRead);
      if (r.bytesRead === 0) break;
      bytesRead += r.bytesRead;
    }
    // Short of `length`: the file shrank after the stat, so this may be cut too.
    const truncated = st.size > max || bytesRead < length;
    // A cut through a multi-byte character would decode as U+FFFD; end on a
    // character boundary instead, so a real U+FFFD in the file is kept.
    const end = truncated ? utf8Boundary(buf, bytesRead) : bytesRead;
    return { text: stripBom(buf.subarray(0, end).toString("utf-8")), truncated };
  } finally {
    await handle.close();
  }
}

/** The largest `n <= length` at which `buf[0..n)` ends on a whole UTF-8 character. */
function utf8Boundary(buf: Buffer, length: number): number {
  let i = length;
  // Step back over continuation bytes (10xxxxxx) to the last lead byte.
  while (i > 0 && i > length - 4 && (buf[i - 1] & 0xc0) === 0x80) i--;
  if (i === 0) return length;
  const lead = buf[i - 1];
  const need = lead >= 0xf0 ? 4 : lead >= 0xe0 ? 3 : lead >= 0xc0 ? 2 : 1;
  // The character starting at i - 1 is complete only if all its bytes fit.
  return length - (i - 1) >= need ? length : i - 1;
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
 * A cut snaps back to a line break only when one is this close; a longer
 * partial line is kept, cut by character, so a file ending in one very long
 * line still compares what was read rather than almost none of it.
 */
const LINE_SNAP_MAX = 64 * 1024;

/** `text` cut at `limit` (all of it if shorter), snapped back to a line break within `LINE_SNAP_MAX`. */
function cutNear(text: string, limit: number): string {
  if (text.length <= limit) return text;
  const nl = text.lastIndexOf("\n", limit - 1);
  return nl >= 0 && limit - (nl + 1) <= LINE_SNAP_MAX
    ? text.slice(0, nl + 1)
    : capText(text, limit).text;
}

/** A cut side ends mid-line: drop that partial line when it is short, keep it otherwise. */
function toNearLastLine(text: string): string {
  const nl = text.lastIndexOf("\n");
  return nl >= 0 && text.length - (nl + 1) <= LINE_SNAP_MAX ? text.slice(0, nl + 1) : text;
}

/**
 * Make the cut sides comparable. A side cut at the cap is taken back to its
 * last full line when that line break is near (`LINE_SNAP_MAX`). Then neither side runs past the shortest cut side, because
 * beyond that point the other version is unknown, not different. A complete
 * side shorter than that is never cut: it really does end there, and what the
 * other side holds past it is a real difference. The caps count different
 * units (raw bytes before CRLF folding on disk, UTF-16 code units for the
 * document), so without this the same text stops at different points.
 */
function alignCuts(
  a: { text: string; truncated: boolean },
  b: { text: string; truncated: boolean },
): [string, string] {
  const at = a.truncated ? toNearLastLine(a.text) : a.text;
  const bt = b.truncated ? toNearLastLine(b.text) : b.text;
  const limit = Math.min(
    a.truncated ? at.length : Number.POSITIVE_INFINITY,
    b.truncated ? bt.length : Number.POSITIVE_INFINITY,
  );
  return [cutNear(at, limit), cutNear(bt, limit)];
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
    res.status(400).json({
      error: "BAD_REQUEST",
      message: "Compare is available for .md and .txt files opened from disk, not read-only.",
    });
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

  // Serialized only once the other side is known to exist, and only if the
  // document is still open after those awaits: a tab closed meanwhile must
  // answer 404, never compare against (and leave behind) an empty Y.Doc.
  const stillOpen = [...getOpenDocs().values()].some((d) => d.id === safeId);
  const ydoc = stillOpen ? getDocument(safeId) : undefined;
  if (!ydoc) {
    res.status(404).json({ error: "NOT_FOUND", message: "Document is not open." });
    return;
  }
  let serialized: string;
  try {
    serialized = adapter.save(ydoc);
  } catch (err) {
    console.error("[Compare] could not serialize the document:", err);
    res.status(500).json({ error: "INTERNAL", message: "Couldn't read the document." });
    return;
  }
  const current = capText(toLf(stripBom(serialized)), COMPARE_MAX_BYTES);
  const otherSide = { text: toLf(other.text), truncated: other.truncated };
  const truncated = current.truncated || other.truncated;
  const [currentShown, otherShown] = truncated
    ? alignCuts(current, otherSide)
    : [current.text, otherSide.text];
  res.json({
    data: {
      current: currentShown,
      other: otherShown,
      otherLabel,
      truncated,
      format: docState.format,
    },
  });
}
