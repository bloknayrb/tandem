import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { createServer, type Server, type ServerResponse } from "node:http";
import { connect as netConnect } from "node:net";
import { resolve } from "node:path";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

/**
 * #2422: Tandem's own programs never send a loopback request through an
 * environment proxy.
 *
 * Each of the stdio bridge, the channel shim and the monitor is the REAL
 * program, started in its own process with Node's environment proxy on and
 * `HTTP_PROXY` naming a recording `CONNECT` tunnel. The proxy variables must be
 * on the CHILD: Node fixes its dispatcher at start-up, so setting them in this
 * process proves nothing. A control child (a bare global `fetch`) first proves
 * the tunnel really does see a `CONNECT` under these variables, so a clean run
 * means the program avoided the proxy rather than that the harness could not
 * show one.
 */

const TOKEN = "tok_Loopback2422_AbCdEfGhIjKlMnOpQrStUvWx";
const root = resolve(__dirname, "../..");
const entries = {
  bridge: ["src/cli/index.ts", "mcp-stdio"],
  shim: ["src/channel/index.ts"],
  monitor: ["src/monitor/index.ts"],
} as const;

/** Node's environment proxy exists from 22.21 (earlier lines ignore the variable). */
function nodeHonoursEnvProxy(): boolean {
  const [maj = 0, min = 0] = process.versions.node.split(".").map(Number);
  return maj > 22 || (maj === 22 && min >= 21);
}
const suite = nodeHonoursEnvProxy() ? describe : describe.skip;

interface Seen {
  method: string;
  url: string;
  authorization?: string;
}

const children: ChildProcessWithoutNullStreams[] = [];
const servers: Server[] = [];

afterEach(async () => {
  for (const c of children.splice(0)) c.kill();
  for (const s of servers.splice(0)) {
    s.closeAllConnections?.();
    await new Promise<void>((r) => s.close(() => r()));
  }
});

const EVENT = {
  id: "evt_1",
  type: "annotation:created",
  timestamp: 1,
  documentId: "doc1",
  payload: {
    annotationId: "a1",
    annotationType: "comment",
    content: "c",
    textSnippet: "s",
    hasSuggestedText: false,
  },
};

/**
 * A fake Tandem. `/api/events` opens a stream and, once it is open, sends one
 * event after a delay: arrival of that event proves the SSE body streams.
 */
async function makeUpstream(host = "127.0.0.1") {
  const seen: Seen[] = [];
  const streams = new Set<ServerResponse>();
  let session = 0;
  const server = createServer((req, res) => {
    const url = req.url ?? "";
    seen.push({
      method: req.method ?? "",
      url,
      authorization: req.headers.authorization,
    });
    if (url.startsWith("/api/events")) {
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.write(":open\n\n");
      streams.add(res);
      res.on("close", () => streams.delete(res));
      setTimeout(() => res.write(`id: evt_1\ndata: ${JSON.stringify(EVENT)}\n\n`), 400);
      return;
    }
    if (url.startsWith("/api/mode")) {
      res.writeHead(200, { "Content-Type": "application/json" }).end('{"mode":"tandem"}');
      return;
    }
    if (url === "/mcp" && req.method === "POST") {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
          id?: number;
          method?: string;
        };
        if (body.method === "initialize") {
          session += 1;
          res.writeHead(200, {
            "Content-Type": "application/json",
            "mcp-session-id": `s${session}`,
          });
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
        res.writeHead(202).end();
      });
      return;
    }
    res.writeHead(200, { "Content-Type": "application/json" }).end("{}");
  });
  servers.push(server);
  await new Promise<void>((r, reject) => {
    server.once("error", reject);
    server.listen(0, host, () => r());
  });
  const addr = server.address();
  if (!addr || typeof addr === "string") throw new Error("address");
  const base = host === "::1" ? `http://[::1]:${addr.port}` : `http://127.0.0.1:${addr.port}`;
  return { base, port: addr.port, seen };
}

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

function childEnv(extra: Record<string, string | undefined>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const k of [
    // The monitor's entry skips its auto-run under vitest.
    "VITEST",
    "NODE_USE_ENV_PROXY",
    "NODE_OPTIONS",
    "HTTP_PROXY",
    "http_proxy",
    "HTTPS_PROXY",
    "https_proxy",
    "NO_PROXY",
    "no_proxy",
    "TANDEM_URL",
    "CLAUDE_PLUGIN_OPTION_SERVER_URL",
    "CLAUDE_PLUGIN_OPTION_AUTH_TOKEN",
    "TANDEM_AUTH_TOKEN",
    "TANDEM_OWNER_HANDLE",
    "TANDEM_OWNER_HANDLE_URL",
  ]) {
    delete env[k];
  }
  for (const [k, v] of Object.entries(extra)) {
    if (v !== undefined) env[k] = v;
  }
  return env;
}

function start(args: readonly string[], env: NodeJS.ProcessEnv) {
  const c = spawn(process.execPath, ["--import", "tsx", ...args], {
    cwd: root,
    env,
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
  return {
    c,
    stdout: () => out,
    stderr: () => err,
    send: (msg: unknown) => c.stdin.write(`${JSON.stringify(msg)}\n`),
  };
}

async function waitFor(predicate: () => boolean, what: string, ms = 25_000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
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

type Kind = keyof typeof entries;
type ProxyStyle = "env-var" | "node-options";

/** Start `kind` against a fake upstream with the environment proxy on. */
async function run(kind: Kind, style: ProxyStyle, host = "127.0.0.1") {
  const up = await makeUpstream(host);
  const tunnel = await makeTunnel();
  const env = childEnv({
    TANDEM_URL: up.base,
    TANDEM_AUTH_TOKEN: TOKEN,
    // The bridge sends the token only to the default port or this one.
    TANDEM_MCP_PORT: String(up.port),
    HTTP_PROXY: tunnel.url,
    ...(style === "env-var" ? { NODE_USE_ENV_PROXY: "1" } : { NODE_OPTIONS: "--use-env-proxy" }),
  });
  const p = start(entries[kind], env);
  if (kind === "bridge") {
    await new Promise((r) => setTimeout(r, 700));
    p.send(INITIALIZE);
    await waitFor(() => p.stdout().includes('"id":1'), "the bridge's initialize response");
  } else if (kind === "shim") {
    await new Promise((r) => setTimeout(r, 700));
    p.send(INITIALIZE);
    await waitFor(() => p.stdout().includes("annotation:created"), "the pushed event");
  } else {
    await waitFor(() => p.stdout().includes("annotation:created"), "the pushed event");
  }
  return { up, tunnel, p };
}

suite("loopback requests never use an environment proxy (#2422)", () => {
  beforeAll(async () => {
    // The control: with these variables a bare global fetch IS proxied.
    const up = await makeUpstream();
    const tunnel = await makeTunnel();
    const c = spawn(
      process.execPath,
      [
        "-e",
        `fetch(${JSON.stringify(`${up.base}/health`)}).then(()=>process.exit(0),()=>process.exit(0))`,
      ],
      {
        env: childEnv({ NODE_USE_ENV_PROXY: "1", HTTP_PROXY: tunnel.url }),
        stdio: "ignore",
      },
    );
    await new Promise<void>((r) => c.once("exit", () => r()));
    expect(tunnel.connects, "the harness must be able to show a proxied request").toContain(
      `127.0.0.1:${up.port}`,
    );
  }, 30_000);

  it.each(["bridge", "shim", "monitor"] as const)(
    "%s: no CONNECT, the upstream gets the Authorization header, and the SSE stream streams",
    async (kind) => {
      const { up, tunnel } = await run(kind, "env-var");
      expect(tunnel.connects).toEqual([]);
      expect(up.seen.length).toBeGreaterThan(0);
      const carrying = up.seen.filter((s) =>
        s.url.startsWith(kind === "bridge" ? "/mcp" : "/api/events"),
      );
      expect(carrying.length).toBeGreaterThan(0);
      for (const s of carrying) expect(s.authorization).toBe(`Bearer ${TOKEN}`);
    },
    60_000,
  );

  it("bridge: --use-env-proxy in NODE_OPTIONS makes no difference", async () => {
    const { up, tunnel } = await run("bridge", "node-options");
    expect(tunnel.connects).toEqual([]);
    expect(up.seen.find((s) => s.url === "/mcp")?.authorization).toBe(`Bearer ${TOKEN}`);
  }, 60_000);

  it("bridge: a [::1] base URL; skipped where the host has no IPv6", async (ctx) => {
    let result: Awaited<ReturnType<typeof run>>;
    try {
      await makeUpstream("::1");
    } catch {
      ctx.skip();
      return;
    }
    result = await run("bridge", "env-var", "::1");
    expect(result.tunnel.connects).toEqual([]);
    expect(result.up.seen.find((s) => s.url === "/mcp")?.authorization).toBe(`Bearer ${TOKEN}`);
  }, 60_000);
});
