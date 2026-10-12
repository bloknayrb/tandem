/**
 * The launcher's licence contract (#1521).
 *
 * An unlicensed Tandem does not spawn Claude Code: at boot, on the deferred
 * start, on a crash-respawn, or on a relaunch / start-fresh. The two refusal
 * shapes are deliberate and both are pinned here:
 *  - `startInternal` (boot, deferred start, crash-respawn) refuses by RETURNING
 *    and records `lastError: "unlicensed"` — a throw would be renamed
 *    `spawn-failed` by its callers;
 *  - `respawn` (relaunch, start-fresh) refuses by THROWING
 *    `LicenseRefusedError` BEFORE stopping anything, and never overwrites a
 *    running child's clean status or a breaker diagnosis.
 * `resumeAfterLicence` is the one way back, and it can neither stop nor
 * double-spawn anything.
 *
 * The licence decision is injected (`aiRefusal` option), so this suite runs on
 * the dark vitest build; the real decision's armed behaviour is
 * `tests/server/license-armed-restricted.test.ts`.
 */
import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import express, { type Express } from "express";
import { afterEach, beforeEach, describe, expect, it, type MockInstance, vi } from "vitest";

vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:child_process")>()),
  spawn: vi.fn(),
}));

import { spawn } from "node:child_process";
import type { IntegrationsFile } from "../../../src/server/integrations/schema.js";
import { createIntegrationsStore } from "../../../src/server/integrations/storage.js";
import {
  _resetInflightForTests,
  _resetLauncherGateForTests,
  registerLauncherRoutes,
} from "../../../src/server/launcher/api-routes.js";
import {
  createSupervisor,
  LicenseRefusedError,
  type Supervisor,
} from "../../../src/server/launcher/supervisor.js";
import type { AiRefusal } from "../../../src/server/license/ai-refusal.js";
import { TAURI_HOSTNAME } from "../../../src/shared/constants.js";
import { LAUNCHER_ERROR_UNLICENSED } from "../../../src/shared/launcher/contract.js";
import { LICENSE_REQUIRED } from "../../../src/shared/license-copy.js";

class FakeChild extends EventEmitter {
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  killed = false;
  kills: string[] = [];
  readonly stdin = Object.assign(new EventEmitter(), {
    writable: true,
    write: (_d: string, cb?: (err?: Error | null) => void) => {
      cb?.();
      return true;
    },
  });
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  constructor(readonly pid: number) {
    super();
  }
  kill(sig: NodeJS.Signals = "SIGTERM"): boolean {
    this.kills.push(sig);
    this.killed = true;
    setImmediate(() => {
      if (this.exitCode !== null || this.signalCode !== null) return;
      this.signalCode = sig;
      this.emit("exit", null, sig);
    });
    return true;
  }
}

const REFUSAL: AiRefusal = {
  error: "LICENSE_REQUIRED",
  kind: "unlicensed",
  message: "Tandem is unlicensed, so its AI features are turned off.",
};

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
async function waitFor(probe: () => boolean, label: string, ms = 3_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!probe()) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${label}`);
    await sleep(5);
  }
}

const ENV_KEYS = ["TANDEM_REAPER_PATH", "TANDEM_TAURI_SIDECAR", "NODE_ENV"] as const;
const savedEnv: Record<string, string | undefined> = {};
let baseDir: string;
let cwdDir: string;
let children: FakeChild[];
let sups: Supervisor[];
let errSpy: MockInstance<typeof console.error>;
/** The injected licence decision; flip it to refuse or admit. */
let refused: boolean;

beforeEach(async () => {
  for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
  process.env.NODE_ENV = "test";
  delete process.env.TANDEM_TAURI_SIDECAR;
  process.env.TANDEM_REAPER_PATH = process.execPath;
  baseDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "tandem-")));
  cwdDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "tandem-")));
  children = [];
  sups = [];
  refused = false;
  let pid = 50_000;
  vi.mocked(spawn).mockClear();
  vi.mocked(spawn).mockImplementation(() => {
    const child = new FakeChild(pid++);
    children.push(child);
    setImmediate(() => child.emit("spawn"));
    return child as unknown as ChildProcess;
  });
  errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  const file: IntegrationsFile = {
    schemaVersion: 3,
    integrations: [
      {
        kind: "claude-code",
        id: "active",
        label: "Active Claude",
        // A throwaway path: the supervisor never reads it, it only has to validate.
        configPath: path.join(baseDir, "claude-config.json"),
        transport: "http",
        url: "http://127.0.0.1:3479/mcp",
        apply: "create",
        workingDirectory: cwdDir,
      },
    ],
  };
  await createIntegrationsStore(baseDir).write(file);
});

afterEach(async () => {
  refused = false;
  for (const sup of sups) await sup.stop();
  errSpy.mockRestore();
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  for (const dir of [baseDir, cwdDir]) {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

function makeSupervisor(): Supervisor {
  const sup = createSupervisor({
    integrationsBase: baseDir,
    probeCliUsable: () => true,
    restartBackoffsMs: [0],
    // Both fan-out seams faked: the defaults subscribe to the REAL queue, and
    // a supervisor left armed would leak a subscription into the next test.
    subscribeToEvents: () => () => {},
    subscribeDuringGap: () => () => {},
    aiRefusal: () => (refused ? REFUSAL : null),
  });
  sups.push(sup);
  return sup;
}

describe("supervisor licence refusal (#1521)", () => {
  it("a refused boot spawns nothing and records `unlicensed`, not `spawn-failed`", async () => {
    refused = true;
    const sup = makeSupervisor();
    await sup.start();
    expect(children).toHaveLength(0);
    expect(sup.status()).toEqual({ running: false, lastError: "unlicensed" });
    expect(sup.licenceRefusal()).toEqual(REFUSAL);
  });

  it("an admitted boot spawns (positive twin)", async () => {
    const sup = makeSupervisor();
    await sup.start();
    expect(children).toHaveLength(1);
    expect(sup.status().running).toBe(true);
    expect(sup.licenceRefusal()).toBeNull();
  });

  it("a refused crash-respawn records `unlicensed` and schedules nothing further", async () => {
    const sup = makeSupervisor();
    await sup.start();
    refused = true;
    const first = children[0];
    first.exitCode = 1;
    first.emit("exit", 1, null);
    await waitFor(() => sup.status().lastError === "unlicensed", "the refused respawn");
    await sleep(50);
    expect(children).toHaveLength(1);
    expect(sup.status()).toEqual({ running: false, lastError: "unlicensed" });
  });

  it("a refused relaunch throws BEFORE stopping a running child, and leaves its status clean", async () => {
    const sup = makeSupervisor();
    await sup.start();
    const running = children[0];
    refused = true;
    await expect(sup.relaunch(cwdDir)).rejects.toBeInstanceOf(LicenseRefusedError);
    expect(running.kills).toEqual([]);
    expect(sup.status().running).toBe(true);
    expect(sup.status().lastError).toBeUndefined();
  });

  it("a refused start-fresh throws too, and records `unlicensed` with no child alive", async () => {
    refused = true;
    const sup = makeSupervisor();
    await expect(sup.startFresh(cwdDir)).rejects.toMatchObject({ kind: "unlicensed" });
    expect(children).toHaveLength(0);
    expect(sup.status()).toEqual({ running: false, lastError: "unlicensed" });
  });

  it("a refused relaunch never overwrites a breaker diagnosis", async () => {
    const sup = makeSupervisor();
    await sup.start();
    // Crash-loop until the breaker trips: crash each child, then wait for
    // either its successor or the trip — never a fixed sleep.
    while (sup.status().lastError !== "circuit-open") {
      const child = children[children.length - 1];
      const spawned = children.length;
      child.exitCode = 1;
      child.emit("exit", 1, null);
      await waitFor(
        () => children.length > spawned || sup.status().lastError === "circuit-open",
        "the next spawn or the trip",
      );
    }
    expect(sup.status()).toEqual({ running: false, lastError: "circuit-open" });
    refused = true;
    await expect(sup.relaunch(cwdDir)).rejects.toBeInstanceOf(LicenseRefusedError);
    expect(sup.status()).toEqual({ running: false, lastError: "circuit-open" });
    // And resume will not undo the breaker.
    refused = false;
    const before = children.length;
    await sup.resumeAfterLicence();
    expect(children).toHaveLength(before);
  });

  it("a refused relaunch never overwrites spawn-failed either", async () => {
    const sup = makeSupervisor();
    await sup.start();
    // A crash whose restart cannot read integrations.json (not a transient
    // errno) stays down with `spawn-failed` — a real diagnosis.
    fs.writeFileSync(
      path.join(baseDir, "integrations.json"),
      JSON.stringify({ schemaVersion: 999, integrations: [] }),
    );
    const first = children[0];
    first.exitCode = 1;
    first.emit("exit", 1, null);
    await waitFor(() => sup.status().lastError === "spawn-failed", "the failed restart");
    refused = true;
    await expect(sup.relaunch(cwdDir)).rejects.toBeInstanceOf(LicenseRefusedError);
    expect(sup.status()).toEqual({ running: false, lastError: "spawn-failed" });
    expect(sup.licenceRefusal()).toBeNull();
  });

  it("resumeAfterLicence spawns exactly once after the licence is activated", async () => {
    refused = true;
    const sup = makeSupervisor();
    await sup.start();
    expect(children).toHaveLength(0);
    refused = false;
    await sup.resumeAfterLicence();
    expect(children).toHaveLength(1);
    expect(sup.status().running).toBe(true);
    // Idempotent: a live child means a no-op, never a stop or a second spawn.
    await sup.resumeAfterLicence();
    expect(children).toHaveLength(1);
    expect(children[0].kills).toEqual([]);
  });

  it("resumeAfterLicence is a no-op when nothing was refused", async () => {
    const sup = makeSupervisor();
    await sup.resumeAfterLicence();
    expect(children).toHaveLength(0);
  });

  it("no resume during shutdown (after the user stop)", async () => {
    refused = true;
    const sup = makeSupervisor();
    await sup.start();
    await sup.stop();
    refused = false;
    await sup.resumeAfterLicence();
    expect(children).toHaveLength(0);
  });
});

describe("launcher routes answer a licence refusal with 403 (#1521)", () => {
  function fakeSupervisor(overrides: Partial<Supervisor>): Supervisor {
    return {
      start: async () => {},
      stop: async () => {},
      relaunch: async () => {},
      startFresh: async () => {},
      resumeAfterLicence: async () => {},
      licenceRefusal: () => null,
      status: () => ({ running: false }),
      ...overrides,
    };
  }

  function makeApp(deps: Parameters<typeof registerLauncherRoutes>[2]): Express {
    const app = express();
    app.use(express.json());
    registerLauncherRoutes(app, (_req, _res, next) => next(), deps);
    return app;
  }

  async function call(
    app: Express,
    method: "GET" | "POST",
    url: string,
    body?: unknown,
  ): Promise<{ status: number; body: Record<string, unknown> }> {
    const server = app.listen(0, "127.0.0.1");
    await new Promise<void>((resolve) => server.once("listening", () => resolve()));
    const address = server.address();
    if (typeof address !== "object" || address === null) throw new Error("no address");
    try {
      const res = await fetch(`http://127.0.0.1:${address.port}${url}`, {
        method,
        headers: {
          Origin: `http://${TAURI_HOSTNAME}`,
          ...(body !== undefined ? { "content-type": "application/json" } : {}),
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
      return { status: res.status, body: (await res.json()) as Record<string, unknown> };
    } finally {
      server.close();
    }
  }

  async function withNonce(app: Express, url: string, body: Record<string, unknown> = {}) {
    const nonce = (await call(app, "GET", "/api/launcher/nonce")).body.nonce;
    return call(app, "POST", url, { ...body, nonce });
  }

  const store = {
    read: async () => ({ schemaVersion: 3, integrations: [] }),
    write: async () => {},
  } as unknown as Parameters<typeof registerLauncherRoutes>[2]["store"];

  beforeEach(() => {
    _resetLauncherGateForTests();
    _resetInflightForTests();
  });

  it.each([
    ["relaunch", "/api/launcher/relaunch"],
    ["startFresh", "/api/launcher/start-fresh"],
  ] as const)(
    "a refused %s answers 403 LAUNCHER_UNLICENSED with the envelope",
    async (method, url) => {
      const sup = fakeSupervisor({
        [method]: async () => {
          throw new LicenseRefusedError(REFUSAL);
        },
      });
      const app = makeApp({
        getSupervisor: () => sup,
        unavailableReason: () => "stdio-mode",
        startSupervisor: async () => {},
        store,
        isClaudeSessionAttached: () => false,
      });
      const res = await withNonce(app, url);
      expect(res.status).toBe(403);
      expect(res.body).toMatchObject({
        error: LICENSE_REQUIRED,
        kind: "unlicensed",
        code: LAUNCHER_ERROR_UNLICENSED,
        message: REFUSAL.message,
      });
    },
  );

  it("the deferred start creates the supervisor, then answers 403 instead of started: true", async () => {
    let sup: Supervisor | null = null;
    const app = makeApp({
      getSupervisor: () => sup,
      unavailableReason: () => "deferred-autostart",
      startSupervisor: async () => {
        sup = fakeSupervisor({
          status: () => ({ running: false, lastError: "unlicensed" }),
          licenceRefusal: () => REFUSAL,
        });
      },
      store,
      isClaudeSessionAttached: () => false,
    });
    const res = await withNonce(app, "/api/launcher/start");
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ error: LICENSE_REQUIRED, code: LAUNCHER_ERROR_UNLICENSED });
    // The supervisor EXISTS — that is what lets activation resume it.
    expect(sup).not.toBeNull();
  });

  it("the deferred start still answers started: true when admitted (positive twin)", async () => {
    let sup: Supervisor | null = null;
    const app = makeApp({
      getSupervisor: () => sup,
      unavailableReason: () => "deferred-autostart",
      startSupervisor: async () => {
        sup = fakeSupervisor({});
      },
      store,
      isClaudeSessionAttached: () => false,
    });
    const res = await withNonce(app, "/api/launcher/start");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, started: true });
  });
});
