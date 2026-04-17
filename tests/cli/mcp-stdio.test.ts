import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getRequestId, getResponseId } from "../../src/cli/mcp-stdio.js";

/** Read one newline-delimited line from the child's stdout with a timeout,
 *  capturing stderr for diagnostic context on failure. */
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
  // Covers issue #336: the stdio bridge must reply with a JSON-RPC -32000
  // error for any in-flight request when the upstream is unavailable, rather
  // than closing stdio silently (which surfaces as "tools never appear" with
  // no diagnostic in the plugin host).

  let child: ChildProcessWithoutNullStreams | undefined;

  afterEach(() => {
    child?.kill();
    child = undefined;
  });

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

      // Let the bridge finish its preflight + http.start() handshake.
      await new Promise((r) => setTimeout(r, 600));

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
      for (let i = 0; i < 50; i++) {
        if (held) break;
        await new Promise((r) => setTimeout(r, 50));
      }
      // Destroy the held response — the mcp-stdio bridge sees this as
      // upstream-closed-unexpectedly. Server close happens in finally.
      held?.destroy();

      const line = await readOneLine(child);
      const parsed = JSON.parse(line) as {
        id: number;
        error?: { code: number; message: string };
      };
      expect(parsed.id).toBe(77);
      expect(parsed.error?.code).toBe(-32000);
      expect(parsed.error?.message).toMatch(/closed|unreachable/i);
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  }, 30_000);
});
