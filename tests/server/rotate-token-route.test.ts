/**
 * Integration tests for the POST /api/rotate-token route handler.
 *
 * These tests spin up a real `startMcpServerHttp` instance so the full Express
 * middleware stack (DNS-rebinding, auth, route) is exercised as deployed.
 *
 * All requests are sent from 127.0.0.1 (loopback), so auth middleware bypasses
 * token validation — the route itself is what we're testing here.
 *
 * `readTokenFromFile` is mocked to avoid disk I/O and make the "new token" value
 * predictable in assertions.
 */

import type { Server } from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearPreviousToken, getPreviousToken } from "../../src/server/auth/middleware.js";
import { startMcpServerHttp } from "../../src/server/mcp/server.js";
import { allocPort } from "../helpers/alloc-port.js";

// ── Module-level stub (vi.hoisted so it's available inside the hoisted vi.mock factory) ─────

const { _readTokenFromFileSpy } = vi.hoisted(() => ({
  _readTokenFromFileSpy: vi.fn(),
}));

vi.mock("../../src/server/auth/token-store.js", async (importOriginal) => {
  const actual = (await importOriginal()) as typeof import("../../src/server/auth/token-store.js");
  return {
    ...actual,
    readTokenFromFile: _readTokenFromFileSpy,
  };
});

// ── Helpers ───────────────────────────────────────────────────────────────────

const KNOWN_TOKEN = "oldtoken_oldtoken_oldtoken_oldtoken"; // seeded into tokenRef.current
const NEW_TOKEN = "newtoken_newtoken_newtoken_newtoken"; // returned by mocked readTokenFromFile

// ── Test lifecycle ────────────────────────────────────────────────────────────

let httpServer: Server;
let port: number;

function closeServer(s: Server): Promise<void> {
  return new Promise<void>((resolve) => {
    // Ignore "not running" errors — test may have closed it already
    s.close((err) => {
      if (err && (err as NodeJS.ErrnoException).code !== "ERR_SERVER_NOT_RUNNING") {
        console.error("server close error:", err);
      }
      resolve();
    });
  });
}

beforeEach(async () => {
  delete process.env.TANDEM_AUTH_TOKEN;
  clearPreviousToken();
  _readTokenFromFileSpy.mockReset().mockResolvedValue(NEW_TOKEN);

  port = await allocPort();
  // Pass KNOWN_TOKEN so tokenRef.current is seeded (the "old" token before rotation)
  httpServer = await startMcpServerHttp(port, "127.0.0.1", KNOWN_TOKEN);
});

afterEach(async () => {
  clearPreviousToken();
  delete process.env.TANDEM_AUTH_TOKEN;
  await closeServer(httpServer);
});

// ── Route handler tests ───────────────────────────────────────────────────────

describe("POST /api/rotate-token — route handler", () => {
  it("returns 200 { ok: true } and activates the grace window", async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/rotate-token`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Host: `127.0.0.1:${port}`,
        Authorization: `Bearer ${KNOWN_TOKEN}`,
      },
      body: JSON.stringify({}),
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toEqual({ ok: true });

    // Grace window: old token should now be in the previous-token slot
    const slot = getPreviousToken();
    expect(slot).toBeDefined();
    expect(slot!.value).toBe(KNOWN_TOKEN);
    expect(slot!.expiresAt).toBeGreaterThan(Date.now());
  });

  it("reads new token from disk and uses it (readTokenFromFile was called)", async () => {
    await fetch(`http://127.0.0.1:${port}/api/rotate-token`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Host: `127.0.0.1:${port}`,
        Authorization: `Bearer ${KNOWN_TOKEN}`,
      },
      body: JSON.stringify({}),
    });

    expect(_readTokenFromFileSpy).toHaveBeenCalledOnce();
  });

  it("returns 500 when readTokenFromFile returns null (no token on disk)", async () => {
    _readTokenFromFileSpy.mockResolvedValue(null);

    const res = await fetch(`http://127.0.0.1:${port}/api/rotate-token`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Host: `127.0.0.1:${port}`,
        Authorization: `Bearer ${KNOWN_TOKEN}`,
      },
      body: JSON.stringify({}),
    });

    expect(res.status).toBe(500);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toHaveProperty("error", "INTERNAL");
  });

  it("returns 500 when readTokenFromFile throws", async () => {
    _readTokenFromFileSpy.mockRejectedValue(new Error("disk error"));

    const res = await fetch(`http://127.0.0.1:${port}/api/rotate-token`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Host: `127.0.0.1:${port}`,
        Authorization: `Bearer ${KNOWN_TOKEN}`,
      },
      body: JSON.stringify({}),
    });

    expect(res.status).toBe(500);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toHaveProperty("error", "INTERNAL");
  });

  it("returns 409 when TANDEM_AUTH_TOKEN env is set (Tauri guard)", async () => {
    process.env.TANDEM_AUTH_TOKEN = "tauri-managed-token";

    const res = await fetch(`http://127.0.0.1:${port}/api/rotate-token`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Host: `127.0.0.1:${port}`,
        Authorization: `Bearer ${KNOWN_TOKEN}`,
      },
      body: JSON.stringify({}),
    });

    expect(res.status).toBe(409);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toHaveProperty("error");
    expect(String(body.error)).toContain("Tauri");

    // Token was NOT read from disk when the guard fires
    expect(_readTokenFromFileSpy).not.toHaveBeenCalled();
  });

  it("does not put previousToken in the grace slot when getCurrentToken returns null", async () => {
    // Close the existing server (has KNOWN_TOKEN) and start one with no initial token.
    await closeServer(httpServer);

    const noTokenPort = await allocPort();
    const noTokenServer = await startMcpServerHttp(noTokenPort, "127.0.0.1"); // no token arg

    // Update httpServer so afterEach closes the new server, not the already-closed one.
    httpServer = noTokenServer;

    const res = await fetch(`http://127.0.0.1:${noTokenPort}/api/rotate-token`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Host: `127.0.0.1:${noTokenPort}`,
      },
      body: JSON.stringify({}),
    });

    expect(res.status).toBe(200);
    // No old token → grace slot should NOT be set
    expect(getPreviousToken()).toBeUndefined();
  });

  // --- CSRF: the simple-request vector -------------------------------------
  //
  // These four run the ACTUAL attack rather than asserting a guard exists.
  // Each sends a CORS-safelisted content type, which is what makes the request
  // "simple" and skips the preflight entirely; the socket is loopback, so
  // neither enforceLoopbackMutation nor authMiddleware objects. Before the fix
  // every one of them rotated the token and armed the grace window.
  for (const [label, contentType] of [
    ["text/plain", "text/plain"],
    ["form-urlencoded", "application/x-www-form-urlencoded"],
    ["multipart", "multipart/form-data; boundary=x"],
    ["no Content-Type at all", ""],
  ] as const) {
    it(`refuses a simple-request POST (${label}) and leaves the grace window unarmed`, async () => {
      const headers: Record<string, string> = {
        Host: `127.0.0.1:${port}`,
        Authorization: `Bearer ${KNOWN_TOKEN}`,
      };
      if (contentType) headers["Content-Type"] = contentType;

      const res = await fetch(`http://127.0.0.1:${port}/api/rotate-token`, {
        method: "POST",
        headers,
        body: "irrelevant",
      });

      expect(res.status).toBe(400);
      // The status alone would be satisfied by a route that 400s everything --
      // and the control below is what rules that out. This assertion is the
      // one that matters: the SIDE EFFECT must not have happened.
      expect(
        getPreviousToken(),
        "the grace window was armed, so the refusal came after the rotation",
      ).toBeUndefined();
      expect(_readTokenFromFileSpy).not.toHaveBeenCalled();
    });
  }

  it("still accepts the CLI's shape — application/json with {} — and rotates", async () => {
    // Required-GREEN control. The CLI (src/cli/rotate-token.ts:73-80) sends
    // exactly this, and it sends NO Origin header, which is why the fix above
    // is a body check and not assertOriginAllowlisted: that gate fails closed
    // on a missing Origin and would 403 every real rotation, after which the
    // CLI rolls the new token back off disk.
    const res = await fetch(`http://127.0.0.1:${port}/api/rotate-token`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Host: `127.0.0.1:${port}`,
        Authorization: `Bearer ${KNOWN_TOKEN}`,
        // deliberately no Origin
      },
      body: JSON.stringify({}),
    });

    expect(res.status).toBe(200);
    expect(_readTokenFromFileSpy).toHaveBeenCalledOnce();
  });
});
