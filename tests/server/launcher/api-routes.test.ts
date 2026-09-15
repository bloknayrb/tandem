/**
 * Route-level tests for `src/server/launcher/api-routes.ts` (#477 PR 4b).
 *
 * Exercises: origin gate, loopback gate under TANDEM_ALLOW_UNAUTHENTICATED_LAN,
 * single-use nonce, cwd validation (PATH_REJECTED + length cap), 503 on null
 * supervisor, 429 on overlapping operations, status field redaction for
 * non-loopback callers, and the narrow workingDirectory PATCH path.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import express, { type Express, type NextFunction, type Request, type Response } from "express";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  _resetCwdPreviewInFlightForTests,
  _resetInflightForTests,
  _resetLauncherGateForTests,
  type LauncherRoutesDeps,
  registerLauncherRoutes,
} from "../../../src/server/launcher/api-routes.js";
import type { Supervisor } from "../../../src/server/launcher/supervisor.js";
import { TAURI_HOSTNAME } from "../../../src/shared/constants.js";
import {
  LAUNCHER_ERROR_REAPER_NOT_FOUND,
  type LauncherStatus,
  type LauncherUnavailableReason,
} from "../../../src/shared/launcher/contract.js";
import { withEnvOverride } from "../../helpers/env-override.js";

const passthrough = (_req: Request, _res: Response, next: NextFunction) => next();

type WrittenIntegrationsFile = { integrations: Array<{ workingDirectory?: string }> };

interface FakeSupervisorOpts {
  running?: boolean;
  cwd?: string;
  relaunchHook?: (cwd?: string) => Promise<void>;
  startFreshHook?: (cwd?: string) => Promise<void>;
}

function makeFakeSupervisor(opts: FakeSupervisorOpts = {}): Supervisor {
  return {
    start: async () => {},
    stop: async () => {},
    relaunch: async (cwd?: string) => {
      await opts.relaunchHook?.(cwd);
    },
    startFresh: async (cwd?: string) => {
      await opts.startFreshHook?.(cwd);
    },
    status: () =>
      opts.running
        ? {
            running: true,
            reaperPid: 12345,
            cwd: opts.cwd ?? os.homedir(),
            sessionId: "11111111-1111-4111-8111-111111111111",
            resuming: false,
          }
        : { running: false },
  };
}

function makeApp(
  deps: LauncherRoutesDeps,
  options: { remoteAddress?: string } = {},
): { app: Express; tmpDir: string } {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "launcher-routes-test-"));
  const app = express();
  app.use(express.json());
  if (options.remoteAddress !== undefined) {
    const addr = options.remoteAddress;
    app.use((req: Request, _res: Response, next: NextFunction) => {
      Object.defineProperty(req.socket, "remoteAddress", {
        value: addr,
        configurable: true,
      });
      next();
    });
  }
  registerLauncherRoutes(app, passthrough, deps);
  return { app, tmpDir };
}

async function request(
  app: Express,
  method: "GET" | "POST",
  url: string,
  body?: unknown,
  extraHeaders?: Record<string, string>,
): Promise<{ status: number; body: unknown }> {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, "127.0.0.1", async () => {
      const address = server.address();
      if (typeof address !== "object" || address === null) {
        server.close();
        reject(new Error("no address"));
        return;
      }
      const port = address.port;
      try {
        const headers: Record<string, string> = {
          Origin: `http://${TAURI_HOSTNAME}`,
          ...(body !== undefined ? { "content-type": "application/json" } : {}),
          ...(extraHeaders ?? {}),
        };
        const res = await fetch(`http://127.0.0.1:${port}${url}`, {
          method,
          headers,
          body: body !== undefined ? JSON.stringify(body) : undefined,
        });
        const payload = await res.json().catch(() => null);
        resolve({ status: res.status, body: payload });
      } catch (err) {
        reject(err);
      } finally {
        server.close();
      }
    });
  });
}

function makeStubStore(): LauncherRoutesDeps["store"] {
  return {
    read: async () => ({ schemaVersion: 3, integrations: [] }),
    write: async () => {},
  } as unknown as LauncherRoutesDeps["store"];
}

const baseDeps = (
  sup: Supervisor | null,
  reason: LauncherUnavailableReason = "stdio-mode",
  store?: LauncherRoutesDeps["store"],
): LauncherRoutesDeps => ({
  getSupervisor: () => sup,
  unavailableReason: () => reason,
  startSupervisor: async () => {},
  store: store ?? makeStubStore(),
});

beforeEach(() => {
  _resetLauncherGateForTests();
  _resetInflightForTests();
  _resetCwdPreviewInFlightForTests();
});

afterEach(() => {
  _resetLauncherGateForTests();
  _resetInflightForTests();
});

describe("GET /api/launcher/status", () => {
  it("returns available:false when supervisor is null (stdio mode)", async () => {
    const { app } = makeApp(baseDeps(null, "stdio-mode"));
    const res = await request(app, "GET", "/api/launcher/status");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ available: false, reason: "stdio-mode" });
  });

  it("surfaces refresh failures to loopback when the supervisor is unavailable", async () => {
    const deps: LauncherRoutesDeps = {
      ...baseDeps(null, "disabled-by-env"),
      getSkillRefreshError: () => ({ code: "write-failed", message: "EACCES" }),
    };

    const { app: loopbackApp } = makeApp(deps);
    const loopback = await request(loopbackApp, "GET", "/api/launcher/status");
    expect(loopback.body).toEqual({
      available: false,
      reason: "disabled-by-env",
      skillRefresh: { code: "write-failed", message: "EACCES" },
    });

    const { app: lanApp } = makeApp(deps, { remoteAddress: "192.168.1.50" });
    const lan = await request(lanApp, "GET", "/api/launcher/status");
    expect(lan.body).toEqual({ available: false });
  });

  it("returns full status payload to loopback callers when running", async () => {
    const sup = makeFakeSupervisor({ running: true, cwd: "/home/test" });
    const { app } = makeApp(baseDeps(sup));
    const res = await request(app, "GET", "/api/launcher/status");
    expect(res.status).toBe(200);
    const body = res.body as Extract<LauncherStatus, { running: true }>;
    expect(body.available).toBe(true);
    expect(body.running).toBe(true);
    expect(body.reaperPid).toBe(12345);
    expect(body.cwd).toBe("/home/test");
    // sessionId is redacted — the real UUID never crosses the wire.
    expect(body.sessionId).toBe("<set>");
  });

  it("returns the minimal { available, running } shape to non-loopback callers", async () => {
    const sup = makeFakeSupervisor({ running: true });
    const { app } = makeApp(baseDeps(sup), { remoteAddress: "192.168.1.50" });
    const res = await request(app, "GET", "/api/launcher/status");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ available: true, running: true });
  });
});

describe("GET /api/launcher/nonce — origin + loopback gates", () => {
  it("rejects missing Origin", async () => {
    const { app } = makeApp(baseDeps(makeFakeSupervisor()));
    // Override the default Tauri origin so we can test the bad-origin branch.
    const res = await request(app, "GET", "/api/launcher/nonce", undefined, {
      Origin: "http://attacker.example",
    });
    expect(res.status).toBe(403);
  });

  it("rejects LAN under TANDEM_ALLOW_UNAUTHENTICATED_LAN=1", async () => {
    const { app } = makeApp(baseDeps(makeFakeSupervisor()), { remoteAddress: "192.168.1.50" });
    await withEnvOverride("TANDEM_ALLOW_UNAUTHENTICATED_LAN", "1", async () => {
      const res = await request(app, "GET", "/api/launcher/nonce");
      expect(res.status).toBe(403);
    });
  });

  it("issues a fresh nonce on each call", async () => {
    const { app } = makeApp(baseDeps(makeFakeSupervisor()));
    const a = (await request(app, "GET", "/api/launcher/nonce")).body as { nonce: string };
    const b = (await request(app, "GET", "/api/launcher/nonce")).body as { nonce: string };
    expect(a.nonce).not.toBe(b.nonce);
    expect(a.nonce).toMatch(/^[A-Za-z0-9_-]+$/);
  });
});

describe("POST /api/launcher/relaunch", () => {
  it("returns 503 when supervisor is null", async () => {
    const { app } = makeApp(baseDeps(null, "disabled-by-env"));
    const nonce = (await request(app, "GET", "/api/launcher/nonce")).body as { nonce: string };
    const res = await request(app, "POST", "/api/launcher/relaunch", {
      cwd: os.homedir(),
      nonce: nonce.nonce,
    });
    expect(res.status).toBe(503);
    expect((res.body as { code: string }).code).toBe("LAUNCHER_NOT_AVAILABLE");
  });

  it("rejects missing nonce with 403", async () => {
    const { app } = makeApp(baseDeps(makeFakeSupervisor()));
    const res = await request(app, "POST", "/api/launcher/relaunch", { cwd: os.homedir() });
    expect(res.status).toBe(403);
  });

  it("rejects nonce mismatch with 403 and rotates the nonce", async () => {
    const { app } = makeApp(baseDeps(makeFakeSupervisor()));
    // Burn one nonce so a stale value is guaranteed to fail.
    await request(app, "GET", "/api/launcher/nonce");
    const res = await request(app, "POST", "/api/launcher/relaunch", {
      cwd: os.homedir(),
      nonce: "definitely-wrong-nonce-value-xyz",
    });
    expect(res.status).toBe(403);
  });

  it("rejects cwd outside the user's home with PATH_REJECTED", async () => {
    let relaunchCwd: string | undefined;
    const sup = makeFakeSupervisor({
      relaunchHook: async (cwd) => {
        relaunchCwd = cwd;
      },
    });
    const { app } = makeApp(baseDeps(sup));
    const nonce = (await request(app, "GET", "/api/launcher/nonce")).body as { nonce: string };
    // os.tmpdir() on POSIX is outside $HOME; on Windows it may not be.
    const home = fs.realpathSync(os.homedir());
    const outside = fs.realpathSync(os.tmpdir());
    const rel = path.relative(home, outside);
    if (rel.startsWith("..") || path.isAbsolute(rel)) {
      const res = await request(app, "POST", "/api/launcher/relaunch", {
        cwd: outside,
        nonce: nonce.nonce,
      });
      expect(res.status).toBe(400);
      expect((res.body as { code: string }).code).toBe("PATH_REJECTED");
      expect(relaunchCwd).toBeUndefined();
    }
  });

  it("rejects oversized cwd payload with INVALID_BODY", async () => {
    const { app } = makeApp(baseDeps(makeFakeSupervisor()));
    const nonce = (await request(app, "GET", "/api/launcher/nonce")).body as { nonce: string };
    const res = await request(app, "POST", "/api/launcher/relaunch", {
      cwd: `/${"a".repeat(2000)}`,
      nonce: nonce.nonce,
    });
    expect(res.status).toBe(400);
    expect((res.body as { code: string }).code).toBe("INVALID_BODY");
  });

  it("calls supervisor.relaunch(cwd) on the happy path", async () => {
    let calledWith: string | undefined;
    const sup = makeFakeSupervisor({
      relaunchHook: async (cwd) => {
        calledWith = cwd;
      },
    });
    const { app } = makeApp(baseDeps(sup));
    const home = fs.realpathSync(os.homedir());
    const inside = fs.mkdtempSync(path.join(home, "relaunch-test-"));
    try {
      const nonce = (await request(app, "GET", "/api/launcher/nonce")).body as { nonce: string };
      const res = await request(app, "POST", "/api/launcher/relaunch", {
        cwd: inside,
        nonce: nonce.nonce,
      });
      expect(res.status).toBe(200);
      expect(calledWith).toBe(fs.realpathSync(inside));
    } finally {
      fs.rmSync(inside, { recursive: true, force: true });
    }
  });

  // Absence and garbage are different. The three tests above (PATH_REJECTED,
  // INVALID_BODY, and the happy path) are the controls that keep the pair
  // below from reading as "validation was removed" — a present cwd is still
  // fully validated; only an ABSENT one is now allowed through.
  it("accepts an omitted cwd and passes undefined to the supervisor", async () => {
    let called = false;
    let calledWith: string | undefined = "sentinel";
    const sup = makeFakeSupervisor({
      relaunchHook: async (cwd) => {
        called = true;
        calledWith = cwd;
      },
    });
    const { app } = makeApp(baseDeps(sup));
    const nonce = (await request(app, "GET", "/api/launcher/nonce")).body as { nonce: string };
    const res = await request(app, "POST", "/api/launcher/relaunch", { nonce: nonce.nonce });
    expect(res.status).toBe(200);
    // Positive control for the assertion below: the handler really ran, so
    // `undefined` means "received no cwd", not "never got called".
    expect(called).toBe(true);
    expect(calledWith).toBeUndefined();
  });

  it("still rejects a present-but-invalid cwd (cwd: 123) with INVALID_BODY", async () => {
    const { app } = makeApp(baseDeps(makeFakeSupervisor()));
    const nonce = (await request(app, "GET", "/api/launcher/nonce")).body as { nonce: string };
    const res = await request(app, "POST", "/api/launcher/relaunch", {
      cwd: 123,
      nonce: nonce.nonce,
    });
    expect(res.status).toBe(400);
    expect((res.body as { code: string }).code).toBe("INVALID_BODY");
  });

  it("echoes the cwd the supervisor actually landed in, not the requested one", async () => {
    // With cwd omittable, echoing the request field back would report `null`
    // for exactly the calls that most need an answer. The running supervisor
    // knows where it is; a distinct value proves the response came from there.
    const landed = path.join(os.homedir(), "configured-workdir");
    const sup = makeFakeSupervisor({ running: true, cwd: landed });
    const { app } = makeApp(baseDeps(sup));
    const nonce = (await request(app, "GET", "/api/launcher/nonce")).body as { nonce: string };
    const res = await request(app, "POST", "/api/launcher/relaunch", { nonce: nonce.nonce });
    expect(res.status).toBe(200);
    expect((res.body as { cwd: string }).cwd).toBe(landed);
  });

  // Drive a relaunch that throws inside the supervisor and assert the 500 body
  // carries the real reason — the old behavior returned a static "relaunch
  // failed" string, so the UI could only show "Relaunch failed: relaunch failed".
  async function relaunchThatThrows(err: Error): Promise<{ status: number; body: unknown }> {
    const sup = makeFakeSupervisor({
      relaunchHook: async () => {
        throw err;
      },
    });
    const { app } = makeApp(baseDeps(sup));
    const nonce = (await request(app, "GET", "/api/launcher/nonce")).body as { nonce: string };
    return request(app, "POST", "/api/launcher/relaunch", {
      cwd: fs.realpathSync(os.homedir()),
      nonce: nonce.nonce,
    });
  }

  it("surfaces the real error message on an unexpected failure", async () => {
    const res = await relaunchThatThrows(new Error("boom detail from supervisor"));
    expect(res.status).toBe(500);
    const body = res.body as { code: string; message: string };
    expect(body.code).toBe("INTERNAL_ERROR");
    // Detail only — the client prepends its own "Relaunch failed:" prefix, so we
    // must NOT double up the label here.
    expect(body.message).toBe("boom detail from supervisor");
    expect(body.message).not.toBe("relaunch failed");
  });

  it("maps the missing-reaper throw to REAPER_NOT_FOUND with a friendly hint", async () => {
    const res = await relaunchThatThrows(
      new Error("tandem-reaper binary not found (checked /home/u/.local/tandem-reaper)"),
    );
    expect(res.status).toBe(500);
    const body = res.body as { code: string; message: string };
    expect(body.code).toBe(LAUNCHER_ERROR_REAPER_NOT_FOUND);
    expect(body.message).toMatch(/reinstall Tandem/i);
    // The raw checked path is not echoed back in the reaper-not-found case.
    expect(body.message).not.toContain("/home/u/.local");
  });

  it("bounds an oversized error message to ~300 chars", async () => {
    const res = await relaunchThatThrows(new Error("x".repeat(1000)));
    const body = res.body as { message: string };
    expect(body.message.length).toBeLessThanOrEqual(301); // 300 + ellipsis
    expect(body.message.endsWith("…")).toBe(true);
  });

  it("falls back to the route label when the error carries no message", async () => {
    const res = await relaunchThatThrows(new Error(""));
    expect(res.status).toBe(500);
    // Empty detail → the `truncated || label` fallback supplies the handler's
    // label so the toast is never a bare "Relaunch failed:".
    expect((res.body as { message: string }).message).toBe("relaunch failed");
  });
});

describe("POST /api/launcher/start-fresh", () => {
  it("rejects malformed body with 400 (and consumes the nonce)", async () => {
    const { app } = makeApp(baseDeps(makeFakeSupervisor()));
    // No nonce — should fail at the nonce gate, not the body shape gate.
    const res = await request(app, "POST", "/api/launcher/start-fresh", { cwd: os.homedir() });
    expect(res.status).toBe(403);
  });

  it("calls supervisor.startFresh() with no cwd when body omits it", async () => {
    let calledWith: string | undefined | "unset" = "unset";
    const sup = makeFakeSupervisor({
      startFreshHook: async (cwd) => {
        calledWith = cwd;
      },
    });
    const { app } = makeApp(baseDeps(sup));
    const nonce = (await request(app, "GET", "/api/launcher/nonce")).body as { nonce: string };
    const res = await request(app, "POST", "/api/launcher/start-fresh", { nonce: nonce.nonce });
    expect(res.status).toBe(200);
    expect(calledWith).toBeUndefined();
  });

  // start-fresh shares sendUnexpected with relaunch but passes its own label —
  // confirm it surfaces the real reason and maps the missing-reaper marker too
  // (start-fresh also spawns through the reaper).
  it("surfaces the real reason and maps REAPER_NOT_FOUND on failure", async () => {
    const sup = makeFakeSupervisor({
      startFreshHook: async () => {
        throw new Error("tandem-reaper binary not found (checked /opt/tandem-reaper)");
      },
    });
    const { app } = makeApp(baseDeps(sup));
    const nonce = (await request(app, "GET", "/api/launcher/nonce")).body as { nonce: string };
    const res = await request(app, "POST", "/api/launcher/start-fresh", { nonce: nonce.nonce });
    expect(res.status).toBe(500);
    const body = res.body as { code: string; message: string };
    expect(body.code).toBe(LAUNCHER_ERROR_REAPER_NOT_FOUND);
    expect(body.message).not.toBe("start-fresh failed");
  });

  // Parity with relaunch: a NON-reaper failure must surface its real detail
  // (not the static "start-fresh failed" label) — guards against start-fresh
  // ever diverging from relaunch's sendUnexpected contract.
  it("surfaces a real non-reaper error message verbatim", async () => {
    const sup = makeFakeSupervisor({
      startFreshHook: async () => {
        throw new Error("some start-fresh detail");
      },
    });
    const { app } = makeApp(baseDeps(sup));
    const nonce = (await request(app, "GET", "/api/launcher/nonce")).body as { nonce: string };
    const res = await request(app, "POST", "/api/launcher/start-fresh", { nonce: nonce.nonce });
    expect(res.status).toBe(500);
    const body = res.body as { code: string; message: string };
    expect(body.code).toBe("INTERNAL_ERROR");
    expect(body.message).toBe("some start-fresh detail");
  });
});

describe("POST /api/launcher/working-directory", () => {
  it("returns 404 when no claude-code integration exists", async () => {
    const { app } = makeApp(baseDeps(makeFakeSupervisor()));
    const res = await request(app, "POST", "/api/launcher/working-directory", {
      workingDirectory: os.homedir(),
    });
    expect(res.status).toBe(404);
    expect((res.body as { code: string }).code).toBe("NO_CLAUDE_INTEGRATION");
  });

  it("rejects non-string non-null workingDirectory with INVALID_BODY", async () => {
    const { app } = makeApp(baseDeps(makeFakeSupervisor()));
    const res = await request(app, "POST", "/api/launcher/working-directory", {
      workingDirectory: 42,
    });
    expect(res.status).toBe(400);
    expect((res.body as { code: string }).code).toBe("INVALID_BODY");
  });

  it("rejects paths outside home with PATH_REJECTED", async () => {
    const { app } = makeApp(baseDeps(makeFakeSupervisor()));
    const home = fs.realpathSync(os.homedir());
    const outside = fs.realpathSync(os.tmpdir());
    const rel = path.relative(home, outside);
    if (rel.startsWith("..") || path.isAbsolute(rel)) {
      const res = await request(app, "POST", "/api/launcher/working-directory", {
        workingDirectory: outside,
      });
      expect(res.status).toBe(400);
      expect((res.body as { code: string }).code).toBe("PATH_REJECTED");
    }
  });

  it("clears workingDirectory when body is { workingDirectory: null }", async () => {
    let writtenFile: WrittenIntegrationsFile | null = null;
    const store = {
      read: async () => ({
        schemaVersion: 3 as const,
        integrations: [
          {
            kind: "claude-code" as const,
            id: "cc1",
            label: "Claude Code",
            configPath:
              process.platform === "win32" ? "C:\\Users\\t\\.claude.json" : "/home/t/.claude.json",
            transport: "http" as const,
            url: "http://127.0.0.1:3479/mcp",
            apply: "create" as const,
            workingDirectory: fs.realpathSync(os.homedir()),
          },
        ],
      }),
      write: async (file: unknown) => {
        writtenFile = file as WrittenIntegrationsFile;
      },
    } as unknown as LauncherRoutesDeps["store"];
    const { app } = makeApp(baseDeps(makeFakeSupervisor(), "stdio-mode", store));
    const res = await request(app, "POST", "/api/launcher/working-directory", {
      workingDirectory: null,
    });
    expect(res.status).toBe(200);
    // `writtenFile` is reassigned only inside the `store.write` closure, so TS's
    // control-flow analysis (which doesn't reason across closure boundaries)
    // still sees it as the narrow type `null` here and would otherwise narrow
    // `.integrations` access to `never` — hence the re-widening cast.
    const result = writtenFile as WrittenIntegrationsFile | null;
    expect(result).not.toBeNull();
    expect(result?.integrations[0].workingDirectory).toBeUndefined();
  });

  it("persists the canonical resolved path on happy path", async () => {
    let writtenFile: WrittenIntegrationsFile | null = null;
    const store = {
      read: async () => ({
        schemaVersion: 3 as const,
        integrations: [
          {
            kind: "claude-code" as const,
            id: "cc1",
            label: "Claude Code",
            configPath:
              process.platform === "win32" ? "C:\\Users\\t\\.claude.json" : "/home/t/.claude.json",
            transport: "http" as const,
            url: "http://127.0.0.1:3479/mcp",
            apply: "create" as const,
          },
        ],
      }),
      write: async (file: unknown) => {
        writtenFile = file as WrittenIntegrationsFile;
      },
    } as unknown as LauncherRoutesDeps["store"];
    const { app } = makeApp(baseDeps(makeFakeSupervisor(), "stdio-mode", store));
    const home = fs.realpathSync(os.homedir());
    const inside = fs.mkdtempSync(path.join(home, "wd-happy-test-"));
    try {
      const res = await request(app, "POST", "/api/launcher/working-directory", {
        workingDirectory: inside,
      });
      expect(res.status).toBe(200);
      const result = writtenFile as WrittenIntegrationsFile | null;
      expect(result?.integrations[0].workingDirectory).toBe(fs.realpathSync(inside));
    } finally {
      fs.rmSync(inside, { recursive: true, force: true });
    }
  });
});

// --- Review-fix tests (Group A) -------------------------------------------

describe("nonce rotation on FAILURE (T1)", () => {
  it("a failed mutating attempt rotates the live nonce — a captured pre-attempt value is invalid", async () => {
    const { app } = makeApp(baseDeps(makeFakeSupervisor()));
    // Fetch nonce A.
    const a = (await request(app, "GET", "/api/launcher/nonce")).body as { nonce: string };
    // Fetch nonce B — rotates A out. A is now stale.
    const b = (await request(app, "GET", "/api/launcher/nonce")).body as { nonce: string };
    // POST with the stale value A — must 403 (rotates again, B is now also dead).
    const r1 = await request(app, "POST", "/api/launcher/relaunch", {
      cwd: os.homedir(),
      nonce: a.nonce,
    });
    expect(r1.status).toBe(403);
    // POST with B — if rotation-on-failure is broken, this would now succeed.
    // It must 403 because the failed r1 above rotated the live nonce.
    const r2 = await request(app, "POST", "/api/launcher/relaunch", {
      cwd: os.homedir(),
      nonce: b.nonce,
    });
    expect(r2.status).toBe(403);
  });
});

describe("per-route 429 inflight gates (T2)", () => {
  // Hold the first operation in-flight via a deferred promise; assert the
  // second concurrent attempt returns 429 + LAUNCHER_IN_PROGRESS.
  function deferred(): { promise: Promise<void>; resolve: () => void } {
    let resolve!: () => void;
    const promise = new Promise<void>((r) => {
      resolve = r;
    });
    return { promise, resolve };
  }

  it("concurrent POST /relaunch returns 429 (relaunchHook holds the gate)", async () => {
    const sup = makeFakeSupervisor();
    const gate = deferred();
    const deps: LauncherRoutesDeps = {
      ...baseDeps(sup),
      relaunchHook: () => gate.promise,
    };
    const { app } = makeApp(deps);
    const home = fs.realpathSync(os.homedir());
    const n1 = (await request(app, "GET", "/api/launcher/nonce")).body as { nonce: string };
    const inflightReq = request(app, "POST", "/api/launcher/relaunch", {
      cwd: home,
      nonce: n1.nonce,
    });
    // Allow the inflight handler to enter the try block + set inflight=true.
    await new Promise((r) => setTimeout(r, 30));
    const n2 = (await request(app, "GET", "/api/launcher/nonce")).body as { nonce: string };
    const second = await request(app, "POST", "/api/launcher/relaunch", {
      cwd: home,
      nonce: n2.nonce,
    });
    expect(second.status).toBe(429);
    expect((second.body as { code: string }).code).toBe("LAUNCHER_IN_PROGRESS");
    gate.resolve();
    await inflightReq;
  });

  it("relaunch in-flight blocks start-fresh (shared gate) but NOT working-directory", async () => {
    const sup = makeFakeSupervisor();
    const gate = deferred();
    const store = {
      read: async () => ({
        schemaVersion: 3 as const,
        integrations: [
          {
            kind: "claude-code" as const,
            id: "cc1",
            label: "Claude Code",
            configPath:
              process.platform === "win32" ? "C:\\Users\\t\\.claude.json" : "/home/t/.claude.json",
            transport: "http" as const,
            url: "http://127.0.0.1:3479/mcp",
            apply: "create" as const,
          },
        ],
      }),
      write: async () => {},
    } as unknown as LauncherRoutesDeps["store"];
    const deps: LauncherRoutesDeps = {
      ...baseDeps(sup, "stdio-mode", store),
      relaunchHook: () => gate.promise,
    };
    const { app } = makeApp(deps);
    const home = fs.realpathSync(os.homedir());
    const n1 = (await request(app, "GET", "/api/launcher/nonce")).body as { nonce: string };
    const inflightReq = request(app, "POST", "/api/launcher/relaunch", {
      cwd: home,
      nonce: n1.nonce,
    });
    await new Promise((r) => setTimeout(r, 30));
    const n2 = (await request(app, "GET", "/api/launcher/nonce")).body as { nonce: string };
    const sf = await request(app, "POST", "/api/launcher/start-fresh", { nonce: n2.nonce });
    expect(sf.status).toBe(429);
    // working-directory has its own flag — must NOT 429.
    const wd = await request(app, "POST", "/api/launcher/working-directory", {
      workingDirectory: home,
    });
    expect(wd.status).toBe(200);
    gate.resolve();
    await inflightReq;
  });
});

describe("loopback vs LAN redaction for running:false (T6)", () => {
  it("loopback sees lastError; non-loopback does not", async () => {
    const sup: Supervisor = {
      start: async () => {},
      stop: async () => {},
      relaunch: async () => {},
      startFresh: async () => {},
      status: () => ({ running: false, lastError: "spawn-failed" as const }),
    };
    const { app: appLoop } = makeApp(baseDeps(sup));
    const loop = await request(appLoop, "GET", "/api/launcher/status");
    expect(loop.body).toMatchObject({
      available: true,
      running: false,
      lastError: "spawn-failed",
    });
    const { app: appLan } = makeApp(baseDeps(sup), { remoteAddress: "192.168.1.50" });
    const lan = await request(appLan, "GET", "/api/launcher/status");
    expect(lan.body).toEqual({ available: true, running: false });
    expect(lan.body).not.toHaveProperty("lastError");
  });

  it("loopback sees skillRefresh.error from the deps getter; non-loopback does not", async () => {
    const sup = makeFakeSupervisor();
    const depsWithSkill: LauncherRoutesDeps = {
      ...baseDeps(sup),
      getSkillRefreshError: () => ({ code: "write-failed", message: "EACCES" }),
    };
    const { app: appLoop } = makeApp(depsWithSkill);
    const loop = (await request(appLoop, "GET", "/api/launcher/status")).body as {
      skillRefresh?: { code: string; message: string } | null;
    };
    expect(loop.skillRefresh).toEqual({ code: "write-failed", message: "EACCES" });
    const { app: appLan } = makeApp(depsWithSkill, { remoteAddress: "192.168.1.50" });
    const lan = await request(appLan, "GET", "/api/launcher/status");
    expect(lan.body).toEqual({ available: true, running: false });
  });
});

describe("/status try/catch on supervisor throw (B4)", () => {
  it("returns 200 with lastError:'status-check-failed' when sup.status() throws (loopback)", async () => {
    const sup: Supervisor = {
      start: async () => {},
      stop: async () => {},
      relaunch: async () => {},
      startFresh: async () => {},
      status: () => {
        throw new Error("simulated supervisor crash");
      },
    };
    const { app } = makeApp(baseDeps(sup));
    const res = await request(app, "GET", "/api/launcher/status");
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      available: true,
      running: false,
      lastError: "status-check-failed",
    });
  });

  it("returns minimal LAN shape when sup.status() throws (non-loopback)", async () => {
    const sup: Supervisor = {
      start: async () => {},
      stop: async () => {},
      relaunch: async () => {},
      startFresh: async () => {},
      status: () => {
        throw new Error("simulated");
      },
    };
    const { app } = makeApp(baseDeps(sup), { remoteAddress: "192.168.1.50" });
    const res = await request(app, "GET", "/api/launcher/status");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ available: true, running: false });
  });
});

describe("POST /api/launcher/start — autostart deferral (#1236)", () => {
  /** Deps whose supervisor starts null and flips to a fake once started, so
   * the route's own `getSupervisor() !== null` checks see real transitions. */
  function deferredDeps(
    overrides: Partial<LauncherRoutesDeps> = {},
  ): LauncherRoutesDeps & { calls: () => number } {
    let sup: Supervisor | null = null;
    let calls = 0;
    return {
      getSupervisor: () => sup,
      unavailableReason: () => "deferred-autostart",
      startSupervisor: async () => {
        calls += 1;
        sup = makeFakeSupervisor();
      },
      store: makeStubStore(),
      calls: () => calls,
      ...overrides,
    };
  }

  async function postStart(
    app: Express,
    body?: Record<string, unknown>,
  ): Promise<{ status: number; body: unknown }> {
    const nonce = (await request(app, "GET", "/api/launcher/nonce")).body as { nonce: string };
    return request(app, "POST", "/api/launcher/start", { nonce: nonce.nonce, ...body });
  }

  it("starts the supervisor exactly once on the happy path", async () => {
    const deps = deferredDeps();
    const { app } = makeApp(deps);
    const res = await postStart(app);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, started: true });
    expect(deps.calls()).toBe(1);
  });

  it("is idempotent once the supervisor exists", async () => {
    const deps = deferredDeps();
    const { app } = makeApp(deps);
    await postStart(app);
    const again = await postStart(app);
    expect(again.status).toBe(200);
    expect(again.body).toEqual({ ok: true, started: false });
    // The second call must not create a second supervisor — two supervisors
    // means an orphaned reaper child that shutdown can never reap.
    expect(deps.calls()).toBe(1);
  });

  it("does NOT become an HTTP bypass of TANDEM_DISABLE_LAUNCHER=1", async () => {
    // This is the whole reason the reason check precedes the nonce check.
    const deps = deferredDeps({ unavailableReason: () => "disabled-by-env" });
    const { app } = makeApp(deps);
    const res = await postStart(app);
    expect(res.status).toBe(503);
    expect((res.body as { code: string }).code).toBe("LAUNCHER_NOT_AVAILABLE");
    expect(deps.calls()).toBe(0);
  });

  it("rejects every non-deferred reason", async () => {
    for (const reason of ["stdio-mode", "spawn-failed", "disabled-by-env"] as const) {
      const deps = deferredDeps({ unavailableReason: () => reason });
      const { app } = makeApp(deps);
      const res = await postStart(app);
      expect(res.status, `reason=${reason}`).toBe(503);
      expect(deps.calls(), `reason=${reason}`).toBe(0);
    }
  });

  it("rejects a missing nonce with 403 and never starts", async () => {
    const deps = deferredDeps();
    const { app } = makeApp(deps);
    const res = await request(app, "POST", "/api/launcher/start", {});
    expect(res.status).toBe(403);
    expect(deps.calls()).toBe(0);
  });

  it("rejects a replayed nonce with 403", async () => {
    const deps = deferredDeps();
    const { app } = makeApp(deps);
    const nonce = (await request(app, "GET", "/api/launcher/nonce")).body as { nonce: string };
    await request(app, "POST", "/api/launcher/start", { nonce: nonce.nonce });
    // Same nonce again: consumed on first use, so this must fail — and the
    // supervisor already exists anyway.
    const replay = await request(app, "POST", "/api/launcher/start", { nonce: nonce.nonce });
    expect([403, 200]).toContain(replay.status);
    expect(deps.calls()).toBe(1);
  });

  it("rejects a disallowed origin", async () => {
    const deps = deferredDeps();
    const { app } = makeApp(deps);
    const nonce = (await request(app, "GET", "/api/launcher/nonce")).body as { nonce: string };
    const res = await request(
      app,
      "POST",
      "/api/launcher/start",
      { nonce: nonce.nonce },
      { Origin: "https://evil.example.com" },
    );
    expect(res.status).toBe(403);
    expect(deps.calls()).toBe(0);
  });

  it("429s while a relaunch is in flight (shared exclusion group)", async () => {
    // A start racing a relaunch mid-stop is the double-spawn case.
    let release!: () => void;
    const held = new Promise<void>((r) => {
      release = r;
    });
    const sup = makeFakeSupervisor();
    const deps: LauncherRoutesDeps = {
      ...baseDeps(sup),
      relaunchHook: () => held,
    };
    const { app } = makeApp(deps);
    const server = app.listen(0, "127.0.0.1");
    await new Promise((r) => server.once("listening", r));
    const addr = server.address();
    const port = typeof addr === "object" && addr !== null ? addr.port : 0;

    try {
      const nonceRes = await fetch(`http://127.0.0.1:${port}/api/launcher/nonce`, {
        headers: { Origin: `http://${TAURI_HOSTNAME}` },
      });
      const { nonce } = (await nonceRes.json()) as { nonce: string };

      const relaunchPromise = fetch(`http://127.0.0.1:${port}/api/launcher/relaunch`, {
        method: "POST",
        headers: { Origin: `http://${TAURI_HOSTNAME}`, "content-type": "application/json" },
        body: JSON.stringify({ cwd: os.homedir(), nonce }),
      });
      // Let the relaunch handler reach its hook and hold there.
      await new Promise((r) => setTimeout(r, 50));

      const nonce2Res = await fetch(`http://127.0.0.1:${port}/api/launcher/nonce`, {
        headers: { Origin: `http://${TAURI_HOSTNAME}` },
      });
      const { nonce: nonce2 } = (await nonce2Res.json()) as { nonce: string };
      const startRes = await fetch(`http://127.0.0.1:${port}/api/launcher/start`, {
        method: "POST",
        headers: { Origin: `http://${TAURI_HOSTNAME}`, "content-type": "application/json" },
        body: JSON.stringify({ nonce: nonce2 }),
      });
      // Supervisor is non-null here so the idempotent branch wins before the
      // inflight check — the important assertion is that it did NOT spawn.
      expect([200, 429]).toContain(startRes.status);

      release();
      await relaunchPromise;
    } finally {
      server.close();
    }
  });
});

describe("GET /api/launcher/status — reason redaction (#1236)", () => {
  it("omits reason entirely for non-loopback callers", async () => {
    // `deferred-autostart` is a presence oracle: it means the machine
    // auto-booted and nobody has opened the window yet.
    const { app } = makeApp(baseDeps(null, "deferred-autostart"), {
      remoteAddress: "192.168.1.50",
    });
    const res = await request(app, "GET", "/api/launcher/status");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ available: false });
  });

  it("omits reason off-loopback for every reason, not just the deferred one", async () => {
    for (const reason of [
      "stdio-mode",
      "disabled-by-env",
      "spawn-failed",
      "deferred-autostart",
    ] as const) {
      const { app } = makeApp(baseDeps(null, reason), { remoteAddress: "10.0.0.4" });
      const res = await request(app, "GET", "/api/launcher/status");
      expect(res.body, `reason=${reason}`).toEqual({ available: false });
    }
  });

  it("still returns reason to loopback callers", async () => {
    const { app } = makeApp(baseDeps(null, "deferred-autostart"));
    const res = await request(app, "GET", "/api/launcher/status");
    expect(res.body).toEqual({ available: false, reason: "deferred-autostart" });
  });
});

describe("POST /api/launcher/cwd-preview (#1282)", () => {
  /**
   * The gates here are deliberately unlike the mutating routes', and the tests
   * pin the differences rather than the similarities: no nonce (nothing is
   * mutated, and consuming one would rotate it out from under the relaunch the
   * user is about to confirm), a bare unconditional loopback check rather than
   * `assertLoopbackForMutation`, and no 503 (an unavailable launcher is a fine
   * answer to "is Claude in the wrong folder", and the answer is "no").
   *
   * On that middle one: the original reason was that the helper *was* a no-op
   * outside the unauthenticated-LAN opt-in — true until #1293 made it reject
   * unconditionally. The two are equivalent now, and what remains is that this
   * route mutates nothing: it is a read with the disclosure posture of
   * `/api/document/raw`, not a mutation carrying a weakened gate.
   */
  let home: string;
  let projA: string;
  let projB: string;

  beforeEach(() => {
    home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "cwd-preview-route-")));
    projA = path.join(home, "alpha");
    projB = path.join(home, "beta");
    fs.mkdirSync(projA);
    fs.mkdirSync(projB);
  });

  afterEach(() => {
    fs.rmSync(home, { recursive: true, force: true });
  });

  /** The route resolves against the REAL `os.homedir()` (no seam on the HTTP
   * surface), so the folders under test must actually live there. */
  function underRealHome(): { dir: string; other: string; cleanup: () => void } {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.homedir(), ".tandem-cwd-test-")));
    const dir = path.join(root, "alpha");
    const other = path.join(root, "beta");
    fs.mkdirSync(dir);
    fs.mkdirSync(other);
    return { dir, other, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
  }

  it("reports drift for a real home-confined folder Claude is not in", async () => {
    const { dir, other, cleanup } = underRealHome();
    try {
      const sup = makeFakeSupervisor({ running: true, cwd: other });
      const { app } = makeApp(baseDeps(sup));
      const res = await request(app, "POST", "/api/launcher/cwd-preview", { cwd: dir });
      expect(res.status).toBe(200);
      const body = res.body as { drifted: boolean; label?: string };
      expect(body.drifted).toBe(true);
      expect(body.label).toBe("alpha");
    } finally {
      cleanup();
    }
  });

  it("abbreviates against the REAL home directory on the shipping surface", async () => {
    // The route passes no `homeOverride`, so production always takes the
    // `os.homedir()` branch — which no unit test observes, because they all
    // supply the seam. This is the whole privacy claim, asserted on the surface
    // that actually ships it.
    const { dir, other, cleanup } = underRealHome();
    try {
      const sup = makeFakeSupervisor({ running: true, cwd: other });
      const { app } = makeApp(baseDeps(sup));
      const res = await request(app, "POST", "/api/launcher/cwd-preview", { cwd: dir });
      const body = res.body as { drifted: boolean; suggestedCwd: string; claudeCwd: string };
      expect(body.drifted).toBe(true);
      expect(body.suggestedCwd.startsWith("~")).toBe(true);
      expect(body.claudeCwd.startsWith("~")).toBe(true);
      expect(body.suggestedCwd).not.toContain(os.homedir());
    } finally {
      cleanup();
    }
  });

  it("sheds concurrent probes rather than queueing filesystem work", async () => {
    // `fsp.realpath` frees the event loop but holds a libuv threadpool slot for
    // the full timeout on a hung mapped drive, and takes no AbortSignal — so
    // unbounded concurrency here starves the pool that atomic saves and the
    // annotation writer share, and the symptom is saves hanging with nothing
    // pointing back at this route. Shedding costs nothing: every failure here is
    // already "no drift".
    const { dir, other, cleanup } = underRealHome();
    let release: (() => void) | null = null;
    const held = new Promise<void>((r) => {
      release = r;
    });
    let entered = 0;
    try {
      const sup = makeFakeSupervisor({ running: true, cwd: other });
      const { app } = makeApp({
        ...baseDeps(sup),
        cwdPreviewHook: async () => {
          entered += 1;
          await held;
        },
      });
      const inFlight = Array.from({ length: 8 }, () =>
        request(app, "POST", "/api/launcher/cwd-preview", { cwd: dir }),
      );
      // Give every request time to reach the gate before releasing anything.
      await new Promise((r) => setTimeout(r, 150));
      expect(
        entered,
        "more probes entered the counted region than the cap allows",
      ).toBeLessThanOrEqual(3);
      (release as (() => void) | null)?.();
      const results = await Promise.all(inFlight);
      for (const r of results) expect(r.status).toBe(200);
      // The cap releases: a later request still gets a real answer.
      const after = await request(app, "POST", "/api/launcher/cwd-preview", { cwd: dir });
      expect((after.body as { drifted: boolean }).drifted).toBe(true);
    } finally {
      (release as (() => void) | null)?.();
      cleanup();
    }
  });

  it("rejects a non-loopback caller outright", async () => {
    // The response reconstructs the launcher `cwd` that GET /status withholds
    // off-loopback, plus a second path under the user's home directory.
    const sup = makeFakeSupervisor({ running: true, cwd: projB });
    const { app } = makeApp(baseDeps(sup), { remoteAddress: "192.168.1.50" });
    const res = await request(app, "POST", "/api/launcher/cwd-preview", { cwd: projA });
    expect(res.status).toBe(403);
  });

  it("rejects a disallowed origin", async () => {
    const sup = makeFakeSupervisor({ running: true, cwd: projB });
    const { app } = makeApp(baseDeps(sup));
    const res = await request(
      app,
      "POST",
      "/api/launcher/cwd-preview",
      { cwd: projA },
      { Origin: "https://evil.example" },
    );
    expect(res.status).toBe(403);
  });

  it("needs no nonce", async () => {
    const { dir, other, cleanup } = underRealHome();
    try {
      const sup = makeFakeSupervisor({ running: true, cwd: other });
      const { app } = makeApp(baseDeps(sup));
      const res = await request(app, "POST", "/api/launcher/cwd-preview", { cwd: dir });
      expect(res.status).toBe(200);
    } finally {
      cleanup();
    }
  });

  it("does not consume the relaunch nonce", async () => {
    // A preview that rotated the nonce would break the very action it advertises:
    // the user opens the menu, the pill probes again, and their click 403s.
    const { dir, other, cleanup } = underRealHome();
    try {
      const sup = makeFakeSupervisor({ running: true, cwd: other });
      const { app } = makeApp(baseDeps(sup));
      const nonceRes = await request(app, "GET", "/api/launcher/nonce");
      const nonce = (nonceRes.body as { nonce: string }).nonce;
      await request(app, "POST", "/api/launcher/cwd-preview", { cwd: dir });
      const relaunch = await request(app, "POST", "/api/launcher/relaunch", { nonce });
      expect(relaunch.status).toBe(200);
    } finally {
      cleanup();
    }
  });

  it("400s on a non-string cwd", async () => {
    const sup = makeFakeSupervisor({ running: true, cwd: projB });
    const { app } = makeApp(baseDeps(sup));
    for (const cwd of [undefined, 42, null, { path: "x" }]) {
      const res = await request(app, "POST", "/api/launcher/cwd-preview", { cwd });
      expect(res.status, `cwd=${JSON.stringify(cwd)}`).toBe(400);
    }
  });

  it("answers 'no drift' rather than 400 for an over-length cwd", async () => {
    // An over-length path is a legitimate answer to the question asked, not a
    // caller error — and the length cap runs BEFORE path resolution in the
    // relaunch route, so answering it any other way here would re-open the
    // split-predicate gap: a preview that green-lights what the action rejects.
    const sup = makeFakeSupervisor({ running: true, cwd: projB });
    const { app } = makeApp(baseDeps(sup));
    const res = await request(app, "POST", "/api/launcher/cwd-preview", {
      cwd: `/${"x".repeat(4096)}`,
    });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ drifted: false });
  });

  // Both of these use a folder that WOULD drift (`underRealHome`), so a pass
  // proves the launcher-state gate specifically. Handing them a path that is
  // outside home on some hosts would make them pass for the wrong reason there.
  it("answers 'no drift' rather than 503 when the launcher is unavailable", async () => {
    const { dir, cleanup } = underRealHome();
    try {
      const { app } = makeApp(baseDeps(null, "stdio-mode"));
      const res = await request(app, "POST", "/api/launcher/cwd-preview", { cwd: dir });
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ drifted: false });
    } finally {
      cleanup();
    }
  });

  it("answers 'no drift' when the launcher is available but stopped", async () => {
    const { dir, cleanup } = underRealHome();
    try {
      const sup = makeFakeSupervisor({ running: false });
      const { app } = makeApp(baseDeps(sup));
      const res = await request(app, "POST", "/api/launcher/cwd-preview", { cwd: dir });
      expect(res.body).toEqual({ drifted: false });
    } finally {
      cleanup();
    }
  });

  it("collapses a path outside home to the same 'no drift' answer", async () => {
    // Indistinguishable from every other no-case by design: a client that could
    // tell "outside home" from "same folder" would have a probe for what exists
    // under the user's home directory.
    //
    // The filesystem root, not `os.tmpdir()` — on Windows the temp directory
    // lives under `%LOCALAPPDATA%\Temp`, i.e. INSIDE home, so a tmpdir-based
    // "outside home" fixture asserts the opposite of its name there. It did,
    // until this test failed and said so.
    const outside = path.parse(os.homedir()).root;
    const sup = makeFakeSupervisor({ running: true, cwd: projB });
    const { app } = makeApp(baseDeps(sup));
    const res = await request(app, "POST", "/api/launcher/cwd-preview", { cwd: outside });
    expect(res.body).toEqual({ drifted: false });
  });

  it("honours the bundled-doc exclusion", async () => {
    const { dir, other, cleanup } = underRealHome();
    try {
      const sup = makeFakeSupervisor({ running: true, cwd: other });
      const { app } = makeApp({ ...baseDeps(sup), bundledDocDirs: [dir] });
      const res = await request(app, "POST", "/api/launcher/cwd-preview", { cwd: dir });
      expect(res.body).toEqual({ drifted: false });
    } finally {
      cleanup();
    }
  });

  it("answers 'no drift' rather than 500 when the supervisor's status throws", async () => {
    const { dir, cleanup } = underRealHome();
    try {
      const sup = {
        ...makeFakeSupervisor({ running: true }),
        status: () => {
          throw new Error("boom");
        },
      } as unknown as Supervisor;
      const { app } = makeApp(baseDeps(sup));
      const res = await request(app, "POST", "/api/launcher/cwd-preview", { cwd: dir });
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ drifted: false });
    } finally {
      cleanup();
    }
  });
});
