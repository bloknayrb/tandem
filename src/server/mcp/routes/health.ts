import type { Request, Response } from "express";
import { isLoopback } from "../../auth/middleware.js";
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
}

/**
 * GET /health — public liveness, plus loopback-only diagnostics.
 *
 * Public: `status`, `version`, `transport`. Loopback-only: `hasSession` and `push`.
 *
 * Both gated fields are session-presence signals — whether an AI is attached, and
 * whether a real-time consumer is receiving — so they are withheld from LAN callers
 * for the same reason. Note "loopback socket" is a weaker boundary than it sounds:
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
 */
export function makeHealthHandler(deps: HealthHandlerDeps): Handler {
  return (req: Request, res: Response): void => {
    const body: Record<string, unknown> = {
      status: "ok",
      version: deps.version,
      transport: "http",
    };

    if (isLoopback(req.socket.remoteAddress)) {
      body.hasSession = deps.hasSession();
      body.push = {
        subscribers: deps.getSubscriberCount(),
        ...deps.getPushLiveness(),
      };
    }

    res.json(body);
  };
}
