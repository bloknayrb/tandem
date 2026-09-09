import { readFileSync } from "node:fs";
import http from "http";
import net from "net";
import path from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  decideStartupAction,
  freePort,
  isTauriSidecar,
  type ProbeSchedule,
  parseLsofPids,
  parseNetstatListeningPids,
  parseSsPid,
  probeTandemInstance,
  resolveAppDataDir,
  SESSION_DIR,
  TAURI_SIDECAR_ARGV_FLAG,
  waitForPort,
} from "../../src/server/platform";
import { expectWithinMs } from "../helpers/timing.js";

/**
 * A short probe schedule for the absence cases, which would otherwise pay the
 * production ~3.5s. Shape and defaults live with `probeTandemInstance`; no
 * production caller passes one.
 */
const FAST: ProbeSchedule = { attempts: 3, timeoutMs: 50, delayMs: 10 };

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

  // These pin the process-selection half of freePort() on Windows. The old
  // implementation piped netstat through `findstr ":${port}.*LISTENING"` — a
  // regex matched anywhere in the line — and then took the last whitespace
  // token of the whole blob, so it could kill a process that merely had a
  // similar-looking port. Since the Tauri shell now NAMES the holder in its
  // error dialog while this function KILLS it, the two must select the same row.
  describe("parseNetstatListeningPids", () => {
    // Verbatim `netstat -ano` shape captured on Windows 11.
    const NETSTAT = [
      "",
      "Active Connections",
      "",
      "  Proto  Local Address          Foreign Address        State           PID",
      "  TCP    0.0.0.0:135            0.0.0.0:0              LISTENING       1520",
      "  TCP    127.0.0.1:3479         0.0.0.0:0              LISTENING       12345",
      "  TCP    [::]:445               [::]:0                 LISTENING       4",
      "",
    ].join("\n");

    it("finds the PID listening on the requested port", () => {
      expect(parseNetstatListeningPids(NETSTAT, 3479)).toEqual([12345]);
    });

    it("does not match a longer port sharing the prefix", () => {
      // The regression the old findstr regex had: ":3479.*LISTENING" matched
      // this row, so freePort killed an unrelated service.
      const out = "  TCP    127.0.0.1:34790        0.0.0.0:0              LISTENING       999\n";
      expect(parseNetstatListeningPids(out, 3479)).toEqual([]);
    });

    it("ignores connected rows on the same port", () => {
      const out = "  TCP    127.0.0.1:3479         127.0.0.1:5500         ESTABLISHED     42\n";
      expect(parseNetstatListeningPids(out, 3479)).toEqual([]);
    });

    it("does not treat a TIME_WAIT row as a listener (headline case: killed sidecar's lingering connection)", () => {
      // Mirrors `finds_a_lingering_connection_when_there_is_no_listener` in
      // src-tauri/src/sidecar.rs — same row, same claim: the old sidecar is gone
      // (no LISTENING row) but its connections sit in TIME_WAIT with owner PID
      // 0, and freePortWindows must not try to taskkill PID 0. The Rust and TS
      // parsers must agree here or the dialog names one thing and the kill
      // targets another.
      const out = "  TCP    127.0.0.1:3479         127.0.0.1:52000        TIME_WAIT       0\n";
      expect(parseNetstatListeningPids(out, 3479)).toEqual([]);
    });

    it("ignores listeners on interfaces that don't contend with a loopback bind", () => {
      // A WSL/Hyper-V/Docker adapter listening on its own address does not
      // prevent Tandem binding 127.0.0.1 — killing it would be pure collateral.
      const out = "  TCP    172.28.16.1:3479       0.0.0.0:0              LISTENING       777\n";
      expect(parseNetstatListeningPids(out, 3479)).toEqual([]);
    });

    it("returns every distinct holder, not just the last row", () => {
      // The old `.at(-1)` over the whole blob returned one PID — and not
      // necessarily one from a matching row.
      const out = [
        "  TCP    127.0.0.1:3479         0.0.0.0:0              LISTENING       111",
        "  TCP    [::]:3479              [::]:0                 LISTENING       222",
        "  TCP    [::]:445               [::]:0                 LISTENING       4",
      ].join("\n");
      expect(parseNetstatListeningPids(out, 3479)).toEqual([111, 222]);
    });

    it("treats a wildcard foreign port as listening (localized Windows)", () => {
      // netstat localizes the State column, so "LISTENING" is absent on a
      // non-English host. A foreign address of *:0 is the structural signature.
      const out = "  TCP    127.0.0.1:3479         0.0.0.0:0              ABIERTO         31\n";
      expect(parseNetstatListeningPids(out, 3479)).toEqual([31]);
    });

    it("returns nothing for empty, header-only, or garbage output", () => {
      expect(parseNetstatListeningPids("", 3479)).toEqual([]);
      expect(parseNetstatListeningPids("no table here", 3479)).toEqual([]);
      expect(
        parseNetstatListeningPids("  Proto  Local Address  Foreign Address  State  PID", 3479),
      ).toEqual([]);
    });

    it("rejects a non-numeric PID column", () => {
      const out = "  TCP    127.0.0.1:3479         0.0.0.0:0              LISTENING       n/a\n";
      expect(parseNetstatListeningPids(out, 3479)).toEqual([]);
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
      expectWithinMs(Date.now() - start, 500, "waitForPort does not poll when the port is free");
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

    // Pins the DEFAULT timeout (no explicit argument). Uses fake timers so the
    // 15s ceiling costs no wall clock. The default is coupled to HEALTH_TIMEOUT
    // in src-tauri/src/sidecar.rs — the Tauri shell times this wait from outside the
    // process, so lowering one without the other resurrects the post-update
    // "Server failed to start after 3 restart attempts" failure.
    it("defaults to a 15s ceiling", async () => {
      holdServer = net.createServer();
      await new Promise<void>((resolve) => holdServer!.listen(0, "127.0.0.1", resolve));
      const port = (holdServer.address() as net.AddressInfo).port;

      vi.useFakeTimers();
      try {
        let settled: "pending" | "rejected" = "pending";
        const pending = waitForPort(port).catch((err: Error) => {
          settled = "rejected";
          return err;
        });

        await vi.advanceTimersByTimeAsync(14_900);
        expect(settled).toBe("pending");

        await vi.advanceTimersByTimeAsync(400);
        const err = await pending;
        expect(settled).toBe("rejected");
        expect((err as Error).message).toBe(`Port ${port} still not available after 15000ms`);
      } finally {
        vi.useRealTimers();
      }
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

  // #1758 — identify the holder of the port before `freePort` SIGKILLs it.
  describe("probeTandemInstance", () => {
    const servers: http.Server[] = [];

    afterEach(async () => {
      await Promise.all(
        servers.splice(0).map(
          (s) =>
            new Promise<void>((resolve) => {
              s.closeAllConnections?.();
              s.close(() => resolve());
            }),
        ),
      );
    });

    async function listen(handler: http.RequestListener): Promise<number> {
      const server = http.createServer(handler);
      servers.push(server);
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      const addr = server.address();
      if (typeof addr === "string" || addr === null) throw new Error("no port");
      return addr.port;
    }

    function json(res: http.ServerResponse, status: number, body: unknown): void {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    }

    it("identifies a Tandem-shaped /health body", async () => {
      const port = await listen((_req, res) =>
        json(res, 200, { status: "ok", version: "9.9.9", pid: 4242, transport: "http" }),
      );
      await expect(probeTandemInstance(port)).resolves.toEqual({ pid: 4242, version: "9.9.9" });
    });

    // A `status: "ok"` body is not proof of Tandem. Accepting one would let an
    // unrelated health endpoint block startup forever, and a refusal nothing
    // can recover from is worse than the bug this probe fixes.
    it("returns null for an ok body with no pid", async () => {
      const port = await listen((_req, res) => json(res, 200, { status: "ok", version: "x" }));
      await expect(probeTandemInstance(port, FAST)).resolves.toBeNull();
    });

    it("returns null for a 200 that is not JSON", async () => {
      const port = await listen((_req, res) => {
        res.writeHead(200, { "content-type": "text/plain" });
        res.end("hello");
      });
      await expect(probeTandemInstance(port, FAST)).resolves.toBeNull();
    });

    it("returns null for a 404", async () => {
      const port = await listen((_req, res) => json(res, 404, { error: "nope" }));
      await expect(probeTandemInstance(port, FAST)).resolves.toBeNull();
    });

    it("returns null when nothing is listening", async () => {
      await expect(probeTandemInstance(59_998, FAST)).resolves.toBeNull();
    });

    // Kills a missing timeout, which would hang every startup behind a
    // black-holed port.
    it("returns null against a server that never responds", { timeout: 15_000 }, async () => {
      const port = await listen(() => {
        /* never answers */
      });
      await expect(probeTandemInstance(port, FAST)).resolves.toBeNull();
    });

    // Kills the single-shot probe: a healthy Tandem whose event loop is
    // briefly blocked would otherwise classify as absent and then be SIGKILLed.
    it("retries, so a server that answers on the third attempt is found", async () => {
      let seen = 0;
      const port = await listen((_req, res) => {
        seen += 1;
        if (seen < 3) {
          res.destroy();
          return;
        }
        json(res, 200, { status: "ok", version: "1.2.3", pid: 77 });
      });
      await expect(probeTandemInstance(port, FAST)).resolves.toEqual({ pid: 77, version: "1.2.3" });
    });
  });

  describe("decideStartupAction", () => {
    const LIVE = { pid: 1, version: "1.0.0" };

    // No evidence → today's behaviour, `freePort` included.
    it("proceeds when nothing answered", () => {
      expect(decideStartupAction({ probe: null, mode: "http", isSidecar: false })).toBe("proceed");
    });

    it("refuses when a live Tandem holds the port in http mode", () => {
      expect(decideStartupAction({ probe: LIVE, mode: "http", isSidecar: false })).toBe("refuse");
    });

    // Kills a refusal that strands the desktop app behind its own orphaned
    // sidecar — the shell has no other way to reclaim the port.
    it("proceeds for the Tauri sidecar even against a live instance", () => {
      expect(decideStartupAction({ probe: LIVE, mode: "http", isSidecar: true })).toBe("proceed");
    });

    // Kills the stdio branch inheriting the exit, which would break every MCP
    // client that spawns it.
    it("skips freePort rather than exiting in stdio mode", () => {
      expect(decideStartupAction({ probe: LIVE, mode: "stdio", isSidecar: false })).toBe(
        "skip-freeport",
      );
    });
  });

  // The derivation itself, through the helper — NOT a hand-passed boolean.
  // `TANDEM_TAURI_SIDECAR` is inherited by every descendant of the sidecar, so
  // keying the carve-out on it means an npm `tandem` launched from an
  // auto-launched Claude Code session SIGKILLs the desktop's own sidecar: the
  // issue's bug, reached through its fix.
  describe("isTauriSidecar", () => {
    const saved = process.env.TANDEM_TAURI_SIDECAR;
    afterEach(() => {
      if (saved === undefined) delete process.env.TANDEM_TAURI_SIDECAR;
      else process.env.TANDEM_TAURI_SIDECAR = saved;
    });

    it("is true when argv carries the flag", () => {
      expect(isTauriSidecar(["node", "server.js", TAURI_SIDECAR_ARGV_FLAG])).toBe(true);
    });

    it("is false for a descendant that merely inherited the env var", () => {
      process.env.TANDEM_TAURI_SIDECAR = "1";
      expect(isTauriSidecar(["node", "server.js"])).toBe(false);
      expect(
        decideStartupAction({
          probe: { pid: 1, version: "1.0.0" },
          mode: "http",
          isSidecar: isTauriSidecar(["node", "server.js"]),
        }),
      ).toBe("refuse");
    });
  });

  // The fix is call-site ordering, and no test can drive `main()` — the module
  // binds ports on import. Same pattern as `tests/docs/loopback-gate-claims.
  // test.ts` and `tests/server/document-write-rearm.test.ts`: read the source
  // and assert by index.
  //
  // What it kills: landing both functions fully tested and never calling them,
  // or calling them after `freePort`. Under that implementation every other
  // case in this file is green and none of the behavioural clauses hold.
  describe("startup decision wiring (source shape)", () => {
    const source = readFileSync(
      path.join(import.meta.dirname, "..", "..", "src", "server", "index.ts"),
      "utf-8",
    );

    it("consults decideStartupAction before the store lock and before every freePort", () => {
      const decide = source.indexOf("decideStartupAction(");
      expect(decide).toBeGreaterThan(-1);

      const lock = source.indexOf("acquireStoreLock(");
      expect(lock).toBeGreaterThan(-1);
      expect(decide).toBeLessThan(lock);

      const freePorts = [...source.matchAll(/freePort\(/g)].map((m) => m.index ?? -1);
      expect(freePorts.length).toBeGreaterThanOrEqual(2);
      for (const at of freePorts) expect(decide).toBeLessThan(at);
    });

    it("exits 1 on the refusal arm", () => {
      const refuse = source.indexOf('action === "refuse"');
      expect(refuse).toBeGreaterThan(-1);
      const window = source.slice(refuse, refuse + 1_500);
      expect(window).toContain("process.exit(1)");
    });
  });
});
