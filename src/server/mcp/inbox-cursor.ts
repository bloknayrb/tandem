/**
 * The caller-held inbox cursor (#2064, #2294).
 *
 * `tandem_checkInbox` used to keep ONE process-wide record of what it had
 * returned, and committed it before the response reached anybody. Two
 * consequences: a second Claude session polling the same server drained the
 * first one's items (#2064), and a response lost in transit lost its items for
 * the life of the process (#2294).
 *
 * Under the cursor contract the server keeps no per-reader state at all. It
 * keeps one ITEM-keyed registry: every item version any poll returns gets a
 * process-wide sequence number the first time it is returned. Each reader's
 * position — "every seq up to here, except these, has reached me" — lives
 * entirely in the opaque cursor it is handed and passes back on its next poll.
 * So a reader's acknowledgement is simply its next poll, a lost response is
 * re-delivered when the old cursor comes back, and one reader's position can
 * never move another's. Nothing here is keyed on `Mcp-Session-Id`,
 * `X-Claude-Session-Id` or any transport identity (CLAUDE.md: do not key new
 * per-client state on the legacy session id), and
 * `tests/server/inbox-cursor.test.ts` pins that this module imports neither.
 *
 * What a reader has seen, per scope (one scope per document, one for chat):
 *  - a numeric `mark` — every seq ≤ mark has reached it, except those in `held`;
 *  - `mark === null` — a FRESH reader (`"start"`, or a cursor this server cannot
 *    read). It has seen exactly what SOME reader has acknowledged (`acked`), so
 *    a new session is not handed the whole reply and resolution history of
 *    every open document; it gets what is still unacknowledged, plus anything
 *    never returned to anybody.
 *  - `held` — seqs at or below the mark that were withheld from this reader
 *    when its mark passed them (Solo hold, or a record `admit` refused), so a
 *    mark that moved past them does not lose them.
 *
 * Every overflow and every unreadable input resolves toward DUPLICATES, never
 * loss: an oversize held list lowers the mark below what it drops, a cursor
 * that does not fit the size budget is folded into a lower mark, and a cursor
 * that cannot be read is treated as fresh.
 *
 * Content never enters this module: entries hold item keys and integers only,
 * and a key is created only for an item that passed every privacy gate and was
 * returned, so notes, private records and Solo-held items never get one.
 */

import { randomUUID } from "node:crypto";
import { z } from "zod";
import { CTRL_ROOM } from "../../shared/constants.js";

/** Which kind of item an entry versions: annotation, user reply, or chat message. */
export type EntryKind = "a" | "r" | "c";

/** One returned item version. Never removed until {@link DeliveryRegistry.reset}. */
export interface RegistryEntry {
  readonly seq: number;
  readonly kind: EntryKind;
  readonly scope: string;
  /** The item's ledger key (`inboxLedgerKey`, `ledgerKey`, or the chat message id). */
  readonly base: string;
  /** The version: an annotation's `editedAt` (0 if never edited); 0 for replies and chat. */
  readonly editedAt: number;
  /** Some reader acknowledged it (or a cursor-less poll returned it). Never reset. */
  acked: boolean;
}

/** The scope chat entries live in. Not a document id: it never appears in a cursor's `d`. */
export const CHAT_SCOPE = "\u0000chat";

/** A reader's position in one scope. */
export interface ScopeView {
  mark: number | null;
  held: ReadonlySet<number>;
}

/** Whether the reader holding `view` has already been handed `entry`. */
export function seenBy(view: ScopeView, entry: RegistryEntry): boolean {
  if (view.held.has(entry.seq)) return false;
  return view.mark === null ? entry.acked : entry.seq <= view.mark;
}

/**
 * The item-keyed, process-wide registry. Grows for the life of the process,
 * like the legacy ledgers do; `reset()` (via `resetInbox`) empties it and
 * changes the epoch, so every outstanding cursor reads as fresh.
 */
export class DeliveryRegistry {
  #epoch = "";
  #generation = 0;
  #counter = 0;
  readonly #byVersion = new Map<string, RegistryEntry>();
  readonly #byBase = new Map<string, RegistryEntry[]>();
  readonly #byScope = new Map<string, RegistryEntry[]>();
  readonly #unacked = new Map<string, Set<RegistryEntry>>();

  constructor() {
    this.reset();
  }

  /** Changes on every reset; a cursor from another epoch reads as fresh. */
  get epoch(): string {
    return this.#epoch;
  }

  /** The highest seq assigned so far (0 when none). */
  get counter(): number {
    return this.#counter;
  }

  reset(): void {
    this.#generation += 1;
    this.#epoch = `${randomUUID().slice(0, 8)}-${this.#generation}`;
    this.#counter = 0;
    this.#byVersion.clear();
    this.#byBase.clear();
    this.#byScope.clear();
    this.#unacked.clear();
  }

  lookup(kind: EntryKind, base: string, editedAt: number): RegistryEntry | undefined {
    return this.#byVersion.get(versionId(kind, base, editedAt));
  }

  /** The existing entry for this version, or a new one with the next seq. */
  assign(kind: EntryKind, scope: string, base: string, editedAt: number): RegistryEntry {
    const id = versionId(kind, base, editedAt);
    const known = this.#byVersion.get(id);
    if (known) return known;
    this.#counter += 1;
    const entry: RegistryEntry = { seq: this.#counter, kind, scope, base, editedAt, acked: false };
    this.#byVersion.set(id, entry);
    push(this.#byBase, baseId(kind, base), entry);
    push(this.#byScope, scope, entry);
    let unacked = this.#unacked.get(scope);
    if (!unacked) {
      unacked = new Set();
      this.#unacked.set(scope, unacked);
    }
    unacked.add(entry);
    return entry;
  }

  /** Every assigned version of one item, oldest seq first. */
  versionsOf(kind: EntryKind, base: string): readonly RegistryEntry[] {
    return this.#byBase.get(baseId(kind, base)) ?? [];
  }

  /** Every entry in a scope, in seq order. */
  entriesIn(scope: string): readonly RegistryEntry[] {
    return this.#byScope.get(scope) ?? [];
  }

  /** The highest seq in a scope, or 0. */
  maxSeq(scope: string): number {
    const entries = this.#byScope.get(scope);
    return entries && entries.length > 0 ? (entries[entries.length - 1]?.seq ?? 0) : 0;
  }

  /** Document scopes with at least one entry. */
  documentScopes(): string[] {
    return [...this.#byScope.keys()].filter((scope) => scope !== CHAT_SCOPE);
  }

  /**
   * Record that a reader at `view` has acknowledged everything it has seen in
   * `scope`. Feeds only the FRESH-reader floor; it never changes what a reader
   * with a numeric mark is owed.
   */
  acknowledge(scope: string, view: ScopeView): void {
    if (view.mark === null) return;
    const unacked = this.#unacked.get(scope);
    if (!unacked) return;
    for (const entry of unacked) {
      if (entry.seq <= view.mark && !view.held.has(entry.seq)) this.markAcked(entry);
    }
  }

  markAcked(entry: RegistryEntry): void {
    entry.acked = true;
    this.#unacked.get(entry.scope)?.delete(entry);
  }
}

function versionId(kind: EntryKind, base: string, editedAt: number): string {
  return `${kind}\u0000${base}\u0000${editedAt}`;
}

function baseId(kind: EntryKind, base: string): string {
  return `${kind}\u0000${base}`;
}

function push<K, V>(map: Map<K, V[]>, key: K, value: V): void {
  const list = map.get(key);
  if (list) list.push(value);
  else map.set(key, [value]);
}

/** The process-wide registry `tandem_checkInbox` uses. */
export const deliveryRegistry = new DeliveryRegistry();

// ── The cursor ───────────────────────────────────────────────────────────────

/** A decoded cursor: one reader's whole position. */
export interface ReaderCursor {
  /** The mark of every document scope not listed in `docs`. */
  m: number | null;
  docs: Map<string, ScopeView>;
  chat: ScopeView;
}

/** What the caller passes on its first poll. */
export const START_CURSOR = "start";

/** Upper bound on an encoded cursor, both accepted and emitted. */
export const MAX_CURSOR_LENGTH = 8192;

/** Upper bound on one scope's held list and on the number of listed documents. */
export const MAX_CURSOR_ENTRIES = 256;

const markSchema = z.number().int().min(0).nullable();
const seqSchema = z.number().int().min(1);

const cursorWireSchema = z.strictObject({
  v: z.literal(1),
  e: z.string().min(1).max(64),
  m: markSchema,
  c: z
    .tuple([markSchema], seqSchema)
    .refine((t) => t.length <= MAX_CURSOR_ENTRIES + 1, "held list too long"),
  // An array of tuples, not a record: a JSON key of `__proto__` never becomes
  // an object key anywhere in this path.
  d: z
    .array(
      z
        .tuple([z.string().min(1).max(256), markSchema], seqSchema)
        .refine((t) => t.length <= MAX_CURSOR_ENTRIES + 2, "held list too long"),
    )
    .max(MAX_CURSOR_ENTRIES)
    .optional(),
});

type CursorWire = z.infer<typeof cursorWireSchema>;

/** A reader that has seen nothing anyone has not acknowledged. */
export function freshCursor(): ReaderCursor {
  return { m: null, docs: new Map(), chat: { mark: null, held: new Set() } };
}

/**
 * Read a caller's cursor. Anything this server cannot vouch for — malformed,
 * oversize, altered, or minted before a restart — reads as FRESH, which can
 * only re-deliver, never hide. `recognised` is false for every such input
 * except the literal `"start"`, so the summary can say why items repeated.
 */
export function decodeCursor(
  raw: string,
  registry: DeliveryRegistry = deliveryRegistry,
): { cursor: ReaderCursor; recognised: boolean } {
  if (raw === START_CURSOR) return { cursor: freshCursor(), recognised: true };
  const unrecognised = { cursor: freshCursor(), recognised: false };
  if (raw.length > MAX_CURSOR_LENGTH || !/^[A-Za-z0-9_-]+$/.test(raw)) return unrecognised;
  let json: unknown;
  try {
    json = JSON.parse(Buffer.from(raw, "base64url").toString("utf8"));
  } catch {
    return unrecognised;
  }
  const parsed = cursorWireSchema.safeParse(json);
  if (!parsed.success) return unrecognised;
  const wire = parsed.data;
  if (wire.e !== registry.epoch) return unrecognised;

  const counter = registry.counter;
  const clamp = (mark: number | null): number | null =>
    mark === null ? null : Math.min(mark, counter);
  const view = (mark: number | null, held: readonly number[]): ScopeView => {
    const clamped = clamp(mark);
    // A held seq above the mark means nothing: it is owed anyway.
    return {
      mark: clamped,
      held: new Set(held.filter((seq) => clamped !== null && seq <= clamped)),
    };
  };
  const docs = new Map<string, ScopeView>();
  for (const [id, mark, ...held] of wire.d ?? []) {
    // CTRL_ROOM is never a document; a duplicate id is not something this
    // server emits. Either way the cursor was not ours.
    if (id === CTRL_ROOM || id === CHAT_SCOPE || docs.has(id)) return unrecognised;
    docs.set(id, view(mark, held));
  }
  const [chatMark, ...chatHeld] = wire.c;
  return {
    cursor: { m: clamp(wire.m), docs, chat: view(chatMark, chatHeld) },
    recognised: true,
  };
}

/**
 * Cap one held list at {@link MAX_CURSOR_ENTRIES}, keeping the LOWEST seqs and
 * lowering the mark to just below the lowest one dropped, so every dropped seq
 * is owed again (as are the delivered ones above it: duplicates, not loss).
 */
function capHeld(view: ScopeView): ScopeView {
  if (view.held.size <= MAX_CURSOR_ENTRIES) return view;
  const sorted = [...view.held].sort((a, b) => a - b);
  const firstDropped = sorted[MAX_CURSOR_ENTRIES] ?? 1;
  return { mark: firstDropped - 1, held: new Set(sorted.slice(0, MAX_CURSOR_ENTRIES)) };
}

/**
 * The lowest numeric mark that still owes everything `view` is owed. A held
 * list cannot be folded into a bare mark without going below it; a fresh
 * (null) mark folds to 0, since "everything" is the only numeric mark that
 * owes every unacknowledged item.
 */
function foldedMark(view: ScopeView): number {
  if (view.held.size > 0) return Math.min(...view.held) - 1;
  return view.mark ?? 0;
}

function toWire(cursor: ReaderCursor, epoch: string): CursorWire {
  const d: CursorWire["d"] = [];
  for (const [id, view] of cursor.docs) {
    if (view.mark === cursor.m && view.held.size === 0) continue;
    d.push([id, view.mark, ...[...view.held].sort((a, b) => a - b)]);
  }
  return {
    v: 1,
    e: epoch,
    m: cursor.m,
    c: [cursor.chat.mark, ...[...cursor.chat.held].sort((a, b) => a - b)],
    ...(d.length > 0 ? { d } : {}),
  };
}

function serialize(wire: CursorWire): string {
  return Buffer.from(JSON.stringify(wire), "utf8").toString("base64url");
}

/**
 * Encode a cursor, folding it until it fits {@link MAX_CURSOR_LENGTH} and the
 * entry caps — so the server never emits a cursor its own decoder would read
 * as fresh. Each fold drops the largest listed document into the shared mark,
 * lowering that mark first so the document loses nothing.
 */
export function encodeCursor(
  cursor: ReaderCursor,
  registry: DeliveryRegistry = deliveryRegistry,
): string {
  let m = cursor.m;
  const docs = new Map<string, ScopeView>();
  for (const [id, view] of cursor.docs) docs.set(id, capHeld(view));
  let chat = capHeld(cursor.chat);
  for (;;) {
    const wire = toWire({ m, docs, chat }, registry.epoch);
    const encoded = serialize(wire);
    const listed = wire.d?.length ?? 0;
    if (encoded.length <= MAX_CURSOR_LENGTH && listed <= MAX_CURSOR_ENTRIES) return encoded;
    if (listed > 0) {
      let widest: string | undefined;
      let widestSize = -1;
      for (const [id, view] of docs) {
        if (view.mark === m && view.held.size === 0) continue;
        if (view.held.size > widestSize) {
          widest = id;
          widestSize = view.held.size;
        }
      }
      if (widest === undefined) break;
      const folded = foldedMark(docs.get(widest) as ScopeView);
      // Every unlisted document shares `m`, so it may only go DOWN (a fresh
      // null mark has no numeric equivalent that loses nothing but 0).
      m = Math.min(m ?? 0, folded);
      docs.delete(widest);
      // Listed documents whose own mark now equals `m` drop out on their own.
      continue;
    }
    // Only chat's held list is left to shrink.
    if (chat.held.size === 0) break;
    chat = { mark: foldedMark(chat), held: new Set() };
  }
  // Unreachable in practice: a cursor with nothing listed and no held seqs is
  // a few dozen bytes. Fresh is the safe answer.
  return START_CURSOR;
}
