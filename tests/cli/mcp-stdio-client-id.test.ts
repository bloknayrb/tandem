import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import {
  createServer,
  type IncomingHttpHeaders,
  type Server,
  type ServerResponse,
} from "node:http";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { TANDEM_CLIENT_ID_HEADER } from "../../src/shared/cli-runtime.js";

/**
 * The stdio bridge's per-process client id (#2358, ADR-054; ownership design
 * §3.1 rule 2): one random id per bridge process, on every request — POST,
 * the standalone GET, DELETE, and the replayed `initialize` after a 404 — so
 * a server with ownership on keeps a bridge without a Claude session id on
 * one owner record. Sent unconditionally: the bridge bundle reads no flags.
 */

const cliEntry = resolve(__dirname, "../../src/cli/index.ts");

interface Seen {
  method: string;
  rpc?: string;
  headers: IncomingHttpHeaders;
}

let child: ChildProcessWithoutNullStreams | undefined;
let server: Server | undefined;

afterEach(async () => {
  child?.kill();
  child = undefined;
  server?.closeAllConnections?.();
  await new Promise<void>((r) => (server ? server.close(() => r()) : r()));
  server = undefined;
});

/** A fake Tandem that records every request's headers and can expire the session. */
async function makeUpstream() {
  const seen: Seen[] = [];
  let live: string | undefined;
  let minted = 0;
  const streams = new Set<ServerResponse>();
  server = createServer((req, res) => {
    if (req.url === "/health") {
      res.writeHead(200).end("ok");
      return;
    }
    if (req.method === "GET" && req.url === "/mcp") {
      seen.push({ method: "GET", headers: req.headers });
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.write(":open\n\n");
      streams.add(res);
      res.on("close", () => streams.delete(res));
      return;
    }
    if (req.method === "DELETE") {
      seen.push({ method: "DELETE", headers: req.headers });
      res.writeHead(200).end();
      return;
    }
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
        id?: number;
        method?: string;
      };
      seen.push({ method: "POST", rpc: body.method, headers: req.headers });
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
        res.writeHead(202).end();
        return;
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ jsonrpc: "2.0", id: body.id, result: { echo: body.method } }));
    });
  });
  await new Promise<void>((r) => server?.listen(0, "127.0.0.1", r));
  const addr = server.address();
  if (!addr || typeof addr === "string") throw new Error("address");
  return {
    port: addr.port,
    seen,
    /** As a restarted server: the session is gone and its stream ends. */
    expire: () => {
      live = undefined;
      for (const s of streams) s.end();
    },
  };
}

function spawnBridge(port: number) {
  const c = spawn(process.execPath, ["--import", "tsx", cliEntry, "mcp-stdio"], {
    env: { ...process.env, TANDEM_URL: `http://127.0.0.1:${port}` },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let out = "";
  c.stdout.on("data", (b: Buffer) => {
    out += b.toString("utf8");
  });
  c.stderr.on("data", () => {});
  const responded = (id: number) =>
    out
      .split("\n")
      .filter((l) => l.trim())
      .some((l) => (JSON.parse(l) as { id?: number }).id === id);
  const send = (msg: unknown) => c.stdin.write(`${JSON.stringify(msg)}\n`);
  return { c, send, responded };
}

async function waitFor(predicate: () => boolean, what: string, ms = 20_000) {
  const start = Date.now();
  while (Date.now() - start < ms) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`timed out waiting for ${what}`);
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

describe("the bridge's X-Tandem-Client-Id", () => {
  it("is the wire name the server reads", () => {
    expect(TANDEM_CLIENT_ID_HEADER.toLowerCase()).toBe("x-tandem-client-id");
  });

  it("rides every request, the replayed initialize included, with one value per process", async () => {
    const up = await makeUpstream();
    const bridge = spawnBridge(up.port);
    child = bridge.c;
    await new Promise((r) => setTimeout(r, 700));
    bridge.send(INITIALIZE);
    await waitFor(() => bridge.responded(1), "initialize");
    bridge.send({ jsonrpc: "2.0", method: "notifications/initialized" });
    await waitFor(() => up.seen.some((s) => s.method === "GET"), "the standalone stream");

    up.expire();
    bridge.send({ jsonrpc: "2.0", id: 2, method: "tools/list" });
    await waitFor(() => bridge.responded(2), "the call after a re-initialize");
    expect(up.seen.filter((s) => s.rpc === "initialize").length).toBeGreaterThanOrEqual(2);

    const ids = new Set(up.seen.map((s) => s.headers["x-tandem-client-id"]));
    expect(ids.size, JSON.stringify([...ids])).toBe(1);
    const [id] = [...ids];
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(new Set(up.seen.map((s) => s.method))).toEqual(new Set(["POST", "GET"]));

    // A second bridge process mints its own. The first is gone before the
    // second starts, and the id is read from the second's own initialize, not
    // from whatever request happens to land next (the first bridge's shutdown
    // could send one).
    const first = child;
    await new Promise<void>((r) => {
      first.once("exit", () => r());
      first.kill();
    });
    const before = up.seen.length;
    const second = spawnBridge(up.port);
    child = second.c;
    await new Promise((r) => setTimeout(r, 700));
    second.send(INITIALIZE);
    await waitFor(() => second.responded(1), "the second bridge's initialize");
    const secondId = up.seen.slice(before).find((s) => s.rpc === "initialize")?.headers[
      "x-tandem-client-id"
    ];
    expect(secondId).toMatch(/^[0-9a-f-]{36}$/);
    expect(secondId).not.toBe(id);
  }, 60_000);
});
