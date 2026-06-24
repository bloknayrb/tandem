import { describe, expect, it } from "vitest";
import { formatLicenseStatus, resolveLicenseInput } from "../../src/cli/license.js";
import type { LicenseState } from "../../src/server/license/license-types.js";

describe("resolveLicenseInput", () => {
  it("reads + trims a file when the arg is an existing path", () => {
    const blob = resolveLicenseInput(
      "/some/file.license",
      (p) => p === "/some/file.license",
      () => "  BLOBDATA\n",
    );
    expect(blob).toBe("BLOBDATA");
  });

  it("treats the arg as a literal blob when it is not a path", () => {
    const blob = resolveLicenseInput(
      "eyJtZXRhIjoxfQ==",
      () => false,
      () => {
        throw new Error("should not read");
      },
    );
    expect(blob).toBe("eyJtZXRhIjoxfQ==");
  });
});

describe("formatLicenseStatus", () => {
  const trial: LicenseState = {
    gateActive: true,
    status: "trial",
    updateWindowCurrent: false,
    trial: { firstRunAt: "x", expiresAt: "y", daysRemaining: 9 },
  };
  const restricted: LicenseState = {
    gateActive: true,
    status: "restricted",
    updateWindowCurrent: false,
  };
  const licensed: LicenseState = {
    gateActive: true,
    status: "licensed",
    updateWindowCurrent: true,
    license: {
      id: "lic-1",
      name: "Jane Doe",
      email: "jane@example.com",
      type: "grandfathered",
      createdAt: new Date(0).toISOString(),
      expiresAt: "2027-01-01T00:00:00.000Z",
      version: "1.0",
    },
    licenseId: "lic-1",
  };

  it("shows trial days remaining", () => {
    const out = formatLicenseStatus(trial, true).join("\n");
    expect(out).toContain("trial (9 days remaining)");
    expect(out).toContain("Enforcement:   on");
  });

  it("shows the restricted escape-hatch hint", () => {
    expect(formatLicenseStatus(restricted, true).join("\n")).toContain("restricted");
  });

  it("shows licensee + update window for a licensed device", () => {
    const out = formatLicenseStatus(licensed, true).join("\n");
    expect(out).toContain("Jane Doe (grandfathered)");
    expect(out).toContain("Update window: current (through 2027-01-01)");
  });

  it("reports enforcement off when the gate ships dark", () => {
    expect(formatLicenseStatus(licensed, false).join("\n")).toContain(
      "Enforcement:   off (activates at v1.0)",
    );
  });
});
