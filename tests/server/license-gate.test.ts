import { describe, expect, it } from "vitest";
import type { LicenseState } from "../../src/server/license/license-types.js";
import { gatedTool, licenseGateResult } from "../../src/server/mcp/license-gate.js";

const RESTRICTED: LicenseState = {
  gateActive: true,
  status: "restricted",
  updateWindowCurrent: false,
};
const TRIAL: LicenseState = {
  gateActive: true,
  status: "trial",
  updateWindowCurrent: false,
  trial: { firstRunAt: "x", expiresAt: "y", daysRemaining: 5 },
};
const LICENSED: LicenseState = {
  gateActive: true,
  status: "licensed",
  updateWindowCurrent: true,
};
const DARK: LicenseState = {
  gateActive: false,
  status: "licensed",
  updateWindowCurrent: true,
};

/** Decode the JSON error envelope a tool result carries. */
function envelope(result: { content: Array<{ text: string }> }): {
  error: boolean;
  code?: string;
} {
  return JSON.parse(result.content[0].text);
}

describe("licenseGateResult (Surface B decision)", () => {
  it("blocks mutations with LICENSE_REQUIRED when restricted", () => {
    const blocked = licenseGateResult(RESTRICTED);
    expect(blocked).not.toBeNull();
    const env = envelope(blocked as { content: Array<{ text: string }> });
    expect(env.error).toBe(true);
    expect(env.code).toBe("LICENSE_REQUIRED");
  });

  it("allows mutations during trial", () => {
    expect(licenseGateResult(TRIAL)).toBeNull();
  });

  it("allows mutations when licensed", () => {
    expect(licenseGateResult(LICENSED)).toBeNull();
  });

  it("is a no-op when the gate is inactive — even if status would block", () => {
    expect(licenseGateResult({ ...RESTRICTED, gateActive: false })).toBeNull();
    expect(licenseGateResult(DARK)).toBeNull();
  });
});

describe("gatedTool (registration wrapper)", () => {
  it("passes through to the handler when the gate is dark (vitest default)", async () => {
    const handler = gatedTool("tandem_test", async () => ({
      content: [{ type: "text" as const, text: JSON.stringify({ error: false, data: "ok" }) }],
    }));
    const result = await handler({});
    expect(envelope(result).error).toBe(false);
  });

  it("wraps thrown handler errors in an INTERNAL_ERROR envelope (error boundary)", async () => {
    const handler = gatedTool("tandem_test", async () => {
      throw new Error("boom");
    });
    const result = await handler({});
    const env = envelope(result);
    expect(env.error).toBe(true);
    expect(env.code).toBe("INTERNAL_ERROR");
  });
});
