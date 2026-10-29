import fs from "fs";
import http from "http";
import os from "os";
import path from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  deactivateViaRunningServer,
  formatDeactivationResult,
  runDeactivate,
  runLicenseStatus,
} from "../../src/cli/license.js";
import { GATE_ENABLED } from "../../src/server/license/gate-flag.js";
import { closeMcpSession, startMcpServerHttp } from "../../src/server/mcp/server.js";
import { TANDEM_PURCHASE_URL } from "../../src/shared/constants.js";
import {
  LICENSE_REMOVE_FAILED,
  LICENSE_REMOVE_FAILED_MESSAGE,
} from "../../src/shared/license-copy.js";
import { allocPort } from "../helpers/alloc-port.js";
import { teardownFileAppDataDir } from "../helpers/app-data-teardown.js";

/**
 * `tandem deactivate` (#1943): the transport (same guards as `tandem
 * activate`, #2205), the outcome mapping, the local fallback, and one real
 * server end to end. Plus `tandem license` on a dark build staying exactly
 * what it was over a broken licence (#2231).
 */

function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
}

const URL_OK = "http://127.0.0.1:1";

describe("deactivateViaRunningServer (#1943)", () => {
  it("only ever contacts a literal http://127.0.0.1 URL", async () => {
    const fetchImpl = vi.fn();
    for (const url of ["http://localhost:1", "https://127.0.0.1:1", "http://10.0.0.2:1", "nope"]) {
      await expect(
        deactivateViaRunningServer({ url, fetchImpl: fetchImpl as unknown as typeof fetch }),
      ).resolves.toEqual({ kind: "unavailable", reason: "non-loopback-url" });
    }
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("POSTs { confirm: true } with no Origin and never follows a redirect", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(200, { removed: true, gateActive: false }));
    await deactivateViaRunningServer({
      url: "http://user:pw@127.0.0.1:1/some/path?q=1",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("http://127.0.0.1:1/api/license/deactivate");
    expect(init.redirect).toBe("manual");
    expect(Object.keys(init.headers as Record<string, string>)).toEqual(["Content-Type"]);
    expect(JSON.parse(init.body as string)).toEqual({ confirm: true });
  });

  it.each([
    [
      { removed: true, cliActivateEffective: true },
      { kind: "removed", cliSharesRoot: true },
    ],
    [{ removed: false }, { kind: "not-installed" }],
    [
      { removed: true, wasUnverifiable: "BAD_SIGNATURE" },
      { kind: "removed", wasUnverifiable: "BAD_SIGNATURE" },
    ],
    // An unknown code is dropped, never echoed.
    [{ removed: true, wasUnverifiable: "\u001b[31mEVIL" }, { kind: "removed" }],
  ])("maps a 2xx %j", async (body, expected) => {
    const fetchImpl = vi.fn(async () => jsonResponse(200, body));
    await expect(
      deactivateViaRunningServer({ url: URL_OK, fetchImpl: fetchImpl as unknown as typeof fetch }),
    ).resolves.toEqual(expected);
  });

  it("a 2xx without a boolean `removed` is not Tandem", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(200, { gateActive: false }));
    await expect(
      deactivateViaRunningServer({ url: URL_OK, fetchImpl: fetchImpl as unknown as typeof fetch }),
    ).resolves.toEqual({ kind: "unavailable", reason: "not-tandem" });
  });

  it("a redirect is not Tandem, and its target is never contacted", async () => {
    const fetchImpl = vi.fn(
      async () => new Response(null, { status: 307, headers: { Location: "http://evil/" } }),
    );
    await expect(
      deactivateViaRunningServer({ url: URL_OK, fetchImpl: fetchImpl as unknown as typeof fetch }),
    ).resolves.toEqual({ kind: "unavailable", reason: "not-tandem" });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("the route's own refusals are `refused`, with the message sanitized", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse(500, { error: LICENSE_REMOVE_FAILED, message: "nope\u001b[2J‮" }),
    );
    await expect(
      deactivateViaRunningServer({ url: URL_OK, fetchImpl: fetchImpl as unknown as typeof fetch }),
    ).resolves.toEqual({ kind: "refused", status: 500, message: "nope [2J" });
  });

  it.each([
    [404, { error: "Not found" }, "not-tandem"],
    [500, { error: "SOMETHING_ELSE", message: "x" }, "not-tandem"],
    [403, { code: "BAD_ORIGIN", error: "FORBIDDEN" }, "origin-refused"],
  ])("a %i %j is unavailable (%s)", async (status, body, reason) => {
    const fetchImpl = vi.fn(async () => jsonResponse(status, body));
    await expect(
      deactivateViaRunningServer({ url: URL_OK, fetchImpl: fetchImpl as unknown as typeof fetch }),
    ).resolves.toEqual({ kind: "unavailable", reason });
  });

  it("a timeout and a refused connection are told apart", async () => {
    const timeout = vi.fn(async () => {
      throw new DOMException("t", "TimeoutError");
    });
    await expect(
      deactivateViaRunningServer({ url: URL_OK, fetchImpl: timeout as unknown as typeof fetch }),
    ).resolves.toEqual({ kind: "unavailable", reason: "timeout" });
    const refused = vi.fn(async () => {
      throw new TypeError("fetch failed");
    });
    await expect(
      deactivateViaRunningServer({ url: URL_OK, fetchImpl: refused as unknown as typeof fetch }),
    ).resolves.toEqual({ kind: "unavailable", reason: "unreachable" });
  });
});

describe("formatDeactivationResult (#1943)", () => {
  it("a good key: removed, and reversible", () => {
    const out = formatDeactivationResult(true, undefined).join("\n");
    expect(out).toContain("✓ License removed from this device.");
    expect(out).toContain("Activate the same key again any time");
  });

  it.each(["BAD_SIGNATURE", "UNSUPPORTED_VERSION"] as const)(
    "a key that failed %s is NOT promised a reactivation, and is never offered a purchase",
    (code) => {
      const out = formatDeactivationResult(true, code).join("\n");
      expect(out).not.toContain("Activate the same key again any time");
      expect(out).toContain("support@tandem.ink");
      expect(out).not.toContain(TANDEM_PURCHASE_URL);
    },
  );

  it("nothing installed", () => {
    expect(formatDeactivationResult(false, undefined)[0]).toBe(
      "\nNo license was installed on this device.",
    );
  });
});

describe("runDeactivate (#1943)", () => {
  let dir: string;
  let logs: string[];
  let errors: string[];
  let exit: ReturnType<typeof vi.spyOn>;
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  const licenseFile = () => path.join(dir, "license.json");
  const graceFile = () => path.join(dir, "license-grace.json");

  beforeEach(() => {
    logs = [];
    errors = [];
    vi.stubEnv("CLAUDE_PLUGIN_OPTION_SERVER_URL", "");
    vi.stubEnv("TANDEM_URL", URL_OK);
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "tandem-deactivate-cli-"));
    process.env.TANDEM_APP_DATA_DIR = dir;
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
    await teardownFileAppDataDir();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("a running Tandem removed it: prints the result, touches nothing locally", async () => {
    fs.writeFileSync(licenseFile(), JSON.stringify({ version: 1, blob: "b" }));
    fetchSpy.mockResolvedValue(jsonResponse(200, { removed: true, cliActivateEffective: false }));
    await runDeactivate();
    expect(logs.join("\n")).toContain("✓ License removed from this device.");
    expect(logs.join("\n")).toContain("reads a separate store");
    // The SERVER did the removal; the CLI's own file is left alone.
    expect(fs.existsSync(licenseFile())).toBe(true);
    expect(exit).not.toHaveBeenCalled();
  });

  it("a refusal exits 1 and does not fall back to a local removal", async () => {
    fs.writeFileSync(licenseFile(), JSON.stringify({ version: 1, blob: "b" }));
    fetchSpy.mockResolvedValue(
      jsonResponse(500, { error: LICENSE_REMOVE_FAILED, message: LICENSE_REMOVE_FAILED_MESSAGE }),
    );
    await runDeactivate();
    expect(exit).toHaveBeenCalledWith(1);
    expect(errors.join("\n")).toContain(LICENSE_REMOVE_FAILED_MESSAGE);
    expect(fs.existsSync(licenseFile())).toBe(true);
  });

  it("nothing running: removes the licence and grace record from this CLI's store", async () => {
    fs.writeFileSync(licenseFile(), JSON.stringify({ version: 1, blob: "b" }));
    fs.writeFileSync(graceFile(), JSON.stringify({ version: 1, entries: {} }));
    fetchSpy.mockRejectedValue(new TypeError("fetch failed"));
    await runDeactivate();
    expect(fs.existsSync(licenseFile())).toBe(false);
    expect(fs.existsSync(graceFile())).toBe(false);
    expect(logs.join("\n")).toContain("✓ License removed from this device.");
    expect(logs.join("\n")).not.toContain("didn't take the request");
    // The desktop app's store is not this one, so "removed" here says nothing about it.
    expect(logs.join("\n")).toContain("changed only this command's own store");
    expect(exit).not.toHaveBeenCalled();
  });

  it("an older Tandem (404) falls back locally and says it changed only this store", async () => {
    fetchSpy.mockResolvedValue(jsonResponse(404, { error: "Not found" }));
    await runDeactivate();
    expect(logs.join("\n")).toContain("No license was installed on this device.");
    expect(logs.join("\n")).toContain("changed only this command's own store");
  });

  it("a local removal that fails exits 1 with the remove-failed copy", async () => {
    fs.mkdirSync(path.join(licenseFile(), "inner"), { recursive: true });
    fetchSpy.mockRejectedValue(new TypeError("fetch failed"));
    await runDeactivate();
    expect(exit).toHaveBeenCalledWith(1);
    expect(errors.join("\n")).toContain(LICENSE_REMOVE_FAILED_MESSAGE);
  });
});

describe("tandem deactivate against a real Tandem (#1943)", () => {
  let dir: string;

  beforeEach(() => {
    vi.stubEnv("CLAUDE_PLUGIN_OPTION_SERVER_URL", "");
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "tandem-deactivate-e2e-"));
    process.env.TANDEM_APP_DATA_DIR = dir;
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    await teardownFileAppDataDir();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("the server removes the licence from its own root", async () => {
    fs.writeFileSync(path.join(dir, "license.json"), JSON.stringify({ version: 1, blob: "b" }));
    const port = await allocPort();
    const server = await startMcpServerHttp(port, "127.0.0.1");
    try {
      const outcome = await deactivateViaRunningServer({ url: `http://127.0.0.1:${port}` });
      expect(outcome).toMatchObject({ kind: "removed" });
      expect(fs.existsSync(path.join(dir, "license.json"))).toBe(false);
    } finally {
      await closeMcpSession();
      await new Promise<void>((r) => server.close(() => r()));
    }
  });

  it("a text/plain simple request to the real route deletes nothing", async () => {
    fs.writeFileSync(path.join(dir, "license.json"), JSON.stringify({ version: 1, blob: "b" }));
    const port = await allocPort();
    const server = await startMcpServerHttp(port, "127.0.0.1");
    try {
      const status = await new Promise<number>((resolve, reject) => {
        const req = http.request(
          {
            host: "127.0.0.1",
            port,
            path: "/api/license/deactivate",
            method: "POST",
            headers: { "Content-Type": "text/plain" },
          },
          (res) => {
            res.resume();
            resolve(res.statusCode ?? 0);
          },
        );
        req.on("error", reject);
        req.end('{"confirm":true}');
      });
      expect(status).toBe(400);
      expect(fs.existsSync(path.join(dir, "license.json"))).toBe(true);
    } finally {
      await closeMcpSession();
      await new Promise<void>((r) => server.close(() => r()));
    }
  });
});

describe("tandem license on a dark build (#2231, ADR-040 D7)", () => {
  let dir: string;
  let logs: string[];

  beforeEach(() => {
    logs = [];
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "tandem-license-dark-cli-"));
    process.env.TANDEM_APP_DATA_DIR = dir;
    vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      logs.push(args.map(String).join(" "));
    });
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await teardownFileAppDataDir();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("prints no grace period over a broken licence, and never reads or writes a grace record", async () => {
    expect(GATE_ENABLED).toBe(false);
    fs.writeFileSync(path.join(dir, "license.json"), JSON.stringify({ version: 1, blob: "b" }));
    fs.writeFileSync(
      path.join(dir, "trial.json"),
      JSON.stringify({
        version: 1,
        firstRunAt: new Date(Date.now() - 30 * 86_400_000).toISOString(),
      }),
    );
    await runLicenseStatus();
    const out = logs.join("\n");
    expect(out).toContain("license not verified — nothing is enforced in this build");
    expect(out).not.toMatch(/grace|stay on until/i);
    expect(fs.existsSync(path.join(dir, "license-grace.json"))).toBe(false);
  });
});
