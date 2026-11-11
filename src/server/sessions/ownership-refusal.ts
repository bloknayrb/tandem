/**
 * `NOT_DOC_OWNER` refusal copy (#2358, ADR-054; ownership design §5.3, R4.2, R3.6).
 *
 * **Pure.** It turns a decision into the message and `details` a tool returns.
 * Every message carries its remedy inline, because skills older than the flip
 * stay in use after it and know nothing about ownership.
 *
 * **Nothing a session chose can appear in a message** (R3.6). The only inputs
 * that reach the text are the server's own closed display kind and the random
 * label it minted — never a client name, a file name, a status text or a
 * session id. `documentId` appears in `details` only.
 *
 * **What is written here is what PR 1c can reach.** `chat` and `post` arrive
 * with reply acceptance (PR 2), `unlinked` with the shim's identity (PR 4),
 * `unbound-child` with the handle (PR 3a), and the `released` and `assigned`
 * causes of `lost` with the controls (PR 5). `default` and `not-present` need
 * a present Tandem's Claude, which arrives in PR 3b; their copy is here
 * because the decision that produces them is.
 */

import type { HolderView, LossCause, OwnershipRefusalReason } from "./ownership.js";

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
  }
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

/**
 * Write-mode `tandem_status` on a document another record holds: the text is
 * shown, the position marker stays where its holder put it (ownership design
 * §5.2). Said so the caller neither retries nor opens the document for it.
 */
export const FOCUS_NOT_MOVED_WARNING =
  "Status text set. Your position marker was not moved: another session holds this document. Nothing to do, and do not open the document for this.";
