/**
 * Delivery state — the join between the push path and the pull path.
 *
 * Three stamps, and the distinction between them is the entire point:
 *
 *  1. **Forward** (`recordWakeForward`) — the server handed an unanswered-ask
 *     event to the fan-out with at least one EXTERNAL subscriber attached.
 *     Written in `queue.ts#pushEvent`, so it covers every external consumer
 *     including the launcher's supervisor, which wakes its child over stdin and
 *     never speaks SSE.
 *  2. **Poll** (`recordInboxPoll`) — `tandem_checkInbox` dispatched. This is the
 *     pull path, and it is the only signal in the server that a MODEL did
 *     something. Everything else observes transports.
 *  3. The **join** — how long an outstanding forward waited before a poll
 *     followed it, or how long one has been waiting.
 *
 * ## What each one is not
 *
 * A forward is not a delivery, and the gap is wider than "an inert consumer
 * might discard it". The record is written BEFORE the fan-out loop runs, so it
 * means *handed to the fan-out*, not *written to anything*. The supervisor's
 * `sendTurn` returns `false` when the child's stdin is not writable and says so
 * in its own contract — "a wake dropped here is a notification the user will
 * never get". That case records a forward. `noteExternalConsumersGone` below is
 * what keeps it from becoming a permanent lie; the residual window is small and
 * named rather than papered over.
 *
 * A poll is not a delivery either, and this is the correction that made this
 * module worth building rather than the bare stamp originally specified. The
 * shipped skill instructs polling every 2–3 tool calls *regardless of push
 * state*, so a busy session with no wake path at all stamps continuously — and
 * that is precisely the session in trouble. Poll recency measures polling.
 *
 * What the join adds is the one thing neither stamp has alone: an ORDER. An
 * unanswered ask went out and no poll has followed it in N seconds is a
 * statement about this specific event, it degrades toward the truth as N grows,
 * and it never asserts that delivery works. `"idle"` makes no claim at all,
 * which is the correct reading on a machine where nothing is attached: that case
 * belongs to `subscribers === 0`, the sound negative, not here.
 *
 * ## The negative is sound for ONE model, not for two
 *
 * Process-global, deliberately: no per-session claim can be derived from it.
 * `claudeSessionId` is absent for the direct-HTTP entry (the hand-launched
 * population this work exists for) and `mcpSessionId` is absent for any client
 * on MCP `2026-07-28`. Keying on either would reproduce the process-global flaw
 * one level down while LOOKING per-session.
 *
 * State the consequence rather than implying it was dodged: **any session's poll
 * clears the single global outstanding forward.** With two concurrent sessions —
 * two terminals, or an auto-launched child plus a hand-launched session, both
 * normal — a second busy session polling on its routine cadence pins `state` at
 * `"polled"` and silently masks a first session that is genuinely wedged. So
 * `"awaiting-poll"` is trustworthy evidence; `"polled"` is not evidence of
 * health when more than one model is attached. Any copy built on this must say
 * only what the former supports.
 *
 * ## Why the outstanding marker exists
 *
 * `lastPollAt - lastForwardAt` is NOT latency. Claude polls repeatedly; each
 * poll advances one term while the other sits still, so a push delivered
 * instantly reads as steadily worsening latency the longer the session runs.
 * `pendingSince` fixes the measurement to the FIRST forward with no poll after
 * it, and the poll clears it — so `lastLatencyMs` is a real forward→poll
 * interval and not an artifact of how chatty the session is.
 *
 * Diagnostics and advisory copy only. Nothing gates on this.
 */

import type { TandemEvent } from "./types.js";

/** Epoch ms of the most recent `tandem_checkInbox` dispatch, or null. */
let lastPollAt: number | null = null;
/** Total inbox polls this run — distinguishes "never polled" from "quiet". */
let pollCount = 0;
/** Epoch ms of the most recent unanswered-ask forward to an external consumer. */
let lastForwardAt: number | null = null;
/** Total unanswered-ask forwards this run. */
let forwardCount = 0;
/**
 * Epoch ms of the OLDEST forward not yet followed by a poll, or null when the
 * pull path has caught up. Set only on the transition into "outstanding" — a
 * second forward while one is already pending must not push the clock forward,
 * or a stream of events would keep resetting the wait it is supposed to measure.
 */
let pendingSince: number | null = null;
/** Did every external consumer detach while the pending forward was outstanding? */
let pendingAbandoned = false;
/** The most recent completed forward→poll interval, in ms. */
let lastLatencyMs: number | null = null;

/**
 * The inbox items the outstanding round is waiting on, keyed by
 * {@link deliveryItemKey} and mapped to their document (PR #2225 review).
 *
 * Only `annotation:*` forwards that name a document add an entry — each one is
 * a specific comment or reply the inbox will hand over. A chat forward adds
 * nothing (the inbox reads chat from CTRL_ROOM whatever document it names), and
 * neither does the Solo release wake (no `documentId`): both are closed by any
 * successful poll, exactly as before.
 *
 * It exists so a poll that could NOT hand an item over does not close the
 * round. Since #2187 a default poll isolates a document that throws and admits
 * items one at a time, so "the poll returned" no longer means "the poll
 * returned everything". Item-scoped rather than document-scoped on purpose: an
 * admit drop holds only the round that is waiting on THAT item, so one
 * permanently malformed record does not hold every later round open.
 *
 * Cleared with the round — on resolve, on a fresh round after an abandoned one,
 * and on reset — so it never outlives the `pendingSince` it describes. Each
 * entry keeps its own forward time, so a round that a poll holds is re-timed to
 * the oldest item still undelivered rather than to the first forward of the
 * round: later forwards that a poll DID deliver neither extend the wait nor
 * hide behind the held item's clock.
 */
const pendingItems = new Map<string, { documentId: string; forwardedAt: number }>();

/** One inbox item a forward is waiting on: its document and its annotation or reply id. */
export interface PendingDeliveryItem {
  documentId: string;
  itemId: string;
}

/**
 * What a poll could NOT hand over: documents whose pass threw (every pending
 * item of theirs matches) and individual items it refused (keyed by
 * {@link deliveryItemKey}, matching only themselves).
 */
export interface UndeliveredScope {
  documents: ReadonlySet<string>;
  items: ReadonlySet<string>;
}

/** The pending-item key. NUL-separated, so no document id can forge another's key. */
export function deliveryItemKey(documentId: string, itemId: string): string {
  return `${documentId}\u0000${itemId}`;
}

/**
 * Which events mean "the user asked for something and is waiting".
 *
 * Deliberately NARROWER than `isWakeWorthy`, and the two must not be merged
 * back together — they answer different questions and the difference has a
 * user-visible cost.
 *
 * `isWakeWorthy` asks "is this worth interrupting Claude for", and includes the
 * `annotation:accepted` / `annotation:dismissed` status flips. Those are emitted
 * only for Claude-authored annotations under a browser-origin write — i.e. the
 * user clicking Accept or Dismiss on Claude's own work. That is an
 * ACKNOWLEDGMENT of work already done, not a request. An unnecessary wake costs
 * one redundant `checkInbox` and closes its own loop, so including them there is
 * cheap.
 *
 * Starting a WAIT CLOCK on them is not cheap. Accept/dismiss is the most common
 * user action in a review session, and each one would demand a poll that nothing
 * compels and nothing is owed — so on a machine with a shim attached and no
 * model running, ordinary review work would drive `waitingMs` up forever and the
 * signal advertised as "something went unanswered" would be answering nothing.
 *
 * The resulting set is the same one `isUserPrivacyHeld` holds in Solo, and that
 * correspondence is not a coincidence — "content the AI must not see in Solo"
 * and "the user is waiting on a reply" are both asking what the user
 * originated. They are kept as separate predicates anyway: they can legitimately
 * diverge, and aliasing them would make a future privacy change silently retune
 * a diagnostic.
 */
export function isUnansweredAsk(event: TandemEvent): boolean {
  switch (event.type) {
    case "annotation:created":
    case "annotation:edited":
      return true;
    case "annotation:reply":
      return event.payload.replyAuthor === "user";
    case "chat:message":
      return true;
    default:
      return false;
  }
}

/**
 * A model reached for the inbox. Pull-path liveness ONLY — this does not close
 * the join.
 *
 * Call at the point `tandem_checkInbox` DISPATCHES, not where it succeeds: a
 * poll naming a closed document still tells us a model is reaching for the
 * inbox, which is the fact this stamp reports.
 *
 * Split from {@link resolveDeliveryRound} because the two facts are true at
 * different moments and one of them is a claim about the USER's message. A poll
 * that bails out before the CTRL_ROOM chat loop marks nothing read, so the
 * user's message is still unseen and the round must stay open. Since chat is
 * delivered with no document open, `tandem_checkInbox` no longer returns
 * `noDocumentError()` there; what still bails out is a throw in the document
 * pass (refresh, replies, awareness), which the error boundary turns into an
 * error result, and — since PR #2225's review — a response that fails its own
 * output-schema check, which commits nothing. That is why the handler resolves
 * the round only once the response has validated and its ledgers and chat
 * stamps are committed. Closing the join any earlier would report
 * `{state: "polled", latencyMs: 240}` — "push delivered in a quarter second" —
 * for a message the model never received, which is the comforting-and-wrong
 * shape this module exists to eliminate.
 */
export function recordInboxPoll(now: number = Date.now()): void {
  lastPollAt = now;
  pollCount += 1;
}

/**
 * The inbox poll actually collected. Closes any outstanding forward.
 *
 * Call only once the poll has committed what it returned — the chat bucket's
 * `read: true` writes and the `surfacedIds` ledger updates. See
 * {@link recordInboxPoll} for why the split exists.
 *
 * `undelivered` (PR #2225 review) names what the poll could not hand over. When
 * it covers an item this round is waiting on, the round stays OPEN — the
 * user's comment was not delivered, so `polled` would be the comforting-and-
 * wrong answer — and only the items this poll did deliver are forgotten, so a
 * later poll that reaches the rest closes it. Omitted, or covering none of the
 * pending items, the round closes as it always has.
 */
export function resolveDeliveryRound(
  now: number = Date.now(),
  undelivered?: UndeliveredScope,
): void {
  if (pendingSince === null) return;
  if (undelivered) {
    const held = [...pendingItems].filter(
      ([key, entry]) => undelivered.documents.has(entry.documentId) || undelivered.items.has(key),
    );
    if (held.length > 0) {
      // Everything older than the oldest held item was delivered by this poll,
      // so that much of the round is a completed forward→poll interval; record
      // it, then restart the clock at the oldest item still undelivered.
      const oldestHeld = Math.min(...held.map(([, entry]) => entry.forwardedAt));
      if (oldestHeld > pendingSince) {
        lastLatencyMs = pendingAbandoned ? null : Math.max(0, now - pendingSince);
        pendingAbandoned = false;
      }
      pendingSince = Math.max(pendingSince, oldestHeld);
      pendingItems.clear();
      for (const [key, entry] of held) pendingItems.set(key, entry);
      return;
    }
  }
  pendingItems.clear();
  // No latency is recorded for an abandoned round. That interval spans a
  // period with nothing attached, so it measures the user's absence rather
  // than the wake path's speed — and it would be the one number a reader
  // most wants to trust.
  //
  // The stale value is CLEARED rather than left standing: `lastLatencyMs` has
  // no age of its own, so keeping it would let a round that measured nothing
  // present a number from an older one. `{state: "polled", latencyMs: 50}`
  // where the 50 came from two rounds ago is indistinguishable, to a reader,
  // from a fresh measurement.
  lastLatencyMs = pendingAbandoned ? null : Math.max(0, now - pendingSince);
  pendingSince = null;
  pendingAbandoned = false;
}

/**
 * An unanswered-ask event was handed to the fan-out with >=1 external consumer.
 *
 * The caller owns both halves of that sentence — `queue.ts` calls this only
 * after its Solo gate has passed AND with a non-empty external subscriber set.
 * Recording a forward with nothing attached would turn "nobody is listening"
 * into "Claude is ignoring you", which is a different and false story.
 */
export function recordWakeForward(now: number = Date.now(), item?: PendingDeliveryItem): void {
  lastForwardAt = now;
  forwardCount += 1;
  if (pendingAbandoned) {
    // A fresh round: something is attached again and a new ask went out, so the
    // abandoned clock is superseded rather than extended — and so are the items
    // it was waiting on, which belong to the superseded round.
    pendingItems.clear();
    pendingSince = now;
    pendingAbandoned = false;
  } else {
    pendingSince ??= now;
  }
  if (item) {
    const key = deliveryItemKey(item.documentId, item.itemId);
    // The FIRST forward of an item is when it started waiting; a re-forward of
    // the same item (an edit, say) must not reset that.
    if (!pendingItems.has(key))
      pendingItems.set(key, { documentId: item.documentId, forwardedAt: now });
  }
}

/**
 * Every external consumer has detached.
 *
 * Without this, the `externalSubscribers.size > 0` conjunct guarding the record
 * would be checked at push time and never again — so a shim whose host exits,
 * or a launcher child that crashes, leaves `pendingSince` set forever and
 * `/health` reports `push.subscribers: 0` beside `delivery.state:
 * "awaiting-poll"` with `waitingMs` climbing for days. Two fields on one
 * response directly contradicting each other, with the sound negative being the
 * one telling the truth.
 *
 * The most likely real trigger is the Solo→Tandem release wake: it is often the
 * only forward an entire Solo session produces, and it fires at exactly the
 * moment a user tends to stop working.
 *
 * Called on the transition to zero, not per unsubscribe.
 */
export function noteExternalConsumersGone(): void {
  if (pendingSince !== null) pendingAbandoned = true;
}

/**
 * An external consumer attached again, with a forward still outstanding.
 *
 * The counterpart to {@link noteExternalConsumersGone}, and NOT optional: the
 * latch is otherwise one-directional. Only a poll or a fresh forward could clear
 * it, so a routine reconnect produced the exact contradiction the detach hook
 * exists to prevent, mirrored — `push.subscribers: 1` beside
 * `delivery.state: "consumer-detached"` on the same response, with the sound
 * positive being the one telling the truth.
 *
 * This is the default desktop install, not an edge case. The launcher's child
 * crashes, `teardownTurnDelivery` unsubscribes, `scheduleRestart` respawns two
 * seconds later, and `wakeOwedAcrossSpawns` re-sends the wake — so the event
 * genuinely IS delivered to the new consumer. Same for any SSE reconnect, where
 * `Last-Event-ID` replay re-delivers it.
 *
 * Clearing the latch does not fake a delivery. `pendingSince` is untouched, so
 * the round stays open and the clock keeps running from the ORIGINAL forward —
 * the user has been waiting since then. If the re-delivery did not in fact
 * happen, the state reads `awaiting-poll` with a climbing `waitingMs`, which is
 * the louder alarm, not the quieter one.
 *
 * Called on the transition to non-zero, not per subscribe.
 */
export function noteExternalConsumerAttached(): void {
  pendingAbandoned = false;
}

export type DeliveryJoinState =
  /** Nothing has been forwarded this run. No claim is made. */
  | "idle"
  /** A poll followed the last forward. `latencyMs` is that interval. */
  | "polled"
  /** A forward is outstanding and something is still attached to receive it. */
  | "awaiting-poll"
  /** A forward was outstanding when the last external consumer detached. */
  | "consumer-detached"
  /**
   * A forward is outstanding while Tandem refuses the AI (#1521). Neither
   * stalled nor detached: nothing can answer it until a license is activated.
   * Applied at read time by `applyAiRefusal`, never stored.
   */
  | "license-refused";

export interface DeliveryState {
  pollCount: number;
  /**
   * Total forwards, NOT "messages sent to Claude" — do not render it as one.
   * A Solo session holding twelve comments releases as a SINGLE synthetic wake,
   * so this reads `1` for twelve messages. Correct for the join (one wake, one
   * poll expected); wrong as a message count.
   */
  forwardCount: number;
  state: DeliveryJoinState;
  /**
   * The last completed forward→poll interval in ms — null if none has
   * completed, AND null whenever a forward is currently outstanding.
   *
   * That second clause is not tidiness. `recordWakeForward` does not clear this
   * value, so without the suppression a session in total delivery failure would
   * report `{state: "awaiting-poll", waitingMs: 600000, latencyMs: 50}` — every
   * field individually true, and a renderer showing "latency: 50 ms" during a
   * ten-minute outage. That is precisely the comforting-but-wrong signal this
   * module exists to eliminate, so the two are mutually exclusive by
   * construction rather than by a note telling consumers to be careful.
   *
   * When present it is an UPPER BOUND on wake latency, never proof of
   * causation: the poll may have been the skill's routine cadence rather than a
   * response to the wake.
   */
  latencyMs: number | null;
  /**
   * How long the outstanding forward has waited — null when none is, AND null
   * once the round is stranded.
   *
   * The second clause is the same argument as `latencyMs`'s, pointed the other
   * way. Nothing has been "waiting" across a span with no consumer attached;
   * that interval measures the gap since the user's last action, and rendering
   * it beside `consumer-detached` invites "Claude has been ignoring you for 24
   * hours" when nothing was ever listening. `state` already carries the whole
   * of what is known about a stranded round.
   */
  waitingMs: number | null;
  /** ms since the last inbox poll, or null if a model has never polled. */
  sincePollMs: number | null;
}

/**
 * `externalConsumerCount` is passed in rather than imported: `queue.ts` already
 * imports this module, so reaching back for `getSubscriberCount` would close a
 * cycle. The caller holds both.
 *
 * REQUIRED, with no default. A default of `1` is the unsound direction of this
 * codebase's central asymmetry — only zero is a sound claim — so a caller that
 * simply forgot the argument would silently assert "something is attached" and
 * suppress `consumer-detached` on a machine with nothing attached. Making it
 * required turns that into a type error at the one moment it can still be
 * caught. Tests pass an explicit count like everyone else.
 */
export function getDeliveryState(now: number, externalConsumerCount: number): DeliveryState {
  // Read-time re-evaluation, not just the detach hook. It also covers the case
  // where a consumer detaches and a NEW one attaches before anything is
  // forwarded — the old clock is meaningless either way, and only a read knows
  // what is attached right now.
  const outstanding = pendingSince !== null;
  const stranded = outstanding && (pendingAbandoned || externalConsumerCount === 0);

  const state: DeliveryJoinState = stranded
    ? "consumer-detached"
    : outstanding
      ? "awaiting-poll"
      : lastForwardAt === null
        ? "idle"
        : "polled";

  return {
    pollCount,
    forwardCount,
    state,
    // `Math.max(0, …)` throughout guards a clock that stepped backwards between
    // two reads (NTP correction, a resumed VM, a laptop waking). A negative
    // duration is not a measurement, and rendering one looks like a bug in the
    // feature being diagnosed.
    latencyMs: outstanding ? null : lastLatencyMs,
    waitingMs: pendingSince === null || stranded ? null : Math.max(0, now - pendingSince),
    sincePollMs: lastPollAt === null ? null : Math.max(0, now - lastPollAt),
  };
}

/** Testing-only. */
export function resetDeliveryStateForTests(): void {
  lastPollAt = null;
  pollCount = 0;
  lastForwardAt = null;
  forwardCount = 0;
  pendingSince = null;
  pendingAbandoned = false;
  lastLatencyMs = null;
  pendingItems.clear();
}

/**
 * Re-read a delivery state through the licence refusal (#1521). While Tandem
 * refuses the AI, an outstanding forward is neither stalled (`awaiting-poll`
 * with a climbing clock — the launched child left running at expiry is closed
 * at its next request, so no poll can land) nor detached (refusal revokes the
 * SSE and wake consumers, which reads as the last consumer leaving). Both map
 * to `license-refused`, with no clock: there is no wait to time.
 *
 * `consumer-detached` maps even when the detach predated expiry. While refused
 * nothing can attach (`/api/events` and `/api/wake` refuse at entry), so the
 * detach cannot be acted on until activation, and the refusal is the fact in
 * the user's way. `idle` and `polled` make no claim and pass through.
 *
 * Read-time, not a latch, so there is no window between expiry and the next
 * refused event, and nothing goes stale after activation. The refusal is
 * passed in, the way `externalConsumerCount` is: this module imports no
 * licence code, and the caller decides it with `aiRefusal()`. It is a thunk,
 * asked only for a state it could remap, because answering it costs a licence
 * file read and a signature check on every `/health` poll otherwise.
 */
export function applyAiRefusal(state: DeliveryState, aiRefused: () => boolean): DeliveryState {
  if (state.state !== "awaiting-poll" && state.state !== "consumer-detached") return state;
  if (!aiRefused()) return state;
  return { ...state, state: "license-refused", waitingMs: null, latencyMs: null };
}
