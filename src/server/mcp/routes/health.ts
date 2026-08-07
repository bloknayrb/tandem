import type { Request, Response } from "express";
import { isLoopback } from "../../auth/middleware.js";
import type { DeliveryState } from "../../events/delivery-state.js";
import type { Handler } from "./_shared.js";

export interface HealthHandlerDeps {
  version: string;
  /**
   * True when at least one MCP transport has completed `initialize`.
   *
   * Scoped to handshake-era clients by construction: MCP `2026-07-28` removed
   * both the handshake and protocol-level sessions, so a client on that revision
   * never increments this. Supplementing it without inverting its failure mode
   * is #1249; see ADR-045's 2026-07-30 amendment.
   */
  hasSession: () => boolean;
  /** Live count of event-queue subscribers (the SSE fan-out). */
  getSubscriberCount: () => number;
  /** Consumer heartbeat counters — see events/push-liveness.ts. */
  getPushLiveness: () => { lastEventAt: number | null; eventCount: number };
  /**
   * The push↔pull join — see events/delivery-state.ts.
   *
   * The only field group here sourced from a MODEL's behaviour rather than a
   * transport's, which is why it can say things `hasSession` and `subscribers`
   * structurally cannot. Still not a delivery proof; read that module's
   * docblock before rendering any of it.
   *
   * Takes the live external-consumer count so the join can be re-evaluated at
   * READ time. Its "something was attached" conjunct is checked when the event
   * is pushed and would otherwise never be checked again, which is how a
   * detached consumer turns into a `waitingMs` that climbs for days.
   */
  getDeliveryState: (externalConsumerCount: number) => DeliveryState;
}

/**
 * GET /health — public liveness, plus loopback-only diagnostics.
 *
 * Public: `status`, `version`, `transport`. Loopback-only: `hasSession`, `push`
 * and `delivery`.
 *
 * All three gated fields are session-presence signals — whether an AI is attached,
 * whether a real-time consumer is receiving, and whether a model has polled since
 * something was handed out — so they are withheld from LAN callers for the same
 * reason. `delivery` is the most sensitive of them, not the least: its counters
 * describe when a human's messages arrive and whether anyone is answering, which is
 * a coarse activity trace of the person using this machine.
 *
 * Note "loopback socket" is a weaker boundary than it sounds:
 * the CORS allowlist is port-wildcarded, so any page served from 127.0.0.1 can read
 * this cross-origin. Keep that in mind before adding a field here; it is the same
 * boundary `/api/diagnostics` sits behind, not a Tandem-UI-only one.
 *
 * A factory, not an inline closure, so the loopback gate can be exercised against a
 * genuine non-loopback request. The previous guard asserted on the handler's SOURCE
 * TEXT and could not fail: it sliced from the `if (isLoopback(...))` line to
 * `res.json(body)`, a window that contains the block's own closing brace, so hoisting
 * a field OUT of the gate still matched. See tests/server/health-route.test.ts.
 *
 * DIAGNOSTICS ONLY. `hasSession` describes the PULL path (an MCP transport completed
 * initialize); `push` describes the SSE fan-out. They are structurally disjoint —
 * which is exactly why a user can see "AI connected" while nothing they do reaches
 * Claude. Neither proves push reaches a model: `subscribers: 0` is a sound negative,
 * but any positive count includes an attached-but-inert channel shim. Do not build a
 * "push is live" indicator on this.
 *
 * `delivery` is the one field here that observes a model rather than a transport,
 * and it is still not that indicator. Two qualifications belong with it wherever
 * copy is built on it:
 *
 *  - **The negative is sound for ONE model, not two.** Any session's poll clears
 *    the single process-global outstanding forward, so a second busy session —
 *    two terminals, or an auto-launched child alongside a hand-launched one —
 *    pins `state` at `"polled"` while masking a first session that is wedged.
 *    `"awaiting-poll"` is trustworthy evidence; `"polled"` is not evidence of
 *    health.
 *  - **A busy turn looks like a wedged one.** The supervisor coalesces wakes
 *    while a turn is in flight (latch window: ten minutes), so `waitingMs` can
 *    climb through a perfectly healthy session that is simply working. Copy keyed
 *    on it needs a threshold well past a plausible turn, not a few seconds.
 */
export function makeHealthHandler(deps: HealthHandlerDeps): Handler {
  return (req: Request, res: Response): void => {
    const body: Record<string, unknown> = {
      status: "ok",
      version: deps.version,
      transport: "http",
    };

    if (isLoopback(req.socket.remoteAddress)) {
      const subscribers = deps.getSubscriberCount();
      body.hasSession = deps.hasSession();
      body.push = {
        subscribers,
        ...deps.getPushLiveness(),
      };
      // Read once and shared, so `push.subscribers` and the join's re-evaluation
      // can never disagree within a single response — which is the exact
      // contradiction ("subscribers: 0" beside "awaiting-poll") this fixes.
      body.delivery = deps.getDeliveryState(subscribers);
    }

    res.json(body);
  };
}
