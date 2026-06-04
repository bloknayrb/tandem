import net from "net";
import path from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  freePort,
  parseLsofPids,
  parseSsPid,
  resolveAppDataDir,
  SESSION_DIR,
  waitForPort,
} from "../../src/server/platform";

describe("platform", () => {
  describe("SESSION_DIR", () => {
    it("is an absolute path", () => {
      expect(path.isAbsolute(SESSION_DIR)).toBe(true);
    });

    it("contains 'tandem' and 'sessions'", () => {
      const normalized = SESSION_DIR.replace(/\\/g, "/").toLowerCase();
      expect(normalized).toContain("tandem");
      expect(normalized).toContain("sessions");
    });

    if (process.platform === "win32") {
      it("uses LOCALAPPDATA on Windows", () => {
        const localAppData = process.env.LOCALAPPDATA;
        expect(localAppData).toBeDefined();
        expect(SESSION_DIR.toLowerCase()).toContain(localAppData!.toLowerCase());
      });
    }
  });

  describe("freePort", () => {
    it("does not throw on an unused port", () => {
      expect(() => freePort(59999)).not.toThrow();
    });
  });

  describe("parseLsofPids", () => {
    it("parses single PID", () => {
      expect(parseLsofPids("1234\n")).toEqual([1234]);
    });

    it("parses multiple PIDs", () => {
      expect(parseLsofPids("1234\n5678\n")).toEqual([1234, 5678]);
    });

    it("ignores empty lines and non-numeric content", () => {
      expect(parseLsofPids("\n\n")).toEqual([]);
      expect(parseLsofPids("")).toEqual([]);
    });

    it("handles whitespace around PIDs", () => {
      expect(parseLsofPids("  1234  \n  5678  \n")).toEqual([1234, 5678]);
    });
  });

  describe("parseSsPid", () => {
    it("extracts PID from ss output", () => {
      const ssOutput = `State  Recv-Q Send-Q Local Address:Port  Peer Address:Port Process
LISTEN 0      128    127.0.0.1:3478       0.0.0.0:*     users:(("node",pid=12345,fd=18))`;
      expect(parseSsPid(ssOutput)).toBe(12345);
    });

    it("returns null when no PID found", () => {
      expect(parseSsPid("LISTEN 0 128 127.0.0.1:3478 0.0.0.0:*")).toBeNull();
    });

    it("returns null for empty string", () => {
      expect(parseSsPid("")).toBeNull();
    });
  });

  describe("waitForPort", () => {
    let holdServer: net.Server | null = null;

    afterEach(() => {
      if (!holdServer?.listening) return;
      const srv = holdServer;
      holdServer = null;
      return new Promise<void>((resolve) => srv.close(() => resolve()));
    });

    // Bind an OS-assigned ephemeral port (listen(0)), capture it, then release it.
    // Hardcoded high ports (e.g. 49170-49172) collide with the Windows reserved
    // ephemeral range (Hyper-V/WSL/Docker), throwing EACCES deterministically on
    // such hosts. Port 0 always picks a guaranteed-bindable port. See #1014.
    async function findFreePort(): Promise<number> {
      const probe = net.createServer();
      await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
      const port = (probe.address() as net.AddressInfo).port;
      await new Promise<void>((resolve) => probe.close(() => resolve()));
      return port;
    }

    it("resolves immediately when port is free", async () => {
      const port = await findFreePort();
      const start = Date.now();
      await waitForPort(port);
      expect(Date.now() - start).toBeLessThan(500);
    });

    it("resolves when occupied port is released mid-poll", async () => {
      holdServer = net.createServer();
      await new Promise<void>((resolve) => holdServer!.listen(0, "127.0.0.1", resolve));
      const port = (holdServer.address() as net.AddressInfo).port;

      // Release the port after 300ms
      setTimeout(() => {
        holdServer?.close();
        holdServer = null;
      }, 300);

      const start = Date.now();
      await waitForPort(port, 5000);
      const elapsed = Date.now() - start;
      expect(elapsed).toBeGreaterThanOrEqual(200);
      expect(elapsed).toBeLessThan(3000);
    });

    it("throws when port stays occupied past timeout", async () => {
      holdServer = net.createServer();
      await new Promise<void>((resolve) => holdServer!.listen(0, "127.0.0.1", resolve));
      const port = (holdServer.address() as net.AddressInfo).port;

      const start = Date.now();
      await expect(waitForPort(port, 500)).rejects.toThrow(
        `Port ${port} still not available after 500ms`,
      );
      expect(Date.now() - start).toBeGreaterThanOrEqual(400);
    });
  });

  describe("resolveAppDataDir", () => {
    let savedEnv: string | undefined;

    beforeEach(() => {
      savedEnv = process.env.TANDEM_APP_DATA_DIR;
    });

    afterEach(() => {
      if (savedEnv === undefined) {
        delete process.env.TANDEM_APP_DATA_DIR;
      } else {
        process.env.TANDEM_APP_DATA_DIR = savedEnv;
      }
    });

    it("returns TANDEM_APP_DATA_DIR when set to a non-empty string", () => {
      process.env.TANDEM_APP_DATA_DIR = "/custom/app-data";
      expect(resolveAppDataDir()).toBe("/custom/app-data");
    });

    it("falls back to an absolute env-paths path when TANDEM_APP_DATA_DIR is unset", () => {
      delete process.env.TANDEM_APP_DATA_DIR;
      const result = resolveAppDataDir();
      expect(path.isAbsolute(result)).toBe(true);
      expect(result.replace(/\\/g, "/").toLowerCase()).toContain("tandem");
    });

    it("treats empty string as unset and falls back to env-paths", () => {
      process.env.TANDEM_APP_DATA_DIR = "";
      const result = resolveAppDataDir();
      expect(path.isAbsolute(result)).toBe(true);
      expect(result.replace(/\\/g, "/").toLowerCase()).toContain("tandem");
    });
  });
});
