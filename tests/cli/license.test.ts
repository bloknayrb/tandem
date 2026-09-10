import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { formatLicenseStatus, resolveLicenseInput, runActivate } from "../../src/cli/license.js";
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
    // "of 14" states the trial length: the LICENSE file's Additional Use Grant
    // says 30 days while the gate enforces 14, so leaving the number implicit
    // turns a documented decision into an apparent contradiction.
    expect(out).toContain("trial (9 of 14 days remaining)");
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

/**
 * `runActivate`'s error paths — this file's first coverage of them (#1789).
 *
 * The `exit` spy must be NON-throwing. A throwing mock leaves `runActivate` AT
 * `process.exit(1)`, so the explicit `return` after it is unreachable in the
 * test and the "only one message" negative below passes with and without the
 * fix — the assertion would defeat itself.
 */
describe("runActivate — unreadable input (#1789)", () => {
  let errors: string[];
  let exit: ReturnType<typeof vi.spyOn>;
  let dir: string;
  let previousAppDataDir: string | undefined;

  beforeEach(() => {
    errors = [];
    // A NAMED temp dir: a bare `mkdtemp` prefix fails platform.test.ts. This
    // path does go through `resolveAppDataDir()`, so it must be redirected.
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "tandem-"));
    previousAppDataDir = process.env.TANDEM_APP_DATA_DIR;
    process.env.TANDEM_APP_DATA_DIR = dir;
    vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      errors.push(args.map(String).join(" "));
    });
    exit = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
  });

  afterEach(() => {
    if (previousAppDataDir === undefined) delete process.env.TANDEM_APP_DATA_DIR;
    else process.env.TANDEM_APP_DATA_DIR = previousAppDataDir;
    vi.restoreAllMocks();
  });

  it("a directory argument prints one sentence, not a stack trace", async () => {
    // `existsSync` says yes for a directory and `readFileSync` then throws
    // EISDIR. Before the fix that call sat outside every handler.
    await expect(runActivate(["activate", dir])).resolves.toBeUndefined();

    expect(exit).toHaveBeenCalledWith(1);
    const out = errors.join("\n");
    expect(out).toContain("Could not read a license from");
    // The negative that pins BOTH the explicit `return` and the sibling (never
    // nested) `try`: either mistake prints the generic copy on top of this one.
    expect(out).not.toContain("License activation failed");
    // Review round 1: the errno survives. A bare `catch` gave every read
    // failure the folder advice above and discarded the cause, so an EACCES on
    // a real file, or an EIO on a disconnected share, was indistinguishable
    // from pointing at a directory — with nothing left naming which.
    expect(out).toContain("Reason:");
    expect(out).toContain("EISDIR");
  });

  it("names the cause when the file exists but cannot be read", async () => {
    // The case the folder-specific advice is actively wrong about.
    const file = path.join(dir, "jane.license");
    fs.writeFileSync(file, "blob");
    const readSpy = vi.spyOn(fs, "readFileSync").mockImplementation(() => {
      throw Object.assign(new Error("EACCES: permission denied, open 'jane.license'"), {
        code: "EACCES",
      });
    });
    try {
      await expect(runActivate(["activate", file])).resolves.toBeUndefined();
    } finally {
      readSpy.mockRestore();
    }

    expect(exit).toHaveBeenCalledWith(1);
    const out = errors.join("\n");
    expect(out).toContain("Could not read a license from");
    expect(out).toContain("EACCES");
    expect(out).not.toContain("License activation failed");
  });

  it("no argument exits without throwing past the spy", async () => {
    await expect(runActivate(["activate"])).resolves.toBeUndefined();
    expect(exit).toHaveBeenCalledWith(1);
    expect(errors.join("\n")).toContain("Usage: tandem activate");
    expect(errors.join("\n")).not.toContain("License activation failed");
  });
});
