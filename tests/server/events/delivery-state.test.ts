import { beforeEach, describe, expect, it } from "vitest";
import {
  getDeliveryState,
  isUnansweredAsk,
  noteExternalConsumerAttached,
  noteExternalConsumersGone,
  recordInboxPoll,
  recordWakeForward,
  resetDeliveryStateForTests,
  resolveDeliveryRound,
} from "../../../src/server/events/delivery-state.js";
import type { TandemEvent } from "../../../src/server/events/types.js";

/**
 * The push↔pull join.
 *
 * Two of the tests below pin measurement bugs that the design this replaces
 * actually had, rather than hypothetical ones — see "does not grow" and "does
 * not restart the clock". Both produce plausible-looking numbers while being
 * wrong, which is the failure mode that matters for a signal whose entire job
 * is to stop the product lying about connectivity.
 */
describe("delivery-state", () => {
  beforeEach(resetDeliveryStateForTests);

  const T0 = 1_700_000_000_000;

  /**
   * A `tandem_checkInbox` that ran to completion — it both stamped pull-path
   * liveness and closed the join. The production call site does these as two
   * separate steps straddling the document guard, so a poll that bailed out
   * calls only the first; the "bails out" block below drives that case directly
   * with `recordInboxPoll`.
   */
  function poll(now: number): void {
    recordInboxPoll(now);
    resolveDeliveryRound(now);
  }

  describe("the idle state", () => {
    it("makes no claim before anything is forwarded", () => {
      expect(getDeliveryState(T0, 1)).toEqual({
        pollCount: 0,
        forwardCount: 0,
        state: "idle",
        latencyMs: null,
        waitingMs: null,
        sincePollMs: null,
      });
    });

    it("stays idle when a model polls but nothing was ever handed out", () => {
      // The case the bare stamp got wrong. A session polling every 2-3 tool
      // calls with no wake path attached looks maximally healthy by poll
      // recency, and it is exactly the session in trouble. Ordering is what
      // carries the information, so a poll alone must not move the state.
      poll(T0);
      const state = getDeliveryState(T0 + 1_000, 1);
      expect(state.state).toBe("idle");
      expect(state.latencyMs).toBeNull();
      expect(state.pollCount).toBe(1);
    });
  });

  describe("an outstanding forward", () => {
    it("reports how long it has waited", () => {
      recordWakeForward(T0);
      expect(getDeliveryState(T0 + 4_000, 1)).toMatchObject({
        state: "awaiting-poll",
        waitingMs: 4_000,
        latencyMs: null,
      });
    });

    it("does not restart the clock when more events arrive", () => {
      // The measurement bug: `pendingSince = now` on every forward means a
      // steady trickle of chat messages keeps resetting the wait, so a session
      // that has ignored the user for ten minutes reports a two-second wait for
      // as long as the user keeps typing. `??=` is what makes this hold.
      recordWakeForward(T0);
      recordWakeForward(T0 + 30_000);
      recordWakeForward(T0 + 60_000);
      const state = getDeliveryState(T0 + 90_000, 1);
      expect(state.waitingMs).toBe(90_000);
      expect(state.forwardCount).toBe(3);
    });

    it("is cleared by a poll, closing the interval", () => {
      recordWakeForward(T0);
      poll(T0 + 2_500);
      expect(getDeliveryState(T0 + 9_999, 1)).toMatchObject({
        state: "polled",
        latencyMs: 2_500,
        waitingMs: null,
      });
    });
  });

  describe("latency is an interval, not a difference of last-seen stamps", () => {
    it("does not grow as a healthy session keeps polling", () => {
      // `lastPollAt - lastForwardAt` reads as steadily worsening latency the
      // longer a session runs, because each routine poll advances one term
      // while the other sits still. A push delivered in 50ms would be reported
      // as a five-minute delay purely for being followed by ordinary work.
      recordWakeForward(T0);
      poll(T0 + 50);
      for (let i = 1; i <= 20; i++) poll(T0 + i * 30_000);

      const state = getDeliveryState(T0 + 600_000, 1);
      expect(state.latencyMs).toBe(50);
      expect(state.state).toBe("polled");
    });

    it("reports the newest completed interval across successive rounds", () => {
      recordWakeForward(T0);
      poll(T0 + 100);
      expect(getDeliveryState(T0 + 100, 1).latencyMs).toBe(100);

      recordWakeForward(T0 + 200);
      poll(T0 + 5_200);
      expect(getDeliveryState(T0 + 5_200, 1).latencyMs).toBe(5_000);
    });

    it("measures from the OLDEST unanswered forward, not the newest", () => {
      // The user's first message is the one that has been waiting. Measuring
      // from the last would under-report the delay by the length of whatever
      // they typed while waiting — shrinking the number precisely as the
      // problem gets worse.
      recordWakeForward(T0);
      recordWakeForward(T0 + 10_000);
      poll(T0 + 12_000);
      expect(getDeliveryState(T0 + 12_000, 1).latencyMs).toBe(12_000);
    });
  });

  describe("a clock that steps backwards", () => {
    // NTP correction, a resumed VM, a laptop waking. `Date.now()` is not
    // monotonic and these are diagnostics a human reads, so a negative duration
    // is worse than a zero: it looks like a bug in the feature being diagnosed.
    it("clamps a negative interval to zero rather than reporting it", () => {
      recordWakeForward(T0);
      poll(T0 - 5_000);
      expect(getDeliveryState(T0, 1).latencyMs).toBe(0);
    });

    it("clamps a negative wait to zero", () => {
      recordWakeForward(T0);
      expect(getDeliveryState(T0 - 5_000, 1).waitingMs).toBe(0);
    });
  });

  describe("process-global by design", () => {
    it("lets any poll clear any forward, with no session key", () => {
      // Not an oversight to be fixed later. Both candidate identity keys are
      // absent on the target population — `claudeSessionId` for the direct-HTTP
      // entry, `mcpSessionId` for any client on MCP 2026-07-28 — so keying this
      // would reproduce the process-global flaw one level down while LOOKING
      // per-session. Two concurrent sessions share one honest counter instead.
      recordWakeForward(T0);
      poll(T0 + 1_000);
      expect(getDeliveryState(T0 + 1_000, 1).state).toBe("polled");
    });
  });

  describe("a stale latency during a live failure", () => {
    it("suppresses latencyMs while a forward is outstanding", () => {
      // Without this, ten minutes of total delivery failure reports
      // `{state: "awaiting-poll", waitingMs: 600000, latencyMs: 50}` — every
      // field individually true, and a renderer showing "latency: 50 ms"
      // during an outage. The comforting-but-wrong signal in miniature.
      recordWakeForward(T0);
      poll(T0 + 50);
      expect(getDeliveryState(T0 + 50, 1).latencyMs).toBe(50);

      recordWakeForward(T0 + 1_000);
      expect(getDeliveryState(T0 + 601_000, 1)).toMatchObject({
        state: "awaiting-poll",
        waitingMs: 600_000,
        latencyMs: null,
      });
    });
  });

  describe("a poll that bails out", () => {
    it("stamps pull-path liveness but does NOT close the join", () => {
      // `tandem_checkInbox` against a closed document returns `noDocumentError`
      // before collecting anything: no annotations, no replies, and it never
      // reaches the CTRL_ROOM chat loop, so not one message is marked read. The
      // user's message is still unseen.
      //
      // With the join closed at dispatch, /health reported
      // `{state: "polled", latencyMs: 240}` — "push delivered in a quarter
      // second" — for a message the model never received. The comforting-and-
      // wrong shape this module exists to eliminate, emitted by the module.
      recordWakeForward(T0);
      recordInboxPoll(T0 + 240);

      const state = getDeliveryState(T0 + 240, 1);
      expect(state.state).toBe("awaiting-poll");
      expect(state.latencyMs).toBeNull();
      expect(state.waitingMs).toBe(240);
      // The liveness half still lands — that a model reached for the inbox is
      // true regardless of where the poll landed, and it is the only signal in
      // the server written by a model rather than by a transport.
      expect(state.pollCount).toBe(1);
      expect(state.sincePollMs).toBe(0);
    });

    it("lets the NEXT successful poll close the round it left open", () => {
      recordWakeForward(T0);
      recordInboxPoll(T0 + 240); // bailed out
      poll(T0 + 1_500); // ran to completion

      expect(getDeliveryState(T0 + 1_500, 1)).toMatchObject({
        state: "polled",
        // Measured from the original forward, not from the failed poll.
        latencyMs: 1_500,
        pollCount: 2,
      });
    });
  });

  describe("the consumer detaching mid-wait", () => {
    it("stops claiming a poll is owed once nothing is attached", () => {
      // The contradiction otherwise: /health reports `push.subscribers: 0`
      // beside `state: "awaiting-poll"` with waitingMs climbing for days. The
      // sound negative says nobody was listening; the join says the message was
      // delivered and ignored. Both on one response.
      recordWakeForward(T0);
      noteExternalConsumersGone();
      expect(getDeliveryState(T0 + 86_400_000, 1)).toMatchObject({
        state: "consumer-detached",
        // `waitingMs` is suppressed too, which this assertion used to get wrong
        // — it pinned 86_400_000 as correct. Nothing was "waiting" across a span
        // with no consumer attached; that number is the gap since the user's
        // last action, and rendering it beside `consumer-detached` invites
        // "Claude has been ignoring you for 24 hours" when nothing was ever
        // listening. Same argument as `latencyMs`'s suppression, pointed the
        // other way.
        waitingMs: null,
      });
    });

    it("also catches it at READ time, with no detach hook fired", () => {
      // Belt and braces: the hook covers the transition, the read covers a
      // consumer that detached and was replaced before anything else happened.
      recordWakeForward(T0);
      expect(getDeliveryState(T0 + 5_000, 0).state).toBe("consumer-detached");
      expect(getDeliveryState(T0 + 5_000, 1).state).toBe("awaiting-poll");
    });

    it("records NO latency for a round that was abandoned", () => {
      // That interval spans a period with nothing attached, so it measures the
      // user's absence rather than the wake path's speed — and it is exactly
      // the number a reader would most want to trust.
      recordWakeForward(T0);
      noteExternalConsumersGone();
      poll(T0 + 3_600_000);
      expect(getDeliveryState(T0 + 3_600_000, 1)).toMatchObject({
        state: "polled",
        latencyMs: null,
      });
    });

    it("clears the abandoned latch when a consumer attaches again", () => {
      // The latch was one-directional: only a poll or a fresh forward could
      // clear it, and a live count could not. So a routine reconnect produced
      // the MIRROR of the contradiction the detach hook exists to fix —
      // `push.subscribers: 1` beside `state: "consumer-detached"` on one
      // response, with the sound positive telling the truth this time.
      //
      // This is the default desktop install: the launcher child crashes,
      // unsubscribes, respawns two seconds later, and `wakeOwedAcrossSpawns`
      // re-sends the wake, so the event genuinely does reach the new consumer.
      recordWakeForward(T0);
      noteExternalConsumersGone();
      expect(getDeliveryState(T0 + 2_000, 0).state).toBe("consumer-detached");

      noteExternalConsumerAttached();

      const state = getDeliveryState(T0 + 3_000, 1);
      expect(state.state).toBe("awaiting-poll");
      // The clock is NOT restarted — the user has been waiting since T0, and
      // re-attaching does not undo that. Clearing the latch makes the alarm
      // louder, not quieter.
      expect(state.waitingMs).toBe(3_000);
    });

    it("measures the latency of a round that survived a reconnect", () => {
      // The second consequence of the sticky latch: `resolveDeliveryRound`
      // discards the interval for an abandoned round, so EVERY crash-restart and
      // every SSE reconnect silently threw away the one number this feature
      // exists to produce — and `latencyMs` went on reporting a stale value from
      // an older round with no indication of its age.
      recordWakeForward(T0);
      noteExternalConsumersGone();
      noteExternalConsumerAttached();
      poll(T0 + 4_000);

      expect(getDeliveryState(T0 + 4_000, 1)).toMatchObject({
        state: "polled",
        latencyMs: 4_000,
      });
    });

    it("does not let a stale latency stand in for a round that measured nothing", () => {
      // A completed round, then an abandoned one. `lastLatencyMs` carries no age
      // of its own, so leaving the old value would present a number from two
      // rounds ago as this round's measurement — indistinguishable to a reader.
      recordWakeForward(T0);
      poll(T0 + 50);
      expect(getDeliveryState(T0 + 50, 1).latencyMs).toBe(50);

      recordWakeForward(T0 + 1_000);
      noteExternalConsumersGone();
      poll(T0 + 3_600_000);

      expect(getDeliveryState(T0 + 3_600_000, 1).latencyMs).toBeNull();
    });

    it("starts a fresh clock when a new ask goes out after an abandonment", () => {
      recordWakeForward(T0);
      noteExternalConsumersGone();
      recordWakeForward(T0 + 100_000);
      expect(getDeliveryState(T0 + 105_000, 1)).toMatchObject({
        state: "awaiting-poll",
        waitingMs: 5_000,
      });
    });

    it("does nothing when there was no outstanding forward", () => {
      noteExternalConsumersGone();
      expect(getDeliveryState(T0, 1).state).toBe("idle");
    });
  });

  describe("isUnansweredAsk — narrower than isWakeWorthy, deliberately", () => {
    const ev = (type: string, payload: Record<string, unknown> = {}) =>
      ({ id: "e", type, timestamp: T0, payload }) as unknown as TandemEvent;

    it("counts the things the user originated", () => {
      expect(isUnansweredAsk(ev("annotation:created"))).toBe(true);
      expect(isUnansweredAsk(ev("annotation:edited"))).toBe(true);
      expect(isUnansweredAsk(ev("chat:message"))).toBe(true);
      expect(isUnansweredAsk(ev("annotation:reply", { replyAuthor: "user" }))).toBe(true);
    });

    it("does NOT count accept/dismiss — the user closing the loop themselves", () => {
      // These fire only for Claude-authored annotations under a browser write:
      // the user clicking Accept or Dismiss on Claude's own work. It is an
      // acknowledgment, not a request. They are also the MOST common action in
      // a review session, so counting them would drive waitingMs up forever on
      // a machine with a shim attached and no model running — the signal
      // advertised as "something went unanswered" answering nothing.
      expect(isUnansweredAsk(ev("annotation:accepted"))).toBe(false);
      expect(isUnansweredAsk(ev("annotation:dismissed"))).toBe(false);
    });

    it("does not count Claude's own reply", () => {
      expect(isUnansweredAsk(ev("annotation:reply", { replyAuthor: "claude" }))).toBe(false);
    });

    it("does not count document:* lifecycle", () => {
      expect(isUnansweredAsk(ev("document:switched"))).toBe(false);
      expect(isUnansweredAsk(ev("document:opened"))).toBe(false);
    });
  });

  it("reports how long since the last poll", () => {
    poll(T0);
    expect(getDeliveryState(T0 + 7_500, 1).sincePollMs).toBe(7_500);
  });

  it("resets every field, so a leaked counter cannot cross tests", () => {
    recordWakeForward(T0);
    poll(T0 + 1);
    recordWakeForward(T0 + 2);
    noteExternalConsumersGone();
    resetDeliveryStateForTests();
    expect(getDeliveryState(T0 + 3, 1)).toEqual({
      pollCount: 0,
      forwardCount: 0,
      state: "idle",
      latencyMs: null,
      waitingMs: null,
      sincePollMs: null,
    });
  });
});
