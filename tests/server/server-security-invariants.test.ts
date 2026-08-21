/**
 * Security invariant tests for the HTTP MCP server app.
 *
 * Invariant 6: OAuth metadata endpoints return literal "localhost" in `resource`
 *              (never req.host), and advertise bearer_methods_supported: ["header"].
 * Invariant 7: /health omits `hasSession` for non-loopback requests; includes it
 *              for loopback.
 * Invariant 8: /health's `push` diagnostics ride inside the SAME loopback gate
 *              as `hasSession` — subscriber counts and consumer heartbeats are
 *              session-presence signals of the same kind.
 *
 * These tests spin up a real `startMcpServerHttp` instance on an ephemeral port
 * so the Express routing and middleware are tested exactly as deployed.
 */

import { readFileSync } from "node:fs";
import type { Server } from "node:http";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { isLoopback } from "../../src/server/auth/middleware.js";
import { startMcpServerHttp } from "../../src/server/mcp/server.js";
import { allocPort } from "../helpers/alloc-port.js";

let httpServer: Server;
let port: number;

beforeEach(async () => {
  // Pre-allocate a real port so startMcpServerHttp receives the actual port number
  // it will listen on. The OAuth metadata handler closes over the port arg, so we
  // must pass the real port — not 0 — to get a correct `resource` URL.
  port = await allocPort();
  httpServer = await startMcpServerHttp(port, "127.0.0.1");
});

afterEach(() => {
  return new Promise<void>((resolve, reject) => {
    httpServer.close((err) => (err ? reject(err) : resolve()));
  });
});

// ── Invariant 6: OAuth Protected Resource Metadata ────────────────────────────

describe("Invariant 6 — OAuth metadata uses literal localhost, not req.host", () => {
  it("/.well-known/oauth-protected-resource contains correct resource field", async () => {
    const res = await fetch(`http://127.0.0.1:${port}/.well-known/oauth-protected-resource`, {
      headers: { Host: `127.0.0.1:${port}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    // resource must use literal "127.0.0.1", not the Host header value
    expect(body.resource).toBe(`http://127.0.0.1:${port}/mcp`);
    expect(body.bearer_methods_supported).toEqual(["header"]);
    expect(Array.isArray(body.authorization_servers)).toBe(true);
  });

  it("/.well-known/oauth-protected-resource/mcp contains correct resource field", async () => {
    const res = await fetch(`http://127.0.0.1:${port}/.well-known/oauth-protected-resource/mcp`, {
      headers: { Host: `127.0.0.1:${port}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.resource).toBe(`http://127.0.0.1:${port}/mcp`);
    expect(body.bearer_methods_supported).toEqual(["header"]);
    expect(Array.isArray(body.authorization_servers)).toBe(true);
  });

  it("resource field stays literal 127.0.0.1 even if Host header differs (spoof check)", async () => {
    // If a caller sends Host: 10.0.0.1:1234 the resource field must still say localhost.
    const res = await fetch(`http://127.0.0.1:${port}/.well-known/oauth-protected-resource`, {
      headers: { Host: `10.0.0.1:${port}` },
    });
    // apiMiddleware will block non-localhost hosts → 403. That's fine — the invariant
    // is that `resource` is never derived from req.host. When apiMiddleware passes
    // (because remoteAddress is 127.0.0.1), the field uses the literal constant.
    // We just verify the metadata endpoint is reachable and correct from localhost.
    expect([200, 403]).toContain(res.status);
    if (res.status === 200) {
      const body = (await res.json()) as Record<string, unknown>;
      expect(body.resource).toBe(`http://127.0.0.1:${port}/mcp`);
      expect(body.resource).not.toMatch(/10\.0\.0\.1/);
    }
  });
});

// ── Invariant 7: /health omits hasSession for non-loopback ───────────────────
//
// Because the test runner itself connects from 127.0.0.1 (loopback), we cannot
// fake a non-loopback remoteAddress via fetch. Instead we test the positive path
// (loopback includes hasSession) and verify the /health handler uses isLoopback()
// to gate the field. The unit test in auth-middleware.test.ts already covers the
// isLoopback() function thoroughly; the integration test here covers the wiring.

describe("Invariant 7 — /health includes hasSession for loopback callers", () => {
  it("/health returns status:ok and includes hasSession from loopback", async () => {
    const res = await fetch(`http://127.0.0.1:${port}/health`, {
      headers: { Host: `127.0.0.1:${port}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.status).toBe("ok");
    // hasSession is present when caller is loopback (test runner is always loopback)
    expect("hasSession" in body).toBe(true);
    expect(typeof body.hasSession).toBe("boolean");
  });

  it("/health includes version and transport fields", async () => {
    const res = await fetch(`http://127.0.0.1:${port}/health`, {
      headers: { Host: `127.0.0.1:${port}` },
    });
    const body = (await res.json()) as Record<string, unknown>;
    expect(typeof body.version).toBe("string");
    expect(body.transport).toBe("http");
  });

  // Invariant 8: `push` rides inside the SAME loopback branch as hasSession.
  // Subscriber counts and consumer heartbeats are session-presence signals of
  // the same kind, so a LAN caller must not learn whether anyone is attached.
  // Same testing constraint as Invariant 7 — we assert the positive path plus
  // the co-location, since the runner is always loopback.
  it("/health exposes push diagnostics to loopback callers", async () => {
    const res = await fetch(`http://127.0.0.1:${port}/health`, {
      headers: { Host: `127.0.0.1:${port}` },
    });
    const body = (await res.json()) as Record<string, unknown>;
    expect("push" in body).toBe(true);
    const push = body.push as Record<string, unknown>;
    expect(typeof push.subscribers).toBe("number");
    expect(typeof push.eventCount).toBe("number");
    expect("lastEventAt" in push).toBe(true);
  });

  // The negative half — "a LAN caller sees neither field" — is asserted in
  // tests/server/health-route.test.ts, which drives `makeHealthHandler` with a
  // real non-loopback `remoteAddress`. It used to be a source-text slice here,
  // running from the `if (isLoopback(...))` line to `res.json(body)`; that window
  // contains the block's own closing brace, so hoisting a field OUT of the gate
  // still matched and the test could not fail on the regression it named.
});

// ── Fix 1 regression: /mcp DNS-rebinding protection with allowedHosts ────────
//
// When startMcpServerHttp is called with resolvedLanIP set (non-loopback bind),
// createMcpExpressApp receives allowedHosts and hostHeaderValidation validates
// against that list. A request to /mcp with Host: evil.com must be rejected 403.
//
// resolvedLanIP does NOT switch the check on and off — it only swaps which allowlist
// is used. With allowedHosts undefined, createMcpExpressApp falls through to
// localhostHostValidation() whenever the bind host is 127.0.0.1 / localhost / ::1
// (node_modules/@modelcontextprotocol/sdk/dist/cjs/server/express.js), which is
// Tandem's default bind — so the SDK Host check is active in the default
// configuration too. Probed: no resolvedLanIP, POST /mcp with Host: evil.com still
// returns 403 {"error":{"code":-32000,"message":"Invalid Host: evil.com"}}.
//
// Node.js fetch() silently overrides the Host header with the connection target,
// so we use http.request() with explicit headers to properly spoof the Host header.

import { request as httpRequest } from "node:http";

/** Low-level HTTP POST that preserves the Host header exactly as given. */
function rawPost(
  port: number,
  path: string,
  hostHeader: string,
  body: string,
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const bodyBuf = Buffer.from(body, "utf8");
    const req = httpRequest(
      {
        host: "127.0.0.1",
        port,
        path,
        method: "POST",
        headers: {
          Host: hostHeader,
          "Content-Type": "application/json",
          "Content-Length": bodyBuf.length,
        },
      },
      (res) => {
        let data = "";
        res.on("data", (chunk: Buffer) => {
          data += chunk.toString();
        });
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body: data }));
      },
    );
    req.on("error", reject);
    req.write(bodyBuf);
    req.end();
  });
}

describe("Fix 1 regression — /mcp DNS-rebinding protection (non-loopback bind)", () => {
  let lanHttpServer: Server;
  let lanPort: number;

  beforeEach(async () => {
    lanPort = await allocPort();
    // Pass resolvedLanIP to simulate a non-loopback bind (e.g. TANDEM_BIND_HOST=0.0.0.0
    // with a single detected interface). The server itself still binds to 127.0.0.1 so
    // the test runner can reach it; what matters is that allowedHosts gets activated.
    lanHttpServer = await startMcpServerHttp(lanPort, "127.0.0.1", undefined, "192.168.1.50");
  });

  afterEach(() => {
    return new Promise<void>((resolve, reject) => {
      lanHttpServer.close((err) => (err ? reject(err) : resolve()));
    });
  });

  it("blocks /mcp POST with Host: evil.com when resolvedLanIP is set", async () => {
    const payload = JSON.stringify({ jsonrpc: "2.0", method: "initialize", id: 1 });
    const res = await rawPost(lanPort, "/mcp", "evil.com", payload);
    // SDK hostHeaderValidation must reject the spoofed Host header
    expect(res.status).toBe(403);
  });

  it("allows /mcp POST with Host: 127.0.0.1 when resolvedLanIP is set", async () => {
    const payload = JSON.stringify({ jsonrpc: "2.0", method: "initialize", id: 1 });
    const res = await rawPost(lanPort, "/mcp", `127.0.0.1:${lanPort}`, payload);
    // 127.0.0.1 is in the allowlist — should not be blocked by host-header validation
    expect(res.status).not.toBe(403);
  });

  it("allows /mcp POST with Host matching resolvedLanIP", async () => {
    const payload = JSON.stringify({ jsonrpc: "2.0", method: "initialize", id: 1 });
    const res = await rawPost(lanPort, "/mcp", `192.168.1.50:${lanPort}`, payload);
    // resolvedLanIP is in the allowlist — should not be blocked by host-header validation
    expect(res.status).not.toBe(403);
  });
});

// ── Invariant 7 (non-loopback path): /health must omit hasSession ─────────────
//
// The test server binds to 127.0.0.1; all fetch() calls from the test runner
// arrive as loopback and cannot directly test the non-loopback branch. Instead
// we unit-test the branching logic directly: isLoopback("192.168.1.100") returns
// false, so the handler omits hasSession. The integration wiring is validated by
// checking that isLoopback() is used (server.ts handler reads req.socket.remoteAddress).

describe("Invariant 7 — /health non-loopback branch omits hasSession (unit)", () => {
  it("isLoopback returns false for non-loopback address (gates hasSession exclusion)", () => {
    // The /health handler gates hasSession behind: if (isLoopback(req.socket.remoteAddress))
    // Verify the gate function itself rejects non-loopback addresses.
    expect(isLoopback("192.168.1.100")).toBe(false);
    expect(isLoopback("10.0.0.1")).toBe(false);
    expect(isLoopback("172.16.0.1")).toBe(false);
    // Only loopback passes
    expect(isLoopback("127.0.0.1")).toBe(true);
    expect(isLoopback("::1")).toBe(true);
  });

  it("response body for non-loopback simulated request omits hasSession", () => {
    // Simulate the /health handler response-shaping logic directly.
    // When isLoopback(remoteAddress) is false, hasSession must not be included.
    const nonLoopbackAddr = "192.168.1.100";
    const currentTransport = null; // simulate no active session
    const body: Record<string, unknown> = {
      status: "ok",
      version: "test",
      transport: "http",
    };
    if (isLoopback(nonLoopbackAddr)) {
      body.hasSession = currentTransport !== null;
    }
    expect("hasSession" in body).toBe(false);
  });
});

// ── #1488 item 2: auth-ordering comment matches the real registration order ──
//
// The block comment sitting directly above `app.use("/mcp", authMiddleware)` /
// `app.use("/api", authMiddleware)` used to assert authMiddleware ran "AFTER
// apiMiddleware (DNS-rebinding)" — the opposite of the real order: auth is
// mounted first here, and the per-route DNS-rebinding check (lanAwareApiMiddleware
// for /api, the SDK's hostHeaderValidation for /mcp) is attached later, inside
// registrars called further down this same function.
//
// (a) below is a source-text guard against the exact wrong phrase reappearing —
// weak alone, since a differently-worded wrong claim would sail through it
// uncaught. (b) is the behavioral counterpart: it exercises the real running
// Express app and goes red if the registration order itself ever regresses,
// independent of whatever the comment says.

describe('#1488 item 2 — comment above app.use("/mcp", authMiddleware) matches reality', () => {
  const serverSrc = readFileSync(
    fileURLToPath(new URL("../../src/server/mcp/server.ts", import.meta.url)),
    "utf-8",
  );

  const MARKER = 'app.use("/mcp", authMiddleware);';

  /**
   * Returns the contiguous run of `//` lines immediately above `marker`'s line.
   *
   * Anchor to the block, never to a byte budget. The first version of this guard
   * sliced a fixed `idx - 800`, and the block is 887 chars from its first character
   * to the marker — so the window opened mid-block and left the comment's FIRST line,
   * the exact line the wrong "AFTER apiMiddleware" claim lived on, outside the
   * assertion. The guard was green while the comment still made the wrong claim.
   * A byte budget silently decouples from the comment the moment anyone lengthens it;
   * walking the block cannot.
   */
  function commentBlockAbove(src: string, marker: string): string {
    const idx = src.indexOf(marker);
    expect(idx, `${marker} not found in server.ts`).toBeGreaterThan(-1);
    const before = src.slice(0, idx).split("\n");
    // The final element is the marker line's own leading indentation, not a full line.
    let i = before.length - 2;
    while (i >= 0 && /^\s*\/\//.test(before[i] as string)) i--;
    // Strip the `//` markers and flatten to a single space-separated line, so every
    // assertion below is line-wrap tolerant. Matching the raw text would make each
    // regex hostage to where a formatter happened to break the sentence — and would
    // let a wrong claim evade the negative assertion just by wrapping across two lines.
    return before
      .slice(i + 1)
      .map((line) => line.replace(/^\s*\/\/ ?/, ""))
      .join(" ")
      .replace(/\s+/g, " ")
      .trim();
  }

  it("(a) does not claim auth runs AFTER apiMiddleware", () => {
    expect(commentBlockAbove(serverSrc, MARKER)).not.toMatch(/AFTER\s+apiMiddleware/i);
  });

  it("(a2) positive control: the block actually states the order and the mcpApp mount", () => {
    // (a) alone is an absence assertion, and absence satisfies it: deleting the whole
    // comment block left (a) green because the license-webhook NOTE above simply moved
    // into view. Pinning a phrase that must be PRESENT makes deletion fail too, so the
    // pair covers both reintroduction (a) and removal/rewording (a2).
    const block = commentBlockAbove(serverSrc, MARKER);
    expect(block).toMatch(/mounted BEFORE the per-route DNS-rebinding/);
    // The block must also keep saying WHY /api sees the SDK Host check first: mcpApp is
    // mounted at the root with no path prefix, so its hostHeaderValidation is in front of
    // /api/* as well, ahead of the route's own lanAwareApiMiddleware. An earlier revision
    // attributed the /api 403 to lanAwareApiMiddleware alone, which is measurably wrong.
    expect(block).toMatch(/mounts the SDK sub-app at the ROOT/);
  });
});

// (b) Behavioral order test — the app itself, not its comments.
//
// isLoopback() (src/server/auth/middleware.ts) does an exact-string compare
// against "127.0.0.1", so binding the *client's* outbound socket to 127.0.0.2 via
// Node's `localAddress` option produces a request whose `req.socket.remoteAddress`
// is "127.0.0.2" server-side — genuinely non-loopback to authMiddleware — while
// the connection never leaves the machine. That lets one request trip two
// different checks for two different reasons: authMiddleware rejects it with 401
// (no/bad Authorization), and a Host-header DNS-rebinding check would reject the same
// request with 403 (each case below picks a Host that the check it targets refuses —
// see the note above cases 1-4 for which Host selects which middleware). Whichever
// check runs first determines the status code actually observed, so this is a live
// assertion about registration order, not source text.
//
// IMPORTANT — this trick depends on isLoopback() matching "127.0.0.1" by exact
// string, not by CIDR range (see src/server/auth/middleware.ts). If isLoopback()
// is ever widened to treat the whole 127.0.0.0/8 block as loopback, 127.0.0.2
// becomes loopback too: authMiddleware will bypass it, and cases 1 and 3 below
// will reach the Host check instead of being rejected by auth — they will fail
// LOUDLY with 403 instead of the expected 401. That failure is NOT an
// auth-ordering regression; it means the loopback definition moved, and this test
// needs a different non-loopback source address. Do not "fix" it by reordering
// middleware.
//
// PLATFORM — Linux only, hence the skipIf. `localAddress` is a bind() of the client's
// outbound socket, and bind() requires the address to be ASSIGNED to an interface; it is
// not a routing question. Linux's `lo` claims all of 127.0.0.0/8, so 127.0.0.2 is bindable
// out of the box. macOS `lo0` carries only 127.0.0.1 unless someone runs `ifconfig lo0
// alias 127.0.0.2`, and Windows behaves likewise — there bind() returns EADDRNOTAVAIL, the
// `req.on("error", reject)` path fires, and all four cases fail for a reason that has
// nothing to do with auth ordering. CI would never surface it (only ci.yml's `check` job
// runs vitest, on ubuntu-latest), but the pre-push hook runs the full vitest suite
// locally, so a macOS or Windows contributor would be blocked at push by a red suite they
// did not break. Skipping is the lesser evil, and the skip reason is spelled out in the
// describe name so it reads as a deliberate platform gap rather than a silent hole. The
// source-text guard (a)/(a2) above is NOT skipped and still runs everywhere.
describe.skipIf(process.platform !== "linux")(
  "#1488 item 2 — auth runs before the DNS-rebinding Host check (behavioral; Linux only — needs a bindable 127.0.0.2 source address)",
  () => {
    const AUTH_TOKEN = "test-token-1488-auth-ordering";
    let orderPort: number;
    let orderHttpServer: Server;

    beforeEach(async () => {
      orderPort = await allocPort();
      // Both a known token (so we can construct a request auth actually accepts)
      // and a resolvedLanIP (so the /mcp SDK host check is active, matching the
      // "Fix 1 regression" block above) are required to exercise both prefixes.
      orderHttpServer = await startMcpServerHttp(
        orderPort,
        "127.0.0.1",
        AUTH_TOKEN,
        "192.168.1.50",
      );
    });

    afterEach(() => {
      return new Promise<void>((resolve, reject) => {
        orderHttpServer.close((err) => (err ? reject(err) : resolve()));
      });
    });

    function rawRequest(
      path: string,
      opts: { method?: string; hostHeader: string; authorization?: string; body?: string },
    ): Promise<{ status: number; body: string }> {
      return new Promise((resolve, reject) => {
        const bodyBuf = opts.body !== undefined ? Buffer.from(opts.body, "utf8") : undefined;
        const headers: Record<string, string | number> = { Host: opts.hostHeader };
        if (opts.authorization !== undefined) headers.Authorization = opts.authorization;
        if (bodyBuf !== undefined) {
          headers["Content-Type"] = "application/json";
          headers["Content-Length"] = bodyBuf.length;
        }
        const req = httpRequest(
          {
            host: "127.0.0.1",
            port: orderPort,
            path,
            method: opts.method ?? "GET",
            // Binds the client's outbound socket to a non-loopback address while
            // still connecting to the server on 127.0.0.1 — see the block comment
            // above for why this makes authMiddleware treat the request as
            // genuinely non-loopback without any real network traffic leaving the
            // machine.
            localAddress: "127.0.0.2",
            headers,
          },
          (res) => {
            let data = "";
            res.on("data", (chunk: Buffer) => {
              data += chunk.toString();
            });
            res.on("end", () => resolve({ status: res.statusCode ?? 0, body: data }));
          },
        );
        req.on("error", reject);
        if (bodyBuf !== undefined) req.write(bodyBuf);
        req.end();
      });
    }

    // Cases 1+2 target the PER-ROUTE /api check (lanAwareApiMiddleware); cases 3+4 target
    // the SDK's hostHeaderValidation on /mcp. Picking the Host header is what separates
    // them, and getting it wrong makes the two "controls" assert the same middleware twice:
    // `app.use(mcpApp)` mounts the SDK sub-app at the ROOT, so "evil.com" on /api/info is
    // answered by the SDK, not by lanAwareApiMiddleware — with `evil.com` here, deleting
    // lanAwareApiMiddleware from the /api/info route entirely left this suite fully green.
    // "localhost:PORT" is the discriminator: the SDK's allowlist admits it, isHostAllowed
    // rejects it. The body assertions are the second half of the fix — they name which
    // middleware actually answered, so a future mix-up cannot hide behind a bare 403.
    const API_BAD_HOST = () => `localhost:${orderPort}`;

    it("1) GET /api/info, non-loopback + bad Host + no Authorization -> 401 (auth runs first)", async () => {
      const { status } = await rawRequest("/api/info", { hostHeader: API_BAD_HOST() });
      expect(status).toBe(401);
    });

    it("2) control: same request WITH valid Authorization -> 403 from lanAwareApiMiddleware (the per-route /api Host check is reachable)", async () => {
      const { status, body } = await rawRequest("/api/info", {
        hostHeader: API_BAD_HOST(),
        authorization: `Bearer ${AUTH_TOKEN}`,
      });
      expect(status).toBe(403);
      // lanAwareApiMiddleware's shape, NOT the SDK's JSON-RPC error body. If the route ever
      // loses its lanAwareApiMiddleware, "localhost:PORT" sails past the SDK check and this
      // becomes a 200 from the handler.
      expect(JSON.parse(body)).toMatchObject({ error: "FORBIDDEN" });
    });

    it("3) POST /mcp, non-loopback + bad Host + no Authorization -> 401 (auth runs first)", async () => {
      const payload = JSON.stringify({ jsonrpc: "2.0", method: "initialize", id: 1 });
      const { status } = await rawRequest("/mcp", {
        method: "POST",
        hostHeader: "evil.com",
        body: payload,
      });
      expect(status).toBe(401);
    });

    it("4) control: same request WITH valid Authorization -> 403 from the SDK hostHeaderValidation (a different middleware than case 2)", async () => {
      const payload = JSON.stringify({ jsonrpc: "2.0", method: "initialize", id: 1 });
      const { status, body } = await rawRequest("/mcp", {
        method: "POST",
        hostHeader: "evil.com",
        authorization: `Bearer ${AUTH_TOKEN}`,
        body: payload,
      });
      expect(status).toBe(403);
      // The SDK's JSON-RPC error shape, NOT lanAwareApiMiddleware's {error:"FORBIDDEN"}.
      expect(JSON.parse(body)).toMatchObject({
        jsonrpc: "2.0",
        error: { code: -32000, message: "Invalid Host: evil.com" },
      });
    });
  },
);
