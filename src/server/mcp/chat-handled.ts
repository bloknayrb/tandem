/**
 * The handled rule for user chat with ownership on (#2358, the posts PR, R3.2;
 * ownership design §5.5, §6.4). **Pure**: it reads chat rows and nothing else
 * — no delivery registry, no flag, no clock — so it gives the same answer
 * before and after a restart, as far as the rows are kept.
 *
 * A user message is handled when a Claude row names it in `replyTo` or lists
 * it in `settles`, and that row is a real Claude **final** reply: no
 * `inProgress` (an acknowledgement answers nothing), no `superseded`, no
 * `agentIdentity` (the local model's) and no `chatNotice`. With ownership on,
 * every such row was written by the server: a client connection's change to
 * the chat map is undone (R4).
 *
 * While ownership is off nothing calls this: master's rule (`answeredChatIds`
 * in `awareness.ts`, with its received-sweep) stays.
 *
 * Imports types and constants only, so `document-service.ts` (the boot's
 * carried-over capture) and `awareness.ts` share it without a cycle.
 */

import type * as Y from "yjs";
import type { ChatMessage } from "../../shared/types.js";

/** Whether `msg` is a real Claude final reply whose `replyTo` and `settles` count. */
function isFinalClaudeReply(msg: Partial<ChatMessage>): boolean {
  return (
    msg.author === "claude" &&
    !msg.agentIdentity &&
    msg.chatNotice === undefined &&
    msg.inProgress !== true &&
    msg.superseded !== true
  );
}

/** The keys of the user chat messages handled by this rule. */
export function settledChatIds(chatMap: Y.Map<unknown>): Set<string> {
  const handled = new Set<string>();
  chatMap.forEach((value) => {
    if (typeof value !== "object" || value === null) return;
    const msg = value as Partial<ChatMessage>;
    if (!isFinalClaudeReply(msg)) return;
    if (typeof msg.replyTo === "string") handled.add(msg.replyTo);
    if (Array.isArray(msg.settles)) {
      for (const key of msg.settles) if (typeof key === "string") handled.add(key);
    }
  });
  return handled;
}

/**
 * The user rows that are `read` and not handled by this rule (R0.1): what a
 * boot restoring the CTRL session takes as its carried-over set.
 */
export function carriedOverCandidates(chatMap: Y.Map<unknown>): string[] {
  const handled = settledChatIds(chatMap);
  const keys: string[] = [];
  chatMap.forEach((value, key) => {
    if (typeof value !== "object" || value === null) return;
    const msg = value as Partial<ChatMessage>;
    if (msg.author === "user" && msg.read === true && !handled.has(key)) keys.push(key);
  });
  return keys;
}
