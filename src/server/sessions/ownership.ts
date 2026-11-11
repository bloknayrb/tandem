/**
 * Multi-session document ownership: owner records and ownership entries
 * (#2358, ADR-054; ownership design v5 §2–§4,
 * docs/spikes/multi-session-ownership/README.md).
 *
 * **Ships dark.** Every exported function that production code calls returns at
 * once while `ownershipEnabled()` is false, so a release build never creates a
 * record, an entry or a timer. The `ownership-flag-on` CI job runs everything
 * flag-on.
 *
 * **What is here.** PR 1a: records, labels, display kinds, attachment and lapse
 * (ownership design §3.4), the ownership map, `setDocOwner`, the default
 * rule's user-side seam, a presence seam that answers "not present" until PR
 * 3b, and a no-op `startOrWake`. PR 1c: the decisions enforcement rests on
 * (`claimForWrite`, `decideTake`, `takeDocument`), loss records (ownership design §5.3) and
 * the
 * thread answerers (ownership design §5.5). **Nothing here answers a tool call**: the MCP tool
 * wrapper (`mcp/owned-op.ts`) asks these functions and builds the refusal, so
 * `/api`, autosave and the reload family never meet a check (ownership design §3.1).
 *
 * **Nearly a leaf.** It imports the flag, one helper from `sessions/context.ts`,
 * the operation queue, two names from `mcp/transport-registry.ts` and
 * `node:crypto` — never the document registry or anything under `documents/`,
 * so every route and service that calls it keeps its module graph. Callers
 * pass document ids in.
 *
 * **Identity headers select, they do not prove** (ownership design §11.1).
 * Ownership coordinates Claude sessions; it is not a security boundary.
 */

import { randomInt } from "node:crypto";
import { CLAUDE_DESKTOP_CLIENT_NAME, claudeIdKey } from "../mcp/transport-registry.js";
import { ownershipEnabled } from "../ownership-flag.js";
import { runOutsideMcpContext } from "./context.js";
import {
  docOpQueueSizeForTests,
  resetDocOpQueuesForTests,
  runWhenDocIdle,
} from "./doc-op-queue.js";

/** How a record was identified (ownership design §2, §3.1). Server-derived. */
export type RecordKind = "tandem" | "claude" | "bridge" | "http" | "local";

/** What the badge may call a record (ownership design §10.3): a closed list. */
export type DisplayKind = "Tandem's Claude" | "terminal" | "Claude Desktop" | "other app";

/** What can move a document (ownership design §4.1). */
export type OwnershipKind = "default" | "claimed" | "opened" | "assigned";

/**
 * Why an ownership entry changed. Later PRs add their causes. `claim` is a
 * write to an unowned document, `take` a `tandem_open` (ownership design §4.2),
 * `claim-reversed` a claim undone because its operation was refused on its
 * arguments (§5.1: such a refusal never claims), `stale` an entry whose record
 * was gone.
 */
export type OwnershipChangeCause =
  | "user-open"
  | "lapse"
  | "take-back"
  | "claim"
  | "take"
  | "claim-reversed"
  | "stale";

/**
 * Why a record lost a document, for the causes that block it from claiming
 * the document again without a `tandem_open` (ownership design §5.3). PR 5
 * adds `released` and `assigned` with the controls that cause them.
 */
export type LossCause = "taken" | "taken back";

/** What a refusal may say about a record: its label and display kind, never its id. */
export interface HolderView {
  readonly label: string;
  readonly displayKind: DisplayKind;
}

/** The `reason` a `NOT_DOC_OWNER` refusal carries (ownership design §5.3), as far as PR 1c reaches. */
export type OwnershipRefusalReason =
  | "switch"
  | "answered"
  | "lost"
  | "held"
  | "claimed"
  | "default"
  | "not-present";

/** A refused ownership decision. `holder` is null when no record holds the document, or its record is gone. */
export interface OwnershipRefusal {
  readonly ok: false;
  readonly reason: OwnershipRefusalReason;
  readonly cause?: LossCause;
  readonly holder: HolderView | null;
}

/** The one record per server run that is Tandem's own Claude (ownership design §3.2). */
export const TANDEM_OWNER_ID = "tandem";
/** The one record a stdio-mode server answers every call as (ownership design §3.1 rule 4). */
export const LOCAL_OWNER_ID = "local";

/**
 * Claude Code's `clientInfo.name`. **Unverified**, like
 * `CLAUDE_DESKTOP_CLIENT_NAME`: nothing displays a display kind until PR 5,
 * whose hand tests read it from a real "MCP session established" line.
 */
export const CLAUDE_CODE_CLIENT_NAME = "claude-code";

/** The grace a detached record gets before it lapses (ownership design §3.4). */
export const DEFAULT_GRACE_MS = 2 * 60 * 1000;

/**
 * At most this many records may be detached (in their grace) at once. Each
 * `initialize` with a new identity header creates a record, and any local
 * process can send those, so without a bound the records and their timers
 * would grow at the `initialize` rate for two minutes. Past it, the excess
 * lapses at once: records holding nothing first, then the one detached
 * longest. Live records are already bounded by the transport registry's
 * session cap.
 */
export const MAX_DETACHED_RECORDS = 64;

export interface OwnerRecord {
  /**
   * The record's key: `claude:<id>`, `bridge:<client id>`, `http:<Mcp-Session-Id>`,
   * `local` or `tandem`. The first three carry a raw header value, and an
   * `Mcp-Session-Id` is a bearer value for its transport, so **an `ownerId` is
   * never published**: not in the ctrl room (`broadcastOpenDocs`), not in a tool
   * result, an `/api` response or diagnostics. Anything a person or another
   * session sees names the record by its `label`. Log lines pass it through
   * `sessionIdForLog`. `tests/server/ownership-source-pins.test.ts` pins which
   * `src` files may mention it.
   */
  readonly ownerId: string;
  readonly recordKind: RecordKind;
  /** `owner-` plus random characters. Never derived from a session id. */
  readonly label: string;
  /** The latest `initialize`'s self-reported `clientInfo.name`. */
  clientName?: string;
  /** When this record last polled its inbox (the plan's "per-record last-poll time"). */
  lastPollAt?: number;
  graceTimer?: ReturnType<typeof setTimeout>;
  /** When `graceTimer` was last armed, so the cap lapses in expiry order. */
  graceArmedAt?: number;
  /** Set once the grace expired; cleared when the record is attached again. */
  lapsed?: boolean;
}

/** One document's ownership entry (ownership design §2). No entry means unowned. */
export interface OwnershipEntry {
  readonly ownerId: string;
  readonly kind: OwnershipKind;
  readonly since: number;
  /** The inbox registry's counter when the entry was made (wired in PR 2). */
  readonly sinceSeq: number;
}

/** The slice of a transport-registry entry attachment is judged from. */
export interface TransportViewEntry {
  ownerId?: string;
  openStreams: number;
  streamEver?: boolean;
}

// ---------------------------------------------------------------------------
// State. In memory only; a restart forgets everything (decision 8).

const records = new Map<string, OwnerRecord>();
const ownerByDoc = new Map<string, OwnershipEntry>();
/** Per-document handover mark (ownership design §6.3). Written by PR 2; only cleared here. */
const handoverSeq = new Map<string, number>();
/**
 * The document's loss record (ownership design §5.3): which record lost it
 * and why. **At most one per document**, because a loss stands only until the
 * document changes owner again. Kept per document rather than on the record,
 * so it is bounded by open documents and survives the loser's record being
 * deleted and re-created for the same identity (stricter than the design's
 * "a record keeps", and the only difference).
 */
const lossByDoc = new Map<string, { ownerId: string; cause: LossCause }>();
/**
 * Who answered a thread's latest user entry (ownership design §5.5), keyed
 * `documentId \n annotationId \n item`. Written only if unset. One entry per
 * item answered this server run; forgotten when the annotation is removed
 * through MCP and on restart, and kept across a close and reopen.
 */
const answererByItem = new Map<string, string>();

let transportMode: "http" | "stdio" | undefined;
let transportView: () => ReadonlyArray<TransportViewEntry> = () => [];
let presenceSource: () => boolean = () => false;
let waitingProbe: (documentId: string, ownerId: string) => boolean = () => false;
let seqSource: () => number = () => 0;
let graceMs = DEFAULT_GRACE_MS;
const lastLogAt = new Map<string, number>();

/**
 * Run `fn`; log and return `fallback` if it throws. Every entry point that
 * production calls goes through this: they run inside `onsessioninitialized`,
 * the registry's removal path, a stream's `close` listener and timer callbacks,
 * where a throw would leak a server, reject the reaper or exit the process.
 */
function total<T>(what: string, fallback: T, fn: () => T): T {
  try {
    return fn();
  } catch (err) {
    logLimited(`throw:${what}`, `[ownership] ${what} failed: ${errorText(err)}`);
    return fallback;
  }
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * At most one line per key per minute; `resetOwnershipForTests` forgets the
 * keys. Never pass it a session id. `withErrorBoundary`'s no-caller line uses
 * it too, so there is one limiter.
 */
export function logLimited(key: string, line: string): void {
  const now = Date.now();
  const last = lastLogAt.get(key);
  if (last !== undefined && now - last < 60_000) return;
  lastLogAt.set(key, now);
  console.error(line);
}

// ---------------------------------------------------------------------------
// Transport mode and wiring seams.

/**
 * Tell the module which transport this process serves. Called once from each
 * transport branch of `src/server/index.ts`. Unset — a unit test, or any
 * process no boot has told — means a tool call with no request context is
 * refused (ownership design §3.1 rule 4). Never throws: a second call with a
 * different value is logged and ignored, so it can neither fail `main()` nor
 * turn a fail-closed HTTP process into a stdio one.
 */
export function setOwnershipTransportMode(mode: "http" | "stdio"): void {
  if (!ownershipEnabled()) return;
  total("setOwnershipTransportMode", undefined, () => {
    if (transportMode === undefined) {
      transportMode = mode;
      if (mode === "stdio") ensureRecord(LOCAL_OWNER_ID, "local");
      return;
    }
    if (transportMode !== mode) {
      logLimited("mode", `[ownership] transport mode is ${transportMode}; ignoring ${mode}`);
    }
  });
}

/** The transport mode a boot set, or undefined. */
export function getOwnershipTransportMode(): "http" | "stdio" | undefined {
  return transportMode;
}

/** Install the registry view attachment is judged from. `startMcpServerHttp` calls it. */
export function setTransportView(view: () => ReadonlyArray<TransportViewEntry>): void {
  transportView = view;
}

/** Presence seam (ownership design §8.1). Not present until PR 3b wires the supervisor. */
export function setTandemPresenceSource(source: () => boolean): void {
  presenceSource = source;
}

/** Whether Tandem's Claude is present. Always false while the flag is off. */
export function isTandemPresent(): boolean {
  if (!ownershipEnabled()) return false;
  return total("isTandemPresent", false, () => presenceSource() === true);
}

/** "Waiting" seam (ownership design §8.5). Nothing is waiting until PR 2 lands the collector. */
export function setWaitingProbe(probe: (documentId: string, ownerId: string) => boolean): void {
  waitingProbe = probe;
}

/** Source of `sinceSeq` (ownership design §2). The inbox registry's counter, from PR 2. */
export function setOwnershipSeqSource(source: () => number): void {
  seqSource = source;
}

// ---------------------------------------------------------------------------
// Records (ownership design §3.1, §3.2, §3.4).

/**
 * Which record an MCP transport belongs to, from what its `initialize` carried
 * (ownership design §3.1 rules 1–3; rule 0, the handle bind, is PR 3a's).
 * **Pure**: it creates nothing. `noteTransportRegistered` creates the record
 * once the transport is actually in the registry, so a record cannot be
 * removed in the window between the two (the registry's `add` awaits an LRU
 * eviction first). Undefined only while the flag is off; flag-on it is total.
 */
export function resolveTransportRecord(identity: {
  mcpSessionId: string;
  claudeSessionId?: string;
  clientId?: string;
}): { ownerId: string; recordKind: RecordKind } | undefined {
  if (!ownershipEnabled()) return undefined;
  const byTransport = { ownerId: `http:${identity.mcpSessionId}`, recordKind: "http" as const };
  return total("resolveTransportRecord", byTransport, () => {
    if (identity.claudeSessionId !== undefined) {
      return { ownerId: `claude:${claudeIdKey(identity.claudeSessionId)}`, recordKind: "claude" };
    }
    if (identity.clientId !== undefined) {
      return { ownerId: `bridge:${identity.clientId}`, recordKind: "bridge" };
    }
    return byTransport;
  });
}

/**
 * A transport of `ownerId` is now in the registry: create the record if it is
 * new (minting its label), take the latest client name, and re-judge
 * attachment. Called right after `registry.add` resolves.
 */
export function noteTransportRegistered(
  ownerId: string | undefined,
  info: { recordKind: RecordKind; clientName?: string },
): void {
  if (!ownershipEnabled() || ownerId === undefined) return;
  const record = total("noteTransportRegistered", undefined, () =>
    ensureRecord(ownerId, info.recordKind),
  );
  if (!record) return;
  record.clientName = info.clientName;
  rejudge(record);
}

/**
 * Something about one of `ownerId`'s transports changed: a request arrived, a
 * stream opened or closed, or the transport left the registry. Re-judges
 * attachment. A no-op for an id with no record; it never creates one.
 */
export function noteTransportChanged(ownerId: string | undefined): void {
  if (!ownershipEnabled() || ownerId === undefined) return;
  const record = records.get(ownerId);
  if (record) rejudge(record);
}

/**
 * `recompute`, total. If it threw, a record must not be left with no grace and
 * no deletion: fail toward a lapse by arming a grace (its expiry re-checks
 * attachment before moving anything).
 */
function rejudge(record: OwnerRecord): void {
  const judged = total("rejudge", false, () => {
    recompute(record);
    return true;
  });
  if (judged || isBuiltin(record) || record.graceTimer !== undefined || record.lapsed) return;
  if (records.get(record.ownerId) !== record) return;
  total("failTowardLapse", undefined, () => armGrace(record));
}

/** Record that `ownerId` polled its inbox. A no-op for an unknown id. */
export function noteRecordPoll(ownerId: string | undefined): void {
  if (!ownershipEnabled() || ownerId === undefined) return;
  const record = records.get(ownerId);
  if (record) record.lastPollAt = Date.now();
}

/** The record for `ownerId`, or undefined. */
export function getOwnerRecord(ownerId: string): Readonly<OwnerRecord> | undefined {
  return records.get(ownerId);
}

/**
 * Whether a record holds anything a lapse must move out (ownership design
 * §3.4). **The one place each later PR adds its per-record state** (change
 * notices and chat in 2). Loss records are per document (`lossByDoc`) and a
 * lapse moves none, so they are not counted here. A detached record that holds
 * state always has a grace running, even after an earlier lapse, so whatever
 * it picked up since is returned in turn; a record that holds none is not
 * re-armed. It never decides whether a record is kept: a lapse moves the
 * state out, and a record with no registered transport is then deleted.
 * `tests/server/ownership-records.test.ts` pins `OwnerRecord`'s keys against
 * this, so a new field fails until someone decides whether it counts here.
 */
export function recordHoldsState(record: OwnerRecord): boolean {
  for (const entry of ownerByDoc.values()) {
    if (entry.ownerId === record.ownerId) return true;
  }
  return false;
}

/**
 * Display kind (ownership design §10.3), record kind first: only the `tandem`
 * record is "Tandem's Claude"; a `claude` record is a terminal whatever name
 * its client sends; a name decides only among the other two kinds. Nothing
 * renders it before PR 5.
 */
export function displayKindOf(record: Pick<OwnerRecord, "recordKind" | "clientName">): DisplayKind {
  switch (record.recordKind) {
    case "tandem":
      return "Tandem's Claude";
    case "claude":
    case "local":
      return "terminal";
    case "bridge":
      return record.clientName === CLAUDE_DESKTOP_CLIENT_NAME ? "Claude Desktop" : "other app";
    case "http":
      if (record.clientName === CLAUDE_DESKTOP_CLIENT_NAME) return "Claude Desktop";
      return record.clientName === CLAUDE_CODE_CLIENT_NAME ? "terminal" : "other app";
  }
}

/** The record for `ownerId`, created (with a fresh label) if it is new. */
function ensureRecord(ownerId: string, recordKind: RecordKind): OwnerRecord {
  let record = records.get(ownerId);
  if (!record) {
    record = { ownerId, recordKind, label: mintLabel() };
    records.set(ownerId, record);
  }
  return record;
}

const LABEL_ALPHABET = "0123456789abcdefghijklmnopqrstuvwxyz";

function randomChars(n: number): string {
  let out = "";
  for (let i = 0; i < n; i++) out += LABEL_ALPHABET[randomInt(LABEL_ALPHABET.length)];
  return out;
}

/**
 * `owner-` plus 4 random base36 characters, unique among live records. Live
 * records are bounded (the registry's 16 plus 64 detached) against 36^4
 * labels, so the retry loop ends at once in practice.
 */
function mintLabel(): string {
  const taken = new Set([...records.values()].map((r) => r.label));
  let label: string;
  do label = `owner-${randomChars(4)}`;
  while (taken.has(label));
  return label;
}

/**
 * Attached (ownership design §3.4): some registered transport carries the
 * record, and — if any of its transports ever held a `GET /mcp` stream — one
 * such stream is open. Judged from the registry's own counters, so there is
 * one count, not two. `tandem` and `local` are never judged this way.
 */
function readAttachment(): { registered: Set<string>; attached: Set<string> } {
  const byOwner = new Map<string, { streamEver: boolean; open: boolean }>();
  for (const e of transportView()) {
    if (e.ownerId === undefined) continue;
    const seen = byOwner.get(e.ownerId) ?? { streamEver: false, open: false };
    seen.streamEver ||= e.streamEver === true;
    seen.open ||= e.openStreams > 0;
    byOwner.set(e.ownerId, seen);
  }
  const attached = new Set<string>();
  for (const [ownerId, seen] of byOwner) if (!seen.streamEver || seen.open) attached.add(ownerId);
  return { registered: new Set(byOwner.keys()), attached };
}

function isAttached(ownerId: string): boolean {
  return readAttachment().attached.has(ownerId);
}

function isBuiltin(record: OwnerRecord): boolean {
  return record.recordKind === "tandem" || record.recordKind === "local";
}

/**
 * Re-judge one record after any event. Attached → clear the grace. Detached →
 * (re)start the grace from now, so a request on a record that is still
 * detached starts a fresh grace instead of cancelling it for good (a client
 * that lost its stream and made one more request would otherwise keep its
 * documents until the idle reaper, ~37 minutes). A lapsed record that is still
 * detached is not re-armed; once its last transport goes it is deleted.
 */
function recompute(record: OwnerRecord): void {
  if (isBuiltin(record)) return;
  const { registered, attached } = readAttachment();
  if (attached.has(record.ownerId)) {
    clearGrace(record);
    record.lapsed = undefined;
    return;
  }
  if (record.lapsed && !recordHoldsState(record)) {
    if (!registered.has(record.ownerId)) deleteRecord(record);
    return;
  }
  armGrace(record);
}

function clearGrace(record: OwnerRecord): void {
  if (record.graceTimer !== undefined) clearTimeout(record.graceTimer);
  record.graceTimer = undefined;
  record.graceArmedAt = undefined;
}

function deleteRecord(record: OwnerRecord): void {
  clearGrace(record);
  records.delete(record.ownerId);
}

function armGrace(record: OwnerRecord): void {
  clearGrace(record);
  record.graceArmedAt = Date.now();
  // Armed outside any MCP request context: the event that detached this record
  // may be another client's request (an LRU eviction inside its initialize, a
  // DELETE), and a timer keeps the context it was created in. The lapse must
  // not run as that caller.
  const timer: ReturnType<typeof setTimeout> = runOutsideMcpContext(() =>
    setTimeout(() => onGraceExpired(record.ownerId, timer), graceMs),
  );
  timer.unref?.();
  record.graceTimer = timer;
  enforceDetachedCap();
}

function onGraceExpired(ownerId: string, timer: ReturnType<typeof setTimeout>): void {
  total("grace", undefined, () => {
    const record = records.get(ownerId);
    if (!record || record.graceTimer !== timer) return;
    clearGrace(record);
    if (!isAttached(ownerId)) lapse(record);
  });
}

/**
 * Past `MAX_DETACHED_RECORDS` graces, lapse early first the records that hold
 * nothing, then the ones that would expire first (expiry order, so a record
 * that keeps making requests while detached is not the first to go). Re-arming a record already in its grace does not grow the
 * count, so it cannot trigger this. A local process can trigger it on purpose —
 * a lapse accelerator, within the design's D4 (coordination, not security) —
 * and ADR-054 says so. Run outside any request context, like the timer path.
 */
function enforceDetachedCap(): void {
  // A record attached again since its grace was armed (its new transport
  // landed in the registry before its own re-judge ran) is not detached: its
  // grace ends here instead of counting against the cap.
  const { attached } = readAttachment();
  for (const r of records.values()) {
    if (r.graceTimer !== undefined && attached.has(r.ownerId)) clearGrace(r);
  }
  const inGrace = [...records.values()].filter((r) => r.graceTimer !== undefined);
  if (inGrace.length <= MAX_DETACHED_RECORDS) return;
  // Records that hold nothing go first: lapsing one early costs nothing, so
  // `initialize` churn cannot push out a record that holds documents while
  // empty ones remain. Within each group, expiry order.
  const holds = new Map(inGrace.map((r) => [r, recordHoldsState(r)]));
  inGrace.sort(
    (a, b) =>
      Number(holds.get(a)) - Number(holds.get(b)) || (a.graceArmedAt ?? 0) - (b.graceArmedAt ?? 0),
  );
  const excess = inGrace.slice(0, inGrace.length - MAX_DETACHED_RECORDS);
  logLimited(
    "cap",
    `[ownership] more than ${MAX_DETACHED_RECORDS} records detached; lapsing ${excess.length} early`,
  );
  runOutsideMcpContext(() => {
    for (const record of excess) lapse(record);
  });
}

/**
 * The record's client went away (ownership design §3.4): each document it holds
 * goes to the default rule. Its chat follows in PR 2, and each later PR moves
 * its own per-record state out here too. A lapse records no blocking loss. A
 * record with no registered transport is then deleted; one whose transport is
 * still registered keeps its label and may claim again like anyone — a grace
 * starts again if it does while still detached (`recompute`).
 */
function lapse(record: OwnerRecord): void {
  clearGrace(record);
  record.lapsed = true;
  for (const [documentId, entry] of [...ownerByDoc]) {
    if (entry.ownerId !== record.ownerId) continue;
    // At its turn in the document's queue (ownership design §4.3): at once
    // when nothing is in flight, otherwise after the running operation, so a
    // document never changes owner in the middle of one. A deferred move
    // re-checks everything it was decided on: this exact entry, this exact
    // record, still lapsed and still detached.
    runWhenDocIdle(
      documentId,
      () => {
        const stillThis =
          ownerByDoc.get(documentId) === entry &&
          records.get(record.ownerId) === record &&
          record.lapsed === true &&
          !isAttached(record.ownerId);
        if (stillThis) setDocOwner(documentId, defaultRuleOwner(), "lapse");
        // On every exit: a move that was no longer needed (the tab closed, the
        // claim was reversed) must still let a record with nothing left go.
        deleteIfGone(record);
      },
      (err) => logLimited("throw:lapse", `[ownership] lapse failed: ${errorText(err)}`),
    );
  }
  deleteIfGone(record);
}

/** Delete a lapsed record once it holds nothing and no transport carries it. */
function deleteIfGone(record: OwnerRecord): void {
  if (records.get(record.ownerId) !== record || !record.lapsed) return;
  if (recordHoldsState(record)) return;
  if (!readAttachment().registered.has(record.ownerId)) deleteRecord(record);
}

// ---------------------------------------------------------------------------
// Ownership entries (ownership design §4).

/** The document's ownership entry, or undefined when it is unowned. */
export function getDocOwner(documentId: string): OwnershipEntry | undefined {
  return ownerByDoc.get(documentId);
}

/**
 * Where a document goes when nobody in particular should have it (ownership
 * design §2): Tandem's Claude as `default` while it is present, otherwise
 * unowned.
 */
export function defaultRuleOwner(): { ownerId: string; kind: OwnershipKind } | null {
  return isTandemPresent() ? { ownerId: TANDEM_OWNER_ID, kind: "default" } : null;
}

/**
 * The one composite every ownership change goes through (ownership design
 * §4.3). **No enforcement here or anywhere in 1a.** Synchronous in 1a; PR 1c
 * runs it at its turn in the document's operation queue. Of the design's five
 * steps, 1a runs step 2 (the entry; `null` deletes it, so unowned is always
 * the absence of an entry) and step 5's seam; 1c adds step 1's loss record.
 * Step 1's handover is PR 2's, step 3 (change notices) PR 2's, step 4
 * (publishing owner fields through `broadcastOpenDocs`) PR 5's.
 *
 * It can run inside the registry's removal path (`closeEntry`) and inside
 * another client's request (a lapse triggered by an eviction in its
 * `initialize`), so whatever a later PR adds to it must not assume a caller's
 * request context or touch the transport registry.
 */
export function setDocOwner(
  documentId: string,
  next: { ownerId: string; kind: OwnershipKind } | null,
  cause: OwnershipChangeCause,
  caller?: string,
): void {
  if (!ownershipEnabled()) return;
  total("setDocOwner", undefined, () => {
    // Step 1, the loss-record half (ownership design §5.3). A loss stands
    // until the document changes owner again, and going to unowned counts.
    const previousId = ownerByDoc.get(documentId)?.ownerId;
    if (previousId !== next?.ownerId) {
      lossByDoc.delete(documentId);
      const lost = next === null ? undefined : lossCauseOf(cause, next.ownerId);
      if (previousId !== undefined && lost !== undefined) {
        lossByDoc.set(documentId, { ownerId: previousId, cause: lost });
      }
    }
    if (next === null) {
      ownerByDoc.delete(documentId);
      return;
    }
    if (next.ownerId === TANDEM_OWNER_ID) ensureRecord(TANDEM_OWNER_ID, "tandem");
    ownerByDoc.set(documentId, {
      ownerId: next.ownerId,
      kind: next.kind,
      since: Date.now(),
      sinceSeq: seqSource(),
    });
    // Step 5 (ownership design §4.4). Frames for a non-tandem owner are PR 3b's.
    if (
      next.ownerId === TANDEM_OWNER_ID &&
      caller !== TANDEM_OWNER_ID &&
      cause !== "take-back" &&
      waitingProbe(documentId, next.ownerId)
    ) {
      startOrWake(cause);
    }
  });
}

/**
 * Start or wake Tandem's Claude for returning work (ownership design §8.4).
 * **A no-op until PR 3b**, whose body must refuse through `aiRefusal()` before
 * it writes to the child (ownership design §11.5, Critical Rule 9).
 */
export function startOrWake(_cause: OwnershipChangeCause): void {}

/**
 * The default rule for a document the user opened (ownership design §4.2:
 * `POST /api/open`, upload, scratchpad, `/api/convert`, startup restore,
 * `welcome.md`). Applied only to a document with **no** entry: re-opening a
 * tab that is already held must not move an `opened` or `assigned` document.
 * Called from the user-side callers only, never from `documents/open.ts`,
 * which `tandem_open` also runs.
 */
export function applyUserOpenDefault(documentId: string): void {
  if (!ownershipEnabled()) return;
  total("applyUserOpenDefault", undefined, () => {
    if (ownerByDoc.has(documentId)) return;
    const next = defaultRuleOwner();
    if (next) setDocOwner(documentId, next, "user-open");
  });
}

/** `applyUserOpenDefault` over every document open at boot (`src/server/index.ts`). */
export function applyUserOpenDefaultToDocuments(documentIds: Iterable<string>): void {
  if (!ownershipEnabled()) return;
  for (const id of documentIds) applyUserOpenDefault(id);
}

/**
 * The tab-close point (ownership design §4.2): the entry and its handover mark
 * go. Synchronous, with no await between its caller's check and this write.
 * The handover that precedes it is PR 2's.
 */
export function onDocumentClosed(documentId: string): void {
  if (!ownershipEnabled()) return;
  total("onDocumentClosed", undefined, () => {
    ownerByDoc.delete(documentId);
    handoverSeq.delete(documentId);
    lossByDoc.delete(documentId);
  });
}

// ---------------------------------------------------------------------------
// Enforcement decisions (ownership design §4.2, §5.1–§5.6). PR 1c.
//
// Asked only by the MCP tool wrapper (`mcp/owned-op.ts`), inside the
// document's operation queue. They are deliberately NOT wrapped in `total()`:
// a throw here must reach `withErrorBoundary` as INTERNAL_ERROR rather than
// fall back to "allowed". No thrown message and no log line here carries an
// owner id: an `http:` owner id is that transport's bearer session id.

/** Which loss, if any, a change of owner records on the previous owner. */
function lossCauseOf(cause: OwnershipChangeCause, nextOwnerId: string): LossCause | undefined {
  if (cause === "take-back") return "taken back";
  if (cause === "take") return nextOwnerId === TANDEM_OWNER_ID ? "taken back" : "taken";
  return undefined;
}

/**
 * The document's entry, after clearing one whose record no longer exists. An
 * entry is never written for a record that does not exist, and a lapse moves a
 * record's documents before deleting it, so this is a backstop: without it
 * such an entry would refuse every session until the tab closed.
 */
function liveEntry(documentId: string): OwnershipEntry | undefined {
  const entry = ownerByDoc.get(documentId);
  if (entry && !records.has(entry.ownerId)) {
    setDocOwner(documentId, null, "stale");
    return undefined;
  }
  return entry;
}

function viewOf(ownerId: string): HolderView | null {
  const record = records.get(ownerId);
  return record ? { label: record.label, displayKind: displayKindOf(record) } : null;
}

/** The refusal for a document `callerId` does not hold, or undefined when it holds it or nobody does. */
function refusalFor(
  documentId: string,
  callerId: string,
  entry: OwnershipEntry | undefined,
): OwnershipRefusal | undefined {
  if (entry?.ownerId === callerId) return undefined;
  const holder = entry ? viewOf(entry.ownerId) : null;
  // "The first row wins" (ownership design §5.3): a caller that lost this document is told so
  // before it is told who holds it now.
  const loss = lossByDoc.get(documentId);
  if (loss?.ownerId === callerId) return { ok: false, reason: "lost", cause: loss.cause, holder };
  if (!entry) return undefined;
  if (entry.kind === "claimed") return { ok: false, reason: "claimed", holder };
  if (entry.kind === "default") return { ok: false, reason: "default", holder };
  return { ok: false, reason: "held", holder };
}

/** What a claim wrote, so that exactly that claim can be reversed. */
export interface ClaimToken {
  readonly entry: OwnershipEntry;
  readonly clearedLoss?: { ownerId: string; cause: LossCause };
}

/**
 * The ownership check for a write, and the claim of an unowned document
 * (ownership design §4.2, §5.1): **the first thing inside the queued
 * operation**, synchronous. Refused when another record holds the document or
 * the caller lost it; otherwise allowed, and an unowned document is claimed —
 * `default` for a present Tandem's Claude, `claimed` for anyone else. A
 * Tandem's Claude that is not present never claims (`not-present`).
 *
 * A caller with no record (a wiring fault, or a client whose record was
 * deleted while its call waited) may write to an unowned document but never
 * holds one: an entry for a record that does not exist could never lapse.
 */
export function claimForWrite(
  documentId: string,
  callerId: string,
): { ok: true; claimed: ClaimToken | null } | OwnershipRefusal {
  const entry = liveEntry(documentId);
  if (entry?.ownerId === callerId) return { ok: true, claimed: null };
  const refusal = refusalFor(documentId, callerId, entry);
  if (refusal) return refusal;
  const isTandem = callerId === TANDEM_OWNER_ID;
  if (isTandem && !isTandemPresent()) return { ok: false, reason: "not-present", holder: null };
  if (!isTandem && !records.has(callerId)) return { ok: true, claimed: null };
  const clearedLoss = lossByDoc.get(documentId);
  const written = writeEntry(documentId, callerId, isTandem ? "default" : "claimed", "claim");
  return { ok: true, claimed: { entry: written, ...(clearedLoss ? { clearedLoss } : {}) } };
}

/**
 * Undo a claim whose operation was then refused on its arguments or on a fact
 * fixed at open (ownership design §5.1: such a refusal never claims). Only
 * the exact entry the claim wrote is removed — never one the caller held
 * before the operation, nor a later one — and a loss record the claim cleared
 * is put back, so a refused call changes nothing.
 */
export function reverseClaim(documentId: string, token: ClaimToken): void {
  if (ownerByDoc.get(documentId) !== token.entry) return;
  setDocOwner(documentId, null, "claim-reversed", token.entry.ownerId);
  if (token.clearedLoss) lossByDoc.set(documentId, token.clearedLoss);
}

/**
 * The take rule for `tandem_open` (ownership design §4.2), as a decision:
 * `next` is the kind the caller would hold, or null for "no change". An
 * `opened` or `assigned` document held by another record is refused, and that
 * is checked before the Tandem's Claude arm, so a not-present Tandem's Claude
 * cannot reload another record's document either.
 */
export function decideTake(
  documentId: string,
  callerId: string,
): { ok: true; next: OwnershipKind | null } | OwnershipRefusal {
  const entry = liveEntry(documentId);
  const isTandem = callerId === TANDEM_OWNER_ID;
  if (entry?.ownerId === callerId) {
    return { ok: true, next: entry.kind === "claimed" ? "opened" : null };
  }
  if (entry && (entry.kind === "opened" || entry.kind === "assigned")) {
    return refusalFor(documentId, callerId, entry) as OwnershipRefusal;
  }
  if (isTandem) return { ok: true, next: isTandemPresent() ? "default" : null };
  if (!records.has(callerId)) return { ok: true, next: null };
  return { ok: true, next: "opened" };
}

/**
 * Decide the take again and apply it, synchronously (ownership design §5.4).
 * Called once the document is open. A refusal here means another record took
 * the document while this open was reading the disk.
 */
export function takeDocument(
  documentId: string,
  callerId: string,
): { ok: true; took: boolean } | OwnershipRefusal {
  const decision = decideTake(documentId, callerId);
  if (!decision.ok) return decision;
  if (decision.next === null) return { ok: true, took: false };
  writeEntry(documentId, callerId, decision.next, "take");
  return { ok: true, took: true };
}

/**
 * Write an entry through `setDocOwner` and confirm it landed. `setDocOwner`
 * is total (it logs and swallows), so a failed write would otherwise read as
 * "claimed" to the operation about to run on the strength of it.
 */
function writeEntry(
  documentId: string,
  callerId: string,
  kind: OwnershipKind,
  cause: OwnershipChangeCause,
): OwnershipEntry {
  setDocOwner(documentId, { ownerId: callerId, kind }, cause, callerId);
  const entry = ownerByDoc.get(documentId);
  if (entry?.ownerId !== callerId || entry.kind !== kind) {
    throw new Error("the ownership entry for this document could not be written");
  }
  // A holder that is detached must have a grace running, or it would keep the
  // document until its transport is reaped.
  const record = records.get(callerId);
  if (record) rejudge(record);
  return entry;
}

/**
 * The record holding `documentId` when it is not `callerId`, as a view; null
 * when the caller holds it or nobody does. For the two owner-only reads
 * (`tandem_switchDocument`, a write-mode `tandem_status` focus), which never
 * claim.
 */
export function otherHolderOf(
  documentId: string,
  callerId: string,
): { holder: HolderView | null } | null {
  const entry = liveEntry(documentId);
  if (!entry || entry.ownerId === callerId) return null;
  return { holder: viewOf(entry.ownerId) };
}

/** The ids of the documents `ownerId` holds. */
export function heldDocumentIds(ownerId: string): string[] {
  const held: string[] = [];
  for (const [documentId, entry] of ownerByDoc)
    if (entry.ownerId === ownerId) held.push(documentId);
  return held;
}

/**
 * How the caller's own record is described back to it, and the two facts the
 * refusal copy keys on (ownership design §3.1 rule 3, §5.3). Undefined for a
 * caller with no record.
 */
export function callerView(
  ownerId: string,
): (HolderView & { isTandem: boolean; isLegacyClaudeCode: boolean }) | undefined {
  const record = records.get(ownerId);
  if (!record) return undefined;
  return {
    label: record.label,
    displayKind: displayKindOf(record),
    isTandem: record.recordKind === "tandem",
    isLegacyClaudeCode:
      record.recordKind === "http" && record.clientName === CLAUDE_CODE_CLIENT_NAME,
  };
}

function answererKey(documentId: string, annotationId: string, item: string): string {
  return `${documentId}\n${annotationId}\n${item}`;
}

/**
 * Whether a record other than `callerId` already answered this item
 * (ownership design §5.5): its view (null when that record is gone), or
 * undefined when nobody did or the caller is the answerer.
 */
export function otherAnswererOf(
  documentId: string,
  annotationId: string,
  item: string,
  callerId: string,
): { holder: HolderView | null } | undefined {
  const answerer = answererByItem.get(answererKey(documentId, annotationId, item));
  if (answerer === undefined || answerer === callerId) return undefined;
  return { holder: viewOf(answerer) };
}

/** Make `callerId` the item's answerer, if it has none. */
export function recordAnswerer(
  documentId: string,
  annotationId: string,
  item: string,
  callerId: string,
): void {
  if (!ownershipEnabled()) return;
  const key = answererKey(documentId, annotationId, item);
  if (!answererByItem.has(key)) answererByItem.set(key, callerId);
}

/** Forget a removed annotation's answerers. */
export function forgetThreadAnswerers(documentId: string, annotationId: string): void {
  const prefix = answererKey(documentId, annotationId, "");
  for (const key of [...answererByItem.keys()]) {
    if (key.startsWith(prefix)) answererByItem.delete(key);
  }
}

// ---------------------------------------------------------------------------
// Test seams.

/** Everything this module holds, for "nothing was created" assertions. */
export function ownershipSnapshotForTests(): {
  transportMode: "http" | "stdio" | undefined;
  records: OwnerRecord[];
  ownerByDoc: Array<[string, OwnershipEntry]>;
  handoverSeq: Array<[string, number]>;
  timers: number;
  losses: Array<[string, { ownerId: string; cause: LossCause }]>;
  answerers: number;
  queuedDocuments: number;
} {
  return {
    transportMode,
    records: [...records.values()].map((r) => ({ ...r })),
    ownerByDoc: [...ownerByDoc],
    handoverSeq: [...handoverSeq],
    timers: [...records.values()].filter((r) => r.graceTimer !== undefined).length,
    losses: [...lossByDoc],
    answerers: answererByItem.size,
    queuedDocuments: docOpQueueSizeForTests(),
  };
}

/** Shorten the grace for a test. */
export function setGraceMsForTests(ms: number): void {
  graceMs = ms;
}

/** Forget everything: records, entries, timers, seams, mode. */
export function resetOwnershipForTests(): void {
  for (const record of records.values()) clearGrace(record);
  records.clear();
  ownerByDoc.clear();
  handoverSeq.clear();
  lossByDoc.clear();
  answererByItem.clear();
  resetDocOpQueuesForTests();
  lastLogAt.clear();
  transportMode = undefined;
  transportView = () => [];
  presenceSource = () => false;
  waitingProbe = () => false;
  seqSource = () => 0;
  graceMs = DEFAULT_GRACE_MS;
}
