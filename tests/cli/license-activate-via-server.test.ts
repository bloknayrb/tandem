import fs from "fs";
import http from "http";
import os from "os";
import path from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runActivate } from "../../src/cli/license.js";
import * as verifier from "../../src/server/license/verifier.js";
import { closeMcpSession, startMcpServerHttp } from "../../src/server/mcp/server.js";
import { allocPort } from "../helpers/alloc-port.js";
import { teardownFileAppDataDir } from "../helpers/app-data-teardown.js";

/**
 * #2205, end to end: `tandem activate` against a real Tandem HTTP server, then
 * against nothing, then against a redirect — real sockets, real undici.
 *
 * The CLI and the in-process server share `TANDEM_APP_DATA_DIR`, so a
 * `license.json` in the temp dir after the first case was written by the
 * SERVER (the CLI writes nothing on that path — asserted by the resume spy and
 * by the hand-off line).
 */
describe("tandem activate hands the key to a running Tandem (#2205)", () => {
  const saved: Record<string, string | undefined> = {};
  // TANDEM_APP_DATA_DIR is not in this list: `teardownFileAppDataDir` restores
  // it, never by deleting it (CLAUDE.md, Testing & E2E).
  const ENV_KEYS = ["CLAUDE_PLUGIN_OPTION_SERVER_URL", "TANDEM_URL"];
  let dir: string;
  let logs: string[];
  let exit: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    for (const k of ENV_KEYS) saved[k] = process.env[k];
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "tandem-activate-e2e-"));
    // Blank, not deleted: a non-blank plugin option outranks TANDEM_URL.
    process.env.CLAUDE_PLUGIN_OPTION_SERVER_URL = "";
    process.env.TANDEM_APP_DATA_DIR = dir;
    logs = [];
    vi.spyOn(verifier, "verifyLicenseSignature").mockImplementation(
      () =>
        ({
          id: "lic-1",
          email: "jane@example.com",
          type: "personal",
          createdAt: new Date(0).toISOString(),
          expiresAt: null,
          version: "1.0",
          keyId: "0123456789abcdef",
        }) as ReturnType<typeof verifier.verifyLicenseSignature>,
    );
    vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      logs.push(args.map(String).join(" "));
    });
    vi.spyOn(console, "error").mockImplementation(() => {});
    exit = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    await teardownFileAppDataDir();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  function fakeSupervisor(resume: () => Promise<void>) {
    return {
      start: async () => {},
      stop: async () => {},
      relaunch: async () => ({ spawned: true as const }),
      startFresh: async () => ({ spawned: true as const }),
      refreshConfigured: async () => {},
      startAfterSetup: async () => "unknown" as const,
      resumeAfterLicence: resume,
      licenceRefusal: () => null,
      startByUser: async () => ({ spawned: true as const }),
      updateSettings: async () => ({
        startMode: "auto" as const,
        lifetime: "always" as const,
        idleMinutes: 30,
      }),
      appliedSettings: () => null,
      status: () => ({ running: false as const }),
    };
  }

  it("a running server takes the key and resumes; with it gone, the CLI writes directly", async () => {
    const resume = vi.fn(async () => {});
    const port = await allocPort();
    process.env.TANDEM_URL = `http://127.0.0.1:${port}`;
    const server = await startMcpServerHttp(port, "127.0.0.1", undefined, undefined, {
      getSupervisor: () => fakeSupervisor(resume),
      unavailableReason: () => "stdio-mode",
      startSupervisor: async () => {},
    });
    try {
      await runActivate(["activate", "a-good-key"]);
      expect(resume).toHaveBeenCalledTimes(1);
      expect(fs.existsSync(path.join(dir, "license.json"))).toBe(true);
      expect(exit).not.toHaveBeenCalled();
      expect(logs.join("\n")).toContain("picked the license up straight away");
    } finally {
      await closeMcpSession();
      await new Promise<void>((r) => server.close(() => r()));
    }

    // Same port, nothing listening now: today's direct write.
    fs.rmSync(path.join(dir, "license.json"));
    logs.length = 0;
    await runActivate(["activate", "a-good-key"]);
    expect(resume).toHaveBeenCalledTimes(1);
    expect(fs.existsSync(path.join(dir, "license.json"))).toBe(true);
    expect(exit).not.toHaveBeenCalled();
    expect(logs.join("\n")).not.toContain("picked the license up");
  });

  it("never re-sends the key to a redirect target", async () => {
    const seenByB: string[] = [];
    const b = http.createServer((req, res) => {
      seenByB.push(`${req.method} ${req.url}`);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ gateActive: false, status: "licensed", licenseInstalled: true }));
    });
    await new Promise<void>((r) => b.listen(0, "127.0.0.1", r));
    const bPort = (b.address() as { port: number }).port;
    const a = http.createServer((req, res) => {
      req.resume();
      res.writeHead(307, { Location: `http://127.0.0.1:${bPort}/steal` });
      res.end();
    });
    await new Promise<void>((r) => a.listen(0, "127.0.0.1", r));
    const aPort = (a.address() as { port: number }).port;
    process.env.TANDEM_URL = `http://127.0.0.1:${aPort}`;
    try {
      await runActivate(["activate", "a-good-key"]);
      expect(seenByB).toEqual([]);
      expect(fs.existsSync(path.join(dir, "license.json"))).toBe(true);
      expect(exit).not.toHaveBeenCalled();
      expect(logs.join("\n")).not.toContain("picked the license up");
    } finally {
      await new Promise<void>((r) => a.close(() => r()));
      await new Promise<void>((r) => b.close(() => r()));
    }
  });
});
