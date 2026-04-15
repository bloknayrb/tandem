import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getRequestId } from "../../src/cli/mcp-stdio.js";

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

    const stdoutChunks: string[] = [];
    child.stdout.on("data", (c: Buffer) => stdoutChunks.push(c.toString("utf8")));
    const stderrChunks: string[] = [];
    child.stderr.on("data", (c: Buffer) => stderrChunks.push(c.toString("utf8")));

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

    // Wait for a response on stdout (or fail the test).
    const response = await new Promise<string>((resolveResp, rejectResp) => {
      const timer = setTimeout(() => {
        rejectResp(
          new Error(
            `no stdout within 10s. stderr=${stderrChunks.join("")} stdout=${stdoutChunks.join("")}`,
          ),
        );
      }, 10_000);
      const checker = setInterval(() => {
        const joined = stdoutChunks.join("");
        const nl = joined.indexOf("\n");
        if (nl >= 0) {
          clearTimeout(timer);
          clearInterval(checker);
          resolveResp(joined.slice(0, nl));
        }
      }, 50);
    });

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
