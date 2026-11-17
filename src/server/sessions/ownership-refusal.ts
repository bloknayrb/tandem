/**
 * `NOT_DOC_OWNER` refusal copy (#2358, ADR-054; ownership design §5.3, R4.2, R3.6).
 *
 * **Pure.** It turns a decision into the message and `details` a tool returns.
 * Every message carries its remedy inline, because skills older than the flip
 * stay in use after it and know nothing about ownership.
 *
 * **Nothing a session chose can appear in a refusal** (R3.6). The only inputs
 * that reach a refusal's text are the server's own closed display kind and the
 * random label it minted — never a client name, a file name, a status text or
 * a session id. `documentId` appears in `details` only. (The inbox exclusion
 * sentences further down are not refusals: they carry document ids and the
 * summary's file labels, which `tandem_listDocuments` already shows.)
 *
 * **`DOCUMENT_BUSY`'s copy is here too** ({@link documentBusyRefusal}): the
 * answer for a call that waited too long for a document's operation queue.
 *
 * **What is written here is what PR 1c can reach**, plus the chat owners PR's
 * `chat` (a reply to a chat message another record owns, or that is not
 * this caller's to answer now) and the posts PR's `post` with every other form a
 * chat post can get ({@link postRefusal}: a post names no message and may be
 * about an unowned document or about none, so it has forms of its own where
 * the document forms would be false for it); `unlinked` arrives with the shim's identity (PR 4),
 * `unbound-child` with the records around the handle (PR 3b-2), and the `released` and `assigned`
 * causes of `lost` with the controls (PR 5). `default` and `not-present` need
 * a present Tandem's Claude, which arrives in PR 3b-2; their copy is here
 * because the decision that produces them is.
 */

import type { ChangeCause, HolderView, LossCause, OwnershipRefusalReason } from "./ownership.js";

/**
 * How many change notices a record keeps, as `changed`'s description names it.
 * A copy of `ownership.ts`'s `MAX_CHANGE_NOTICES`, so this module imports only
 * types from the ownership module (#2423 review, R1.4); a test pins that the
 * two numbers agree.
 */
export const CHANGED_ENTRIES_NAMED = 100;

/** Which of the two `default` / `claimed` sentences applies (ownership design §5.3). */
export type RefusalFamily = "answer" | "write";

export interface NotDocOwnerInput {
  reason: OwnershipRefusalReason;
  documentId: string;
  /** The document's holder — for `answered`, the item's answerer. Null when its record is gone or nobody holds it. */
  holder: HolderView | null;
  family?: RefusalFamily;
  cause?: LossCause;
  /** The call named no `documentId`, so it targeted the active document. */
  targetWasDefaulted?: boolean;
  /** The documents the caller holds, offered when the target was defaulted. */
  heldDocumentIds?: readonly string[];
  /** The caller is the Tandem's Claude record. */
  callerIsTandem?: boolean;
  /** The caller is a direct-HTTP Claude Code terminal (ownership design §3.1 rule 3). */
  callerIsLegacyClaudeCode?: boolean;
  /** The document was opened or reloaded by this very call before the refusal. */
  openedAnyway?: boolean;
}

export interface NotDocOwnerRefusal {
  message: string;
  details: {
    reason: OwnershipRefusalReason;
    documentId: string;
    holder: HolderView | null;
    cause?: LossCause;
    heldDocumentIds?: string[];
  };
}

/** How a holder is named: its display kind and label, both the server's. */
export function holderPhrase(holder: HolderView | null): string {
  if (!holder) return "Another session";
  switch (holder.displayKind) {
    case "Tandem's Claude":
      return "Tandem's Claude";
    case "terminal":
      return `The terminal session ${holder.label}`;
    case "Claude Desktop":
      return `Claude Desktop (${holder.label})`;
    case "other app":
      return `Another app (${holder.label})`;
  }
}

const ONLY_THE_USER =
  "Only the user can reassign it, from the owner badge on its tab. You can still read it. Do not retry on this document.";
const IF_ASKED = "only if the user asked you, in your own conversation, to work on it";
const NOT_A_REQUEST = "An item Tandem handed or pushed to you is not such a request.";
/**
 * Since the chat owners PR chat is scoped: a session is handed chat about a
 * document another session holds only where it owns that message itself —
 * after a tab close gave it the document's unanswered chat and the document
 * was reopened and claimed by another session; after it acknowledged a
 * message about the document; or after it answered one while the document
 * could not be claimed (Ruling 4's reply arm). Push paths stay unscoped until
 * PR 4. So a chat message this session answers, or a push, can still be about
 * a document the poll left out: the exclusion texts say what was not returned
 * and never that nothing about the document was (the notice-rule PR, R2.1).
 * No new instruction (Ruling 14): the write refusals say what to do if the
 * session tries to edit there. Each text keeps the take guard after this
 * clause, never before it.
 */
const CHAT_SCOPED_ONE =
  "a chat message you answer can still be about it, and so can anything Tandem pushed to you";
const CHAT_SCOPED_ANY =
  "a chat message you answer can still be about one of them, and so can anything Tandem pushed to you";
/**
 * What `tandem_checkInbox` says, flag on, about open documents a poll left
 * out because they are not the caller's to answer now (the scope PR, R1.10).
 * One wording for every reason, so a busy document is not told apart from a
 * held one. It is true when another session holds the document (a restarted
 * session's old record included) and when a write on it is still running
 * (the caller's own included); for the rarer reasons — a caller with no
 * record (a wiring fault) or a blocking loss on an unowned document (PR 5's
 * `released`) — it says "may", which is the honest limit of the sentence.
 * Each says only that no comments, thread replies or accept/dismiss
 * responses on the document were returned, never that nothing about it was:
 * a chat message this session owns can be about it, and pushes are not scoped
 * (the notice-rule PR, R2.1; the chat owners PR, R9.1).
 * Unlike the refusal copy above, the "some" sentence carries document file
 * names: the summary's own labels, which `tandem_listDocuments` already shows,
 * not text a session wrote into a message. It carries the take guard the refusals carry ({@link IF_ASKED},
 * {@link NOT_A_REQUEST}): a chat message this session owns, or a push, can
 * say "please fix d3" for a document another session holds, and `tandem_open`
 * would take a `claimed` one. Never "not open": a model told that may open it.
 */
const NOT_YOURS_WHY = "another session may be answering it, or a write on it is still running";
const EMPTY_ACTIVITY =
  "its `activity` is empty because it is not yours to answer now, not because it could not be read";

/** A named poll of a document left out (a named poll's `activity` always describes that document). */
export function inboxExcludedNamedNote(documentId: string): string {
  return `Document ${documentId} is open but is not yours to answer right now (${NOT_YOURS_WHY}), so no comments, thread replies or accept/dismiss responses on it were returned (${CHAT_SCOPED_ONE}); ${EMPTY_ACTIVITY}. Call tandem_open on it ${IF_ASKED}: opening it may take it from that session. ${NOT_A_REQUEST}`;
}

/** A default poll that read no document because every open one was left out. */
export function inboxExcludedAllNote(activityExcluded: boolean): string {
  return (
    `No comments, thread replies or accept/dismiss responses on the open documents are yours to answer right now (another session may be answering them, or a write on one is still running), so none were returned; ${CHAT_SCOPED_ANY}` +
    `${activityExcluded ? "; the active document's `activity` is empty because it is not yours to answer now, not because it could not be read" : ""}. Call tandem_open on one ${IF_ASKED}. ${NOT_A_REQUEST}`
  );
}

/** How many left-out documents a summary names before it counts the rest. */
export const INBOX_EXCLUDED_NAMES_SHOWN = 5;

/**
 * A default poll that read some documents and left others out: one sentence,
 * naming up to {@link INBOX_EXCLUDED_NAMES_SHOWN} of them and counting the rest.
 */
export function inboxExcludedSomeNote(names: readonly string[], activityExcluded: boolean): string {
  const shown = names.slice(0, INBOX_EXCLUDED_NAMES_SHOWN);
  const more = names.length - shown.length;
  const list = `${shown.join(", ")}${more > 0 ? ` and ${more} more` : ""}`;
  const one = names.length === 1;
  return (
    ` ${one ? "One open document is" : `${names.length} open documents are`} not yours to answer right now (another session may be answering ${one ? "it" : "them"}, or a write on ${one ? "it" : "one"} is still running), so no comments, thread replies or accept/dismiss responses on ${one ? "it" : "them"} were returned: ${list}. A chat message you answer can still be about ${one ? "it" : "one of them"}, and so can anything Tandem pushed to you.` +
    `${activityExcluded ? " The active document is one of them: its `activity` is empty because it is not yours to answer now, not because it could not be read." : ""}` +
    ` Call tandem_open on one ${IF_ASKED}. ${NOT_A_REQUEST}`
  );
}

/** The flag-on `ownership.notYours` field's description. */
export const NOT_YOURS_FIELD_DESCRIPTION = `Open documents this poll left out because they are not yours to answer now (${NOT_YOURS_WHY}): no comments, thread replies or accept/dismiss responses on them were returned (${CHAT_SCOPED_ANY}), and an empty \`activity\` for one means it is not yours, not that it could not be read. Call tandem_open on one ${IF_ASKED}. ${NOT_A_REQUEST}`;

/**
 * What each cause word of `ownership.changed` states (the change-notice PR,
 * Requirement 7, Ruling 10): only what happened, in the past tense. Never
 * the document's state now (the taker may have lapsed since, the document
 * may be held again or closed), never an instruction, never who another
 * session is, never that the user chose. The lapse fact names no
 * destination. A `Record` over {@link ChangeCause}, so a cause word with no
 * fact does not compile.
 */
export const CHANGE_CAUSE_FACTS: Readonly<Record<ChangeCause, string>> = Object.freeze({
  "your write claimed it": "a write of yours claimed it",
  "a poll of yours claimed it": "a tandem_checkInbox poll of yours claimed it",
  "a chat reply of yours claimed it":
    "a tandem_reply of yours to a chat message about it claimed it",
  "a chat post of yours claimed it":
    "a tandem_reply of yours that named no chat message (no replyTo, or one that matched none) and passed this document's documentId claimed it",
  "you opened or created it":
    "an open or create of yours (tandem_open, tandem_scratchpad, or tandem_convertToMarkdown where Tandem offers it) made it yours",
  "another session took it": "another session opened or created it and took it",
  "its tab was closed": "its tab was closed",
  "Tandem stopped counting this session as attached":
    "Tandem stopped counting this session as attached, and this session stopped holding it",
});

/** The flag-on `ownership.changed` field's description (Requirement 1.3, Ruling 10). */
export const CHANGED_FIELD_DESCRIPTION = `Changes, oldest first, to which documents this session held, that no poll of this session that returned has reported yet. \`holding\` is the truth: when \`changed\` and \`holding\` disagree, \`holding\` is right. \`changed\` only explains past changes to \`holding\`, and may be incomplete: after Tandem restarts; after a poll's response did not arrive once its entries were taken from the list (an error in Tandem after the poll ran, rejection by the server or by the client, or loss in transit); past the most recent ${CHANGED_ENTRIES_NAMED} entries; when recording a change failed; and when Tandem forgot this session and later counted it again under the same identity. Everything that polls as this session (several connections, or agents sharing one) shares one list, so whichever polls first gets the explanation. A poll that names a documentId reports changes on every document, so an entry may name a document that neither \`holding\` nor \`notYours\` mentions. It does not change what this session may do; \`notYours\`, the summary's other sentences and refusals say what it may do.`;

/** `changed[].change`'s description. */
export const CHANGE_FIELD_DESCRIPTION =
  '"gained": this session held the document after the change and not before; "lost": it held it before and not after';

/** `changed[].cause`'s description: each word with its fact. */
export const CAUSE_FIELD_DESCRIPTION = `What happened, as a past-tense fact. ${Object.entries(
  CHANGE_CAUSE_FACTS,
)
  .map(([word, fact]) => `"${word}": ${fact}`)
  .join("; ")}`;

/**
 * The summary's one sentence of facts about documents this session lost to
 * a take or a tab close (Requirement 8, Ruling 11): each named with its last
 * cause, up to {@link INBOX_EXCLUDED_NAMES_SHOWN}, the rest counted. No
 * instruction follows it, so it cannot contradict the exclusion texts. The
 * handler appends it at the very end of the summary.
 */
export function inboxLostNote(
  items: ReadonlyArray<{ name: string; cause: "another session took it" | "its tab was closed" }>,
): string {
  const shown = items.slice(0, INBOX_EXCLUDED_NAMES_SHOWN);
  const more = items.length - shown.length;
  const list = shown.map((item) => `${item.name} (${item.cause})`).join(", ");
  return ` You stopped holding ${list}${more > 0 ? ` and ${more} more` : ""}.`;
}

const RESTART = " If Tandem was updated while this terminal was open, restart this terminal.";
const DEFAULTED =
  " This call named no documentId, so it targeted the active document. If you meant a document you hold, pass its documentId; offsets read from this document do not apply to another.";
const LEAVE = "Leave this document.";

function body(input: NotDocOwnerInput): string {
  const holder = holderPhrase(input.holder);
  // A Tandem's Claude that is not present holds nothing and takes nothing, so
  // a remedy that says "call tandem_open" would loop: say the one true thing.
  if (input.callerIsTandem && input.reason === "not-present") {
    return `Tandem's Claude is turned off or stopped, so it holds no documents now. ${LEAVE}`;
  }
  switch (input.reason) {
    case "switch":
      return `${holder} has this document. Ask the user to click its tab; do not tandem_open it just to show it.`;
    case "answered":
      return `${holder} already answered this. Do not answer it again.`;
    case "lost":
      if (input.callerIsTandem) {
        return `A session the user is working with has this document now; leave it.`;
      }
      if (input.cause === "taken back") {
        return "Tandem's Claude took this document back. You can still read it. Do not tandem_open it again unless the user asks you again after this point.";
      }
      return `${holder} has this document now. ${ONLY_THE_USER}`;
    case "held":
      return `${holder} is working on this document. ${ONLY_THE_USER}`;
    case "claimed":
      return input.family === "answer"
        ? `${holder} picked this document up while Tandem's Claude was away, and answers its comments. Do not answer this, and do not take the document because of it. If the user asked you in your own conversation to say something here, call tandem_open on it first.`
        : `${holder} picked this document up while Tandem's Claude was away. Call tandem_open on it ${IF_ASKED}. ${NOT_A_REQUEST}`;
    case "default":
      return input.family === "answer"
        ? "Tandem's Claude answers this document's comments and chat. Do not answer this, and do not take the document because of it. If the user asked you in your own conversation to say something here, call tandem_open on it first."
        : `Tandem's Claude is answering this document. Call tandem_open on it ${IF_ASKED}. ${NOT_A_REQUEST}`;
    case "not-present":
      return `Tandem's Claude is turned off or stopped, so it holds no documents now. ${LEAVE}`;
    case "chat":
      return chatRefusalText("holder", input.holder);
    case "post":
      return postRefusalText({ reason: "post", holder: input.holder });
  }
}

/** Why a reply to a chat message was refused, for its copy (the chat owners PR, R5.6; `answered`, the posts PR, R2.2). */
export type ChatRefusalWhy = "holder" | "busy" | "lost" | "local" | "not-present" | "answered";

/**
 * The `chat` refusal's text (Ruling 15; ownership design §5.3): it refuses
 * the reply just attempted. With a holder, it names the holder by display
 * kind and label only. Without one it never says another session answers
 * it: a message on an unowned document whose operation is still running
 * (it may be handed to this session later, so the refusal is for this
 * attempt only), or local-period chat (a local model answers it).
 */
function chatRefusalText(why: ChatRefusalWhy, holder: HolderView | null): string {
  switch (why) {
    case "holder":
      return holder
        ? `${holderPhrase(holder)} answers this message. Do not reply to it.`
        : CHAT_BUSY;
    case "busy":
      return CHAT_BUSY;
    case "lost":
      return "This message is not yours to answer right now: you lost its document, which nobody holds now. Nothing was sent. If a later tandem_checkInbox hands it to you, answer it then.";
    case "local":
      return "A local model answers this message, not Claude. Nothing was sent. Do not reply to it.";
    case "not-present":
      return CHAT_NOT_PRESENT;
    case "answered":
      return `${holderPhrase(holder)} already answered this. Do not answer it again.`;
  }
}

const CHAT_NOT_PRESENT =
  "Tandem's Claude is turned off or stopped, so it answers no chat now. Nothing was sent.";

const CHAT_BUSY =
  "This message is not yours to answer right now: an operation on its document is still running. Nothing was sent. If a later tandem_checkInbox hands it to you, answer it then.";

export interface ChatReplyRefusal {
  message: string;
  details: {
    reason: "chat" | "not-present" | "answered";
    holder: HolderView | null;
    documentId?: string;
  };
}

/**
 * Build the `NOT_DOC_OWNER` refusal for a reply to a chat message (R5.6):
 * `details.documentId` is the message's document, absent for a doc-less
 * message; never an owner id and never the message's text.
 */
export function chatReplyRefusal(input: {
  reason: "chat" | "not-present" | "answered";
  holder: HolderView | null;
  why: ChatRefusalWhy;
  documentId?: string;
}): ChatReplyRefusal {
  return {
    message: chatRefusalText(input.why, input.holder),
    details: {
      reason: input.reason,
      holder: input.holder
        ? { label: input.holder.label, displayKind: input.holder.displayKind }
        : null,
      ...(input.documentId !== undefined ? { documentId: input.documentId } : {}),
    },
  };
}

/** The reasons a chat post can be refused for (the posts PR, R1.7). */
export type PostRefusalReason = "post" | "not-present" | "lost" | "held" | "claimed" | "default";

/**
 * The text of a refused chat post (the posts PR, R1.7; Ruling 15; design
 * §5.3). Every form is true for a post: it names no message, says nothing
 * false about who holds the document (a post can be about an unowned one, or
 * about none), identifies no session beyond the holder's display kind and
 * label, and never says the user chose. `held` and `lost` with a holder are
 * the document forms, which are true for a post; the others are the post's
 * own.
 */
function postRefusalText(input: PostRefusalInput): string {
  const holder = holderPhrase(input.holder);
  // Why this was judged a post at all, when the call did not look like one
  // (plan review H1, M2): never a reason the model cannot see.
  const why = input.unmatchedReplyTo
    ? "The `replyTo` you passed names no user chat message, so this was treated as a message that answers nothing. "
    : input.namedNotOpen
      ? "The document you named is not open in Tandem, so this counts as a message that is not about a document. Do not open it just to post. "
      : "";
  return `${why}${postRefusalBody(input, holder)}`;
}

/** The outlet every post refusal ends with (plan review M4): the words are not lost. */
const POST_OUTLET =
  "Nothing was sent. If the user asked you in your own conversation to say this, tell them there.";

function postRefusalBody(input: PostRefusalInput, holder: string): string {
  switch (input.reason) {
    case "post": {
      const steps = input.callerHolds
        ? "To answer a user's chat message, pass its id as `replyTo`; to post about a document you hold, pass its `documentId`."
        : "To answer a user's chat message, pass its id as `replyTo`.";
      return `${input.holder ? `${holder} answers chat that is not about a document. ` : ""}${steps} Do not open or take a document in order to post. ${POST_OUTLET}`;
    }
    case "not-present":
      return "Tandem's Claude is turned off or stopped, so it cannot post to chat now. Nothing was sent. Do not retry.";
    case "held":
      return `${holder} is working on this document. ${ONLY_THE_USER} ${POST_OUTLET}`;
    case "claimed":
      return `${holder} picked this document up while Tandem's Claude was away, and answers its comments and chat. Do not take the document in order to post about it. ${POST_OUTLET}`;
    case "default":
      return `Tandem's Claude answers this document's comments and chat. Do not take the document in order to post about it. ${POST_OUTLET}`;
    case "lost":
      if (input.callerIsTandem) {
        return input.holder
          ? "A session the user is working with has this document now; leave it. Nothing was sent."
          : "This document was taken from Tandem's Claude, and nobody holds it now. Nothing was sent.";
      }
      if (input.cause === "taken back") {
        return `Tandem's Claude took this document back. You can still read it. Do not tandem_open it again unless the user asks you again after this point. ${POST_OUTLET}`;
      }
      return input.holder
        ? `${holder} has this document now. ${ONLY_THE_USER} ${POST_OUTLET}`
        : `You lost this document, and nobody holds it now. You can still read it. Do not tandem_open it again unless the user asks you again after this point. ${POST_OUTLET}`;
  }
}

/** What a post's refusal is built from (the posts PR, R1.7). */
export interface PostRefusalInput {
  reason: PostRefusalReason;
  holder: HolderView | null;
  documentId?: string;
  cause?: LossCause;
  callerIsTandem?: boolean;
  /** The call passed a `replyTo` that named no user message (so it was judged a post). */
  unmatchedReplyTo?: boolean;
  /** The call named a `documentId` that is not open (so it was judged doc-less). */
  namedNotOpen?: boolean;
  /** The caller holds at least one document. */
  callerHolds?: boolean;
}

export interface PostRefusal {
  message: string;
  details: {
    reason: PostRefusalReason;
    holder: HolderView | null;
    documentId?: string;
    cause?: LossCause;
  };
}

/**
 * Build the `NOT_DOC_OWNER` refusal for a chat post (the posts PR, R1.7):
 * `details.documentId` is the id the post named, absent when it named none;
 * never an owner id and never the post's text. A post never sets
 * `targetWasDefaulted` (one with no `documentId` is doc-less, never aimed at
 * the active document).
 */
export function postRefusal(input: PostRefusalInput): PostRefusal {
  return {
    message: postRefusalText(input),
    details: {
      reason: input.reason,
      holder: input.holder
        ? { label: input.holder.label, displayKind: input.holder.displayKind }
        : null,
      ...(input.documentId !== undefined ? { documentId: input.documentId } : {}),
      ...(input.cause !== undefined ? { cause: input.cause } : {}),
    },
  };
}

/** Build the message and `details` of a `NOT_DOC_OWNER` refusal. */
export function notDocOwnerRefusal(input: NotDocOwnerInput): NotDocOwnerRefusal {
  let message = body(input);
  if (input.openedAnyway) {
    message =
      "The document was opened (or reloaded, if you passed force) by this call, but you do not hold it: another session took it while it was opening. " +
      message;
  }
  const restartApplies =
    input.reason === "held" || input.reason === "claimed" || input.reason === "default";
  if (input.callerIsLegacyClaudeCode && restartApplies) message += RESTART;
  const defaulted = input.targetWasDefaulted === true && input.reason !== "answered";
  if (defaulted) message += DEFAULTED;
  return {
    message,
    details: {
      reason: input.reason,
      documentId: input.documentId,
      holder: input.holder
        ? { label: input.holder.label, displayKind: input.holder.displayKind }
        : null,
      ...(input.cause !== undefined ? { cause: input.cause } : {}),
      ...(defaulted && input.heldDocumentIds
        ? { heldDocumentIds: [...input.heldDocumentIds] }
        : {}),
    },
  };
}

/** Why a call left a document's operation queue without running. */
export type DocumentBusyReason = "wait-expired" | "cancelled";

export interface DocumentBusyRefusal {
  message: string;
  details: { reason: DocumentBusyReason; documentId: string; waitedMs?: number };
}

/**
 * `DOCUMENT_BUSY` (#2358, ADR-054 amended 2026-11-11): the call waited for its
 * turn in the document's operation queue and was not run. Nothing was claimed
 * and nothing was written. It names no holder: it is about an operation that
 * has not finished, not about who holds the document. The remedy is bounded
 * ("once"), so a session behind an operation that never settles stops and
 * tells the user rather than retrying every time the limit passes.
 *
 * The `cancelled` sentence has no reader in practice: the SDK sends no
 * response for a request its client cancelled.
 */
export function documentBusyRefusal(input: {
  reason: DocumentBusyReason;
  documentId: string;
  waitedMs?: number;
}): DocumentBusyRefusal {
  const message =
    input.reason === "cancelled"
      ? "This call was cancelled before its turn on this document. It was not run and nothing was changed."
      : "Another operation on this document has not finished, so this call was not run and nothing was changed. Retry once. If it is refused again, stop and tell the user: the document may be stuck on a slow save, and restarting Tandem clears it. If you are retrying an edit, read the document again first: the operation ahead of you may have changed it.";
  return {
    message,
    details: {
      reason: input.reason,
      documentId: input.documentId,
      ...(input.waitedMs !== undefined ? { waitedMs: input.waitedMs } : {}),
    },
  };
}

/**
 * Write-mode `tandem_status` on a document another record holds: the text is
 * shown, the position marker stays where its holder put it (ownership design
 * §5.2). Said so the caller neither retries nor opens the document for it.
 */
export const FOCUS_NOT_MOVED_WARNING =
  "Status text set. Your position marker was not moved: another session holds this document. Nothing to do, and do not open the document for this.";
