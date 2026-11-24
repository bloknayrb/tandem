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
 *   `audience`, `promotedFrom`) — decide who owns the CONTENT (`content`,
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
 *   written without seeing the delete.
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
 * firing them twice. A loser whose origin is unknown (written before this
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

/** Per-key head history, by document; survives a re-attach to the same doc. */
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
}

type Rec = Record<string, unknown>;

/** Field groups. A field listed nowhere is its own group. */
const DECISION = ["status", "resolvedBy", "acceptedReplyId", "priorSuggestedText"] as const;
const IDENTITY = ["type", "audience", "promotedFrom"] as const;
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

function groupChanged(fields: readonly string[], base: Rec, side: Rec): boolean {
  return fields.some((f) => !deepEqual(base[f], side[f]));
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

  const govL = groupChanged(DECISION, base, l) || groupChanged(IDENTITY, base, l);
  const govW = groupChanged(DECISION, base, w) || groupChanged(IDENTITY, base, w);
  const loserApplied = opts.loserIsBrowser && appliedText(base, l) && !appliedText(base, w);
  // Both sides made the SAME governing change (two Dismisses, or the same
  // sanitize migration of a legacy record's `audience`/`type` that every
  // sanitized write carries): no decision conflicts, so the content merges as
  // though neither had decided rather than going wholesale to the Yjs winner.
  const sameGov = govL && govW && [...DECISION, ...IDENTITY].every((f) => deepEqual(w[f], l[f]));
  if (!sameGov && govL && (!govW || loserApplied)) {
    take(DECISION);
    take(IDENTITY);
    take(CONTENT);
  } else if (sameGov || (!govL && !govW)) {
    if (groupChanged(CONTENT, base, l) && !groupChanged(CONTENT, base, w)) take(CONTENT);
  }
  // Otherwise the winner keeps all three groups.

  if (groupChanged(ANCHOR, base, l) && !groupChanged(ANCHOR, base, w)) take(ANCHOR);

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
 * where the history restarts from the swapped doc's heads; a re-attach to the
 * SAME doc (the reload paths, Save-As promotion) keeps its history.
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
    const latest = hist.get(key)?.at(-1);
    // Already recorded by an earlier attach to this doc: keep its attribution.
    if (latest && latest.id === id && latest.deleted === head.deleted) continue;
    push(key, {
      id,
      deleted: head.deleted,
      value: head.deleted ? undefined : itemValue(head),
      writer: "unknown",
    });
  }

  /**
   * Record what THIS transaction wrote to `key` — read from its own items, never
   * from the key's current head. Observers of a transaction run after any
   * transaction an earlier observer nested inside it (the held-in-solo stamp,
   * this module's own repair), so by then the head can belong to a later write,
   * and attributing it to this one would re-apply it under the wrong origin.
   */
  const recordTxn = (key: string, txn: Y.Transaction, items: Y.Item[], writer: WriterKind) => {
    if (items.length > 0) {
      for (const item of items) {
        push(key, { id: lastIdString(item), deleted: false, value: itemValue(item), writer });
      }
      return;
    }
    // No item added: this transaction deleted the key. Find the item it deleted.
    let it: Y.Item | null = heads.get(key) ?? null;
    for (let steps = 0; it && steps < 4 * HISTORY_PER_KEY; steps++) {
      if (Y.isDeleted(txn.deleteSet, it.id)) {
        push(key, { id: lastIdString(it), deleted: true, value: undefined, writer });
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
    txn.afterState.forEach((after, client) => {
      const before = txn.beforeState.get(client) ?? 0;
      if (after <= before) return;
      const structs = doc.store.clients.get(client);
      if (!structs) return;
      for (let i = structs.length - 1; i >= 0; i--) {
        const s = structs[i];
        if (s.id.clock + s.length <= before) break;
        // Past this transaction's end: a write an observer nested inside it
        // (or a repair queued from it), which its own transaction records.
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
    const atEnd = (it: Y.Item) => it.id.clock < (txn.afterState.get(it.id.client) ?? 0);
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
      if (prior.writer === "unknown") {
        console.warn(
          "[annotation-arbiter] %s: concurrent write lost by an unattributed writer; left as merged",
          docName,
        );
        return undefined;
      }
      const loserIsBrowser = prior.writer === "remote" || prior.writer === BROWSER_ORIGIN;
      const patch = mergePatch(base.value, remoteValue, prior.value, { loserIsBrowser });
      // The loser here already LANDED and was observed under its own origin
      // when it arrived, so a browser one has already fired its channel events
      // (e.g. `annotation:accepted`). Restoring it under `withBrowser` would
      // fire them a second time; restore it as a server repair instead, and
      // persist it explicitly because durable sync skips `internal`.
      const writer: WriterKind = loserIsBrowser ? INTERNAL_ORIGIN : prior.writer;
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
    if (!queued || queued.txn !== txn) return;
    const { repairs } = queued;
    queued = undefined;
    for (const r of repairs) apply(r);
  };

  map.observe(onChange);
  doc.on("afterTransaction", flush);
  return () => {
    map.unobserve(onChange);
    doc.off("afterTransaction", flush);
    queued = undefined;
  };
}
