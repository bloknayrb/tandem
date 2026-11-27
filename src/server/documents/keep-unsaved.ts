/**
 * Keep an open document's unsaved edits before a Claude action discards them
 * (ADR-057: undo, not ask).
 *
 * Three MCP tools can throw away edits the user has not saved yet:
 * `tandem_open force:true` (reloads from disk), `tandem_restoreBackup`
 * (replaces the content with a snapshot) and `tandem_close` (does not save).
 * Rather than ask the user first, each keeps those edits as an `unsaved`-kind
 * backup snapshot (`file-io/doc-backup.ts`), proceeds, and says so: the tool
 * result names the backup and the editor gets a notice. If the backup cannot be
 * kept, the action is REFUSED with `BACKUP_FAILED` — the edits are the thing at
 * risk, so proceeding would be the loss this exists to prevent.
 *
 * Opt-in by the three tools, and by the browser's Version history restore
 * (`POST /api/backups/restore`, `actor: "user"`), which keeps the edits the
 * same way but says so in the user's own voice and never records what it kept
 * as unseen (`kept-unseen.json`), and by the conflict banner's Reload (PR 3),
 * the same way. The browser's close, `/api/open` and the watcher's
 * auto-reload do not pass through here.
 *
 * Covered: `.md`/`.txt` documents opened from disk (`AUTO_SAVE_FORMATS`,
 * `source: "file"`), i.e. exactly where "what the next autosave would write"
 * exists. Not `.html` (restoring a snapshot writes it to disk, which the save
 * path refuses on purpose), not `.docx` (ships dark; its serializer is lossy and
 * async and never autosaves), not uploads or scratchpads (no backup directory).
 *
 * Two captures, so nothing typed during the action's own awaits is lost:
 *  1. `unsavedEditsOf` + `keepUnsavedEdits` BEFORE anything irreversible, which
 *     refuses on failure.
 *  2. `captureAtSwap` synchronously inside the transaction that replaces the
 *     content, then `keepEditsCapturedAtSwap` after it. Only text that differs
 *     from the first capture and from the incoming content is kept. The swap has
 *     already happened by then, so this one cannot refuse; a failure is logged
 *     and reported as no second backup.
 */

import path from "path";
import type * as Y from "yjs";
import { keepsUnsavedEditsOnDiscard } from "../../shared/constants.js";
import { generateNotificationId } from "../../shared/utils.js";
import { markSnapshotNewest, snapshotUnsavedEdits } from "../file-io/doc-backup.js";
import { getAdapter } from "../file-io/index.js";
import { pushNotification } from "../notifications.js";
import { resolveAppDataDir } from "../platform.js";
import { readPendingConflict } from "./conflict.js";
import { isDirty } from "./dirty.js";

/** A backup that holds the edits a Claude action discarded. */
export interface KeptBackup {
  /** Snapshot name: pass it to `tandem_restoreBackup` to bring the edits back. */
  name: string;
  /** When the snapshot was taken, ISO 8601. */
  timestamp: string;
}

/** Which Claude action discarded the edits; picks the notice's wording. */
export type DiscardingAction = "reload" | "restore" | "close";

/**
 * Who asked for the action. `claude` (an MCP tool) gets the editor notice and
 * a note addressed to Claude; `user` (the editor's own Version history) gets
 * neither: the user is looking at the result, and a "Claude restored…" notice
 * would be false.
 */
export type KeepActor = "claude" | "user";

/** The open-document fields this module reads. */
interface DocFacts {
  filePath: string;
  format: string;
  source: string;
  readOnly?: boolean;
}

/**
 * The document's unsaved edits as the next autosave would have written them,
 * or null when it has none a Claude action could lose (clean, not covered).
 * Synchronous, so it can run inside the transaction that swaps the content.
 *
 * Gated on the dirty flag or a pending conflict, never on "the serialized text
 * differs from disk": the serializer does not reproduce arbitrary Markdown
 * byte-for-byte, so a clean document would otherwise "differ" on every call.
 */
export function unsavedEditsOf(id: string, doc: Y.Doc, docState: DocFacts): string | null {
  if (!keepsUnsavedEditsOnDiscard(docState)) return null;
  if (!isDirty(id) && readPendingConflict(doc) === undefined) return null;
  const adapter = getAdapter(docState.format);
  if (!adapter.save) return null;
  try {
    return adapter.save(doc);
  } catch (err) {
    // The edits cannot be serialized, so they cannot be kept: refuse, under the
    // code that says so, rather than let the action discard them.
    console.error("[KeepUnsaved] serializing the unsaved edits failed for %s:", id, err);
    throw backupFailedError(docState.filePath);
  }
}

/** The refusal a Claude action answers with when the edits could not be kept. */
export function backupFailedError(filePath: string): Error & { code: "BACKUP_FAILED" } {
  return Object.assign(
    new Error(
      `Couldn't keep a backup of the unsaved edits in ${path.basename(filePath)}, so nothing was ` +
        "changed. Tandem's backup folder may be full or not writable. Save the document first " +
        "(tandem_save), or ask the user how to proceed.",
    ),
    { code: "BACKUP_FAILED" as const },
  );
}

/**
 * Keep `edits` as an `unsaved` snapshot unless they equal `incoming` (the
 * content about to replace them, when known), in which case nothing would be
 * lost and nothing is kept. Throws `BACKUP_FAILED` when the snapshot could not
 * be written or the backup folder is at its size limit. `protect`: a snapshot
 * name the prune must not remove (the one a restore is writing back).
 */
export async function keepUnsavedEdits(
  filePath: string,
  edits: string,
  incoming?: string,
  protect?: string,
  actor: KeepActor = "claude",
): Promise<KeptBackup | undefined> {
  if (incoming !== undefined && edits === incoming) return undefined;
  const r = await snapshotUnsavedEdits(filePath, edits, {
    appDataDir: resolveAppDataDir(),
    ...(protect !== undefined ? { protect } : {}),
    // A Claude keep is news to the user (the kept-edits banner); the editor's
    // own Version history keep is not.
    unseen: actor === "claude",
  });
  if (r.outcome === "written" || r.outcome === "skipped-identical") {
    return { name: r.name, timestamp: r.timestamp };
  }
  throw backupFailedError(filePath);
}

/**
 * A slot `captureAtSwap` fills inside the swap transaction. Call `capture()`
 * there (synchronously, before the content is replaced); read `text` after.
 */
export interface SwapCapture {
  /** `liveDoc`: the document the swap is replacing, as the swapping code holds it. */
  capture(liveDoc: Y.Doc): void;
  readonly text: string | null;
  /** True once the swap ran `capture`: from then on the old content is gone. */
  readonly fired: boolean;
}

/**
 * Build the swap-time capture for one document. It reads the document the
 * swap passes in, not one looked up earlier, so a Y.Doc replaced during the
 * action's awaits (Hocuspocus `onLoadDocument`) is never the one serialized.
 */
export function captureAtSwap(id: string, docState: DocFacts): SwapCapture {
  let text: string | null = null;
  let fired = false;
  return {
    capture(liveDoc) {
      fired = true;
      try {
        text = unsavedEditsOf(id, liveDoc, docState);
      } catch (err) {
        // A serializer throw must not abort the swap it rides in; the first
        // capture already holds everything but what was typed in the gap.
        console.error("[KeepUnsaved] swap-time capture failed for %s:", id, err);
      }
    },
    get text() {
      return text;
    },
    get fired() {
      return fired;
    },
  };
}

/**
 * After the swap: keep the text `captureAtSwap` read if it holds edits made
 * since the first capture (`before`) that the incoming content does not
 * contain. Never throws — the swap has landed, so a failure can only be
 * logged; it returns undefined then.
 */
export async function keepEditsCapturedAtSwap(
  filePath: string,
  atSwap: string | null,
  before: string | null,
  incoming?: string,
  protect?: string,
  actor: KeepActor = "claude",
): Promise<KeptBackup | undefined> {
  if (atSwap === null || atSwap === before || atSwap === incoming) return undefined;
  try {
    const kept = await keepUnsavedEdits(filePath, atSwap, incoming, protect, actor);
    // This copy is a superset of the first capture's, and it is the one the
    // result names. On a coarse filesystem clock both can carry the same mtime
    // (and a restore pushes the first one's ahead of its disk snapshot), so
    // the listing would rank them by the random uuid8: mark this one newest,
    // so it tops the Version history.
    if (kept) {
      const markedAt = await markSnapshotNewest(filePath, resolveAppDataDir(), kept.name);
      if (markedAt !== undefined) kept.timestamp = markedAt;
    }
    return kept;
  } catch (err) {
    console.error(
      "[KeepUnsaved] edits typed during the action could not be kept for %s:",
      filePath,
      err,
    );
    return undefined;
  }
}

/**
 * The backup holding the edits an action discarded, once its swap has run:
 * the swap-time capture's keep when it fired and differs from the first one,
 * else the first one. Never throws (see `keepEditsCapturedAtSwap`). One place
 * for the order every discarding action needs after its swap, success and
 * failure alike.
 */
export async function keptAfterSwap(
  filePath: string,
  swap: SwapCapture | undefined,
  editsBefore: string | null,
  keptBefore: KeptBackup | undefined,
  opts: { incoming?: string; protect?: string; actor?: KeepActor } = {},
): Promise<KeptBackup | undefined> {
  const atSwap = swap?.fired
    ? await keepEditsCapturedAtSwap(
        filePath,
        swap.text,
        editsBefore,
        opts.incoming,
        opts.protect,
        opts.actor,
      )
    : undefined;
  return atSwap ?? keptBefore;
}

/**
 * Tell the editor that a Claude action discarded unsaved edits and where they
 * went. `warning`, so it stays in the activity tray (an `info` expires) — past
 * tense on what happened, per `TandemNotification.severity`.
 */
export function notifyUnsavedEditsKept(
  documentId: string,
  filePath: string,
  action: DiscardingAction,
  kept: KeptBackup,
  outcome: "done" | "failed" = "done",
): void {
  const name = path.basename(filePath);
  const verb = action === "reload" ? "reload" : action === "restore" ? "restore" : "close";
  const what =
    outcome === "failed"
      ? `Claude's ${verb} of ${name} did not finish.`
      : action === "reload"
        ? `Claude reloaded ${name} from disk.`
        : action === "restore"
          ? `Claude restored ${name} from a backup.`
          : `Claude closed ${name}.`;
  pushNotification({
    id: generateNotificationId(),
    type: "unsaved-edits-kept",
    severity: "warning",
    message:
      outcome === "failed"
        ? `${what} Your unsaved edits had been kept as a backup first, which you can restore if they are gone.`
        : `${what} Your unsaved edits were kept as a backup, which you can restore.`,
    documentId,
    backupName: kept.name,
    dedupKey: `unsaved-edits-kept:${documentId}:${kept.name}`,
    timestamp: Date.now(),
  });
}

/**
 * A Claude action failed after its backup was kept. Say where the edits went
 * anyway — the failure may have come after they were discarded (a restore's
 * bytes are already on disk; a reload's swap may have landed) — by a notice
 * and a sentence on the error Claude receives. Returns the error to rethrow.
 * `alreadyNotified`: the success notice went out before the failure, so only
 * the error is amended. `actor: "user"` (the Version history): no notice, and
 * the sentence points at Version history.
 */
export function reportKeptBackupOnFailure(
  err: unknown,
  documentId: string,
  filePath: string,
  action: DiscardingAction,
  kept: KeptBackup | undefined,
  {
    alreadyNotified = false,
    actor = "claude",
  }: { alreadyNotified?: boolean; actor?: KeepActor } = {},
): unknown {
  if (!kept) return err;
  if (!alreadyNotified && actor === "claude") {
    notifyUnsavedEditsKept(documentId, filePath, action, kept, "failed");
  }
  if (err instanceof Error) {
    const note = actor === "claude" ? keptBackupFailureNote(kept) : USER_KEPT_FAILURE_NOTE;
    err.message += ` ${note}`;
    // Also carried on its own, for an error mapping that replaces the message
    // with a fixed one (`tandem_open`'s FILE_LOCKED): the note must survive it.
    (err as Error & { keptBackupNote?: string }).keptBackupNote = note;
  }
  return err;
}

/** The sentence a failed Version history restore's error carries when the edits were kept. */
const USER_KEPT_FAILURE_NOTE =
  "Your unsaved edits had been kept as a backup first; you can restore them from Version history.";

/** The sentence a failed Claude action's error carries when its backup was kept. */
function keptBackupFailureNote(kept: KeptBackup): string {
  return (
    `The document's unsaved edits had been kept first as backup ${JSON.stringify(kept.name)}; ` +
    "tell the user, and restore it with tandem_restoreBackup if they want it."
  );
}
