/**
 * Tests for src/server/auth/middleware.ts
 *
 * Uses mock req/res/next objects — supertest cannot override req.socket.remoteAddress
 * reliably. Each test constructs a fresh middleware instance so rate-limit maps start empty.
 */

import type { NextFunction, Request, Response } from "express";
import { describe, expect, it, vi } from "vitest";
import { createAuthMiddleware, isLoopback } from "../../src/server/auth/middleware.js";

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeReq(
  remoteAddress: string | undefined,
  authHeader?: string,
  hostHeader?: string,
): Request {
  return {
    socket: { remoteAddress },
    headers: {
      ...(authHeader !== undefined ? { authorization: authHeader } : {}),
      ...(hostHeader !== undefined ? { host: hostHeader } : {}),
    },
  } as unknown as Request;
}

function makeRes() {
  const res = {
    _status: 0,
    _body: null as unknown,
    status(code: number) {
      this._status = code;
      return this;
    },
    json(body: unknown) {
      this._body = body;
      return this;
    },
  };
  return res;
}

const VALID_TOKEN = "abcdefghijklmnopqrstuvwxyz123456"; // 32 chars, alphanumeric
const VALID_TOKEN_B = "ABCDEFGHIJKLMNOPQRSTUVWXYZ123456"; // different 32-char token
const LAN_ADDR = "192.168.1.100";

// ── isLoopback unit tests ─────────────────────────────────────────────────────

describe("isLoopback", () => {
  it("127.0.0.1 is loopback", () => {
    expect(isLoopback("127.0.0.1")).toBe(true);
  });

  it("::1 is loopback", () => {
    expect(isLoopback("::1")).toBe(true);
  });

  it("::ffff:127.0.0.1 is loopback", () => {
    expect(isLoopback("::ffff:127.0.0.1")).toBe(true);
  });

  it("undefined is NOT loopback (fail-closed)", () => {
    expect(isLoopback(undefined)).toBe(false);
  });

  it("LAN address is not loopback", () => {
    expect(isLoopback(LAN_ADDR)).toBe(false);
  });
});

// ── Loopback bypass ───────────────────────────────────────────────────────────

describe("loopback bypass", () => {
  const getToken = () => VALID_TOKEN;

  it("127.0.0.1 skips auth entirely", () => {
    const mw = createAuthMiddleware(getToken);
    const next = vi.fn();
    const res = makeRes();
    mw(makeReq("127.0.0.1"), res as unknown as Response, next);
    expect(next).toHaveBeenCalledOnce();
    expect(res._status).toBe(0); // no status set
  });

  it("::1 skips auth entirely", () => {
    const mw = createAuthMiddleware(getToken);
    const next = vi.fn();
    const res = makeRes();
    mw(makeReq("::1"), res as unknown as Response, next);
    expect(next).toHaveBeenCalledOnce();
  });

  it("::ffff:127.0.0.1 skips auth entirely", () => {
    const mw = createAuthMiddleware(getToken);
    const next = vi.fn();
    const res = makeRes();
    mw(makeReq("::ffff:127.0.0.1"), res as unknown as Response, next);
    expect(next).toHaveBeenCalledOnce();
  });
});

// ── Basic auth behavior ───────────────────────────────────────────────────────

describe("non-loopback auth", () => {
  it("LAN address without token → 401", () => {
    const mw = createAuthMiddleware(() => VALID_TOKEN);
    const next = vi.fn();
    const res = makeRes();
    mw(makeReq(LAN_ADDR), res as unknown as Response, next);
    expect(next).not.toHaveBeenCalled();
    expect(res._status).toBe(401);
  });

  it("LAN address with valid token → next() called (200)", () => {
    const mw = createAuthMiddleware(() => VALID_TOKEN);
    const next = vi.fn();
    const res = makeRes();
    mw(makeReq(LAN_ADDR, `Bearer ${VALID_TOKEN}`), res as unknown as Response, next);
    expect(next).toHaveBeenCalledOnce();
    expect(res._status).toBe(0);
  });

  it("LAN address with wrong token → 401", () => {
    const mw = createAuthMiddleware(() => VALID_TOKEN);
    const next = vi.fn();
    const res = makeRes();
    mw(makeReq(LAN_ADDR, `Bearer ${VALID_TOKEN_B}`), res as unknown as Response, next);
    expect(next).not.toHaveBeenCalled();
    expect(res._status).toBe(401);
  });
});

// ── Invariant 1 — Host header cannot bypass loopback check ───────────────────

describe("Invariant 1 — Host header cannot bypass loopback check", () => {
  it("forged Host: 127.0.0.1 with LAN remoteAddress → 401 (not bypass)", () => {
    const mw = createAuthMiddleware(() => VALID_TOKEN);
    const next = vi.fn();
    const res = makeRes();
    // remoteAddress is LAN, Host is spoofed to 127.0.0.1
    mw(
      makeReq(LAN_ADDR, undefined, "127.0.0.1"),
      res as unknown as Response,
      next as unknown as NextFunction,
    );
    expect(next).not.toHaveBeenCalled();
    expect(res._status).toBe(401);
  });
});

// ── SHA-256 length-mismatch safety ───────────────────────────────────────────

describe("SHA-256 approach handles token length variants without throwing", () => {
  // Since we hash both sides to fixed 32-byte digests, timingSafeEqual never
  // sees a length mismatch. All these should complete without throwing — just returning 401.
  const lengths = [1, 31, 32, 33, 64, 1024];

  for (const len of lengths) {
    it(`length=${len} token processes without throwing`, () => {
      const mw = createAuthMiddleware(() => VALID_TOKEN);
      const next = vi.fn();
      const res = makeRes();
      const badToken = "x".repeat(len);
      expect(() => {
        mw(makeReq(LAN_ADDR, `Bearer ${badToken}`), res as unknown as Response, next);
      }).not.toThrow();
      // Length-1 is the zero-length-after-trim edge — 32+ are just wrong tokens
      if (len > 0) {
        expect(res._status).toBe(401);
      }
    });
  }
});

// ── Rate limiting ─────────────────────────────────────────────────────────────

describe("rate limiting", () => {
  it("5 failures still yield 401 (not 429)", () => {
    const mw = createAuthMiddleware(() => VALID_TOKEN);
    const res = makeRes();
    for (let i = 0; i < 5; i++) {
      mw(makeReq(LAN_ADDR), res as unknown as Response, vi.fn());
      expect(res._status).toBe(401);
    }
  });

  it("6th failure yields 429", () => {
    const mw = createAuthMiddleware(() => VALID_TOKEN);
    // First 5 failures
    for (let i = 0; i < 5; i++) {
      mw(makeReq(LAN_ADDR), makeRes() as unknown as Response, vi.fn());
    }
    // 6th failure (over limit recorded after 5th failure increments to 5, limit is >5 = 6th is rate-limited)
    const res = makeRes();
    mw(makeReq(LAN_ADDR), res as unknown as Response, vi.fn());
    expect(res._status).toBe(429);
  });

  it("IPv6 /64 keying: same /64 shares fail bucket", () => {
    const mw = createAuthMiddleware(() => VALID_TOKEN);
    const addr1 = "2001:db8:1:2:0:0:0:1";
    const addr2 = "2001:db8:1:2:0:0:0:2"; // same /64 as addr1

    // 5 failures from addr1
    for (let i = 0; i < 5; i++) {
      mw(makeReq(addr1), makeRes() as unknown as Response, vi.fn());
    }

    // addr2 from the same /64 should now be rate-limited (429)
    const res = makeRes();
    mw(makeReq(addr2), res as unknown as Response, vi.fn());
    expect(res._status).toBe(429);
  });
});

// ── Log redaction ─────────────────────────────────────────────────────────────

describe("log redaction", () => {
  it("rejection log does not contain the Authorization header value", () => {
    const mw = createAuthMiddleware(() => VALID_TOKEN);
    const logLines: string[] = [];
    const origError = console.error;
    console.error = (...args: unknown[]) => {
      logLines.push(args.map(String).join(" "));
    };

    try {
      const secretToken = "super-secret-token-value-do-not-log";
      mw(makeReq(LAN_ADDR, `Bearer ${secretToken}`), makeRes() as unknown as Response, vi.fn());
    } finally {
      console.error = origError;
    }

    for (const line of logLines) {
      expect(line).not.toContain("super-secret-token-value-do-not-log");
    }
  });
});
