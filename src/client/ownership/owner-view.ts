/**
 * The editor's read of the ownership state the server publishes (#2358 PR 5b,
 * ADR-054's 5b amendment; ownership design §10.2, §10.3). Pure: no DOM, no
 * Svelte, no fetch, so every rule the badge, its popover, the native menu and
 * the composer line follow is unit-tested here.
 *
 * **Flag off renders exactly as today.** A dark server publishes no owner key
 * on any `Y_MAP_OPEN_DOCUMENTS` entry and no summary, so {@link readOwnerFields}
 * answers undefined and {@link readOwnershipSummary} null, and every view below
 * answers null: no badge, no popover, no menu leaf, no composer line. The
 * client reads no flag of its own; the server's publication is the switch.
 *
 * **Read-only.** The client never writes these keys: the server's guard
 * (5a-3) restores any client write, and Critical Rule 2's helpers are not
 * needed because nothing here writes a Y.Doc at all.
 *
 * Copy is ownership design §10.2's, verbatim where the design gives it.
 */

import type {
  NotPresentReason,
  OwnershipSummary,
  PublishedChatHeldBy,
  PublishedChatMessageOwner,
  PublishedDisplayKind,
  PublishedOwner,
  PublishedOwnerFields,
  PublishedOwnerHint,
  PublishedOwnerStale,
  PublishedOwnershipKind,
} from "../../shared/ownership-published";

const DISPLAY_KINDS: ReadonlySet<string> = new Set<PublishedDisplayKind>([
  "Tandem's Claude",
  "terminal",
  "Claude Desktop",
  "other app",
]);
const OWNERSHIP_KINDS: ReadonlySet<string> = new Set<PublishedOwnershipKind>([
  "default",
  "claimed",
  "opened",
  "assigned",
]);
const STALES: ReadonlySet<string> = new Set<PublishedOwnerStale>([
  "disconnected",
  "not-checking-in",
]);
const HINTS: ReadonlySet<string> = new Set<PublishedOwnerHint>([
  "unowned-waiting",
  "start-to-answer",
]);
const REASONS: ReadonlySet<string> = new Set<NotPresentReason>([
  "off",
  "not-set-up",
  "staying-down",
  "bind-failed",
  "not-started",
]);

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function readOwner(v: unknown): PublishedOwner | null | undefined {
  if (v === null) return null;
  if (!isRecord(v)) return undefined;
  const { label, displayKind, kind } = v;
  if (typeof label !== "string" || label.length === 0) return undefined;
  if (typeof displayKind !== "string" || !DISPLAY_KINDS.has(displayKind)) return undefined;
  if (typeof kind !== "string" || !OWNERSHIP_KINDS.has(kind)) return undefined;
  return {
    label,
    displayKind: displayKind as PublishedDisplayKind,
    kind: kind as PublishedOwnershipKind,
  };
}

/**
 * The owner fields of one `Y_MAP_OPEN_DOCUMENTS` entry, or undefined when the
 * entry carries none (a dark server: "ownership is off") or carries a shape
 * this client does not know, which it treats the same way rather than guess.
 * A present `owner: null` is "unowned".
 */
export function readOwnerFields(entry: unknown): PublishedOwnerFields | undefined {
  if (!isRecord(entry) || !("owner" in entry)) return undefined;
  const owner = readOwner(entry.owner);
  if (owner === undefined) return undefined;
  const stale =
    typeof entry.stale === "string" && STALES.has(entry.stale)
      ? (entry.stale as PublishedOwnerStale)
      : null;
  const hint =
    typeof entry.hint === "string" && HINTS.has(entry.hint)
      ? (entry.hint as PublishedOwnerHint)
      : null;
  const waitingSince =
    typeof entry.waitingSince === "number" && Number.isFinite(entry.waitingSince)
      ? entry.waitingSince
      : null;
  return { owner, stale, hint, waitingSince };
}

/**
 * The owner fields of a whole `Y_MAP_OPEN_DOCUMENTS` list, by document id,
 * holding only the entries that carry them (so a dark server's list gives an
 * empty map). Returns `prev` itself when nothing changed, so a republish that
 * changed nothing re-renders nothing.
 */
export function ownerFieldsFromList(
  list: ReadonlyArray<{ id: string }>,
  prev: ReadonlyMap<string, PublishedOwnerFields>,
): ReadonlyMap<string, PublishedOwnerFields> {
  const next = new Map<string, PublishedOwnerFields>();
  for (const entry of list) {
    const fields = readOwnerFields(entry);
    if (fields) next.set(entry.id, fields);
  }
  if (next.size !== prev.size) return next;
  for (const [id, fields] of next) {
    if (!sameOwnerFields(prev.get(id), fields)) return next;
  }
  return prev;
}

/** The composer summary under `Y_MAP_OWNERSHIP_SUMMARY`, or null when absent or malformed. */
export function readOwnershipSummary(v: unknown): OwnershipSummary | null {
  if (!isRecord(v)) return null;
  const {
    tandemPresent,
    tandemRunning,
    tandemStartable,
    notPresentReason,
    otherAiAttached,
    chatWaiting,
    chatStale,
  } = v;
  if (
    typeof tandemPresent !== "boolean" ||
    typeof tandemRunning !== "boolean" ||
    typeof tandemStartable !== "boolean" ||
    typeof otherAiAttached !== "boolean" ||
    // #2358 PR 5d: chat waiting and chat stale (read and compared here; PR 5e
    // drives the stall banner from the per-message facts, the same set).
    typeof chatWaiting !== "boolean" ||
    typeof chatStale !== "boolean"
  )
    return null;
  let reason: NotPresentReason | null = null;
  if (notPresentReason !== null) {
    if (typeof notPresentReason !== "string" || !REASONS.has(notPresentReason)) return null;
    reason = notPresentReason as NotPresentReason;
  }
  return {
    tandemPresent,
    tandemRunning,
    tandemStartable,
    notPresentReason: reason,
    otherAiAttached,
    chatWaiting,
    chatStale,
  };
}

const HELD_BY: ReadonlySet<string> = new Set<PublishedChatHeldBy>([
  "message",
  "document",
  "presence",
  "none",
]);

/** One message's published facts, or undefined for a shape this client does not know. */
function readChatOwner(v: unknown): PublishedChatMessageOwner | undefined {
  if (!isRecord(v)) return undefined;
  const { owner, heldBy, release, assign, since, stale } = v;
  let holder: PublishedChatMessageOwner["owner"] = null;
  if (owner !== null) {
    if (!isRecord(owner)) return undefined;
    const { label, displayKind } = owner;
    if (typeof label !== "string" || label.length === 0) return undefined;
    if (typeof displayKind !== "string" || !DISPLAY_KINDS.has(displayKind)) return undefined;
    holder = { label, displayKind: displayKind as PublishedDisplayKind };
  }
  if (typeof heldBy !== "string" || !HELD_BY.has(heldBy)) return undefined;
  if (typeof release !== "boolean" || typeof assign !== "boolean") return undefined;
  if (typeof since !== "number" || !Number.isFinite(since)) return undefined;
  if (typeof stale !== "boolean") return undefined;
  return { owner: holder, heldBy: heldBy as PublishedChatHeldBy, release, assign, since, stale };
}

function sameChatOwner(
  a: PublishedChatMessageOwner | undefined,
  b: PublishedChatMessageOwner,
): boolean {
  if (a === undefined) return false;
  if (
    a.heldBy !== b.heldBy ||
    a.release !== b.release ||
    a.assign !== b.assign ||
    a.since !== b.since ||
    a.stale !== b.stale
  )
    return false;
  if (a.owner === null || b.owner === null) return a.owner === b.owner;
  return a.owner.label === b.owner.label && a.owner.displayKind === b.owner.displayKind;
}

/**
 * Each unanswered message's published facts under `Y_MAP_OWNERSHIP_CHAT`
 * (#2358 PR 5d), by chat key (the message's id), keeping only the entries of
 * a shape this client knows; an empty map when the key is absent (ownership
 * off: a dark server never writes it) or not an object. Returns `prev` itself
 * when nothing changed, so a republish that changed nothing re-renders
 * nothing. Read-only: the client never writes the key (#2358 PR 5e).
 */
export function readChatOwners(
  v: unknown,
  prev: ReadonlyMap<string, PublishedChatMessageOwner>,
): ReadonlyMap<string, PublishedChatMessageOwner> {
  const next = new Map<string, PublishedChatMessageOwner>();
  if (isRecord(v)) {
    for (const [key, raw] of Object.entries(v)) {
      const facts = readChatOwner(raw);
      if (facts) next.set(key, facts);
    }
  }
  if (next.size !== prev.size) return next;
  for (const [key, facts] of next) {
    if (!sameChatOwner(prev.get(key), facts)) return next;
  }
  return prev;
}

/**
 * How long the oldest stale chat message with no controlling badge has gone
 * without a final answer since its last change of owner, in ms, or null when
 * none is stale (#2358 PR 5e; ownership design §10.2: "The stale flag, counted
 * from the message's last change of owner, only drives the stall banner").
 * The same set as the summary's `chatStale`: a message that follows its open
 * document is that document's badge's, so it is left out. The server decides
 * `stale` (and only for a message written in its run); this only measures it.
 */
export function chatStaleWaitMs(
  owners: ReadonlyMap<string, PublishedChatMessageOwner>,
  now: number,
): number | null {
  let oldest: number | null = null;
  for (const facts of owners.values()) {
    if (!facts.stale || facts.heldBy === "document") continue;
    if (oldest === null || facts.since < oldest) oldest = facts.since;
  }
  return oldest === null ? null : Math.max(0, now - oldest);
}

/** Field-wise equality, so a republish that changed nothing keeps identity. */
export function sameOwnerFields(
  a: PublishedOwnerFields | undefined,
  b: PublishedOwnerFields | undefined,
): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  if (a.stale !== b.stale || a.hint !== b.hint || a.waitingSince !== b.waitingSince) return false;
  if (a.owner === null || b.owner === null) return a.owner === b.owner;
  return (
    a.owner.label === b.owner.label &&
    a.owner.displayKind === b.owner.displayKind &&
    a.owner.kind === b.owner.kind
  );
}

export function sameSummary(a: OwnershipSummary | null, b: OwnershipSummary | null): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return (
    a.tandemPresent === b.tandemPresent &&
    a.tandemRunning === b.tandemRunning &&
    a.tandemStartable === b.tandemStartable &&
    a.notPresentReason === b.notPresentReason &&
    a.otherAiAttached === b.otherAiAttached &&
    a.chatWaiting === b.chatWaiting &&
    a.chatStale === b.chatStale
  );
}

const TANDEM: PublishedDisplayKind = "Tandem's Claude";

/**
 * How a holder is named: "Tandem's Claude" alone (it is one record, and the
 * design's composer copy names it so), otherwise the display kind and the
 * label, as the composer's "→ terminal owner-k7qx". Server-written text only
 * (ownership design §10.3): never a client's own name.
 */
export function holderName(owner: Pick<PublishedOwner, "label" | "displayKind">): string {
  return owner.displayKind === TANDEM ? TANDEM : `${owner.displayKind} ${owner.label}`;
}

/** The composer's suffixes for a stale holder (ownership design §10.2). */
export const STALE_TEXT: Record<PublishedOwnerStale, string> = {
  disconnected: "(disconnected)",
  "not-checking-in": "(not checking in)",
};

/** The badge's hints (ownership design §10.2). */
export const HINT_TEXT: Record<PublishedOwnerHint, string> = {
  "unowned-waiting": "Unowned and waiting",
  "start-to-answer": "Waiting — Start to answer",
};

/** What the badge calls an unowned document with no hint. */
export const UNASSIGNED_TEXT = "Unassigned";

/** Whole minutes since `waitingSince`, never negative (a clock skew reads 0). */
export function waitingMinutes(waitingSince: number, now: number): number {
  return Math.max(0, Math.floor((now - waitingSince) / 60_000));
}

/**
 * "waiting N min; nobody has checked in" (ownership design §10.2), for an
 * unowned document with a waiting time; null otherwise.
 */
export function waitingText(fields: PublishedOwnerFields, now: number): string | null {
  if (fields.hint !== "unowned-waiting" || fields.waitingSince === null) return null;
  return `waiting ${waitingMinutes(fields.waitingSince, now)} min; nobody has checked in`;
}

export interface BadgeView {
  /** The badge's own text. */
  readonly text: string;
  /** The longer description: the tooltip and the popover's heading. */
  readonly detail: string;
  readonly stale: PublishedOwnerStale | null;
  readonly hint: PublishedOwnerHint | null;
  /** The document's kind, or null when unowned. */
  readonly kind: PublishedOwnershipKind | null;
}

/**
 * What a document's owner fields say, whether or not the badge is shown: the
 * badge's text and the longer description its tooltip and popover heading
 * carry. The native menu's Assign leaf opens the popover on a document whose
 * badge is hidden, so the popover needs this unconditionally.
 */
export function describeOwner(fields: PublishedOwnerFields, now: number): BadgeView {
  const { owner, stale, hint } = fields;
  const name =
    owner === null
      ? UNASSIGNED_TEXT
      : stale === null
        ? holderName(owner)
        : `${holderName(owner)} ${STALE_TEXT[stale]}`;
  const held = owner === null ? name : `${name} · ${owner.kind}`;
  if (hint !== null) {
    const parts = [HINT_TEXT[hint]];
    if (owner !== null) parts.push(held);
    const waiting = waitingText(fields, now);
    if (waiting !== null) parts.push(waiting);
    return {
      text: HINT_TEXT[hint],
      detail: parts.join(" — "),
      stale,
      hint,
      kind: owner?.kind ?? null,
    };
  }
  return { text: name, detail: held, stale, hint, kind: owner?.kind ?? null };
}

/**
 * The badge for one document, or null when it is not shown (ownership design
 * §10.2: "shown only when it says something"): whenever a record other than
 * Tandem's Claude is attached, when the document is held by a record other
 * than Tandem's Claude, or when a hint is active. A lone Tandem's Claude, or
 * no AI at all, shows no badge unless a hint is active. No fields (ownership
 * off) is always null.
 */
export function badgeView(
  fields: PublishedOwnerFields | undefined,
  summary: OwnershipSummary | null,
  now: number,
): BadgeView | null {
  if (!fields) return null;
  const heldByOther = fields.owner !== null && fields.owner.displayKind !== TANDEM;
  const otherAttached = summary?.otherAiAttached === true;
  if (!heldByOther && !otherAttached && fields.hint === null) return null;
  return describeOwner(fields, now);
}

/** Release's two destinations (ownership design §10.2). */
export const RELEASE_TO_TANDEM_TEXT = "Back to Tandem's Claude";
export const RELEASE_UNASSIGNED_TEXT =
  "Unassigned — the next session to check in takes it, or Tandem's Claude when it is turned on; this one won't take it back on its own";

/**
 * Whether Release is offered (ownership design §10.2): hidden where it would
 * change nothing, on an unowned document and on a `default` document while
 * Tandem's Claude is present. Null fields (ownership off) never offer it.
 */
export function canRelease(
  fields: PublishedOwnerFields | undefined,
  summary: OwnershipSummary | null,
): boolean {
  if (!fields || fields.owner === null) return false;
  return !(fields.owner.kind === "default" && summary?.tandemPresent === true);
}

/** Where a Release sends the document: back to Tandem's Claude while it is present. */
export function releaseGoesToTandem(summary: OwnershipSummary | null): boolean {
  return summary?.tandemPresent === true;
}

/**
 * Whether the native menu's Assign leaf is offered. The leaf opens the
 * popover, whose list comes from `GET /api/ownership/owners` and hides
 * Assign when that list is empty (ownership design §10.2); the menu cannot
 * wait for the fetch, so it offers the leaf when the summary says some
 * record can take a document (Tandem's Claude present, or another session
 * attached), and with no summary (stdio mode, or no launcher) whenever the
 * entry carries owner fields.
 */
export function mayAssign(
  fields: PublishedOwnerFields | undefined,
  summary: OwnershipSummary | null,
): boolean {
  if (!fields) return false;
  if (summary === null) return true;
  return summary.tandemPresent || summary.otherAiAttached;
}

/**
 * Whether Start is offered on a badge (ownership design §10.2: a hint
 * "offers Assign, and Start where Start can help").
 */
export function badgeOffersStart(
  fields: PublishedOwnerFields | undefined,
  summary: OwnershipSummary | null,
): boolean {
  return !!fields && fields.hint !== null && summary?.tandemStartable === true;
}

/**
 * The names of the documents a Start would take back (ownership design §8.2,
 * §10.2: "Every Start control that will take back `claimed` documents …
 * says so and lists them by name"): those another session holds as `claimed`.
 */
export function takeBackNames(
  entries: ReadonlyArray<{ fileName: string; fields: PublishedOwnerFields | undefined }>,
): string[] {
  return entries
    .filter(
      (e) =>
        e.fields?.owner != null &&
        e.fields.owner.kind === "claimed" &&
        e.fields.owner.displayKind !== TANDEM,
    )
    .map((e) => e.fileName);
}

/** The sentence a Start control adds when it will take documents back. */
export function takeBackText(names: readonly string[]): string | null {
  if (names.length === 0) return null;
  return `Starting takes back ${names.map((n) => `“${n}”`).join(", ")}`;
}

/** The bind-failed pointer, verbatim (ownership design §8.7). */
export const NO_AI_BIND_FAILED_TEXT =
  "No AI will answer — Tandem's Claude couldn't connect its Tandem tools (see Settings)";
export const NO_AI_TEXT = "No AI will answer";

export type ComposerLine =
  | { readonly kind: "to"; readonly text: string }
  | { readonly kind: "none"; readonly text: string; readonly remedy: "start" | "settings" };

function tandemLine(summary: OwnershipSummary | null): ComposerLine | null {
  if (summary === null) return null;
  if (summary.tandemPresent && summary.tandemRunning) {
    return { kind: "to", text: "→ Tandem's Claude" };
  }
  return null;
}

function willStart(summary: OwnershipSummary | null): ComposerLine | null {
  if (summary?.tandemStartable === true && !summary.tandemRunning) {
    return { kind: "to", text: "→ Tandem's Claude (will start)" };
  }
  return null;
}

function noAi(summary: OwnershipSummary | null): ComposerLine {
  if (summary?.notPresentReason === "bind-failed") {
    return { kind: "none", text: NO_AI_BIND_FAILED_TEXT, remedy: "settings" };
  }
  return {
    kind: "none",
    text: NO_AI_TEXT,
    remedy: summary?.tandemStartable === true ? "start" : "settings",
  };
}

const FIRST_TO_CHECK_IN: ComposerLine = { kind: "to", text: "→ the first session to check in" };

/**
 * The composer's "who answers" line (ownership design §10.2): from the active
 * document's owner fields when a tab is active and its entry carries them,
 * otherwise from the summary alone (no tab: a doc-less message, which
 * Tandem's Claude owns by presence and anyone may claim otherwise, §7.1).
 * Null when neither is published (ownership off: the composer is unchanged).
 *
 * `active` is the active tab's fields: `undefined` when there is no active
 * tab or its entry carries none.
 */
export function composerLine(
  active: PublishedOwnerFields | undefined,
  summary: OwnershipSummary | null,
): ComposerLine | null {
  if (active) {
    const { owner, stale } = active;
    if (owner !== null) {
      if (owner.displayKind === TANDEM) {
        if (summary === null) return { kind: "to", text: "→ Tandem's Claude" };
        if (summary.tandemPresent) {
          return summary.tandemRunning
            ? { kind: "to", text: "→ Tandem's Claude" }
            : { kind: "to", text: "→ Tandem's Claude (will start)" };
        }
        return noAi(summary);
      }
      const name = holderName(owner);
      return { kind: "to", text: stale === null ? `→ ${name}` : `→ ${name} ${STALE_TEXT[stale]}` };
    }
    // Unowned: the first session to check in claims it; with no other
    // session attached, Tandem's Claude when today's rule would start it.
    if (summary === null || summary.otherAiAttached) return FIRST_TO_CHECK_IN;
    if (summary.tandemPresent && summary.tandemRunning) return FIRST_TO_CHECK_IN;
    return willStart(summary) ?? noAi(summary);
  }
  if (summary === null) return null;
  // No tab (ownership design §7.1): Tandem's Claude by presence, else claimable.
  if (summary.tandemPresent) {
    return tandemLine(summary) ?? { kind: "to", text: "→ Tandem's Claude (will start)" };
  }
  if (summary.otherAiAttached) return FIRST_TO_CHECK_IN;
  return willStart(summary) ?? noAi(summary);
}

/** A control's refusal, in words (ownership design §10.1's answers). */
export function ownershipErrorText(code: string | null): string {
  switch (code) {
    case "busy":
      return "An operation is in progress — try again";
    case "owner-detached":
    case "unknown-owner":
      return "That session just disconnected — pick another or Release";
    case "unknown-document":
      return "This document is no longer open";
    default:
      return "Couldn't change who works on this document — try again";
  }
}
