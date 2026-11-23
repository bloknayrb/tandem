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
 * 3b, and `startOrWake`, step 5's seam (a no-op until 3b-2b1c made it the
 * forward to the supervisor, through a sink `index.ts` sets). PR 1c: the decisions enforcement rests on
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
 * round). PR 3b-2c: the greeting by bound transport
 * ({@link greetingTransportBound}). PR 5a: the user's Release and Assign of a
 * document ({@link controlDocumentOwner}). PR 5a-2: of a chat message
 * ({@link controlMessageOwner}), with the message's loss record, and a
 * document's control moving the messages its close gave an owner.
 * **Nothing here answers a tool call**: the MCP tool
 * wrapper (`mcp/owned-op.ts`) asks these functions and builds the refusal, so
 * `/api`, autosave and the reload family never meet a check (ownership design §3.1).
 *
 * **Nearly a leaf.** It imports the flag, one helper from `sessions/context.ts`,
 * the operation queue, two names from `mcp/transport-registry.ts`, the
 * spawn-end listener seam of `sessions/owner-handle-bind.ts` (#2358 PR
 * 3b-2b3b; that module is a leaf), the
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
  DocOpCancelled,
  DocOpWaitExpired,
  docOpBusySince,
  docOpQueueSizeForTests,
  docOpWaitLimitMs,
  resetDocOpQueuesForTests,
  runDocOp,
  runWhenDocIdle,
} from "./doc-op-queue.js";
import { setSpawnEndedListener } from "./owner-handle-bind.js";
import {
  type ChatRefusalWhy,
  type ChatReplyRefusal,
  chatReplyRefusal,
  type PostRefusalInput,
  type PostRefusalReason,
  postRefusal,
  unlinkedReplyRefusal,
} from "./ownership-refusal.js";

/**
 * How a record was identified (ownership design §2, §3.1). Server-derived.
 * `unbound-child` (one per spawn, owner id `spawn:<n>`) and `child-private`
 * (one per transport, owner id `private:<Mcp-Session-Id>`) are rule 0's
 * records for Tandem's own children that did not bind (#2358 PR 3b-2b3a);
 * only {@link resolveTransportRecord} and the re-pointing at a spawn's start
 * or teardown (3b-2b3b) make them, and only while the own-spawn seam is set
 * ({@link setOwnSpawnSource}).
 */
export type RecordKind =
  | "tandem"
  | "claude"
  | "bridge"
  | "http"
  | "local"
  | "unbound-child"
  | "child-private";

/** What the badge may call a record (ownership design §10.3): a closed list. */
export type DisplayKind = "Tandem's Claude" | "terminal" | "Claude Desktop" | "other app";

/**
 * The cause words of `tandem_checkInbox`'s `ownership.changed` (the
 * change-notice PR, Requirement 7): a closed set, each a past-tense fact in
 * plain English that reads by itself. Their descriptions live in
 * `ownership-refusal.ts` (`CHANGE_CAUSE_FACTS`), a `Record` over this type,
 * and the output schema's enum is this list, so no word can be queued that
 * the schema does not list. A cause no production path makes today (Tandem's
 * Claude's gains and losses) is not here: each joins with the PR that
 * produces it. Release and Assign joined with #2358 PR 5a (the ownership
 * route): a released session is told only that the document was released,
 * never that the user chose it (ownership design §11.3). A chat post's claim joined with the posts PR
 * (R1.8); a terminal's loss to Tandem's Claude (a take-back, or its own
 * `tandem_open`: the `taken back` loss) with #2358 PR 3b-2b4c. None equals
 * an internal {@link OwnershipChangeCause}.
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
  "Tandem's Claude took it back",
  "it was released",
  "it was assigned to another session",
  "it was assigned to this session",
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
 * one synchronous run, an unqueued change like `reply-claim`); `presence`
 * Tandem's Claude becoming present (an open document with no entry goes to
 * `default`) or ceasing to be (each document it holds goes unowned), each at
 * the document's turn in its queue (#2358 PR 3b-2b4a, {@link noteTandemPresence};
 * ownership design §4.2). `release` and `assign` are the user's controls
 * (#2358 PR 5a, `POST /api/ownership`; ownership design §10.1), each at the
 * document's turn in its queue ({@link controlDocumentOwner}).
 */
export type OwnershipChangeCause =
  | "user-open"
  | "presence"
  | "lapse"
  | "take-back"
  | "claim"
  | "take"
  | "stale"
  | "poll-claim"
  | "reply-claim"
  | "post-claim"
  | "release"
  | "assign";

/**
 * Why a record lost a document, for the causes that block it from claiming
 * the document again without a `tandem_open` (ownership design §5.3).
 * `released` and `assigned` came with the controls that cause them (#2358 PR
 * 5a). `released` is the one recorded on a change to unowned: Release must
 * last while Tandem's Claude is not present (ownership design §5.3).
 */
export type LossCause = "taken" | "taken back" | "released" | "assigned";

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
  | "post"
  /** A rule-0 child record on a document Tandem's Claude holds (#2358 PR 3b-2b3b; design §5.3). */
  | "unbound-child";

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
 * The greeting's transport fact (#2358 PR 3b-2c; ownership design §7.3):
 * whether a `tandem_reply` arrived on a transport bound to Tandem's Claude's
 * current run. Undefined while ownership is off, so the greeting classifier
 * keeps keying on the reply's session id, as on master. Flag on it is true
 * only for an MCP caller on the `tandem` record, which rule 0 gives a
 * transport only once its bind to the current spawn is confirmed, and which a
 * spawn's teardown takes back from its bound transports
 * (`noteOwnSpawnEnded`); a reply's session id never counts. A
 * `/api/channel-reply` reply (`"channel"`) has no transport and is never the
 * greeting. Writes nothing.
 */
export function greetingTransportBound(
  caller: { readonly ownerId?: string } | "channel",
): boolean | undefined {
  if (!ownershipEnabled()) return undefined;
  return caller !== "channel" && caller.ownerId === TANDEM_OWNER_ID;
}

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
  /**
   * Made by re-pointing Tandem's own child's bound transports at its teardown
   * (`noteOwnSpawnEnded`): its lapse is the child's own leftovers going, so it
   * starts nothing (Bryan, 2026-11-23: "No, its own lapse starts nothing").
   */
  fromOwnTeardown?: boolean;
}

/** One document's ownership entry (ownership design §2). No entry means unowned. */
export interface OwnershipEntry {
  readonly ownerId: string;
  readonly kind: OwnershipKind;
  readonly since: number;
  /** The inbox registry's counter when the entry was made (`setOwnershipSeqSource`). */
  readonly sinceSeq: number;
}

/**
 * The slice of a transport-registry entry attachment is judged from. The
 * view is the registry's own entries, so re-pointing a transport
 * (`repointTransports`, #2358 PR 3b-2b3b, reached only while rule 0 routes)
 * writes `ownerId` on them; nothing else here writes through the view.
 */
export interface TransportViewEntry {
  /** The transport's `Mcp-Session-Id`: a private record's key. */
  readonly sessionId?: string;
  readonly clientName?: string;
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
 * Documents closed this server run whose reopen has not yet been seen
 * (#2358 PR 3b-2b5, the reopen round): its delivery round was dropped at the
 * close, and the close's handover re-owed what its holder was handed, so its
 * reopen opens the round of the items still owed ({@link noteReopened}).
 * Added by a flag-on {@link onDocumentClosed}; taken by the first of a user
 * open's default rule ({@link applyUserOpenDefault}) or the first entry
 * written for it (a `tandem_open` take, a claim). Bounded by the documents
 * closed and not reopened this run.
 */
const reopenRoundOwed = new Set<string>();
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

/**
 * How a message's per-message owner was set (the chat owners PR, R3.3).
 * `assign` is the user's Assign of the message (#2358 PR 5a-2; ownership
 * design §10.1, §10.2): the one origin written by an overwrite, never by the
 * check-and-set ({@link applyMessageControl}).
 */
export type MessageOwnerOrigin = "poll" | "reply" | "acknowledgement" | "close" | "assign";

/** A user chat message's per-message owner (ownership design §7.1, §7.2). */
export interface MessageOwner {
  readonly ownerId: string;
  /**
   * How it was set. Never rewritten: an owner keeps the origin it was set
   * with (R3.3), except by the user's Assign of the message, which replaces
   * the whole owner (#2358 PR 5a-2, the one exception to R3.3).
   */
  readonly origin: MessageOwnerOrigin;
  /**
   * Origin `close` only: the document whose tab close set it. The document's
   * Release and Assign read it, to move the message with its document
   * (R3.4; #2358 PR 5a-2, {@link moveCloseDerivedChat}).
   */
  readonly closedDocumentId?: string;
}

/**
 * Per-message owners of user chat messages, keyed by the row's key in
 * CTRL_ROOM's chat map (a message's identity, R3.1's terms). **Server memory
 * only**: never on a row, never in the session file, lost at restart like
 * every map here (R3.2). At most one per chat row: an owner whose row is
 * deleted goes (`forgetChatMessageOwners`, R3.6), and an owner goes with its
 * record (`deleteRecord`, R3.5a). Written by {@link setMessageOwner}, which
 * is a check-and-set: an existing owner and its origin are never overwritten
 * (R3.3); and by the user's Assign of the message
 * ({@link applyMessageControl}, #2358 PR 5a-2), **the one writer that
 * overwrites**, the narrow exception ADR-054's 5a-2 amendment states. The
 * user's controls also drop owners: a message Release, and a document's
 * Release or Assign moving the messages its close gave an owner
 * ({@link moveCloseDerivedChat}). Empty while ownership is off (every writer
 * returns at the flag first).
 */
const ownerByMessage = new Map<string, MessageOwner>();

/**
 * A message's loss record (#2358 PR 5a-2; ownership design §10.2, "A
 * message's loss record"): the record the user's Release or Assign of the
 * message moved it away from, and why. **At most one per message**, keyed by
 * its chat key like {@link ownerByMessage}. While it stands, §7.1's table
 * skips that record ({@link messageStanding}): where the table would give the
 * message back to it (Tandem's Claude by presence, or the holder of its open
 * document), the message is claimable by anyone else instead, and that
 * record cannot take it by a poll or a reply ({@link setMessageOwner} refuses
 * it too, as a backstop that also covers a tab close). It stands until the
 * message's per-message owner changes again: a new owner is set (a take, a
 * reply, an acknowledgement, a close, an Assign), an owner is dropped by a
 * lapse, a deleted record or the end of presence ({@link releaseMessageOwners}),
 * or the user's control writes a new one. A change that only follows a
 * document or presence leaves it (decided in 5a-2, stated in ADR-054).
 * Dropped with the row ({@link forgetChatMessageOwners}) and at restart; kept
 * when the loser's record is deleted, as a document's loss is. Not counted by
 * `recordHoldsState`. Empty while ownership is off.
 */
const lossByMessage = new Map<string, { ownerId: string; cause: LossCause }>();

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
 * naming one is accepted and sets no owner. Leaves when its row is deleted
 * (`forgetChatMessageOwners`: Clear chat), or when the user Assigns it
 * (#2358 PR 5a-2, Bryan's pick "Let Assign own them": `applyMessageControl`
 * takes it out of this set in the same write that gives it its owner, so a
 * message in this set never has an owner). Bounded by the restored
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
 * own rows. Written for a final reply from a caller with a record, through
 * `tandem_reply` or, since the shim's permit (#2358 PR 4b), an accepted
 * `/api/channel-reply` from a mapped shim (never a post, an acknowledgement,
 * a channel row written while ownership was off or a local-model row, which
 * so settle only their target). Dropped with the row
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
 * needs from chat comes through these eight members (`owedToFreshReader` is
 * #2358 PR 3b-2b1b-chat's, `unhandledKeys` 3b-2b4b's), which `src/server/index.ts`
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
  /** The keys of every user message that is not handled and not local-period chat (#2358 PR 3b-2b4b). */
  unhandledKeys(): readonly string[];
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
  unhandledKeys: () => [],
  message: () => undefined,
  reOwe: () => {},
  settleCandidates: () => [],
  addSettles: () => [],
  owedToFreshReader: () => [],
});

let transportMode: "http" | "stdio" | undefined;
let transportView: () => ReadonlyArray<TransportViewEntry> = () => [];
let presenceSource: () => boolean = () => false;
/** The own-spawn seam (#2358 PR 3b-2b3a): set by `index.ts`'s supervisor setup (3b-2b4a). */
let ownSpawnSource: (() => OwnSpawn | null) | undefined;
let ownChildCheck: ((sessionId: string) => boolean) | undefined;
let waitingProbe: (documentId: string, ownerId: string) => boolean = () => false;
let startOrWakeSink: (
  cause: "document" | "message" | "departure" | "solo-release" | "mode-known",
) => void = () => {};
let requestWakeSink: () => void = () => {};
let ownershipFrameSink: () => void = () => {};
let roundOpener:
  | ((owed: { documents: readonly string[]; messages: readonly string[] }) => void)
  | undefined;
let openDocumentIds: () => Iterable<string> = () => [];
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
      // #2358 PR 3b-2b3a: an HTTP-mode boot has Tandem's Claude's record from
      // the start, as stdio has `local`. Stdio mode makes it only lazily.
      else ensureRecord(TANDEM_OWNER_ID, "tandem");
      return;
    }
    if (transportMode !== mode) {
      logLimited("mode", `[ownership] transport mode is ${transportMode}; ignoring ${mode}`);
    }
  });
}

/** The current spawn of Tandem's own Claude, as the supervisor numbers it. */
export interface OwnSpawn {
  readonly n: number;
  readonly sessionId: string;
}

/**
 * The own-spawn seam (#2358 PR 3b-2b3a): the supervisor's current spawn and
 * its test for any session id one of its children ever used. While it is set
 * (and the flag is on), {@link resolveTransportRecord} applies rule 0 and the
 * MCP server chooses a transport's record after its bind is confirmed.
 * `src/server/index.ts` sets it once, inside the launcher supervisor's setup,
 * together with presence's consumer (#2358 PR 3b-2b4a; Bryan, 2026-11-23:
 * "Build dark, switch on with 3b-2b4"); a source pin holds that. Flag off it
 * routes nothing ({@link ownSpawnRoutingActive}). Undefined clears it;
 * `resetOwnershipForTests` clears it too.
 */
export function setOwnSpawnSource(
  source: (() => OwnSpawn | null) | undefined,
  isOwnChild?: (sessionId: string) => boolean,
): void {
  ownSpawnSource = source;
  ownChildCheck = source === undefined ? undefined : isOwnChild;
  // Teardown re-pointing (#2358 PR 3b-2b3b) listens only while the seam is
  // set, so an unset seam leaves a spawn's teardown exactly as it was.
  setSpawnEndedListener(source === undefined ? undefined : noteOwnSpawnEnded);
}

const toPrivateRecord = (mcpSessionId: string) => ({
  ownerId: `private:${mcpSessionId}`,
  recordKind: "child-private" as const,
});

/**
 * Retirement and demotion at each spawn (ownership design §3.1; #2358 PR
 * 3b-2b3b), called at each spawn's start through the supervisor's
 * `onSpawnStarted` event, which `index.ts` subscribes beside the seam
 * (3b-2b4a); a no-op unless rule 0 routes
 * ({@link ownSpawnRoutingActive}). Every earlier spawn's `unbound-child`
 * record is retired: each of its transports (a `--resume` terminal included)
 * moves to a fresh `child-private` record of its own, then the record lapses,
 * so its documents go to the default rule and its unanswered messages lose
 * their owner, exactly as a lapse moves them. A plain `claude:` record
 * holding the new spawn's session id is demoted the same way, its transports
 * going to this spawn's `unbound-child` record. Never the `tandem` record.
 */
export function noteOwnSpawnStarted(spawn: OwnSpawn): void {
  if (!ownSpawnRoutingActive()) return;
  total("noteOwnSpawnStarted", undefined, () => {
    const current = `spawn:${spawn.n}`;
    for (const record of [...records.values()]) {
      if (record.recordKind === "unbound-child" && record.ownerId !== current) {
        repointTransports(record.ownerId, toPrivateRecord);
        lapse(record);
      }
    }
    const demoted = records.get(`claude:${claudeIdKey(spawn.sessionId)}`);
    if (demoted?.recordKind === "claude") {
      repointTransports(demoted.ownerId, () => ({ ownerId: current, recordKind: "unbound-child" }));
      lapse(demoted);
    }
  });
}

/**
 * A spawn's teardown (ownership design §3.3; #2358 PR 3b-2b3b): its bound
 * transports still registered, which rule 0 put on `tandem`, move to fresh
 * `child-private` records, one each. The `tandem` record keeps its
 * documents: presence decides what it holds, not the run. Reached from
 * `endSpawn` only while the seam is set, and a no-op unless rule 0 routes.
 */
function noteOwnSpawnEnded(boundMcpSessionIds: readonly string[]): void {
  if (!ownSpawnRoutingActive()) return;
  const bound = new Set(boundMcpSessionIds);
  total("noteOwnSpawnEnded", undefined, () => {
    for (const record of repointTransports(TANDEM_OWNER_ID, toPrivateRecord, bound)) {
      record.fromOwnTeardown = true;
    }
  });
}

/**
 * Move `fromOwnerId`'s registered transports (only those in `only`, when
 * given) to the records `to` names, creating each, and re-judge them. The
 * old record is the caller's to re-judge or lapse.
 */
function repointTransports(
  fromOwnerId: string,
  to: (mcpSessionId: string) => { ownerId: string; recordKind: RecordKind },
  only?: ReadonlySet<string>,
): ReadonlySet<OwnerRecord> {
  const moved = new Set<OwnerRecord>();
  for (const entry of transportView()) {
    const sid = entry.sessionId;
    if (entry.ownerId !== fromOwnerId || sid === undefined) continue;
    if (only !== undefined && !only.has(sid)) continue;
    const next = to(sid);
    const record = ensureRecord(next.ownerId, next.recordKind);
    record.clientName = entry.clientName;
    entry.ownerId = next.ownerId;
    moved.add(record);
  }
  for (const record of moved) rejudge(record);
  return moved;
}

/**
 * Whether a record's lapse is Tandem's own child's leftovers going, which
 * starts nothing (Bryan, 2026-11-23, picked from options: "No, its own lapse
 * starts nothing (Recommended)"): a record its teardown re-pointed, or the
 * unbound-child record of a spawn that is no longer current. A `--resume`
 * terminal on the current spawn's record still counts and still re-asks.
 */
function isOwnChildLeftover(record: OwnerRecord): boolean {
  if (record.fromOwnTeardown === true) return true;
  if (record.recordKind !== "unbound-child") return false;
  let current: OwnSpawn | null = null;
  try {
    current = ownSpawnSource?.() ?? null;
  } catch {
    current = null;
  }
  return current === null || record.ownerId !== `spawn:${current.n}`;
}

/** A rule-0 record of Tandem's own child that did not bind (design §3.1). */
function isChildRecord(ownerId: string): boolean {
  const kind = records.get(ownerId)?.recordKind;
  return kind === "unbound-child" || kind === "child-private";
}

/**
 * §3.1's one rule for `unbound-child` and `child-private` records: on a
 * document Tandem's Claude holds they are refused with the `unbound-child`
 * copy, and they take nothing from it. Everywhere else they are a terminal.
 * No such record exists while the own-spawn seam is unset.
 */
function guardsTandem(entry: OwnershipEntry | undefined, callerId: string): boolean {
  return entry?.ownerId === TANDEM_OWNER_ID && isChildRecord(callerId);
}

/** Whether rule 0 routes (flag on and the own-spawn seam set). */
export function ownSpawnRoutingActive(): boolean {
  return ownershipEnabled() && ownSpawnSource !== undefined;
}

/** The transport mode a boot set, or undefined. */
export function getOwnershipTransportMode(): "http" | "stdio" | undefined {
  return transportMode;
}

/** Install the registry view attachment is judged from. `startMcpServerHttp` calls it. */
export function setTransportView(view: () => ReadonlyArray<TransportViewEntry>): void {
  transportView = view;
}

/** Presence seam (ownership design §8.1). `src/server/index.ts` wires the supervisor's
 * announced presence (PR 3b-1, `Supervisor.tandemPresence`) here inside the launcher
 * supervisor's setup (#2358 PR 3b-2b4a); unwired, or flag off, not present. */
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
 * unwired it answers false. Step 5 asks it only flag on, only when the new
 * owner is Tandem's Claude, the caller is not, and the cause is not
 * `take-back`; flag on, the default rule's writers (a lapse, the user-open
 * default, presence's moves) reach it while Tandem's Claude is present
 * (presence wired in 3b-2b4a). A true answer reaches `startOrWake`, which
 * forwards to the supervisor (3b-2b1c). Step 5 asks it through `waitingAtDocumentChange`
 * (3b-2b1b-chat-step5): the probe first, exactly as `(documentId,
 * next.ownerId)`, and only when it answers false the chat that follows the
 * document. A throw from the probe is not caught there: it reaches
 * `setDocOwner`'s `total`, as before. `tandemWorkWaiting` (#2358 PR
 * 3b-2b1b-chat) also asks it, flag on, for each document Tandem's Claude
 * holds and, while no other session is connected, for each open document
 * nobody holds that it could claim (3b-2b1b-claimable); the supervisor's
 * start-or-wake pass asks that decision (3b-2b1c, `workWaiting`).
 */
export function setWaitingProbe(probe: (documentId: string, ownerId: string) => boolean): void {
  waitingProbe = probe;
}

/**
 * The ids of the open documents (#2358 PR 3b-2b1b-claimable): what
 * {@link tandemWorkWaiting} reads to find claimable work, an open document
 * nobody holds. `src/server/index.ts` wires `getOpenDocs().keys()` beside the
 * waiting probe, before both transport branches (pinned from source in
 * `tests/server/ownership-source-pins.test.ts`): a seam, because importing
 * `documents/` or `document-service` here would close an import cycle.
 * Unwired it answers no document, so nothing claimable counts. Only stored:
 * read only by a flag-on `tandemWorkWaiting`, which copies it into a set
 * before it asks anything.
 */
export function setOpenDocumentIdsSource(source: () => Iterable<string>): void {
  openDocumentIds = source;
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
 * (ownership design §3.1 rules 0–3). Rule 0 (#2358 PR 3b-2b3a) applies only
 * while the own-spawn seam is set ({@link setOwnSpawnSource}); unset, the
 * answer is exactly rules 1–3, and `bound` is ignored. Under rule 0: a
 * transport whose bind to the current spawn was confirmed is `tandem`; one
 * that did not bind but carries the current spawn's session id is that
 * spawn's `unbound-child` record (`spawn:<n>`, one per spawn, so a resumed
 * spawn with the same id gets a new one); one carrying any other id a child
 * of Tandem's ever used is a `child-private` record of its own
 * (`private:<Mcp-Session-Id>`). Nothing but a confirmed bind is ever `tandem`.
 * **Pure**: it creates nothing. `noteTransportRegistered` creates the record
 * once the transport is actually in the registry, so a record cannot be
 * removed in the window between the two (the registry's `add` awaits an LRU
 * eviction first). Undefined only while the flag is off; flag-on it is total.
 */
export function resolveTransportRecord(identity: {
  mcpSessionId: string;
  claudeSessionId?: string;
  clientId?: string;
  /** The bind outcome: confirmed bound to the current spawn (rule 0 only). */
  bound?: boolean;
}): { ownerId: string; recordKind: RecordKind } | undefined {
  if (!ownershipEnabled()) return undefined;
  const byTransport = { ownerId: `http:${identity.mcpSessionId}`, recordKind: "http" as const };
  return total("resolveTransportRecord", byTransport, () => {
    if (ownSpawnSource !== undefined) {
      const ruleZero = ownSpawnRecord(ownSpawnSource, identity);
      if (ruleZero) return ruleZero;
    }
    if (identity.claudeSessionId !== undefined) {
      return { ownerId: `claude:${claudeIdKey(identity.claudeSessionId)}`, recordKind: "claude" };
    }
    if (identity.clientId !== undefined) {
      return { ownerId: `bridge:${identity.clientId}`, recordKind: "bridge" };
    }
    return byTransport;
  });
}

/** Rule 0's answer, or undefined to fall through to rules 1–3. */
function ownSpawnRecord(
  source: () => OwnSpawn | null,
  identity: { mcpSessionId: string; claudeSessionId?: string; bound?: boolean },
): { ownerId: string; recordKind: RecordKind } | undefined {
  if (identity.bound === true) return { ownerId: TANDEM_OWNER_ID, recordKind: "tandem" };
  if (identity.claudeSessionId === undefined) return undefined;
  const key = claudeIdKey(identity.claudeSessionId);
  const spawn = source();
  if (spawn !== null && claudeIdKey(spawn.sessionId) === key) {
    return { ownerId: `spawn:${spawn.n}`, recordKind: "unbound-child" };
  }
  if (ownChildCheck?.(identity.claudeSessionId) === true) {
    return { ownerId: `private:${identity.mcpSessionId}`, recordKind: "child-private" };
  }
  return undefined;
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
 * its client sends, and so are rule 0's `unbound-child` and `child-private`
 * records (a `--resume` terminal is the expected one, #2358 PR 3b-2b3a); a name decides only among the other two kinds. Nothing
 * renders it before PR 5.
 */
export function displayKindOf(record: Pick<OwnerRecord, "recordKind" | "clientName">): DisplayKind {
  switch (record.recordKind) {
    case "tandem":
      return "Tandem's Claude";
    case "claude":
    case "local":
    case "unbound-child":
    case "child-private":
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
 * handled, so a handled one just loses its owner). The owner-dropping entry
 * point for a record going away: a lapse (unhandled only), a deleted record
 * (all) and the end of presence ({@link noteTandemPresence}: unhandled, and
 * origin "acknowledgement" handled or not; 3b-2b4a) call it. Each dropped
 * message's loss record ends with its owner (#2358 PR 5a-2). The user's
 * controls drop owners themselves, one message at a time and throwing on a
 * failed re-owe ({@link applyMessageControl}, {@link moveCloseDerivedChat}),
 * because a control must answer the user rather than retry. Never throws.
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
  let forwarded = false;
  for (const [key] of dropped) {
    ownerByMessage.delete(key);
    // Its owner changed again, so a loss on the message no longer stands (#2358 PR 5a-2).
    lossByMessage.delete(key);
    if (messageOwnerChanged({ key })) forwarded = true;
  }
  const keys = dropped.map(([key]) => key);
  // The `ownership` frame (3b-2d): once for the whole release, never per key.
  const framed = frameOwedForMessages(keys);
  if (framed) sendOwnershipFrame();
  // Handover gap (d) (3b-2b5): a wake went out for what was re-owed.
  if (forwarded || framed) openOwedRounds([], keys);
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
 * same `startOrWake` a document's change reaches, with the message forward's
 * admit (#2358 PR 3b-2b1c-b, R5). With no `change` there is no admit: the
 * observer is told, nothing is forwarded (`setMessageOwner`, for every
 * origin, the close included: Bryan's pick 1). With a `change`, the forward is
 * admitted only when the caller is not Tandem's Claude, a departure (no
 * caller and not the user: the release loop's lapse, deleted record and
 * re-owe retry) finds no other session connected (R1.7's gate, before the
 * scan), and the changed message is waiting for Tandem's Claude, owned by it
 * and not claimable (`tandemChatWaiting` on that key alone). The user's
 * Release or Assign (`byUser`, #2358 PR 5a-2) is the user's choice, so it is
 * not gated on other sessions, as a document those controls give Tandem's
 * Claude is not. Returns whether it was forwarded.
 */
function messageOwnerChanged(change?: { key: string; caller?: string; byUser?: true }): boolean {
  const admit = (): boolean =>
    change !== undefined &&
    change.caller !== TANDEM_OWNER_ID &&
    (change.byUser === true || change.caller !== undefined || !anotherSessionConnected()) &&
    tandemChatWaiting((k) => k === change.key);
  return startOrWake("message-owner", change === undefined ? undefined : admit);
}

/**
 * Make `ownerId` the message's per-message owner, if it has none (R3.3): a
 * check-and-set with nothing between the check and the write; an existing
 * owner and its origin are never rewritten. Never for a caller with no
 * record, and never for the record a standing message loss names (#2358 PR
 * 5a-2: §7.1's table skips it; the poll's scope and the reply gate refuse it
 * first, and this also covers a tab close, which would otherwise give a
 * released message back to its document's holder). Setting one ends the
 * message's loss: its owner changed again. Returns whether it set one. A
 * lapsed record whose message is not handled has its grace armed again, as a
 * claim does.
 */
function setMessageOwner(
  key: string,
  ownerId: string,
  origin: MessageOwnerOrigin,
  closedDocumentId?: string,
): boolean {
  // A carried-over message is never given an owner (the posts PR, R0.1).
  if (!ownershipEnabled() || ownerByMessage.has(key) || carriedOver.has(key)) return false;
  if (lostMessage(key, ownerId)) return false;
  if (ownerId === TANDEM_OWNER_ID) ensureRecord(TANDEM_OWNER_ID, "tandem");
  const record = records.get(ownerId);
  if (!record) return false;
  ownerByMessage.set(key, {
    ownerId,
    origin,
    ...(closedDocumentId !== undefined ? { closedDocumentId } : {}),
  });
  lossByMessage.delete(key);
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
      lossByMessage.delete(key);
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
  // The re-ask (#2358 PR 3b-2b2; the claimable row): a session that stops
  // counting may be the last other one, which makes claimable work Tandem's
  // Claude's (Bryan's pick "Yes, unless another session is open"). Asked
  // whatever the record held, so two sessions going away together are caught
  // at the second; gated in `startOrWake` like a lapse, and the pass asks the
  // whole waiting decision. Tandem's own child's leftovers going start
  // nothing (`isOwnChildLeftover`).
  if (!isOwnChildLeftover(record)) startOrWake("departure");
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
 * operation queue, and so do the user-open default and presence's moves
 * (3b-2b4a) and the user's Release and Assign (PR 5a, `controlDocumentOwner`);
 * the stale-entry backstop and a lapse whose wait ran out call it
 * where they are. (The tab-close point does
 * not come through here at all: `onDocumentClosed` deletes the entry itself.
 * `doc-op-queue.ts`'s header lists every unqueued change.) Of the design's five
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
): readonly string[] {
  if (!ownershipEnabled()) return [];
  return total("setDocOwner", [] as readonly string[], () => {
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
      const lost = lossCauseOf(cause, next?.ownerId);
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
    const reOwed = leavesRecord ? reOweDocumentChat(documentId) : [];
    // Step 3, change notices. Its own catch: the change above stands.
    compositeObserver?.("notices", documentId);
    if (previousId !== next?.ownerId) {
      queueChangeNotices(documentId, previousId, next?.ownerId, cause);
    }
    // Step 4, publishing (PR 5): no body yet.
    compositeObserver?.("publish", documentId);
    // Step 5 (ownership design §4.4). For Tandem's Claude it asks
    // `waitingAtDocumentChange`: the waiting probe, then the chat that
    // follows this document (3b-2b1b-chat-step5). After the re-owe above, so
    // chat the handover has just owed again counts. For any other owner, or
    // none, the `ownership` frame (3b-2d, `frameOwedAtDocumentChange`).
    compositeObserver?.("wake", documentId);
    // Handover gap (d) (#2358 PR 3b-2b5): when the wake is sent for a change
    // that owed items again, their delivery rounds open, so `/health` does
    // not read idle while they wait. Not for a change that re-owed nothing.
    // A Release that leaves the holder the same record (Tandem's Claude's
    // `assigned`, `claimed` or `opened` falling back to `default` while it is
    // present) starts or wakes nothing (#2358 PR 5a; Bryan's pick "Skip the
    // wake (Recommended)", 2026-11-23): only a change of holder is the user
    // handing Tandem's Claude work. Scoped to `release`, so no other cause's
    // forward changes; the frame below already skips a same-holder change.
    if (
      next !== null &&
      next.ownerId === TANDEM_OWNER_ID &&
      caller !== TANDEM_OWNER_ID &&
      cause !== "take-back" &&
      !(cause === "release" && previousId === next.ownerId) &&
      waitingAtDocumentChange(documentId, next.ownerId)
    ) {
      if (startOrWake(cause) && leavesRecord) openOwedRounds([documentId], reOwed);
    } else if (frameOwedAtDocumentChange(documentId, previousId, next, cause, caller)) {
      sendOwnershipFrame();
      if (leavesRecord) openOwedRounds([documentId], reOwed);
    }
    // The reopen round (3b-2b5): the first entry of a document reopened by a
    // `tandem_open` take or a claim, before any user open's default rule.
    if (previousId === undefined && next !== null) noteReopened(documentId);
    return reOwed;
  });
}

/**
 * The chat half of a handover of `documentId` (R6.1): each unanswered,
 * non-local-period message on it that has no per-message owner follows the
 * document, so it is re-owed. Never the old owner's doc-less chat, and never
 * a message with a per-message owner. Returns the keys handed to the re-owe
 * (none when it threw). Never throws.
 */
function reOweDocumentChat(documentId: string): string[] {
  try {
    chatFaultForTests?.("re-owe");
    const keys = chatSide
      .messagesOn(documentId)
      .filter((key) => !ownerByMessage.has(key) && !carriedOver.has(key));
    if (keys.length > 0) chatSide.reOwe(keys);
    return keys;
  } catch {
    logLimited("chat-reowe-failed", CHAT_REOWE_FAILED);
    return [];
  }
}

/** What reaches step 5: a document's change, or a change of a message's owner (R6.4). */
export type WakeCause = OwnershipChangeCause | "message-owner" | "departure";

/** Fixed text: no id, no record, nothing from the error. */
const FORWARD_FAILED =
  "[ownership] a change of owner could not be passed on to Tandem's Claude; it may not have been started or woken.";

/**
 * Start or wake Tandem's Claude for returning work (ownership design §8.4 as
 * ADR-054's 3b-2b1c-a amendment rules it): the forward from step 5 to the
 * supervisor, through the sink `src/server/index.ts` sets
 * (`setStartOrWakeSink`, which calls the supervisor's `startOrWake`). Unset,
 * the sink does nothing. The supervisor refuses at the call (flag off,
 * shutdown, live Off, the licence) and its pass asks the whole waiting
 * decision (`tandemWorkWaiting`) before it wakes or starts anything, so the
 * licence refusal is the supervisor's (Critical Rule 9), not this function's.
 *
 * In order: nothing while ownership is off; the test observer is told every
 * cause (`setWakeObserverForTests`); `user-open` is dropped; a
 * `message-owner` reaches the sink as `"message"` only when its `admit`
 * answers true (3b-2b1c-b; `messageOwnerChanged`'s), and a document cause
 * carries none; a `lapse` or a `departure` (the lapse's re-ask, 3b-2b2) is
 * dropped while another session is connected ({@link anotherSessionConnected});
 * a `departure` reaches the sink as `"departure"`, every other cause as
 * `"document"`. A `presence` (a document Tandem's Claude gets back when it
 * becomes present, 3b-2b4a) is neither dropped nor gated: Bryan's pick "Yes,
 * start anyway (Recommended)" (2026-11-23, picked from options) starts it
 * for waiting work on those documents even with another session connected. The sink runs outside any MCP request context (a forward can
 * run inside another client's request: an eviction in its `initialize`,
 * `closeEntry`), in its own catch: a throw logs one fixed line and is never
 * rethrown, so the caller's change stands. Returns whether the sink was
 * called (#2358 PR 3b-2b5: a forward that went out opens the delivery
 * round of what it was for); the supervisor may still drop it.
 */
export function startOrWake(cause: WakeCause, admit?: () => boolean): boolean {
  if (!ownershipEnabled()) return false;
  wakeObserverForTests?.(cause);
  // An open is never a reason on its own (Bryan's pick 1, "No, never by
  // itself (Recommended)", picked from options); this also covers the boot, whose restored and startup documents
  // get the default rule with this cause. A later Off-to-On default rule
  // (3b-2b4; design flip-change 13) must not reuse "user-open", or this drop
  // loses its start. That default rule is `presence` (3b-2b4a), forwarded below.
  if (cause === "user-open") return false;
  try {
    // The message forward (3b-2b1c-b, R5): only an admitted change, and the
    // admit runs here, inside this catch (its scan may throw).
    if (cause === "message-owner") {
      if (admit?.() !== true) return false;
      runOutsideMcpContext(() => startOrWakeSink("message"));
      return true;
    }
    // One gate toward Bryan's pick 2 ("Only if no other session is open
    // (Recommended)", picked from options): a
    // holder going away forwards nothing while another session is connected.
    // The departing record never counts (`lapse` marks it lapsed before any
    // move). Only `lapse` is a holder going away: no other cause reaches here
    // with a caller that is not Tandem's Claude, so the others are forwarded
    // unchecked. A later writer that hands Tandem's Claude a document decides
    // its own rule. A `departure` (the lapse's re-ask, 3b-2b2) is gated the
    // same way and keeps its own name at the sink. `presence` is not gated
    // (Bryan, 2026-11-23: "Yes, start anyway (Recommended)").
    if ((cause === "lapse" || cause === "departure") && anotherSessionConnected()) return false;
    runOutsideMcpContext(() => startOrWakeSink(cause === "departure" ? "departure" : "document"));
    return true;
  } catch {
    logLimited("forward-failed", FORWARD_FAILED);
    return false;
  }
}

/**
 * Where `startOrWake` forwards (#2358 PR 3b-2b1c-a): `src/server/index.ts`
 * sets a sink that calls the supervisor's `startOrWake` through its
 * `launcherSupervisor` reference, read at call time (null does nothing). Only
 * stored; called only by a flag-on `startOrWake`.
 */
export function setStartOrWakeSink(
  sink: (cause: "document" | "message" | "departure" | "solo-release" | "mode-known") => void,
): void {
  startOrWakeSink = sink;
}

/**
 * Where a run start's wake goes (#2358 PR 3b-2b4b; ownership design §8.2,
 * §8.6): `src/server/index.ts` sets a sink that calls the supervisor's
 * `requestWake` through its `launcherSupervisor` reference, read at call time.
 * The supervisor's writer asks the licence (`requestWakeOnSpawn`), so the
 * refusal is the supervisor's (Critical Rule 9). Only stored; called only by
 * a flag-on {@link noteTandemRunStart}.
 */
export function setRequestWakeSink(sink: () => void): void {
  requestWakeSink = sink;
}

/**
 * Where the `ownership` frame goes (#2358 PR 3b-2d; ownership design §4.4,
 * §8.6, §8.7): `src/server/index.ts` sets a sink that calls the wake socket's
 * `requestOwnershipFrame`, whose writer asks the licence at the moment it
 * writes (Critical Rule 9), so the refusal is the wake socket's, as the
 * supervisor's is for `requestWake`. Only stored; called only by a flag-on
 * {@link sendOwnershipFrame}.
 */
export function setOwnershipFrameSink(sink: () => void): void {
  ownershipFrameSink = sink;
}

/**
 * Where the delivery rounds of owed work are opened (#2358 PR 3b-2b5;
 * handover gap (d), the reopen round): `src/server/index.ts` sets
 * `events/queue.ts`'s `openRoundsForOwedWork`, which opens nothing while rounds are
 * not keyed. A seam because this module never imports `events/`. Only
 * stored; called only by a flag-on change of owner, run start or reopen.
 */
export function setDeliveryRoundOpener(
  open: (owed: { documents: readonly string[]; messages: readonly string[] }) => void,
): void {
  roundOpener = open;
}

/** Fixed text: no id, no record, nothing from the error. */
const ROUNDS_FAILED =
  "[ownership] the delivery round of work owed again could not be opened; /health may read idle while it waits.";

/**
 * Open the delivery rounds of work just owed again (#2358 PR 3b-2b5): each of
 * `documentIds` whose items a fresh reader would be handed now (the waiting
 * probe, for whoever holds it, or nobody), and each of `keys` a fresh reader
 * would be handed and that was not carried over. Called only where a wake has
 * been sent for that work (step 5's forward or frame, a release's, the run
 * start's) or where a document is reopened, so no round opens for work
 * nobody is told of, a reopen aside. Outside any MCP request context and in
 * its own catch, so the change it follows stands.
 */
function openOwedRounds(documentIds: readonly string[], keys: readonly string[]): void {
  // Unwired (a unit test that sets no opener), nothing is read: the probe and
  // the chat side are asked only for a round that can be opened.
  const open = roundOpener;
  if (open === undefined) return;
  try {
    const documents = documentIds.filter((documentId) =>
      waitingProbe(documentId, ownerByDoc.get(documentId)?.ownerId ?? ""),
    );
    const owed = keys.length > 0 ? new Set(chatSide.owedToFreshReader()) : new Set<string>();
    const messages = keys.filter((key) => owed.has(key) && !carriedOver.has(key));
    if (documents.length === 0 && messages.length === 0) return;
    runOutsideMcpContext(() => open({ documents, messages }));
  } catch {
    logLimited("rounds-failed", ROUNDS_FAILED);
  }
}

/** Fixed text: no id, no record, nothing from the error. */
const FRAME_FAILED =
  "[ownership] attached sessions could not be told that work changed hands; they reach it at their next poll.";

/**
 * Ask for the payload-free `ownership` frame on `/api/wake` (#2358 PR 3b-2d):
 * outside any MCP request context (the sink arms a timer, which would
 * otherwise carry the caller's), in its own catch, so the caller's change
 * stands whatever the sink does. Unscoped until Phase 3 (ownership design
 * §9.4): every armed session is woken, and only the one the work is for, or
 * any that may claim it, finds it at its poll. Pull stays the backstop.
 */
function sendOwnershipFrame(): void {
  try {
    runOutsideMcpContext(() => ownershipFrameSink());
  } catch {
    logLimited("frame-failed", FRAME_FAILED);
  }
}

/** Fixed text: no id, no record, nothing from the error. */
const FRAME_WAITING_FAILED =
  "[ownership] whether work is waiting after a change of owner could not be read; no session was told.";

/**
 * Whether step 5 of {@link setDocOwner} sends the `ownership` frame (#2358 PR
 * 3b-2d; ownership design §4.4): the change moved the document to a record
 * that is not Tandem's Claude and is not the caller (its own poll, write,
 * post, reply or take never wakes anyone), or left it unowned, and work is
 * waiting on it ({@link workWaitingOnDocument}). Never for `take-back` (its own
 * wake rule, ownership design §8.2) or `stale` (a reader's backstop, inside a
 * check whose caller goes on to claim or refuse at once), and never when the
 * holder stays the same. A change to Tandem's Claude is the forward's
 * (`startOrWake`), never a frame. No licence term: refusal is the writer's,
 * at the write.
 */
function frameOwedAtDocumentChange(
  documentId: string,
  previousId: string | undefined,
  next: { ownerId: string } | null,
  cause: OwnershipChangeCause,
  caller: string | undefined,
): boolean {
  if (cause === "take-back" || cause === "stale") return false;
  if (previousId === next?.ownerId) return false;
  if (next !== null && (next.ownerId === TANDEM_OWNER_ID || caller === next.ownerId)) return false;
  return workWaitingOnDocument(documentId, next?.ownerId);
}

/**
 * Whether work waits on `documentId` for whoever holds it now, or for nobody
 * (#2358 PR 3b-2d): the waiting probe (the production probe, `documentWaiting`,
 * reads no owner: what a fresh reader would be handed, after every privacy
 * gate, so a Solo-held comment is never waiting), then the chat that follows
 * the document: a message a fresh reader would be handed, not carried over,
 * on this document and with no per-message owner. Read after the change, so
 * that chat's standing names the new holder, or the document's claim. Each
 * half in its own catch, read as false with one fixed, rate-limited line.
 */
function workWaitingOnDocument(documentId: string, ownerId: string | undefined): boolean {
  try {
    if (waitingProbe(documentId, ownerId ?? "")) return true;
  } catch {
    logLimited("frame-waiting", FRAME_WAITING_FAILED);
  }
  try {
    for (const key of chatSide.owedToFreshReader()) {
      if (carriedOver.has(key)) continue;
      const facts = chatSide.message(key);
      if (facts === undefined || facts.documentId !== documentId) continue;
      const standing = messageStanding(key, facts);
      if (standing.kind === "with-document") return true;
      if (standing.kind === "owned" && !standing.perMessage) return true;
    }
  } catch {
    logLimited("frame-waiting", FRAME_WAITING_FAILED);
  }
  return false;
}

/**
 * Whether messages whose per-message owner just went (a lapse, a deleted
 * record, the re-owe retry, the end of presence) or that presence alone held
 * leave work waiting for a session other than Tandem's Claude, or for nobody
 * (#2358 PR 3b-2d; ownership design §4.4): one of `keys` a fresh reader would
 * be handed, not carried over, whose standing now is another record's (it
 * follows a document that record holds), the claim of an open unowned
 * document, or claimable per message. A message now Tandem's Claude's is the
 * message forward's (`messageOwnerChanged`), and a local-period one nobody's.
 * A poll's undo of its own take (`dropChatOwners`) does not come here: that
 * restores the state before the poll, whose caller is the one asking. Reads
 * the fresh reader's set once. In its own catch: false, one fixed line.
 */
function frameOwedForMessages(keys: readonly string[]): boolean {
  try {
    const owed = new Set(chatSide.owedToFreshReader());
    for (const key of keys) {
      if (!owed.has(key) || carriedOver.has(key)) continue;
      const facts = chatSide.message(key);
      if (facts === undefined) continue;
      const standing = messageStanding(key, facts);
      if (standing.kind === "none") continue;
      if (standing.kind === "owned" && standing.ownerId === TANDEM_OWNER_ID) continue;
      return true;
    }
  } catch {
    logLimited("frame-waiting", FRAME_WAITING_FAILED);
  }
  return false;
}

const WAKE_FAILED =
  "[ownership] Tandem's Claude could not be woken for work it took back at its run start; it reaches the work at its next look.";

const FAILED_BIND_WAKE_FAILED =
  "[ownership] Tandem's Claude's unbound run could not be woken for work its failed bind left unowned; a session reaches the work at its next poll.";

/**
 * The supervisor's `requestWake` through the sink (the run start's wake, and
 * the failed-bind wake), outside any MCP request context, in its own catch.
 */
function wakeTandem(failed: string = WAKE_FAILED): void {
  try {
    runOutsideMcpContext(() => requestWakeSink());
  } catch {
    logLimited("wake-failed", failed);
  }
}

/**
 * The default rule for a document the user opened (ownership design §4.2:
 * `POST /api/open`, upload, scratchpad, `/api/convert`, startup restore,
 * `welcome.md`). Applied only to a document with **no** entry: re-opening a
 * tab that is already held must not move an `opened` or `assigned` document.
 * Called from the user-side callers only, never from `documents/open.ts`,
 * which `tandem_open` also runs. At the document's turn in its queue (#2358
 * PR 3b-2b4a; ownership design §4.3): at once when nothing is in flight,
 * otherwise after the running operation, re-checking at its turn that the
 * document still has no entry and is still open.
 */
export function applyUserOpenDefault(documentId: string): void {
  if (!ownershipEnabled()) return;
  total("applyUserOpenDefault", undefined, () => {
    if (ownerByDoc.has(documentId)) return;
    atTurnWhileUnowned(documentId, "applyUserOpenDefault", () => {
      const next = defaultRuleOwner();
      if (next) setDocOwner(documentId, next, "user-open");
      // The reopen round (#2358 PR 3b-2b5), once it has its owner, or none
      // (the entry just written already took it).
      noteReopened(documentId);
    });
  });
}

/**
 * The reopen round (#2358 PR 3b-2b5): if `documentId` was closed this run
 * and this is the first sign of its reopen (a user open's default rule, or
 * the first entry written for it), its items still owed open its delivery
 * round again ({@link openOwedRounds}: none when nothing is owed). The close
 * dropped that round, and the close's handover owed again what its holder
 * was handed. A reopen wakes nobody by itself (Bryan's pick 1; `user-open`
 * is dropped in `startOrWake`). Chat rounds survive a close.
 */
function noteReopened(documentId: string): void {
  if (reopenRoundOwed.delete(documentId)) openOwedRounds([documentId], []);
}

/**
 * Run `apply` at `documentId`'s turn in its queue, only if it then still has
 * no entry and, when the turn was deferred behind a running operation, is
 * still open (a deferred move must not give a closed document an entry). An
 * idle queue runs it at once, synchronously. A deferred throw is logged.
 */
function atTurnWhileUnowned(documentId: string, what: string, apply: () => void): void {
  let deferred = false;
  runWhenDocIdle(
    documentId,
    () => {
      if (ownerByDoc.has(documentId)) return;
      if (deferred && ![...openDocumentIds()].includes(documentId)) return;
      apply();
    },
    (err) => logLimited(`throw:${what}`, `[ownership] ${what} failed: ${errorText(err)}`),
  );
  deferred = true;
}

/** `applyUserOpenDefault` over every document open at boot (`src/server/index.ts`). */
export function applyUserOpenDefaultToDocuments(documentIds: Iterable<string>): void {
  if (!ownershipEnabled()) return;
  for (const id of documentIds) applyUserOpenDefault(id);
}

/**
 * Presence's consumer (#2358 PR 3b-2b4a; ownership design §4.2, §7.2, §8.1):
 * `src/server/index.ts` subscribes it to the supervisor's announced presence.
 * Each document moves at its turn in its queue, re-checked there (a
 * `tandem_open` queued ahead wins).
 *
 * - **Present:** every open document with no entry goes to the default rule,
 *   cause `presence`, so step 5 forwards waiting work as `"document"`,
 *   ungated (Bryan, 2026-11-23: "Yes, start anyway (Recommended)"). A
 *   `claimed`, `opened` or `assigned` document is untouched: take-back at a
 *   run start (3b-2b4b) is what moves a `claimed` one.
 * - **Not present:** every document Tandem's Claude holds goes unowned,
 *   unless it is present again by its turn, and its per-message owners are
 *   dropped (the flip-blocker row this closed): a message not handled is
 *   re-owed, and an acknowledgement's owner goes even when its message is
 *   handled (the chat side re-owes only what is not handled). Its record
 *   never lapses, so nothing else would drop them. Then the doc-less and
 *   closed-document chat it held by presence alone, with no per-message
 *   owner, is re-owed too (ownership design §7.2; 3b-2b4c), never a
 *   carried-over or handled message.
 */
export function noteTandemPresence(present: boolean): void {
  if (!ownershipEnabled()) return;
  total("noteTandemPresence", undefined, () => {
    if (present) {
      for (const documentId of [...openDocumentIds()]) {
        if (ownerByDoc.has(documentId)) continue;
        atTurnWhileUnowned(documentId, "noteTandemPresence", () => {
          const next = defaultRuleOwner();
          if (next) setDocOwner(documentId, next, "presence");
        });
      }
      return;
    }
    for (const [documentId, entry] of [...ownerByDoc]) {
      if (entry.ownerId !== TANDEM_OWNER_ID) continue;
      runWhenDocIdle(
        documentId,
        () => {
          if (ownerByDoc.get(documentId) !== entry || isTandemPresent()) return;
          setDocOwner(documentId, null, "presence");
        },
        (err) =>
          logLimited("throw:noteTandemPresence", `[ownership] presence failed: ${errorText(err)}`),
      );
    }
    // Read before the per-message owners go, so a message released below is
    // not counted again here.
    const presenceOnly = presenceOnlyChat();
    const handled = ownerByMessage.size > 0 ? handledKeysOrNone() : new Set<string>();
    releaseMessageOwners(
      TANDEM_OWNER_ID,
      (key, owner) =>
        owner.origin === "acknowledgement" || (!handled.has(key) && !carriedOver.has(key)),
    );
    // The `ownership` frame (3b-2d): chat held by presence alone is claimable now.
    if (presenceOnly.length > 0 && reOweChat(presenceOnly) && frameOwedForMessages(presenceOnly)) {
      sendOwnershipFrame();
      openOwedRounds([], presenceOnly);
    }
  });
}

/**
 * The chat Tandem's Claude held by presence alone (#2358 PR 3b-2b4c;
 * ownership design §7.2): each unhandled, non-local-period user message that
 * is doc-less or on a closed document, has no per-message owner whose record
 * exists, and was not carried over. Read once presence has ended, from the
 * facts alone (`messageStanding` would no longer name Tandem's Claude).
 * Never throws: a failed read re-owes nothing.
 */
function presenceOnlyChat(): string[] {
  try {
    return chatSide.unhandledKeys().filter((key) => {
      if (carriedOver.has(key)) return false;
      const own = ownerByMessage.get(key);
      if (own && records.has(own.ownerId)) return false;
      const facts = chatSide.message(key);
      if (facts === undefined || facts.localPeriod) return false;
      return facts.documentId === undefined || !facts.documentOpen;
    });
  } catch {
    logLimited("chat-reowe-failed", CHAT_REOWE_FAILED);
    return [];
  }
}

/**
 * Take-back, the self re-owe and their wake, at each run start of Tandem's
 * Claude (#2358 PR 3b-2b4b; ownership design §8.2 as ADR-054's 3b-1
 * amendment moves it to the bind, D-own-1). `src/server/index.ts` subscribes
 * it to the supervisor's run-start event, which follows presence's
 * announcement in the same synchronous run.
 *
 * 1. **The self re-owe.** §6.3's retire step (`handOver`) over every document
 *    Tandem's Claude already holds, and §6.5 over every unanswered user chat
 *    message it owns (per message, by following a document it holds, or
 *    doc-less or on a closed document while present), so a new run, often
 *    with a fresh cursor, is owed what the previous run was handed and did not
 *    answer. It may show again a comment answered only in chat (Bryan,
 *    2026-11-23: "Accept the duplicates (Recommended)").
 * 2. **Take-back.** Every open document that is unowned or `claimed` goes to
 *    Tandem's Claude as `default`, cause `take-back`, at its turn in its
 *    queue, re-checked there: still unowned or `claimed` by another record
 *    (an `opened` or `assigned` one, or one a `tandem_open` queued ahead now
 *    holds, is left alone), Tandem's Claude still present, and, when the
 *    turn was deferred, still open. The loser records `taken back`.
 * 3. **The wake.** After the synchronous part, if anything is waiting
 *    (`tandemWorkWaiting`, which holds a Solo-held item back), the sink's
 *    `requestWake`; a take-back that ran later, at a busy queue's turn, wakes
 *    when its document's work is waiting. Step 5 forwards nothing for
 *    `take-back` (`setDocOwner`), so this is its only wake.
 */
export function noteTandemRunStart(): void {
  if (!ownershipEnabled()) return;
  total("noteTandemRunStart", undefined, () => {
    for (const documentId of heldDocumentIds(TANDEM_OWNER_ID)) handOver(documentId);
    // The chat each re-owe step owed again, for the wake's delivery rounds
    // (#2358 PR 3b-2b5; handover gap (d)).
    const reOwed = reOweTandemChat();
    for (const documentId of [...openDocumentIds()]) {
      if (!takeBackApplies(documentId)) continue;
      let deferred = false;
      runWhenDocIdle(
        documentId,
        () => {
          if (!takeBackApplies(documentId) || !isTandemPresent()) return;
          if (deferred && ![...openDocumentIds()].includes(documentId)) return;
          const keys = setDocOwner(
            documentId,
            { ownerId: TANDEM_OWNER_ID, kind: "default" },
            "take-back",
          );
          if (!deferred) {
            reOwed.push(...keys);
          } else if (waitingAtDocumentChange(documentId, TANDEM_OWNER_ID)) {
            wakeTandem();
            openOwedRounds([documentId], keys);
          }
        },
        (err) => logLimited("throw:takeBack", `[ownership] take-back failed: ${errorText(err)}`),
      );
      deferred = true;
    }
    if (tandemWorkWaiting()) {
      wakeTandem();
      openOwedRounds(heldDocumentIds(TANDEM_OWNER_ID), reOwed);
    }
  });
}

/**
 * §6.5 over the unanswered chat Tandem's Claude owns (the self re-owe).
 * Returns the keys it re-owed (none when the re-owe failed). Never throws.
 */
function reOweTandemChat(): string[] {
  try {
    const keys = chatSide.unhandledKeys().filter((key) => {
      if (carriedOver.has(key)) return false;
      const facts = chatSide.message(key);
      if (facts === undefined) return false;
      const standing = messageStanding(key, facts);
      return standing.kind === "owned" && standing.ownerId === TANDEM_OWNER_ID;
    });
    return keys.length > 0 && reOweChat(keys) ? keys : [];
  } catch {
    logLimited("chat-reowe-failed", CHAT_REOWE_FAILED);
    return [];
  }
}

/** Whether take-back moves `documentId` now: nobody holds it, or another record holds it `claimed`. */
function takeBackApplies(documentId: string): boolean {
  const entry = ownerByDoc.get(documentId);
  return entry === undefined || (entry.kind === "claimed" && entry.ownerId !== TANDEM_OWNER_ID);
}

/**
 * The Solo-release check (#2358 PR 3b-2b4b; ownership design §8.3 "Leaving
 * Solo"): the release route verified the room reads Tandem, so work held in
 * Solo may now be waiting. Forwarded to the supervisor's start-or-wake as
 * `solo-release`; it drops the call while Off or refused by the licence, and
 * its pass asks the whole waiting decision first. Flag off: nothing.
 */
export function noteSoloReleased(): void {
  if (!ownershipEnabled()) return;
  try {
    runOutsideMcpContext(() => startOrWakeSink("solo-release"));
  } catch {
    logLimited("forward-failed", FORWARD_FAILED);
  }
}

/**
 * The mode-unknown observer's state (#2358, the restart question). In memory
 * only, so a server run starts with both false: `modeUnknownSeen` is set
 * while the mode last read unknown (the key absent, `readModeState()`'s
 * `"indeterminate"`), and `modeKnownAsked` latches the one forward a run makes.
 */
let modeUnknownSeen = false;
let modeKnownAsked = false;

/**
 * The mode-unknown observer (#2358, the restart question; Bryan, 2026-11-23:
 * "Build an observer"). `events/queue.ts` installs an observer on
 * `CTRL_ROOM`'s mode key beside the other `CTRL_ROOM` observers, so the
 * Hocuspocus document swap re-installs it, and it calls this with the mode it
 * reads at install and at every change of the key. While the mode is unknown
 * (after a restart, before a client says whether it was Solo or Tandem) the
 * waiting decision counts nothing a Solo hold could cover, so nothing starts
 * or wakes Tandem's Claude; the first time in a server run the mode then
 * reads Tandem, this asks again as the Solo release does (ownership design
 * §8.3 "Leaving Solo"): forwarded to the supervisor's start-or-wake as
 * `mode-known`, which it drops while Off or refused by the licence, and whose
 * pass asks the whole waiting decision first. A Solo reading in between
 * disarms it: Solo→Tandem is the release route's (`noteSoloReleased`), so
 * the two do not both forward a change from a Solo the room saw (a window
 * that toggled before its CTRL_ROOM sync writes only `tandem`, then posts the
 * release, so both forward; the supervisor's pass joins or repeats the ask).
 * At most once per server run. Flag
 * off: nothing, and nothing recorded. Total, since it runs inside a
 * `CTRL_ROOM` transaction's observer.
 */
export function noteModeObserved(state: "solo" | "tandem" | "indeterminate"): void {
  if (!ownershipEnabled()) return;
  if (modeKnownAsked) return;
  if (state === "indeterminate") {
    modeUnknownSeen = true;
    return;
  }
  if (state === "solo") {
    modeUnknownSeen = false;
    return;
  }
  if (!modeUnknownSeen) return;
  modeKnownAsked = true;
  try {
    runOutsideMcpContext(() => startOrWakeSink("mode-known"));
  } catch {
    logLimited("forward-failed", FORWARD_FAILED);
  }
}

/**
 * The observer's ask again, replayed once the supervisor has started (#2358,
 * the restart question). A window can reconnect and write the mode before the
 * supervisor exists (the boot's config sweep runs first, and a deferred
 * autostart creates none until the window opens), or while its `start()` has
 * set no standby yet; the forward then reaches nothing, and the once-per-run
 * latch would leave the waiting work unasked. `src/server/index.ts` calls
 * this after `start()` resolves, and it forwards `mode-known` again when the
 * observer has already asked this run; a forward that did land is asked
 * twice, which the supervisor's pass joins or repeats. Flag off: nothing.
 */
export function replayModeKnownAfterSupervisorStart(): void {
  if (!ownershipEnabled()) return;
  if (!modeKnownAsked) return;
  try {
    runOutsideMcpContext(() => startOrWakeSink("mode-known"));
  } catch {
    logLimited("forward-failed", FORWARD_FAILED);
  }
}

/**
 * The failed-bind wake (#2358 PR 3b-2b5; ownership design §8.7, R2.5):
 * `src/server/index.ts` subscribes it to the supervisor's failed-bind event.
 * That event is emitted synchronously from the judging site (the child's
 * exit, a stop's release, the bind window's timer), before the presence
 * announcement it causes, so the work is deferred to a later turn of the
 * event loop (`setImmediate`): by then presence has ended (3b-2b4a), the
 * documents Tandem's Claude held went unowned at their turn (each idle
 * queue's at once; one behind a running operation later), and step 5 sent
 * the unscoped `ownership` frame (3b-2d) for each with work waiting, which
 * covers other sessions. Then, unless Tandem's Claude is present again (a
 * later spawn bound), and only if work is stranded for a session to claim
 * ({@link strandedWorkWaiting}, which holds a Solo-held item back), the
 * supervisor's `requestWake` through the sink: it wakes a live child only
 * (the window's expiry leaves the unbound spawn running; an exit leaves
 * none) and asks the licence at its writer (Critical Rule 9), so the child,
 * as its `unbound-child` record, may claim and answer the stranded item. A
 * document still held behind a running operation is not counted yet; its
 * own step 5 frame reaches attached sessions when it moves. Flag off:
 * nothing (the supervisor emits no failed-bind event flag off either).
 */
export function noteFailedBind(): void {
  if (!ownershipEnabled()) return;
  total("noteFailedBind", undefined, () => {
    runOutsideMcpContext(() =>
      setImmediate(() => {
        total("noteFailedBind", undefined, () => {
          if (isTandemPresent()) return;
          if (strandedWorkWaiting()) wakeTandem(FAILED_BIND_WAKE_FAILED);
        });
      }),
    );
  });
}

/** Fixed text: no id, no record, nothing from the error. */
const STRANDED_FAILED =
  "[ownership] whether a failed bind left work stranded could not be read; the unbound run was not woken.";

/**
 * Whether work waits that a session other than Tandem's Claude may claim
 * (#2358 PR 3b-2b5, the failed-bind wake): an open document nobody holds
 * with items a fresh reader would be handed (the waiting probe, read for no
 * owner, after every privacy gate), or a user chat message a fresh reader
 * would be handed, not carried over, that follows such a document or is
 * claimable per message. Each half in its own catch: false, one fixed line.
 */
function strandedWorkWaiting(): boolean {
  try {
    for (const documentId of [...openDocumentIds()]) {
      if (readEntry(documentId) === undefined && waitingProbe(documentId, "")) return true;
    }
  } catch {
    logLimited("stranded-waiting", STRANDED_FAILED);
  }
  try {
    for (const key of chatSide.owedToFreshReader()) {
      if (carriedOver.has(key)) continue;
      const facts = chatSide.message(key);
      if (facts === undefined) continue;
      const standing = messageStanding(key, facts);
      if (standing.kind === "with-document" || standing.kind === "per-message") return true;
    }
  } catch {
    logLimited("stranded-waiting", STRANDED_FAILED);
  }
  return false;
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
    reopenRoundOwed.add(documentId);
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

/**
 * Which loss, if any, a change of owner records on the previous owner.
 * `nextOwnerId` is undefined for a change to unowned, which records a loss
 * only for a Release (#2358 PR 5a; ownership design §5.3: "This makes Release
 * last while Tandem's Claude is not present"). A take and a take-back always
 * name their next owner.
 */
function lossCauseOf(
  cause: OwnershipChangeCause,
  nextOwnerId: string | undefined,
): LossCause | undefined {
  if (cause === "release") return "released";
  if (cause === "assign") return "assigned";
  if (nextOwnerId === undefined) return undefined;
  if (cause === "take-back") return "taken back";
  if (cause === "take") return nextOwnerId === TANDEM_OWNER_ID ? "taken back" : "taken";
  return undefined;
}

/**
 * The cause word an ownership change gives the record it reaches, or
 * undefined when it gives none: a gain by Tandem's Claude (its record is
 * never told: `noticeRecord`), a cause with no word yet (`user-open`,
 * `presence`), the clearing of a stale entry (its record is gone), or a
 * combination no path makes (a claim never moves a document away from an
 * existing record). A loss whose loss record is `taken back`
 * (`lossCauseOf`: a take-back, or Tandem's Claude's own `tandem_open`) has
 * its own word (#2358 PR 3b-2b4c). Release and Assign (#2358 PR 5a) have
 * theirs: a Release is told only as "it was released", never that the user
 * chose it (ownership design §11.3). Undefined queues nothing, so no word
 * outside the schema can be queued.
 */
function changeCauseOf(
  cause: OwnershipChangeCause,
  change: "gained" | "lost",
  nextOwnerId: string | undefined,
): ChangeCause | undefined {
  if (change === "gained") {
    if (cause === "claim") return "your write claimed it";
    if (cause === "poll-claim") return "a poll of yours claimed it";
    if (cause === "reply-claim") return "a chat reply of yours claimed it";
    if (cause === "post-claim") return "a chat post of yours claimed it";
    if (cause === "take") return "you opened or created it";
    if (cause === "assign") return "it was assigned to this session";
    return undefined;
  }
  if (cause === "release") return "it was released";
  if (cause === "assign") return "it was assigned to another session";
  if (nextOwnerId !== undefined && lossCauseOf(cause, nextOwnerId) === "taken back") {
    return "Tandem's Claude took it back";
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
      const word = changeCauseOf(cause, change, nextId);
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
 * an ownership change (it runs the composite), so only the decisions made
 * inside the document's queue do it (`checkWrite`, `decideTake` and, since
 * PR 5a, the user's Release and Assign in `applyControl`, through
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
  // Before every other row: for such a record it replaces their copy (ownership design §5.3).
  if (guardsTandem(entry, callerId)) return { ok: false, reason: "unbound-child", holder };
  // "The first row wins" (ownership design §5.3): a caller that lost this document is told so
  // before it is told who holds it now. With no entry this row is reached only
  // by a Release: `setDocOwner` deletes the loss record on every change of
  // owner, going to unowned included, and records only `released` on one
  // (#2358 PR 5a; design §5.3: Release lasts while Tandem's Claude is not
  // present). `setLossForTests` reaches it too.
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
 * The waiting decision asks it too, for Tandem's Claude while present, over
 * the open documents its seam names (#2358 PR 3b-2b1b-claimable,
 * `claimableByTandem`).
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
  // A message's loss record (#2358 PR 5a-2; ownership design §10.2): where the
  // table would give the message back to the record it was released or
  // reassigned from, it is claimable per message by anyone else instead.
  const lost = lossByMessage.get(key)?.ownerId;
  if (facts.documentId !== undefined && facts.documentOpen) {
    const entry = readEntry(facts.documentId);
    if (entry) {
      if (entry.ownerId === lost) return { kind: "per-message" };
      return { kind: "owned", ownerId: entry.ownerId, perMessage: false };
    }
    return { kind: "with-document", documentId: facts.documentId };
  }
  if (isTandemPresent()) {
    if (lost === TANDEM_OWNER_ID) return { kind: "per-message" };
    return { kind: "owned", ownerId: TANDEM_OWNER_ID, perMessage: false };
  }
  return { kind: "per-message" };
}

/**
 * Whether `ownerId` is the record a standing loss on the message under `key`
 * names (#2358 PR 5a-2): the one its Release or Assign moved it away from,
 * which may not take it while it is claimable. Pure.
 */
function lostMessage(key: string, ownerId: string | undefined): boolean {
  return ownerId !== undefined && lossByMessage.get(key)?.ownerId === ownerId;
}

/** Whether `callerId` may take a message that is claimable per message: a record, and not a Tandem's Claude that is not present. */
function mayTakePerMessage(callerId: string | undefined): callerId is string {
  if (callerId === undefined) return false;
  if (callerId === TANDEM_OWNER_ID) return isTandemPresent();
  return records.has(callerId);
}

/**
 * What one push-stream event names, for its narrowing (#2358 PR 4a): its
 * document, and for a user `chat:message` the message's key. The SSE writer
 * builds it from the event; this module never imports `events/`.
 */
export interface PushEventScope {
  readonly documentId?: string;
  /** The user chat message's key, for a `chat:message` event only. */
  readonly chatMessageKey?: string;
}

/**
 * Whether an `/api/events` stream that sent `claudeSessionId` as its
 * `X-Claude-Session-Id` (undefined for none) gets `event` (#2358 PR 4a;
 * ownership design §9.1, R3.4). Asked by the SSE writer for each event at the
 * moment it writes it, live and on `Last-Event-ID` replay, wake-mode streams
 * included, after the queue's Solo filter and licence refusal, so it only ever
 * removes an event. The header is mapped afresh each time
 * ({@link pushStreamRecord}), so a shim that connected before its bridge
 * initialized is mapped once the record exists. An unmapped stream gets
 * exactly today's stream. A mapped stream gets an event whose document its
 * record holds or nobody holds (an entry whose record is gone reads as
 * unowned); a chat event whose message's owner (ownership design §7.1) is its
 * record, or which is claimable (it follows an open document nobody holds,
 * or is claimable per message); and every event with no document that is not
 * chat (the Solo release wake). A chat event whose row is gone, or local-period
 * chat (which is never pushed), names no owner and is not claimable, so a
 * mapped stream does not get it. **Pure**: it marks nothing handled or
 * delivered and creates no record. True at its first line while ownership is
 * off, and true when it throws (today's stream; D4: narrowing coordinates
 * sessions and is not a security boundary).
 */
export function pushStreamAdmits(
  claudeSessionId: string | undefined,
  event: PushEventScope,
): boolean {
  if (!ownershipEnabled()) return true;
  return total("pushStreamAdmits", true, () => {
    const ownerId = pushStreamRecord(claudeSessionId);
    if (ownerId === undefined) return true;
    if (event.chatMessageKey !== undefined) {
      const facts = chatSide.message(event.chatMessageKey);
      if (facts === undefined) return false;
      const standing = messageStanding(event.chatMessageKey, facts);
      if (standing.kind === "owned") return standing.ownerId === ownerId;
      // Claimable, but never by the record it was moved away from (#2358 PR 5a-2).
      return standing.kind !== "none" && !lostMessage(event.chatMessageKey, ownerId);
    }
    if (event.documentId === undefined) return true;
    const entry = readEntry(event.documentId);
    return entry === undefined || entry.ownerId === ownerId;
  });
}

/**
 * The record a push stream's `X-Claude-Session-Id` maps to, or undefined for
 * an unmapped stream (ownership design §9.1), in order: (1) Tandem's Claude's
 * session id — the current spawn's, while the own-spawn seam is set — maps to
 * the `tandem` record while Tandem's Claude is present (its run bound), for
 * reading only, otherwise to that spawn's `unbound-child` record; an id an
 * earlier child of Tandem's used, with no spawn current or not the current
 * one, is unmapped, and such an id never maps through rule 2; (2) a live
 * `claude:<id>` record (it exists and has not lapsed) maps to that record;
 * (3) anything else, or no header, is unmapped. **Pure**: creates nothing.
 */
function pushStreamRecord(claudeSessionId: string | undefined): string | undefined {
  return mapSessionHeader(claudeSessionId)?.ownerId;
}

/**
 * How an `X-Claude-Session-Id` maps (ownership design §9.1's order), shared
 * by the push stream ({@link pushStreamRecord}) and `/api/channel-reply`
 * ({@link channelReplyGate}), so the two cannot drift apart. `currentChild` is
 * rule 1's arm: the header is the current spawn's session id, which a reply
 * never acts as (ownership design §9.2, R3.3). Undefined is unmapped.
 * **Pure**: creates nothing.
 */
function mapSessionHeader(
  claudeSessionId: string | undefined,
): { readonly ownerId: string; readonly currentChild: boolean } | undefined {
  if (claudeSessionId === undefined) return undefined;
  const key = claudeIdKey(claudeSessionId);
  if (ownSpawnSource !== undefined) {
    const spawn = ownSpawnSource();
    if (spawn !== null && claudeIdKey(spawn.sessionId) === key) {
      return {
        ownerId: isTandemPresent() ? TANDEM_OWNER_ID : `spawn:${spawn.n}`,
        currentChild: true,
      };
    }
    if (ownChildCheck?.(claudeSessionId) === true) return undefined;
  }
  const ownerId = `claude:${key}`;
  const record = records.get(ownerId);
  return record !== undefined && record.lapsed !== true
    ? { ownerId, currentChild: false }
    : undefined;
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
  /**
   * Of `documentIds`, those Tandem's Claude took back from the caller, read
   * live: a standing `taken back` loss (#2358 PR 3b-2b4b), for the exclusion
   * texts. Empty for a caller with no record id, and while ownership is off.
   */
  takenBack(documentIds: readonly string[]): string[];
  /**
   * Of `documentIds`, those the user released from the caller, read live: a
   * standing `released` loss (#2358 PR 5a), for the exclusion texts. Empty
   * for a caller with no record id, and while ownership is off.
   */
  released(documentIds: readonly string[]): string[];
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
  takenBack: () => [],
  released: () => [],
});

/** Which record each drained batch came from, so a give-back reaches only that record. */
const drainedFrom = new WeakMap<InboxChangeBatch, OwnerRecord>();

/** One of the poll claim's commit-time checks, for {@link setInboxClaimCheckForTests}. */
export type InboxClaimCheck = "claimable" | "open" | "unowned" | "record" | "scope";

let claimCheckForTests: ((check: InboxClaimCheck, documentId: string) => boolean) | undefined;
/** Runs right after a poll claim's `setDocOwner`, for {@link setPollClaimAppliedForTests}. */
let pollClaimAppliedForTests: ((documentId: string) => void) | undefined;

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
        // Tests only: what a re-entrant lapse through the detached cap does
        // here (`rejudge` below), at the one point it can happen.
        pollClaimAppliedForTests?.(documentId);
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
          // Never to the record a message loss names (#2358 PR 5a-2).
          return open === "may-claim" && !lostMessage(key, callerId) ? "claim" : "neither";
        case "per-message":
          return mayTakePerMessage(callerId) && !lostMessage(key, callerId) ? "take" : "neither";
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
          // Runs before the poll's chat revert (awareness.ts), so the admit
          // reads the poll's stamps; inert while its caller is a terminal and
          // presence cannot flip between the take and this undo (R6).
          messageOwnerChanged({ key, caller: callerId });
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
    takenBack: (documentIds) =>
      documentIds.filter((id) => {
        const loss = lossByDoc.get(id);
        return callerId !== undefined && loss?.ownerId === callerId && loss.cause === "taken back";
      }),
    released: (documentIds) =>
      documentIds.filter((id) => {
        const loss = lossByDoc.get(id);
        return callerId !== undefined && loss?.ownerId === callerId && loss.cause === "released";
      }),
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
  reason: ChatReplyRefusal["details"]["reason"],
  holder: HolderView | null,
  facts: ChatMessageFacts,
  why: ChatRefusalWhy,
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
      if (standing.ownerId === TANDEM_OWNER_ID && isChildRecord(callerId)) {
        return chatRefused("unbound-child", viewOf(TANDEM_OWNER_ID), facts, "unbound-child");
      }
      return chatRefused("chat", viewOf(standing.ownerId), facts, "holder");
    case "with-document": {
      const documentId = standing.documentId;
      // The record the user released or reassigned the message from (#2358
      // PR 5a-2): not by a reply either, Ruling 4's arm included.
      const moved = messageLossRefusal(key, callerId, facts);
      if (moved) return moved;
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
      // A blocking loss on an unowned document (a Release to unowned, PR 5a)
      // is not a running operation.
      const lost = lossByDoc.get(documentId)?.ownerId === callerId;
      return chatRefused("chat", null, facts, lost ? "lost" : "busy");
    }
    case "per-message":
      // A claimable message with no open document to claim (doc-less, or on
      // a closed document): a final reply or an acknowledgement makes the
      // caller its per-message owner (design §7.1). Never the record the
      // user released or reassigned it from (#2358 PR 5a-2).
      return (
        messageLossRefusal(key, callerId, facts) ??
        accept(() => setMessageOwner(key, callerId, origin))
      );
  }
}

/**
 * The `chat` refusal for the record a message loss names, replying to a
 * message that is claimable (#2358 PR 5a-2; ownership design §10.2: "its
 * reply gets the `chat` copy"). Undefined for any other caller. A message
 * with a holder to name is not claimable, and the `owned` arm refuses it
 * first, naming that holder.
 */
function messageLossRefusal(
  key: string,
  callerId: string,
  facts: ChatMessageFacts,
): ReplyGate | undefined {
  const loss = lossByMessage.get(key);
  if (loss?.ownerId !== callerId) return undefined;
  return chatRefused("chat", null, facts, loss.cause === "released" ? "released" : "reassigned");
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
 * The `/api/channel-reply` permit (#2358 PR 4b; ownership design §9.2, §9.3,
 * R1.3, R3.3, R4.8): the same decision as `tandem_reply`'s gate, for a caller
 * the route maps itself from the shim's `X-Claude-Session-Id`, in §9.1's
 * order ({@link mapSessionHeader}). Decided **without writing anything**
 * beyond what {@link replyGate} itself may (the `tandem` record made so a
 * refusal can name it); the route appends and then calls `apply`, with no
 * `await` between, exactly as `tandem_reply` does.
 *
 * - **Tandem's Claude's session id** (rule 1, bound or not): refused with
 *   `unlinked`. A header is never enough to act as Tandem's Claude (R3.3):
 *   the bound child answers through the `tandem` server's `tandem_reply`,
 *   where its transport's bind is what identifies it.
 * - **A live `claude:<id>` record**: judged as that record by `replyGate`,
 *   replies and posts alike (ownership design §7.3, §5.5).
 * - **Unmapped** (no header, no live record, or an id an earlier child of
 *   Tandem's used): refused, with `chat` naming Tandem's Claude when the
 *   message `replyTo` names is Tandem's Claude's (one refusal instead of
 *   two), and otherwise `unlinked` (ownership design §9.3: an unmigrated
 *   direct-HTTP terminal's shim is never linked). A post names no message,
 *   so it is `unlinked`.
 *
 * `legacy` while ownership is off, so the route runs master's path.
 */
export function channelReplyGate(
  claudeSessionId: string | undefined,
  request: { replyTo?: string; inProgress?: boolean; documentId?: string },
  docs: ReplyGateDocuments,
): ReplyGate {
  if (!ownershipEnabled()) return LEGACY_REPLY;
  const mapped = mapSessionHeader(claudeSessionId);
  if (mapped !== undefined && !mapped.currentChild) return replyGate(mapped.ownerId, request, docs);
  const key = request.replyTo;
  const facts = key === undefined ? undefined : chatSide.message(key);
  if (mapped === undefined && key !== undefined && facts !== undefined) {
    if (ownsMessage(key, TANDEM_OWNER_ID)) {
      ensureRecord(TANDEM_OWNER_ID, "tandem");
      return chatRefused("chat", viewOf(TANDEM_OWNER_ID), facts, "holder");
    }
  }
  const { message, details } = unlinkedReplyRefusal(facts?.documentId);
  return { kind: "refused", stage: "ownership", code: "NOT_DOC_OWNER", message, details };
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
   * {@link greetingTransportBound}, for `tandem_reply` (#2358 PR 3b-2c):
   * through this door because `awareness.ts` imports one name from this
   * module. The caller is passed along unread.
   */
  greetingTransportBound(caller: { readonly ownerId?: string }): boolean | undefined {
    return greetingTransportBound(caller);
  },
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
  // The take guard (#2358 PR 3b-2b3b): a child record takes nothing from
  // Tandem's Claude, whatever the kind.
  if (
    entry &&
    (entry.kind === "opened" || entry.kind === "assigned" || guardsTandem(entry, callerId))
  ) {
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
// The user's controls: Release and Assign of a document, and the owners list
// (#2358 PR 5a; ownership design §10.1); Release and Assign of a chat message
// (#2358 PR 5a-2; design §10.1, §10.2). Reached only from the ownership
// route (`mcp/routes/ownership.ts`), which is registered only while ownership
// is on. Nothing here is an AI surface: the AI effect of a change (step 5's
// start-or-wake and the `ownership` frame) is refused downstream, by the
// supervisor and by each frame writer (Critical Rule 9; design §10.1, §11.5).

/**
 * How long a Release or Assign waits for the document's turn in its queue
 * before the route answers `409 busy` (ownership design §10.1: v4.1's
 * 10-second wait). Shorter than the tools' 20-second bound (`DOC_OP_WAIT_MS`)
 * on purpose: a person is waiting on a click, and a refused click changes
 * nothing, so trying again is cheap. A refused change is never queued. Never
 * longer than the queue's own limit either (`docOpWaitLimitMs`), so a test
 * that shortens that limit shortens this wait with it.
 */
export const OWNERSHIP_CONTROL_WAIT_MS = 10_000;

/** The two controls on a document (ownership design §10.1). */
export type OwnershipControlAction = "release" | "assign";

/**
 * What a Release or Assign did, for the route's answer (ownership design
 * §10.1; stories OWN-CTL-05, -07, -10): `changed` and `unchanged` are 200s
 * (`{changed}`), `unknown-owner` a 404, `owner-detached` and `busy` 409s,
 * `not-open` a 404, `cancelled` the caller went away before the turn (nothing
 * changed and nobody is answered).
 */
export type OwnershipControlOutcome =
  | "changed"
  | "unchanged"
  | "unknown-owner"
  | "owner-detached"
  | "not-open"
  | "busy"
  | "cancelled";

/** The live record carrying `label`, or undefined. Labels are unique among live records. */
function recordByLabel(label: string): OwnerRecord | undefined {
  for (const record of records.values()) if (record.label === label) return record;
  return undefined;
}

/**
 * Whether a record can be given a document now (ownership design §10.2,
 * `canTake`): Tandem's Claude only while present; stdio's one `local` record
 * whenever it exists; any other record only while it is attached and has not
 * lapsed, so a session in its grace (just disconnected) is never handed a
 * document it is about to drop (story OWN-CTL-10).
 */
function canTakeNow(record: OwnerRecord): boolean {
  if (record.recordKind === "tandem") return isTandemPresent();
  if (record.recordKind === "local") return true;
  return record.lapsed !== true && isAttached(record.ownerId);
}

/**
 * One entry of the owners list (`GET /api/ownership/owners`; ownership design
 * §10.1): a record by its label and display kind, never its owner id, with
 * the ids of the documents it holds (the route turns them into basenames) and
 * whether it can be given a document now.
 */
export interface OwnerListing {
  readonly label: string;
  readonly displayKind: DisplayKind;
  readonly holds: readonly string[];
  readonly canTake: boolean;
}

/**
 * The owners list (ownership design §10.1): every attached record, and
 * Tandem's Claude while present, in no promised order. Empty while ownership
 * is off. A reader: it writes nothing.
 */
export function ownersList(): OwnerListing[] {
  if (!ownershipEnabled()) return [];
  return total("ownersList", [] as OwnerListing[], () => {
    const listed: OwnerListing[] = [];
    for (const record of records.values()) {
      if (!canTakeNow(record)) continue;
      listed.push({
        label: record.label,
        displayKind: displayKindOf(record),
        holds: heldDocumentIds(record.ownerId),
        canTake: true,
      });
    }
    return listed;
  });
}

/**
 * Release or Assign one open document (#2358 PR 5a; ownership design §4.2,
 * §10.1), at its turn in the document's queue, waiting at most
 * {@link OWNERSHIP_CONTROL_WAIT_MS}. The caller is the user, never a record,
 * so step 5 of {@link setDocOwner} treats the new owner as someone else's
 * choice: Tandem's Claude is started or woken for waiting work through the
 * forward, any other new owner (or none) gets the `ownership` frame.
 *
 * - **Release** applies the default rule ({@link defaultRuleOwner}) and
 *   records a blocking `released` loss on the record it leaves, which lasts
 *   while the document is unowned (ownership design §5.3). A no-op
 *   (`unchanged`) on an unowned document and where the default rule would
 *   leave the entry as it is (a `default` document while Tandem's Claude is
 *   present). An entry whose record is gone is cleared at the turn
 *   (`liveEntry`) and the default rule applied: `changed`. A Release of a
 *   document Tandem's Claude holds some other way,
 *   while it is present, falls back to `default` with the same holder:
 *   `changed`, but step 5 starts or wakes nothing and sends no frame, since
 *   the holder did not change (Bryan's pick "Skip the wake (Recommended)").
 * - **Assign** gives the document to the live record carrying `ownerLabel`
 *   as `assigned`, recording a blocking `assigned` loss on the record it
 *   leaves. `unknown-owner` when no live record carries the label,
 *   `owner-detached` when it cannot take a document now
 *   ({@link canTakeNow}). A no-op (`unchanged`) when that record already
 *   holds the document, whatever kind of hold it is (Bryan's pick "Do
 *   nothing", 2026-11-23): Assign never rewrites the holder's own kind.
 *
 * `isOpen` is the registry's answer (this module never imports the
 * registry), asked at the turn: a document closed while the control waited
 * is `not-open` and gets no entry. Every decision is made at the turn, never
 * before it, so two windows' controls are serialised and the second answers
 * from the first's result (story OWN-CTL-08).
 *
 * A control that changes the document also moves the unanswered messages
 * whose per-message owner came from this document's close (#2358 PR 5a-2;
 * ownership design §7.2, {@link moveCloseDerivedChat}); a no-op control
 * moves nothing.
 */
export async function controlDocumentOwner(
  documentId: string,
  action: OwnershipControlAction,
  ownerLabel: string | undefined,
  isOpen: () => boolean,
  signal?: AbortSignal,
): Promise<OwnershipControlOutcome> {
  if (!ownershipEnabled()) return "not-open";
  try {
    return await runDocOp(documentId, () => applyControl(documentId, action, ownerLabel, isOpen), {
      waitMs: Math.min(OWNERSHIP_CONTROL_WAIT_MS, docOpWaitLimitMs()),
      ...(signal !== undefined ? { signal } : {}),
    });
  } catch (err) {
    if (err instanceof DocOpWaitExpired) return "busy";
    if (err instanceof DocOpCancelled) return "cancelled";
    throw err;
  }
}

/** The control's decision and write, at the document's turn. Synchronous. */
function applyControl(
  documentId: string,
  action: OwnershipControlAction,
  ownerLabel: string | undefined,
  isOpen: () => boolean,
): OwnershipControlOutcome {
  if (!isOpen()) return "not-open";
  // `liveEntry` clears an entry whose record is gone (the stale backstop),
  // and that clearing is itself a change of owner. A Release then still
  // applies the default rule and answers `changed`, rather than leaving the
  // document unowned beside a present Tandem's Claude and saying nothing moved.
  const hadEntry = ownerByDoc.has(documentId);
  const entry = liveEntry(documentId);
  if (action === "release") {
    if (entry === undefined) {
      if (!hadEntry) return "unchanged";
      const fallback = defaultRuleOwner();
      if (fallback !== null) setDocOwner(documentId, fallback, "release");
      return "changed";
    }
    const next = defaultRuleOwner();
    if (next !== null && next.ownerId === entry.ownerId && next.kind === entry.kind) {
      return "unchanged";
    }
    const moved = closeDerivedChat(documentId, next?.ownerId);
    setDocOwner(documentId, next, "release");
    const after = ownerByDoc.get(documentId);
    if (next === null ? after !== undefined : after?.ownerId !== next.ownerId) {
      throw new Error("the ownership entry for this document could not be written");
    }
    moveCloseDerivedChat(moved);
    return "changed";
  }
  const target = ownerLabel === undefined ? undefined : recordByLabel(ownerLabel);
  if (target === undefined) return "unknown-owner";
  if (!canTakeNow(target)) return "owner-detached";
  // Bryan's pick "Do nothing" (2026-11-23): Assign to the session that
  // already holds the document is a no-op whatever kind of hold it is.
  if (entry?.ownerId === target.ownerId) return "unchanged";
  const moved = closeDerivedChat(documentId, target.ownerId);
  setDocOwner(documentId, { ownerId: target.ownerId, kind: "assigned" }, "assign");
  const after = ownerByDoc.get(documentId);
  if (after?.ownerId !== target.ownerId || after.kind !== "assigned") {
    throw new Error("the ownership entry for this document could not be written");
  }
  moveCloseDerivedChat(moved);
  return "changed";
}

/** Thrown when a control's chat re-owe fails: nothing was changed, and the route answers 500. */
const CONTROL_REOWE_FAILED =
  "the chat this change moves could not be marked unread again, so nothing was changed";

/**
 * The messages a document's Release or Assign moves with it (#2358 PR 5a-2;
 * ownership design §7.2: "Once D is open again, Bryan's Assign or Release of
 * D also moves the unanswered messages whose per-message owner came from D's
 * close"): each unanswered message whose per-message owner has origin
 * `close` and names this document loses that owner, so it follows the
 * document again, to its new holder (or its claim, when it goes unowned).
 * Two halves around the document's `setDocOwner`, both at its turn:
 *
 * - **{@link closeDerivedChat}, before it**: picks the messages and runs the
 *   chat handover (ownership design §6.5) for those whose owner changes
 *   (`nextOwnerId` is the document's holder after the control, undefined for
 *   none): their chat entries retired, marked unread, their
 *   acknowledgements superseded. If the re-owe throws, it throws and the
 *   control changes nothing (the route answers 500).
 * - **{@link moveCloseDerivedChat}, after it**: drops their owners, then
 *   step 5 for the ones that changed ({@link wakeForMovedMessages}). After,
 *   so the document's own handover (which re-owes only chat with no
 *   per-message owner) does not re-owe a message whose close-given owner is
 *   the document's next holder: such a message only stops being owned per
 *   message, and nothing is re-owed or woken for it.
 *
 * No message loss is recorded: ownership design §10.2 records one for a
 * Release or Assign **of a message**, and this moves the messages with their
 * document (decided in 5a-2, stated in ADR-054). A handled message keeps its
 * owner (it is answered).
 */
function closeDerivedChat(
  documentId: string,
  nextOwnerId: string | undefined,
): { keys: string[]; changing: string[] } {
  const handled = ownerByMessage.size > 0 ? handledKeysOrNone() : new Set<string>();
  const keys: string[] = [];
  for (const [key, owner] of ownerByMessage) {
    if (owner.origin !== "close" || owner.closedDocumentId !== documentId) continue;
    if (handled.has(key)) continue;
    keys.push(key);
  }
  const changing = keys.filter((key) => ownerByMessage.get(key)?.ownerId !== nextOwnerId);
  if (changing.length > 0 && !reOweChat(changing)) throw new Error(CONTROL_REOWE_FAILED);
  return { keys, changing };
}

/** The second half of the move (see {@link closeDerivedChat}). Never throws. */
function moveCloseDerivedChat(moved: { keys: string[]; changing: string[] }): void {
  for (const key of moved.keys) {
    ownerByMessage.delete(key);
    lossByMessage.delete(key);
  }
  wakeForMovedMessages(moved.changing);
}

/**
 * Step 5 for messages the user's control moved (#2358 PR 5a-2; ownership
 * design §4.4, §6.5 step 3): for each that Tandem's Claude now owns with work
 * waiting, the message forward to the supervisor's start-or-wake (the user's
 * choice, so not gated on other sessions: `byUser`); once for all of them,
 * the `ownership` frame when any now waits for another session or for
 * nobody; and, when either went out, their delivery rounds. Bryan's "Skip the
 * wake (Recommended)" holds per item: a message whose holder did not change
 * is never passed here. Never throws: the change stands.
 */
function wakeForMovedMessages(keys: readonly string[]): void {
  if (keys.length === 0) return;
  total("wakeForMovedMessages", undefined, () => {
    let forwarded = false;
    for (const key of keys) if (messageOwnerChanged({ key, byUser: true })) forwarded = true;
    const framed = frameOwedForMessages(keys);
    if (framed) sendOwnershipFrame();
    if (forwarded || framed) openOwedRounds([], keys);
  });
}

/**
 * What a Release or Assign of a chat message did, for the route's answer
 * (#2358 PR 5a-2; ownership design §10.1, §10.2): `changed` and `unchanged`
 * are 200s; `unknown-message` (no user chat message has that id) and
 * `unknown-owner` are 404s; `owner-detached`, `follows-document` (the message
 * follows an open document, whose own Release and Assign move it), `answered`
 * (a final reply already answered it) and `not-controllable` (local-period
 * chat, which a local model answers) are 409s. A message carried over from
 * before a restart may be Assigned ({@link controlCarriedOver}).
 */
export type MessageControlOutcome =
  | "changed"
  | "unchanged"
  | "unknown-message"
  | "unknown-owner"
  | "owner-detached"
  | "follows-document"
  | "answered"
  | "not-controllable";

/**
 * Release or Assign one user chat message (#2358 PR 5a-2; ownership design
 * §10.1, §10.2, §6.5, §7.1). **A synchronous check-and-set, not a document
 * queue operation** (ownership design §10.1, and Bryan's "Chat replies always
 * get through": no chat decision waits behind a document's writes), so it
 * never answers `busy`: nothing is awaited between its check and its write.
 * The caller is the user, never a record.
 *
 * Which messages: the ones with no controlling badge (ownership design
 * §10.2): doc-less, on a closed document, or owned per message even on an
 * open document, and one a message loss has made claimable on an open
 * document. A message that follows an open document (owned by its holder,
 * or claimable with it) is `follows-document`.
 *
 * - **Release** drops the message's per-message owner, so the message
 *   follows ownership design §7.1's table again, and records a blocking
 *   `released` loss on that record, which the table then skips (Release
 *   always moves a message away from the record it was released from). A
 *   no-op (`unchanged`) when the message has no per-message owner.
 * - **Assign** makes the live record carrying `ownerLabel` the message's
 *   per-message owner, origin `assign`, **overwriting any owner it had**: the
 *   one exception to R3.3 (ADR-054's 5a-2 amendment). It records a blocking
 *   `assigned` loss on the record that held the message, if any. `unknown-owner`
 *   and `owner-detached` as for a document ({@link canTakeNow}). A no-op
 *   (`unchanged`) when that record already holds the message, per message or
 *   by §7.1's table (Bryan's pick "Do nothing", 2026-11-23, applied to messages).
 *
 * A change runs the chat handover first (ownership design §6.5: the entry
 * retired, the message unread, its acknowledgements superseded); if that
 * throws, this throws with nothing changed. Then step 5 for the message
 * ({@link wakeForMovedMessages}): Tandem's Claude, now its owner with the
 * message waiting, is started or woken through the forward; any other new
 * owner, or none, gets the `ownership` frame. A Release never leaves the
 * holder the same record, so Bryan's "Skip the wake (Recommended)" has no
 * case here. No change notice: `ownership.changed` reports documents only,
 * and ownership design §6.6 names none for a message.
 */
export function controlMessageOwner(
  key: string,
  action: OwnershipControlAction,
  ownerLabel: string | undefined,
): MessageControlOutcome {
  if (!ownershipEnabled()) return "unknown-message";
  const facts = chatSide.message(key);
  if (facts === undefined) return "unknown-message";
  if (facts.localPeriod) return "not-controllable";
  if (handledKeysOrNone().has(key)) return "answered";
  if (carriedOver.has(key)) return controlCarriedOver(key, action, ownerLabel);
  const standing = messageStanding(key, facts);
  const followsDocument =
    facts.documentId !== undefined &&
    facts.documentOpen &&
    (standing.kind === "with-document" || (standing.kind === "owned" && !standing.perMessage));
  if (followsDocument) return "follows-document";
  const holder = standing.kind === "owned" ? standing.ownerId : undefined;
  if (action === "release") {
    if (standing.kind !== "owned" || !standing.perMessage) return "unchanged";
    applyMessageControl(key, undefined, { ownerId: standing.ownerId, cause: "released" });
    return "changed";
  }
  const target = ownerLabel === undefined ? undefined : recordByLabel(ownerLabel);
  if (target === undefined) return "unknown-owner";
  if (!canTakeNow(target)) return "owner-detached";
  if (holder === target.ownerId) return "unchanged";
  applyMessageControl(
    key,
    target.ownerId,
    holder === undefined ? undefined : { ownerId: holder, cause: "assigned" },
  );
  return "changed";
}

/**
 * Release or Assign of a carried-over message (#2358 PR 5a-2; Bryan's pick
 * "Let Assign own them", 2026-11-23). A carried-over message (a row the
 * boot's restore brought back read and unhandled, the posts amendment's
 * R0.1) has no owner and is handed to nobody; any session may take it up.
 *
 * - **Release** is a no-op (`unchanged`): it has no owner to drop.
 * - **Assign** is the one way such a message gets an owner, an explicit,
 *   narrow exception to R0.1's "never given an owner". It **ends the
 *   message's carried-over status** in the same synchronous write that gives
 *   it its owner ({@link applyMessageControl}), so the two never overlap: a
 *   carried-over message still has no owner, everywhere. From then on it is an
 *   ordinary message owned per message, origin `assign`: the chat handover
 *   marks it unread, so its owner's next poll is handed it; every other
 *   session is refused naming the owner, as for any per-message owner; its
 *   owner's acknowledgement and final reply are judged as for any owned
 *   message; its owner's lapse re-owes it and it then follows §7.1's table.
 *   No message loss (nobody held it). It is not woken for: it was written
 *   before this server run, and only work written in this run waits (Bryan's
 *   "Written since boot", the restart row), so its owner picks it up at its
 *   next poll. `unknown-owner`, `owner-detached` as for any message; never
 *   `follows-document` (a carried-over message follows no document).
 */
function controlCarriedOver(
  key: string,
  action: OwnershipControlAction,
  ownerLabel: string | undefined,
): MessageControlOutcome {
  if (action === "release") return "unchanged";
  const target = ownerLabel === undefined ? undefined : recordByLabel(ownerLabel);
  if (target === undefined) return "unknown-owner";
  if (!canTakeNow(target)) return "owner-detached";
  applyMessageControl(key, target.ownerId, undefined, true);
  return "changed";
}

/**
 * The write of a message control (#2358 PR 5a-2), synchronous: the chat
 * handover (throws, changing nothing, if it fails), then the owner (`next`
 * undefined drops it; otherwise **overwrites** whatever owner the message
 * had, origin `assign`: the one exception to R3.3) and the message's loss
 * (`loss` undefined clears any), then step 5. `endsCarriedOver` (an Assign
 * of a carried-over message, {@link controlCarriedOver}) takes the message
 * out of the carried-over set before it gets its owner: **the one writer
 * that ends a message's carried-over status** other than its row's deletion.
 */
function applyMessageControl(
  key: string,
  next: string | undefined,
  loss: { ownerId: string; cause: LossCause } | undefined,
  endsCarriedOver = false,
): void {
  if (!reOweChat([key])) throw new Error(CONTROL_REOWE_FAILED);
  if (endsCarriedOver && next !== undefined) carriedOver.delete(key);
  if (next === undefined) ownerByMessage.delete(key);
  else ownerByMessage.set(key, { ownerId: next, origin: "assign" });
  if (loss === undefined) lossByMessage.delete(key);
  else lossByMessage.set(key, loss);
  wakeForMovedMessages([key]);
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
 * `"claim"` arm (chat following an open, unowned document) is
 * {@link claimableChatWaiting}'s (#2358 PR 3b-2b1b-claimable), asked only
 * while no other session is connected. `select` receives the facts because an
 * `owned` standing carries no document id. Unexported: `tandemWorkWaiting`
 * the step-5 composite (`waitingAtDocumentChange`) and the message forward's
 * admit (`messageOwnerChanged`, 3b-2b1c-b) call it. Synchronous; no Y.Doc, registry, read-stamp or
 * ownership write (the chat member resolves the control room with the
 * creating getter, which exists from boot). May throw: its callers
 * catch.
 */
function tandemChatWaiting(
  select: (
    key: string,
    facts: ChatMessageFacts,
    standing: Extract<MessageStanding, { kind: "owned" }>,
  ) => boolean,
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

/** Fixed text: no id, no record, nothing from the error. */
const STEP5_CHAT_FAILED =
  "[ownership] the chat that follows a document could not be read at its change of owner; it is read as nothing waiting.";

/**
 * Step 5's question (#2358 PR 3b-2b1b-chat-step5; ownership design §8.5): is
 * work waiting for `ownerId` on `documentId`, which a change has just given
 * to Tandem's Claude? Called only from step 5 of {@link setDocOwner}, after
 * the handover's re-owe, so chat it has just owed again counts.
 *
 * The waiting probe first, called exactly as step 5 called it before (a
 * throw from it is not caught here and reaches `setDocOwner`'s `total`). Only
 * when it answers false, the chat that follows the document:
 * {@link tandemChatWaiting} keeping a message only when it names this
 * document and its standing is not per message. A doc-less message, a
 * message on another document, and a message on this one with a per-message
 * owner (even Tandem's Claude's) are not counted at this document's change;
 * `tandemWorkWaiting` counts the ones Tandem's Claude owns. The chat half has
 * its own catch: a throw reads it as false and logs one fixed, rate-limited
 * line with no id and no error text. No licence term, on purpose: refusal is
 * the supervisor's, at the call. Writes nothing.
 */
function waitingAtDocumentChange(documentId: string, ownerId: string): boolean {
  if (waitingProbe(documentId, ownerId)) return true;
  // The chat half answers for Tandem's Claude only (`tandemChatWaiting`'s
  // owner filter); step 5 asks only for it, and any other owner reads false.
  if (ownerId !== TANDEM_OWNER_ID) return false;
  try {
    return tandemChatWaiting(
      (_key, facts, standing) => facts.documentId === documentId && standing.perMessage === false,
    );
  } catch {
    logLimited("waiting-step5-chat", STEP5_CHAT_FAILED);
    return false;
  }
}

const OPEN_DOCUMENTS_FAILED =
  "[ownership] the open documents could not be read for waiting; no unheld document is counted.";

/**
 * "Another session is connected" (#2358 PR 3b-2b1b-claimable; the brief's
 * ruling): some record that is not built in (`tandem`, or `local`, the
 * stdio-mode record), has not lapsed, and whose self-reported client name is
 * not Claude Desktop's, whatever its kind (the kind comes from headers, the
 * name from `initialize`). A record that has not lapsed is attached or in its
 * grace (`recompute` arms a grace whenever it is not attached), so a gone
 * session counts for its grace, and one that never held a stream counts while
 * its transport is registered, then for its grace (up to about 37 minutes with
 * the idle reaper). A lapsed record stays lapsed until attached again, even if
 * it claims while detached: not connected. Tandem's own launched Claude counts
 * until its transports reach the `tandem` record (3b-2b3; flip-blocker row).
 * Rule 0's `unbound-child` and `child-private` records count (#2358 PR
 * 3b-2b3a; Bryan, 2026-11-23: "A --resume terminal counts"), which also
 * counts a stray unbound bridge of the current child (accepted in ADR-054).
 * Unlike the supervisor's `otherAiAttached` (#2196), which judges registry
 * entries by session id and a 60-second recency. Pure.
 */
function anotherSessionConnected(): boolean {
  for (const record of records.values()) {
    if (isBuiltin(record) || record.lapsed) continue;
    if (record.clientName === CLAUDE_DESKTOP_CLIENT_NAME) continue;
    return true;
  }
  return false;
}

/**
 * Whether Tandem's Claude could claim `documentId` now, an open document
 * (#2358 PR 3b-2b1b-claimable). Present: exactly the poll's own answer,
 * `inboxScopeOf(...) === "may-claim"` (nobody holds it, its queue is idle or
 * past the bound, no blocking loss). Not present, before its first bind
 * included (Bryan's pick "Yes, even before my first Start"): nobody holds it,
 * and nothing else (a busy queue or a loss is not read; the brief's Accepted
 * 5). Pure.
 */
function claimableByTandem(documentId: string, now: number): boolean {
  if (isTandemPresent()) return inboxScopeOf(documentId, TANDEM_OWNER_ID, now) === "may-claim";
  return readEntry(documentId) === undefined;
}

/**
 * Whether some user chat message a fresh reader would be handed follows an
 * open document nobody holds that `claimable` accepts (#2358 PR
 * 3b-2b1b-claimable): the poll's `"claim"` arm, which {@link tandemChatWaiting}
 * does not count. A carried-over key is skipped, as there. Doc-less chat
 * claimable per message is not counted. May throw: its caller catches.
 */
function claimableChatWaiting(claimable: (documentId: string) => boolean): boolean {
  for (const key of chatSide.owedToFreshReader()) {
    if (carriedOver.has(key)) continue;
    const facts = chatSide.message(key);
    if (facts === undefined) continue;
    const standing = messageStanding(key, facts);
    if (
      standing.kind === "with-document" &&
      !lostMessage(key, TANDEM_OWNER_ID) &&
      claimable(standing.documentId)
    ) {
      return true;
    }
  }
  return false;
}

/**
 * Whether anything is waiting for Tandem's Claude (#2358 PR 3b-2b1b-chat,
 * widened by 3b-2b1b-claimable). Held work, always: on a document it holds
 * (the waiting probe, `documentWaiting`), or in chat it owns
 * ({@link tandemChatWaiting}). Claimable work, only while no other session is
 * connected ({@link anotherSessionConnected}; Bryan's pick "Yes, unless
 * another session is open (Recommended)"): an open document nobody holds that
 * Tandem's Claude could claim ({@link claimableByTandem}) with a user comment
 * or user thread reply waiting on it (the same probe), or chat that follows
 * such a document ({@link claimableChatWaiting}). False while ownership is off,
 * before anything is read. The supervisor's waiting decision (`workWaiting`,
 * wired in `src/server/index.ts` by 3b-2b1c-a): a start-or-wake pass asks it
 * before it wakes or starts anything. It claims nothing:
 * synchronous; it makes no Y.Doc, registry, read-stamp or ownership write (the
 * probe, `documentWaiting`, can log a legacy migration or a failed read and
 * add to an in-memory dedup set; the chat side resolves the control room with
 * the creating getter, which exists from boot). No licence term, on purpose:
 * refusal is the supervisor's, at the call. The open documents are read first,
 * in their own catch (unwired, or a throw: none, with one fixed line), so a
 * throw in either half cannot hide claimable chat; then both halves are always
 * asked, each in its own catch, so a throw in one cannot hide a waiting answer
 * from the other (inside the document half, a throw from the held probe also
 * hides its claimable arm, which shares the catch): a failed half reads as
 * false and logs one fixed, rate-limited line with no id and no error text.
 */
export function tandemWorkWaiting(): boolean {
  if (!ownershipEnabled()) return false;
  let open = new Set<string>();
  try {
    open = new Set(openDocumentIds());
  } catch {
    logLimited("waiting-open-documents", OPEN_DOCUMENTS_FAILED);
  }
  const now = performance.now();
  const claimable = (documentId: string) =>
    open.has(documentId) && claimableByTandem(documentId, now);
  // The held arm and the claimable document arm share this one catch: a
  // throw from the held probe also hides the claimable document arm (the
  // same probe answers both), never the chat half's.
  let documents = false;
  try {
    documents =
      heldDocumentIds(TANDEM_OWNER_ID).some((documentId) =>
        waitingProbe(documentId, TANDEM_OWNER_ID),
      ) ||
      (!anotherSessionConnected() &&
        [...open].some(
          (documentId) => claimable(documentId) && waitingProbe(documentId, TANDEM_OWNER_ID),
        ));
  } catch {
    logLimited("waiting-document-half", DOCUMENT_HALF_FAILED);
  }
  // Both halves run whatever the first answered (plan review M1), so a chat
  // half that throws is logged even beside a waiting document.
  let chat = false;
  try {
    chat =
      tandemChatWaiting(() => true) ||
      (!anotherSessionConnected() && claimableChatWaiting(claimable));
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
  // A child record on Tandem's Claude's document is answered by the
  // ownership check's `unbound-child` row instead, which replaces this one.
  if (guardsTandem(readEntry(documentId), callerId)) return undefined;
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
  /** #2358 PR 5a-2: each message's loss record, by chat key. */
  messageLosses: Array<[string, { ownerId: string; cause: LossCause }]>;
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
    messageLosses: [...lossByMessage].map(([key, loss]) => [key, { ...loss }]),
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

/**
 * Watch `startOrWake` (step 5): told each cause that reaches it while
 * ownership is on, before any cause is dropped or forwarded. Undefined clears it.
 */
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
/**
 * Tests only (#2358 flip-blocker row, the chat claim's `"changed"` outcome):
 * run `hook` right after a poll claim's `setDocOwner`, where a re-entrant
 * lapse through the detached cap can move the document away. Reset by
 * `resetOwnershipForTests`.
 */
export function setPollClaimAppliedForTests(
  hook: ((documentId: string) => void) | undefined,
): void {
  pollClaimAppliedForTests = hook;
}

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
  lossByMessage.clear();
  handedByRecord.clear();
  pendingClaims.clear();
  compositeObserver = undefined;
  noticeFaultForTests = undefined;
  claimCheckForTests = undefined;
  pollClaimAppliedForTests = undefined;
  scopeReadForTests = undefined;
  resetDocOpQueuesForTests();
  lastLogAt.clear();
  transportMode = undefined;
  transportView = () => [];
  presenceSource = () => false;
  ownSpawnSource = undefined;
  ownChildCheck = undefined;
  setSpawnEndedListener(undefined);
  waitingProbe = () => false;
  openDocumentIds = () => [];
  seqSource = () => 0;
  inboxHandover = () => {};
  chatSide = NO_CHAT_SIDE;
  chatFaultForTests = undefined;
  wakeObserverForTests = undefined;
  startOrWakeSink = () => {};
  modeUnknownSeen = false;
  modeKnownAsked = false;
  requestWakeSink = () => {};
  ownershipFrameSink = () => {};
  roundOpener = undefined;
  reopenRoundOwed.clear();
  graceMs = DEFAULT_GRACE_MS;
}
