import { EventEmitter } from "node:events";
import { createServer } from "node:http";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { launchStandalone, waitForBackendReady } from "../../scripts/dev-standalone.mjs";

type FakeChild = EventEmitter & {
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

// Track every fake child created during a test so afterEach can release them
// without firing the `attachUnexpectedExit` listener (which would call
// process.exit() on the vitest worker).
const trackedFakeChildren: FakeChild[] = [];

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
  const child = new EventEmitter() as FakeChild;

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
  trackedFakeChildren.push(child);
  return child;
}

describe("dev standalone runner", () => {
  afterEach(() => {
    // Tear down every fake child the test created. `launchStandalone` calls
    // `attachUnexpectedExit(child, ...)` which registers a `child.once("exit")`
    // listener whose callback closes over the whole `children` array,
    // `shutdownState`, and `process.exit`. The "does not start the monitor"
    // test never kills its (fake) children, so without explicit teardown those
    // listeners — plus two undestroyed PassThrough streams per child — stay
    // retained in the shared worker after the test ends.
    //
    // This retention contaminated tests/cli/mcp-stdio.test.ts (#724): when that
    // file runs next in the same vitest worker, the leftover handles slowed
    // subprocess startup / event-loop responsiveness enough that its
    // timing-sensitive `tandem mcp-stdio` subprocess assertions flaked
    // ("no stdout within Nms", "expected 0 to be >= 3"). Removing the listeners
    // also neutralizes the `kill()`-emits-"exit" path, which would otherwise
    // let a stray emit call process.exit() on the worker itself.
    for (const child of trackedFakeChildren) {
      child.removeAllListeners();
      child.stdout.removeAllListeners();
      child.stderr.removeAllListeners();
      child.stdout.destroy();
      child.stderr.destroy();
    }
    trackedFakeChildren.length = 0;
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
