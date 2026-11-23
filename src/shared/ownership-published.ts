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
}

/** How old a waiting item must be before the holder reads as not checking in. */
export const OWNERSHIP_STALE_AFTER_MS = 5 * 60 * 1000;

/** The stale tick (ownership design §10.2: "a 60-second server tick"). */
export const OWNERSHIP_STALE_TICK_MS = 60 * 1000;
