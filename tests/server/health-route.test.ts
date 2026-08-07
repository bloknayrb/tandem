/**
 * `/health`'s loopback gate, tested against a genuine non-loopback request.
 *
 * This replaces a source-text assertion in `server-security-invariants.test.ts`
 * that could not fail. It sliced the handler's source from the
 * `if (isLoopback(req.socket.remoteAddress))` line to `res.json(body)` and
 * asserted both gated fields appeared inside that window — but the window
 * contains the block's own closing brace, so hoisting a field OUT of the gate
 * still matched. It gave assurance about a regression it could not detect.
 *
 * The handler is a factory precisely so the gate can be driven directly. The
 * file-level constraint that motivated the source scan ("vitest always connects
 * from 127.0.0.1") is about `fetch`, not about calling a handler.
 */

import { describe, expect, it } from "vitest";
import { makeHealthHandler } from "../../src/server/mcp/routes/health.js";

function makeMockRes() {
  const mock = {
    _body: null as Record<string, unknown> | null,
    json(body: Record<string, unknown>) {
      mock._body = body;
    },
  };
  return mock;
}

function makeMockReq(remoteAddress: string | undefined) {
  return { socket: { remoteAddress } };
}

const DELIVERY = {
  pollCount: 7,
  forwardCount: 4,
  state: "polled" as const,
  latencyMs: 9_000,
  waitingMs: null,
  sincePollMs: 1_200,
};

const seenCounts: number[] = [];
const DEPS = {
  version: "0.0.0-test",
  hasSession: () => true,
  getSubscriberCount: () => 3,
  getPushLiveness: () => ({ lastEventAt: 1_700_000_000_000, eventCount: 42 }),
  getDeliveryState: (externalConsumerCount: number) => {
    seenCounts.push(externalConsumerCount);
    return DELIVERY;
  },
};

/**
 * The public field set, enumerated. Every OTHER key the handler can emit is
 * gated, so asserting equality here catches a new gated field hoisted out of
 * the `isLoopback` block — which naming the gated fields one by one cannot,
 * since a test that lists `hasSession` and `push` stays green forever no matter
 * what is added beside them.
 */
const PUBLIC_KEYS = ["status", "transport", "version"];

function callWith(remoteAddress: string | undefined): Record<string, unknown> {
  const res = makeMockRes();
  // biome-ignore lint/suspicious/noExplicitAny: minimal Express req/res doubles
  makeHealthHandler(DEPS)(makeMockReq(remoteAddress) as any, res as any, (() => {}) as any);
  if (!res._body) throw new Error("handler did not respond");
  return res._body;
}

describe("GET /health — loopback gate", () => {
  it("returns public fields to every caller", () => {
    for (const addr of ["127.0.0.1", "192.168.1.100"]) {
      const body = callWith(addr);
      expect(body.status).toBe("ok");
      expect(body.version).toBe("0.0.0-test");
      expect(body.transport).toBe("http");
    }
  });

  it("includes hasSession, push and delivery for a loopback caller", () => {
    const body = callWith("127.0.0.1");
    expect(body.hasSession).toBe(true);
    expect(body.push).toEqual({
      subscribers: 3,
      lastEventAt: 1_700_000_000_000,
      eventCount: 42,
    });
    expect(body.delivery).toEqual(DELIVERY);
  });

  // The assertion the old source scan could not make, in the form that also
  // covers fields nobody has written yet. `delivery` is the case that motivated
  // widening it: its counters trace when a human's messages arrive and whether
  // anyone answers, so it is the most sensitive field on the route, not the least.
  it("emits ONLY the public fields to a non-loopback caller", () => {
    expect(Object.keys(callWith("192.168.1.100")).sort()).toEqual(PUBLIC_KEYS);
  });

  it("fails closed when the socket has no remote address", () => {
    expect(Object.keys(callWith(undefined)).sort()).toEqual(PUBLIC_KEYS);
  });

  // A document id is not opaque — docIdFromPath is `<basename-slug>-<hash>`, so
  // retaining one would put a filename in every /health response. The liveness
  // struct deliberately carries only counters; this pins that it stays that way.
  it("exposes no document identifier in the push payload", () => {
    const body = callWith("127.0.0.1");
    const push = body.push as Record<string, unknown>;
    expect(Object.keys(push).sort()).toEqual(["eventCount", "lastEventAt", "subscribers"]);
  });

  // Same rule for the join, and it needs saying separately: `delivery` is
  // derived from real user messages, so the tempting next field is "what was
  // waiting" — a document id, an annotation id, a text snippet. Counters and
  // timestamps only.
  it("exposes only counters and timestamps in the delivery payload", () => {
    const delivery = callWith("127.0.0.1").delivery as Record<string, unknown>;
    for (const [key, value] of Object.entries(delivery)) {
      expect(
        value === null || typeof value === "number" || typeof value === "string",
        `delivery.${key} must be a scalar, got ${typeof value}`,
      ).toBe(true);
    }
    expect(Object.keys(delivery).sort()).toEqual([
      "forwardCount",
      "latencyMs",
      "pollCount",
      "sincePollMs",
      "state",
      "waitingMs",
    ]);
  });

  // The contradiction this route could otherwise emit: `push.subscribers: 0`
  // beside `delivery.state: "awaiting-poll"` with waitingMs climbing for days.
  // Both must come from ONE read of the count, so they cannot disagree within a
  // single response.
  it("feeds the SAME subscriber count into push and into the join", () => {
    seenCounts.length = 0;
    const body = callWith("127.0.0.1");
    const push = body.push as Record<string, unknown>;
    expect(seenCounts).toEqual([push.subscribers]);
  });
});
