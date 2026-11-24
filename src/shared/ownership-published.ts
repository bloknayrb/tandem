/**
 * The ownership state the server publishes for the editor (#2358 PR 5a-3,
 * ADR-054's 5a-3 amendment; ownership design §10.2, §10.3). PR 5b's badge,
 * popover and composer line read it; nothing in the client reads it yet.
 *
 * **Only a flag-on server writes any of it.** While ownership ships dark the
 * `Y_MAP_OPEN_DOCUMENTS` entries carry none of these keys and `CTRL_ROOM`
 * holds no {@link OwnershipSummary}, so a client must read an absent `owner`
 * key as "ownership is off" (the native menu's Release and Assign leaves are
 * omitted then) and a present `owner: null` as "unowned".
 *
 * **What it never carries** (ownership design §10.3): an owner id, an owner
 * handle, a session id or a client's self-reported name. A holder is named by
 * its server-minted label and its display kind from a closed list.
 *
 * Dependency-free: `src/shared` is imported by the client and by every bundle.
 */

/** What the badge may call a record (ownership design §10.3): a closed list. */
export type PublishedDisplayKind = "Tandem's Claude" | "terminal" | "Claude Desktop" | "other app";

/** How the holder came to hold the document (ownership design §4.1). */
export type PublishedOwnershipKind = "default" | "claimed" | "opened" | "assigned";

/** A document's holder, as the badge shows it. */
export interface PublishedOwner {
  readonly label: string;
  readonly displayKind: PublishedDisplayKind;
  readonly kind: PublishedOwnershipKind;
}

/**
 * Why the holder reads as stale (ownership design §10.2, "Stale owner"):
 * `disconnected` while it is in its grace (the composer's "(disconnected)"),
 * `not-checking-in` when the document's oldest waiting item is more than
 * {@link OWNERSHIP_STALE_AFTER_MS} old and the holder has not polled since it
 * arrived (the composer's "(not checking in)").
 */
export type PublishedOwnerStale = "disconnected" | "not-checking-in";

/**
 * The badge's hints (ownership design §10.2): `unowned-waiting` ("Unowned and
 * waiting") and `start-to-answer` ("Waiting — Start to answer").
 */
export type PublishedOwnerHint = "unowned-waiting" | "start-to-answer";

/** The fields a flag-on server adds to each `Y_MAP_OPEN_DOCUMENTS` entry. */
export interface PublishedOwnerFields {
  /** The holder, or null when the document is unowned. */
  readonly owner: PublishedOwner | null;
  readonly stale: PublishedOwnerStale | null;
  readonly hint: PublishedOwnerHint | null;
  /**
   * When the document's oldest waiting item was written (ms since the epoch),
   * set only while a hint is shown, so the client can count "waiting N min".
   * An activity disclosure (`docs/security.md`, the ownership entry).
   */
  readonly waitingSince: number | null;
}

/**
 * Why Tandem's Claude is not present (ownership design §8.1, §8.7, §10.2),
 * first match wins in this order: `off` (the user turned it off), `not-set-up`
 * (no Claude Code integration is configured), `staying-down` (an error with
 * no restart underway, or a tripped breaker), `bind-failed` (its latest run
 * failed to bind), `not-started` (anything else, a run still inside its bind
 * window included).
 */
export type NotPresentReason =
  | "off"
  | "not-set-up"
  | "staying-down"
  | "bind-failed"
  | "not-started";

/**
 * The composer summary in `CTRL_ROOM`'s `Y_MAP_USER_AWARENESS` under
 * `Y_MAP_OWNERSHIP_SUMMARY` (ownership design §10.2). Written only by a
 * flag-on HTTP-mode server with a launcher; never in stdio mode.
 */
export interface OwnershipSummary {
  readonly tandemPresent: boolean;
  /** A Tandem's Claude child process is alive. */
  readonly tandemRunning: boolean;
  /** Start can help (ownership design §10.2, "Where Start can help"). */
  readonly tandemStartable: boolean;
  /** Null while Tandem's Claude is present. */
  readonly notPresentReason: NotPresentReason | null;
  /** Some session other than Tandem's Claude is attached and can take a document. */
  readonly otherAiAttached: boolean;
  /**
   * "Chat waiting" (ownership design §10.2; #2358 PR 5d): some unanswered user
   * chat message with no controlling badge (doc-less, on a closed document,
   * owned per message, or claimable on its own) was written in this server
   * run. A message that follows an open document is that document's badge's.
   */
  readonly chatWaiting: boolean;
  /**
   * "Chat stale" (ownership design §10.2; #2358 PR 5d): one of those messages
   * has had no final answer for more than {@link OWNERSHIP_STALE_AFTER_MS}
   * since its last change of owner (its arrival, if it never had one).
   */
  readonly chatStale: boolean;
}

/**
 * How an unanswered message is held (ownership design §7.1; #2358 PR 5d):
 * - `message`: by its own per-message owner (ownership design §7.2), even on
 *   an open document;
 * - `document`: it follows its open document, held by the document's holder
 *   or claimable with it (its controls are that document's badge's);
 * - `presence`: doc-less or on a closed document, Tandem's Claude's while it
 *   is present;
 * - `none`: nobody holds it: claimable on its own, or carried over from
 *   before a restart (handed to nobody until the user Assigns it).
 */
export type PublishedChatHeldBy = "message" | "document" | "presence" | "none";

/** A message's holder, as the pickup row shows it: its label and display kind. */
export interface PublishedChatOwner {
  readonly label: string;
  readonly displayKind: PublishedDisplayKind;
}

/**
 * One unanswered user chat message's ownership facts (#2358 PR 5d; ownership
 * design §6.5, §10.2), for the pickup row's Assign and Release (PR 5e).
 */
export interface PublishedChatMessageOwner {
  /** Who holds it now (ownership design §7.1), or null when nobody does. */
  readonly owner: PublishedChatOwner | null;
  readonly heldBy: PublishedChatHeldBy;
  /**
   * Release applies (ownership design §10.2: "when it has a per-message
   * owner"): exactly the messages `POST /api/ownership`'s Release would move.
   */
  readonly release: boolean;
  /**
   * Assign applies: every message but one that follows its open document
   * (that one answers `409 follows-document`; its document's Assign moves it).
   */
  readonly assign: boolean;
  /**
   * The pickup and stall clock's start, ms since the epoch (ownership design
   * §6.5): the message's last change of owner, or its arrival if it never
   * had one. A chat handover (a re-owe) restarts it too. An activity
   * disclosure (`docs/security.md`, the ownership entry).
   */
  readonly since: number;
  /**
   * No final answer for more than {@link OWNERSHIP_STALE_AFTER_MS} since
   * `since`. Never for a message written before this server run started
   * (Bryan's "Same rule (Recommended)", the waiting rule's restart row).
   */
  readonly stale: boolean;
}

/**
 * The per-message facts under `Y_MAP_OWNERSHIP_CHAT` in `CTRL_ROOM`'s
 * `Y_MAP_USER_AWARENESS`, keyed by the message's chat key (its key in the
 * chat map). Every unanswered user chat message that is not a local model's
 * has an entry; nothing else does. Written by a flag-on server in both
 * transports; absent while ownership is off.
 */
export type PublishedChatOwners = Readonly<Record<string, PublishedChatMessageOwner>>;

/** How old a waiting item must be before the holder reads as not checking in. */
export const OWNERSHIP_STALE_AFTER_MS = 5 * 60 * 1000;

/** The stale tick (ownership design §10.2: "a 60-second server tick"). */
export const OWNERSHIP_STALE_TICK_MS = 60 * 1000;
