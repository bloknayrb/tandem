import { EventEmitter } from "node:events";
import { createServer } from "node:http";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { launchStandalone, waitForBackendReady } from "../../scripts/dev-standalone.mjs";

function createDeferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function makeFakeChild(command: string, args: string[]) {
  const child = new EventEmitter() as EventEmitter & {
    command: string;
    args: string[];
    env?: NodeJS.ProcessEnv;
    cwd?: string;
    killed?: boolean;
    exitCode: number | null;
    signalCode: NodeJS.Signals | null;
    kill: () => void;
    stdout: PassThrough;
    stderr: PassThrough;
  };

  child.command = command;
  child.args = args;
  child.exitCode = null;
  child.signalCode = null;
  child.killed = false;
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = () => {
    child.killed = true;
    child.exitCode = 0;
    child.emit("exit", 0, null);
  };
  return child;
}

describe("dev standalone runner", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("waits for /health and /api/events before starting the monitor", async () => {
    let healthHits = 0;
    const server = createServer((req, res) => {
      if (!req.url) {
        res.writeHead(404).end();
        return;
      }

      if (req.url === "/health") {
        healthHits++;
        if (healthHits < 2) {
          res
            .writeHead(503, { "Content-Type": "application/json" })
            .end(JSON.stringify({ status: "starting" }));
          return;
        }
        res
          .writeHead(200, { "Content-Type": "application/json" })
          .end(JSON.stringify({ status: "ok" }));
        return;
      }

      if (req.url === "/api/events") {
        res.writeHead(200, { "Content-Type": "text/event-stream" }).end();
        return;
      }

      res.writeHead(404).end();
    });

    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("Failed to bind test server");
    }

    await expect(
      waitForBackendReady(`http://127.0.0.1:${address.port}`, { timeoutMs: 2_000 }),
    ).resolves.toBeUndefined();

    await new Promise<void>((resolve) => server.close(() => resolve()));
    expect(healthHits).toBeGreaterThanOrEqual(2);
  });

  it("times out when the backend never becomes ready", async () => {
    await expect(waitForBackendReady("http://127.0.0.1:59999", { timeoutMs: 300 })).rejects.toThrow(
      /Timed out waiting for Tandem backend/,
    );
  });

  it("does not start the monitor until the backend probe resolves", async () => {
    const spawnCalls: Array<{ command: string; args: string[]; env?: NodeJS.ProcessEnv }> = [];
    const ready = createDeferred<void>();
    const fakeSpawn = (
      command: string,
      args: string[],
      options: { env?: NodeJS.ProcessEnv } = {},
    ) => {
      spawnCalls.push({ command, args, env: options.env });
      return makeFakeChild(command, args);
    };

    const launchPromise = launchStandalone({
      env: { TANDEM_URL: "http://127.0.0.1:3479" },
      spawnImpl: fakeSpawn,
      waitForBackendReadyImpl: () => ready.promise,
      timeoutMs: 2_000,
    });

    await Promise.resolve();
    expect(spawnCalls).toHaveLength(2);
    expect(spawnCalls[0]?.command).toMatch(/^vite(\.cmd)?$/);
    expect(spawnCalls[1]?.command).toMatch(/^tsx(\.cmd)?$/);
    expect(spawnCalls[1]?.args).toEqual(["watch", "src/server/index.ts"]);

    ready.resolve();
    const runtime = await launchPromise;
    expect(spawnCalls).toHaveLength(3);
    expect(spawnCalls[2]?.command).toMatch(/^tsx(\.cmd)?$/);
    expect(spawnCalls[2]?.args).toEqual(["src/monitor/index.ts"]);
    expect(runtime.monitor).toBeDefined();
  });
});
