/**
 * Undoing a client connection's changes to a document's replies map (#2360;
 * ADR-054's #2360 PR A amendment; `docs/plans/2360-thread-replies.md` §3
 * "Undoing client writes"). Ships dark: it acts only while
 * `chatClientWritesUndone()` answers true, which is the ownership flag (the
 * same seam the CTRL chat undo reads, so nothing here imports the flag).
 *
 * **The property.** The browser never writes `Y_MAP_ANNOTATION_REPLIES`: every
 * reply goes through a server POST (`addUserReply`) or the MCP seam, and there
 * is no client `set` or `delete` on that map. So with ownership on, EVERY change
 * to it whose origin is a Hocuspocus `Connection` is undone:
 *  - an added row is deleted;
 *  - a changed row is put back;
 *  - a deleted row is restored.
 * Only a plain-object earlier value is put back (`chat-client-undo.ts`'s M2): a
 * change over any other value is judged as an add (deleted), and such a delete
 * stands. This is what makes `answers` server-only on the live map: a client
 * cannot mark an entry answered **through the replies map**. It is no more
 * than that: a client can still hide a comment by editing the parent record in
 * `Y_MAP_ANNOTATIONS` (ownership design D4, coordination, not security).
 *
 * **Before derivation.** The undo is registered on the replies map before the
 * replies observer (`events/queue.ts`' `attachObservers`), and Yjs calls a
 * map's listeners in registration order, so it runs first on the same event.
 * A transaction it repaired is remembered ({@link wasRepairedByReplyUndo}) and
 * the replies observer derives nothing from it, so a forged add pushes no
 * `annotation:reply` event. The undo itself is ONE `withInternal` transaction
 * (Critical Rule 2: a repair of server state; `internal` derives no event and
 * is skipped by durable sync, so the repair is persisted explicitly).
 *
 * **Every room.** Attached for every document, upload and scratchpad included
 * (the replies observer is not attached to those), and again after the
 * Hocuspocus swap, like the Solo stamp observer.
 *
 * **Pending structs: no guard (Bryan, 2026-11-26).** A client update that
 * depends on data the room does not hold yet is kept in the store's pending
 * state, as Yjs keeps it, and is never dropped here. #2360 PR A dropped it
 * (`makeDocumentPendingGuard`); the Chromium measurement (smoke S8) saw that
 * guard drop a real user's paste after a forced reconnect, and the tab then
 * stopped syncing, so it was removed (ADR-054's flip amendment). What that
 * leaves (`docs/security.md` #2576): a pending struct or delete aimed at the
 * server's next clock is integrated only inside a later `applyUpdate` after
 * that write lands (a local write never retries pending data). In the live
 * room that is a client's update, a `Connection` transaction, so this undo
 * still sees it. But `encodeStateAsUpdate` carries pending data, so a session
 * file written while it is held integrates it under no origin when restored,
 * past this undo, and a lit file is trusted, so the load sweep keeps a forged
 * `answers`; the Hocuspocus swap's merge (`yjs/provider.ts`) is the same
 * mechanism. Pinned in `tests/server/ownership-thread-replies.test.ts`.
 *
 * The session restore, the envelope merge and `onLoadDocument` apply with no
 * origin, so they are never undone here; the load sweep
 * (`annotations/thread-answers-trust.ts`) covers what they bring in.
 */

import type * as Y from "yjs";
import { Y_MAP_ANNOTATION_REPLIES } from "../../../shared/constants.js";
import { withInternal } from "../../../shared/origins.js";
import { queueSnapshot } from "../../annotations/sync.js";
import { chatClientWritesUndone } from "../../chat-client-writes.js";
import { getFileSyncContextForDoc } from "../file-sync-registry.js";
import { isClientConnection } from "./chat-client-undo.js";

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/** What one client write to the replies map comes to once undone. */
export interface ReplyUndo {
  /** Keys whose earlier (plain-object) value is put back. */
  readonly restored: ReadonlyMap<string, Record<string, unknown>>;
  /** Keys the client added (or changed over a non-object value): deleted. */
  readonly removed: readonly string[];
}

/** Decide the undo from the observer's event; changes nothing. */
export function planReplyUndo(event: Y.YMapEvent<unknown>): ReplyUndo {
  const restored = new Map<string, Record<string, unknown>>();
  const removed: string[] = [];
  for (const [key, change] of event.changes.keys) {
    if (change.action === "update" || change.action === "delete") {
      if (isPlainObject(change.oldValue)) {
        restored.set(key, change.oldValue);
        continue;
      }
      if (change.action === "delete") continue;
    }
    removed.push(key);
  }
  return { restored, removed };
}

/** Transactions whose replies-map change this module undid. */
let repaired = new WeakSet<Y.Transaction>();

/** Whether the undo repaired this transaction (the replies observer then derives nothing). */
export function wasRepairedByReplyUndo(txn: Y.Transaction): boolean {
  return repaired.has(txn);
}

/**
 * Attach the undo to `doc`'s replies map. Returns the teardown. Register it
 * BEFORE the replies observer (see the module docblock).
 */
export function makeReplyClientUndo(doc: Y.Doc): () => void {
  const replies = doc.getMap(Y_MAP_ANNOTATION_REPLIES);
  const onChange = (event: Y.YMapEvent<unknown>, txn: Y.Transaction): void => {
    if (!isClientConnection(txn.origin) || !chatClientWritesUndone()) return;
    const undo = planReplyUndo(event);
    if (undo.restored.size === 0 && undo.removed.length === 0) return;
    repaired.add(txn);
    try {
      withInternal(doc, () => {
        for (const [key, value] of undo.restored) replies.set(key, value);
        for (const key of undo.removed) replies.delete(key);
      });
    } catch {
      console.error(
        "[Tandem] Undoing a browser tab's change to a comment thread failed; part of that change may stand",
      );
    }
    // `internal` is skipped by durable sync: persist the repaired map.
    const ctx = getFileSyncContextForDoc(doc);
    if (ctx) queueSnapshot(ctx);
  };
  replies.observe(onChange);
  return () => replies.unobserve(onChange);
}

/** Forget which transactions were repaired (tests). */
export function resetReplyUndoForTests(): void {
  repaired = new WeakSet<Y.Transaction>();
}
