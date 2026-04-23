/**
 * Tests for `tandem rotate-token` (src/cli/rotate-token.ts).
 *
 * vi.mock calls are hoisted to file top by Vitest — factories cannot reference
 * variables. We use module-level vi.fn() stubs that `beforeEach` reconfigures
 * via `.mockResolvedValue` / `.mockRejectedValue`.
 */

import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearPreviousToken,
  getPreviousToken,
  setPreviousToken,
} from "../../src/server/auth/middleware.js";

// ── Top-level stubs (referenced by vi.mock factories) ────────────────────────

const _writeFileSpy = vi.fn().mockResolvedValue(undefined);
const _renameSpy = vi.fn().mockResolvedValue(undefined);
const _readTokenSpy = vi.fn().mockResolvedValue("oldtoken_oldtoken_oldtoken_oldtoken");
const _getTokenPathSpy = vi.fn().mockReturnValue("/tmp/tandem/token");
const _applyConfigSpy = vi.fn().mockResolvedValue({ updated: 2, errors: [] });

// ── Module mocks ─────────────────────────────────────────────────────────────

vi.mock("node:fs", async (importOriginal) => {
  const actual = (await importOriginal()) as typeof import("node:fs");
  return {
    ...actual,
    promises: {
      ...actual.promises,
      writeFile: _writeFileSpy,
      rename: _renameSpy,
    },
  };
});

vi.mock("../../src/shared/auth/token-file.js", () => ({
  readTokenFromFile: _readTokenSpy,
  getTokenFilePath: _getTokenPathSpy,
}));

vi.mock("../../src/cli/setup.js", () => ({
  applyConfigWithToken: _applyConfigSpy,
}));

// ── Constants ─────────────────────────────────────────────────────────────────

const OLD_TOKEN = "oldtoken_oldtoken_oldtoken_oldtoken"; // 35 chars
const NEW_TOKEN = "newtoken_newtoken_newtoken_newtoken"; // 35 chars

// ── middleware grace-window unit tests ────────────────────────────────────────

describe("setPreviousToken / getPreviousToken", () => {
  afterEach(() => {
    clearPreviousToken();
  });

  it("returns undefined before any token is set", () => {
    expect(getPreviousToken()).toBeUndefined();
  });

  it("returns the slot immediately after setting", () => {
    setPreviousToken(OLD_TOKEN, 5000);
    const slot = getPreviousToken();
    expect(slot).toBeDefined();
    expect(slot!.value).toBe(OLD_TOKEN);
    expect(slot!.expiresAt).toBeGreaterThan(Date.now());
  });

  it("returns undefined after the TTL elapses (fake timers)", () => {
    vi.useFakeTimers();
    setPreviousToken(OLD_TOKEN, 100);
    vi.advanceTimersByTime(200);
    expect(getPreviousToken()).toBeUndefined();
    vi.useRealTimers();
  });

  it("overwrites previous slot on second call", () => {
    setPreviousToken(OLD_TOKEN, 5000);
    setPreviousToken("another_token_another_token_another_token", 5000);
    expect(getPreviousToken()!.value).toBe("another_token_another_token_another_token");
  });
});

// ── middleware two-slot auth ──────────────────────────────────────────────────

describe("createAuthMiddleware grace window", () => {
  afterEach(() => {
    clearPreviousToken();
  });

  function makeReq(remoteAddress: string, authHeader?: string) {
    return {
      socket: { remoteAddress },
      headers: authHeader !== undefined ? { authorization: authHeader } : {},
    } as unknown as import("express").Request;
  }

  function makeRes() {
    return {
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
  }

  it("accepts current token", async () => {
    const { createAuthMiddleware } = await import("../../src/server/auth/middleware.js");
    const mw = createAuthMiddleware(() => OLD_TOKEN);
    const req = makeReq("192.168.1.1", `Bearer ${OLD_TOKEN}`);
    const res = makeRes();
    const next = vi.fn();
    mw(
      req,
      res as unknown as import("express").Response,
      next as unknown as import("express").NextFunction,
    );
    expect(next).toHaveBeenCalledOnce();
  });

  it("accepts previous token during grace window", async () => {
    const { createAuthMiddleware } = await import("../../src/server/auth/middleware.js");
    setPreviousToken(OLD_TOKEN, 60_000);
    const mw = createAuthMiddleware(() => NEW_TOKEN);
    const req = makeReq("192.168.1.1", `Bearer ${OLD_TOKEN}`);
    const res = makeRes();
    const next = vi.fn();
    mw(
      req,
      res as unknown as import("express").Response,
      next as unknown as import("express").NextFunction,
    );
    expect(next).toHaveBeenCalledOnce();
  });

  it("rejects previous token after grace window expires", async () => {
    vi.useFakeTimers();
    const { createAuthMiddleware } = await import("../../src/server/auth/middleware.js");
    setPreviousToken(OLD_TOKEN, 100);
    const mw = createAuthMiddleware(() => NEW_TOKEN);
    vi.advanceTimersByTime(200);
    const req = makeReq("192.168.1.1", `Bearer ${OLD_TOKEN}`);
    const res = makeRes();
    const next = vi.fn();
    mw(
      req,
      res as unknown as import("express").Response,
      next as unknown as import("express").NextFunction,
    );
    expect(next).not.toHaveBeenCalled();
    expect(res._status).toBe(401);
    vi.useRealTimers();
  });
});

// ── rotate-token CLI integration ──────────────────────────────────────────────

describe("rotateToken CLI", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    delete process.env.TANDEM_AUTH_TOKEN;

    // Reset module-level stubs to defaults
    _writeFileSpy.mockReset().mockResolvedValue(undefined);
    _renameSpy.mockReset().mockResolvedValue(undefined);
    _readTokenSpy.mockReset().mockResolvedValue(OLD_TOKEN);
    _getTokenPathSpy.mockReset().mockReturnValue("/tmp/tandem/token");
    _applyConfigSpy.mockReset().mockResolvedValue({ updated: 2, errors: [] });

    // Mock global fetch
    fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: vi.fn().mockResolvedValue({ ok: true }),
    });
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("AbortSignal", { timeout: vi.fn().mockReturnValue({}) });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    clearPreviousToken();
    delete process.env.TANDEM_AUTH_TOKEN;
  });

  it("writes new token to disk atomically and calls server rotate endpoint", async () => {
    // Dynamic import so module mocks are applied
    const { rotateToken } = await import("../../src/cli/rotate-token.js");
    await rotateToken();

    // New token was written to a temp file first (atomic write pattern)
    expect(_writeFileSpy).toHaveBeenCalledOnce();
    const [writtenPath, writtenToken] = _writeFileSpy.mock.calls[0] as [string, string, unknown];
    // Temp path sits in the same dir as the final path, with a random suffix.
    // Use cross-platform match: path separator may be / or \ on Windows.
    expect(writtenPath).toMatch(/\.auth-token-tmp-[0-9a-f]{8}$/);
    expect(typeof writtenToken).toBe("string");
    expect(writtenToken.length).toBeGreaterThanOrEqual(32);

    // rename() moves the temp file to the final path atomically
    expect(_renameSpy).toHaveBeenCalledOnce();
    const [renameFrom, renameTo] = _renameSpy.mock.calls[0] as [string, string];
    expect(renameFrom).toBe(writtenPath);
    // Final path matches the mocked token path (cross-platform: may use \ or /)
    expect(renameTo).toMatch(/token$/);

    // Server was called with old token in Authorization header
    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0] as [
      string,
      RequestInit & { headers: Record<string, string> },
    ];
    expect(url).toContain("/api/rotate-token");
    expect(init.headers["Authorization"]).toBe(`Bearer ${OLD_TOKEN}`);
    // previousToken is no longer sent in the body — the server derives it from its own state
    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(body).not.toHaveProperty("previousToken");
  });

  it("calls applyConfigWithToken with the new token", async () => {
    const { rotateToken } = await import("../../src/cli/rotate-token.js");
    await rotateToken();

    expect(_applyConfigSpy).toHaveBeenCalledOnce();
    const [passedToken] = _applyConfigSpy.mock.calls[0] as [string];
    // New token — not the old one
    expect(passedToken).not.toBe(OLD_TOKEN);
    expect(typeof passedToken).toBe("string");
    expect(passedToken.length).toBeGreaterThanOrEqual(32);
  });

  it("warns and continues when server is not reachable", async () => {
    fetchMock.mockRejectedValue(new Error("ECONNREFUSED"));
    const stderrCalls: unknown[][] = [];
    const stderrSpy = vi
      .spyOn(console, "error")
      .mockImplementation((...args) => stderrCalls.push(args));

    const { rotateToken } = await import("../../src/cli/rotate-token.js");
    await rotateToken(); // should not throw

    expect(_writeFileSpy).toHaveBeenCalledOnce();
    expect(_applyConfigSpy).toHaveBeenCalledOnce();
    const messages = stderrCalls.flat().join("\n");
    expect(messages).toContain("not reachable");
    // "not reachable" path still prints success since disk write succeeded
    expect(messages).toContain("Rotated auth token");
    // Must NOT print WARNING (that's the rejected case)
    expect(messages).not.toContain("WARNING");

    stderrSpy.mockRestore();
  });

  it("prints strong warning (not success) when server returns non-2xx", async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 409,
      json: vi.fn().mockResolvedValue({ error: "Token is managed by Tauri; rotate via the app." }),
    });
    const stderrCalls: unknown[][] = [];
    const stderrSpy = vi
      .spyOn(console, "error")
      .mockImplementation((...args) => stderrCalls.push(args));

    const { rotateToken } = await import("../../src/cli/rotate-token.js");
    await rotateToken(); // should not throw

    const messages = stderrCalls.flat().join("\n");
    expect(messages).toContain("WARNING");
    expect(messages).toContain("409");
    // Must NOT print "Rotated auth token." — that implies success
    expect(messages).not.toContain("[tandem] Rotated auth token.");
    // Config files were updated; warning about divergence should be present
    expect(messages).toContain("Restart the server");

    stderrSpy.mockRestore();
  });

  it("exits with code 1 when TANDEM_AUTH_TOKEN env is set", async () => {
    process.env.TANDEM_AUTH_TOKEN = "some-env-token";
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((_code?: number) => {
      throw new Error("process.exit called");
    });

    const { rotateToken } = await import("../../src/cli/rotate-token.js");
    await expect(rotateToken()).rejects.toThrow("process.exit called");
    expect(exitSpy).toHaveBeenCalledWith(1);

    exitSpy.mockRestore();
  });

  it("exits with code 1 when no token file exists", async () => {
    _readTokenSpy.mockResolvedValue(null);
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((_code?: number) => {
      throw new Error("process.exit called");
    });

    const { rotateToken } = await import("../../src/cli/rotate-token.js");
    await expect(rotateToken()).rejects.toThrow("process.exit called");
    expect(exitSpy).toHaveBeenCalledWith(1);

    exitSpy.mockRestore();
  });

  it("fingerprint produces 8-char lowercase hex", () => {
    const fp = (t: string) => createHash("sha256").update(t, "utf8").digest("hex").slice(0, 8);
    const fp1 = fp(OLD_TOKEN);
    const fp2 = fp(NEW_TOKEN);
    expect(fp1).toHaveLength(8);
    expect(fp2).toHaveLength(8);
    expect(fp1).toMatch(/^[0-9a-f]{8}$/);
    expect(fp1).not.toBe(fp2);
  });
});
