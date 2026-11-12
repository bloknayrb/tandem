/**
 * Multi-session document ownership: owner records and ownership entries
 * (#2358, ADR-054; ownership design v5 §2–§4,
 * docs/spikes/multi-session-ownership/README.md).
 *
 * **Ships dark.** Every exported function that production code calls returns at
 * once while `ownershipEnabled()` is false, so a release build never creates a
 * record, an entry or a timer. (The wiring seams — `setTransportView`,
 * `setOwnershipSeqSource` and their kin — only store a function, which
 * nothing calls while dark.) The `ownership-flag-on` CI job runs everything
 * flag-on.
 *
 * **What is here.** PR 1a: records, labels, display kinds, attachment and lapse
 * (ownership design §3.4), the ownership map, `setDocOwner`, the default
 * rule's user-side seam, a presence seam that answers "not present" until PR
 * 3b, and a no-op `startOrWake`. PR 1c: the decisions enforcement rests on
 * (`checkWrite`, `decideTake`, `takeDocument`), loss records (ownership design §5.3) and
 * the
 * thread answerers (ownership design §5.5). PR 2a: a write's claim takes
 * effect at its operation's outcome (`beginWriteClaim`, `settleWriteClaim`),
 * and the inbox scope read the scope PR will call (`inboxScopeOf`). The
 * handover PR: the handover (`handOver`, ownership design §6.3's rule) for
 * user comments and thread replies, and the writing of `handoverSeq`. The
 * scope PR: the inbox's one door (`inboxOwnership`: a poll's scope, its
 * claims and `holding`) and the stuck-write release in `inboxScopeOf`. Still
 * to come, named by content as in the plan: the change-notice PR (change
 * notices, the notice rule that reads `handoverSeq`, per-document delivery
 * rounds), and the chat PR.
 * **Nothing here answers a tool call**: the MCP tool
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
  docOpBusySince,
  docOpQueueSizeForTests,
  docOpWaitLimitMs,
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
 * write to an unowned document, applied once the write's outcome is known
 * (a refusal that never claims, §5.1, and a throw apply nothing, so there is
 * no cause for undoing one); `take` a `tandem_open` (ownership design §4.2);
 * `stale` an entry whose record was gone; `poll-claim` an inbox poll that
 * was handed items on an unowned document it may claim (the scope PR,
 * applied in the poll's synchronous commit, not at a turn in the queue).
 */
export type OwnershipChangeCause =
  | "user-open"
  | "lapse"
  | "take-back"
  | "claim"
  | "take"
  | "stale"
  | "poll-claim";

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
  /** The inbox registry's counter when the entry was made (`setOwnershipSeqSource`). */
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
/**
 * Per-document handover mark (ownership design §6.3 step 2). It outlives
 * ownership entries, an unowned spell and a close and reopen, for the server
 * run: a notice at or below it was handed to an earlier owner. Only a
 * handover writes it (`handOver`), with the delivery registry's counter at
 * that moment; nothing reads it until the scope PR's notice rule. One entry
 * per document that ever had a handover, never pruned.
 */
const handoverSeq = new Map<string, number>();
/**
 * Claims by writes whose outcome is not known yet (PR 2a). **Nothing reads
 * this to decide who holds or may claim a document**: no reader, no check, no
 * take, `recordHoldsState` and no scope predicate. Only the settle of the
 * same write looks its own token up. It exists so the tab-close point can
 * cancel a claim
 * (a document closed during the write gets no entry, even if it is reopened
 * before the write returns), and so tests can count it.
 */
const pendingClaims = new Set<PendingClaim>();
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
let inboxHandover: (documentId: string) => void = () => {};
let compositeObserver: ((step: CompositeStep, documentId: string) => void) | undefined;
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

/** "Waiting" seam (ownership design §8.5). Nothing is waiting until a later PR lands the collector. */
export function setWaitingProbe(probe: (documentId: string, ownerId: string) => boolean): void {
  waitingProbe = probe;
}

/**
 * Source of `sinceSeq` (ownership design §2): the delivery registry's counter.
 * `src/server/index.ts` wires it at boot (pinned from source in
 * `tests/server/ownership-source-pins.test.ts`); unwired it answers 0. Read
 * when an entry is written, so for a claim made by a write it is the counter
 * at the moment the claim takes effect. A claim made by an inbox poll (the
 * scope PR) passes its own value to `setDocOwner` instead: the counter before
 * its pass.
 */
export function setOwnershipSeqSource(source: () => number): void {
  seqSource = source;
}

/**
 * The inbox's half of a handover (ownership design §6.3): what makes the
 * comments and replies a document's previous owner was shown count as unseen
 * again. `src/server/index.ts` wires `handOverDocumentInbox` at boot (pinned
 * from source in `tests/server/ownership-source-pins.test.ts`); unwired it
 * does nothing, so a handover would re-owe nothing and no unit test would
 * notice. A seam because this module never imports the inbox. Synchronous:
 * a function that returned a promise would run outside `handOver`'s guard.
 */
export function setOwnershipInboxHandover(handover: (documentId: string) => void): void {
  inboxHandover = handover;
}

/**
 * Fixed text, true of every point the handover can fail at: nothing from the
 * error, no record and no document.
 */
const HANDOVER_FAILED =
  "[ownership] a document changed hands but its inbox handover did not complete: some of what its previous owner was shown may still count as seen, or the document's handover mark was not moved";

/**
 * The handover (ownership design §6.3's rule, as the handover PR narrows it):
 * `documentId`'s ownership just left a record, so the user comments and thread
 * replies seen on it are owed again to every reader, and its handover mark
 * becomes the delivery registry's counter. It hands nothing and moves
 * nothing: no Y.Doc write, no push, no wake.
 *
 * **Called from exactly two places, each after its function's first-line
 * flag return** (`setDocOwner` once the entry is written, `onDocumentClosed`
 * once it is deleted), with no `await` between the ownership change and this,
 * so no poll sees one without the other. **It never throws**: the change it
 * rides on has already happened and must stand. The mark is written last, so
 * a failure in the inbox half leaves it where it was (the notice rule that
 * will read it then errs toward a duplicate notice).
 */
function handOver(documentId: string): void {
  try {
    inboxHandover(documentId);
    handoverSeq.set(documentId, seqSource());
  } catch {
    logLimited("handover-failed", HANDOVER_FAILED);
  }
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
 * goes to the default rule. Its chat follows in the chat PR, and each later PR moves
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
    // document does not change owner in the middle of one — with one
    // exception: a lapse that has waited the queue's limit runs anyway, beside
    // whatever is still running, so a dead owner cannot keep a document
    // behind an operation that never settles. A deferred move re-checks
    // everything it was decided on: this exact entry, this exact
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
        // On every exit: a move that was no longer needed (the tab closed,
        // another record took the document) must still let a record with
        // nothing left go.
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
 * §4.3). **No enforcement here or anywhere in 1a.** Synchronous. From PR 1c
 * a claim, a take and a lapse call it at their turn in the document's
 * operation queue; the user-open default, the stale-entry backstop and a
 * lapse whose wait ran out call it where they are. (The tab-close point does
 * not come through here at all: `onDocumentClosed` deletes the entry itself.
 * `doc-op-queue.ts`'s header lists all four.) Of the design's five
 * steps, 1a runs step 2 (the entry; `null` deletes it, so unowned is always
 * the absence of an entry) and step 5's seam; 1c adds step 1's loss record.
 * Step 1's handover (`handOver`) is decided where the design puts it and
 * runs as soon as the entry is written, in the same synchronous run, so a
 * change that fails before its entry hands nothing over. Step 3 (change
 * notices) is the scope PR's, step 4 (publishing owner fields through
 * `broadcastOpenDocs`) PR 5's.
 *
 * **A write's claim reaches this only once its outcome is known** (PR 2a,
 * `settleWriteClaim`): a write that is refused on its arguments, or throws,
 * never calls it, so nothing here runs for a claim that does not stand.
 * `sinceSeq` overrides the sequence source, for a claim made by an inbox
 * poll (the scope PR: the counter before that poll's pass).
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
  sinceSeq?: number,
): void {
  if (!ownershipEnabled()) return;
  total("setDocOwner", undefined, () => {
    // Read before anything is changed, so a source that throws leaves every
    // map as it was. Only for an entry about to be written: removing one (a
    // lapse to unowned, the stale-entry backstop) must not depend on it.
    const seq = next === null ? 0 : (sinceSeq ?? seqSource());
    const previousId = ownerByDoc.get(documentId)?.ownerId;
    // Step 1, the handover (ownership design §6.3): ownership leaves a
    // record. Not a claim of an unowned document, and not a change that
    // leaves the owner the same. Decided here, run below once the entry is in.
    const leavesRecord = previousId !== undefined && previousId !== next?.ownerId;
    if (leavesRecord) compositeObserver?.("handover", documentId);
    // Step 1, the loss-record half (ownership design §5.3). A loss stands
    // until the document changes owner again, and going to unowned counts.
    if (previousId !== next?.ownerId) {
      compositeObserver?.("loss", documentId);
      lossByDoc.delete(documentId);
      const lost = next === null ? undefined : lossCauseOf(cause, next.ownerId);
      if (previousId !== undefined && lost !== undefined) {
        lossByDoc.set(documentId, { ownerId: previousId, cause: lost });
      }
    }
    // Step 2, the entry.
    compositeObserver?.("entry", documentId);
    if (next === null) {
      ownerByDoc.delete(documentId);
    } else {
      if (next.ownerId === TANDEM_OWNER_ID) ensureRecord(TANDEM_OWNER_ID, "tandem");
      ownerByDoc.set(documentId, {
        ownerId: next.ownerId,
        kind: next.kind,
        since: Date.now(),
        sinceSeq: seq,
      });
    }
    if (leavesRecord) handOver(documentId);
    // Step 3, change notices (the scope PR), and step 4, publishing (PR 5): no body yet.
    compositeObserver?.("notices", documentId);
    compositeObserver?.("publish", documentId);
    // Step 5 (ownership design §4.4). Frames for a non-tandem owner are PR 3b's.
    compositeObserver?.("wake", documentId);
    if (
      next !== null &&
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
 * The tab-close point (ownership design §4.2): the entry and the loss record
 * go, and a claim still pending on a write is cancelled, so a document closed
 * during a write gets no entry even if it is reopened before the write
 * returns (reopening starts from the default rule, §6.3). **The handover mark
 * stays** (§6.3 step 2: it survives a close and reopen for the server run).
 * Synchronous, with no await between its caller's check and this write. A
 * close while a record holds the document is a handover, run here once
 * the entry is gone; the document is still registered and its annotations
 * are still readable at this point (`closeDocumentById`).
 */
export function onDocumentClosed(documentId: string): void {
  if (!ownershipEnabled()) return;
  total("onDocumentClosed", undefined, () => {
    const held = ownerByDoc.has(documentId);
    ownerByDoc.delete(documentId);
    lossByDoc.delete(documentId);
    for (const pending of [...pendingClaims]) {
      if (pending.documentId === documentId) pendingClaims.delete(pending);
    }
    if (held) handOver(documentId);
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
 * The document's entry, after clearing one whose record no longer exists
 * (**inside the document's queue only**; a reader uses `readEntry`). An
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

/**
 * The document's entry as a **reader** sees it: one whose record no longer
 * exists reads as unowned, and nothing is written. Clearing such an entry is
 * an ownership change (it runs the composite), so only the two decisions made
 * inside the document's queue do it (`checkWrite`, `decideTake`, through
 * `liveEntry`); every read outside the queue comes through here.
 */
function readEntry(documentId: string): OwnershipEntry | undefined {
  const entry = ownerByDoc.get(documentId);
  return entry && records.has(entry.ownerId) ? entry : undefined;
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
  // before it is told who holds it now. With no entry this row is unreachable
  // today: `setDocOwner` deletes the loss record on every change of owner,
  // going to unowned included, so a loss never stands on an unowned document.
  // It is kept for PR 5's `released` cause (design §5.3: Release lasts while
  // Tandem's Claude is not present), and `setLossForTests` reaches it.
  const loss = lossByDoc.get(documentId);
  if (loss?.ownerId === callerId) return { ok: false, reason: "lost", cause: loss.cause, holder };
  if (!entry) return undefined;
  if (entry.kind === "claimed") return { ok: false, reason: "claimed", holder };
  if (entry.kind === "default") return { ok: false, reason: "default", holder };
  return { ok: false, reason: "held", holder };
}

/** Where `callerId` stands on a document for a write, given the document's entry. */
type WriteStanding =
  /** The caller holds it. */
  | { ok: true; holds: true }
  /**
   * Nobody holds it and the caller may write. `claim` is the kind the caller
   * would hold it as, or null for a caller that never holds a document (one
   * with no record: an entry for a record that does not exist could never
   * lapse).
   */
  | { ok: true; holds: false; claim: OwnershipKind | null }
  | OwnershipRefusal;

/**
 * The one rule for who may write and who may claim (ownership design §4.2,
 * §5.1), **pure**: it reads the maps and writes nothing. The check at the top
 * of a write, the re-decision when the write's claim takes effect and the
 * inbox scope read all answer from it, so they cannot drift apart.
 */
function standingOf(
  documentId: string,
  callerId: string,
  entry: OwnershipEntry | undefined,
): WriteStanding {
  if (entry?.ownerId === callerId) return { ok: true, holds: true };
  const refusal = refusalFor(documentId, callerId, entry);
  if (refusal) return refusal;
  const isTandem = callerId === TANDEM_OWNER_ID;
  if (isTandem && !isTandemPresent()) return { ok: false, reason: "not-present", holder: null };
  if (!isTandem && !records.has(callerId)) return { ok: true, holds: false, claim: null };
  return { ok: true, holds: false, claim: isTandem ? "default" : "claimed" };
}

/**
 * The ownership check for a write (ownership design §4.2, §5.1): **the first
 * thing inside the queued operation**, synchronous. Refused when another
 * record holds the document or the caller lost it; otherwise allowed.
 * **It claims nothing** (PR 2a): `claim` is the kind an unowned document
 * would be claimed as — `default` for a present Tandem's Claude, `claimed`
 * for anyone else — and the caller applies it with `settleWriteClaim` once
 * the write's outcome is known. A Tandem's Claude that is not present never
 * claims (`not-present`).
 *
 * A caller with no record (a wiring fault, or a client whose record was
 * deleted while its call waited) may write to an unowned document but never
 * holds one (`claim: null`).
 *
 * The one thing it may write: an entry whose record is gone is cleared here
 * (`liveEntry`), as before.
 */
export function checkWrite(
  documentId: string,
  callerId: string,
): { ok: true; claim: OwnershipKind | null } | OwnershipRefusal {
  const standing = standingOf(documentId, callerId, liveEntry(documentId));
  if (!standing.ok) return standing;
  return { ok: true, claim: standing.holds ? null : standing.claim };
}

/** Names no record: an owner id can be a bearer session id. */
const CLAIM_NOT_APPLIED =
  "[ownership] a write landed but its claim of the document could not be applied; the document stays unowned";

/** A write's claim of an unowned document, until the write's outcome is known. */
export interface PendingClaim {
  readonly documentId: string;
  readonly callerId: string;
}

/**
 * Note that a write which may claim `documentId` has started. The token is
 * invisible: until `settleWriteClaim` applies it the document reads as
 * unowned to everything. Inert (an unregistered token) while ownership is off.
 */
export function beginWriteClaim(documentId: string, callerId: string): PendingClaim {
  const pending: PendingClaim = { documentId, callerId };
  if (ownershipEnabled()) pendingClaims.add(pending);
  return pending;
}

/** Forget a pending claim whose write was refused without claiming, or threw. Changes nothing else. */
export function dropWriteClaim(pending: PendingClaim): void {
  pendingClaims.delete(pending);
}

/**
 * The write behind `pending` kept its claim: make the caller the document's
 * owner, **if the claim still stands now**. Called inside the queued
 * operation, synchronously, before it returns, so the next operation in the
 * document's queue finds the claim in effect. Everything is decided again at
 * this moment, by the same rule as the check:
 *
 * - the document was not closed during the write (`onDocumentClosed` cancels
 *   the token, so a close followed by a reopen counts) and is open now
 *   (`stillOpen`, which the caller reads from the document registry). The
 *   second is kept beside the first on purpose: the cancellation holds only
 *   while every untrack goes through the tab-close point, and one registry
 *   read covers a later path that forgets it;
 * - it has no entry at all (an unqueued change that gave it an owner during
 *   the write stands);
 * - the caller's record still exists (a record that lapsed but still exists
 *   gets the entry, and `rejudge` arms its grace again; one that was deleted
 *   gets none), it holds no blocking loss for the document, and a Tandem's
 *   Claude caller is still present.
 *
 * **It never throws.** The write has already happened: a failure here must
 * not turn it into an error the client would retry. A claim that could not be
 * applied is logged and the document stays unowned. Returns whether the
 * caller now holds the document.
 */
export function settleWriteClaim(pending: PendingClaim, stillOpen: boolean): boolean {
  try {
    // Before the flag is read, so the token goes whatever happens next.
    const registered = pendingClaims.delete(pending);
    if (!ownershipEnabled() || !registered || !stillOpen) return false;
    const { documentId, callerId } = pending;
    const standing = standingOf(documentId, callerId, ownerByDoc.get(documentId));
    if (!standing.ok || standing.holds || standing.claim === null) return false;
    const kind = standing.claim;
    setDocOwner(documentId, { ownerId: callerId, kind }, "claim", callerId);
    const entry = ownerByDoc.get(documentId);
    if (entry?.ownerId !== callerId || entry.kind !== kind) {
      // `setDocOwner` is total and has logged why.
      logLimited("claim-not-applied", CLAIM_NOT_APPLIED);
      return false;
    }
    // A holder that is detached must have a grace running, or it would keep
    // the document until its transport is reaped.
    const record = records.get(callerId);
    if (record) rejudge(record);
    return true;
  } catch {
    logLimited("claim-not-applied", CLAIM_NOT_APPLIED);
    return false;
  }
}

/** What an inbox poll may do with a document (ownership design §6.2). */
export type InboxScope = "holds" | "may-claim" | "neither";

/**
 * Where `callerId` stands on an **open** document for an inbox poll
 * (ownership design §6.2). The scope PR calls it through `inboxOwnership`
 * below; `inboxScope` in `owned-op.ts` is its tool-side name.
 * **Pure**: a reader never changes ownership, so an entry whose record is
 * gone reads as unowned and is left alone.
 *
 * - `"holds"`: the caller's record holds it (decided before the queue, so a
 *   holder reads its document mid-write).
 * - `"may-claim"`: nobody holds it and a poll by the caller may claim it now —
 *   the caller has a record, holds no blocking loss for it, is not a
 *   Tandem's Claude that is not present, **and the document's operation queue
 *   is idle, or the operation running now started at least the queue's wait
 *   bound (`DOC_OP_WAIT_MS`, 20 s) before `now`** (the stuck-write release,
 *   Bryan 2026-11-12: a write that never settles must not hide a document from
 *   every session until restart). Measured from when the operation running
 *   now started, never from when the queue first became busy, so a run of
 *   healthy short operations is not released; a queue busy with no operation
 *   started yet (the microtask between two) reads as within the bound.
 * - `"neither"`: anything else, including a caller with no owner id or no
 *   record (PR 2a's ruling), and every caller while ownership is off.
 *
 * It cannot see whether the document is open (this module never imports the
 * registry): pass open documents only. Chat is the chat PR's.
 */
export function inboxScopeOf(
  documentId: string,
  callerId: string | undefined,
  now: number = Date.now(),
): InboxScope {
  if (!ownershipEnabled() || callerId === undefined) return "neither";
  const standing = standingOf(documentId, callerId, readEntry(documentId));
  if (!standing.ok) return "neither";
  if (standing.holds) return "holds";
  if (standing.claim === null) return "neither";
  const since = docOpBusySince(documentId);
  if (since === undefined) return "may-claim";
  return since !== null && now - since >= docOpWaitLimitMs() ? "may-claim" : "neither";
}

/**
 * Where a poll stands on one open document, as the poll's scope snapshot
 * holds it: an {@link InboxScope}, `"unread"` when the scope read for it
 * threw (the poll neither reads nor acknowledges it and keeps the reader's
 * position there, so nothing it was owed is passed), or `"closed"` for an id
 * the poll did not find open (master's behaviour applies).
 */
export type InboxDocumentScope = InboxScope | "unread" | "closed";

/** What a poll needs from ownership, fixed when the poll begins. */
export interface InboxPollScope {
  /**
   * False while ownership is off: the poll reads every document,
   * acknowledges as master does and returns no `ownership` field. True flag
   * on, for every caller — one with no record included, whose every document
   * is `"neither"`.
   */
  readonly scoped: boolean;
  /** The document's answer in this poll's snapshot. */
  scopeOf(documentId: string): InboxDocumentScope;
  /**
   * Apply a poll's claim of `documentId` (the inbox commit, ownership design
   * §6.2), only if, now: the snapshot answered `"may-claim"` for it; it is
   * still open (`stillOpen`, read by the caller from the document registry);
   * it is still unowned (an entry whose record is gone reads as unowned, and
   * the claim then runs a handover inside `setDocOwner`); the caller's record
   * still exists; and the scope rule, with the poll's own clock reading, still
   * answers `"may-claim"`. `sinceSeq` is the registry counter before this
   * poll's pass over the document. Never throws. Answers `"held"` when the
   * caller holds the document afterwards; `"refused"` when a check refused it
   * and nothing changed; `"changed"` when the ownership change ran but the
   * caller does not hold the document after it (a re-entrant lapse, or a
   * failure after the entry was written): its handover may already have
   * re-owed the document's items, which the caller must not undo.
   */
  claim(documentId: string, sinceSeq: number, stillOpen: boolean): InboxClaimOutcome;
  /** The documents the caller holds right now (empty for no record). */
  holding(): string[];
}

/** What applying a poll's claim came to (`InboxPollScope.claim`). */
export type InboxClaimOutcome = "held" | "refused" | "changed";

/** The poll scope while ownership is off: read everything, claim nothing. */
const UNSCOPED: InboxPollScope = Object.freeze({
  scoped: false,
  scopeOf: (): InboxDocumentScope => "holds",
  claim: (): InboxClaimOutcome => "refused",
  holding: () => [],
});

/** One of the poll claim's commit-time checks, for {@link setInboxClaimCheckForTests}. */
export type InboxClaimCheck = "claimable" | "open" | "unowned" | "record" | "scope";

let claimCheckForTests: ((check: InboxClaimCheck, documentId: string) => boolean) | undefined;

let scopeReadForTests: typeof inboxScopeOf | undefined;

const POLL_CLAIM_NOT_APPLIED =
  "[ownership] an inbox poll's claim of a document could not be applied; the document stays unowned";

function pollScope(callerId: string | undefined, openIds: Iterable<string>, now: number) {
  const snapshot = new Map<string, InboxDocumentScope>();
  for (const id of openIds) {
    try {
      snapshot.set(id, (scopeReadForTests ?? inboxScopeOf)(id, callerId, now));
    } catch {
      logLimited(
        "inbox-scope",
        "[ownership] an inbox scope read failed; the document was not read",
      );
      snapshot.set(id, "unread");
    }
  }
  const passes = (check: InboxClaimCheck, documentId: string, ok: () => boolean): boolean =>
    ok() && (claimCheckForTests?.(check, documentId) ?? true);
  const scope: InboxPollScope = {
    scoped: true,
    scopeOf: (documentId) => snapshot.get(documentId) ?? "closed",
    claim: (documentId, sinceSeq, stillOpen) => {
      let changed = false;
      const outcomeAfterChange = (): InboxClaimOutcome =>
        callerId !== undefined && readEntry(documentId)?.ownerId === callerId ? "held" : "changed";
      try {
        if (callerId === undefined) return "refused";
        const applies =
          passes("claimable", documentId, () => snapshot.get(documentId) === "may-claim") &&
          passes("open", documentId, () => stillOpen) &&
          passes("unowned", documentId, () => readEntry(documentId) === undefined) &&
          passes("record", documentId, () => records.has(callerId)) &&
          passes(
            "scope",
            documentId,
            () => inboxScopeOf(documentId, callerId, now) === "may-claim",
          );
        if (!applies) return "refused";
        // The kind from the same rule a write's claim uses (`standingOf`).
        const standing = standingOf(documentId, callerId, readEntry(documentId));
        if (!standing.ok || standing.holds || standing.claim === null) return "refused";
        const kind = standing.claim;
        changed = true;
        setDocOwner(documentId, { ownerId: callerId, kind }, "poll-claim", callerId, sinceSeq);
        const entry = ownerByDoc.get(documentId);
        if (entry?.ownerId !== callerId || entry.kind !== kind) {
          logLimited("poll-claim-not-applied", POLL_CLAIM_NOT_APPLIED);
          return outcomeAfterChange();
        }
        // A holder that is detached must have a grace running, or it would
        // keep the document until its transport is reaped. This can lapse
        // other records, or this one, re-entrantly (`enforceDetachedCap`).
        const record = records.get(callerId);
        if (record) rejudge(record);
        return outcomeAfterChange();
      } catch {
        logLimited("poll-claim-not-applied", POLL_CLAIM_NOT_APPLIED);
        return changed ? outcomeAfterChange() : "refused";
      }
    },
    holding: () => (callerId === undefined ? [] : heldDocumentIds(callerId)),
  };
  return scope;
}

/**
 * **The inbox's one door into ownership** (#2358 scope PR; design §6.2,
 * §6.6, §6.8 as amended by the scope PR's brief). `mcp/awareness.ts` imports
 * this name and nothing else from this module, passes the tool caller it was
 * given along without reading it, and never reads the ownership flag:
 * `responseField` answers that for it.
 */
export const inboxOwnership = Object.freeze({
  /**
   * Whether `tandem_checkInbox` carries the `ownership` field. Read once at
   * the tool's registration; the handler keeps that answer for its own
   * backstop schema and for whether it emits the field, so a server never
   * answers outside the output schema it advertised.
   */
  responseField(): boolean {
    return ownershipEnabled();
  },
  /**
   * Begin a poll: the caller's scope over `openIds`, decided once, at `now`
   * (the poll's one clock reading, reused for acknowledgement, the pass and
   * the commit). Flag off: the unscoped answer, whoever the caller is.
   */
  begin(
    caller: { readonly ownerId?: string },
    openIds: Iterable<string>,
    now: number,
  ): InboxPollScope {
    if (!ownershipEnabled()) return UNSCOPED;
    return pollScope(caller.ownerId, openIds, now);
  },
});

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
 * Write a take's entry through `setDocOwner` and confirm it landed.
 * `setDocOwner` is total (it logs and swallows), so a failed write would
 * otherwise read as "taken". (A write's claim is applied by
 * `settleWriteClaim`, which must not throw.)
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
 * claim. A reader: an entry whose record is gone reads as nobody's and is
 * left as it is.
 */
export function otherHolderOf(
  documentId: string,
  callerId: string,
): { holder: HolderView | null } | null {
  const entry = readEntry(documentId);
  if (!entry || entry.ownerId === callerId) return null;
  return { holder: viewOf(entry.ownerId) };
}

/**
 * The ids of the documents `ownerId` holds. A reader: an entry whose record is
 * gone holds nothing (`readEntry`'s rule), so an id with no record is told it
 * holds nothing.
 */
export function heldDocumentIds(ownerId: string): string[] {
  const held: string[] = [];
  if (!records.has(ownerId)) return held;
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
  pendingClaims: number;
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
    pendingClaims: pendingClaims.size,
  };
}

/**
 * The steps of the ownership-change composite (ownership design §4.3), as a
 * test may watch them. `"handover"` is reported where the design puts step 1,
 * when the change is found to leave a record and BEFORE the entry is
 * written; the handover's work (`handOver`) runs after the entry, so this
 * step says a handover was decided, not that it has run.
 */
export type CompositeStep = "handover" | "loss" | "entry" | "notices" | "publish" | "wake";

/**
 * Watch the composite: `observer` is told each step `setDocOwner` reaches,
 * whether or not the step has a body yet. For "this call changed no
 * ownership" assertions that stay true once later PRs fill the steps in.
 */
export function setCompositeObserverForTests(
  observer: ((step: CompositeStep, documentId: string) => void) | undefined,
): void {
  compositeObserver = observer;
}

/**
 * Put a loss record on a document whatever its entry, which no production
 * path can do for an unowned one before PR 5's `released` (see `refusalFor`).
 */
export function setLossForTests(documentId: string, ownerId: string, cause: LossCause): void {
  lossByDoc.set(documentId, { ownerId, cause });
}

/** Write a document's handover mark, which in production only a handover writes. */
export function setHandoverSeqForTests(documentId: string, seq: number): void {
  handoverSeq.set(documentId, seq);
}

/**
 * Force one of a poll claim's commit-time checks to fail for a test (it is
 * ANDed with the real check, so it can never make a failing check pass).
 * The checks cannot fail while the commit stays synchronous except through
 * re-entrancy, which an ESM spy cannot reach. Undefined clears it.
 */
export function setInboxClaimCheckForTests(
  hook: ((check: InboxClaimCheck, documentId: string) => boolean) | undefined,
): void {
  claimCheckForTests = hook;
}

/** Replace the poll snapshot's scope read for a test (to make it throw); undefined restores it. */
export function setInboxScopeReadForTests(read: typeof inboxScopeOf | undefined): void {
  scopeReadForTests = read;
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
  pendingClaims.clear();
  compositeObserver = undefined;
  claimCheckForTests = undefined;
  scopeReadForTests = undefined;
  resetDocOpQueuesForTests();
  lastLogAt.clear();
  transportMode = undefined;
  transportView = () => [];
  presenceSource = () => false;
  waitingProbe = () => false;
  seqSource = () => 0;
  inboxHandover = () => {};
  graceMs = DEFAULT_GRACE_MS;
}
