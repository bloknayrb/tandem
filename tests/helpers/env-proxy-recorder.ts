import { type ChildProcess, spawn } from "node:child_process";
import { createServer, type Server } from "node:http";
import { connect as netConnect } from "node:net";

/**
 * The shared pieces of the #2422 real-process proofs: a recording `CONNECT`
 * tunnel, the child environment that turns Node's environment proxy on, and
 * the control that proves the tunnel does see a bare global `fetch`.
 *
 * Used by `tests/cli/loopback-no-proxy.test.ts` (the bridge, the shim, the
 * monitor, the licence commands) and
 * `tests/server/local-model/loopback-no-proxy.test.ts` (the local-model client
 * and the start-up instance probe). The proxy variables must be set on the
 * CHILD: Node fixes its dispatcher at start-up, so setting them in the test
 * process proves nothing.
 */

/**
 * Node's environment proxy exists from 24.5 and was backported to 22.21; 23.x
 * and 24.0–24.4 ignore the variable, so the control would fail there rather
 * than prove anything.
 */
export function nodeHonoursEnvProxy(): boolean {
  const [maj = 0, min = 0] = process.versions.node.split(".").map(Number);
  return maj > 24 || (maj === 24 && min >= 5) || (maj === 22 && min >= 21);
}

/** Whether `err` is a listen on `::1` refused because this host has no IPv6. */
export function noIpv6(err: unknown): boolean {
  const code = (err as { code?: unknown } | null)?.code;
  return code === "EAFNOSUPPORT" || code === "EADDRNOTAVAIL";
}

/**
 * Servers and children a file started; `cleanup()` (call it in `afterEach`)
 * closes and kills them. One registry per test file: it is a module-level
 * value in the file that creates it, which vitest isolates per file. Every
 * server the file starts (upstreams and tunnels alike) goes in the same one.
 */
export function createRegistry() {
  const servers: Server[] = [];
  const children: ChildProcess[] = [];
  return {
    servers,
    children,
    async cleanup() {
      for (const c of children.splice(0)) c.kill();
      for (const s of servers.splice(0)) {
        s.closeAllConnections?.();
        await new Promise<void>((r) => s.close(() => r()));
      }
    },
  };
}
export type Registry = ReturnType<typeof createRegistry>;

/** A CONNECT tunnel that records what it was asked to reach, then pipes. */
export async function makeTunnel(reg: Registry) {
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
  reg.servers.push(proxy);
  await new Promise<void>((r) => proxy.listen(0, "127.0.0.1", r));
  const addr = proxy.address();
  if (!addr || typeof addr === "string") throw new Error("address");
  return { connects, url: `http://127.0.0.1:${addr.port}` };
}

/**
 * The test process's environment with every proxy, `NO_PROXY` and Tandem
 * variable removed, then `extra` laid over it.
 */
export function childEnv(extra: Record<string, string | undefined>): NodeJS.ProcessEnv {
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

/**
 * The control: a child that makes a bare global `fetch` of `url` with Node's
 * environment proxy on and `HTTP_PROXY` naming `tunnelUrl`. Resolves once the
 * child exits; the caller asserts the tunnel saw the `CONNECT`.
 */
export async function bareFetchThroughEnvProxy(
  reg: Registry,
  url: string,
  tunnelUrl: string,
): Promise<void> {
  const c = spawn(
    process.execPath,
    ["-e", `fetch(${JSON.stringify(url)}).then(()=>process.exit(0),()=>process.exit(0))`],
    {
      env: childEnv({ NODE_USE_ENV_PROXY: "1", HTTP_PROXY: tunnelUrl }),
      stdio: "ignore",
    },
  );
  reg.children.push(c);
  await new Promise<void>((r) => c.once("exit", () => r()));
}
