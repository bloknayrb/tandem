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

import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { makeHealthHandler } from "../../src/server/mcp/routes/health.js";

function makeMockRes() {
  const mock = {
    _body: null as Record<string, unknown> | null,
    // Recorded, not ignored: the shutdown case below asserts the handler never
    // downgrades the status CODE (which the Tauri shell reads as "gone").
    _status: undefined as number | undefined,
    status(code: number) {
      mock._status = code;
      return mock;
    },
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
let shuttingDown = false;
const DEPS = {
  version: "0.0.0-test",
  hasSession: () => true,
  getSubscriberCount: () => 3,
  getPushLiveness: () => ({ lastEventAt: 1_700_000_000_000, eventCount: 42 }),
  getDeliveryState: (externalConsumerCount: number) => {
    seenCounts.push(externalConsumerCount);
    return DELIVERY;
  },
  isShuttingDown: () => shuttingDown,
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

  // #1812: the Tauri shell compares this against the child it spawned, so a
  // 2xx from a previous process still holding the port stops reading as "our
  // sidecar is healthy". Loopback-only like every other identity signal here —
  // the absent half is what kills hoisting the field out of the gate.
  it("reports the process pid to a loopback caller and to nobody else", () => {
    expect(callWith("127.0.0.1").pid).toBe(process.pid);
    expect(callWith("203.0.113.5").pid).toBeUndefined();
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

/**
 * #1758 review — a Tandem that is shutting down must not probe as live.
 *
 * `shutdown()` closes the HTTP listener LAST, after up to ~7s of flushing, so
 * for that whole window `/health` answered `status: "ok"` with a real `pid`.
 * `probeTandemInstance` read that as a live instance and the REPLACEMENT
 * process exited 1 — Ctrl-C and re-run within a few seconds, or any wrapper
 * that SIGTERMs then respawns.
 */
describe("GET /health — shutdown state", () => {
  afterEach(() => {
    shuttingDown = false;
  });

  it("reports status ok while running", () => {
    expect(callWith("127.0.0.1").status).toBe("ok");
  });

  it("reports status shutting-down once shutdown has begun", () => {
    shuttingDown = true;
    for (const addr of ["127.0.0.1", "192.168.1.100"]) {
      expect(callWith(addr).status).toBe("shutting-down");
    }
  });

  /**
   * The status CODE must stay 2xx. The Tauri shell's `wait_for_server_gone`
   * treats any non-2xx as "the sidecar has exited" and then hard-kills the
   * child, so a 503 here would truncate the very flush the graceful stop
   * exists to perform. See `src/server/shutdown-state.ts`.
   */
  it("keeps the response a 200 while shutting down", () => {
    shuttingDown = true;
    const res = makeMockRes();
    // biome-ignore lint/suspicious/noExplicitAny: minimal Express req/res doubles
    makeHealthHandler(DEPS)(makeMockReq("127.0.0.1") as any, res as any, (() => {}) as any);
    expect(res._status ?? 200).toBe(200);
  });

  /**
   * The join with `probeTandemInstance`: the probe's `status !== "ok"` guard is
   * what turns this field into "do not refuse your own replacement". Asserted
   * against the real predicate's source rather than restating the string, so a
   * rename on either side fails here.
   */
  it("emits a status the startup probe rejects", () => {
    shuttingDown = true;
    const status = callWith("127.0.0.1").status;
    expect(status).not.toBe("ok");
    const probeSource = readFileSync(
      new URL("../../src/server/platform.ts", import.meta.url),
      "utf8",
    );
    expect(probeSource).toContain('if (record.status !== "ok") return null;');
  });
});
