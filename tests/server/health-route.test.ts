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

const DEPS = {
  version: "0.0.0-test",
  hasSession: () => true,
  getSubscriberCount: () => 3,
  getPushLiveness: () => ({ lastEventAt: 1_700_000_000_000, eventCount: 42 }),
};

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

  it("includes hasSession and push for a loopback caller", () => {
    const body = callWith("127.0.0.1");
    expect(body.hasSession).toBe(true);
    expect(body.push).toEqual({
      subscribers: 3,
      lastEventAt: 1_700_000_000_000,
      eventCount: 42,
    });
  });

  // The assertion the old source scan could not make. Both fields are
  // session-presence signals; neither may reach a LAN caller.
  it("omits BOTH hasSession and push for a non-loopback caller", () => {
    const body = callWith("192.168.1.100");
    expect("hasSession" in body).toBe(false);
    expect("push" in body).toBe(false);
  });

  it("fails closed when the socket has no remote address", () => {
    const body = callWith(undefined);
    expect("hasSession" in body).toBe(false);
    expect("push" in body).toBe(false);
  });

  // A document id is not opaque — docIdFromPath is `<basename-slug>-<hash>`, so
  // retaining one would put a filename in every /health response. The liveness
  // struct deliberately carries only counters; this pins that it stays that way.
  it("exposes no document identifier in the push payload", () => {
    const body = callWith("127.0.0.1");
    const push = body.push as Record<string, unknown>;
    expect(Object.keys(push).sort()).toEqual(["eventCount", "lastEventAt", "subscribers"]);
  });
});
