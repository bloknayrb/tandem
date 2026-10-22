/**
 * Ask before overwriting a file the OS marks read-only (#2273).
 *
 * Tandem's save is a temp-file-plus-rename (`writeTempThenRename`), and on
 * POSIX a rename needs write permission on the DIRECTORY, not the file — so a
 * `chmod 444` document used to be overwritten silently, by every 60 s
 * autosave. `saveDocumentToDisk` now probes the file first and, when it is not
 * writable, refuses with `READ_ONLY_FILE` and raises a prompt through here.
 *
 * Two pieces of state, both in server memory and both per open document:
 *
 * - **The episode** (`detectedAt`, `declined`): the prompt the user is being
 *   shown. It is mirrored into `Y_MAP_READ_ONLY_FILE` for the banner, but the
 *   mirror is never read back — any WS peer can write that map, so a decision
 *   keyed on it would be forgeable. The resolve route must echo the live
 *   episode's `detectedAt`; with no live episode it approves nothing.
 * - **The approval**: the file path the user said "Overwrite" for. Keyed on the
 *   path, so a rename or save-as drops it by construction, and dropped when a
 *   later probe finds the file writable (re-protecting it outside Tandem asks
 *   again). It lasts until close; a restart asks again.
 *
 * **Windows never offers Overwrite.** There the read-only attribute makes the
 * rename fail outright, so no save — and no page that can reach the save
 * route — could ever overwrite such a file. Clearing the attribute to honour
 * an approval would open that class for the first time (the #2027 shape: a
 * destructive switch behind the any-loopback-port origin gate) and needs a
 * path-based attribute write that follows a swapped-in symlink. The banner
 * tells the user to clear Read-only in the file's Properties instead.
 */

import fs from "fs/promises";
import path from "path";
import type * as Y from "yjs";
import { Y_MAP_DOCUMENT_META, Y_MAP_READ_ONLY_FILE } from "../../shared/constants.js";
import { withInternal } from "../../shared/origins.js";
import type { ReadOnlyFileState } from "../../shared/types.js";
import { generateNotificationId } from "../../shared/utils.js";
import { pushNotification } from "../notifications.js";

interface Episode {
  detectedAt: number;
  declined: boolean;
}

const episodes = new Map<string, Episode>();
const approvals = new Map<string, string>();
/**
 * The last `detectedAt` issued per document. Kept past the episode's end (only
 * close forgets it), so a re-raise in the same millisecond as an ENDED episode
 * — a source-view commit ends one in `clearAndReload` and its save raises the
 * next — still gets a new id, and an answer in flight from the old banner
 * reads as `stale` instead of deciding the new prompt.
 */
const lastIssued = new Map<string, number>();

/** Read per call, not captured, so a test can stub `process.platform`. */
export function canOverwriteReadOnly(): boolean {
  return process.platform !== "win32";
}

/**
 * Whether the current user may write `filePath`. On Windows libuv answers
 * W_OK from the read-only attribute alone; on POSIX it is the permission
 * check, which root always passes. Only EACCES/EPERM mean "read-only": any
 * other failure is left to the write itself, exactly as before this check.
 */
export async function isWritableOnDisk(filePath: string): Promise<boolean> {
  try {
    // Safe FS sink (CodeQL js/path-injection): every caller passes the
    // registry's server-managed `docState.filePath`, the same value the save
    // path's `fs.stat` reads — never raw request input. Dismiss per #1042.
    await fs.access(filePath, fs.constants.W_OK);
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    return code !== "EACCES" && code !== "EPERM";
  }
}

/**
 * Decide a save against a file the probe found not writable. Returns true when
 * the user already approved overwriting this path. Otherwise raises the prompt
 * — once per episode, so repeated autosaves do not re-stamp it and the
 * banner's in-flight `detectedAt` stays valid — and returns false. After "Not
 * now", only the user's own save (Ctrl+S, `source: "manual"`) raises a fresh
 * episode: autosave stays silent, and so does `tandem_save`, which must not
 * re-show a banner the user dismissed.
 */
export function gateReadOnlyFileSave(
  id: string,
  doc: Y.Doc,
  filePath: string,
  source: "auto-save" | "manual" | "mcp",
): boolean {
  if (canOverwriteReadOnly() && approvals.get(id) === filePath) return true;
  const live = episodes.get(id);
  if (live && (!live.declined || source !== "manual")) {
    // Re-mirror a live prompt whose mirror vanished (any WS peer can delete
    // the key), so "use the banner" never points at nothing.
    if (!live.declined && !doc.getMap(Y_MAP_DOCUMENT_META).has(Y_MAP_READ_ONLY_FILE)) {
      mirror(doc, live);
    }
    return false;
  }
  // Strictly increasing per document, so a re-raise within the same
  // millisecond is still a different episode to the resolve route.
  const detectedAt = Math.max(Date.now(), (lastIssued.get(id) ?? 0) + 1);
  lastIssued.set(id, detectedAt);
  const episode = { detectedAt, declined: false };
  episodes.set(id, episode);
  mirror(doc, episode);
  pushNotification({
    id: generateNotificationId(),
    type: "read-only-file",
    severity: "warning",
    message: `${path.basename(filePath)} is read-only on disk, so Tandem did not save your edits.`,
    documentId: id,
    dedupKey: `read-only-file:${id}`,
    timestamp: Date.now(),
  });
  return false;
}

/**
 * Another program changed the file (#2273): the user's "Overwrite" was for the
 * file as it stood then, not for whatever replaced it, so the next refused
 * save asks again. Tandem's own reloads (source-view commit, Reload from file,
 * restore) never reach here, so working on the same file does not re-ask.
 */
export function revokeOverwriteApproval(id: string): void {
  approvals.delete(id);
}

/** A probe found the file writable: drop the approval and any prompt. */
export function noteFileWritable(id: string, doc: Y.Doc): void {
  approvals.delete(id);
  endReadOnlyFileEpisode(id, doc);
}

/** End the prompt (a save landed, or the content was reloaded from disk). */
export function endReadOnlyFileEpisode(id: string, doc: Y.Doc): void {
  episodes.delete(id);
  const meta = doc.getMap(Y_MAP_DOCUMENT_META);
  if (meta.has(Y_MAP_READ_ONLY_FILE)) withInternal(doc, () => meta.delete(Y_MAP_READ_ONLY_FILE));
}

/** Whether a prompt is live (shown or declined) — saves to this file are refused. */
export function hasReadOnlyFileEpisode(id: string): boolean {
  return episodes.has(id);
}

/** Close: forget everything for this document. */
export function clearReadOnlyFileState(id: string): void {
  episodes.delete(id);
  approvals.delete(id);
  lastIssued.delete(id);
}

export type ReadOnlyFileResolution = "approved" | "declined" | "stale" | "unsupported";

/**
 * Apply the user's answer to the live episode. `detectedAt` must name it, or
 * the answer is `stale` and changes nothing — a banner left over from an
 * earlier episode cannot approve a later one, and with no episode at all
 * nothing can be pre-approved.
 */
export function resolveReadOnlyFile(
  id: string,
  doc: Y.Doc,
  filePath: string,
  choice: "overwrite" | "dismiss",
  detectedAt: number,
): ReadOnlyFileResolution {
  const live = episodes.get(id);
  if (!live || live.detectedAt !== detectedAt) return "stale";
  if (choice === "dismiss") {
    live.declined = true;
    mirror(doc, live);
    return "declined";
  }
  if (!canOverwriteReadOnly()) return "unsupported";
  approvals.set(id, filePath);
  return "approved";
}

function mirror(doc: Y.Doc, episode: Episode): void {
  const meta = doc.getMap(Y_MAP_DOCUMENT_META);
  const state: ReadOnlyFileState = { ...episode, canOverwrite: canOverwriteReadOnly() };
  withInternal(doc, () => meta.set(Y_MAP_READ_ONLY_FILE, state));
}

/** Test-only. */
export function resetReadOnlyFileStateForTests(): void {
  episodes.clear();
  approvals.clear();
  lastIssued.clear();
}
