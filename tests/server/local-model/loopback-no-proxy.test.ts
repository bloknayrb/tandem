import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  bareFetchThroughEnvProxy,
  childEnv,
  createRegistry,
  makeTunnel,
  nodeHonoursEnvProxy,
  noIpv6,
} from "../../helpers/env-proxy-recorder.js";

/**
 * #1123 / #2422: the local-model client and the start-up instance probe never
 * send a loopback request through an environment proxy.
 *
 * Each case starts `__fixtures__/loopback-no-proxy-child.ts` in its own
 * process (through `tsx`), with Node's environment proxy on, `HTTP_PROXY`
 * naming a recording `CONNECT` tunnel and `NO_PROXY` / `no_proxy` removed. The
 * child calls the shipped `chat()` or `probeTandemInstance`. A control child
 * (a bare global `fetch` to the same upstream, under the same variables) must
 * see a `CONNECT`, so a clean run means the code avoided the proxy rather than
 * that the harness could not show one. The upstream records the request, so a
 * child that never really made it fails too.
 *
 * The recorder and the control are shared with `tests/cli/loopback-no-proxy.test.ts`.
 */

const root = resolve(__dirname, "../../..");
const CHILD = "tests/server/local-model/__fixtures__/loopback-no-proxy-child.ts";
const SENTINEL = "SENTINEL-1123-doc-text-zq7";
const DELTA = "delta-from-upstream-x9";
const PID = 424242;

const suite = nodeHonoursEnvProxy() ? describe : describe.skip;
const reg = createRegistry();
afterEach(() => reg.cleanup());

interface Seen {
  method: string;
  url: string;
  body: string;
}

/**
 * A fake OpenAI-compatible model server that also answers a Tandem-shaped
 * `/health`. A `stream: true` chat request is answered with an SSE body.
 */
async function makeUpstream(host = "127.0.0.1") {
  const seen: Seen[] = [];
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const body = Buffer.concat(chunks).toString("utf8");
      const url = req.url ?? "";
      seen.push({ method: req.method ?? "", url, body });
      if (url === "/health") {
        res
          .writeHead(200, { "Content-Type": "application/json" })
          .end(
            JSON.stringify({ status: "ok", version: "0.0.0-test", pid: PID, transport: "http" }),
          );
        return;
      }
      let stream = false;
      try {
        stream = (JSON.parse(body) as { stream?: unknown }).stream === true;
      } catch {
        // not a chat body; answered below
      }
      if (stream) {
        res.writeHead(200, { "Content-Type": "text/event-stream" });
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: DELTA } }] })}\n\n`);
        res.end("data: [DONE]\n\n");
        return;
      }
      res
        .writeHead(200, { "Content-Type": "application/json" })
        .end(JSON.stringify({ choices: [{ message: { content: "plain-answer" } }] }));
    });
  });
  reg.servers.push(server);
  await new Promise<void>((r, reject) => {
    server.once("error", reject);
    server.listen(0, host, () => r());
  });
  const addr = server.address();
  if (!addr || typeof addr === "string") throw new Error("address");
  const base = host === "::1" ? `http://[::1]:${addr.port}` : `http://127.0.0.1:${addr.port}`;
  return { base, port: addr.port, seen };
}

/** `makeUpstream("::1")`, or `null` where this host has no IPv6 (only then). */
async function makeIpv6Upstream() {
  try {
    return await makeUpstream("::1");
  } catch (err) {
    if (!noIpv6(err)) throw err;
    return null;
  }
}

type ChildSpec =
  | { kind: "chat"; endpoint: string; sentinel: string; stream: boolean }
  | { kind: "probe"; port: number; host: string };

/** Run the child under the environment proxy; resolve its `RESULT` line. */
async function runChild(
  spec: ChildSpec,
  tunnelUrl: string,
  style: "env-var" | "node-options" = "env-var",
): Promise<Record<string, unknown>> {
  const env = childEnv({
    HTTP_PROXY: tunnelUrl,
    ...(style === "env-var" ? { NODE_USE_ENV_PROXY: "1" } : { NODE_OPTIONS: "--use-env-proxy" }),
  });
  const c = spawn(process.execPath, ["--import", "tsx", CHILD, JSON.stringify(spec)], {
    cwd: root,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  reg.children.push(c);
  let out = "";
  let err = "";
  c.stdout.on("data", (b: Buffer) => {
    out += b.toString("utf8");
  });
  c.stderr.on("data", (b: Buffer) => {
    err += b.toString("utf8");
  });
  await new Promise<void>((r) => c.once("exit", () => r()));
  const line = out.split("\n").find((l) => l.startsWith("RESULT "));
  if (!line) throw new Error(`child printed no RESULT; stderr:\n${err.slice(-2000)}`);
  return JSON.parse(line.slice("RESULT ".length)) as Record<string, unknown>;
}

/** Assert the control: a bare `fetch` of `url` under these variables IS proxied. */
async function expectControlProxied(url: string, connectTarget: string) {
  const tunnel = await makeTunnel(reg);
  await bareFetchThroughEnvProxy(reg, url, tunnel.url);
  expect(tunnel.connects, "the harness must be able to show a proxied request").toContain(
    connectTarget,
  );
}

/** Run a chat child; assert no CONNECT and that the upstream got the prompt. */
async function chatCase(
  up: Awaited<ReturnType<typeof makeUpstream>>,
  endpoint: string,
  stream: boolean,
  style: "env-var" | "node-options" = "env-var",
) {
  const tunnel = await makeTunnel(reg);
  const result = await runChild(
    { kind: "chat", endpoint, sentinel: SENTINEL, stream },
    tunnel.url,
    style,
  );
  expect(result).toMatchObject({ ok: true });
  expect(tunnel.connects).toEqual([]);
  const posts = up.seen.filter((s) => s.method === "POST");
  expect(posts.map((s) => s.url)).toEqual(["/v1/chat/completions"]);
  expect(posts[0]?.body).toContain(SENTINEL);
  return result;
}

suite("the local-model client never uses an environment proxy (#1123, #2422)", () => {
  it("control: a bare fetch to the 127.0.0.1 upstream IS proxied under these variables", async () => {
    const up = await makeUpstream();
    await expectControlProxied(`${up.base}/v1/chat/completions`, `127.0.0.1:${up.port}`);
  }, 30_000);

  it("control: a bare fetch to localhost IS proxied under these variables", async () => {
    const up = await makeUpstream();
    await expectControlProxied(
      `http://localhost:${up.port}/v1/chat/completions`,
      `localhost:${up.port}`,
    );
  }, 30_000);

  it("http://127.0.0.1:<port>, non-streaming: no CONNECT, the upstream gets the prompt", async () => {
    const up = await makeUpstream();
    const result = await chatCase(up, up.base, false);
    expect(result.content).toBe("plain-answer");
  }, 60_000);

  it("http://127.0.0.1:<port>, streaming: no CONNECT, the callback gets the upstream's delta", async () => {
    const up = await makeUpstream();
    const result = await chatCase(up, up.base, true);
    expect(result.deltas).toEqual([DELTA]);
    expect(JSON.parse(up.seen[0]?.body ?? "{}")).toMatchObject({ stream: true });
  }, 60_000);

  it("http://localhost:<port>: rewritten to 127.0.0.1 and not proxied", async () => {
    const up = await makeUpstream();
    const result = await chatCase(up, `http://localhost:${up.port}`, false);
    expect(result.content).toBe("plain-answer");
  }, 60_000);

  it("--use-env-proxy in NODE_OPTIONS makes no difference", async () => {
    const up = await makeUpstream();
    const result = await chatCase(up, up.base, false, "node-options");
    expect(result.content).toBe("plain-answer");
  }, 60_000);

  it("control: a bare fetch to a [::1] upstream IS proxied; skipped where the host has no IPv6", async (ctx) => {
    const up = await makeIpv6Upstream();
    if (!up) return ctx.skip();
    await expectControlProxied(`${up.base}/v1/chat/completions`, `[::1]:${up.port}`);
  }, 30_000);

  it("http://[::1]:<port>: not proxied; skipped where the host has no IPv6", async (ctx) => {
    const up = await makeIpv6Upstream();
    if (!up) return ctx.skip();
    const result = await chatCase(up, up.base, false);
    expect(result.content).toBe("plain-answer");
  }, 60_000);
});

suite("the start-up instance probe never uses an environment proxy (#1758, #2422)", () => {
  it("control: a bare fetch to the fake /health IS proxied under these variables", async () => {
    const up = await makeUpstream();
    await expectControlProxied(`${up.base}/health`, `127.0.0.1:${up.port}`);
  }, 30_000);

  it("probeTandemInstance on 127.0.0.1: no CONNECT, and it identifies the instance by pid", async () => {
    const up = await makeUpstream();
    const tunnel = await makeTunnel(reg);
    const result = await runChild({ kind: "probe", port: up.port, host: "127.0.0.1" }, tunnel.url);
    expect(tunnel.connects).toEqual([]);
    expect(up.seen.map((s) => `${s.method} ${s.url}`)).toEqual(["GET /health"]);
    expect(result).toMatchObject({
      ok: true,
      probe: { pid: PID, version: "0.0.0-test", host: "127.0.0.1" },
    });
  }, 60_000);

  it("control: a bare fetch to a [::1] /health IS proxied; skipped where the host has no IPv6", async (ctx) => {
    const up = await makeIpv6Upstream();
    if (!up) return ctx.skip();
    await expectControlProxied(`${up.base}/health`, `[::1]:${up.port}`);
  }, 30_000);

  it("probeTandemInstance on ::1: no CONNECT, identified by pid; skipped where the host has no IPv6", async (ctx) => {
    const up = await makeIpv6Upstream();
    if (!up) return ctx.skip();
    const tunnel = await makeTunnel(reg);
    const result = await runChild({ kind: "probe", port: up.port, host: "::1" }, tunnel.url);
    expect(tunnel.connects).toEqual([]);
    expect(up.seen.map((s) => `${s.method} ${s.url}`)).toEqual(["GET /health"]);
    expect(result).toMatchObject({ ok: true, probe: { pid: PID, host: "::1" } });
  }, 60_000);
});
