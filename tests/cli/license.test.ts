import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { formatLicenseStatus, resolveLicenseInput, runActivate } from "../../src/cli/license.js";
import type { LicenseState } from "../../src/server/license/license-types.js";
import * as verifier from "../../src/server/license/verifier.js";
import { TANDEM_PURCHASE_URL } from "../../src/shared/constants.js";
import { teardownFileAppDataDir } from "../helpers/app-data-teardown.js";

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
      email: "jane@example.com",
      type: "grandfathered",
      createdAt: new Date(0).toISOString(),
      expiresAt: "2027-01-01T00:00:00.000Z",
      version: "1.0",
      keyId: "0123456789abcdef",
    },
    licenseId: "lic-1",
  };

  it("shows trial days remaining", () => {
    const out = formatLicenseStatus(trial, true).join("\n");
    // "of 14" states the trial length: the LICENSE file's Additional Use Grant
    // names the same 14 days the gate enforces, so the status line says the
    // number outright and a reader can check one against the other.
    expect(out).toContain("trial (9 of 14 days remaining)");
    expect(out).toContain("Enforcement:   on");
  });

  it("says AI is off and the editor unaffected when enforcement is on (#1521)", () => {
    const out = formatLicenseStatus(restricted, true).join("\n");
    expect(out).toContain("unlicensed — AI features off; the editor is unaffected");
    expect(out).toContain(`Buy a license: ${TANDEM_PURCHASE_URL}`);
    expect(out).not.toMatch(/keep editing|read-only/);
  });

  // A dark build is a pre-1.0 beta: free, no time limit. A stale `trial.json`
  // must not tell that reader they are unlicensed, out of trial, or should buy.
  it.each([
    ["keyless", restricted, "Status:        no license key — nothing is enforced in this build"],
    [
      "unverifiable",
      { ...restricted, licenseUnverifiable: "BAD_SIGNATURE" } as LicenseState,
      "Status:        license not verified — nothing is enforced in this build",
    ],
  ])(
    "claims nothing is switched off on a dark build (%s, stale trial.json)",
    (kind, state, line) => {
      const out = formatLicenseStatus(state, false).join("\n");
      expect(out).toContain(line);
      expect(out).not.toMatch(/AI features off|unlicensed|trial ended|expired/i);
      expect(out).not.toContain(TANDEM_PURCHASE_URL);
      // The fix-or-reissue paragraph is the holder's remedy, dark or not.
      expect(/A license is installed on this device/.test(out)).toBe(kind === "unverifiable");
    },
  );

  it.each([
    ["keyless", trial, "no license key"],
    [
      "unverifiable",
      { ...trial, licenseUnverifiable: "MALFORMED" } as LicenseState,
      "license not verified",
    ],
  ])(
    "never tells a beta user they are on a trial (dark build, %s, fresh trial.json)",
    (kind, state, which) => {
      const out = formatLicenseStatus(state, false).join("\n");
      expect(out).toContain(
        `Status:        ${which} — nothing is enforced in this build (trial clock: 9 of 14 days)`,
      );
      expect(out).not.toMatch(/Status:\s+trial|days remaining|unlicensed|AI features off|expired/i);
      expect(out).not.toContain(TANDEM_PURCHASE_URL);
      expect(/A license is installed on this device/.test(out)).toBe(kind === "unverifiable");
    },
  );

  it("never offers a purchase link for an installed licence that fails to verify", () => {
    const out = formatLicenseStatus(
      { ...restricted, licenseUnverifiable: "BAD_SIGNATURE" } as LicenseState,
      true,
    ).join("\n");
    expect(out).toContain("license not verified — AI features off");
    expect(out).not.toContain(TANDEM_PURCHASE_URL);
    expect(out).toMatch(/reissued/);
  });

  it("shows licensee + a dated update window for a hand-signed windowed key", () => {
    const out = formatLicenseStatus(licensed, true).join("\n");
    expect(out).toContain("jane@example.com (grandfathered)");
    expect(out).toContain("Update window: current (through 2027-01-01)");
  });

  it("says all future updates are included for a key with no window", () => {
    // Every issued key since ADR-040's 2026-10-09 amendment (A5) has a null
    // `expiresAt`. It used to print "Update window: current" with no date.
    const open: LicenseState = {
      ...licensed,
      license: { ...licensed.license, type: "personal", expiresAt: null },
    };
    const out = formatLicenseStatus(open, true).join("\n");
    expect(out).toContain("Updates:       all future updates included");
    expect(out).not.toContain("Update window:");
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

  beforeEach(() => {
    errors = [];
    // A NAMED temp dir: a bare `mkdtemp` prefix fails platform.test.ts. This
    // path does go through `resolveAppDataDir()`, so it must be redirected.
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "tandem-"));
    process.env.TANDEM_APP_DATA_DIR = dir;
    vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      errors.push(args.map(String).join(" "));
    });
    exit = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
  });

  afterEach(async () => {
    // Restores the worker's isolated directory and removes this one; never
    // deletes the variable (CLAUDE.md, Testing & E2E).
    await teardownFileAppDataDir();
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

/**
 * #2205: `tandem activate` hands the key to a running Tandem. `fetch` is
 * stubbed here; the real-socket half is `license-activate-via-server.test.ts`.
 *
 * Env is stubbed per test and unstubbed after, so nothing leaks into the
 * unreadable-input cases above (which all exit before the network call).
 */
describe("runActivate — hands the key to a running server (#2205)", () => {
  let logs: string[];
  let errors: string[];
  let exit: ReturnType<typeof vi.spyOn>;
  let fetchSpy: ReturnType<typeof vi.spyOn>;
  let dir: string;

  const META = {
    id: "lic-1",
    email: "jane@example.com",
    type: "personal",
    createdAt: new Date(0).toISOString(),
    expiresAt: null,
    version: "1.0",
    keyId: "0123456789abcdef",
  } as unknown as ReturnType<typeof verifier.verifyLicenseSignature>;

  // Today's direct-path success lines, exactly.
  const DIRECT_LINES = [
    "\n✓ License activated for jane@example.com (personal).",
    "  All future updates are included.",
    "",
  ];
  const PICKED_UP = "  Tandem is running, so it picked the license up straight away.";

  const licenseFile = () => path.join(dir, "license.json");

  function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}) {
    return new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json", ...headers },
    });
  }

  beforeEach(() => {
    logs = [];
    errors = [];
    vi.stubEnv("CLAUDE_PLUGIN_OPTION_SERVER_URL", "");
    vi.stubEnv("TANDEM_URL", "http://127.0.0.1:1");
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "tandem-"));
    process.env.TANDEM_APP_DATA_DIR = dir;
    vi.spyOn(verifier, "verifyLicenseSignature").mockImplementation(() => META);
    vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      logs.push(args.map(String).join(" "));
    });
    vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      errors.push(args.map(String).join(" "));
    });
    exit = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
    fetchSpy = vi.spyOn(globalThis, "fetch");
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    // As above: the shared teardown, never a hand-written delete.
    await teardownFileAppDataDir();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("a 200 licence wire: prints the hand-off line, writes nothing locally", async () => {
    fetchSpy.mockResolvedValue(
      jsonResponse(200, {
        gateActive: false,
        status: "licensed",
        licenseInstalled: true,
        cliActivateEffective: true,
      }),
    );
    await runActivate(["activate", "  a-good-key \n"]);

    expect(logs).toEqual([DIRECT_LINES[0], DIRECT_LINES[1], PICKED_UP, ""]);
    expect(fs.existsSync(licenseFile())).toBe(false);
    expect(exit).not.toHaveBeenCalled();
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://127.0.0.1:1/api/license/activate");
    const headers = init.headers as Record<string, string>;
    expect(Object.keys(headers).map((k) => k.toLowerCase())).toEqual(["content-type"]);
    expect(headers["Content-Type"]).toBe("application/json");
    expect(init.redirect).toBe("manual");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body as string)).toEqual({ license: "a-good-key" });
  });

  it("adds the separate-store note when the CLI's root is not the server's", async () => {
    fetchSpy.mockResolvedValue(
      jsonResponse(200, {
        gateActive: false,
        status: "licensed",
        licenseInstalled: true,
        cliActivateEffective: false,
      }),
    );
    await runActivate(["activate", "a-good-key"]);
    expect(logs.join("\n")).toContain(PICKED_UP);
    expect(logs.join("\n")).toContain("reads a separate store");
    expect(fs.existsSync(licenseFile())).toBe(false);
  });

  it("a coded 400 is printed with control characters stripped, exit 1, no local write", async () => {
    fetchSpy.mockResolvedValue(
      jsonResponse(400, { error: "INVALID_LICENSE", message: "M\u001b[2J‮X" }),
    );
    await runActivate(["activate", "a-good-key"]);
    expect(exit).toHaveBeenCalledWith(1);
    const out = errors.join("\n");
    expect(out).toContain("License activation failed.");
    expect(out).toContain("M [2JX");
    expect(out).not.toContain("\u001b");
    expect(out).not.toContain("‮");
    expect(fs.existsSync(licenseFile())).toBe(false);
    expect(logs).toEqual([]);
  });

  it("strips the bidi marks sanitizeForLog strips, not only overrides and isolates", async () => {
    fetchSpy.mockResolvedValue(
      jsonResponse(400, {
        error: "INVALID_LICENSE",
        message: "A‎B‏C؜D‪E⁧F",
      }),
    );
    await runActivate(["activate", "a-good-key"]);
    const out = errors.join("\n");
    expect(out).toContain("ABCDEF");
    for (const ch of ["‎", "‏", "؜", "‪", "⁧"]) {
      expect(out).not.toContain(ch);
    }
  });

  it("a coded 500 LICENSE_WRITE_FAILED is printed, exit 1, no local write", async () => {
    fetchSpy.mockResolvedValue(jsonResponse(500, { error: "LICENSE_WRITE_FAILED", message: "W" }));
    await runActivate(["activate", "a-good-key"]);
    expect(exit).toHaveBeenCalledWith(1);
    expect(errors.join("\n")).toContain("\nW\n");
    expect(fs.existsSync(licenseFile())).toBe(false);
  });

  it("caps a long refusal message", async () => {
    fetchSpy.mockResolvedValue(
      jsonResponse(400, { error: "INVALID_LICENSE", message: "x".repeat(2000) }),
    );
    await runActivate(["activate", "a-good-key"]);
    const printed = errors.join("\n").match(/x+…?/)?.[0] ?? "";
    expect(printed.length).toBeLessThanOrEqual(501);
    expect(printed.endsWith("…")).toBe(true);
  });

  const notTandem: Array<[string, () => Response]> = [
    ["500 with no JSON", () => new Response("Internal Server Error", { status: 500 })],
    [
      "405 with an HTML body",
      () =>
        new Response("<html>Method Not Allowed</html>", {
          status: 405,
          headers: { "Content-Type": "text/html" },
        }),
    ],
    ["502 with an empty body", () => new Response("", { status: 502 })],
    ["401 UNAUTHORIZED", () => jsonResponse(401, { error: "UNAUTHORIZED" })],
    ["404", () => new Response("Not Found", { status: 404 })],
    [
      "a 200 with an HTML body",
      () =>
        new Response("<html>hi</html>", { status: 200, headers: { "Content-Type": "text/html" } }),
    ],
    ["a 200 with only gateActive", () => jsonResponse(200, { gateActive: false })],
    [
      "403 Host not allowed (no code)",
      () => jsonResponse(403, { error: "FORBIDDEN", message: "Host not allowed." }),
    ],
    [
      "400 with an error outside the route's vocabulary",
      () => jsonResponse(400, { error: "SOMETHING_ELSE", message: "nope" }),
    ],
    [
      "a 503 carrying a Tandem-looking body",
      () => jsonResponse(503, { error: "INVALID_LICENSE", message: "nope" }),
    ],
  ];
  for (const [name, make] of notTandem) {
    it(`falls back to today's direct write on ${name}`, async () => {
      fetchSpy.mockResolvedValue(make());
      await runActivate(["activate", "a-good-key"]);
      expect(fs.existsSync(licenseFile())).toBe(true);
      expect(logs).toEqual(DIRECT_LINES);
      expect(exit).not.toHaveBeenCalled();
    });
  }

  it("never follows a redirect: one fetch, then the local write", async () => {
    fetchSpy.mockResolvedValue(
      new Response("moved", { status: 307, headers: { Location: "http://203.0.113.9/steal" } }),
    );
    await runActivate(["activate", "a-good-key"]);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(fs.existsSync(licenseFile())).toBe(true);
    expect(logs).toEqual(DIRECT_LINES);
    expect(exit).not.toHaveBeenCalled();
  });

  it("a 403 BAD_ORIGIN (a pre-#2205 Tandem) writes locally and says so", async () => {
    fetchSpy.mockResolvedValue(
      jsonResponse(403, { error: "FORBIDDEN", code: "BAD_ORIGIN", message: "Open Tandem…" }),
    );
    await runActivate(["activate", "a-good-key"]);
    expect(fs.existsSync(licenseFile())).toBe(true);
    expect(logs.join("\n")).toContain("didn't take the key directly");
    expect(exit).not.toHaveBeenCalled();
  });

  it("nothing listening: writes locally with today's exact lines", async () => {
    fetchSpy.mockRejectedValue(
      Object.assign(new TypeError("fetch failed"), {
        cause: Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" }),
      }),
    );
    await runActivate(["activate", "a-good-key"]);
    expect(fs.existsSync(licenseFile())).toBe(true);
    expect(logs).toEqual(DIRECT_LINES);
    expect(exit).not.toHaveBeenCalled();
  });

  it("a timeout writes locally and says Tandem didn't confirm", async () => {
    fetchSpy.mockRejectedValue(new DOMException("timed out", "TimeoutError"));
    await runActivate(["activate", "a-good-key"]);
    expect(fs.existsSync(licenseFile())).toBe(true);
    expect(logs.join("\n")).toContain("didn't confirm it took the key");
    expect(exit).not.toHaveBeenCalled();
  });

  for (const url of [
    "http://203.0.113.5:3479",
    "http://localhost:3479",
    "http://[::1]:3479",
    "https://127.0.0.1:3479",
    "not a url",
  ]) {
    it(`never contacts TANDEM_URL=${url}; writes locally`, async () => {
      vi.stubEnv("TANDEM_URL", url);
      await runActivate(["activate", "a-good-key"]);
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(fs.existsSync(licenseFile())).toBe(true);
      expect(logs).toEqual(DIRECT_LINES);
    });
  }

  it("a key that does not verify is refused locally and never sent", async () => {
    vi.mocked(verifier.verifyLicenseSignature).mockImplementation(() => {
      throw new Error("bad");
    });
    await runActivate(["activate", "junk"]);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(exit).toHaveBeenCalledWith(1);
    expect(errors.join("\n")).toContain("License activation failed.");
    expect(fs.existsSync(licenseFile())).toBe(false);
  });
});
