import { type ChildProcess, spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { resolveBindHostEnv } from "../../src/server/bind-check.js";
import { startMcpServerHttp } from "../../src/server/mcp/server.js";
import { DEFAULT_BIND_HOST, LAN_BIND_ENABLED } from "../../src/shared/constants.js";

/**
 * ADR-056: listening beyond this computer ships dark. The decision is pure and
 * table-tested here; the spawn at the bottom is the half a table cannot give,
 * that `main()` actually consults it before doing anything else.
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "../..");
const SERVER_ENTRY = path.join(REPO_ROOT, "src/server/index.ts");

const NON_LOOPBACK = ["0.0.0.0", "::", "192.168.1.50", "127.0.0.2", "::ffff:127.0.0.1"];
const GARBAGE = ["LOCALHOST", "[::1]", "not-an-ip", " "];
const LOOPBACK = ["127.0.0.1", "localhost", "::1"];

describe("LAN_BIND_ENABLED (ADR-056)", () => {
  it("ships dark", () => {
    expect(LAN_BIND_ENABLED).toBe(false);
  });
});

describe("resolveBindHostEnv: dark", () => {
  const dark = (raw: string | undefined, transportMode: string) =>
    resolveBindHostEnv({ raw, transportMode, lanBindEnabled: false });

  it.each([...NON_LOOPBACK, ...GARBAGE])("refuses %j in http mode, naming ADR-056", (raw) => {
    const decision = dark(raw, "http");
    expect(decision.kind).toBe("refuse");
    if (decision.kind !== "refuse") return;
    expect(decision.message).toContain("ADR-056");
    expect(decision.message).toContain(`"${raw}"`);
    // The token remedy belongs to a mode that is refused anyway.
    expect(decision.message).not.toMatch(/token/i);
  });

  it.each([...NON_LOOPBACK, ...GARBAGE])(
    "ignores %j in stdio mode and falls back to loopback",
    (raw) => {
      const decision = dark(raw, "stdio");
      expect(decision).toMatchObject({ kind: "ignore", bindHost: DEFAULT_BIND_HOST });
      if (decision.kind === "ignore") expect(decision.message).toContain("ADR-056");
    },
  );

  it("treats any transport other than http as the stdio branch, as index.ts does", () => {
    expect(dark("0.0.0.0", "something-else").kind).toBe("ignore");
  });

  it.each(LOOPBACK)("uses %j unchanged in both modes", (raw) => {
    expect(dark(raw, "http")).toEqual({ kind: "use", bindHost: raw });
    expect(dark(raw, "stdio")).toEqual({ kind: "use", bindHost: raw });
  });

  it.each([undefined, ""])("uses the loopback default for %j", (raw) => {
    expect(dark(raw, "http")).toEqual({ kind: "use", bindHost: DEFAULT_BIND_HOST });
  });
});

describe("resolveBindHostEnv: lit", () => {
  it.each([...NON_LOOPBACK, ...GARBAGE, ...LOOPBACK])(
    "passes %j through untouched in both modes",
    (raw) => {
      for (const transportMode of ["http", "stdio"]) {
        expect(resolveBindHostEnv({ raw, transportMode, lanBindEnabled: true })).toEqual({
          kind: "use",
          bindHost: raw,
        });
      }
    },
  );

  it("keeps the old `??` read: unset becomes the default, empty stays empty", () => {
    const lit = (raw: string | undefined) =>
      resolveBindHostEnv({ raw, transportMode: "http", lanBindEnabled: true });
    expect(lit(undefined)).toEqual({ kind: "use", bindHost: DEFAULT_BIND_HOST });
    // Empty reaches the IP validation in index.ts and is rejected there, as before.
    expect(lit("")).toEqual({ kind: "use", bindHost: "" });
  });
});

describe("startMcpServerHttp refuses a non-loopback host while dark", () => {
  it("throws before listening", async () => {
    await expect(startMcpServerHttp(0, "0.0.0.0")).rejects.toThrow(/ADR-056/);
  });
});

describe("both probe sites in main() ask the decided host (ADR-056)", () => {
  // Source pin, because the stdio site's whole point is a value nothing else
  // observes: an ignored LAN value, probed through the env-reading default,
  // asks an address no local Tandem answers, reads as "nobody here", and the
  // port is then killed. A spawn cannot see which address was asked.
  it("passes probeHost at every probeTandemInstance call and leaves none on the default", async () => {
    const src = await fs.readFile(SERVER_ENTRY, "utf-8");
    const calls = [...src.matchAll(/probeTandemInstance\(([^)]*)\)/g)].map((m) => m[1]);
    expect(calls.length, "found no probe call — the matcher has drifted").toBe(2);
    for (const args of calls) expect(args).toBe("mcpPort, undefined, probeHost");
    expect(src).toMatch(/const probeHost = resolveProbeHost\(bindHost \|\| DEFAULT_BIND_HOST\)/);
  });
});

/** Two ports nothing is listening on, so a broken refusal cannot touch a real Tandem. */
async function freePorts(): Promise<[number, number]> {
  const grab = () =>
    new Promise<number>((resolve, reject) => {
      const srv = net.createServer();
      srv.once("error", reject);
      srv.listen(0, "127.0.0.1", () => {
        const { port } = srv.address() as net.AddressInfo;
        srv.close(() => resolve(port));
      });
    });
  return [await grab(), await grab()];
}

describe("the server entry honours the decision at start (ADR-056)", () => {
  let child: ChildProcess | null = null;
  let tmp: string | null = null;

  afterEach(async () => {
    const proc = child;
    if (proc && proc.exitCode === null && proc.signalCode === null) {
      // Wait for the exit, so Windows has released the child's file handles
      // before the temp tree is removed.
      const exited = once(proc, "exit");
      proc.kill("SIGKILL");
      await exited;
    }
    child = null;
    if (tmp) await fs.rm(tmp, { recursive: true, force: true, maxRetries: 5 });
    tmp = null;
  });

  /**
   * Every inherited TANDEM_* goes, every home-relative root points into
   * `tmp`, and the ports are ones nothing holds: the token file resolves
   * through env-paths rather than TANDEM_APP_DATA_DIR, so without these a
   * broken refusal would read the developer's real token, and could probe or
   * free the ports of a Tandem they have running.
   */
  async function isolatedEnv(extra: Record<string, string>): Promise<NodeJS.ProcessEnv> {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), "tandem-lan-dark-"));
    const [wsPort, mcpPort] = await freePorts();
    const env: NodeJS.ProcessEnv = {};
    for (const [key, value] of Object.entries(process.env)) {
      if (!key.startsWith("TANDEM_")) env[key] = value;
    }
    return Object.assign(env, {
      TANDEM_APP_DATA_DIR: path.join(tmp, "app-data"),
      TANDEM_PORT: String(wsPort),
      TANDEM_MCP_PORT: String(mcpPort),
      TANDEM_NO_SAMPLE: "1",
      TANDEM_DISABLE_LAUNCHER: "1",
      HOME: tmp,
      USERPROFILE: tmp,
      APPDATA: path.join(tmp, "AppData", "Roaming"),
      LOCALAPPDATA: path.join(tmp, "AppData", "Local"),
      XDG_DATA_HOME: path.join(tmp, ".local", "share"),
      XDG_CONFIG_HOME: path.join(tmp, ".config"),
      ...extra,
    });
  }

  it("HTTP mode: exits 1 with the ADR-056 message, having created nothing", async () => {
    const env = await isolatedEnv({ TANDEM_TRANSPORT: "http", TANDEM_BIND_HOST: "0.0.0.0" });
    const proc = spawn(process.execPath, ["--import", "tsx", SERVER_ENTRY], {
      env,
      cwd: REPO_ROOT,
      stdio: ["ignore", "ignore", "pipe"],
    });
    child = proc;
    let stderr = "";
    proc.stderr.on("data", (d: Buffer) => {
      stderr += d.toString();
    });
    const code = await new Promise<number | null>((resolve) => proc.on("close", resolve));

    // The message is what discriminates: a refusal that never ran still exits
    // 1 here, at the token check, with a different message.
    expect(stderr).toContain('TANDEM_BIND_HOST="0.0.0.0" is not supported in this version');
    expect(stderr).toContain("ADR-056");
    expect(code).toBe(1);
    // And it refused first: the app-data claim, the sweeps and the store lock
    // all write under this directory, so a refusal that ran after any of them
    // leaves it behind.
    await expect(fs.access(env.TANDEM_APP_DATA_DIR as string)).rejects.toThrow();
  }, 60_000);

  it("stdio mode: says it ignored the value, and keeps running", async () => {
    const env = await isolatedEnv({ TANDEM_TRANSPORT: "stdio", TANDEM_BIND_HOST: "192.168.1.50" });
    // stdin stays open: stdio mode exits on EOF before startup completes.
    const proc = spawn(process.execPath, ["--import", "tsx", SERVER_ENTRY], {
      env,
      cwd: REPO_ROOT,
      stdio: ["pipe", "ignore", "pipe"],
    });
    child = proc;
    let stderr = "";
    const running = new Promise<void>((resolve, reject) => {
      proc.stderr.on("data", (d: Buffer) => {
        stderr += d.toString();
        if (stderr.includes("MCP server running on stdio")) resolve();
      });
      proc.on("close", (code) => reject(new Error(`exited ${code} before running:\n${stderr}`)));
    });
    await running;

    expect(stderr).toContain('Ignoring TANDEM_BIND_HOST="192.168.1.50"');
    expect(stderr).toContain("ADR-056");
    expect(stderr).not.toContain("is not supported in this version");
  }, 60_000);
});
