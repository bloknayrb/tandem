/**
 * Server arbitration of concurrent writes to one annotation record (#1920).
 *
 * ## The condition
 *
 * Every annotation is ONE `Y.Map` value, written whole. When two peers write
 * the same key without having seen each other's write, Yjs keeps exactly one of
 * them — the one from the higher `clientID` — and the other vanishes with no
 * event on the side that already held the winner. Application order plays no
 * part. Reproduced 3/3 in the v1 review
 * (`docs/reviews/2026-09-02-v1-review/experiments/yjs-race.ts`):
 *
 * - the browser's Accept (text already applied to the document) racing a
 *   server write that keeps the record `pending` — Claude's `editPending`, or
 *   the `refreshRange` re-anchor every read path persists — can leave a live
 *   suggestion over text it has already rewritten;
 * - a server delete (`tandem_removeAnnotation`, the browser's Archive through
 *   `POST /api/remove-annotation`) racing a browser write of the same record
 *   resurrects it, because a concurrent `set` always outlives a `delete`.
 *
 * A `version` field with compare-and-set cannot fix this (#1826): both peers
 * read N and both write N+1, and Yjs still resolves by `clientID`.
 *
 * ## What this module does
 *
 * Every browser write reaches the other browsers THROUGH the server, so the
 * server sees every conflict, and it is the only peer that sees all of them.
 * This observer makes the server the single arbiter: on each REMOTE
 * transaction (a Hocuspocus client update — `!txn.local`, non-null origin) it
 * detects, from the Yjs item structure, a write that was made without seeing
 * the record's previous head, and resolves it by application rules instead of
 * by `clientID`. The resolution is an ordinary server write, which every peer
 * then converges on. Browsers never arbitrate, so there is one arbiter and no
 * ping-pong; local transactions are never arbitrated, so the repair write
 * cannot re-enter.
 *
 * Detection reads Yjs internals (`Item.origin`, `Item.left`, the struct store)
 * that the public API does not expose. A `Y.Map` `set` creates an item whose
 * `origin` is the id of the key's head as the WRITER saw it, so a remote item
 * whose origin is not the head the server held before the transaction was
 * written concurrently with that head.
 *
 * ## Resolution rules
 *
 * A three-way merge over field GROUPS, against the base both writers started
 * from (looked up in a small per-key history this observer keeps, because Yjs
 * garbage-collects the content of a replaced item):
 *
 * - The governing groups — the DECISION (`status`, `resolvedBy`,
 *   `acceptedReplyId`, `priorSuggestedText`) and the IDENTITY (`type`,
 *   `audience`, `promotedFrom`, `author`, `color`) — decide who owns the
 *   CONTENT (`content`,
 *   `suggestedText`, `editedAt`). If exactly one side changed a governing
 *   group, that side's governing groups AND content win: an Accept applied the
 *   text the user saw, so a concurrent rewrite of the proposal must not survive
 *   it; and a promotion sent what the user saw to Claude, so text typed into the
 *   still-private note in another window must not ride along (ADR-027). If both
 *   sides changed one, the Yjs winner keeps all three groups — unless the loser
 *   is a browser Accept of a proposal and the winner is not: that Accept has
 *   already written the proposal into the document, which no other decision
 *   does, so the record follows the text.
 * - Every other group is merged independently: the side that changed it
 *   relative to the base keeps it; if both did, the Yjs winner does. The
 *   ANCHOR group (`range`, `relRange`, `textSnapshot*`) moves as one unit, so a
 *   record never pairs one side's flat range with the other's CRDT anchor.
 * - A concurrent DELETE always wins over a `set`: the record is deleted again.
 *   Every browser writer reads the record before writing it and returns when it
 *   is absent, so no browser re-creates a key it has seen deleted, and a remote
 *   `set` landing on a key the server already deleted can only be one that was
 *   written without seeing the delete. Nothing enforces that at runtime;
 *   `tests/server/annotation-write-arbiter-client-writers.test.ts` pins it over
 *   `src/client`.
 * - `rev` is not merged; the repair writes one past the highest of the two.
 *
 * ## The repair's origin
 *
 * The repair RE-APPLIES the losing side's write, so it is tagged with the
 * helper that write was originally made under (ADR-031: the helper choice is
 * the contract). The winner's fields are already present and were already
 * observed under their own origin. A lost browser write is re-applied with
 * `withBrowser` — it is a user edit that originated in the browser, which is
 * exactly that origin's meaning — so the channel event the lost write should
 * have produced (e.g. `annotation:accepted`) is produced now, and the durable
 * store persists it. A lost `mcp` write is re-applied under `withMcp`, and so on.
 * The one exception is a browser write the server already HELD when a
 * concurrent remote write displaced it: it was observed on arrival and its
 * events already fired, so it is restored under `withInternal` (with a snapshot
 * queued, as for every repair under an origin durable sync skips) rather than
 * firing them twice — unless the displacing write made a DECISION of its own
 * that the restore undoes (window A Accepts, window B Dismisses and wins). B's
 * decision was already pushed, so that restore is re-applied with `withBrowser`
 * and the corrective decision event fires; otherwise Claude's last pushed
 * decision would contradict what `tandem_checkInbox` reads.
 *
 * Attribution is per remote TRANSACTION, not per item: a server write an
 * observer nests inside a remote transaction (the held-in-solo stamp, the
 * key-identity repair) completes that browser write, so when the pair is
 * displaced, the loser is the browser's write. A loser whose origin is unknown (written before this
 * observer first attached to the doc, or untagged) is left as Yjs resolved it,
 * with a warning.
 *
 * ## What this does not cover
 *
 * - A remote DELETE that lost to a server `set` (only the browser's highlight
 *   toggle deletes directly) leaves no trace in the transaction to detect: Yjs
 *   records nothing when it applies a delete of an already-deleted item.
 * - A conflict whose base has fallen out of the per-key history (a peer more
 *   than {@link HISTORY_PER_KEY} writes behind) is left as Yjs resolved it,
 *   with a warning.
 * - A transaction with origin `null` (session restore, the Hocuspocus doc swap)
 *   is never arbitrated: no browser could have written concurrently with it.
 * - Between the remote update and the repair, peers can briefly hold the Yjs
 *   winner, and observers of the remote transaction see it: a resurrected user
 *   comment derives an `annotation:created` before it is deleted again.
 * - `Y_MAP_ANNOTATION_REPLIES` is not arbitrated; replies are written through
 *   server routes, not by browsers directly.
 */

import * as Y from "yjs";
import { Y_MAP_ANNOTATIONS } from "../../shared/constants.js";
import {
  BROWSER_ORIGIN,
  FILE_SYNC_ORIGIN,
  INTERNAL_ORIGIN,
  MCP_ORIGIN,
  MODE_RELEASE_ORIGIN,
  RELOAD_ORIGIN,
  shouldSkipDurableSync,
  withBrowser,
  withFileSync,
  withInternal,
  withMcp,
  withModeRelease,
  withReload,
} from "../../shared/origins.js";
import { getFileSyncContextForDoc } from "../events/file-sync-registry.js";
import { queueSnapshot } from "./sync.js";

/** How many recent heads per key are kept to find a conflict's base. */
export const HISTORY_PER_KEY = 16;

/** Per-key head history, by document; survives a re-attach and is carried across a doc swap. */
const historyByDoc = new WeakMap<Y.Doc, Map<string, HeadEntry[]>>();

/**
 * Who wrote an item. `remote` is any Hocuspocus client update (re-applied as a
 * browser write); `unknown` is a write this observer cannot attribute.
 */
type WriterKind =
  | typeof MCP_ORIGIN
  | typeof FILE_SYNC_ORIGIN
  | typeof INTERNAL_ORIGIN
  | typeof RELOAD_ORIGIN
  | typeof BROWSER_ORIGIN
  | typeof MODE_RELEASE_ORIGIN
  | "remote"
  | "unknown";

const KNOWN_LOCAL: ReadonlySet<unknown> = new Set([
  MCP_ORIGIN,
  FILE_SYNC_ORIGIN,
  INTERNAL_ORIGIN,
  RELOAD_ORIGIN,
  BROWSER_ORIGIN,
  MODE_RELEASE_ORIGIN,
]);

interface HeadEntry {
  /** `client:clock` of the item's LAST id — what a later `origin` points at. */
  id: string;
  deleted: boolean;
  /** The record, when the head is live. Held by reference; records are never mutated in place. */
  value: unknown;
  writer: WriterKind;
  /** The id of the head the writer saw (the item's `origin`), for a live entry. */
  originId?: string | null;
  /** Serial of the transaction that wrote this entry. */
  txn?: number;
  /**
   * Serial of the REMOTE transaction this entry's transaction was nested in
   * (opened by an observer of that remote transaction — the held-in-solo stamp,
   * the key-identity repair), when it was.
   */
  nestedIn?: number;
}

/** Transaction serials, unique across docs and attaches. */
let nextTxnSerial = 1;

type Rec = Record<string, unknown>;

/**
 * Carry the per-key history to the replacement doc on a Hocuspocus swap
 * (`onDocSwapped`), before the arbiter re-attaches to it. Item ids survive the
 * swap — the new doc is built by applying the old one's state — so every entry
 * still names the same item; without this, every head would reseed as
 * `unknown` and the next conflict on it would be left as Yjs resolved it.
 * Copied, never moved, like the alias ledger: an in-flight `loadAndMerge` can
 * still hold the old doc.
 */
export function copyArbiterHistory(from: Y.Doc, to: Y.Doc): void {
  const src = historyByDoc.get(from);
  if (!src || src.size === 0) return;
  const dst = historyByDoc.get(to) ?? new Map<string, HeadEntry[]>();
  for (const [key, entries] of src) {
    const later = dst.get(key) ?? [];
    const merged = [
      ...entries.filter((e) => !later.some((x) => x.id === e.id && x.deleted === e.deleted)),
      ...later,
    ];
    dst.set(key, merged.slice(-HISTORY_PER_KEY));
  }
  historyByDoc.set(to, dst);
}

/** The recorded history for one key, oldest first. For the unit spec. */
export function arbiterHistoryForTesting(
  doc: Y.Doc,
  key: string,
): ReadonlyArray<{ id: string; deleted: boolean; writer: string }> {
  return (historyByDoc.get(doc)?.get(key) ?? []).map(({ id, deleted, writer }) => ({
    id,
    deleted,
    writer,
  }));
}

/** Field groups. A field listed nowhere is its own group. */
const DECISION = ["status", "resolvedBy", "acceptedReplyId", "priorSuggestedText"] as const;
// `author` and `color` belong here, not on their own: promotion changes the
// author (`import` -> `user`) and strips the color in the same write as the
// type and audience, so merged apart they could pair a comment with a note's
// color. Nothing writes either in place otherwise.
const IDENTITY = ["type", "audience", "promotedFrom", "author", "color"] as const;
const CONTENT = ["content", "suggestedText", "editedAt"] as const;
const ANCHOR = [
  "range",
  "relRange",
  "textSnapshot",
  "textSnapshotTruncated",
  "textSnapshotBreaks",
] as const;
/** Bookkeeping, never merged: the repair writes its own `rev`. */
const BOOKKEEPING: ReadonlySet<string> = new Set(["rev"]);

const GROUPED: ReadonlySet<string> = new Set<string>([
  ...DECISION,
  ...IDENTITY,
  ...CONTENT,
  ...ANCHOR,
]);

function idString(id: Y.ID): string {
  return `${id.client}:${id.clock}`;
}

function lastIdString(item: Y.Item): string {
  return `${item.id.client}:${item.id.clock + item.length - 1}`;
}

function isRecord(v: unknown): v is Rec {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) {
    const bb = b as unknown[];
    return a.length === bb.length && a.every((v, i) => deepEqual(v, bb[i]));
  }
  const ka = Object.keys(a as Rec).filter((k) => (a as Rec)[k] !== undefined);
  const kb = Object.keys(b as Rec).filter((k) => (b as Rec)[k] !== undefined);
  if (ka.length !== kb.length) return false;
  return ka.every((k) => deepEqual((a as Rec)[k], (b as Rec)[k]));
}

/**
 * Did this write accept a proposal? Only the browser's Accept writes the
 * proposal into the document (Claude's resolve never touches content), so when
 * both sides decided, a browser Accept is the decision the document text
 * already agrees with.
 */
function appliedText(base: Rec, side: Rec): boolean {
  return (
    base.status === "pending" &&
    side.status === "accepted" &&
    typeof side.suggestedText === "string"
  );
}

/**
 * The fields to change on the winner `w` so that it also carries the loser
 * `l`'s write, each with its new value (`undefined` = remove the field). Empty
 * when the winner already is the merge. Exported for the unit spec.
 */
export function mergePatch(
  base: Rec,
  w: Rec,
  l: Rec,
  opts: { loserIsBrowser: boolean },
): Map<string, unknown> {
  const patch = new Map<string, unknown>();
  const take = (fields: readonly string[]) => {
    for (const f of fields) if (!deepEqual(w[f], l[f])) patch.set(f, l[f]);
  };

  // A field both sides set to the SAME value is no side's change: two
  // Dismisses, or the sanitize migration of a legacy record's
  // `audience`/`type` (and a legacy `suggestion`'s content) that every
  // sanitized write carries. Counted as a change, that migration made a plain
  // re-anchor look like a governing write and let it beat a concurrent
  // Dismiss by clientID — so each test below asks whether a side changed a
  // field the OTHER side did not also change to the same value.
  const changedAlone = (fields: readonly string[], side: Rec, other: Rec) =>
    fields.some((f) => !deepEqual(base[f], side[f]) && !deepEqual(side[f], other[f]));
  const govL = changedAlone(DECISION, l, w) || changedAlone(IDENTITY, l, w);
  const govW = changedAlone(DECISION, w, l) || changedAlone(IDENTITY, w, l);
  const loserApplied = opts.loserIsBrowser && appliedText(base, l) && !appliedText(base, w);
  if (govL && (!govW || loserApplied)) {
    take(DECISION);
    take(IDENTITY);
    take(CONTENT);
  } else if (!govL && !govW) {
    if (changedAlone(CONTENT, l, w) && !changedAlone(CONTENT, w, l)) take(CONTENT);
  }
  // Otherwise the winner keeps all three groups.

  if (changedAlone(ANCHOR, l, w) && !changedAlone(ANCHOR, w, l)) take(ANCHOR);

  const singles = new Set([...Object.keys(base), ...Object.keys(w), ...Object.keys(l)]);
  for (const f of singles) {
    if (GROUPED.has(f) || BOOKKEEPING.has(f)) continue;
    if (!deepEqual(base[f], l[f]) && deepEqual(base[f], w[f])) take([f]);
  }
  return patch;
}

function writeAs<T>(writer: WriterKind, doc: Y.Doc, fn: () => T): T | undefined {
  switch (writer) {
    case "remote":
    case BROWSER_ORIGIN:
      return withBrowser(doc, fn);
    case MCP_ORIGIN:
      return withMcp(doc, fn);
    case INTERNAL_ORIGIN:
      return withInternal(doc, fn);
    case RELOAD_ORIGIN:
      return withReload(doc, fn);
    case FILE_SYNC_ORIGIN:
      return withFileSync(doc, fn);
    case MODE_RELEASE_ORIGIN:
      return withModeRelease(doc, fn);
    case "unknown":
      return undefined;
  }
}

function itemValue(item: Y.Item): unknown {
  // A map item holds one value. Read before the end of the transaction, when
  // Yjs garbage-collects the content of a deleted item.
  const content = item.content.getContent();
  return content.length > 0 ? content[content.length - 1] : undefined;
}

/**
 * Attach the arbiter to a document's annotations map. Returns the detach
 * function. Re-attached by `reattachObservers` after the Hocuspocus doc swap,
 * whose history `onDocSwapped` has already carried over with
 * {@link copyArbiterHistory}; a re-attach to the SAME doc (the reload paths,
 * Save-As promotion) keeps its history.
 */
export function makeAnnotationWriteArbiter({
  docName,
  doc,
}: {
  docName: string;
  doc: Y.Doc;
}): () => void {
  const map = doc.getMap(Y_MAP_ANNOTATIONS);
  // biome-ignore lint/suspicious/noExplicitAny: `_map` is Yjs's key -> head-item index; the typings do not expose it on Y.Map.
  const heads = (map as any)._map as Map<string, Y.Item>;
  // Kept per Y.Doc, not per attach: the reload paths re-run `attachObservers`
  // on the SAME doc right after remapping every record, and a fresh history
  // would have lost both the remap's origin and the base a browser write made
  // during the reload started from.
  let history = historyByDoc.get(doc);
  if (!history) {
    history = new Map<string, HeadEntry[]>();
    historyByDoc.set(doc, history);
  }
  const hist = history;

  const push = (key: string, entry: HeadEntry) => {
    const entries = hist.get(key) ?? [];
    entries.push(entry);
    if (entries.length > HISTORY_PER_KEY) entries.splice(0, entries.length - HISTORY_PER_KEY);
    hist.set(key, entries);
  };

  for (const [key, head] of heads) {
    const id = lastIdString(head);
    // Already recorded by an earlier attach to this doc: keep its attribution.
    // Searched, not read off the last entry: a transaction's lost remote write
    // is recorded after the head that beat it, so the head is not always last,
    // and re-recording it as `unknown` would leave its next conflict unarbitrated.
    if (hist.get(key)?.some((e) => e.id === id && e.deleted === head.deleted)) continue;
    push(key, {
      id,
      deleted: head.deleted,
      value: head.deleted ? undefined : itemValue(head),
      writer: "unknown",
    });
  }

  // ---- Transaction bookkeeping ----
  //
  // A transaction opened from an observer of another (the held-in-solo stamp,
  // the key-identity repair) or from its `afterTransaction` (this module's
  // repair) runs its function at once, but Yjs cleans it up — computing its
  // `afterState` and calling its observers — only after the outer transaction's
  // cleanup has finished. By then later transactions may have written too, so
  // `afterState` does NOT bound a nested transaction's own items. Its true end
  // is the state when the NEXT transaction began: a new transaction is opened
  // only once the previous one's function has returned.
  const serials = new WeakMap<Y.Transaction, number>();
  const ends = new WeakMap<Y.Transaction, Map<number, number>>();
  const nestedIn = new WeakMap<Y.Transaction, number>();
  /** Transactions begun and not yet through `afterTransaction`, oldest first. */
  const open: Y.Transaction[] = [];
  const isArbitrated = (txn: Y.Transaction) => !txn.local && txn.origin != null;

  const stateVector = (): Map<number, number> => {
    const sv = new Map<number, number>();
    doc.store.clients.forEach((structs, client) => {
      const last = structs[structs.length - 1];
      if (last) sv.set(client, last.id.clock + last.length);
    });
    return sv;
  };

  const onBegin = (txn: Y.Transaction): void => {
    serials.set(txn, nextTxnSerial++);
    if (open.length > 0) {
      const sv = stateVector();
      for (const t of open) if (!ends.has(t)) ends.set(t, sv);
      // The innermost remote transaction still being cleaned up, if any: this
      // one was opened by one of its observers.
      for (let i = open.length - 1; i >= 0; i--) {
        if (isArbitrated(open[i])) {
          const s = serials.get(open[i]);
          if (s !== undefined) nestedIn.set(txn, s);
          break;
        }
      }
    }
    open.push(txn);
  };

  const onEnd = (txn: Y.Transaction): void => {
    const i = open.indexOf(txn);
    if (i >= 0) open.splice(i, 1);
  };

  /** The clock at which `txn`'s own writes by `client` end (exclusive). */
  const endOf = (txn: Y.Transaction, client: number): number => {
    const after = txn.afterState.get(client) ?? 0;
    const end = ends.get(txn);
    return end ? Math.min(after, end.get(client) ?? 0) : after;
  };

  /**
   * Record what THIS transaction wrote to `key` — read from its own items, never
   * from the key's current head. Observers of a transaction run after any
   * transaction an earlier observer nested inside it (the held-in-solo stamp,
   * this module's own repair), so by then the head can belong to a later write,
   * and attributing it to this one would re-apply it under the wrong origin.
   */
  const recordTxn = (key: string, txn: Y.Transaction, items: Y.Item[], writer: WriterKind) => {
    const tags = { txn: serials.get(txn), nestedIn: nestedIn.get(txn) };
    if (items.length > 0) {
      // In write order: `newItemsByKey` collects each client's items newest first.
      const ordered = [...items].sort(
        (a, b) => a.id.client - b.id.client || a.id.clock - b.id.clock,
      );
      for (const item of ordered) {
        push(key, {
          id: lastIdString(item),
          deleted: false,
          value: itemValue(item),
          writer,
          originId: item.origin ? idString(item.origin) : null,
          ...tags,
        });
      }
      // A key set and then deleted in this same transaction ends deleted: record
      // the delete too, or a later remote `set` written without seeing it is
      // merged as an ordinary conflict instead of losing to the delete.
      let end: Y.Item | null = heads.get(key) ?? null;
      while (end && end.id.clock >= endOf(txn, end.id.client)) {
        end = end.left as Y.Item | null;
      }
      if (end && items.includes(end) && Y.isDeleted(txn.deleteSet, end.id)) {
        push(key, { id: lastIdString(end), deleted: true, value: undefined, writer, ...tags });
      }
      return;
    }
    // No item added: this transaction deleted the key. Find the item it deleted.
    let it: Y.Item | null = heads.get(key) ?? null;
    for (let steps = 0; it && steps < 4 * HISTORY_PER_KEY; steps++) {
      if (Y.isDeleted(txn.deleteSet, it.id)) {
        push(key, { id: lastIdString(it), deleted: true, value: undefined, writer, ...tags });
        return;
      }
      it = it.left as Y.Item | null;
    }
  };

  const find = (key: string, id: string): HeadEntry | undefined => {
    const entries = hist.get(key);
    if (!entries) return undefined;
    // The live entry for an id, if one exists — not its later deletion.
    for (let i = entries.length - 1; i >= 0; i--) {
      if (entries[i].id === id && !entries[i].deleted) return entries[i];
    }
    return undefined;
  };

  const deleterOf = (key: string, id: string): WriterKind | undefined => {
    const entries = hist.get(key);
    if (!entries) return undefined;
    for (let i = entries.length - 1; i >= 0; i--) {
      if (entries[i].id === id && entries[i].deleted) return entries[i].writer;
    }
    return undefined;
  };

  /**
   * The write a live head entry stands for. A server write nested inside a
   * remote transaction (the held-in-solo stamp under `mode-release`, the
   * key-identity repair under `internal`) sits on top of that transaction's
   * browser write and only completes it; the browser's write is what a later
   * concurrent write displaces, so attribution walks past such entries to it.
   * An entry nested in a remote transaction that wrote nothing to this key is
   * its own write.
   */
  const attributed = (key: string, entry: HeadEntry): HeadEntry => {
    const remote = entry.nestedIn;
    if (remote === undefined) return entry;
    let e = entry;
    for (let steps = 0; e.originId && steps < HISTORY_PER_KEY; steps++) {
      const prev = find(key, e.originId);
      if (!prev) break;
      if (prev.txn === remote) return prev;
      if (prev.nestedIn !== remote) break;
      e = prev;
    }
    return entry;
  };

  /** Whether the latest history entry for `id` is its deletion. */
  const isDeletedBefore = (key: string, id: string): boolean => {
    const entries = hist.get(key) ?? [];
    for (let i = entries.length - 1; i >= 0; i--) {
      if (entries[i].id === id) return entries[i].deleted;
    }
    return false;
  };

  /** Items integrated into the annotations map by this transaction, by key. */
  const newItemsByKey = (txn: Y.Transaction): Map<string, Y.Item[]> => {
    const out = new Map<string, Y.Item[]>();
    txn.afterState.forEach((_, client) => {
      const before = txn.beforeState.get(client) ?? 0;
      // Bounded by `endOf`, not `afterState`: for a transaction nested in
      // another, `afterState` is taken at its own cleanup and also covers every
      // write made after it (see the bookkeeping above).
      const after = endOf(txn, client);
      if (after <= before) return;
      const structs = doc.store.clients.get(client);
      if (!structs) return;
      for (let i = structs.length - 1; i >= 0; i--) {
        const s = structs[i];
        if (s.id.clock + s.length <= before) break;
        // Past this transaction's end: a write made after it (one an observer
        // nested inside it, or a repair queued from it), which its own
        // transaction records.
        if (s.id.clock >= after) continue;
        if (!(s instanceof Y.Item)) continue;
        if (s.parent !== (map as unknown) || typeof s.parentSub !== "string") continue;
        const list = out.get(s.parentSub) ?? [];
        list.push(s);
        out.set(s.parentSub, list);
      }
    });
    return out;
  };

  type Repair =
    | {
        kind: "patch";
        key: string;
        writer: WriterKind;
        patch: Map<string, unknown>;
        w: Rec;
        l: Rec;
      }
    | { kind: "delete"; key: string; writer: WriterKind };

  const arbitrate = (key: string, items: Y.Item[], txn: Y.Transaction): Repair | undefined => {
    const byId = new Map(items.map((it) => [lastIdString(it), it]));
    const referenced = new Set(items.flatMap((it) => (it.origin ? [idString(it.origin)] : [])));
    const tips = items.filter((it) => !referenced.has(lastIdString(it)));
    if (tips.length !== 1) {
      console.warn(
        "[annotation-arbiter] %s: %d concurrent write chains in one update; left as merged",
        docName,
        tips.length,
      );
      return undefined;
    }
    const tip = tips[0];
    let first = tip;
    while (first.origin && byId.has(idString(first.origin))) {
      const prev = byId.get(idString(first.origin));
      if (!prev || prev === first) break;
      first = prev;
    }
    const baseId = first.origin ? idString(first.origin) : null;

    // The key's head before this transaction, and at its end. Walked by clock
    // rather than read off the map: an earlier observer of this transaction may
    // already have nested a write of its own on top (the held-in-solo stamp).
    const before = (it: Y.Item) => it.id.clock < (txn.beforeState.get(it.id.client) ?? 0);
    const atEnd = (it: Y.Item) => it.id.clock < endOf(txn, it.id.client);
    const walk = (keep: (it: Y.Item) => boolean): Y.Item | null => {
      let it: Y.Item | null = heads.get(key) ?? null;
      while (it && !keep(it)) it = it.left as Y.Item | null;
      return it;
    };
    const headBefore = walk(before);
    if (!headBefore) return undefined; // a creation
    const headAtEnd = walk(atEnd);

    const headBeforeId = lastIdString(headBefore);
    // From the history, which has seen every transaction before this one: the
    // item's own `deleted` flag also reflects writes nested after it.
    const deletedBefore = isDeletedBefore(key, headBeforeId);
    const remoteWon = headAtEnd === tip && !Y.isDeleted(txn.deleteSet, tip.id);

    if (baseId === headBeforeId && !deletedBefore) return undefined; // sequential

    if (deletedBefore) {
      // A remote set landed on a key the server had already deleted, written
      // without seeing the delete. The delete wins.
      if (!remoteWon) return undefined;
      const writer = deleterOf(key, headBeforeId);
      if (!writer || writer === "unknown") {
        console.warn(
          "[annotation-arbiter] %s: resurrected annotation whose delete is unattributed; left as merged",
          docName,
        );
        return undefined;
      }
      return { kind: "delete", key, writer };
    }

    if (baseId === null) {
      console.warn(
        "[annotation-arbiter] %s: concurrent creation of one key; left as merged",
        docName,
      );
      return undefined;
    }
    const base = find(key, baseId);
    const prior = find(key, headBeforeId);
    if (!base || !prior) {
      console.warn(
        "[annotation-arbiter] %s: concurrent write whose base is out of history; left as merged",
        docName,
      );
      return undefined;
    }
    const remoteValue = itemValue(tip);
    if (!isRecord(base.value) || !isRecord(prior.value) || !isRecord(remoteValue)) return undefined;

    if (remoteWon) {
      // Attributed per remote transaction, not per head item: a server write
      // nested on top of a browser write is restored with it, as that write.
      const loser = attributed(key, prior);
      if (loser.writer === "unknown") {
        console.warn(
          "[annotation-arbiter] %s: concurrent write lost by an unattributed writer; left as merged",
          docName,
        );
        return undefined;
      }
      const loserIsBrowser = loser.writer === "remote" || loser.writer === BROWSER_ORIGIN;
      const patch = mergePatch(base.value, remoteValue, prior.value, { loserIsBrowser });
      // The loser here already LANDED and was observed under its own origin
      // when it arrived, so a browser one has already fired its channel events
      // (e.g. `annotation:accepted`). Restoring it under `withBrowser` would
      // fire them a second time; restore it as a server repair instead, and
      // persist it explicitly because durable sync skips `internal`.
      //
      // Unless the winner made a decision of its own that the restore undoes.
      // The winner's decision was observed and pushed when it landed (e.g.
      // `annotation:dismissed`), so a silent restore would leave Claude's last
      // pushed decision contradicting what `tandem_checkInbox` reads. That
      // restore is re-applied under `withBrowser` — it IS the user's browser
      // decision being re-applied, which is that origin's meaning, and its
      // event goes through the same narrow and the same Solo gate as any
      // other. Claude then sees the decision a second time, after the one it
      // contradicts; that is the price of the corrective event.
      const baseValue = base.value;
      const redecides =
        loserIsBrowser &&
        DECISION.some((f) => patch.has(f)) &&
        DECISION.some((f) => !deepEqual(baseValue[f], remoteValue[f]));
      const writer: WriterKind = !loserIsBrowser
        ? loser.writer
        : redecides
          ? BROWSER_ORIGIN
          : INTERNAL_ORIGIN;
      return patch.size > 0
        ? { kind: "patch", key, writer, patch, w: remoteValue, l: prior.value }
        : undefined;
    }
    if (headAtEnd === headBefore && !Y.isDeleted(txn.deleteSet, headBefore.id)) {
      const patch = mergePatch(base.value, prior.value, remoteValue, { loserIsBrowser: true });
      return patch.size > 0
        ? { kind: "patch", key, writer: "remote", patch, w: prior.value, l: remoteValue }
        : undefined;
    }
    return undefined;
  };

  const apply = (r: Repair) => {
    const wrote =
      r.kind === "delete"
        ? writeAs(r.writer, doc, () => {
            if (!map.has(r.key)) return false;
            map.delete(r.key);
            return true;
          })
        : writePatch(r);
    // Durable sync skips these origins; the writers that use them queue their
    // own snapshot, so the repair that re-applies one must too.
    if (wrote && shouldSkipDurableSync(r.writer)) {
      const ctx = getFileSyncContextForDoc(doc);
      if (ctx) queueSnapshot(ctx);
    }
  };

  const writePatch = (r: Extract<Repair, { kind: "patch" }>): boolean | undefined =>
    writeAs(r.writer, doc, () => {
      const cur = map.get(r.key);
      if (!isRecord(cur)) return false;
      const next: Rec = { ...cur };
      let changed = false;
      for (const [f, v] of r.patch) {
        // Another observer of the same transaction may already have written
        // this record (the held-in-solo stamp does). Only a field still as the
        // winner left it is the arbiter's to change.
        if (!deepEqual(cur[f], r.w[f])) continue;
        if (v === undefined) delete next[f];
        else next[f] = v;
        changed = true;
      }
      if (!changed) return false;
      const revOf = (x: Rec) => (typeof x.rev === "number" ? x.rev : 0);
      next.rev = Math.max(revOf(cur), revOf(r.l), revOf(r.w)) + 1;
      map.set(r.key, next);
      return true;
    });

  const onChange = (event: Y.YMapEvent<unknown>, txn: Y.Transaction): void => {
    const keys = [...event.keysChanged].filter((k): k is string => typeof k === "string");
    const added = newItemsByKey(txn);
    const repairs: Repair[] = [];
    if (!txn.local && txn.origin != null) {
      for (const key of keys) {
        const items = added.get(key);
        if (!items || items.length === 0) continue;
        try {
          const r = arbitrate(key, items, txn);
          if (r) repairs.push(r);
        } catch (err) {
          console.warn(
            "[annotation-arbiter] %s: arbitration failed: %s",
            docName,
            err instanceof Error ? err.name : typeof err,
          );
        }
      }
    }

    const writer: WriterKind = txn.local
      ? KNOWN_LOCAL.has(txn.origin)
        ? (txn.origin as WriterKind)
        : "unknown"
      : txn.origin == null
        ? "unknown"
        : "remote";
    for (const key of keys) recordTxn(key, txn, added.get(key) ?? [], writer);

    if (repairs.length > 0) queued = { txn, repairs };
  };

  // The repair is written from `afterTransaction`, not from the observer: that
  // event fires after EVERY observer of the remote transaction has run, so none
  // of them computes its lazy `event.changes` against a map the repair has
  // already moved on. Yjs has not yet garbage-collected the transaction's
  // deleted content at that point, and the write is its own transaction.
  let queued: { txn: Y.Transaction; repairs: Repair[] } | undefined;
  const flush = (txn: Y.Transaction): void => {
    // First, so the repair below is not counted as nested in `txn`: it
    // re-applies a write under that write's own origin, and is its own write.
    onEnd(txn);
    if (!queued || queued.txn !== txn) return;
    const { repairs } = queued;
    queued = undefined;
    for (const r of repairs) apply(r);
  };

  doc.on("beforeTransaction", onBegin);
  map.observe(onChange);
  doc.on("afterTransaction", flush);
  return () => {
    doc.off("beforeTransaction", onBegin);
    map.unobserve(onChange);
    doc.off("afterTransaction", flush);
    queued = undefined;
    open.length = 0;
  };
}
