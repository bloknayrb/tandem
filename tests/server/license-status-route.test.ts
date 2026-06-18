import type { Request, Response } from "express";
import { describe, expect, it } from "vitest";
import type { LicenseState } from "../../src/server/license/license-types.js";
import {
  handleActivateLicense,
  handleGetLicenseStatus,
  scrubForNonLoopback,
} from "../../src/server/mcp/routes/license.js";

const FULL: LicenseState = {
  gateActive: true,
  status: "licensed",
  updateWindowCurrent: true,
  license: {
    id: "lic-123",
    name: "Jane Doe",
    email: "jane@example.com",
    type: "personal",
    createdAt: new Date(0).toISOString(),
    expiresAt: null,
    version: "1.0",
  },
  licenseId: "lic-123",
};

function fakeRes(): Response & { body: unknown } {
  const r = {
    body: undefined as unknown,
    json(b: unknown) {
      r.body = b;
      return r;
    },
  };
  return r as unknown as Response & { body: unknown };
}

function reqFrom(remoteAddress: string): Request {
  return { socket: { remoteAddress } } as unknown as Request;
}

describe("scrubForNonLoopback", () => {
  it("drops licensee name/email/licenseId", () => {
    const scrubbed = scrubForNonLoopback(FULL);
    expect(scrubbed).toEqual({
      gateActive: true,
      status: "licensed",
      daysRemaining: undefined,
      updateWindowCurrent: true,
    });
    expect(scrubbed).not.toHaveProperty("license");
    expect(scrubbed).not.toHaveProperty("licenseId");
  });

  it("carries trial daysRemaining when present", () => {
    const trialState: LicenseState = {
      gateActive: true,
      status: "trial",
      updateWindowCurrent: false,
      trial: { firstRunAt: "x", expiresAt: "y", daysRemaining: 7 },
    };
    expect(scrubForNonLoopback(trialState).daysRemaining).toBe(7);
  });
});

describe("handleGetLicenseStatus", () => {
  it("responds with a status object for a loopback caller", () => {
    const res = fakeRes();
    handleGetLicenseStatus(reqFrom("127.0.0.1"), res);
    expect((res.body as LicenseState).status).toBeDefined();
  });

  it("never leaks license/licenseId to a non-loopback caller", () => {
    const res = fakeRes();
    handleGetLicenseStatus(reqFrom("203.0.113.5"), res);
    expect(res.body).not.toHaveProperty("license");
    expect(res.body).not.toHaveProperty("licenseId");
    expect((res.body as { status: string }).status).toBeDefined();
  });
});

function fakeResStatus(): Response & { body: unknown; statusCode: number } {
  const r = {
    body: undefined as unknown,
    statusCode: 200,
    status(code: number) {
      r.statusCode = code;
      return r;
    },
    json(b: unknown) {
      r.body = b;
      return r;
    },
  };
  return r as unknown as Response & { body: unknown; statusCode: number };
}

function activateReq(opts: { origin?: string; body?: unknown }): Request {
  return {
    headers: opts.origin ? { origin: opts.origin } : {},
    socket: { remoteAddress: "127.0.0.1" },
    body: opts.body,
  } as unknown as Request;
}

describe("handleActivateLicense", () => {
  it("rejects a non-allowlisted origin with 403 before touching the body", async () => {
    const res = fakeResStatus();
    await handleActivateLicense(activateReq({ body: { license: "x" } }), res);
    expect(res.statusCode).toBe(403);
    expect((res.body as { error: string }).error).toBe("FORBIDDEN");
  });

  it("rejects a missing license body with 400 BAD_REQUEST", async () => {
    const res = fakeResStatus();
    await handleActivateLicense(activateReq({ origin: "http://127.0.0.1:5173", body: {} }), res);
    expect(res.statusCode).toBe(400);
    expect((res.body as { error: string }).error).toBe("BAD_REQUEST");
  });

  it("rejects a garbage license with a generic 400 that never echoes the blob", async () => {
    const secret = "SUPER-SECRET-GARBAGE-BLOB-BYTES";
    const res = fakeResStatus();
    await handleActivateLicense(
      activateReq({ origin: "http://127.0.0.1:5173", body: { license: secret } }),
      res,
    );
    expect(res.statusCode).toBe(400);
    expect((res.body as { error: string }).error).toBe("INVALID_LICENSE");
    expect(JSON.stringify(res.body)).not.toContain(secret);
  });
});
