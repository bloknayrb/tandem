import { type ChatPickup, isPickupStalled } from "./chat-pickup";

/**
 * The chat panel's offer to set up Tandem's own Claude (#2199): "Answers here
 * come from Tandem's own Claude…" with Set up… and Not now. Pure, so it is
 * tested without mounting the panel.
 *
 * Who it is for: someone whose AI cannot answer the chat as it arrives — in
 * practice a Claude Desktop-only setup, which Tandem cannot push to. It never
 * installs anything itself; Set up… opens the setup wizard at its offer.
 */
export interface ClaudeCodeOfferInputs {
  /** Readiness `launcherNotConfigured`: no Claude Code setup for the launcher
   * to run (read off the raw launcher status — a connected Desktop does not
   * hide it). */
  launcherNotConfigured: boolean;
  /** Readiness `pushDelivery === "attached"`: something IS being told about
   * new messages, so an AI that answers as they arrive is already there. */
  pushAttached: boolean;
  /** The licence refuses the AI: its own surfaces speak. */
  aiOff: boolean;
  /** Solo holds the AI back by the user's choice; an offer to add one would
   * be beside the point. */
  solo: boolean;
  /** "Not now" this launch. */
  dismissed: boolean;
}

/** Whether the offer may show at all. */
export function claudeCodeOfferEligible(i: ClaudeCodeOfferInputs): boolean {
  return i.launcherNotConfigured && !i.pushAttached && !i.aiOff && !i.solo && !i.dismissed;
}

/**
 * Whether it shows now: on an empty chat, or once the latest message has
 * waited past the delivery-stall threshold (the pickup row already reads
 * "still waiting" then). Not on every send — a message waits a few seconds
 * even where something answers it.
 */
export function showClaudeCodeOffer(
  eligible: boolean,
  messageCount: number,
  pickup: ChatPickup | null,
): boolean {
  if (!eligible) return false;
  if (messageCount === 0) return true;
  return isPickupStalled(pickup);
}

export const CLAUDE_CODE_OFFER_TEXT =
  "Answers here can come from Tandem's own Claude, as you send them. It isn't set up yet.";
