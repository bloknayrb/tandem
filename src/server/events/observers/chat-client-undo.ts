/**
 * Undoing a client connection's changes to CTRL_ROOM's chat map (#2358, the
 * posts PR, R4; Ruling 8; ownership design §6.4's last paragraph). Ships
 * dark: the CTRL chat observer calls {@link undoClientChatChanges} only when
 * `chatClientWritesUndone()` answers true, which is the ownership flag.
 *
 * **The property (R4.1).** The browser client only ever adds a user row with
 * `author: "user"` and `read: false` (`useChatState`'s `send`), and never
 * changes or deletes one. So a write whose origin is a Hocuspocus
 * `Connection` may add a user row carrying only the client's own fields and
 * the fixed values; any other change it makes to the chat map is undone,
 * leaving each row as it was before that write:
 *  - a changed value on an existing row, or an add under a key that already
 *    exists (Yjs reports both as `update`): the old value is put back;
 *  - a deleted row: put back under its key;
 *  - an added row that is not a user row (a value that is not a plain object
 *    included): deleted — the one delete, and only of a row the client itself
 *    added. Its delete is a server write, so the observer's delete arm feeds
 *    #2419's deleted-class cap and tells the ownership side, which holds
 *    nothing for it;
 *  - an added user row with a server-only field, or a fixed field with
 *    another value: rewritten to its own fields and the fixed values.
 *
 * The previous values come from the observer's own event
 * (`event.changes.keys`, computed inside the observer, where it is valid).
 * The undo is ONE `withInternal` transaction (Critical Rule 2: a repair of
 * server state; `internal` is in the channel-skip set, so it emits no
 * `chat:message`), written from inside the observer: Yjs runs the nested
 * transaction's body at once and its observers after, so the observer's own
 * push loop already reads the repaired rows.
 *
 * **Keyed on the connection** (R4.4): Hocuspocus 2.15.3 applies a client's
 * `Update` with its `Connection` as the origin, and a `SyncStep2` with the
 * connection too (`MessageReceiver.apply`, called by `Connection` with
 * itself). A `Connection` carries a string `socketId` (`mode.ts` reads it the
 * same way). The session restore, the CTRL load merge and `loadDocument`
 * apply with no origin, so they are never undone.
 */

import type * as Y from "yjs";
import { withInternal } from "../../../shared/origins.js";
import type { ChatMessage } from "../../../shared/types.js";

/** Which of the three categories each `ChatMessage` field is in (R4.1). */
export type ChatFieldCategory = "server-only" | "fixed" | "client";

/**
 * Every `ChatMessage` field, placed. A `Record` over `keyof ChatMessage`, so a
 * new field does not compile until it is placed here; a test pins the three
 * lists. On a Claude row every field is server-only, and so is the row.
 */
export const CHAT_FIELD_CATEGORY: Readonly<Record<keyof ChatMessage, ChatFieldCategory>> =
  Object.freeze({
    settles: "server-only",
    superseded: "server-only",
    inProgress: "server-only",
    agentIdentity: "server-only",
    chatNotice: "server-only",
    delivered: "server-only",
    greeting: "server-only",
    localRun: "server-only",
    replyTo: "server-only",
    author: "fixed",
    read: "fixed",
    id: "client",
    text: "client",
    timestamp: "client",
    documentId: "client",
    anchor: "client",
  });

/** The values the fixed fields must have on a row a client adds. */
const FIXED = Object.freeze({ author: "user", read: false });

const CLIENT_FIELDS = Object.freeze(
  (Object.keys(CHAT_FIELD_CATEGORY) as Array<keyof ChatMessage>).filter(
    (field) => CHAT_FIELD_CATEGORY[field] === "client",
  ),
);

/** Whether a transaction's origin is a Hocuspocus client connection. */
export function isClientConnection(origin: unknown): boolean {
  return (
    typeof origin === "object" &&
    origin !== null &&
    typeof (origin as { socketId?: unknown }).socketId === "string"
  );
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/**
 * A user row a client added, reduced to what it may carry: its own fields as
 * it wrote them (outside the bound, R4.3) and the fixed values. Undefined
 * when the value is already exactly that.
 */
function reducedUserRow(value: Record<string, unknown>): Record<string, unknown> | undefined {
  let changed = false;
  const out: Record<string, unknown> = {};
  // Own keys only, both ways (diff review, finding 1): `in` walks the
  // prototype chain, so an own key named like an `Object.prototype` member
  // (`constructor`, `toString`) would pass as one of the row's own fields.
  for (const field of CLIENT_FIELDS) if (Object.hasOwn(value, field)) out[field] = value[field];
  out.author = FIXED.author;
  out.read = FIXED.read;
  for (const key of Object.keys(value)) {
    if (!Object.hasOwn(out, key)) changed = true;
  }
  if (value.author !== FIXED.author || value.read !== FIXED.read) changed = true;
  return changed ? out : undefined;
}

/** What one client write to the chat map comes to once undone. */
export interface ChatUndo {
  /** Keys whose earlier value is put back (a change, or a delete of an existing row). */
  readonly restored: ReadonlyMap<string, unknown>;
  /** Keys of rows the client added that are not user rows: deleted. */
  readonly removed: readonly string[];
  /** User rows the client added, rewritten to their own fields and the fixed values. */
  readonly reduced: ReadonlyMap<string, Record<string, unknown>>;
}

/** Decide the undo from the observer's event; changes nothing. */
export function planChatUndo(chatMap: Y.Map<unknown>, event: Y.YMapEvent<unknown>): ChatUndo {
  const restored = new Map<string, unknown>();
  const removed: string[] = [];
  const reduced = new Map<string, Record<string, unknown>>();
  for (const [key, change] of event.changes.keys) {
    // Only a plain-object earlier value is put back (security review M2): a
    // Y type or other value cannot be re-set safely. An update over such a
    // value is judged as an add; such a delete stands (the observer's delete
    // bookkeeping runs for it, as for any delete).
    if (change.action === "update" || change.action === "delete") {
      if (isPlainObject(change.oldValue)) {
        restored.set(key, change.oldValue);
        continue;
      }
      if (change.action === "delete") continue;
    }
    const value = chatMap.get(key);
    if (!isPlainObject(value) || value.author !== "user") {
      removed.push(key);
      continue;
    }
    const row = reducedUserRow(value);
    if (row) reduced.set(key, row);
  }
  return { restored, removed, reduced };
}

/** Whether an undo changes anything. */
export function isEmptyUndo(undo: ChatUndo): boolean {
  return undo.restored.size === 0 && undo.removed.length === 0 && undo.reduced.size === 0;
}

let undoFaultForTests: (() => void) | undefined;

/** Make the next undo writes throw (inside the transaction); undefined clears it. */
export function setChatUndoFaultForTests(fault: (() => void) | undefined): void {
  undoFaultForTests = fault;
}

/**
 * Apply an undo in ONE `withInternal` transaction on `ctrlDoc`. Returns
 * whether it ran without throwing; a throw is logged with fixed text, and
 * Yjs keeps whatever part of the write ran (there is no rollback), so the
 * caller re-checks which deletes were really put back (security review M2).
 */
export function applyChatUndo(ctrlDoc: Y.Doc, chatMap: Y.Map<unknown>, undo: ChatUndo): boolean {
  if (isEmptyUndo(undo)) return true;
  try {
    withInternal(ctrlDoc, () => {
      undoFaultForTests?.();
      for (const [key, value] of undo.restored) chatMap.set(key, value);
      for (const key of undo.removed) chatMap.delete(key);
      for (const [key, value] of undo.reduced) chatMap.set(key, value);
    });
    return true;
  } catch {
    console.error(
      "[Tandem] Undoing a browser tab's change to the chat failed; part of that change may stand",
    );
    return false;
  }
}

/**
 * Drop update data the CTRL doc is holding back for a missing dependency
 * (security review H1). Yjs keeps a struct or delete set whose dependency has
 * not arrived in `store.pendingStructs` / `pendingDs`, and integrates it on a
 * later update of ANY origin, or when the doc is cloned or merged: a client
 * could send one aimed at the server's next write and have it land later
 * under no origin, past the undo. The browser client talks only to the
 * server (a star), so an update of its depends only on what the server sent
 * it or it sent first, and is expected never to leave anything pending; one
 * that does is dropped. Returns whether anything was dropped.
 *
 * That expectation is a premise, not a property: the same star argument held
 * for document rooms, where Chromium smoke S8 (2026-11-26, on #2358) saw a
 * real tab leave a paste pending after a forced reconnect, the drop lose it,
 * and the tab stop syncing, so the document-room guard was removed. In CTRL,
 * S8 saw nothing pending in Chromium; WebView2 and WKWebView are unmeasured
 * (the CTRL row in `tests/server/ownership-flip-blockers.ts`). Both callers
 * left are CTRL's (`ctrl-chat.ts`, `document-service.ts`).
 */
export function dropPendingUpdates(doc: Y.Doc): boolean {
  const store = doc.store as { pendingStructs: unknown; pendingDs: unknown };
  if (store.pendingStructs === null && store.pendingDs === null) return false;
  store.pendingStructs = null;
  store.pendingDs = null;
  return true;
}
