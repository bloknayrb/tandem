import { describe, it, expect } from "vitest";
import path from "path";
import { SESSION_DIR, freePort, parseLsofPids, parseSsPid } from "../../src/server/platform";

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
});
