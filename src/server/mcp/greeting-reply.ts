/**
 * Is this Claude chat reply Tandem's one-time hello (#2227)?
 *
 * The hello (#2197) is a normal `tandem_reply`, so the client announced it as
 * "Claude replied in …" with a chime, for a message that answers nothing the
 * user sent. Bryan's call (2026-10-28): keep announcing it, chime included, but
 * as "Tandem's Claude is ready". The client must not guess that from the text,
 * so the server tags the chat row `greeting: true`, and only the server can
 * decide it: whether the reply is the greeting turn's, from the supervisor's
 * own child, with no user chat waiting.
 *
 * The launcher supervisor owns that answer (it knows the greeting turn and its
 * child) but must not import the MCP layer, so it registers a classifier here,
 * the same seam shape as `onTandemReply`; `index.ts` wires the two. The MCP
 * `tandem_reply` and `/api/channel-reply` ask it, synchronously, right before
 * they append, and pass the answer to `appendClaudeChatMessage`.
 *
 * The answer changes notification wording ONLY. A wrong `true` reads "Tandem's
 * Claude is ready" for one reply; a wrong `false` reads "Claude replied". So
 * every failure reads `false` — the historical wording — and the classifier
 * writes nothing, here or in the Y.Doc.
 */

import { CTRL_ROOM, Y_MAP_CHAT } from "../../shared/constants.js";
import type { ChatMessage } from "../../shared/types.js";
import { getOrCreateDocument } from "../yjs/provider.js";

/** What a reply looks like to the classifier. No content: it never needs it. */
export interface GreetingReplyQuery {
  /** The caller's `X-Claude-Session-Id`, undefined when its transport sends none. */
  sessionId: string | undefined;
  replyTo: string | undefined;
  inProgress: boolean | undefined;
}

type Classifier = (query: GreetingReplyQuery) => boolean;

let classifier: Classifier | null = null;

/**
 * Register the one classifier (the supervisor's). Returns an unregister fn
 * that only clears its own registration, so a stale supervisor's teardown
 * cannot remove a newer one's.
 */
export function setGreetingReplyClassifier(fn: Classifier): () => void {
  classifier = fn;
  return () => {
    if (classifier === fn) classifier = null;
  };
}

/** False with nothing registered; a throwing classifier is logged and false. */
export function isGreetingReply(query: GreetingReplyQuery): boolean {
  if (classifier === null) return false;
  try {
    return classifier(query) === true;
  } catch (err) {
    console.error("[Tandem] The greeting classifier failed (reply left untagged):", err);
    return false;
  }
}

/** The user's chat messages right now: their ids, and whether any is unread. */
export interface UserChatSnapshot {
  ids: ReadonlySet<string>;
  unread: boolean;
}

/**
 * Read the global chat (CTRL_ROOM, `Y_MAP_CHAT`) for the supervisor's "no user
 * chat was waiting" test. Ids rather than timestamps, so "something arrived
 * during the greeting turn" is a set difference and needs no clock. A pure
 * read.
 */
export function snapshotUserChat(): UserChatSnapshot {
  const chatMap = getOrCreateDocument(CTRL_ROOM).getMap(Y_MAP_CHAT);
  const ids = new Set<string>();
  let unread = false;
  chatMap.forEach((value) => {
    const msg = value as Partial<ChatMessage> | null;
    if (msg === null || typeof msg !== "object" || msg.author !== "user") return;
    if (typeof msg.id === "string") ids.add(msg.id);
    if (msg.read !== true) unread = true;
  });
  return { ids, unread };
}

/** Test-only: drop any registration. */
export function resetGreetingReplyClassifierForTesting(): void {
  classifier = null;
}
