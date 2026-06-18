import type { Request, Response } from "express";
import { describe, expect, it } from "vitest";
import type { LicenseState } from "../../src/server/license/license-types.js";
import {
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
