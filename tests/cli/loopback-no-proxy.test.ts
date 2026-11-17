import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  bareFetchThroughEnvProxy,
  childEnv,
  createRegistry,
  makeTunnel as makeRecordingTunnel,
  nodeHonoursEnvProxy,
  noIpv6,
} from "../helpers/env-proxy-recorder.js";

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
 * show one. The recorder, the child environment and the control are shared
 * with the local-model client's and the instance probe's proof
 * (`tests/helpers/env-proxy-recorder.ts`).
 */

const TOKEN = "tok_Loopback2422_AbCdEfGhIjKlMnOpQrStUvWx";
const root = resolve(__dirname, "../..");
const entries = {
  bridge: ["src/cli/index.ts", "mcp-stdio"],
  shim: ["src/channel/index.ts"],
  monitor: ["src/monitor/index.ts"],
} as const;

const suite = nodeHonoursEnvProxy() ? describe : describe.skip;

interface Seen {
  method: string;
  url: string;
  authorization?: string;
}

const reg = createRegistry();
const { servers, children } = reg;
const makeTunnel = () => makeRecordingTunnel(reg);

afterEach(() => reg.cleanup());

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
    // The channel notification itself, not any text that merely mentions the type.
    await waitFor(
      () => p.stdout().includes("notifications/claude/channel"),
      "the pushed event as a channel notification",
    );
  } else {
    await waitFor(() => p.stdout().includes("Tandem: annotation:created"), "the pushed event");
  }
  return { up, tunnel, p };
}

suite("loopback requests never use an environment proxy (#2422)", () => {
  beforeAll(async () => {
    // The control: with these variables a bare global fetch IS proxied.
    const up = await makeUpstream();
    const tunnel = await makeTunnel();
    await bareFetchThroughEnvProxy(reg, `${up.base}/health`, tunnel.url);
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

  it("control: a bare fetch to a [::1] upstream IS proxied under these variables; skipped where the host has no IPv6", async (ctx) => {
    // The [::1] twin of the control above, so a clean [::1] case below means
    // the bridge avoided the proxy, not that Node never proxies [::1].
    let up: Awaited<ReturnType<typeof makeUpstream>>;
    try {
      up = await makeUpstream("::1");
    } catch (err) {
      // Only a host with no IPv6 skips; any other failure is a failure.
      if (!noIpv6(err)) throw err;
      ctx.skip();
      return;
    }
    const tunnel = await makeTunnel();
    await bareFetchThroughEnvProxy(reg, `${up.base}/health`, tunnel.url);
    expect(tunnel.connects, "Node's environment proxy must carry a [::1] request").toContain(
      `[::1]:${up.port}`,
    );
  }, 30_000);

  it("bridge: a [::1] base URL; skipped where the host has no IPv6", async (ctx) => {
    try {
      await makeUpstream("::1");
    } catch (err) {
      if (!noIpv6(err)) throw err;
      ctx.skip();
      return;
    }
    const result = await run("bridge", "env-var", "::1");
    expect(result.tunnel.connects).toEqual([]);
    expect(result.up.seen.find((s) => s.url === "/mcp")?.authorization).toBe(`Bearer ${TOKEN}`);
  }, 60_000);

  it("tandem deactivate (the licence POST) goes direct as well", async () => {
    // Its app-data root is a scratch directory: if the POST were not answered
    // the command falls back to removing a licence from the local store.
    const scratch = mkdtempSync(join(tmpdir(), "tandem-2422-"));
    try {
      const up = await makeUpstream();
      const tunnel = await makeTunnel();
      const env = childEnv({
        TANDEM_URL: up.base,
        HTTP_PROXY: tunnel.url,
        NODE_USE_ENV_PROXY: "1",
        HOME: scratch,
        USERPROFILE: scratch,
        APPDATA: scratch,
        LOCALAPPDATA: scratch,
        XDG_DATA_HOME: scratch,
        XDG_CONFIG_HOME: scratch,
        TANDEM_APP_DATA_DIR: scratch,
      });
      const p = start(["src/cli/index.ts", "deactivate"], env);
      await new Promise<void>((r) => p.c.once("exit", () => r()));
      expect(tunnel.connects).toEqual([]);
      expect(up.seen.some((s) => s.method === "POST" && s.url === "/api/license/deactivate")).toBe(
        true,
      );
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  }, 60_000);
});
