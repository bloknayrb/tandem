import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { createServer, type Server, type ServerResponse } from "node:http";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

/**
 * The stdio bridge cancels upstream every request it answers itself (#2358,
 * ADR-054 as amended 2026-11-23). Without it, a write the client was told had
 * failed could still wait in a document's operation queue and run up to the
 * 20-second wait bound later, so a retry lands twice.
 *
 * One test per self-answered path a fake upstream can drive: the request
 * timer, a session swap, and a send that fails after the server has the
 * request. Each asserts exactly one `notifications/cancelled`, for the right
 * id, on the session the request was POSTed on, and none for a request the
 * server answered or provably never dispatched.
 */

const cliEntry = resolve(__dirname, "../../src/cli/index.ts");

interface Post {
  body: Record<string, unknown>;
  session: string | undefined;
}

interface Fake {
  port: number;
  posts: Post[];
  /** Forget the live session — later requests carrying it get 404 -32001. */
  retireSession(): void;
  /** The `notifications/cancelled` POSTs received, in order. */
  cancels(): Post[];
  /** Advertise another server name, so the bridge's next re-initialize fails closed. */
  renameServer(name: string): void;
}

let child: ChildProcessWithoutNullStreams | undefined;
let server: Server | undefined;
const held: ServerResponse[] = [];

afterEach(async () => {
  child?.kill();
  child = undefined;
  held.splice(0);
  if (server) {
    const s = server;
    server = undefined;
    s.closeAllConnections();
    await new Promise<void>((r) => s.close(() => r()));
  }
});

/**
 * A fake HTTP MCP upstream with real session semantics. A `tools/call` named
 * `hold` is accepted and never answered (a call waiting in a busy document's
 * queue); one named `drop` has its connection destroyed after the server read
 * it. Every other request is answered.
 */
async function makeFake(): Promise<Fake> {
  const posts: Post[] = [];
  let live: string | undefined;
  let minted = 0;
  let serverName = "fake-tandem";
  server = createServer((req, res) => {
    if (req.method === "GET" && req.url === "/health") {
      res.writeHead(200, { "Content-Type": "text/plain" });
      res.end("ok");
      return;
    }
    if (req.method === "GET" && req.url === "/mcp") {
      res.writeHead(405);
      res.end();
      return;
    }
    if (req.method !== "POST" || req.url !== "/mcp") {
      res.writeHead(404);
      res.end();
      return;
    }
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
      const presented = req.headers["mcp-session-id"];
      posts.push({ body, session: typeof presented === "string" ? presented : undefined });
      const id = body.id as string | number | undefined;
      if (body.method === "initialize") {
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
              serverInfo: { name: serverName, version: "0.0.0-test" },
            },
          }),
        );
        return;
      }
      if (live === undefined || presented !== live) {
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
      const name = (body.params as { name?: string } | undefined)?.name;
      if (body.method === "tools/call" && name === "hold") {
        held.push(res);
        return;
      }
      if (body.method === "tools/call" && name === "drop") {
        req.socket.destroy();
        return;
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ jsonrpc: "2.0", id, result: { echo: body.method } }));
    });
  });
  await new Promise<void>((r) => (server as Server).listen(0, "127.0.0.1", r));
  const addr = (server as Server).address();
  if (!addr || typeof addr === "string") throw new Error("server.address() unexpected");
  return {
    port: addr.port,
    posts,
    retireSession: () => {
      live = undefined;
    },
    cancels: () => posts.filter((p) => p.body.method === "notifications/cancelled"),
    renameServer: (name) => {
      serverName = name;
    },
  };
}

function spawnBridge(port: number, env: Record<string, string> = {}) {
  const c = spawn(process.execPath, ["--import", "tsx", cliEntry, "mcp-stdio"], {
    env: { ...process.env, TANDEM_URL: `http://127.0.0.1:${port}`, ...env },
    stdio: ["pipe", "pipe", "pipe"],
  });
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
    child: c,
    stdout: () => out,
    stderr: () => err,
    responsesFor: (id: number) => lines().filter((m) => m.id === id),
    send: (msg: Record<string, unknown>) => c.stdin.write(`${JSON.stringify(msg)}\n`),
  };
}

async function waitFor(predicate: () => boolean, what: string, timeoutMs = 15_000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`timed out after ${timeoutMs}ms waiting for ${what}`);
}

const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function handshake(io: ReturnType<typeof spawnBridge>): Promise<void> {
  await pause(700);
  io.send({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2024-11-05",
      clientInfo: { name: "test-harness", version: "0.0.0" },
      capabilities: {},
    },
  });
  await waitFor(() => io.responsesFor(1).length === 1, "initialize response");
  io.send({ jsonrpc: "2.0", method: "notifications/initialized" });
}

const call = (id: number, name: string) => ({
  jsonrpc: "2.0",
  id,
  method: "tools/call",
  params: { name, arguments: {} },
});

const errorOf = (m: Record<string, unknown> | undefined) =>
  m?.error as { code?: number; message?: string } | undefined;

describe("the stdio bridge cancels upstream what it answers itself", () => {
  it("its request timer: one cancellation for that id, on the session it was sent on", async () => {
    const fake = await makeFake();
    const io = spawnBridge(fake.port, { TANDEM_REQUEST_TIMEOUT_MS: "1500" });
    child = io.child;
    await handshake(io);

    // Answered by the server: never cancelled.
    io.send({ jsonrpc: "2.0", id: 2, method: "tools/list" });
    await waitFor(() => io.responsesFor(2).length === 1, "tools/list answer");

    io.send(call(3, "hold"));
    await waitFor(() => io.responsesFor(3).length === 1, "the timer's answer");
    expect(errorOf(io.responsesFor(3)[0])?.message).toMatch(/half-open/);
    await waitFor(() => fake.cancels().length >= 1, "the cancellation");
    await pause(500);

    const cancels = fake.cancels();
    expect(cancels).toHaveLength(1);
    expect(cancels[0].body.params).toMatchObject({ requestId: 3 });
    expect(String((cancels[0].body.params as { reason?: unknown }).reason)).toMatch(/timer/);
    expect(cancels[0].session).toBe("sess-1");
    expect(cancels[0].body.id).toBeUndefined();
    // Stdout carries only the client's own frames: no cancellation leaks there.
    expect(io.stdout()).not.toContain("notifications/cancelled");
    expect(io.responsesFor(3)).toHaveLength(1);
  }, 30_000);

  it("a session swap: the in-flight request is cancelled on its old session, the replayed one never", async () => {
    const fake = await makeFake();
    const io = spawnBridge(fake.port);
    child = io.child;
    await handshake(io);

    io.send(call(2, "hold"));
    await waitFor(
      () => fake.posts.some((p) => p.body.id === 2),
      "the held call to reach the server",
    );
    // The next request 404s -32001 (provably never dispatched), which swaps
    // the session; the swap answers the held call at once.
    fake.retireSession();
    io.send({ jsonrpc: "2.0", id: 3, method: "tools/list" });

    await waitFor(() => io.responsesFor(2).length === 1, "the swap's answer", 25_000);
    expect(errorOf(io.responsesFor(2)[0])?.message).toMatch(/session was replaced/);
    await waitFor(() => io.responsesFor(3).length === 1, "the replayed request's answer", 25_000);
    expect(errorOf(io.responsesFor(3)[0])).toBeUndefined();
    await waitFor(() => fake.cancels().length >= 1, "the cancellation");
    await pause(500);

    const cancels = fake.cancels();
    expect(cancels).toHaveLength(1);
    expect(cancels[0].body.params).toMatchObject({ requestId: 2 });
    expect(cancels[0].session).toBe("sess-1");
    expect(io.stdout()).not.toContain("notifications/cancelled");
  }, 60_000);

  it("a send that fails after the server read the request: one cancellation, on the live session", async () => {
    const fake = await makeFake();
    const io = spawnBridge(fake.port);
    child = io.child;
    await handshake(io);

    io.send(call(2, "drop"));
    await waitFor(() => io.responsesFor(2).length === 1, "the bridge's own answer");
    expect(errorOf(io.responsesFor(2)[0])?.message).toMatch(/unreachable/);
    await waitFor(() => fake.cancels().length >= 1, "the cancellation");
    await pause(500);

    const cancels = fake.cancels();
    expect(cancels).toHaveLength(1);
    expect(cancels[0].body.params).toMatchObject({ requestId: 2 });
    expect(cancels[0].session).toBe("sess-1");
  }, 30_000);

  it("a request refused 404 -32001 is never cancelled, even when the bridge answers it later", async () => {
    const fake = await makeFake();
    const io = spawnBridge(fake.port);
    child = io.child;
    await handshake(io);

    // The request is refused before dispatch and queued for replay; the
    // re-initialize then fails closed, and the bridge answers it itself.
    fake.retireSession();
    fake.renameServer("not-tandem");
    io.send(call(2, "edit"));

    await waitFor(
      () => io.responsesFor(2).length === 1,
      "the failed re-initialize's answer",
      25_000,
    );
    expect(errorOf(io.responsesFor(2)[0])?.message).toMatch(/session lost/);
    expect(io.stderr()).toContain("identity changed");
    await pause(500);
    // The server never held it, so there is nothing to cancel.
    expect(fake.cancels()).toHaveLength(0);
  }, 60_000);
});
