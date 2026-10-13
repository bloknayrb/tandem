import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { createServer, type Server, type ServerResponse } from "node:http";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { licenseRefusalError, withoutReconnectHint } from "../../src/cli/mcp-stdio.js";
import { AI_REFUSAL_RECONNECT_HINT } from "../../src/shared/license-copy.js";

/**
 * The stdio bridge under a licence refusal (#1521) — relay, never
 * synthesize, and heal.
 *
 * The fake upstream refuses the way the real server does: a refused POST
 * answers HTTP 200 with a JSON-RPC error whose `data.error` is
 * `LICENSE_REQUIRED` and closes the session; a refused GET answers 403. The
 * bridge must relay the server's own error to the client — never "session
 * lost" or "upstream unreachable" — latch it while refused, retry on a fixed
 * cadence (shortened here via the `TANDEM_LICENSE_RETRY_MS` test seam), adopt
 * the session once admitted, and drop the latch if the upstream goes away.
 */

const cliEntry = resolve(__dirname, "../../src/cli/index.ts");

const LICENSE_ERROR = {
  code: -32003,
  message: "Tandem is unlicensed, so its AI features are turned off.",
  data: { error: "LICENSE_REQUIRED", kind: "unlicensed" },
};
const LICENSE_ERROR_ON_INIT = {
  ...LICENSE_ERROR,
  message: `${LICENSE_ERROR.message} ${AI_REFUSAL_RECONNECT_HINT}`,
};

interface FakeUpstream {
  port: number;
  setRefused(refused: boolean): void;
  /** Hold every refused `initialize` this long before answering it. */
  setRefusedInitDelay(ms: number): void;
  initCount(): number;
  /** Methods of every POST the fake received, in order. */
  methods(): string[];
  close(): Promise<void>;
}

let child: ChildProcessWithoutNullStreams | undefined;
let upstream: FakeUpstream | undefined;

afterEach(async () => {
  child?.kill();
  child = undefined;
  await upstream?.close();
  upstream = undefined;
});

async function makeUpstream(initiallyRefused: boolean): Promise<FakeUpstream> {
  let refused = initiallyRefused;
  let live: string | undefined;
  let minted = 0;
  let inits = 0;
  let refusedInitDelayMs = 0;
  const methods: string[] = [];
  const streams = new Set<ServerResponse>();

  const server: Server = createServer((req, res) => {
    if (req.method === "GET" && req.url === "/health") {
      res.writeHead(200);
      res.end("ok");
      return;
    }
    if (req.method === "GET" && req.url === "/mcp") {
      if (refused) {
        res.writeHead(403, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "LICENSE_REQUIRED", kind: "unlicensed" }));
        return;
      }
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.write(":open\n\n");
      streams.add(res);
      res.on("close", () => streams.delete(res));
      return;
    }
    if (req.method === "DELETE") {
      res.writeHead(200);
      res.end();
      return;
    }
    if (req.method === "POST" && req.url === "/mcp") {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
          id?: string | number;
          method?: string;
        };
        if (body.method === "initialize") inits += 1;
        methods.push(String(body.method));
        if (refused) {
          // The real server's shape: closes any session, ends its stream.
          live = undefined;
          for (const s of streams) s.end();
          if (body.id === undefined) {
            res.writeHead(202);
            res.end();
            return;
          }
          const answer = () => {
            res.writeHead(200, { "Content-Type": "application/json" });
            // As the real server: a refused `initialize` carries the reconnect hint.
            const error = body.method === "initialize" ? LICENSE_ERROR_ON_INIT : LICENSE_ERROR;
            res.end(JSON.stringify({ jsonrpc: "2.0", id: body.id, error }));
          };
          if (body.method === "initialize" && refusedInitDelayMs > 0) {
            setTimeout(answer, refusedInitDelayMs);
          } else {
            answer();
          }
          return;
        }
        if (body.method === "initialize") {
          minted += 1;
          live = `sess-${minted}`;
          res.writeHead(200, { "Content-Type": "application/json", "mcp-session-id": live });
          res.end(
            JSON.stringify({
              jsonrpc: "2.0",
              id: body.id,
              result: {
                protocolVersion: "2024-11-05",
                capabilities: { tools: {} },
                serverInfo: { name: "tandem", version: "0.0.0-test" },
              },
            }),
          );
          return;
        }
        // No session at all is "not found" too, exactly as the real server
        // answers a request that carries no (or a closed) session id.
        if (live === undefined || req.headers["mcp-session-id"] !== live) {
          res.writeHead(404, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({
              jsonrpc: "2.0",
              id: body.id ?? null,
              error: { code: -32001, message: "Session not found" },
            }),
          );
          return;
        }
        if (body.id === undefined) {
          res.writeHead(202);
          res.end();
          return;
        }
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ jsonrpc: "2.0", id: body.id, result: { echo: body.method } }));
      });
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const addr = server.address();
  if (!addr || typeof addr === "string") throw new Error("address");
  return {
    port: addr.port,
    setRefused: (r) => {
      refused = r;
    },
    setRefusedInitDelay: (ms) => {
      refusedInitDelayMs = ms;
    },
    initCount: () => inits,
    methods: () => [...methods],
    close: async () => {
      for (const s of streams) s.destroy();
      server.closeAllConnections?.();
      await new Promise<void>((r) => server.close(() => r()));
    },
  };
}

function spawnBridge(port: number): ChildProcessWithoutNullStreams {
  return spawn(process.execPath, ["--import", "tsx", cliEntry, "mcp-stdio"], {
    env: {
      ...process.env,
      TANDEM_URL: `http://127.0.0.1:${port}`,
      // The floor (1 s): anything lower is clamped, so the seam cannot spin.
      TANDEM_LICENSE_RETRY_MS: "1000",
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
}

function collect(c: ChildProcessWithoutNullStreams) {
  let out = "";
  let err = "";
  c.stdout.on("data", (b: Buffer) => {
    out += b.toString("utf8");
  });
  c.stderr.on("data", (b: Buffer) => {
    err += b.toString("utf8");
  });
  const lines = () =>
    out
      .split("\n")
      .filter((l) => l.trim())
      .map((l) => JSON.parse(l) as Record<string, unknown>);
  return {
    stderr: () => err,
    responseFor: (id: string | number) => lines().find((m) => m.id === id),
  };
}

async function waitFor(predicate: () => boolean, what: string, timeoutMs = 20_000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`timed out after ${timeoutMs}ms waiting for ${what}`);
}

const INITIALIZE = {
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: {
    protocolVersion: "2024-11-05",
    clientInfo: { name: "test-harness", version: "0.0.0" },
    capabilities: {},
  },
};

const send = (c: ChildProcessWithoutNullStreams, msg: unknown) =>
  c.stdin.write(`${JSON.stringify(msg)}\n`);

/** Admitted handshake with a live standalone SSE stream. */
async function handshake(c: ChildProcessWithoutNullStreams, io: ReturnType<typeof collect>) {
  await new Promise((r) => setTimeout(r, 700));
  send(c, INITIALIZE);
  await waitFor(() => io.responseFor(1) !== undefined, "initialize response");
  send(c, { jsonrpc: "2.0", method: "notifications/initialized" });
  await new Promise((r) => setTimeout(r, 300));
}

function errorOf(msg: Record<string, unknown> | undefined) {
  return msg?.error as { code?: number; message?: string; data?: { error?: string } } | undefined;
}

describe("licenseRefusalError", () => {
  it("recognises the wire payload, and nothing else", () => {
    expect(licenseRefusalError({ jsonrpc: "2.0", id: 1, error: LICENSE_ERROR } as never)).toEqual(
      LICENSE_ERROR,
    );
    expect(
      licenseRefusalError({
        jsonrpc: "2.0",
        id: 1,
        error: { code: -32000, message: "x", data: { detail: "y" } },
      } as never),
    ).toBeUndefined();
    expect(licenseRefusalError({ jsonrpc: "2.0", id: 1, result: {} } as never)).toBeUndefined();
  });
});

describe("withoutReconnectHint", () => {
  it("strips only a trailing hint", () => {
    expect(withoutReconnectHint(LICENSE_ERROR_ON_INIT)).toEqual(LICENSE_ERROR);
    expect(withoutReconnectHint(LICENSE_ERROR)).toBe(LICENSE_ERROR);
  });
});

describe("mcp-stdio under a licence refusal (#1521)", () => {
  it("relays a refused first initialize verbatim", async () => {
    upstream = await makeUpstream(true);
    child = spawnBridge(upstream.port);
    const io = collect(child);
    await new Promise((r) => setTimeout(r, 700));
    send(child, INITIALIZE);
    await waitFor(() => io.responseFor(1) !== undefined, "initialize response");
    // The host's own `initialize`: the reconnect hint is right advice here.
    expect(errorOf(io.responseFor(1))).toEqual(LICENSE_ERROR_ON_INIT);
    expect(io.stderr()).toMatch(/initialize refused by Tandem's license check/);
  }, 30_000);

  it("mid-session: latches the server's refusal, answers with it, and heals on activation", async () => {
    upstream = await makeUpstream(false);
    child = spawnBridge(upstream.port);
    const io = collect(child);
    await handshake(child, io);
    const fake = upstream;

    // Expire: the next call is refused and relayed verbatim; the session and
    // its stream are cut, the GET reconnect meets 403, and the replay is refused.
    fake.setRefused(true);
    send(child, { jsonrpc: "2.0", id: 2, method: "tools/list" });
    await waitFor(() => io.responseFor(2) !== undefined, "the refused call");
    expect(errorOf(io.responseFor(2))?.data?.error).toBe("LICENSE_REQUIRED");
    await waitFor(() => /upstream refused the session/.test(io.stderr()), "the latch");

    // Latched: a new request is answered locally with the server's own error,
    // minus the reconnect hint the replayed `initialize` drew: the host's
    // session never failed, and the latch heals by itself.
    send(child, { jsonrpc: "2.0", id: 3, method: "tools/list" });
    await waitFor(() => io.responseFor(3) !== undefined, "the latched answer");
    expect(errorOf(io.responseFor(3))).toEqual(LICENSE_ERROR);
    // Never the bridge's own outage copy, to the client or in the failure log.
    expect(errorOf(io.responseFor(3))?.message).not.toMatch(/session lost|unreachable/);
    expect(io.stderr()).not.toMatch(/re-initialize failed/);

    // Activation: the next retry is admitted and traffic flows again.
    fake.setRefused(false);
    await waitFor(() => /admitted the session again/.test(io.stderr()), "the heal");
    send(child, { jsonrpc: "2.0", id: 4, method: "tools/list" });
    await waitFor(() => io.responseFor(4) !== undefined, "a healed call");
    expect(errorOf(io.responseFor(4))).toBeUndefined();
    expect((io.responseFor(4)?.result as { echo?: string })?.echo).toBe("tools/list");
    expect(child.exitCode).toBeNull();
  }, 60_000);

  it("drops the latch when the upstream goes away, rather than answering with stale licence copy", async () => {
    upstream = await makeUpstream(false);
    child = spawnBridge(upstream.port);
    const io = collect(child);
    await handshake(child, io);

    upstream.setRefused(true);
    send(child, { jsonrpc: "2.0", id: 2, method: "tools/list" });
    await waitFor(() => /upstream refused the session/.test(io.stderr()), "the latch");

    await upstream.close();
    upstream = undefined;
    await waitFor(() => /licence refusal cleared/.test(io.stderr()), "the latch to clear");

    send(child, { jsonrpc: "2.0", id: 5, method: "tools/list" });
    await waitFor(() => io.responseFor(5) !== undefined, "an answer", 40_000);
    expect(errorOf(io.responseFor(5))?.data?.error).not.toBe("LICENSE_REQUIRED");
    expect(child.exitCode).toBeNull();
  }, 60_000);

  it("a refused FIRST initialize is not a dead end: once admitted, the next request heals", async () => {
    upstream = await makeUpstream(true);
    child = spawnBridge(upstream.port);
    const io = collect(child);
    await new Promise((r) => setTimeout(r, 700));
    send(child, INITIALIZE);
    await waitFor(() => io.responseFor(1) !== undefined, "the refused initialize");
    expect(errorOf(io.responseFor(1))).toEqual(LICENSE_ERROR);

    upstream.setRefused(false);
    send(child, { jsonrpc: "2.0", id: 2, method: "tools/list" });
    await waitFor(() => io.responseFor(2) !== undefined, "the healed request");
    expect(errorOf(io.responseFor(2))).toBeUndefined();
    expect((io.responseFor(2)?.result as { echo?: string })?.echo).toBe("tools/list");
    // The #1805 shape: the admitted replay SEEDED the baseline rather than
    // refusing to adopt a server it never had a baseline for.
    expect(io.stderr()).toMatch(/deferred handshake completed/);
    expect(io.stderr()).not.toMatch(/no handshake baseline/);
  }, 60_000);

  it("a request queued while the refused replay is in flight gets the licence error, not 'session lost'", async () => {
    upstream = await makeUpstream(false);
    child = spawnBridge(upstream.port);
    const io = collect(child);
    await handshake(child, io);
    const fake = upstream;

    fake.setRefusedInitDelay(1_500);
    fake.setRefused(true);
    send(child, { jsonrpc: "2.0", id: 2, method: "tools/list" });
    await waitFor(() => io.responseFor(2) !== undefined, "the refused call");
    // The replay `initialize` is now held by the fake; the bridge is mid-reconnect.
    const initsBefore = fake.initCount();
    await waitFor(() => fake.initCount() > initsBefore, "the held replay");
    send(child, { jsonrpc: "2.0", id: 3, method: "tools/list" });

    await waitFor(() => io.responseFor(3) !== undefined, "the queued request's answer");
    expect(errorOf(io.responseFor(3))).toEqual(LICENSE_ERROR);
    expect(io.stderr()).not.toMatch(/re-initialize failed/);
  }, 60_000);

  it("while latched: a notification is dropped, and retries neither count nor announce", async () => {
    upstream = await makeUpstream(false);
    child = spawnBridge(upstream.port);
    const io = collect(child);
    await handshake(child, io);

    upstream.setRefused(true);
    send(child, { jsonrpc: "2.0", id: 2, method: "tools/list" });
    await waitFor(() => /upstream refused the session/.test(io.stderr()), "the latch");
    const announcedAtLatch = (io.stderr().match(/re-initializing upstream session/g) ?? []).length;

    send(child, { jsonrpc: "2.0", method: "notifications/latched-probe" });
    // Several 1 s retries pass while latched.
    await new Promise((r) => setTimeout(r, 3_500));
    expect(upstream.methods()).not.toContain("notifications/latched-probe");
    expect((io.stderr().match(/re-initializing upstream session/g) ?? []).length).toBe(
      announcedAtLatch,
    );
    expect((io.stderr().match(/upstream refused the session/g) ?? []).length).toBe(1);
  }, 60_000);
});
