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
 * claims and `holding`) and the stuck-write release in `inboxScopeOf`. The
 * notice-rule PR: the one reader of `handoverSeq` (`settledThrough` on a
 * poll's scope). The change-notice PR: change notices (step 3 of the
 * composite, and the tab close's notice), queued per record and drained by
 * a poll through `inboxOwnership` (`ownership.changed`). The chat owners
 * PR: per-message owners of user chat messages (ownership design §7.1, §7.2),
 * the inbox's chat scope, acknowledgement and claims through the same door,
 * the reply gate for a `tandem_reply` that names a message
 * (`inboxOwnership.replyGate`, design §7.3 rule 1), and the chat half of a
 * handover and of the tab close (design §6.5, §7.2). The posts PR: posts
 * through the same gate (design §7.3 rule 2), answered-once for chat (the
 * chat answerers), the handled rule without the global received-sweep
 * (`settles`, written by the chat side, and who wrote each reply row), the
 * boot's carried-over messages, and the switch that has a client
 * connection's changes to the chat map undone (`undoClientChatWrites`).
 * The delivery-rounds PR: whether delivery rounds are keyed by document and
 * by message (`keyedDeliveryRounds`, read through a seam by
 * `events/delivery-state.ts`; flag on keyed, flag off master's one global
 * round). Still to come, named by content as in the plan: the greeting by
 * bound transport (PR 3b-2).
 * **Nothing here answers a tool call**: the MCP tool
 * wrapper (`mcp/owned-op.ts`) asks these functions and builds the refusal, so
 * `/api`, autosave and the reload family never meet a check (ownership design §3.1).
 *
 * **Nearly a leaf.** It imports the flag, one helper from `sessions/context.ts`,
 * the operation queue, two names from `mcp/transport-registry.ts`, the
 * refusal copy (`ownership-refusal.ts`, which imports only types from here),
 * `crossBasename` from `src/shared` (dependency-free) and `node:crypto` — never the document registry or anything under `documents/`,
 * so every route and service that calls it keeps its module graph. Callers
 * pass document ids in, and the chat side is reached only through the
 * `setOwnershipChatSide` seam wired at boot: this module never reads the chat
 * map or writes a CTRL row.
 *
 * **Identity headers select, they do not prove** (ownership design §11.1).
 * Ownership coordinates Claude sessions; it is not a security boundary.
 */

import { randomInt } from "node:crypto";
import { crossBasename } from "../../shared/cross-basename.js";
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
import {
  chatReplyRefusal,
  type PostRefusalInput,
  type PostRefusalReason,
  postRefusal,
} from "./ownership-refusal.js";

/** How a record was identified (ownership design §2, §3.1). Server-derived. */
export type RecordKind = "tandem" | "claude" | "bridge" | "http" | "local";

/** What the badge may call a record (ownership design §10.3): a closed list. */
export type DisplayKind = "Tandem's Claude" | "terminal" | "Claude Desktop" | "other app";

/**
 * The cause words of `tandem_checkInbox`'s `ownership.changed` (the
 * change-notice PR, Requirement 7): a closed set, each a past-tense fact in
 * plain English that reads by itself. Their descriptions live in
 * `ownership-refusal.ts` (`CHANGE_CAUSE_FACTS`), a `Record` over this type,
 * and the output schema's enum is this list, so no word can be queued that
 * the schema does not list. A cause no production path makes today (Tandem's
 * Claude's gains and losses, its take-back, Release, Assign) is not here:
 * each joins with the PR that produces it. A chat post's claim joined with
 * the posts PR (R1.8). None equals an internal {@link OwnershipChangeCause}.
 */
export const CHANGE_CAUSES = [
  "your write claimed it",
  "a poll of yours claimed it",
  "a chat reply of yours claimed it",
  "a chat post of yours claimed it",
  "you opened or created it",
  "another session took it",
  "its tab was closed",
  "Tandem stopped counting this session as attached",
] as const;
export type ChangeCause = (typeof CHANGE_CAUSES)[number];

/** One queued change notice: `ownership.changed`'s three keys, and a closed document's name. */
export interface ChangeNotice {
  readonly documentId: string;
  readonly change: "gained" | "lost";
  readonly cause: ChangeCause;
  /**
   * A tab close's notice only: the document's file name at the close
   * (Requirement 8.3), for the summary. **Never part of a `changed` entry.**
   * Freed with the notice.
   */
  readonly closedName?: string;
}

/**
 * At most this many change notices per record; past it the oldest go.
 * `changed`'s description names the number (`output-schemas.ts` reads it).
 */
export const MAX_CHANGE_NOTICES = 100;

/** What can move a document (ownership design §4.1). */
export type OwnershipKind = "default" | "claimed" | "opened" | "assigned";

/**
 * Why an ownership entry changed. Later PRs add their causes. `claim` is a
 * write to an unowned document, applied once the write's outcome is known
 * (a refusal that never claims, §5.1, and a throw apply nothing, so there is
 * no cause for undoing one); `take` a `tandem_open` (ownership design §4.2);
 * `stale` an entry whose record was gone; `poll-claim` an inbox poll that
 * was handed items on an unowned document it may claim (the scope PR,
 * applied in the poll's synchronous commit, not at a turn in the queue);
 * `reply-claim` an accepted `tandem_reply` to a chat message on an unowned
 * document the caller may claim (the chat owners PR, applied in the reply's
 * one synchronous run, not at a turn in the queue: Bryan's decision of
 * 2026-11-11, "Chat replies always get through"); `post-claim` an accepted
 * chat post (a `tandem_reply` with no `replyTo`) that names an open, unowned
 * document the caller may claim (the posts PR, R1.2; applied in the post's
 * one synchronous run, an unqueued change like `reply-claim`).
 */
export type OwnershipChangeCause =
  | "user-open"
  | "lapse"
  | "take-back"
  | "claim"
  | "take"
  | "stale"
  | "poll-claim"
  | "reply-claim"
  | "post-claim";

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
  | "not-present"
  | "chat"
  | "post";

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
  /**
   * The record's change notices not yet drained, oldest first (the
   * change-notice PR). Shared by everything that polls as this record.
   * **Not counted by `recordHoldsState`** (Ruling 6): a lapse queues one for
   * the lapsing record, and counting it would keep a dead record alive. Goes
   * with the record, so a record created again under the same owner id
   * starts with none. At most {@link MAX_CHANGE_NOTICES}.
   */
  changeNotices?: ChangeNotice[];
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
 * that moment. Read only by the notice rule, through a poll's scope
 * (`InboxPollScope.settledThrough`). One entry per document that ever had a
 * handover, never pruned.
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

/** How a message's per-message owner was set (the chat owners PR, R3.3). */
export type MessageOwnerOrigin = "poll" | "reply" | "acknowledgement" | "close";

/** A user chat message's per-message owner (ownership design §7.1, §7.2). */
export interface MessageOwner {
  readonly ownerId: string;
  /** How it was set. Never rewritten: an owner keeps the origin it was set with (R3.3). */
  readonly origin: MessageOwnerOrigin;
  /** Origin `close` only: the document whose tab close set it (PR 5's Assign and Release read it, R3.4). */
  readonly closedDocumentId?: string;
}

/**
 * Per-message owners of user chat messages, keyed by the row's key in
 * CTRL_ROOM's chat map (a message's identity, R3.1's terms). **Server memory
 * only**: never on a row, never in the session file, lost at restart like
 * every map here (R3.2). At most one per chat row: an owner whose row is
 * deleted goes (`forgetChatMessageOwners`, R3.6), and an owner goes with its
 * record (`deleteRecord`, R3.5a). Written only by {@link setMessageOwner}, which
 * is a check-and-set: an existing owner and its origin are never overwritten.
 * Empty while ownership is off (every writer returns at the flag first).
 */
const ownerByMessage = new Map<string, MessageOwner>();

/**
 * Which chat messages each record was handed, by a poll of that record that
 * committed and returned (the chat owners PR, R5.2's Ruling 4 arm: "handed"
 * means returned by a poll). Read only by the reply gate's arm for an open,
 * unowned document the caller may not claim now. It survives a re-owe of the
 * message and goes with the record (`deleteRecord`, R3.5a) or with the row
 * (`forgetChatMessageOwners`), so it is bounded by records times chat rows.
 * Empty while ownership is off.
 */
const handedByRecord = new Map<string, Set<string>>();

/**
 * The boot's carried-over messages (the posts PR, R0.1): the user rows the
 * CTRL session's restore brought back that were `read` and not handled at
 * that moment. Taken once, by `captureCarriedOverChat` (flag on only), and
 * fixed for the run: nothing joins it later. A carried-over message is never
 * re-owed, never handed again and never given a per-message owner; a reply
 * naming one is accepted and sets no owner. Leaves only when its row is
 * deleted (`forgetChatMessageOwners`: Clear chat). Bounded by the restored
 * rows (at most the 200 the prune keeps). Empty while ownership is off.
 */
const carriedOver = new Set<string>();

/**
 * Who answered each user chat message (the posts PR, R2; ownership design
 * §5.5), keyed by the message's chat key. Kept apart from the thread
 * answerers (`answererByItem`), so `forgetThreadAnswerers` never reaches it.
 * Written only if unset: by an accepted final reply (its target) and by
 * `settles` (each message it adds). **Server memory only**: dropped with the
 * row (`forgetChatMessageOwners`) and at restart; kept when the answerer's
 * record is deleted (a refusal then names no holder), as thread answerers
 * are. At most one per chat row. Empty while ownership is off.
 */
const chatAnswerer = new Map<string, string>();

/**
 * Who wrote each accepted final reply row (the posts PR, R3.4): step 2 of
 * `settles` adds a confirmed hand-out's batch only to the confirming record's
 * own rows. Written for a final reply from a caller with a record (never a
 * post, an acknowledgement, a `/api/channel-reply` row or a local-model row,
 * which so settle only their target). Dropped with the row
 * (`forgetChatMessageOwners`) and with the record (`deleteRecord`), so a
 * record created again under the same owner id inherits none. Bounded by
 * chat rows. Empty while ownership is off.
 */
const replierByRow = new Map<string, string>();

/**
 * A lapsed record whose re-owe failed (R0.7 of the posts PR): how many retries
 * it has had, and the pending retry's timer. Kept apart from the grace, so a
 * retry is never armed through `armGrace` (which runs the detached cap, which
 * lapses records, which re-owe: a failure there used to recurse) and never
 * counts against the cap. The first {@link MAX_REOWE_RETRIES} come one grace
 * apart; after that they keep coming, {@link SLOW_REOWE_RETRY_FACTOR} graces
 * apart, for as long as the re-owe fails (an unbounded residual, in ADR-054:
 * stopping would leave the messages owed to nobody). Dropped on success,
 * when the record is attached again, and with the record.
 */
const reOweRetries = new Map<string, { count: number; timer?: ReturnType<typeof setTimeout> }>();

/** How many quick retries (one grace apart) a lapsed record's failed re-owe gets. */
export const MAX_REOWE_RETRIES = 3;
/** After the quick retries, each further retry waits this many graces. */
export const SLOW_REOWE_RETRY_FACTOR = 4;

/** Calls of `recordHoldsState`, for a test that counts a poll's work (R0.7, item 15). */
let recordHoldsStateCalls = 0;

/** What the ownership side needs to know about one user chat row. */
export interface ChatMessageFacts {
  /** The document the row names, if any. */
  readonly documentId?: string;
  /** Whether that document is open now. False for a row that names none. */
  readonly documentOpen: boolean;
  /** #1123 A2's local-period chat: no owner, never claimable (Ruling 9). */
  readonly localPeriod: boolean;
}

/**
 * The chat side, as the ownership side may use it (the chat owners PR, R2.2).
 * **This module never reads the chat map or writes a CTRL row**: everything it
 * needs from chat comes through these seven members (the seventh,
 * `owedToFreshReader`, is #2358 PR 3b-2b1b-chat's), which `src/server/index.ts`
 * wires once at boot (`setOwnershipChatSide`, pinned from source in
 * `tests/server/ownership-source-pins.test.ts`). Each is synchronous.
 */
export interface OwnershipChatSide {
  /**
   * The keys of the user chat messages that are **handled** now (the posts
   * PR, R3.2; design §5.5, §6.4): a real Claude final reply written by the
   * server names it in `replyTo` or lists it in `settles`. Rows with
   * `inProgress`, `superseded`, `agentIdentity` or `chatNotice` count for
   * nothing, and there is no received-sweep. One call reads every chat row
   * once.
   */
  handledKeys(): ReadonlySet<string>;
  /** The keys of the user messages on `documentId` that are not handled and not local-period chat. */
  messagesOn(documentId: string): readonly string[];
  /** The facts of the user row under `key`, or undefined when there is none (no row, or not a user row). */
  message(key: string): ChatMessageFacts | undefined;
  /**
   * The chat half of a handover (ownership design §6.5 steps 1 and 2): each of
   * `keys` that is a user row, not local-period chat and not handled has its
   * chat entry retired and is written `read: false` with no `delivered`, in
   * one server-origin transaction, and every live acknowledgement of it is
   * marked `superseded` in the same write (the posts PR, R3.3). It pushes
   * nothing and wakes nothing.
   */
  reOwe(keys: readonly string[]): void;
  /**
   * Step 1 of `settles` (the posts PR, R3.4), first half: the earlier
   * messages of the reply row's batch already marked received. Writes
   * nothing.
   */
  settleCandidates(rowKey: string): string[];
  /** Step 1, second half: add `keys` to the row's `settles`. Returns the keys added. */
  addSettles(rowKey: string, keys: readonly string[]): string[];
  /**
   * The keys of the user chat rows a fresh cursor reader would be handed if
   * it may have them (user rows, not handled, not local-period chat, not
   * read, admitted by the chat schema). Writes nothing, logs nothing.
   */
  owedToFreshReader(): readonly string[];
}

const NO_CHAT_SIDE: OwnershipChatSide = Object.freeze({
  handledKeys: () => new Set<string>(),
  messagesOn: () => [],
  message: () => undefined,
  reOwe: () => {},
  settleCandidates: () => [],
  addSettles: () => [],
  owedToFreshReader: () => [],
});

let transportMode: "http" | "stdio" | undefined;
let transportView: () => ReadonlyArray<TransportViewEntry> = () => [];
let presenceSource: () => boolean = () => false;
let waitingProbe: (documentId: string, ownerId: string) => boolean = () => false;
let seqSource: () => number = () => 0;
let inboxHandover: (documentId: string) => void = () => {};
let chatSide: OwnershipChatSide = NO_CHAT_SIDE;
let chatFaultForTests:
  | ((at: "re-owe" | "close" | "apply" | "commit" | "settles") => void)
  | undefined;
let wakeObserverForTests: ((cause: WakeCause) => void) | undefined;
let compositeObserver: ((step: CompositeStep, documentId: string) => void) | undefined;
let noticeFaultForTests: ((at: "change" | "close", documentId: string) => void) | undefined;
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

/** Presence seam (ownership design §8.1). Not present until PR 3b-2 wires the supervisor's
 * computed presence (PR 3b-1, `Supervisor.tandemPresence`) here. */
export function setTandemPresenceSource(source: () => boolean): void {
  presenceSource = source;
}

/** Whether Tandem's Claude is present. Always false while the flag is off. */
export function isTandemPresent(): boolean {
  if (!ownershipEnabled()) return false;
  return total("isTandemPresent", false, () => presenceSource() === true);
}

/**
 * "Waiting" seam (ownership design §8.5): step 5 of {@link setDocOwner} asks
 * it whether the document's new owner has work waiting. `src/server/index.ts`
 * wires the inbox's document half, `documentWaiting` (#2358 PR 3b-2b1b),
 * pinned from source in `tests/server/ownership-source-pins.test.ts`;
 * unwired it answers false. Asked only flag on, only when the new owner is
 * Tandem's Claude, the caller is not, and the cause is not `take-back`;
 * nothing in production reaches that yet (the default rule needs presence,
 * which nothing sets), and while `startOrWake` is a stub its answer starts
 * nothing. The chat half and the
 * forward to the supervisor are later PRs.
 */
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
 * The chat side (the chat owners PR, R2.2): how this module reads which
 * messages are handled, which messages are on a document and what a row says,
 * and how it re-owes a message, without importing the inbox. `src/server/index.ts`
 * wires `awareness.ts`'s `ownershipChatSide` at boot (pinned from source in
 * `tests/server/ownership-source-pins.test.ts`). Unwired it answers that
 * nothing is handled, nothing is on any document, no row exists and a re-owe
 * writes nothing, so no unit test would notice a server that forgot it.
 */
export function setOwnershipChatSide(side: OwnershipChatSide): void {
  chatSide = side;
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
 * a failure in the inbox half leaves it where it was (the notice rule, which
 * reads it, then errs toward a duplicate notice).
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
 * (ownership design §3.1 rules 1–3; rule 0's routing of a transport bound by PR 3a's
 * handle bind is PR 3b-2's).
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
 * §3.4). **The one place a later PR adds per-record state that a lapse must
 * move out.** The chat owners PR adds per-message owners, counted **only
 * while their message is not handled** (one predicate for held state, read
 * through the chat side's `handledKeys`: since the posts PR, a final reply's
 * `replyTo` or `settles`, never an acknowledgement): a handled message never
 * keeps a record alive and never re-arms a grace. A carried-over message
 * (R0.1) is never counted, judged from the boot's set. The cost is one read of the chat rows per call, and
 * only for a record that owns a message per message, so the detached cap's
 * ranking reads at most records times chat rows. Change notices are per-record state that
 * is NOT counted here and that a lapse does not move (Ruling 6 of the
 * change-notice PR): a record whose only state is queued notices is deleted,
 * and ranked under the detached cap, as one holding nothing is, and its
 * notices go with it. Loss records are per document (`lossByDoc`) and a
 * lapse moves none, so they are not counted here either. A detached record that holds
 * state always has a grace running, even after an earlier lapse, so whatever
 * it picked up since is returned in turn; a record that holds none is not
 * re-armed. It never decides whether a record is kept: a lapse moves the
 * state out, and a record with no registered transport is then deleted.
 * `tests/server/ownership-records.test.ts` pins `OwnerRecord`'s keys against
 * this, so a new field fails until someone decides whether it counts here.
 */
export function recordHoldsState(record: OwnerRecord): boolean {
  recordHoldsStateCalls++;
  for (const entry of ownerByDoc.values()) {
    if (entry.ownerId === record.ownerId) return true;
  }
  let handled: ReadonlySet<string> | undefined;
  for (const [key, owner] of ownerByMessage) {
    if (owner.ownerId !== record.ownerId || carriedOver.has(key)) continue;
    handled ??= handledKeysOrNone();
    // Only a live user row counts: an owner whose row is gone holds nothing,
    // even if a delete never reached `forgetChatMessageOwners` (R3.6).
    if (!handled.has(key) && rowStillOwed(key)) return true;
  }
  return false;
}

/**
 * The chat side's handled keys, or none when the read throws: a failed read
 * counts every owned message as unhandled, so a record is kept rather than
 * deleted with an unanswered message. Fixed log text.
 */
function handledKeysOrNone(): ReadonlySet<string> {
  try {
    return chatSide.handledKeys();
  } catch {
    logLimited("chat-handled-failed", CHAT_READ_FAILED);
    return new Set();
  }
}

/** Whether `key` is still a user row that is not local-period chat (a failed read counts it). */
function rowStillOwed(key: string): boolean {
  try {
    const facts = chatSide.message(key);
    return facts !== undefined && !facts.localPeriod;
  } catch {
    logLimited("chat-handled-failed", CHAT_READ_FAILED);
    return true;
  }
}

/** Fixed texts: nothing from the error, no record, no message and no document. */
const CHAT_READ_FAILED =
  "[ownership] reading which chat messages are answered failed; every message a session owns counts as unanswered";
const CHAT_REOWE_FAILED =
  "[ownership] a chat message's owner changed but it could not be marked unread again; the session that may answer it now may not be handed it until it changes again";
const CHAT_CLOSE_FAILED =
  "[ownership] a document's tab closed but its unanswered chat could not be given an owner; that chat follows the default rule";

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
    clearReOweRetry(record.ownerId);
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

/**
 * Delete a record, and what it owns per message (R3.5a): its per-message
 * owners (any still unhandled is re-owed; a lapse has already re-owed those,
 * so in practice only handled ones remain) and its "handed" memory, so no
 * owner id dangles and a record created again under the same owner id
 * inherits nothing.
 */
function deleteRecord(record: OwnerRecord): void {
  clearGrace(record);
  clearReOweRetry(record.ownerId);
  records.delete(record.ownerId);
  handedByRecord.delete(record.ownerId);
  for (const [rowKey, ownerId] of [...replierByRow]) {
    if (ownerId === record.ownerId) replierByRow.delete(rowKey);
  }
  releaseMessageOwners(record.ownerId, () => true);
}

/** Forget a record's pending re-owe retry and its count. */
function clearReOweRetry(ownerId: string): void {
  const retry = reOweRetries.get(ownerId);
  if (retry?.timer !== undefined) clearTimeout(retry.timer);
  reOweRetries.delete(ownerId);
}

/**
 * Drop `ownerId`'s per-message owners that `select` picks and re-owe them
 * (ownership design §6.5; the chat side re-owes only a message that is not
 * handled, so a handled one just loses its owner). The one owner-dropping
 * entry point: a lapse (unhandled only), a deleted record (all), and the
 * later triggers (PR 3b-2's end of presence, selecting origin
 * "acknowledgement"; PR 5's Release) call it. Never throws.
 */
function releaseMessageOwners(
  ownerId: string,
  select: (key: string, owner: MessageOwner) => boolean,
): void {
  const dropped: Array<[string, MessageOwner]> = [];
  for (const [key, owner] of [...ownerByMessage]) {
    if (owner.ownerId !== ownerId || !select(key, owner)) continue;
    dropped.push([key, owner]);
  }
  if (dropped.length === 0) return;
  // Re-owe first (review round 1, item 16): if the re-owe fails, the owners
  // stay, so a lapsed record keeps its unhandled messages (and so its grace,
  // which retries the lapse) instead of leaving a read message with no owner.
  // A deleted record's owners go whatever happens: nothing could arm it again.
  const reOwed = reOweChat(dropped.map(([key]) => key));
  const record = records.get(ownerId);
  if (!reOwed && record !== undefined) {
    // R0.7 (the posts PR): a lapsed record keeps its owners and gets a retry
    // of its own, never a grace. A grace would run the detached cap, which
    // can lapse another record early, or this one again, from inside a lapse
    // the cap itself caused; the retry runs neither, and is bounded.
    if (record.lapsed) scheduleReOweRetry(record);
    return;
  }
  if (record !== undefined) clearReOweRetry(ownerId);
  for (const [key] of dropped) {
    ownerByMessage.delete(key);
    messageOwnerChanged();
  }
}

const REOWE_RETRIES_SLOWED =
  "[ownership] a lapsed session's unanswered chat could not be marked unread again after several tries; Tandem keeps retrying, less often";

/**
 * Retry a lapsed record's failed re-owe after the grace's length, and after
 * {@link MAX_REOWE_RETRIES} tries at a slower pace, for as long as it fails
 * (R0.7). The timer is a deferral, never a grace: it is not counted by the
 * detached cap and arming it runs nothing, so arming it from inside a lapse
 * the cap caused lapses nobody early and cannot recurse. The retry re-checks that this is
 * still the same record, still lapsed and still detached, then releases its
 * unhandled messages again; a success clears the count and lets the record
 * go once it holds nothing. Outside any MCP request context, like a grace.
 */
function scheduleReOweRetry(record: OwnerRecord): void {
  const retry = reOweRetries.get(record.ownerId) ?? { count: 0 };
  if (retry.timer !== undefined) return;
  if (retry.count >= MAX_REOWE_RETRIES) logLimited("reowe-retries", REOWE_RETRIES_SLOWED);
  const delay = retry.count >= MAX_REOWE_RETRIES ? graceMs * SLOW_REOWE_RETRY_FACTOR : graceMs;
  retry.count += 1;
  const timer: ReturnType<typeof setTimeout> = runOutsideMcpContext(() =>
    setTimeout(() => {
      total("reoweRetry", undefined, () => {
        const pending = reOweRetries.get(record.ownerId);
        if (pending?.timer !== timer) return;
        pending.timer = undefined;
        if (records.get(record.ownerId) !== record || !record.lapsed) return;
        if (isAttached(record.ownerId)) return;
        const handled = handledKeysOrNone();
        releaseMessageOwners(record.ownerId, (key) => !handled.has(key));
        deleteIfGone(record);
      });
    }, delay),
  );
  timer.unref?.();
  retry.timer = timer;
  reOweRetries.set(record.ownerId, retry);
}

/** The chat side's re-owe, in its own catch (fixed log text). Returns whether it ran without throwing. */
function reOweChat(keys: readonly string[]): boolean {
  try {
    chatFaultForTests?.("re-owe");
    chatSide.reOwe(keys);
    return true;
  } catch {
    logLimited("chat-reowe-failed", CHAT_REOWE_FAILED);
    return false;
  }
}

/**
 * The step 5 seam for a change of a message's owner (R6.4, Ruling 13): the
 * same `startOrWake` a document's change reaches, a no-op until PR 3b-2.
 */
function messageOwnerChanged(): void {
  startOrWake("message-owner");
}

/**
 * Make `ownerId` the message's per-message owner, if it has none (R3.3): a
 * check-and-set with nothing between the check and the write; an existing
 * owner and its origin are never rewritten. Never for a caller with no
 * record. Returns whether it set one. A lapsed record whose message is not
 * handled has its grace armed again, as a claim does.
 */
function setMessageOwner(
  key: string,
  ownerId: string,
  origin: MessageOwnerOrigin,
  closedDocumentId?: string,
): boolean {
  // A carried-over message is never given an owner (the posts PR, R0.1).
  if (!ownershipEnabled() || ownerByMessage.has(key) || carriedOver.has(key)) return false;
  if (ownerId === TANDEM_OWNER_ID) ensureRecord(TANDEM_OWNER_ID, "tandem");
  const record = records.get(ownerId);
  if (!record) return false;
  ownerByMessage.set(key, {
    ownerId,
    origin,
    ...(closedDocumentId !== undefined ? { closedDocumentId } : {}),
  });
  messageOwnerChanged();
  if (record.lapsed) rejudge(record);
  return true;
}

/** Remember that `ownerId` was handed `keys` by a poll that returned. */
/** Remember that `ownerId` was handed `keys`; push onto `added` the ones it had not been handed before. */
function noteHanded(ownerId: string, keys: readonly string[], added: string[]): void {
  if (keys.length === 0 || !records.has(ownerId)) return;
  let set = handedByRecord.get(ownerId);
  if (!set) {
    set = new Set();
    handedByRecord.set(ownerId, set);
  }
  for (const key of keys) {
    if (set.has(key)) continue;
    set.add(key);
    added.push(key);
  }
}

/**
 * The chat side tells this module that chat rows were deleted (Clear chat,
 * or any other delete): their per-message owners and "handed" memory go
 * (R3.6), and (the posts PR) their chat answerers, their place in the
 * carried-over set, and, for a reply row, who wrote it. Wired at boot through
 * `chat-row-deletions.ts`, so neither `ctrl-chat.ts` nor `session/manager.ts`
 * imports this module. Nothing is re-owed: the message is gone. A delete by a
 * client connection that the server undoes never reaches here (R4.2), so the
 * row comes back with all of it. Never throws.
 */
export function forgetChatMessageOwners(keys: Iterable<string>): void {
  if (!ownershipEnabled()) return;
  total("forgetChatMessageOwners", undefined, () => {
    for (const key of keys) {
      ownerByMessage.delete(key);
      for (const set of handedByRecord.values()) set.delete(key);
      chatAnswerer.delete(key);
      carriedOver.delete(key);
      replierByRow.delete(key);
    }
  });
}

/**
 * Take the boot's carried-over set (the posts PR, R0.1): `restoreCtrlSession`
 * calls this once, right after the CTRL session's rows are restored, with a
 * thunk that lists the restored user rows that are `read` and not handled.
 * The thunk is called only with ownership on, so a dark boot takes no set and
 * scans nothing. The set replaces any earlier one and is fixed for the run.
 * Never throws: a failed capture leaves the set empty (the chat owners PR's
 * behaviour for those rows) and is logged.
 */
export function captureCarriedOverChat(candidates: () => readonly string[]): void {
  if (!ownershipEnabled()) return;
  total("captureCarriedOverChat", undefined, () => {
    carriedOver.clear();
    for (const key of candidates()) carriedOver.add(key);
  });
}

/**
 * Whether a client connection's changes to the CTRL chat map are undone (the
 * posts PR, R4.5): with ownership on, yes. `src/server/index.ts` wires it into
 * `chat-client-writes.ts`, so `ctrl-chat.ts` learns it without importing the
 * flag.
 */
export function undoClientChatWrites(): boolean {
  return ownershipEnabled();
}

/**
 * Whether delivery rounds are keyed by document and by message (the
 * delivery-rounds PR; design §6.7): with ownership on, yes. `src/server/index.ts`
 * wires it into `events/delivery-state.ts`'s round seam, so `events/` learns
 * it without importing the flag.
 */
export function keyedDeliveryRounds(): boolean {
  return ownershipEnabled();
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
 * goes to the default rule. Each message it owns per message that is not
 * handled loses that owner and is re-owed (R6.2); a handled one stays with
 * the record until the record is deleted. Its change
 * notices are not moved: each move queues a `lost` notice for it, read only
 * if its record survives (a transport still registered); a record deleted
 * once its documents move takes its notices with it. A lapse records no
 * blocking loss. A
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
  const handled = ownerByMessage.size > 0 ? handledKeysOrNone() : new Set<string>();
  // A carried-over message never has an owner; judged from the boot's set
  // all the same, never from owner state (R0.1).
  releaseMessageOwners(record.ownerId, (key) => !handled.has(key) && !carriedOver.has(key));
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
 * change that fails before its entry hands nothing over. Step 3 queues change
 * notices (the change-notice PR): a `gained` for the record that holds the
 * document afterwards and a `lost` for the one that held it before, each
 * only if that record exists now, is not Tandem's Claude and the cause has a
 * word (`changeCauseOf`); nothing when the holder stays the same record. It
 * has its own catch, so a throw there loses the notice (the change stands
 * and `holding` stays right) and steps 4 and 5 still run. Step 4 (publishing
 * owner fields through `broadcastOpenDocs`) is PR 5's.
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
    // The chat half of the handover (ownership design §6.5, R6.1): the
    // unanswered chat that follows this document is owed again. Its own
    // catch: the change above stands and the steps below still run.
    if (leavesRecord) reOweDocumentChat(documentId);
    // Step 3, change notices. Its own catch: the change above stands.
    compositeObserver?.("notices", documentId);
    if (previousId !== next?.ownerId) {
      queueChangeNotices(documentId, previousId, next?.ownerId, cause);
    }
    // Step 4, publishing (PR 5): no body yet.
    compositeObserver?.("publish", documentId);
    // Step 5 (ownership design §4.4). Frames for a non-tandem owner are PR 3b-2's.
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
 * The chat half of a handover of `documentId` (R6.1): each unanswered,
 * non-local-period message on it that has no per-message owner follows the
 * document, so it is re-owed. Never the old owner's doc-less chat, and never
 * a message with a per-message owner. Never throws.
 */
function reOweDocumentChat(documentId: string): void {
  try {
    chatFaultForTests?.("re-owe");
    const keys = chatSide
      .messagesOn(documentId)
      .filter((key) => !ownerByMessage.has(key) && !carriedOver.has(key));
    if (keys.length > 0) chatSide.reOwe(keys);
  } catch {
    logLimited("chat-reowe-failed", CHAT_REOWE_FAILED);
  }
}

/** What reaches step 5: a document's change, or a change of a message's owner (R6.4). */
export type WakeCause = OwnershipChangeCause | "message-owner";

/**
 * Start or wake Tandem's Claude for returning work (ownership design §8.4).
 * **A no-op until PR 3b-2**, whose body must refuse through `aiRefusal()` before
 * it writes to the child (ownership design §11.5, Critical Rule 9). A test may
 * watch it (`setWakeObserverForTests`).
 */
export function startOrWake(cause: WakeCause): void {
  wakeObserverForTests?.(cause);
}

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
export function onDocumentClosed(documentId: string, filePath?: string): void {
  if (!ownershipEnabled()) return;
  total("onDocumentClosed", undefined, () => {
    const heldBy = ownerByDoc.get(documentId)?.ownerId;
    const held = heldBy !== undefined;
    ownerByDoc.delete(documentId);
    lossByDoc.delete(documentId);
    for (const pending of [...pendingClaims]) {
      if (pending.documentId === documentId) pendingClaims.delete(pending);
    }
    if (held) handOver(documentId);
    // The close's change notice (the change-notice PR, Ruling 8): after the
    // handover and in its own catch, so it can never skip the handover. It
    // carries the file name the document had, for the summary; the basename
    // is computed here, flag on only.
    if (held) queueCloseNotice(documentId, heldBy, filePath);
    // The close's chat half (R6.3), after the handover and in its own catch,
    // so it can never skip the handover. It is given the holder read above,
    // before the entry was deleted.
    assignClosedDocumentChat(documentId, heldBy);
  });
}

/**
 * The tab close's chat half (R6.3, Ruling 6; design §6.3 "a tab close runs
 * steps 1 to 3", §7.2): it re-owes nothing. Each unanswered, non-local-period
 * message on the document that has **no per-message owner** gets one, origin
 * "close": the holder at the close if its record exists and has not lapsed;
 * if the document was unowned, Tandem's Claude while present; otherwise
 * nobody (a lapsed holder's messages are then owned as closed-document
 * messages are, so none is left with a record nothing will arm or delete).
 * An existing per-message owner is never overwritten. Never throws.
 */
function assignClosedDocumentChat(documentId: string, heldBy: string | undefined): void {
  try {
    chatFaultForTests?.("close");
    let to: string | undefined;
    if (heldBy !== undefined) {
      const record = records.get(heldBy);
      if (record && !record.lapsed) to = heldBy;
    } else if (isTandemPresent()) {
      to = TANDEM_OWNER_ID;
    }
    if (to === undefined) {
      // A holder that lapsed (its move deferred behind a busy queue) or whose
      // record is gone: the chat that followed the document leaves that
      // record here, and the deferred move never runs once the entry is gone,
      // so this is the message's change of owner away from a record (R6.1).
      // Re-owe it, or a message the holder had read would be owed to nobody.
      if (heldBy !== undefined) {
        const keys = chatSide
          .messagesOn(documentId)
          .filter((key) => !ownerByMessage.has(key) && !carriedOver.has(key));
        if (keys.length > 0) chatSide.reOwe(keys);
      }
      return;
    }
    // A carried-over message gets no owner (`setMessageOwner` refuses it, R0.1).
    for (const key of chatSide.messagesOn(documentId)) {
      setMessageOwner(key, to, "close", documentId);
    }
  } catch {
    logLimited("chat-close-failed", CHAT_CLOSE_FAILED);
  }
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
 * The cause word an ownership change gives the record it reaches, or
 * undefined when it gives none: a cause no production path makes today
 * (`user-open`, `take-back`), the clearing of a stale entry (its record is
 * gone), or a combination no path makes (a claim never moves a document away
 * from an existing record). Undefined queues nothing, so no word outside the
 * schema can be queued.
 */
function changeCauseOf(
  cause: OwnershipChangeCause,
  change: "gained" | "lost",
): ChangeCause | undefined {
  if (change === "gained") {
    if (cause === "claim") return "your write claimed it";
    if (cause === "poll-claim") return "a poll of yours claimed it";
    if (cause === "reply-claim") return "a chat reply of yours claimed it";
    if (cause === "post-claim") return "a chat post of yours claimed it";
    if (cause === "take") return "you opened or created it";
    return undefined;
  }
  if (cause === "take") return "another session took it";
  if (cause === "lapse") return "Tandem stopped counting this session as attached";
  return undefined;
}

/** Fixed text: nothing from the error, no record and no document. */
const NOTICES_FAILED =
  "[ownership] a document changed hands but its change notice could not be queued; the change stands";

/** The record a notice may reach: one that exists and is not Tandem's Claude (PR 3b-2's). */
function noticeRecord(ownerId: string | undefined): OwnerRecord | undefined {
  const record = ownerId === undefined ? undefined : records.get(ownerId);
  return record && record.recordKind !== "tandem" ? record : undefined;
}

/** Append a notice to a record's queue, dropping the oldest past the cap. */
function pushNotice(record: OwnerRecord, notice: ChangeNotice): void {
  const queue = record.changeNotices ?? [];
  queue.push(notice);
  if (queue.length > MAX_CHANGE_NOTICES) queue.splice(0, queue.length - MAX_CHANGE_NOTICES);
  record.changeNotices = queue;
}

/** Step 3 of the composite (see `setDocOwner`). Never throws. */
function queueChangeNotices(
  documentId: string,
  previousId: string | undefined,
  nextId: string | undefined,
  cause: OwnershipChangeCause,
): void {
  try {
    noticeFaultForTests?.("change", documentId);
    for (const [ownerId, change] of [
      [previousId, "lost"],
      [nextId, "gained"],
    ] as const) {
      const record = noticeRecord(ownerId);
      const word = changeCauseOf(cause, change);
      if (record && word !== undefined) pushNotice(record, { documentId, change, cause: word });
    }
  } catch {
    logLimited("notices-failed", NOTICES_FAILED);
  }
}

/** The tab close's notice for the record that held the document. Never throws. */
function queueCloseNotice(documentId: string, heldBy: string, filePath: string | undefined): void {
  try {
    noticeFaultForTests?.("close", documentId);
    const record = noticeRecord(heldBy);
    if (!record) return;
    const name = filePath === undefined ? "" : crossBasename(filePath);
    pushNotice(record, {
      documentId,
      change: "lost",
      cause: "its tab was closed",
      ...(name !== "" ? { closedName: name } : {}),
    });
  } catch {
    logLimited("notices-failed", NOTICES_FAILED);
  }
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
 * registry): pass open documents only. A chat message that follows an open
 * document reads its answer here too (the chat owners PR, {@link messageStanding}).
 */
export function inboxScopeOf(
  documentId: string,
  callerId: string | undefined,
  now: number = performance.now(),
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
 * Who owns a user chat message now (R3.1; ownership design §7.1), in order:
 * local-period chat has no owner and is never claimable; a per-message owner
 * wins, even on a document open again; a message on an open document follows
 * its holder, or is claimable with the document when it is unowned; a
 * doc-less message, or one on a closed document, is Tandem's Claude's while
 * it is present, otherwise claimable per message. **Pure.** `documentScope`
 * answers an open document's {@link InboxDocumentScope} for the caller (a
 * poll's snapshot, or a live read for a reply), `"closed"` when it is not open.
 */
type MessageStanding =
  | { readonly kind: "none" }
  | { readonly kind: "owned"; readonly ownerId: string; readonly perMessage: boolean }
  | { readonly kind: "with-document"; readonly documentId: string }
  | { readonly kind: "per-message" };

function messageStanding(key: string, facts: ChatMessageFacts): MessageStanding {
  if (facts.localPeriod) return { kind: "none" };
  const own = ownerByMessage.get(key);
  if (own && records.has(own.ownerId)) {
    return { kind: "owned", ownerId: own.ownerId, perMessage: true };
  }
  if (facts.documentId !== undefined && facts.documentOpen) {
    const entry = readEntry(facts.documentId);
    if (entry) return { kind: "owned", ownerId: entry.ownerId, perMessage: false };
    return { kind: "with-document", documentId: facts.documentId };
  }
  if (isTandemPresent()) return { kind: "owned", ownerId: TANDEM_OWNER_ID, perMessage: false };
  return { kind: "per-message" };
}

/** Whether `callerId` may take a message that is claimable per message: a record, and not a Tandem's Claude that is not present. */
function mayTakePerMessage(callerId: string | undefined): callerId is string {
  if (callerId === undefined) return false;
  if (callerId === TANDEM_OWNER_ID) return isTandemPresent();
  return records.has(callerId);
}

/**
 * What a poll may do with one chat message (R4.1): `"owns"` — the caller owns
 * it; `"take"` — it is claimable per message and the caller may take it (the
 * poll's commit makes the caller its owner, R3.3); `"claim"` — it follows an
 * open, unowned document the caller may claim now (the commit claims the
 * document, R4.3); `"neither"` — it is not handed. While ownership is off
 * every message reads `"owns"`, which filters nothing.
 */
export type InboxChatScope = "owns" | "take" | "claim" | "neither";

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
   * still exists, unless the caller is Tandem's Claude (`tandem`), which
   * needs none (the ownership change creates it); and the scope rule, with the poll's own clock reading, still
   * answers `"may-claim"`. `sinceSeq` is the registry counter before this
   * poll's pass over the document. Never throws. Answers `"held"` when the
   * caller holds the document afterwards; `"refused"` when a check refused it
   * and nothing changed; `"changed"` when `setDocOwner` was called but the
   * caller does not hold the document after it (a re-entrant lapse moved it
   * on): its handover may already have re-owed the document's items, which
   * the caller must not undo. `setDocOwner` is total, so one that failed
   * before writing the entry also reads `"changed"`; the inbox then keeps
   * this poll's cursor-less ledger keys (a missed undo, never a loss of an
   * entry). Judged unreachable: with `sinceSeq` given, nothing before the
   * entry write can throw.
   */
  claim(documentId: string, sinceSeq: number, stillOpen: boolean): InboxClaimOutcome;
  /** The documents the caller holds right now (empty for no record). */
  holding(): string[];
  /**
   * The chat owners PR (R4.1): what this poll may do with the user chat
   * message under `key`, which names `documentId` (undefined when it names
   * none). An open document's answer is the snapshot's; per-message owners
   * and Tandem's Claude's presence are read live. A caller with no record is
   * handed nothing (R4.6). Local-period chat is skipped by the collectors
   * before they ask.
   */
  chatScopeOf(key: string, documentId: string | undefined): InboxChatScope;
  /**
   * The chat half of a poll's commit (R3.3, R4.4), after the response
   * validated and its claims were applied: `taken` (messages of scope
   * `"take"` it handed) each get the caller as per-message owner, origin
   * "poll", if they still have none; every key in `handed` is remembered as
   * handed to the caller (Ruling 4's arm). Nothing for a caller with no
   * record. Never throws.
   */
  commitChat(taken: readonly string[], handed: readonly string[], out: InboxChatCommit): void;
  /**
   * Undo `commitChat` for a poll that threw after its chat commit: each
   * owner it recorded in `out.owners` goes if this caller still holds it
   * with origin "poll", and each key it added to the caller's "handed"
   * memory (`out.handed`, only those an earlier poll had not already
   * handed) leaves it again (the response never returned). Never throws.
   */
  dropChatOwners(out: InboxChatCommit): void;
  /**
   * Step 2 of `settles` (the posts PR, R3.4, R3.8), called by a cursor poll
   * the moment its acknowledgement confirmed a chat hand-out: `settle` is
   * given this caller's own final reply rows and the scope test ("owned by
   * the caller now"), writes what it adds, and returns the added keys, each
   * of which takes the caller as its answerer if it has none. Nothing for a
   * caller with no record. Never throws.
   */
  settleHandOut(
    settle: (rows: readonly string[], owns: (key: string) => boolean) => readonly string[],
  ): void;
  /**
   * The notice rule (ownership design §6.3 step 2, as the notice-rule PR's
   * brief rules): the document's handover mark, read live, or 0 when no
   * handover has run on it this server run. A notice whose registry entry is
   * at or below it was handed to a holder the document has since left, and is
   * handed to nobody again (`awareness.ts`, `settleNotices`). **The one
   * reader of `handoverSeq`.** 0 while ownership is off.
   */
  settledThrough(documentId: string): number;
  /**
   * The caller's change notices not yet drained, oldest first, as copies
   * (the change-notice PR). Changes nothing. Empty for a caller with no
   * record, and while ownership is off.
   */
  changes(): readonly ChangeNotice[];
  /**
   * **The drain point**: remove the caller's whole queue and return it, in
   * one swap (a throw cannot half-drain it). A poll calls it once, after its
   * claims, and reads `holding` right after, with no ownership change
   * between (Requirement 3.2). Empty for a caller with no record.
   */
  drainChanges(): InboxChangeBatch;
  /**
   * Put a drained batch back, for a poll that threw after its drain point
   * (Requirement 4.2): before every notice queued since, in its order, then
   * the cap (oldest dropped). Nothing if the record the batch came from is
   * gone or was created again (a new record never inherits). Never throws.
   */
  giveBack(batch: InboxChangeBatch): void;
}

/** What a poll's `commitChat` changed, filled as it goes so a throw part-way still reports it. */
export interface InboxChatCommit {
  /** Keys whose per-message owner this poll set. */
  readonly owners: string[];
  /** Keys this poll added to the caller's "handed" memory. */
  readonly handed: string[];
}

/** What a poll drained (`InboxPollScope.drainChanges`). */
export interface InboxChangeBatch {
  readonly notices: readonly ChangeNotice[];
}

/** What applying a poll's claim came to (`InboxPollScope.claim`). */
export type InboxClaimOutcome = "held" | "refused" | "changed";

/** The poll scope while ownership is off: read everything, claim nothing. */
const UNSCOPED: InboxPollScope = Object.freeze({
  scoped: false,
  scopeOf: (): InboxDocumentScope => "holds",
  claim: (): InboxClaimOutcome => "refused",
  holding: () => [],
  chatScopeOf: (): InboxChatScope => "owns",
  commitChat: () => {},
  dropChatOwners: () => {},
  settleHandOut: () => {},
  settledThrough: () => 0,
  changes: () => [],
  drainChanges: () => ({ notices: [] }),
  giveBack: () => {},
});

/** Which record each drained batch came from, so a give-back reaches only that record. */
const drainedFrom = new WeakMap<InboxChangeBatch, OwnerRecord>();

/** One of the poll claim's commit-time checks, for {@link setInboxClaimCheckForTests}. */
export type InboxClaimCheck = "claimable" | "open" | "unowned" | "record" | "scope";

let claimCheckForTests: ((check: InboxClaimCheck, documentId: string) => boolean) | undefined;

let scopeReadForTests: typeof inboxScopeOf | undefined;

const POLL_CLAIM_NOT_APPLIED =
  "[ownership] an inbox poll's claim of a document could not be applied; the document stays unowned";

function pollScope(callerId: string | undefined, openIds: Iterable<string>, now: number) {
  const snapshot = new Map<string, InboxDocumentScope>();
  for (const documentId of openIds) {
    try {
      snapshot.set(documentId, (scopeReadForTests ?? inboxScopeOf)(documentId, callerId, now));
    } catch (err) {
      // Every failure, with the document id and the error's class (never
      // its message, never an owner id): the summary tells the model the
      // error is in Tandem's log.
      console.error(
        `[ownership] an inbox scope read failed for document ${documentId} (${err instanceof Error ? err.name : typeof err}); the document was not read this poll`,
      );
      snapshot.set(documentId, "unread");
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
          // Tandem's Claude needs no record to claim (`standingOf`; the
          // ownership change creates it), every other caller does. With
          // "unowned" this is defence in depth the brief asks for: for any
          // caller but Tandem's Claude, `standingOf` below refuses a missing
          // record and the scope re-check refuses another holder anyway, so no
          // test can tell either check from `true` (a mutation run shows it).
          passes(
            "record",
            documentId,
            () => callerId === TANDEM_OWNER_ID || records.has(callerId),
          ) &&
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
    chatScopeOf: (key, documentId) => {
      if (callerId === undefined || (callerId !== TANDEM_OWNER_ID && !records.has(callerId))) {
        return "neither";
      }
      // A carried-over message is never handed again (the posts PR, R0.1).
      if (carriedOver.has(key)) return "neither";
      const open = documentId !== undefined ? snapshot.get(documentId) : undefined;
      const standing = messageStanding(key, {
        documentId,
        documentOpen: open !== undefined,
        localPeriod: false,
      });
      // R4.1: chat that follows a document whose scope read threw for this
      // poll is not handed by it (a per-message owner's message still is).
      if (open === "unread" && !(standing.kind === "owned" && standing.perMessage)) {
        return "neither";
      }
      switch (standing.kind) {
        case "none":
          return "neither";
        case "owned":
          return standing.ownerId === callerId ? "owns" : "neither";
        case "with-document":
          // The snapshot's answer (decided once, at the poll's start): an
          // unowned document the caller may not claim now (busy within the
          // bound, a blocking loss) or whose read threw hands nothing (R4.2).
          return open === "may-claim" ? "claim" : "neither";
        case "per-message":
          return mayTakePerMessage(callerId) ? "take" : "neither";
      }
    },
    commitChat: (taken, handed, out) => {
      if (callerId === undefined) return;
      total("commitChat", undefined, () => {
        chatFaultForTests?.("commit");
        for (const key of taken) if (setMessageOwner(key, callerId, "poll")) out.owners.push(key);
        noteHanded(callerId, handed, out.handed);
      });
    },
    dropChatOwners: (out) => {
      if (callerId === undefined) return;
      total("dropChatOwners", undefined, () => {
        const memory = handedByRecord.get(callerId);
        for (const key of out.handed) memory?.delete(key);
        for (const key of out.owners) {
          const owner = ownerByMessage.get(key);
          if (owner?.ownerId !== callerId || owner.origin !== "poll") continue;
          ownerByMessage.delete(key);
          messageOwnerChanged();
        }
      });
    },
    settleHandOut: (settle) => {
      if (callerId === undefined || !records.has(callerId)) return;
      total("settleHandOut", undefined, () => {
        const rows: string[] = [];
        for (const [rowKey, ownerId] of replierByRow) if (ownerId === callerId) rows.push(rowKey);
        if (rows.length === 0) return;
        for (const key of settle(rows, (key) => ownsMessage(key, callerId))) {
          setChatAnswerer(key, callerId);
        }
      });
    },
    settledThrough: (documentId) => handoverSeq.get(documentId) ?? 0,
    changes: () =>
      (callerId === undefined ? undefined : records.get(callerId))?.changeNotices?.map((n) => ({
        ...n,
      })) ?? [],
    drainChanges: () => {
      const record = callerId === undefined ? undefined : records.get(callerId);
      const batch: InboxChangeBatch = { notices: record?.changeNotices ?? [] };
      if (record) {
        record.changeNotices = undefined;
        drainedFrom.set(batch, record);
      }
      return batch;
    },
    giveBack: (batch) => {
      try {
        const record = drainedFrom.get(batch);
        if (!record || records.get(record.ownerId) !== record || batch.notices.length === 0) {
          return;
        }
        const queue = [...batch.notices, ...(record.changeNotices ?? [])];
        if (queue.length > MAX_CHANGE_NOTICES) queue.splice(0, queue.length - MAX_CHANGE_NOTICES);
        record.changeNotices = queue;
      } catch {
        logLimited("notices-failed", NOTICES_FAILED);
      }
    },
  };
  return scope;
}

/**
 * What `tandem_reply`'s ownership gate decided (the chat owners PR, R5;
 * the posts PR, R1; ownership design §7.3). `legacy`: run master's path
 * unchanged (ownership off only). `refused`: the error to return, with
 * nothing written; `stage` says whether the arguments decided it (answered
 * before the licence) or ownership did (answered after it). `accepted`:
 * stamp the row with `documentId` (a reply's message's document or none; a
 * post's, R1.2 and R1.3), then call `apply` with the appended row's key once
 * the append has landed, in the same synchronous run.
 */
export type ReplyGate =
  | { readonly kind: "legacy" }
  | {
      readonly kind: "refused";
      readonly stage: "arguments" | "ownership";
      readonly code: "INVALID_ARGUMENT" | "NOT_DOC_OWNER" | "INTERNAL_ERROR";
      readonly message: string;
      readonly details?: Record<string, unknown>;
    }
  | {
      readonly kind: "accepted";
      readonly documentId: string | undefined;
      apply(rowKey: string): void;
    };

/**
 * What the gate needs to know about documents for a post (the posts PR,
 * R1.2, R1.3), read from the document registry by the caller, since this
 * module never imports it. Called only with ownership on.
 */
export interface ReplyGateDocuments {
  /** Whether `documentId` is open now. */
  isOpen(documentId: string): boolean;
  /** The active document's id, or undefined. */
  activeDocumentId(): string | undefined;
}

const LEGACY_REPLY: ReplyGate = Object.freeze({ kind: "legacy" });

/** The argument refusal (R5.2 step 1): no document id, no message text. */
export const REPLY_DOCUMENT_MISMATCH =
  "Nothing was sent: the documentId you passed is not the document of the chat message that replyTo names. Omit documentId when you reply to a chat message; the reply is filed with that message's own document.";

/** A caller with a record-less identity (R5.4): a wiring fault, or a record deleted while the call ran. */
export const REPLY_NO_RECORD =
  "tandem_reply refused: Tandem has no record for this session, so it cannot answer a chat message now. Nothing was sent. This is a fault in Tandem, not something to retry with different arguments.";

/** The same for a post (the posts PR, R1.4): true for a post, which answers no message. */
export const POST_NO_RECORD =
  "tandem_reply refused: Tandem has no record for this session, so it cannot post to chat now. Nothing was sent. This is a fault in Tandem, not something to retry with different arguments.";

const REPLY_NO_OWNER =
  "tandem_reply refused: this request carries no owner identity. This is a Tandem wiring fault, not something to retry with different arguments.";

function chatRefused(
  reason: "chat" | "not-present" | "answered",
  holder: HolderView | null,
  facts: ChatMessageFacts,
  why: "holder" | "busy" | "lost" | "local" | "not-present" | "answered",
): ReplyGate {
  const { message, details } = chatReplyRefusal({
    reason,
    holder,
    why,
    ...(facts.documentId !== undefined ? { documentId: facts.documentId } : {}),
  });
  return { kind: "refused", stage: "ownership", code: "NOT_DOC_OWNER", message, details };
}

function postRefused(
  reason: PostRefusalReason,
  holder: HolderView | null,
  documentId: string | undefined,
  extra: Omit<PostRefusalInput, "reason" | "holder" | "documentId"> = {},
): ReplyGate {
  const { message, details } = postRefusal({
    reason,
    holder,
    ...(documentId !== undefined ? { documentId } : {}),
    ...extra,
  });
  return { kind: "refused", stage: "ownership", code: "NOT_DOC_OWNER", message, details };
}

const noOwnerIdentity = (): ReplyGate => ({
  kind: "refused",
  stage: "ownership",
  code: "INTERNAL_ERROR",
  message: REPLY_NO_OWNER,
});

/** Make `ownerId` the message's chat answerer, if it has none (R2.1). */
function setChatAnswerer(key: string, ownerId: string): void {
  if (!ownershipEnabled() || chatAnswerer.has(key)) return;
  chatAnswerer.set(key, ownerId);
}

/**
 * Whether `callerId` owns the message under `key` right now (the posts PR,
 * R3.4's "in the replier's scope"): its per-message owner, the holder of its
 * open document, or Tandem's Claude while present for a doc-less one. A
 * carried-over message, or one whose row is gone, is nobody's.
 */
function ownsMessage(key: string, callerId: string): boolean {
  if (carriedOver.has(key)) return false;
  const facts = chatSide.message(key);
  if (facts === undefined) return false;
  const standing = messageStanding(key, facts);
  return standing.kind === "owned" && standing.ownerId === callerId;
}

/**
 * The reply gate (R5.2), decided **without writing anything**. The caller
 * returns a refusal before any write, and for an acceptance appends the row
 * and then calls `apply` with no `await` between (R5.1): Bryan's decision of
 * 2026-11-11 ("Chat replies always get through"): a reply never joins the
 * document operation queue. A `tandem_reply` without `replyTo`, or whose
 * `replyTo` names no user message, is a post ({@link postGate}).
 */
function replyGate(
  callerId: string | undefined,
  request: { replyTo?: string; inProgress?: boolean; documentId?: string },
  docs: ReplyGateDocuments,
): ReplyGate {
  const key = request.replyTo;
  const facts = key === undefined ? undefined : chatSide.message(key);
  // A `replyTo` that names no user message is judged as a post (Ruling
  // (reviewing session)); the handler keeps its warning.
  if (key === undefined || facts === undefined) {
    return postGate(callerId, request.documentId || undefined, docs, key !== undefined);
  }
  // 1. The arguments: an explicit documentId that is not the message's (any
  //    one, for a doc-less message).
  const explicit = request.documentId || undefined;
  if (explicit !== undefined && explicit !== facts.documentId) {
    return {
      kind: "refused",
      stage: "arguments",
      code: "INVALID_ARGUMENT",
      message: REPLY_DOCUMENT_MISMATCH,
    };
  }
  // 2. The licence is the handler's (the append is its admission point).
  // 4. Local-period chat: nobody's, never claimable (Ruling 9).
  if (facts.localPeriod) return chatRefused("chat", null, facts, "local");
  // 5. A caller that may not reply, whatever it owns.
  if (callerId === undefined) return noOwnerIdentity();
  if (callerId === TANDEM_OWNER_ID) {
    if (!isTandemPresent()) return chatRefused("not-present", null, facts, "not-present");
  } else if (!records.has(callerId)) {
    return {
      kind: "refused",
      stage: "ownership",
      code: "INTERNAL_ERROR",
      message: REPLY_NO_RECORD,
    };
  }
  const acknowledging = request.inProgress === true;
  const origin: MessageOwnerOrigin = acknowledging ? "acknowledgement" : "reply";
  // 7. Answered once (the posts PR, R2.2, R2.3; design §5.5), checked after
  //    the owner: a final reply, or an acknowledgement, to a message another
  //    record already answered.
  const answeredBy = (): ReplyGate | undefined => {
    const answerer = chatAnswerer.get(key);
    if (answerer === undefined || answerer === callerId) return undefined;
    return chatRefused("answered", viewOf(answerer), facts, "answered");
  };
  const accept = (effect: () => void): ReplyGate =>
    answeredBy() ?? {
      kind: "accepted",
      documentId: facts.documentId,
      apply: (rowKey) =>
        total("replyApply", undefined, () => {
          chatFaultForTests?.("apply");
          // A final reply (never an acknowledgement, R2.3): step 1 of
          // `settles` takes the batch's received earlier messages the caller
          // owns at the reply's acceptance, judged BEFORE this reply's own
          // claim or owner write, so a claim never brings into scope a message
          // only another session received (R3.4). Only computed here: the
          // claim or owner, the answerer and the row's writer are recorded
          // first, and the `settles` write runs in its own guard after them,
          // so a failed write cannot skip them (review round 1, item 12).
          const batch = acknowledging
            ? []
            : chatSide.settleCandidates(rowKey).filter((k) => ownsMessage(k, callerId));
          effect();
          if (acknowledging) return;
          // The caller answers the message if nobody has, and is remembered
          // as the row's writer (step 2).
          setChatAnswerer(key, callerId);
          if (records.has(callerId)) replierByRow.set(rowKey, callerId);
          if (batch.length === 0) return;
          total("replySettles", undefined, () => {
            chatFaultForTests?.("settles");
            // Each added message takes the caller as its answerer if it has none.
            for (const k of chatSide.addSettles(rowKey, batch)) setChatAnswerer(k, callerId);
          });
        }),
    };
  // 6. The owner. A carried-over message first (R0.1): it has none and gets
  //    none; any caller that may reply may take it up, and nothing is claimed.
  if (carriedOver.has(key)) return accept(() => {});
  const standing = messageStanding(key, facts);
  switch (standing.kind) {
    case "none":
      return chatRefused("chat", null, facts, "local");
    case "owned":
      if (standing.ownerId === callerId) return accept(() => {});
      if (standing.ownerId === TANDEM_OWNER_ID) ensureRecord(TANDEM_OWNER_ID, "tandem");
      return chatRefused("chat", viewOf(standing.ownerId), facts, "holder");
    case "with-document": {
      const documentId = standing.documentId;
      // An acknowledgement claims the document like a final reply, and sets
      // no per-message owner: the message follows the document (the posts
      // PR, R3.3, narrowing the chat owners PR's R3.3 to design §7.1).
      if (inboxScopeOf(documentId, callerId) === "may-claim") {
        return accept(() => claimForReply(key, documentId, callerId));
      }
      // Ruling 4: the document cannot be claimed now. A caller a poll handed
      // the message may still answer it, as its per-message owner; the
      // document is not claimed.
      if (handedByRecord.get(callerId)?.has(key)) {
        return accept(() => setMessageOwner(key, callerId, origin));
      }
      // A blocking loss on an unowned document (PR 5's Release; only
      // `setLossForTests` reaches it before then) is not a running operation.
      const lost = lossByDoc.get(documentId)?.ownerId === callerId;
      return chatRefused("chat", null, facts, lost ? "lost" : "busy");
    }
    case "per-message":
      // A claimable message with no open document to claim (doc-less, or on
      // a closed document): a final reply or an acknowledgement makes the
      // caller its per-message owner (design §7.1).
      return accept(() => setMessageOwner(key, callerId, origin));
  }
}

/**
 * The gate for a chat post (the posts PR, R1; design §7.3 rule 2): a
 * `tandem_reply` that names no message. Decided without writing anything;
 * an accepted post's claim, if any, runs in `apply`, after the append. A
 * post answers nothing: it sets no answerer, no per-message owner and no
 * `settles` (R1.6).
 */
function postGate(
  callerId: string | undefined,
  explicit: string | undefined,
  docs: ReplyGateDocuments,
  unmatchedReplyTo: boolean,
): ReplyGate {
  // R1.4, before anything about documents.
  if (callerId === undefined) return noOwnerIdentity();
  const isTandem = callerId === TANDEM_OWNER_ID;
  const open = explicit !== undefined && docs.isOpen(explicit);
  // What every post refusal says about how the call was judged (plan review).
  const judged = {
    ...(unmatchedReplyTo ? { unmatchedReplyTo: true } : {}),
    ...(explicit !== undefined && !open ? { namedNotOpen: true } : {}),
  };
  if (isTandem && !isTandemPresent()) return postRefused("not-present", null, explicit, judged);
  if (!isTandem && !records.has(callerId)) {
    return { kind: "refused", stage: "ownership", code: "INTERNAL_ERROR", message: POST_NO_RECORD };
  }
  const acceptPost = (documentId: string | undefined, claim?: string): ReplyGate => ({
    kind: "accepted",
    documentId,
    apply: () => {
      if (claim !== undefined)
        total("postApply", undefined, () => claimForPost(claim, callerId, docs));
    },
  });
  // R1.2: an explicit document that is open.
  if (open && explicit !== undefined) {
    const entry = readEntry(explicit);
    // A blocking loss first (`refusalFor` checks it before the entry), so it
    // wins over a holder and over a busy queue.
    const refusal = refusalFor(explicit, callerId, entry);
    if (refusal) {
      return postRefused(refusal.reason as PostRefusalReason, refusal.holder, explicit, {
        ...judged,
        ...(refusal.cause !== undefined ? { cause: refusal.cause } : {}),
        callerIsTandem: isTandem,
      });
    }
    if (entry?.ownerId === callerId) return acceptPost(explicit);
    // Unowned: claimed when the caller may claim it now (Ruling 3);
    // otherwise (its queue busy within the bound) accepted without a claim.
    return inboxScopeOf(explicit, callerId) === "may-claim"
      ? acceptPost(explicit, explicit)
      : acceptPost(explicit);
  }
  // R1.3: no documentId — stamped with the active document only if the
  // caller holds it; it never claims the active tab.
  if (explicit === undefined) {
    const active = docs.activeDocumentId();
    if (active !== undefined && readEntry(active)?.ownerId === callerId) return acceptPost(active);
  }
  // A doc-less post (or one naming a document that is not open, stamped with
  // the id given): from the doc-less chat owner only.
  if (isTandemPresent() && !isTandem) {
    ensureRecord(TANDEM_OWNER_ID, "tandem");
    return postRefused("post", viewOf(TANDEM_OWNER_ID), explicit, {
      ...judged,
      ...(heldDocumentIds(callerId).length > 0 ? { callerHolds: true } : {}),
    });
  }
  return acceptPost(explicit);
}

/**
 * An accepted post's claim of the open, unowned document it names (the
 * posts PR, R1.2; Ruling 3): the same rule a write's claim uses
 * (`standingOf`), re-checked now, applied at once (an unqueued change, cause
 * `post-claim`). A claim no longer possible by now changes nothing: the post
 * stands.
 */
function claimForPost(documentId: string, callerId: string, docs: ReplyGateDocuments): void {
  if (!docs.isOpen(documentId)) return;
  const standing = standingOf(documentId, callerId, readEntry(documentId));
  if (!standing.ok || standing.holds || standing.claim === null) return;
  setDocOwner(documentId, { ownerId: callerId, kind: standing.claim }, "post-claim", callerId);
  const record = records.get(callerId);
  if (record && ownerByDoc.get(documentId)?.ownerId === callerId) rejudge(record);
}

/**
 * An accepted reply's claim of the unowned document its message is on
 * (Ruling 3): the same rule a write's claim uses (`standingOf`), applied at
 * once (an unqueued change, cause `reply-claim`). A claim no longer possible
 * by now changes nothing: the reply stands.
 */
function claimForReply(key: string, documentId: string, callerId: string): void {
  // Still open, as the poll's claim re-checks (`stillOpen`): an entry for a
  // closed document would have no tab and no close to remove it.
  if (chatSide.message(key)?.documentOpen !== true) return;
  const standing = standingOf(documentId, callerId, readEntry(documentId));
  if (!standing.ok || standing.holds || standing.claim === null) return;
  setDocOwner(documentId, { ownerId: callerId, kind: standing.claim }, "reply-claim", callerId);
  const record = records.get(callerId);
  if (record && ownerByDoc.get(documentId)?.ownerId === callerId) rejudge(record);
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
   * (the poll's one reading of the monotonic clock, `performance.now()`, reused for acknowledgement, the pass and
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
  /**
   * The reply gate for `tandem_reply` (the chat owners PR, R5): `legacy`
   * while ownership is off, so the tool runs master's path. The caller is
   * passed along unread, as for `begin`.
   */
  replyGate(
    caller: { readonly ownerId?: string },
    request: { replyTo?: string; inProgress?: boolean; documentId?: string },
    docs: ReplyGateDocuments,
  ): ReplyGate {
    if (!ownershipEnabled()) return LEGACY_REPLY;
    return replyGate(caller.ownerId, request, docs);
  },
  /**
   * Which handled rule chat follows (the posts PR, R3.2): `"settles"` with
   * ownership on (a final reply's `replyTo` or `settles`, no sweep),
   * `"sweep"` off (master's `answeredChatIds`). For the one inbox reader
   * with no poll scope to ask, #2419's owed-at-switch set.
   */
  chatRule(): "settles" | "sweep" {
    return ownershipEnabled() ? "settles" : "sweep";
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

// ---------------------------------------------------------------------------
// Waiting for Tandem's Claude, both halves (#2358 PR 3b-2b1b-chat; ownership
// design §8.5 as ADR-054's 3b-2b1b and 3b-2b1b-chat amendments rule it).

/** Fixed text: no id, no record, nothing from the error. */
const DOCUMENT_HALF_FAILED =
  "[ownership] the document half of waiting could not be computed; it is read as nothing waiting.";
const CHAT_HALF_FAILED =
  "[ownership] the chat half of waiting could not be computed; it is read as nothing waiting.";

/**
 * Whether some user chat message is waiting for Tandem's Claude and accepted
 * by `select` (Ruling K applied to chat): a key the chat side says a fresh
 * reader would be handed if it may have it, that is not carried over, and
 * whose standing is `owned` by Tandem's Claude (per message, by following a
 * document it holds, or doc-less or on a closed document while it is
 * present): what the poll's `chatScopeOf` answers `"owns"` for. Its
 * `"claim"` arm (chat following an open, unowned document) is not counted
 * (the brief's Flag for Bryan). `select` receives the facts because an
 * `owned` standing carries no document id. Unexported: the step-5 composite
 * and 3b-2b1c reuse it. Synchronous; writes nothing. May throw: its callers
 * catch.
 */
function tandemChatWaiting(
  select: (key: string, facts: ChatMessageFacts, standing: MessageStanding) => boolean,
): boolean {
  for (const key of chatSide.owedToFreshReader()) {
    if (carriedOver.has(key)) continue;
    const facts = chatSide.message(key);
    if (facts === undefined) continue;
    const standing = messageStanding(key, facts);
    if (standing.kind !== "owned" || standing.ownerId !== TANDEM_OWNER_ID) continue;
    if (select(key, facts, standing)) return true;
  }
  return false;
}

/**
 * Whether anything is waiting for Tandem's Claude (#2358 PR 3b-2b1b-chat):
 * on a document it holds (the waiting probe, `documentWaiting`), or in chat
 * it owns ({@link tandemChatWaiting}). False while ownership is off, before
 * anything is read. **Computed and not consumed**: nothing calls it until
 * 3b-2b1c wires the supervisor's decision to it. Synchronous; writes nothing.
 * Both halves are always asked, each in its own catch, so a throw in one
 * cannot hide a waiting answer from the other: a failed half reads as false
 * and logs one fixed, rate-limited line with no id and no error text.
 */
export function tandemWorkWaiting(): boolean {
  if (!ownershipEnabled()) return false;
  let documents = false;
  try {
    documents = heldDocumentIds(TANDEM_OWNER_ID).some((documentId) =>
      waitingProbe(documentId, TANDEM_OWNER_ID),
    );
  } catch {
    logLimited("waiting-document-half", DOCUMENT_HALF_FAILED);
  }
  // Both halves run whatever the first answered (plan review M1), so a chat
  // half that throws is logged even beside a waiting document.
  let chat = false;
  try {
    chat = tandemChatWaiting(() => true);
  } catch {
    logLimited("waiting-chat-half", CHAT_HALF_FAILED);
  }
  return documents || chat;
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
  /** Each record's queued change notices, by owner id (records with none are left out). */
  changeNotices: Array<[string, ChangeNotice[]]>;
  /** The chat owners PR: per-message owners, by chat key, each with its origin. */
  messageOwners: Array<[string, MessageOwner]>;
  /** The chat owners PR: what each record was handed by its polls, by owner id. */
  handed: Array<[string, string[]]>;
  /** The posts PR: the boot's carried-over messages, sorted. */
  carriedOver: string[];
  /** The posts PR: each chat message's answerer, by chat key. */
  chatAnswerers: Array<[string, string]>;
  /** The posts PR: who wrote each accepted final reply row, by row key. */
  repliers: Array<[string, string]>;
} {
  return {
    transportMode,
    records: [...records.values()].map((r) => ({ ...r })),
    ownerByDoc: [...ownerByDoc],
    handoverSeq: [...handoverSeq],
    timers:
      [...records.values()].filter((r) => r.graceTimer !== undefined).length +
      [...reOweRetries.values()].filter((r) => r.timer !== undefined).length,
    losses: [...lossByDoc],
    answerers: answererByItem.size,
    queuedDocuments: docOpQueueSizeForTests(),
    pendingClaims: pendingClaims.size,
    changeNotices: [...records.values()]
      .filter((r) => (r.changeNotices?.length ?? 0) > 0)
      .map((r) => [r.ownerId, (r.changeNotices ?? []).map((n) => ({ ...n }))]),
    messageOwners: [...ownerByMessage].map(([key, owner]) => [key, { ...owner }]),
    handed: [...handedByRecord]
      .filter(([, keys]) => keys.size > 0)
      .map(([ownerId, keys]) => [ownerId, [...keys].sort()]),
    carriedOver: [...carriedOver].sort(),
    chatAnswerers: [...chatAnswerer],
    repliers: [...replierByRow],
  };
}

/** How many times `recordHoldsState` has run since the last reset (R0.7, item 15). */
export function recordHoldsStateCallsForTests(): number {
  return recordHoldsStateCalls;
}

/**
 * Make the chat half of a handover (`"re-owe"`), of a close (`"close"`), a
 * reply's apply (`"apply"`), a poll's chat commit (`"commit"`, inside
 * `commitChat`) or a reply's step 1 `settles` write (`"settles"`) throw;
 * undefined clears it.
 */
export function setChatOwnershipFaultForTests(
  fault: ((at: "re-owe" | "close" | "apply" | "commit" | "settles") => void) | undefined,
): void {
  chatFaultForTests = fault;
}

/** Watch `startOrWake` (step 5): told each cause that reaches it. Undefined clears it. */
export function setWakeObserverForTests(observer: ((cause: WakeCause) => void) | undefined): void {
  wakeObserverForTests = observer;
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

/**
 * Make change-notice queueing throw, at step 3 of the composite
 * (`"change"`) or at the tab close (`"close"`): `fault` runs first and may
 * throw. Undefined clears it.
 */
export function setChangeNoticeFaultForTests(
  fault: ((at: "change" | "close", documentId: string) => void) | undefined,
): void {
  noticeFaultForTests = fault;
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
  for (const ownerId of [...reOweRetries.keys()]) clearReOweRetry(ownerId);
  records.clear();
  carriedOver.clear();
  chatAnswerer.clear();
  replierByRow.clear();
  recordHoldsStateCalls = 0;
  ownerByDoc.clear();
  handoverSeq.clear();
  lossByDoc.clear();
  answererByItem.clear();
  ownerByMessage.clear();
  handedByRecord.clear();
  pendingClaims.clear();
  compositeObserver = undefined;
  noticeFaultForTests = undefined;
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
  chatSide = NO_CHAT_SIDE;
  chatFaultForTests = undefined;
  wakeObserverForTests = undefined;
  graceMs = DEFAULT_GRACE_MS;
}
