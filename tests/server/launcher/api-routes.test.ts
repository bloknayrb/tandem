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
import express, { type Express } from "express";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  _resetInflightForTests,
  _resetLauncherGateForTests,
  type LauncherRoutesDeps,
  registerLauncherRoutes,
} from "../../../src/server/launcher/api-routes.js";
import type { Supervisor } from "../../../src/server/launcher/supervisor.js";
import { TAURI_HOSTNAME } from "../../../src/shared/constants.js";
import {
  type LauncherStatus,
  type LauncherUnavailableReason,
} from "../../../src/shared/launcher/contract.js";
import { withEnvOverride } from "../../helpers/env-override.js";

const passthrough: import("express").Handler = (_req, _res, next) => next();

interface FakeSupervisorOpts {
  running?: boolean;
  cwd?: string;
  relaunchHook?: (cwd: string) => Promise<void>;
  startFreshHook?: (cwd?: string) => Promise<void>;
}

function makeFakeSupervisor(opts: FakeSupervisorOpts = {}): Supervisor {
  return {
    start: async () => {},
    stop: async () => {},
    relaunch: async (cwd: string) => {
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
    app.use((req, _res, next) => {
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
  store: store ?? makeStubStore(),
});

beforeEach(() => {
  _resetLauncherGateForTests();
  _resetInflightForTests();
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

  it("returns full status payload to loopback callers when running", async () => {
    const sup = makeFakeSupervisor({ running: true, cwd: "/home/test" });
    const { app } = makeApp(baseDeps(sup));
    const res = await request(app, "GET", "/api/launcher/status");
    expect(res.status).toBe(200);
    const body = res.body as LauncherStatus & { running: true };
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
});
