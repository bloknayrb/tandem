import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { resolve } from "node:path";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  carriedSessionNotFound,
  describeServerInfo,
  getRequestId,
  getResponseId,
  isReplayId,
  isSseStreamLostError,
  isStaleSessionError,
  makeReplayId,
  nextBackoffMs,
  parseTimeoutMs,
  readAndValidateAuthToken,
} from "../../src/cli/mcp-stdio.js";
import { expectWithinMs } from "../helpers/timing.js";

async function readOneLine(
  child: ChildProcessWithoutNullStreams,
  timeoutMs = 10_000,
): Promise<string> {
  const stdoutChunks: string[] = [];
  const stderrChunks: string[] = [];
  child.stdout.on("data", (c: Buffer) => stdoutChunks.push(c.toString("utf8")));
  child.stderr.on("data", (c: Buffer) => stderrChunks.push(c.toString("utf8")));
  return new Promise<string>((resolveResp, rejectResp) => {
    const checker = setInterval(() => {
      const joined = stdoutChunks.join("");
      const nl = joined.indexOf("\n");
      if (nl >= 0) {
        clearTimeout(timer);
        clearInterval(checker);
        resolveResp(joined.slice(0, nl));
      }
    }, 50);
    const timer = setTimeout(() => {
      clearInterval(checker);
      rejectResp(
        new Error(
          `no stdout within ${timeoutMs}ms. stderr=${stderrChunks.join("")} stdout=${stdoutChunks.join("")}`,
        ),
      );
    }, timeoutMs);
  });
}

/**
 * Polls `counter()` until it returns >= `n` or `timeoutMs` elapses.
 * Throws a descriptive error on timeout so CI output names the bottleneck.
 * Decouples assertions from subprocess startup latency; mirrors the
 * `waitForPosts` helper inside the per-request-timeout describe block.
 */
async function waitForCount(counter: () => number, n: number, timeoutMs = 15_000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (counter() >= n) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`Only ${counter()}/${n} items reached threshold within ${timeoutMs}ms`);
}

/**
 * Read up to `n` newline-delimited JSON-RPC lines from child stdout.
 * Returns as soon as n lines arrive or timeoutMs elapses (in which case
 * it resolves with whatever arrived — callers assert on the count).
 */
async function readLines(
  child: ChildProcessWithoutNullStreams,
  n: number,
  timeoutMs = 10_000,
): Promise<string[]> {
  const stdoutChunks: string[] = [];
  child.stdout.on("data", (c: Buffer) => stdoutChunks.push(c.toString("utf8")));
  return new Promise<string[]>((resolveResp) => {
    const lines: string[] = [];
    let remainder = "";
    const checker = setInterval(() => {
      const joined = remainder + stdoutChunks.join("");
      stdoutChunks.length = 0;
      const parts = joined.split("\n");
      remainder = parts.pop() ?? "";
      for (const part of parts) {
        if (part.trim()) lines.push(part);
      }
      if (lines.length >= n) {
        clearTimeout(timer);
        clearInterval(checker);
        resolveResp(lines);
      }
    }, 50);
    const timer = setTimeout(() => {
      clearInterval(checker);
      resolveResp(lines);
    }, timeoutMs);
  });
}

describe("getRequestId", () => {
  it("returns the id for JSON-RPC requests (has method + id)", () => {
    expect(getRequestId({ jsonrpc: "2.0", id: 1, method: "tools/list" } as never)).toBe(1);
    expect(getRequestId({ jsonrpc: "2.0", id: "abc", method: "tools/call" } as never)).toBe("abc");
  });

  it("returns undefined for JSON-RPC notifications (method, no id)", () => {
    expect(getRequestId({ jsonrpc: "2.0", method: "notifications/foo" } as never)).toBeUndefined();
  });

  it("returns undefined for JSON-RPC responses (id, no method)", () => {
    expect(getRequestId({ jsonrpc: "2.0", id: 1, result: {} } as never)).toBeUndefined();
    expect(
      getRequestId({ jsonrpc: "2.0", id: 1, error: { code: 0, message: "" } } as never),
    ).toBeUndefined();
  });
});

describe("getResponseId", () => {
  it("returns the id for JSON-RPC responses (id, no method)", () => {
    expect(getResponseId({ jsonrpc: "2.0", id: 1, result: {} } as never)).toBe(1);
    expect(
      getResponseId({ jsonrpc: "2.0", id: "abc", error: { code: 0, message: "" } } as never),
    ).toBe("abc");
  });

  it("returns undefined for JSON-RPC requests (has method)", () => {
    expect(getResponseId({ jsonrpc: "2.0", id: 1, method: "tools/list" } as never)).toBeUndefined();
  });

  it("returns undefined for JSON-RPC notifications (has method, no id)", () => {
    expect(getResponseId({ jsonrpc: "2.0", method: "notifications/foo" } as never)).toBeUndefined();
  });
});

describe("mcp-stdio proxy integration", () => {
  let server: Server;
  let port: number;
  let receivedPosts: Array<{
    body: unknown;
    headers: Record<string, string | string[] | undefined>;
  }>;
  let child: ChildProcessWithoutNullStreams | undefined;

  beforeEach(async () => {
    receivedPosts = [];
    server = createServer((req: IncomingMessage, res: ServerResponse) => {
      if (req.method === "GET" && req.url === "/health") {
        res.writeHead(200, { "Content-Type": "text/plain" });
        res.end("ok");
        return;
      }
      if (req.method === "POST" && req.url === "/mcp") {
        const chunks: Buffer[] = [];
        req.on("data", (c: Buffer) => chunks.push(c));
        req.on("end", () => {
          let body: unknown;
          try {
            body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
          } catch {
            body = null;
          }
          receivedPosts.push({ body, headers: req.headers });
          const msg = body as { id?: number | string; method?: string } | null;
          if (msg && typeof msg.method === "string" && "id" in msg) {
            const response = {
              jsonrpc: "2.0",
              id: msg.id,
              result: {
                protocolVersion: "2024-11-05",
                capabilities: { tools: {} },
                serverInfo: { name: "fake-tandem", version: "0.0.0-test" },
              },
            };
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify(response));
          } else {
            // notifications get 202 Accepted, no body
            res.writeHead(202);
            res.end();
          }
        });
        return;
      }
      res.writeHead(404);
      res.end();
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const addr = server.address();
    if (!addr || typeof addr === "string") throw new Error("server.address() unexpected");
    port = addr.port;
  });

  afterEach(async () => {
    child?.kill();
    child = undefined;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("forwards an initialize request to the fake HTTP server and returns the response on stdout", async () => {
    const cliEntry = resolve(__dirname, "../../src/cli/index.ts");
    child = spawn(process.execPath, ["--import", "tsx", cliEntry, "mcp-stdio"], {
      env: { ...process.env, TANDEM_URL: `http://127.0.0.1:${port}` },
      stdio: ["pipe", "pipe", "pipe"],
    });

    const initialize = {
      jsonrpc: "2.0",
      id: 42,
      method: "initialize",
      params: {
        protocolVersion: "2024-11-05",
        clientInfo: { name: "test-harness", version: "0.0.0" },
        capabilities: {},
      },
    };
    // Small delay so the child's stdio transport and http transport both have started
    await new Promise((r) => setTimeout(r, 500));
    child.stdin.write(`${JSON.stringify(initialize)}\n`);

    const response = await readOneLine(child);
    const parsed = JSON.parse(response) as {
      id: number;
      result?: { serverInfo?: { name?: string } };
    };
    expect(parsed.id).toBe(42);
    expect(parsed.result?.serverInfo?.name).toBe("fake-tandem");
    expect(receivedPosts).toHaveLength(1);
    expect((receivedPosts[0]?.body as { method?: string })?.method).toBe("initialize");
  }, 30_000);
});

describe("mcp-stdio error synthesis on upstream unavailability", () => {
  let child: ChildProcessWithoutNullStreams | undefined;

  afterEach(() => {
    child?.kill();
    child = undefined;
  });

  it("forwards a buffered request once upstream becomes ready", async () => {
    // Regression guard for the drain path: a request arriving BEFORE
    // http.start() completes must still be forwarded (not dropped, not
    // synthesized) once httpReady flips. The fake server artificially
    // delays /health so preflight takes ~400ms — long enough that a
    // stdin write immediately after spawn lands in preReadyBuffer.
    const receivedPosts: Array<{ method?: string; id?: unknown }> = [];
    const server = createServer((req, res) => {
      if (req.method === "GET" && req.url === "/health") {
        setTimeout(() => {
          res.writeHead(200, { "Content-Type": "text/plain" });
          res.end("ok");
        }, 400);
        return;
      }
      if (req.method === "POST" && req.url === "/mcp") {
        const chunks: Buffer[] = [];
        req.on("data", (c: Buffer) => chunks.push(c));
        req.on("end", () => {
          const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
          receivedPosts.push(body);
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({
              jsonrpc: "2.0",
              id: body.id,
              result: { protocolVersion: "2024-11-05", capabilities: { tools: {} } },
            }),
          );
        });
        return;
      }
      res.writeHead(404);
      res.end();
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const addr = server.address();
    if (!addr || typeof addr === "string") throw new Error("server.address() unexpected");
    const port = addr.port;

    try {
      const cliEntry = resolve(__dirname, "../../src/cli/index.ts");
      child = spawn(process.execPath, ["--import", "tsx", cliEntry, "mcp-stdio"], {
        env: { ...process.env, TANDEM_URL: `http://127.0.0.1:${port}` },
        stdio: ["pipe", "pipe", "pipe"],
      });

      // Write IMMEDIATELY — no 500ms grace. The request must land in
      // preReadyBuffer and survive the drain once httpReady flips.
      const initialize = {
        jsonrpc: "2.0",
        id: 55,
        method: "initialize",
        params: {
          protocolVersion: "2024-11-05",
          clientInfo: { name: "test-harness", version: "0.0.0" },
          capabilities: {},
        },
      };
      child.stdin.write(`${JSON.stringify(initialize)}\n`);

      const line = await readOneLine(child);
      const parsed = JSON.parse(line) as {
        id: number;
        result?: { capabilities?: Record<string, unknown> };
        error?: { code: number };
      };
      expect(parsed.id).toBe(55);
      // Must be a successful forward, NOT a synthesized -32000.
      expect(parsed.error).toBeUndefined();
      expect(parsed.result?.capabilities).toBeDefined();
      expect(receivedPosts).toHaveLength(1);
      expect(receivedPosts[0]?.method).toBe("initialize");
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  }, 30_000);

  it("synthesizes -32000 for an initialize request when the upstream server is not running", async () => {
    const cliEntry = resolve(__dirname, "../../src/cli/index.ts");
    // Point at a port nothing's listening on. Preflight probe fails, the
    // already-started stdio transport replies -32000 to any incoming request.
    child = spawn(process.execPath, ["--import", "tsx", cliEntry, "mcp-stdio"], {
      env: { ...process.env, TANDEM_URL: "http://127.0.0.1:1" },
      stdio: ["pipe", "pipe", "pipe"],
    });

    const initialize = {
      jsonrpc: "2.0",
      id: 99,
      method: "initialize",
      params: {
        protocolVersion: "2024-11-05",
        clientInfo: { name: "test-harness", version: "0.0.0" },
        capabilities: {},
      },
    };
    // Send the request immediately; the child will either buffer it (not
    // ready yet) or receive it after preflight fails but before exit. Either
    // way, the reply must be a -32000.
    child.stdin.write(`${JSON.stringify(initialize)}\n`);

    const line = await readOneLine(child);
    const parsed = JSON.parse(line) as {
      id: number;
      error?: { code: number; message: string };
    };
    expect(parsed.id).toBe(99);
    expect(parsed.error?.code).toBe(-32000);
    expect(parsed.error?.message).toMatch(/not (running|ready)/i);
  }, 30_000);

  it("synthesizes -32000 for pending requests when the upstream dies mid-session", async () => {
    // Fake server that accepts the initialize POST but never responds —
    // then close the socket mid-request to simulate an upstream crash.
    let held: ServerResponse | undefined;
    const server = createServer((req, res) => {
      if (req.method === "GET" && req.url === "/health") {
        res.writeHead(200, { "Content-Type": "text/plain" });
        res.end("ok");
        return;
      }
      if (req.method === "POST" && req.url === "/mcp") {
        const chunks: Buffer[] = [];
        req.on("data", (c: Buffer) => chunks.push(c));
        req.on("end", () => {
          // Hold the response — we'll close the server under the client
          // instead of replying.
          held = res;
        });
        return;
      }
      res.writeHead(404);
      res.end();
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const addr = server.address();
    if (!addr || typeof addr === "string") throw new Error("server.address() unexpected");
    const port = addr.port;

    try {
      const cliEntry = resolve(__dirname, "../../src/cli/index.ts");
      child = spawn(process.execPath, ["--import", "tsx", cliEntry, "mcp-stdio"], {
        env: { ...process.env, TANDEM_URL: `http://127.0.0.1:${port}` },
        stdio: ["pipe", "pipe", "pipe"],
      });

      // Send immediately and let the preReadyBuffer→drain path deliver the
      // request once preflight completes. No fixed sleep needed — we poll
      // `held` below and proceed only once the server has the POST in hand.
      const initialize = {
        jsonrpc: "2.0",
        id: 77,
        method: "initialize",
        params: {
          protocolVersion: "2024-11-05",
          clientInfo: { name: "test-harness", version: "0.0.0" },
          capabilities: {},
        },
      };
      child.stdin.write(`${JSON.stringify(initialize)}\n`);

      // Wait until the fake upstream has received the POST, then slam the
      // socket shut so the client's connection closes mid-session.
      for (let i = 0; i < 100; i++) {
        if (held) break;
        await new Promise((r) => setTimeout(r, 100));
      }
      expect(held).toBeDefined(); // fail fast if CLI startup was too slow
      // Destroy the held response — exercises forwardToUpstream.catch (not
      // http.onclose, which the current SDK only fires from its own close()).
      held!.destroy();

      const line = await readOneLine(child);
      const parsed = JSON.parse(line) as {
        id: number;
        error?: { code: number; message: string };
      };
      expect(parsed.id).toBe(77);
      expect(parsed.error?.code).toBe(-32000);
      // forwardToUpstream.catch fires with "Tandem HTTP upstream unreachable"
      expect(parsed.error?.message).toMatch(/unreachable/i);
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  }, 30_000);

  it("does not synthesize for notifications (no id) on preflight failure", async () => {
    const cliEntry = resolve(__dirname, "../../src/cli/index.ts");
    // Point at a dead port so preflight fails immediately.
    child = spawn(process.execPath, ["--import", "tsx", cliEntry, "mcp-stdio"], {
      env: { ...process.env, TANDEM_URL: "http://127.0.0.1:1" },
      stdio: ["pipe", "pipe", "pipe"],
    });

    // Write a notification (no id) — must never produce a -32000 reply.
    const notification = { jsonrpc: "2.0", method: "notifications/initialized" };
    child.stdin.write(`${JSON.stringify(notification)}\n`);

    // Wait for child to exit (it exits 1 after PREFLIGHT_GRACE_MS).
    await new Promise<void>((r) => child!.once("exit", () => r()));

    // Collect any stdout lines that arrived.
    const stdoutChunks: string[] = [];
    child.stdout.on("data", (c: Buffer) => stdoutChunks.push(c.toString("utf8")));
    const allOutput = stdoutChunks.join("");
    const lines = allOutput.split("\n").filter((l) => l.trim());

    // No line should be a -32000 error reply.
    for (const line of lines) {
      try {
        const parsed = JSON.parse(line) as { error?: { code?: number } };
        expect(parsed.error?.code).not.toBe(-32000);
      } catch {
        // Non-JSON line — fine, ignore.
      }
    }
  }, 15_000);

  it("synthesizes -32000 for multiple concurrent pending requests on mid-session upstream death", async () => {
    // Fake server: /health → 200, /mcp → holds all POSTs without replying.
    const heldResponses: ServerResponse[] = [];
    const server = createServer((req, res) => {
      if (req.method === "GET" && req.url === "/health") {
        res.writeHead(200, { "Content-Type": "text/plain" });
        res.end("ok");
        return;
      }
      if (req.method === "POST" && req.url === "/mcp") {
        const chunks: Buffer[] = [];
        req.on("data", (c: Buffer) => chunks.push(c));
        req.on("end", () => {
          heldResponses.push(res);
        });
        return;
      }
      res.writeHead(404);
      res.end();
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const addr = server.address();
    if (!addr || typeof addr === "string") throw new Error("server.address() unexpected");
    const port = addr.port;

    try {
      const cliEntry = resolve(__dirname, "../../src/cli/index.ts");
      child = spawn(process.execPath, ["--import", "tsx", cliEntry, "mcp-stdio"], {
        env: { ...process.env, TANDEM_URL: `http://127.0.0.1:${port}` },
        stdio: ["pipe", "pipe", "pipe"],
      });

      // Send three concurrent requests with distinct ids.
      const makeRequest = (id: number) => ({
        jsonrpc: "2.0",
        id,
        method: "initialize",
        params: {
          protocolVersion: "2024-11-05",
          clientInfo: { name: "test-harness", version: "0.0.0" },
          capabilities: {},
        },
      });
      child.stdin.write(`${JSON.stringify(makeRequest(100))}\n`);
      child.stdin.write(`${JSON.stringify(makeRequest(101))}\n`);
      child.stdin.write(`${JSON.stringify(makeRequest(102))}\n`);

      // Poll until all three POSTs reach the server (preflight + drain must
      // complete first). 15s budget survives heavy CPU load (e.g. concurrent
      // cargo compile); readLines below uses its own 10s budget, total ~25s
      // well within the 30s test timeout.
      await waitForCount(() => heldResponses.length, 3, 15_000);

      // Destroy all held responses to trigger forwardToUpstream.catch for each.
      for (const r of heldResponses) r.destroy();

      // Collect three -32000 lines.
      const lines = await readLines(child, 3, 10_000);
      expect(lines).toHaveLength(3);

      const receivedIds = new Set<number>();
      for (const line of lines) {
        const parsed = JSON.parse(line) as {
          id: number;
          error?: { code: number };
        };
        expect(parsed.error?.code).toBe(-32000);
        receivedIds.add(parsed.id);
      }
      expect(receivedIds).toEqual(new Set([100, 101, 102]));
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  }, 30_000);

  it("clears pendingRequests after a successful response", async () => {
    // Fake server: first POST (id=1) → success reply; second POST (id=2) → held.
    let postCount = 0;
    let held: ServerResponse | undefined;
    const server = createServer((req, res) => {
      if (req.method === "GET" && req.url === "/health") {
        res.writeHead(200, { "Content-Type": "text/plain" });
        res.end("ok");
        return;
      }
      if (req.method === "POST" && req.url === "/mcp") {
        const chunks: Buffer[] = [];
        req.on("data", (c: Buffer) => chunks.push(c));
        req.on("end", () => {
          const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
            id?: number | string;
          };
          postCount++;
          if (postCount === 1) {
            // Reply immediately for id=1.
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(
              JSON.stringify({
                jsonrpc: "2.0",
                id: body.id,
                result: { protocolVersion: "2024-11-05", capabilities: {} },
              }),
            );
          } else {
            // Hold id=2 — will be destroyed to trigger forwardToUpstream.catch.
            held = res;
          }
        });
        return;
      }
      res.writeHead(404);
      res.end();
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const addr = server.address();
    if (!addr || typeof addr === "string") throw new Error("server.address() unexpected");
    const port = addr.port;

    try {
      const cliEntry = resolve(__dirname, "../../src/cli/index.ts");
      child = spawn(process.execPath, ["--import", "tsx", cliEntry, "mcp-stdio"], {
        env: { ...process.env, TANDEM_URL: `http://127.0.0.1:${port}` },
        stdio: ["pipe", "pipe", "pipe"],
      });

      const makeRequest = (id: number) => ({
        jsonrpc: "2.0",
        id,
        method: "initialize",
        params: {
          protocolVersion: "2024-11-05",
          clientInfo: { name: "test-harness", version: "0.0.0" },
          capabilities: {},
        },
      });

      // Send id=1, read success response — proves delete-after-send path.
      child.stdin.write(`${JSON.stringify(makeRequest(1))}\n`);
      const line1 = await readOneLine(child, 10_000);
      const parsed1 = JSON.parse(line1) as { id: number; error?: { code: number } };
      expect(parsed1.id).toBe(1);
      expect(parsed1.error).toBeUndefined();

      // Send id=2 and wait until the server holds it.
      child.stdin.write(`${JSON.stringify(makeRequest(2))}\n`);
      for (let i = 0; i < 100; i++) {
        if (held) break;
        await new Promise((r) => setTimeout(r, 50));
      }
      expect(held).toBeDefined();

      // Destroy the held response → forwardToUpstream.catch fires for id=2 only.
      held!.destroy();

      const line2 = await readOneLine(child, 10_000);
      const parsed2 = JSON.parse(line2) as { id: number; error?: { code: number } };
      expect(parsed2.id).toBe(2);
      expect(parsed2.error?.code).toBe(-32000);

      // Verify no additional line arrives — id=1 must have been removed from
      // pendingRequests on success and must NOT be re-synthesized.
      const extra = await readLines(child, 1, 500);
      expect(extra).toHaveLength(0);
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  }, 30_000);
});

describe("mcp-stdio per-request timeout", () => {
  let child: ChildProcessWithoutNullStreams | undefined;
  let timeoutServer: Server | undefined;

  afterEach(async () => {
    // Kill child first so the HTTP connection is released before server.close().
    child?.kill();
    child = undefined;
    if (timeoutServer) {
      // closeAllConnections() (Node 18.2+) forces open keep-alive sockets
      // closed so server.close() resolves without hanging.
      (timeoutServer as Server & { closeAllConnections?: () => void }).closeAllConnections?.();
      await new Promise<void>((r) => timeoutServer!.close(() => r()));
      timeoutServer = undefined;
    }
  });

  /**
   * Spin up a fake Tandem server whose /mcp endpoint holds every POST
   * without replying. Used by half-open timeout tests.
   *
   * Returns `postsReceived` — a counter the caller can poll on to determine
   * when the CLI's request reached the fake server (i.e. `httpReady` flipped,
   * `preReadyBuffer` drained, and the per-request timer started ticking).
   * Polling on this counter instead of `setTimeout(500)` is what makes the
   * timeout tests robust under concurrent vitest load, where subprocess
   * startup can easily exceed 500ms.
   */
  async function makeHalfOpenServer(): Promise<{ port: number; postsReceived: { count: number } }> {
    const postsReceived = { count: 0 };
    timeoutServer = createServer((req, res) => {
      if (req.method === "GET" && req.url === "/health") {
        res.writeHead(200, { "Content-Type": "text/plain" });
        res.end("ok");
        return;
      }
      if (req.method === "POST" && req.url === "/mcp") {
        // Intentionally never respond — simulates a half-open upstream.
        // Count POSTs on "end" so the increment fires only after the request
        // body has fully arrived (matches when forwardToUpstream's await on
        // fetch is past send).
        const chunks: Buffer[] = [];
        req.on("data", (c: Buffer) => chunks.push(c));
        req.on("end", () => {
          postsReceived.count += 1;
        });
        return;
      }
      res.writeHead(404);
      res.end();
    });
    await new Promise<void>((r) => (timeoutServer as Server).listen(0, "127.0.0.1", r));
    const addr = (timeoutServer as Server).address();
    if (!addr || typeof addr === "string") throw new Error("server.address() unexpected");
    return { port: addr.port, postsReceived };
  }

  /**
   * Poll until the fake server has received at least `n` POSTs (or fail the
   * test after `timeoutMs`). Decouples assertions from subprocess startup
   * latency, which can easily exceed a fixed delay under load.
   */
  async function waitForPosts(
    counter: { count: number },
    n: number,
    timeoutMs = 10_000,
  ): Promise<void> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      if (counter.count >= n) return;
      await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error(
      `Only ${counter.count}/${n} POSTs reached the fake server within ${timeoutMs}ms`,
    );
  }

  it("synthesizes -32000 after timeout when upstream accepts but never responds (half-open)", async () => {
    // Fake server: /health → 200, /mcp → holds the POST without replying.
    const { port, postsReceived } = await makeHalfOpenServer();
    const cliEntry = resolve(__dirname, "../../src/cli/index.ts");
    // Use a short timeout (500ms) so the test doesn't take 30s.
    child = spawn(process.execPath, ["--import", "tsx", cliEntry, "mcp-stdio"], {
      env: {
        ...process.env,
        TANDEM_URL: `http://127.0.0.1:${port}`,
        TANDEM_REQUEST_TIMEOUT_MS: "500",
      },
      stdio: ["pipe", "pipe", "pipe"],
    });

    // Send the request immediately — it sits in `preReadyBuffer` until
    // httpReady flips, then forwardToUpstream fires and the 500ms timer
    // starts. We don't care WHEN that happens; we poll until the POST
    // arrived at the fake server, which proves the timer is running.
    child.stdin.write(
      `${JSON.stringify({ jsonrpc: "2.0", id: 10, method: "initialize", params: { protocolVersion: "2024-11-05", clientInfo: { name: "test", version: "0" }, capabilities: {} } })}\n`,
    );
    await waitForPosts(postsReceived, 1);

    // Expect -32000 within 500ms timer + processing slack.
    const line = await readOneLine(child, 3_000);
    const parsed = JSON.parse(line) as {
      id: number;
      error?: { code: number; message: string; data?: { detail: string } };
    };
    expect(parsed.id).toBe(10);
    expect(parsed.error?.code).toBe(-32000);
    expect(parsed.error?.message).toMatch(/half-open/i);
    expect(parsed.error?.data?.detail).toMatch(/500ms/);
  }, 15_000);

  it("synthesizes distinct -32000 for each concurrent pending request on timeout", async () => {
    // Fake server: /health → 200, /mcp → holds all POSTs without replying.
    const { port, postsReceived } = await makeHalfOpenServer();
    const cliEntry = resolve(__dirname, "../../src/cli/index.ts");
    child = spawn(process.execPath, ["--import", "tsx", cliEntry, "mcp-stdio"], {
      env: {
        ...process.env,
        TANDEM_URL: `http://127.0.0.1:${port}`,
        TANDEM_REQUEST_TIMEOUT_MS: "500",
      },
      stdio: ["pipe", "pipe", "pipe"],
    });

    const makeRequest = (id: number) =>
      JSON.stringify({
        jsonrpc: "2.0",
        id,
        method: "initialize",
        params: {
          protocolVersion: "2024-11-05",
          clientInfo: { name: "test", version: "0" },
          capabilities: {},
        },
      });
    child.stdin.write(`${makeRequest(20)}\n`);
    child.stdin.write(`${makeRequest(21)}\n`);
    child.stdin.write(`${makeRequest(22)}\n`);
    // Wait until all 3 POSTs reached the fake server — confirms three timers
    // are running before we start reading stdout.
    await waitForPosts(postsReceived, 3);

    // Collect 3 -32000 lines (500ms timer + processing slack).
    const lines = await readLines(child, 3, 3_000);
    expect(lines).toHaveLength(3);

    const receivedIds = new Set<number>();
    for (const line of lines) {
      const parsed = JSON.parse(line) as { id: number; error?: { code: number } };
      expect(parsed.error?.code).toBe(-32000);
      receivedIds.add(parsed.id);
    }
    expect(receivedIds).toEqual(new Set([20, 21, 22]));
  }, 15_000);

  it("does not synthesize double -32000 when timer fires before upstream crash arrives", async () => {
    // Regression guard: when the per-request timer fires and deletes the map entry,
    // a subsequent forwardToUpstream.catch for the same id must find the map empty
    // and NOT emit a second -32000.
    //
    // Sequence:
    //  1. Short timer (300ms) starts when request is forwarded.
    //  2. Server holds the POST (never responds), timer fires → map deleted → -32000 (half-open).
    //  3. Test destroys the server connection after the timer has fired.
    //  4. forwardToUpstream.catch fires: pendingRequests.delete() returns false → no second -32000.
    let heldRes: ServerResponse | undefined;
    const postsReceived = { count: 0 };
    timeoutServer = createServer((req, res) => {
      if (req.method === "GET" && req.url === "/health") {
        res.writeHead(200, { "Content-Type": "text/plain" });
        res.end("ok");
        return;
      }
      if (req.method === "POST" && req.url === "/mcp") {
        const chunks: Buffer[] = [];
        req.on("data", (c: Buffer) => chunks.push(c));
        req.on("end", () => {
          heldRes = res;
          postsReceived.count += 1;
        });
        return;
      }
      res.writeHead(404);
      res.end();
    });
    await new Promise<void>((r) => (timeoutServer as Server).listen(0, "127.0.0.1", r));
    const addr = (timeoutServer as Server).address();
    if (!addr || typeof addr === "string") throw new Error("server.address() unexpected");
    const { port } = addr;

    const cliEntry = resolve(__dirname, "../../src/cli/index.ts");
    child = spawn(process.execPath, ["--import", "tsx", cliEntry, "mcp-stdio"], {
      env: {
        ...process.env,
        TANDEM_URL: `http://127.0.0.1:${port}`,
        // Short enough to fire before we destroy, long enough to be reliable.
        TANDEM_REQUEST_TIMEOUT_MS: "300",
      },
      stdio: ["pipe", "pipe", "pipe"],
    });

    // Collect stdout so we can count total -32000 lines later.
    const stdoutChunks: string[] = [];
    child.stdout.on("data", (c: Buffer) => stdoutChunks.push(c.toString("utf8")));

    // Send the request immediately — preReadyBuffer holds it until httpReady
    // flips, then forwardToUpstream fires and the 300ms timer starts. Polling
    // on postsReceived (below) replaces a fixed setTimeout(500) — under
    // full-suite parallelism, subprocess startup can easily exceed 500ms and
    // the old fixed delay was flaky (see #687).
    child.stdin.write(
      `${JSON.stringify({ jsonrpc: "2.0", id: 30, method: "initialize", params: { protocolVersion: "2024-11-05", clientInfo: { name: "test", version: "0" }, capabilities: {} } })}\n`,
    );

    // Poll until the POST reaches the fake server — proves the per-request
    // timer is now running. Generous budget for full-suite load.
    await waitForPosts(postsReceived, 1);
    expect(heldRes).toBeDefined();

    // Wait for the 300ms timer to fire and produce the -32000. Loose bound
    // (5s) to absorb scheduling jitter under parallel test load.
    const firstLine = await readOneLine(child, 5_000);
    const first = JSON.parse(firstLine) as { id: number; error?: { code: number } };
    expect(first.id).toBe(30);
    expect(first.error?.code).toBe(-32000);

    // Now destroy the connection — forwardToUpstream.catch will fire.
    heldRes!.destroy();

    // Wait 500ms for any spurious second -32000 to arrive.
    await new Promise((r) => setTimeout(r, 500));
    const allOutput = stdoutChunks.join("");
    const allLines = allOutput.split("\n").filter((l) => l.trim());
    const errorCount = allLines.filter((l) => {
      try {
        const p = JSON.parse(l) as { id?: number; error?: { code?: number } };
        return p.id === 30 && p.error?.code === -32000;
      } catch {
        return false;
      }
    }).length;
    // Exactly one -32000 for id=30 — timer fired first, catch found map empty.
    expect(errorCount).toBe(1);
  }, 20_000);

  it("process exits in <3s after half-open timeout fires (no orphan handles)", async () => {
    // Regression guard: after the per-request timer fires and the proxy sends a
    // -32000, the process should exit cleanly when stdin is closed.
    //
    // stdin.end() routes through stdio.onclose → shutdown(0) → process.exit(0),
    // exercising the real natural-exit path. SIGTERM would bypass the Node event
    // loop entirely and cannot detect orphan timer handles that block clean exit.
    // The timer has already fired and been cleared from the map before stdin.end().
    const { port, postsReceived } = await makeHalfOpenServer();
    const cliEntry = resolve(__dirname, "../../src/cli/index.ts");
    child = spawn(process.execPath, ["--import", "tsx", cliEntry, "mcp-stdio"], {
      env: {
        ...process.env,
        TANDEM_URL: `http://127.0.0.1:${port}`,
        TANDEM_REQUEST_TIMEOUT_MS: "300",
      },
      stdio: ["pipe", "pipe", "pipe"],
    });

    // Write immediately — the request buffers in preReadyBuffer until httpReady
    // flips, then forwardToUpstream fires. Poll for the POST (NOT a fixed sleep,
    // see #687) so the test tolerates subprocess startup latency under concurrent
    // vitest load, where `--import tsx` startup can far exceed 500ms. The ordering
    // is load-bearing: the 300ms timer is armed just before http.send, so when
    // waitForPosts returns (POST received) it has been running only for the
    // network round-trip — ~290ms still remain, so readOneLine's listener
    // attaches well before the -32000 is emitted.
    child.stdin.write(
      `${JSON.stringify({ jsonrpc: "2.0", id: 40, method: "initialize", params: { protocolVersion: "2024-11-05", clientInfo: { name: "test", version: "0" }, capabilities: {} } })}\n`,
    );
    await waitForPosts(postsReceived, 1);

    // Wait for the -32000 to arrive (timer fired). Loose bound for full-suite load.
    const line = await readOneLine(child, 5_000);
    const parsed = JSON.parse(line) as { id: number; error?: { code: number } };
    expect(parsed.id).toBe(40);
    expect(parsed.error?.code).toBe(-32000);

    // Close stdin (routes through stdio.onclose → shutdown(0) → process.exit(0)).
    // This exercises the natural exit path — SIGTERM would bypass the event loop
    // and cannot detect orphan timer handles that prevent clean shutdown.
    child.stdin.end();
    const closed = await new Promise<boolean>((resolve) => {
      const deadline = setTimeout(() => resolve(false), 3_000);
      child!.once("close", () => {
        clearTimeout(deadline);
        resolve(true);
      });
    });
    expect(closed).toBe(true);
  }, 20_000);
});

describe("parseTimeoutMs", () => {
  it("returns the parsed value for a valid positive integer string", () => {
    expect(parseTimeoutMs("5000")).toBe(5000);
    expect(parseTimeoutMs("1")).toBe(1);
    expect(parseTimeoutMs("2147483647")).toBe(2_147_483_647);
  });

  it("returns 30000 for undefined (no env var set)", () => {
    expect(parseTimeoutMs(undefined)).toBe(30_000);
  });

  it("returns 30000 for NaN input", () => {
    expect(parseTimeoutMs("not-a-number")).toBe(30_000);
  });

  it("accepts scientific-notation-like input as the leading integer (parseInt stops at 'e')", () => {
    // parseInt("3e4", 10) === 3 — a small positive integer, accepted as valid.
    expect(parseTimeoutMs("3e4")).toBe(3);
    // parseInt("1e10", 10) === 1 — also a small positive integer.
    expect(parseTimeoutMs("1e10")).toBe(1);
  });

  it("returns 30000 for overflow (> MAX_TIMEOUT_MS)", () => {
    expect(parseTimeoutMs("9999999999999")).toBe(30_000);
    expect(parseTimeoutMs("2147483648")).toBe(30_000);
  });

  it("returns 30000 for negative values", () => {
    expect(parseTimeoutMs("-1")).toBe(30_000);
    expect(parseTimeoutMs("-100")).toBe(30_000);
  });

  it("returns 30000 for zero", () => {
    expect(parseTimeoutMs("0")).toBe(30_000);
  });
});

describe("readAndValidateAuthToken", () => {
  const origExit = process.exit;
  const origEnv = process.env.TANDEM_AUTH_TOKEN;
  const origPluginEnv = process.env.CLAUDE_PLUGIN_OPTION_AUTH_TOKEN;

  afterEach(() => {
    // Restore after each test
    process.exit = origExit as typeof process.exit;
    if (origEnv === undefined) {
      delete process.env.TANDEM_AUTH_TOKEN;
    } else {
      process.env.TANDEM_AUTH_TOKEN = origEnv;
    }
    if (origPluginEnv === undefined) {
      delete process.env.CLAUDE_PLUGIN_OPTION_AUTH_TOKEN;
    } else {
      process.env.CLAUDE_PLUGIN_OPTION_AUTH_TOKEN = origPluginEnv;
    }
  });

  function mockExit(): { exitCode: number | undefined } {
    const result = { exitCode: undefined as number | undefined };
    process.exit = ((code?: number) => {
      result.exitCode = code;
      throw new Error(`process.exit(${code})`);
    }) as typeof process.exit;
    return result;
  }

  it("returns null when TANDEM_AUTH_TOKEN is not set", () => {
    delete process.env.TANDEM_AUTH_TOKEN;
    expect(readAndValidateAuthToken()).toBeNull();
  });

  it("returns null when TANDEM_AUTH_TOKEN is empty string (empty after trim = loopback-only mode)", () => {
    // Spec: "If TANDEM_AUTH_TOKEN is not set (or empty after trim), proceed with no Authorization
    // header — no exit." An explicitly-set-but-empty env var is treated the same as not set.
    process.env.TANDEM_AUTH_TOKEN = "";
    expect(readAndValidateAuthToken()).toBeNull();
  });

  it("returns the token when valid (32+ alphanumeric chars)", () => {
    const validToken = "abcdefghijklmnopqrstuvwxyz012345";
    process.env.TANDEM_AUTH_TOKEN = validToken;
    expect(readAndValidateAuthToken()).toBe(validToken);
  });

  it("returns the token with underscores and hyphens (valid chars)", () => {
    const validToken = "abcdef_GHIJKL-mnopqrstuvwxyz01234";
    process.env.TANDEM_AUTH_TOKEN = validToken;
    expect(readAndValidateAuthToken()).toBe(validToken);
  });

  it("returns null for whitespace-only token (empty after trim = loopback-only mode)", () => {
    // Spec: "empty after trim" → no exit, return null.
    process.env.TANDEM_AUTH_TOKEN = "   ";
    expect(readAndValidateAuthToken()).toBeNull();
  });

  it("rejects token with invalid characters (e.g. embedded special chars)", () => {
    // A token with an embedded invalid character (! is not in [A-Za-z0-9_-]).
    // Must be ≥32 chars to ensure failure is due to invalid chars, not length.
    const result = mockExit();
    process.env.TANDEM_AUTH_TOKEN = "validlengthtoken!@#$%^&*()1234567";
    expect(() => readAndValidateAuthToken()).toThrow("process.exit(1)");
    expect(result.exitCode).toBe(1);
  });

  it("exits 1 for Bearer-prefixed token (double-prefix) and names TANDEM_AUTH_TOKEN", () => {
    process.env.TANDEM_AUTH_TOKEN = "Bearer abcdefghijklmnopqrstuvwxyz012345";
    const stderrLines: string[] = [];
    const origStderrWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((...args: Parameters<typeof process.stderr.write>) => {
      stderrLines.push(String(args[0]));
      return origStderrWrite(...args);
    }) as typeof process.stderr.write;
    const result = mockExit();
    try {
      expect(() => readAndValidateAuthToken()).toThrow("process.exit(1)");
      expect(result.exitCode).toBe(1);
      const stderrOutput = stderrLines.join("");
      expect(stderrOutput).toMatch(/double[- ]prefix|Bearer/i);
      expect(stderrOutput).toContain("TANDEM_AUTH_TOKEN");
    } finally {
      process.stderr.write = origStderrWrite;
    }
  });

  it("exits 1 for token shorter than 32 chars", () => {
    process.env.TANDEM_AUTH_TOKEN = "short";
    const result = mockExit();
    expect(() => readAndValidateAuthToken()).toThrow("process.exit(1)");
    expect(result.exitCode).toBe(1);
  });

  it("names CLAUDE_PLUGIN_OPTION_AUTH_TOKEN in stderr when the plugin token is malformed", () => {
    process.env.CLAUDE_PLUGIN_OPTION_AUTH_TOKEN = "short";
    const stderrLines: string[] = [];
    const origStderrWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((...args: Parameters<typeof process.stderr.write>) => {
      stderrLines.push(String(args[0]));
      return origStderrWrite(...args);
    }) as typeof process.stderr.write;
    const result = mockExit();
    try {
      expect(() => readAndValidateAuthToken()).toThrow("process.exit(1)");
      expect(result.exitCode).toBe(1);
      const stderrOutput = stderrLines.join("");
      expect(stderrOutput).toContain("CLAUDE_PLUGIN_OPTION_AUTH_TOKEN");
      expect(stderrOutput).toMatch(/malformed/i);
    } finally {
      process.stderr.write = origStderrWrite;
    }
  });

  it("names CLAUDE_PLUGIN_OPTION_AUTH_TOKEN in stderr when the plugin token has Bearer prefix", () => {
    process.env.CLAUDE_PLUGIN_OPTION_AUTH_TOKEN = "Bearer abcdefghijklmnopqrstuvwxyz012345";
    const stderrLines: string[] = [];
    const origStderrWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((...args: Parameters<typeof process.stderr.write>) => {
      stderrLines.push(String(args[0]));
      return origStderrWrite(...args);
    }) as typeof process.stderr.write;
    const result = mockExit();
    try {
      expect(() => readAndValidateAuthToken()).toThrow("process.exit(1)");
      expect(result.exitCode).toBe(1);
      const stderrOutput = stderrLines.join("");
      expect(stderrOutput).toContain("CLAUDE_PLUGIN_OPTION_AUTH_TOKEN");
      expect(stderrOutput).toMatch(/double[- ]prefix|Bearer/i);
    } finally {
      process.stderr.write = origStderrWrite;
    }
  });

  it("names the higher-precedence source when both are set and the plugin token is malformed", () => {
    process.env.TANDEM_AUTH_TOKEN = "abcdefghijklmnopqrstuvwxyz012345"; // valid
    process.env.CLAUDE_PLUGIN_OPTION_AUTH_TOKEN = "short"; // malformed, but wins precedence
    const stderrLines: string[] = [];
    const origStderrWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((...args: Parameters<typeof process.stderr.write>) => {
      stderrLines.push(String(args[0]));
      return origStderrWrite(...args);
    }) as typeof process.stderr.write;
    const result = mockExit();
    try {
      expect(() => readAndValidateAuthToken()).toThrow("process.exit(1)");
      expect(result.exitCode).toBe(1);
      const stderrOutput = stderrLines.join("");
      expect(stderrOutput).toContain("CLAUDE_PLUGIN_OPTION_AUTH_TOKEN");
      expect(stderrOutput).not.toContain("TANDEM_AUTH_TOKEN is");
    } finally {
      process.stderr.write = origStderrWrite;
    }
  });
});

describe("mcp-stdio token forwarding integration", () => {
  let server: Server;
  let port: number;
  let receivedHeaders: Record<string, string | string[] | undefined>[] = [];
  let child: ChildProcessWithoutNullStreams | undefined;

  beforeEach(async () => {
    receivedHeaders = [];
    server = createServer((req: IncomingMessage, res: ServerResponse) => {
      if (req.method === "GET" && req.url === "/health") {
        res.writeHead(200, { "Content-Type": "text/plain" });
        res.end("ok");
        return;
      }
      if (req.method === "POST" && req.url === "/mcp") {
        const chunks: Buffer[] = [];
        req.on("data", (c: Buffer) => chunks.push(c));
        req.on("end", () => {
          receivedHeaders.push(req.headers);
          let body: unknown;
          try {
            body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
          } catch {
            body = null;
          }
          const msg = body as { id?: number | string; method?: string } | null;
          if (msg && typeof msg.method === "string" && "id" in msg) {
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(
              JSON.stringify({
                jsonrpc: "2.0",
                id: msg.id,
                result: {
                  protocolVersion: "2024-11-05",
                  capabilities: { tools: {} },
                  serverInfo: { name: "fake-tandem", version: "0.0.0-test" },
                },
              }),
            );
          } else {
            res.writeHead(202);
            res.end();
          }
        });
        return;
      }
      res.writeHead(404);
      res.end();
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const addr = server.address();
    if (!addr || typeof addr === "string") throw new Error("server.address() unexpected");
    port = addr.port;
  });

  afterEach(async () => {
    child?.kill();
    child = undefined;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("forwards Authorization: Bearer header when TANDEM_AUTH_TOKEN is valid", async () => {
    const token = "abcdefghijklmnopqrstuvwxyz012345"; // 32 chars
    const cliEntry = resolve(__dirname, "../../src/cli/index.ts");
    child = spawn(process.execPath, ["--import", "tsx", cliEntry, "mcp-stdio"], {
      env: { ...process.env, TANDEM_URL: `http://127.0.0.1:${port}`, TANDEM_AUTH_TOKEN: token },
      stdio: ["pipe", "pipe", "pipe"],
    });

    await new Promise((r) => setTimeout(r, 500));
    child.stdin.write(
      `${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", clientInfo: { name: "test", version: "0" }, capabilities: {} } })}\n`,
    );

    await readOneLine(child);
    expect(receivedHeaders.length).toBeGreaterThan(0);
    const authHeader = receivedHeaders[0]?.authorization;
    expect(authHeader).toBe(`Bearer ${token}`);
  }, 30_000);

  it("does NOT add Authorization header when TANDEM_AUTH_TOKEN is not set", async () => {
    const env: NodeJS.ProcessEnv = { ...process.env, TANDEM_URL: `http://127.0.0.1:${port}` };
    delete env.TANDEM_AUTH_TOKEN;
    const cliEntry = resolve(__dirname, "../../src/cli/index.ts");
    child = spawn(process.execPath, ["--import", "tsx", cliEntry, "mcp-stdio"], {
      env,
      stdio: ["pipe", "pipe", "pipe"],
    });

    await new Promise((r) => setTimeout(r, 500));
    child.stdin.write(
      `${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "initialize", params: { protocolVersion: "2024-11-05", clientInfo: { name: "test", version: "0" }, capabilities: {} } })}\n`,
    );

    await readOneLine(child);
    expect(receivedHeaders.length).toBeGreaterThan(0);
    expect(receivedHeaders[0]?.authorization).toBeUndefined();
  }, 30_000);

  it("preserves Content-Type when token is set (requestInit merge regression)", async () => {
    const token = "abcdefghijklmnopqrstuvwxyz012345";
    const cliEntry = resolve(__dirname, "../../src/cli/index.ts");
    child = spawn(process.execPath, ["--import", "tsx", cliEntry, "mcp-stdio"], {
      env: { ...process.env, TANDEM_URL: `http://127.0.0.1:${port}`, TANDEM_AUTH_TOKEN: token },
      stdio: ["pipe", "pipe", "pipe"],
    });

    await new Promise((r) => setTimeout(r, 500));
    child.stdin.write(
      `${JSON.stringify({ jsonrpc: "2.0", id: 3, method: "initialize", params: { protocolVersion: "2024-11-05", clientInfo: { name: "test", version: "0" }, capabilities: {} } })}\n`,
    );

    await readOneLine(child);
    expect(receivedHeaders.length).toBeGreaterThan(0);
    // StreamableHTTPClientTransport sends application/json
    expect(receivedHeaders[0]?.["content-type"]).toMatch(/application\/json/i);
    expect(receivedHeaders[0]?.authorization).toBe(`Bearer ${token}`);
  }, 30_000);
});

// ---------------------------------------------------------------------------
// Re-initialize on a stale upstream session.
//
// Two defects combined to break Claude Desktop for a whole day at a time: the
// server reaped sessions that were demonstrably still attached, and this
// bridge — the only component that sees the resulting `404 -32001` — had no
// reconnection logic, on the theory that the plugin loader respawns it. Claude
// Desktop does not. Everything below pins the recovery path.
// ---------------------------------------------------------------------------

describe("stale-session helper predicates", () => {
  function httpError(code: number, message: string): Error {
    const err = new Error(message) as Error & { code: number };
    err.code = code;
    return err;
  }

  describe("isStaleSessionError", () => {
    it("is true only for an Error carrying a numeric 404 code", () => {
      expect(isStaleSessionError(httpError(404, "Error POSTing to endpoint: {}"))).toBe(true);
    });

    it("is false for the SDK's non-status codes and for near-misses", () => {
      // StreamableHTTPError(-1, "Unexpected content type: …") is why this
      // compares to 404 exactly rather than `>= 400`.
      expect(isStaleSessionError(httpError(-1, "Unexpected content type: text/plain"))).toBe(false);
      expect(isStaleSessionError(httpError(500, "Error POSTing to endpoint: boom"))).toBe(false);
      const stringCode = new Error("404") as Error & { code: string };
      stringCode.code = "404";
      expect(isStaleSessionError(stringCode)).toBe(false);
      expect(isStaleSessionError({ code: 404, message: "not an Error" })).toBe(false);
      expect(isStaleSessionError("404")).toBe(false);
      expect(isStaleSessionError(undefined)).toBe(false);
    });
  });

  describe("carriedSessionNotFound", () => {
    const body = JSON.stringify({
      jsonrpc: "2.0",
      error: { code: -32001, message: "Session not found" },
      id: 7,
    });

    it("reads -32001 out of the body the SDK embedded in the message", () => {
      expect(carriedSessionNotFound(httpError(404, `Error POSTing to endpoint: ${body}`))).toBe(
        true,
      );
    });

    it("accepts a batched body carrying the code", () => {
      const batched = JSON.stringify([{ jsonrpc: "2.0", error: { code: -32001 }, id: 1 }]);
      expect(carriedSessionNotFound(httpError(404, `Error POSTing to endpoint: ${batched}`))).toBe(
        true,
      );
    });

    it("is false for a non-JSON 404 body — reconnect yes, replay no", () => {
      // A reverse proxy, a different app on the port, or a squatter answering
      // 404 must never get a mutating tool call re-executed against it.
      expect(
        carriedSessionNotFound(httpError(404, "Error POSTing to endpoint: <html>404</html>")),
      ).toBe(false);
      expect(carriedSessionNotFound(httpError(404, "Error POSTing to endpoint: null"))).toBe(false);
    });

    it("is false for a JSON body carrying a different error code", () => {
      const other = JSON.stringify({ jsonrpc: "2.0", error: { code: -32603 }, id: 1 });
      expect(carriedSessionNotFound(httpError(404, `Error POSTing to endpoint: ${other}`))).toBe(
        false,
      );
    });

    it("is false when the message is not the SDK's POST-failure shape", () => {
      expect(carriedSessionNotFound(httpError(404, "Failed to open SSE stream: Not Found"))).toBe(
        false,
      );
      expect(carriedSessionNotFound("nope")).toBe(false);
    });
  });

  describe("isSseStreamLostError", () => {
    it("matches the terminal signal and the first-GET failure", () => {
      expect(isSseStreamLostError(new Error("Maximum reconnection attempts (2) exceeded."))).toBe(
        true,
      );
      expect(isSseStreamLostError(httpError(404, "Failed to open SSE stream: Not Found"))).toBe(
        true,
      );
    });

    it("does not match the SDK's retryable mid-stream strings", () => {
      // The SDK's own two retries cover these, and they also fire during an
      // ordinary restart while the server is still down — reconnecting on them
      // means racing a server that has not come back yet.
      expect(isSseStreamLostError(new Error("SSE stream disconnected: TypeError: fetch"))).toBe(
        false,
      );
      expect(
        isSseStreamLostError(new Error("Failed to reconnect SSE stream: socket hang up")),
      ).toBe(false);
    });

    it("does not match a POST 404, and a GET 404 matches only this predicate first", () => {
      // Ordering is load-bearing in onerror: a GET 404 satisfies BOTH
      // predicates. Testing isSseStreamLostError second would send a stream
      // failure down the POST branch looking for a message to replay.
      const postFailure = httpError(404, "Error POSTing to endpoint: {}");
      expect(isSseStreamLostError(postFailure)).toBe(false);
      expect(isStaleSessionError(postFailure)).toBe(true);

      const getFailure = httpError(404, "Failed to open SSE stream: Not Found");
      expect(isSseStreamLostError(getFailure)).toBe(true);
      expect(isStaleSessionError(getFailure)).toBe(true);
    });

    it("is false for non-Errors", () => {
      expect(isSseStreamLostError("Maximum reconnection attempts (2) exceeded.")).toBe(false);
    });
  });

  describe("makeReplayId", () => {
    it("carries the greppable prefix and does not collide", () => {
      const ids = new Set(Array.from({ length: 200 }, () => makeReplayId()));
      expect(ids.size).toBe(200);
      for (const id of ids) expect(id.startsWith("__tandem_reinit_")).toBe(true);
    });
  });

  describe("isReplayId", () => {
    it("matches any id this bridge minted, not just the awaited one", () => {
      expect(isReplayId(makeReplayId())).toBe(true);
      // The point of the prefix test: an id whose reconnect already gave up on
      // it must still be swallowed, because the failed transport stays
      // installed and its POST can be answered late.
      expect(isReplayId("__tandem_reinit_stale-from-a-previous-attempt")).toBe(true);
    });

    it("never claims an id the client could have issued", () => {
      expect(isReplayId(1)).toBe(false);
      expect(isReplayId("1")).toBe(false);
      expect(isReplayId(undefined)).toBe(false);
      expect(isReplayId("tandem_reinit_x")).toBe(false);
      expect(isReplayId("x__tandem_reinit_")).toBe(false);
    });
  });

  describe("describeServerInfo", () => {
    it("renders name@version and collapses anything else to a sentinel", () => {
      expect(describeServerInfo({ name: "tandem", version: "1.2.3" })).toBe("tandem@1.2.3");
      // A server that omits serverInfo must not compare equal to one that
      // supplies it, so every non-conforming shape collapses to one sentinel.
      expect(describeServerInfo(undefined)).toBe("<unknown>");
      expect(describeServerInfo(null)).toBe("<unknown>");
      expect(describeServerInfo({ name: "tandem" })).toBe("<unknown>");
      expect(describeServerInfo({ name: 1, version: 2 })).toBe("<unknown>");
    });
  });

  describe("nextBackoffMs", () => {
    it("reconnects immediately and resets the ladder after a long-lived session", () => {
      // The ordinary 30-minute-reap case. Latency is the entire point.
      expect(nextBackoffMs(8_000, 61_000)).toEqual({ delayMs: 0, nextMs: 1_000 });
      expect(nextBackoffMs(30_000, 30 * 60 * 1000)).toEqual({ delayMs: 0, nextMs: 1_000 });
    });

    it("escalates when the dead session was short-lived", () => {
      expect(nextBackoffMs(1_000, 0)).toEqual({ delayMs: 1_000, nextMs: 2_000 });
      expect(nextBackoffMs(2_000, 5_000)).toEqual({ delayMs: 2_000, nextMs: 4_000 });
    });

    it("caps at 30s and stays there", () => {
      expect(nextBackoffMs(16_000, 0).nextMs).toBe(30_000);
      expect(nextBackoffMs(30_000, 0)).toEqual({ delayMs: 30_000, nextMs: 30_000 });
    });

    it("treats exactly 60s as not-yet-stable", () => {
      expect(nextBackoffMs(1_000, 60_000).delayMs).toBe(1_000);
      expect(nextBackoffMs(1_000, 60_001).delayMs).toBe(0);
    });
  });
});

/**
 * Drift detector for the SDK message strings `isSseStreamLostError` matches.
 *
 * That predicate is the only trigger a purely-listening client has — no tool
 * traffic means no 404 to notice — and it works by substring-matching error
 * text the SDK constructs. `@modelcontextprotocol/sdk` is declared as
 * `^1.12.1`, so a routine `npm update` can move the minor and reword these
 * with nothing in CI noticing: the predicate would quietly return false
 * forever and the wake channel would go dark again exactly as in #1588.
 *
 * The unit tests above assert the predicate against strings *we* wrote down,
 * which proves nothing about the SDK. These drive the real transport against a
 * real socket and assert the strings it actually emits. If one goes red after
 * a dependency bump, re-read `client/streamableHttp.js` and update
 * `isSseStreamLostError` — do not relax the assertion.
 */
describe("SDK SSE error strings (drift canary for isSseStreamLostError)", () => {
  let canaryServer: Server | undefined;
  let canaryTransport: StreamableHTTPClientTransport | undefined;

  afterEach(async () => {
    if (canaryTransport) {
      const t = canaryTransport;
      canaryTransport = undefined;
      // Stops any scheduled SSE reconnection before the socket goes away.
      t.onerror = undefined;
      await t.close().catch(() => undefined);
    }
    if (canaryServer) {
      const s = canaryServer;
      canaryServer = undefined;
      await new Promise<void>((r) => s.close(() => r()));
    }
  });

  /**
   * Handshake against a fake whose GET behaviour the caller chooses, and hand
   * back the live array `onerror` appends to.
   */
  async function driveSse(onGet: (res: ServerResponse) => void): Promise<Error[]> {
    canaryServer = createServer((req: IncomingMessage, res: ServerResponse) => {
      if (req.method === "GET" && req.url === "/mcp") {
        onGet(res);
        return;
      }
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        const body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}") as {
          id?: unknown;
          method?: unknown;
        };
        if (body.method === "initialize") {
          res.writeHead(200, {
            "Content-Type": "application/json",
            "mcp-session-id": "canary-session",
          });
          res.end(
            JSON.stringify({
              jsonrpc: "2.0",
              id: body.id,
              result: {
                protocolVersion: "2024-11-05",
                capabilities: {},
                serverInfo: { name: "canary", version: "0.0.0" },
              },
            }),
          );
          return;
        }
        res.writeHead(202);
        res.end();
      });
    });
    await new Promise<void>((r) => (canaryServer as Server).listen(0, "127.0.0.1", r));
    const addr = (canaryServer as Server).address();
    if (!addr || typeof addr === "string") throw new Error("server.address() unexpected");

    const errors: Error[] = [];
    const transport = new StreamableHTTPClientTransport(
      new URL(`http://127.0.0.1:${addr.port}/mcp`),
    );
    canaryTransport = transport;
    transport.onerror = (err) => {
      if (err instanceof Error) errors.push(err);
    };
    await transport.start();
    await transport.send({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2024-11-05",
        clientInfo: { name: "canary", version: "0.0.0" },
        capabilities: {},
      },
    });
    // The standalone GET is opened only from this notification's 202 branch,
    // and `_startOrAuthSse` rethrows, so a refused GET rejects this send too.
    await transport
      .send({ jsonrpc: "2.0", method: "notifications/initialized" })
      .catch(() => undefined);
    return errors;
  }

  async function settle(errors: Error[], want: (e: Error) => boolean, timeoutMs: number) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      if (errors.some(want)) return;
      await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error(
      `SDK never emitted the expected error. Saw: ${JSON.stringify(errors.map((e) => e.message))}`,
    );
  }

  it("still says 'Failed to open SSE stream:' when the GET is refused", async () => {
    const errors = await driveSse((res) => {
      res.writeHead(500);
      res.end();
    });
    await settle(errors, isSseStreamLostError, 10_000);
  }, 30_000);

  it("still says 'Maximum reconnection attempts (N) exceeded.' once its retries run out", async () => {
    // Opens cleanly, then dies, and every reconnect is refused — what a reaped
    // session looks like to a client that is only listening. The SDK retries
    // twice (1s, 1.5s) and then emits the terminal string the bridge treats as
    // its primary trigger.
    //
    // The refusals are load-bearing: a *successful* reconnect that then dies
    // again re-enters `_scheduleReconnection(options, 0)`, so the attempt
    // counter resets and the terminal string is never reached. Only a run of
    // failed retries exhausts it.
    let gets = 0;
    const errors = await driveSse((res) => {
      gets += 1;
      if (gets > 1) {
        res.writeHead(500);
        res.end();
        return;
      }
      res.writeHead(200, { "Content-Type": "text/event-stream", Connection: "keep-alive" });
      res.write(": open\n\n");
      setTimeout(() => res.end(), 20);
    });
    await settle(errors, (e) => e.message.includes("Maximum reconnection attempts ("), 20_000);
    expect(errors.some(isSseStreamLostError)).toBe(true);
  }, 40_000);

  it("still uses distinct, non-matching wording for the retryable mid-stream errors", () => {
    // Pinned by reading rather than driving: these two must NOT match, or the
    // bridge reconnects while the server is still down and races it.
    expect(isSseStreamLostError(new Error("SSE stream disconnected: socket hang up"))).toBe(false);
    expect(isSseStreamLostError(new Error("Failed to reconnect SSE stream: fetch failed"))).toBe(
      false,
    );
  });
});

describe("mcp-stdio re-initializes on a stale upstream session", () => {
  let child: ChildProcessWithoutNullStreams | undefined;
  let sessionServer: Server | undefined;
  const cliEntry = resolve(__dirname, "../../src/cli/index.ts");

  interface SessionServer {
    port: number;
    /** Every POST body the fake received, in arrival order. */
    posts: Array<{ body: Record<string, unknown>; headers: Record<string, unknown> }>;
    /** Forget the live session id — later requests carrying it get 404 -32001. */
    retireSession(): void;
    /** How many `initialize` requests the fake has handled. */
    initCount(): number;
    /** How many standalone GET /mcp attempts arrived. */
    getCount(): number;
    /** Swap the advertised serverInfo, to exercise the fail-closed identity check. */
    setServerInfo(info: { name: string; version: string }): void;
    /** Accept the next N initialize POSTs and never answer them. */
    stallInitializes(n: number): void;
    /**
     * Answer every stalled initialize that is still held open, minting a
     * session for each. Models a server whose event loop was merely wedged and
     * then unwedged — the exact scenario the replay deadline exists for, and
     * the one where a late answer can arrive after the bridge gave up.
     */
    releaseStalledInitializes(): number;
    /**
     * Kill the open standalone SSE stream and refuse the SDK's next `failNext`
     * GET retries, which is the only way to reach its terminal
     * `Maximum reconnection attempts` error: a retry that *succeeds* and then
     * dies re-enters `_scheduleReconnection(…, 0)` and resets the counter.
     */
    breakStandaloneStream(failNext: number): void;
  }

  /**
   * Fake HTTP MCP upstream with real session semantics: it mints an
   * `mcp-session-id` on initialize, 404s `-32001` for a retired one, and — this
   * part matters — answers `GET /mcp` with **405**, which the SDK treats as
   * "no stream offered" and returns from cleanly. Every other fake in this file
   * falls through to a bare 404 for GET, which was harmless only because none
   * of them ever forwarded an `initialized` notification, the one thing that
   * makes the SDK open the stream.
   */
  async function makeSessionServer(opts: { sse?: boolean } = {}): Promise<SessionServer> {
    const posts: SessionServer["posts"] = [];
    let live: string | undefined;
    let minted = 0;
    let inits = 0;
    let gets = 0;
    let stallInits = 0;
    let openStream: ServerResponse | undefined;
    let failNextGets = 0;
    let held: Array<{ res: ServerResponse; id: string | number | undefined }> = [];
    let serverInfo = { name: "fake-tandem", version: "0.0.0-test" };

    const answerInitialize = (res: ServerResponse, id: string | number | undefined) => {
      minted += 1;
      live = `sess-${minted}`;
      res.writeHead(200, { "Content-Type": "application/json", "mcp-session-id": live });
      res.end(
        JSON.stringify({
          jsonrpc: "2.0",
          id,
          result: {
            protocolVersion: "2024-11-05",
            capabilities: { tools: {} },
            serverInfo,
          },
        }),
      );
    };

    sessionServer = createServer((req, res) => {
      if (req.method === "GET" && req.url === "/health") {
        res.writeHead(200, { "Content-Type": "text/plain" });
        res.end("ok");
        return;
      }
      if (req.method === "GET" && req.url === "/mcp") {
        gets += 1;
        if (failNextGets > 0) {
          failNextGets -= 1;
          res.writeHead(500);
          res.end();
          return;
        }
        if (!opts.sse) {
          // 405 = "this server offers no standalone stream". The SDK returns
          // without erroring, so the bridge sees a clean handshake.
          res.writeHead(405);
          res.end();
          return;
        }
        res.writeHead(200, { "Content-Type": "text/event-stream", Connection: "keep-alive" });
        res.write(":open\n\n");
        openStream = res;
        res.on("close", () => {
          if (openStream === res) openStream = undefined;
        });
        return;
      }
      if (req.method === "POST" && req.url === "/mcp") {
        const chunks: Buffer[] = [];
        req.on("data", (c: Buffer) => chunks.push(c));
        req.on("end", () => {
          let body: Record<string, unknown>;
          try {
            body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
          } catch {
            body = {};
          }
          posts.push({ body, headers: req.headers as Record<string, unknown> });
          const id = body.id as string | number | undefined;

          if (body.method === "initialize") {
            inits += 1;
            if (stallInits > 0) {
              stallInits -= 1;
              // Accept and never answer — exercises the replay deadline. Held
              // rather than dropped so a test can answer it late.
              held.push({ res, id });
              return;
            }
            answerInitialize(res, id);
            return;
          }

          const presented = req.headers["mcp-session-id"];
          if (live === undefined || presented !== live) {
            // Exactly what dispatchToSession emits, and it emits it BEFORE
            // transport.handleRequest — which is what makes replaying such a
            // request provably side-effect-free.
            res.writeHead(404, { "Content-Type": "application/json" });
            res.end(
              JSON.stringify({
                jsonrpc: "2.0",
                error: { code: -32001, message: "Session not found" },
                id: id ?? null,
              }),
            );
            return;
          }

          if (id === undefined) {
            res.writeHead(202);
            res.end();
            return;
          }
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ jsonrpc: "2.0", id, result: { echo: body.method, live } }));
        });
        return;
      }
      res.writeHead(404);
      res.end();
    });

    await new Promise<void>((r) => (sessionServer as Server).listen(0, "127.0.0.1", r));
    const addr = (sessionServer as Server).address();
    if (!addr || typeof addr === "string") throw new Error("server.address() unexpected");
    return {
      port: addr.port,
      posts,
      retireSession: () => {
        live = undefined;
      },
      initCount: () => inits,
      getCount: () => gets,
      setServerInfo: (info) => {
        serverInfo = info;
      },
      stallInitializes: (n) => {
        stallInits = n;
      },
      breakStandaloneStream: (failNext) => {
        failNextGets = failNext;
        openStream?.end();
        openStream = undefined;
      },
      releaseStalledInitializes: () => {
        const flushed = held;
        held = [];
        for (const { res, id } of flushed) answerInitialize(res, id);
        return flushed.length;
      },
    };
  }

  /** Attach once and accumulate; repeated readLines() calls would drop data. */
  function collect(c: ChildProcessWithoutNullStreams) {
    let out = "";
    let err = "";
    c.stdout.on("data", (b: Buffer) => {
      out += b.toString("utf8");
    });
    c.stderr.on("data", (b: Buffer) => {
      err += b.toString("utf8");
    });
    return {
      stdout: () => out,
      stderr: () => err,
      lines: () => parseLines(out),
    };
  }

  function parseLines(out: string): Array<Record<string, unknown>> {
    return out
      .split("\n")
      .filter((l) => l.trim())
      .map((l) => JSON.parse(l) as Record<string, unknown>);
  }

  function responsesFor(out: string, id: string | number): Array<Record<string, unknown>> {
    return parseLines(out).filter((m) => m.id === id);
  }

  async function waitFor(predicate: () => boolean, what: string, timeoutMs = 15_000) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      if (predicate()) return;
      await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error(`timed out after ${timeoutMs}ms waiting for ${what}`);
  }

  function spawnBridge(port: number, env: Record<string, string> = {}) {
    return spawn(process.execPath, ["--import", "tsx", cliEntry, "mcp-stdio"], {
      env: { ...process.env, TANDEM_URL: `http://127.0.0.1:${port}`, ...env },
      stdio: ["pipe", "pipe", "pipe"],
    });
  }

  const INITIALIZE = {
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2024-11-05",
      clientInfo: { name: "test-harness", version: "0.0.0" },
      capabilities: { roots: { listChanged: true } },
    },
  };

  /** Drive the client half of a handshake and wait for it to complete. */
  async function handshake(
    c: ChildProcessWithoutNullStreams,
    io: ReturnType<typeof collect>,
    fake: SessionServer,
  ): Promise<void> {
    await new Promise((r) => setTimeout(r, 700));
    c.stdin.write(`${JSON.stringify(INITIALIZE)}\n`);
    await waitFor(() => responsesFor(io.stdout(), 1).length === 1, "initialize response");
    c.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
    await waitFor(() => fake.getCount() >= 1, "standalone GET attempt");
  }

  afterEach(async () => {
    child?.kill();
    child = undefined;
    if (sessionServer) {
      const s = sessionServer;
      sessionServer = undefined;
      await new Promise<void>((r) => s.close(() => r()));
    }
  });

  it("replays the handshake privately and heals the request that hit the stale session", async () => {
    const fake = await makeSessionServer();
    child = spawnBridge(fake.port);
    const io = collect(child);
    await handshake(child, io, fake);

    fake.retireSession();
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" })}\n`);

    await waitFor(() => responsesFor(io.stdout(), 2).length === 1, "healed tools/list", 25_000);
    const healed = responsesFor(io.stdout(), 2)[0];
    // The whole point: a real result, not the -32000 the bridge used to emit.
    expect(healed?.error).toBeUndefined();
    expect((healed?.result as { echo?: string })?.echo).toBe("tools/list");
    expect(fake.initCount()).toBe(2);
    expect(child.exitCode).toBeNull();

    const replay = fake.posts.find(
      (p) => p.body.method === "initialize" && String(p.body.id).startsWith("__tandem_reinit_"),
    );
    expect(replay).toBeDefined();
    // params must be replayed verbatim — a re-negotiation that quietly dropped
    // the client's declared capabilities is worse than not reconnecting.
    expect(replay?.body.params).toEqual(INITIALIZE.params);
    // ...and the original must not have been mutated on the way through.
    const original = fake.posts.find((p) => p.body.method === "initialize" && p.body.id === 1);
    expect(original?.body.id).toBe(1);
    // The replay must NOT carry the dead session id.
    expect(replay?.headers["mcp-session-id"]).toBeUndefined();

    // The private id is ours; the client must never see it, and must never see
    // a second response for the id it did issue.
    expect(io.stdout()).not.toContain("__tandem_reinit_");
    expect(responsesFor(io.stdout(), 1)).toHaveLength(1);

    // The push half. The SDK opens the standalone server→client stream ONLY
    // from the `initialized` notification's 202 branch, so a second GET is the
    // only observable proof the replay re-sent it. Without this assertion,
    // deleting that send leaves every reconnect test green while every
    // wake-driven Claude Desktop session silently loses its wake channel —
    // which is the half of #1588 that has no tool call to re-trigger on.
    await waitFor(() => fake.getCount() >= 2, "standalone GET re-opened after the heal");
  }, 60_000);

  it("forwards the auth and Claude-session headers on the replayed handshake", async () => {
    const token = "a".repeat(40);
    const fake = await makeSessionServer();
    child = spawnBridge(fake.port, {
      TANDEM_AUTH_TOKEN: token,
      // resolveClaudeSessionId only trusts the id inside a real Claude Code
      // launch, which CLAUDECODE=1 is what marks.
      CLAUDECODE: "1",
      CLAUDE_CODE_SESSION_ID: "claude-session-xyz",
    });
    const io = collect(child);
    await handshake(child, io, fake);

    fake.retireSession();
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" })}\n`);
    await waitFor(() => fake.initCount() >= 2, "replayed initialize", 25_000);

    const replay = fake.posts.find(
      (p) => p.body.method === "initialize" && String(p.body.id).startsWith("__tandem_reinit_"),
    );
    expect(replay?.headers.authorization).toBe(`Bearer ${token}`);
    expect(replay?.headers["x-claude-session-id"]).toBe("claude-session-xyz");
  }, 60_000);

  it("tells the host the tool set may have changed", async () => {
    const fake = await makeSessionServer();
    child = spawnBridge(fake.port);
    const io = collect(child);
    await handshake(child, io, fake);

    fake.retireSession();
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" })}\n`);
    await waitFor(() => responsesFor(io.stdout(), 2).length === 1, "healed request", 25_000);

    // A restart is exactly when the tool set can change, and the replay's own
    // response — which carries the new capabilities — is swallowed by design.
    const notified = io
      .lines()
      .some((m) => m.method === "notifications/tools/list_changed" && m.id === undefined);
    expect(notified).toBe(true);
  }, 60_000);

  it("fails the reconnect closed when the upstream identity changes", async () => {
    const fake = await makeSessionServer();
    child = spawnBridge(fake.port, { TANDEM_REQUEST_TIMEOUT_MS: "4000" });
    const io = collect(child);
    await handshake(child, io, fake);

    // A different process grabbed the port. Before this change a substituted
    // upstream could not complete a session at all, because the bridge never
    // re-handshaked; reconnecting turns that fail-closed into fail-open unless
    // the new server is checked against what the client agreed to.
    fake.setServerInfo({ name: "not-tandem", version: "9.9.9" });
    fake.retireSession();
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" })}\n`);

    await waitFor(() => responsesFor(io.stdout(), 2).length === 1, "failure response", 30_000);
    const answer = responsesFor(io.stdout(), 2)[0];
    expect((answer?.error as { code?: number })?.code).toBe(-32000);
    expect(io.stderr()).toContain("upstream identity changed across re-initialize");
    // Soft give-up: killing a Claude Desktop child nothing will respawn is the
    // regression this whole change exists to prevent.
    expect(child.exitCode).toBeNull();
  }, 60_000);

  it("answers a request that hit the stale session exactly once", async () => {
    // Pins the *outcome* — one response, two POSTs — not any single line.
    //
    // Deleting the `pendingRequests` entry on the 404-retry branch is the
    // natural way to write it, and alone it changes nothing here, because
    // `enqueueForReconnect` re-arms a missing timer as a structural backstop.
    // It takes removing both to lose the request outright, which is what the
    // mutation check in the PR body pairs. Do not upgrade this comment into a
    // claim about one mutation; it would not be true.
    const fake = await makeSessionServer();
    child = spawnBridge(fake.port);
    const io = collect(child);
    await handshake(child, io, fake);

    fake.retireSession();
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" })}\n`);
    await waitFor(() => responsesFor(io.stdout(), 2).length >= 1, "a response", 25_000);
    await new Promise((r) => setTimeout(r, 2_500));
    expect(responsesFor(io.stdout(), 2)).toHaveLength(1);
    // Exactly two POSTs for the one call: the 404 and the replay.
    expect(fake.posts.filter((p) => p.body.method === "tools/list")).toHaveLength(2);
  }, 60_000);

  it("heals concurrent siblings and replays the triggering request first", async () => {
    const fake = await makeSessionServer();
    child = spawnBridge(fake.port);
    const io = collect(child);
    await handshake(child, io, fake);

    fake.retireSession();
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" })}\n`);
    // Sits behind the reconnect rather than failing later with the same root
    // cause — the most confusing possible outcome, and what this eliminates.
    await new Promise((r) => setTimeout(r, 150));
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 3, method: "resources/list" })}\n`);

    await waitFor(
      () => responsesFor(io.stdout(), 2).length === 1 && responsesFor(io.stdout(), 3).length === 1,
      "both siblings healed",
      30_000,
    );
    expect(responsesFor(io.stdout(), 2)[0]?.error).toBeUndefined();
    expect(responsesFor(io.stdout(), 3)[0]?.error).toBeUndefined();

    // Trigger-first, then FIFO. A plain push would replay them the other way.
    const replayAt = fake.posts.findIndex((p) => String(p.body.id).startsWith("__tandem_reinit_"));
    const afterReplay = fake.posts
      .slice(replayAt)
      .filter((p) => p.body.id === 2 || p.body.id === 3)
      .map((p) => p.body.id);
    expect(afterReplay).toEqual([2, 3]);
  }, 60_000);

  it("does not reconnect when it never saw the client's initialize", async () => {
    const fake = await makeSessionServer();
    child = spawnBridge(fake.port, { TANDEM_REQUEST_TIMEOUT_MS: "4000" });
    const io = collect(child);
    await new Promise((r) => setTimeout(r, 700));

    // No handshake at all: the first request 404s because it carries no session
    // id. Guessing a handshake is worse than failing one.
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 9, method: "tools/list" })}\n`);
    await waitFor(() => responsesFor(io.stdout(), 9).length === 1, "failure response", 25_000);

    expect((responsesFor(io.stdout(), 9)[0]?.error as { code?: number })?.code).toBe(-32000);
    expect(io.stderr()).toContain("no client initialize was captured");
    expect(fake.initCount()).toBe(0);
    expect(child.exitCode).toBeNull();
  }, 60_000);

  it("recovers after a replayed handshake the server accepts and never answers", async () => {
    const fake = await makeSessionServer();
    // The replay deadline is min(request timeout, 15s) — shrink both together.
    child = spawnBridge(fake.port, { TANDEM_REQUEST_TIMEOUT_MS: "3000" });
    const io = collect(child);
    await handshake(child, io, fake);

    // A wedged server event loop (a large .docx import) accepts the POST and
    // never answers. Without a deadline `reconnecting` latches forever: every
    // later request queues and times out, and the bridge never recovers even
    // once the server returns. That is strictly worse than the original bug.
    fake.stallInitializes(1);
    fake.retireSession();
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" })}\n`);
    // Wait on the deadline itself, not on the -32000: the request's own timer
    // is shorter than backoff-plus-deadline, so it answers first.
    await waitFor(
      () => io.stderr().includes("re-initialize timed out"),
      "the replay deadline to fire",
      30_000,
    );
    expect((responsesFor(io.stdout(), 2)[0]?.error as { code?: number })?.code).toBe(-32000);
    expect(child.exitCode).toBeNull();

    // A failed reconnect must leave a *live* transport installed, not the
    // closed old one. This is why `http = fresh` is assigned before the
    // handshake rather than on success: every send() on a closed transport
    // rejects with an AbortError, which carries no `.code`, so nothing would
    // recognise it as a stale session and the request would never reach the
    // server at all. Here it does reach it — and 404s, which re-triggers.
    const postsBefore = fake.posts.filter((p) => p.body.method === "tools/list").length;
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 8, method: "tools/list" })}\n`);
    await waitFor(
      () => fake.posts.filter((p) => p.body.method === "tools/list").length > postsBefore,
      "the post-failure request to actually reach the server",
      15_000,
    );

    // The armed retry heals it with no further client traffic at all — which
    // is the only thing that can rescue a purely-listening client, one with no
    // tool calls to re-trigger on. Without it that client's wake channel stays
    // dark until the host restarts.
    await waitFor(
      () => io.stderr().includes("upstream session re-initialized"),
      "the backoff retry to heal it unprompted",
      40_000,
    );

    // ...and the bridge is usable again.
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 3, method: "tools/list" })}\n`);
    await waitFor(
      () => responsesFor(io.stdout(), 3).length === 1,
      "recovery after the deadline",
      40_000,
    );
    expect(responsesFor(io.stdout(), 3)[0]?.error).toBeUndefined();
  }, 120_000);

  it("heals a purely-listening client from the lost SSE stream alone", async () => {
    // The #1588 user, end to end and with **no client traffic at all**. A
    // desktop session that is attached and quiet has no tool call to 404 and
    // therefore nothing to notice a dead session with; the terminal SSE error
    // is its only trigger. Every other test in this describe reaches the
    // reconnect through a POST 404, and the fakes answer GET with 405, so
    // until this test the path that serves that user was covered only by unit
    // tests on a predicate.
    const fake = await makeSessionServer({ sse: true });
    child = spawnBridge(fake.port);
    const io = collect(child);
    await handshake(child, io, fake);
    expect(fake.initCount()).toBe(1);

    // Kill the stream and refuse the SDK's two retries, which is what makes it
    // emit `Maximum reconnection attempts (2) exceeded.` — the bridge's
    // primary trigger. The third GET succeeds, so the healed session gets its
    // push channel back.
    fake.breakStandaloneStream(2);

    await waitFor(
      () => io.stderr().includes("upstream session re-initialized"),
      "the lost stream alone to drive a heal",
      40_000,
    );
    expect(fake.initCount()).toBe(2);
    expect(child.exitCode).toBeNull();
    // The replayed handshake re-opened the stream: GET #1 (handshake), #2 and
    // #3 (the refused retries), #4 (after the heal).
    await waitFor(() => fake.getCount() >= 4, "the standalone stream to re-open");
    expect(io.stdout()).not.toContain("__tandem_reinit_");
  }, 90_000);

  it("never writes a late replay answer to stdout after the deadline gave up", async () => {
    const fake = await makeSessionServer();
    child = spawnBridge(fake.port, { TANDEM_REQUEST_TIMEOUT_MS: "3000" });
    const io = collect(child);
    await handshake(child, io, fake);

    // Same wedged server as above, but this one un-wedges. The failed
    // transport stays installed as `http` — closing it would fire onclose and
    // kill the bridge — so its still-open POST can be answered seconds after
    // `pendingReplayId` was nulled. Swallowing by id-equality would let that
    // answer take the ordinary path onto stdout, where the host SDK reports
    // `Received a response for an unknown message ID`. The id is ours whether
    // or not anyone is still waiting for it.
    fake.stallInitializes(1);
    fake.retireSession();
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" })}\n`);
    await waitFor(
      () => io.stderr().includes("re-initialize timed out"),
      "the replay deadline to fire",
      30_000,
    );

    expect(fake.releaseStalledInitializes()).toBe(1);
    // Long enough for the answer to travel and be (mis)handled.
    await new Promise((r) => setTimeout(r, 1_500));

    expect(io.stdout()).not.toContain("__tandem_reinit_");
    expect(child.exitCode).toBeNull();
  }, 60_000);

  it("still heals on the fifth restart in a row", async () => {
    // Regression test for the sliding-window retry budget an earlier draft
    // carried: it would have refused this reconnect outright, leaving the
    // bridge permanently inert after a handful of `dev:server` saves.
    const fake = await makeSessionServer();
    child = spawnBridge(fake.port);
    const io = collect(child);
    await handshake(child, io, fake);

    for (let i = 0; i < 5; i += 1) {
      const id = 100 + i;
      fake.retireSession();
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method: "tools/list" })}\n`);
      await waitFor(
        () => responsesFor(io.stdout(), id).length === 1,
        `heal on cycle ${i + 1}`,
        40_000,
      );
      expect(responsesFor(io.stdout(), id)[0]?.error).toBeUndefined();
    }
    expect(fake.initCount()).toBe(6);
    expect(child.exitCode).toBeNull();
  }, 180_000);

  it("escalates the backoff against a server that keeps killing the session", async () => {
    // A backoff, not a hot loop. Sessions here are seconds old, so every
    // attempt takes the escalate branch.
    const fake = await makeSessionServer();
    child = spawnBridge(fake.port, { TANDEM_REQUEST_TIMEOUT_MS: "2000" });
    const io = collect(child);
    await handshake(child, io, fake);

    fake.stallInitializes(10);
    fake.retireSession();
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" })}\n`);

    await waitFor(
      () => /re-initializing in 4000ms/.test(io.stderr()),
      "the backoff to reach 4000ms",
      60_000,
    );
    const delays = [...io.stderr().matchAll(/re-initializing in (\d+)ms/g)].map((m) =>
      Number(m[1]),
    );
    // Monotonic doubling from 1s, never a reset back to 1s. A stale
    // `lastSessionOpenedAt` surviving a failure is what used to reopen that
    // sawtooth and hammer a down server at roughly one attempt per second.
    expect(delays.slice(0, 3)).toEqual([1_000, 2_000, 4_000]);
    expect(child.exitCode).toBeNull();
  }, 120_000);

  it("exits promptly once stdin closes with a retry timer armed", async () => {
    // Every reconnect timer is .unref()'d and cleared in shutdown(); an orphan
    // would show up as a child that outlives its own stdin.
    const fake = await makeSessionServer();
    child = spawnBridge(fake.port, { TANDEM_REQUEST_TIMEOUT_MS: "2000" });
    const io = collect(child);
    await handshake(child, io, fake);

    fake.stallInitializes(10);
    fake.retireSession();
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" })}\n`);
    await waitFor(() => /re-initializing in 2000ms/.test(io.stderr()), "a retry armed", 60_000);

    const c = child;
    const started = Date.now();
    c.stdin.end();
    await new Promise<void>((r) => c.once("exit", () => r()));
    expectWithinMs(Date.now() - started, 3_000, "the bridge exits promptly on stdin end");
  }, 120_000);
});
