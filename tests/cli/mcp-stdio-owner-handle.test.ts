import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import {
  createServer,
  type IncomingHttpHeaders,
  type Server,
  type ServerResponse,
} from "node:http";
import { connect as netConnect } from "node:net";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  OWNER_HANDLE_ENV,
  OWNER_HANDLE_HEADER,
  OWNER_HANDLE_URL_ENV,
} from "../../src/shared/owner-handle.js";

/**
 * The bridge presents the owner handle only to the server that named it
 * (#2358 PR 3a, Requirement 2). The real bridge (`tandem mcp-stdio`) against a
 * fake upstream that records every request's headers: the header rides the
 * first `initialize`, a later request and the re-initialize after a 404, and
 * is absent for every destination R2.2 refuses. Its stderr never carries the
 * handle (R2.5) — checked in the same runs that show the header was sent.
 */

const cliEntry = resolve(__dirname, "../../src/cli/index.ts");
const HANDLE = `th_${"Ab3_-".repeat(6)}xy`;
const HEADER = OWNER_HANDLE_HEADER.toLowerCase();

interface Seen {
  method: string;
  rpc?: string;
  headers: IncomingHttpHeaders;
}

const children: ChildProcessWithoutNullStreams[] = [];
const servers: Server[] = [];
let server: Server | undefined;

afterEach(async () => {
  for (const c of children.splice(0)) c.kill();
  for (const s of servers.splice(0)) {
    s.closeAllConnections?.();
    await new Promise<void>((r) => s.close(() => r()));
  }
  server = undefined;
});

/** A fake Tandem that records every request's headers and can expire the session. */
async function makeUpstream(host = "127.0.0.1") {
  const seen: Seen[] = [];
  let live: string | undefined;
  let minted = 0;
  let failNext = false;
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
      if (failNext) {
        failNext = false;
        res.writeHead(500, { "Content-Type": "text/plain" });
        res.end("upstream exploded");
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
  servers.push(server);
  await new Promise<void>((r, reject) => {
    server?.once("error", reject);
    server?.listen(0, host, () => r());
  });
  const addr = server.address();
  if (!addr || typeof addr === "string") throw new Error("address");
  return {
    port: addr.port,
    seen,
    /** The next session-bound POST answers 500 (an upstream error). */
    failOnce: () => {
      failNext = true;
    },
    /** As a restarted server: the session is gone and its stream ends. */
    expire: () => {
      live = undefined;
      for (const s of streams) s.end();
    },
  };
}

function spawnBridge(env: Record<string, string | undefined>) {
  const base: NodeJS.ProcessEnv = { ...process.env };
  for (const k of [
    OWNER_HANDLE_ENV,
    OWNER_HANDLE_URL_ENV,
    "CLAUDE_PLUGIN_OPTION_SERVER_URL",
    "TANDEM_URL",
  ]) {
    delete base[k];
  }
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) delete base[k];
    else base[k] = v;
  }
  const c = spawn(process.execPath, ["--import", "tsx", cliEntry, "mcp-stdio"], {
    env: base,
    stdio: ["pipe", "pipe", "pipe"],
  });
  children.push(c);
  let out = "";
  let err = "";
  c.stdout.on("data", (b: Buffer) => {
    out += b.toString("utf8");
  });
  c.stderr.on("data", (b: Buffer) => {
    err += b.toString("utf8");
  });
  const responded = (id: number) =>
    out
      .split("\n")
      .filter((l) => l.trim())
      .some((l) => (JSON.parse(l) as { id?: number }).id === id);
  const send = (msg: unknown) => c.stdin.write(`${JSON.stringify(msg)}\n`);
  return { c, send, responded, stderr: () => err };
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

/** Start a bridge, run its initialize, and return what the upstream saw. */
async function initializeThrough(env: Record<string, string | undefined>, up: { seen: Seen[] }) {
  const bridge = spawnBridge(env);
  await new Promise((r) => setTimeout(r, 700));
  bridge.send(INITIALIZE);
  await waitFor(() => bridge.responded(1), "initialize");
  const init = up.seen.find((s) => s.rpc === "initialize");
  return { bridge, init };
}

describe("the bridge's owner handle (R2)", () => {
  it("rides the first initialize, a later request and the re-initialize after a 404; stderr never carries it", async () => {
    const up = await makeUpstream();
    const url = `http://127.0.0.1:${up.port}`;
    const { bridge } = await initializeThrough(
      { TANDEM_URL: url, [OWNER_HANDLE_URL_ENV]: url, [OWNER_HANDLE_ENV]: HANDLE },
      up,
    );
    bridge.send({ jsonrpc: "2.0", method: "notifications/initialized" });
    bridge.send({ jsonrpc: "2.0", id: 2, method: "tools/list" });
    await waitFor(() => bridge.responded(2), "a later request");
    // An upstream error (a 500), then a restarted server (a 404 → re-initialize).
    up.failOnce();
    bridge.send({ jsonrpc: "2.0", id: 3, method: "tools/list" });
    await waitFor(() => bridge.responded(3), "the errored request");
    up.expire();
    bridge.send({ jsonrpc: "2.0", id: 4, method: "tools/list" });
    await waitFor(() => bridge.responded(4), "the call after a re-initialize");

    const inits = up.seen.filter((s) => s.rpc === "initialize");
    expect(inits.length).toBeGreaterThanOrEqual(2);
    for (const s of up.seen) expect(s.headers[HEADER], `${s.method} ${s.rpc}`).toBe(HANDLE);
    expect(up.seen.some((s) => s.rpc === "tools/list")).toBe(true);
    // Not vacuous: the header WAS sent above, and the bridge did print lines.
    expect(bridge.stderr().length).toBeGreaterThan(0);
    expect(bridge.stderr()).not.toContain(HANDLE);
    expect(bridge.stderr()).not.toContain("th_");
  }, 60_000);

  it("is sent when the two URLs differ only in what resolveTandemUrl normalizes", async () => {
    const up = await makeUpstream();
    const url = `http://127.0.0.1:${up.port}`;
    const { init } = await initializeThrough(
      { TANDEM_URL: `${url}/`, [OWNER_HANDLE_URL_ENV]: `  ${url}//`, [OWNER_HANDLE_ENV]: HANDLE },
      up,
    );
    expect(init?.headers[HEADER]).toBe(HANDLE);
  }, 30_000);

  it.each([
    ["unset", undefined],
    ["empty", ""],
    ["malformed (short)", "th_short"],
    ["malformed (33 chars)", `${HANDLE}A`],
    ["malformed (bad character)", `th_${"a".repeat(31)}!`],
  ])(
    "is absent when the handle is %s, and the bridge prints nothing about it",
    async (_n, value) => {
      const up = await makeUpstream();
      const url = `http://127.0.0.1:${up.port}`;
      const { bridge, init } = await initializeThrough(
        { TANDEM_URL: url, [OWNER_HANDLE_URL_ENV]: url, [OWNER_HANDLE_ENV]: value },
        up,
      );
      expect(init).toBeDefined();
      expect(init?.headers[HEADER]).toBeUndefined();
      if (value) expect(bridge.stderr()).not.toContain(value);
    },
    30_000,
  );

  it("is absent when CLAUDE_PLUGIN_OPTION_SERVER_URL points at another loopback port: that port receives no handle", async () => {
    const named = await makeUpstream();
    const other = await makeUpstream();
    const { init } = await initializeThrough(
      {
        TANDEM_URL: `http://127.0.0.1:${named.port}`,
        [OWNER_HANDLE_URL_ENV]: `http://127.0.0.1:${named.port}`,
        CLAUDE_PLUGIN_OPTION_SERVER_URL: `http://127.0.0.1:${other.port}`,
        [OWNER_HANDLE_ENV]: HANDLE,
      },
      other,
    );
    expect(init).toBeDefined();
    for (const s of other.seen) expect(s.headers[HEADER]).toBeUndefined();
    expect(named.seen).toEqual([]);
  }, 30_000);

  it("is absent when the launcher's URL variable is missing", async () => {
    const up = await makeUpstream();
    const { init } = await initializeThrough(
      { TANDEM_URL: `http://127.0.0.1:${up.port}`, [OWNER_HANDLE_ENV]: HANDLE },
      up,
    );
    expect(init?.headers[HEADER]).toBeUndefined();
  }, 30_000);

  it("is absent when the named URL is localhost, even though it reaches the same server", async () => {
    const up = await makeUpstream();
    const url = `http://localhost:${up.port}`;
    const bridge = spawnBridge({
      TANDEM_URL: url,
      [OWNER_HANDLE_URL_ENV]: url,
      [OWNER_HANDLE_ENV]: HANDLE,
    });
    await new Promise((r) => setTimeout(r, 700));
    bridge.send(INITIALIZE);
    // localhost may resolve to ::1 first, where the fake does not listen; the
    // assertion is only that whatever reached it carried no handle.
    await new Promise((r) => setTimeout(r, 2_000));
    for (const s of up.seen) expect(s.headers[HEADER]).toBeUndefined();
  }, 30_000);
});

/** A CONNECT tunnel that records what it was asked to reach, then pipes. */
async function makeTunnel() {
  const connects: string[] = [];
  const proxy = createServer();
  proxy.on("connect", (req, client) => {
    const target = String(req.url);
    connects.push(target);
    const cut = target.lastIndexOf(":");
    const host = target.slice(0, cut).replace(/^\[|\]$/g, "");
    const upstream = netConnect(Number(target.slice(cut + 1)), host, () => {
      client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      upstream.pipe(client);
      client.pipe(upstream);
    });
    upstream.on("error", () => client.destroy());
    client.on("error", () => upstream.destroy());
  });
  servers.push(proxy);
  await new Promise<void>((r) => proxy.listen(0, "127.0.0.1", r));
  const addr = proxy.address();
  if (!addr || typeof addr === "string") throw new Error("address");
  return { connects, url: `http://127.0.0.1:${addr.port}` };
}

describe("Node's environment proxy (#2422): the handle rides a direct request", () => {
  it("is sent, and no CONNECT reaches the proxy, with NODE_USE_ENV_PROXY on", async () => {
    const up = await makeUpstream();
    const tunnel = await makeTunnel();
    const url = `http://127.0.0.1:${up.port}`;
    const { init } = await initializeThrough(
      {
        TANDEM_URL: url,
        [OWNER_HANDLE_URL_ENV]: url,
        [OWNER_HANDLE_ENV]: HANDLE,
        NODE_USE_ENV_PROXY: "1",
        HTTP_PROXY: tunnel.url,
        http_proxy: undefined,
        NO_PROXY: undefined,
        no_proxy: undefined,
      },
      up,
    );
    expect(tunnel.connects).toEqual([]);
    expect(init?.headers[HEADER]).toBe(HANDLE);
  }, 30_000);
});

describe("the destination rule's source (R2.2, R2.4)", () => {
  const bridgeSrc = readFileSync(resolve(__dirname, "../../src/cli/mcp-stdio.ts"), "utf8");
  const ruleSrc = readFileSync(resolve(__dirname, "../../src/shared/owner-handle.ts"), "utf8");

  it("the bridge never passes redirectPolicy, so the SDK follows same-origin redirects only", () => {
    expect(bridgeSrc).not.toMatch(/redirectPolicy\s*:/);
    const sdk = readFileSync(
      resolve(
        __dirname,
        "../../node_modules/@modelcontextprotocol/sdk/dist/esm/client/streamableHttp.js",
      ),
      "utf8",
    );
    // At the lockfile's SDK version: follow only on an explicit 'follow'.
    expect(sdk).toMatch(/_followRedirects = opts\?\.redirectPolicy === 'follow'/);
    expect(sdk).toMatch(/redirect: 'manual'/);
  });

  it("does not widen with LAN_BIND_ENABLED (it cannot be flipped in a test, so its source is pinned)", () => {
    // The rule module imports nothing at all, so it cannot read the constant
    // or call `tokenMayGoTo`; a non-loopback URL is refused by the unit vectors
    // in tests/shared/owner-handle.test.ts.
    expect(ruleSrc).not.toMatch(/^import /m);
    expect(ruleSrc).not.toMatch(/tokenMayGoTo\(/);
    expect(bridgeSrc).toMatch(/ownerHandleForUpstream\(baseUrl, process\.env\)/);
  });
});
