import { type ChildProcess, spawn } from "node:child_process";
import fs from "node:fs/promises";
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
const SERVER_ENTRY = path.resolve(__dirname, "../../src/server/index.ts");

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

describe("the server entry refuses a non-loopback bind at start (ADR-056)", () => {
  let child: ChildProcess | null = null;
  let tmp: string | null = null;

  afterEach(async () => {
    if (child && child.exitCode === null) child.kill("SIGKILL");
    child = null;
    if (tmp) await fs.rm(tmp, { recursive: true, force: true });
    tmp = null;
  });

  it("exits 1 with the ADR-056 message", async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), "tandem-lan-dark-"));
    // Every inherited TANDEM_* goes, and every home-relative root points into
    // `tmp`: the token file resolves through env-paths, not
    // TANDEM_APP_DATA_DIR, so without these a broken refusal would read the
    // developer's real token and carry on into their files.
    const env: NodeJS.ProcessEnv = {};
    for (const [key, value] of Object.entries(process.env)) {
      if (!key.startsWith("TANDEM_")) env[key] = value;
    }
    Object.assign(env, {
      TANDEM_TRANSPORT: "http",
      TANDEM_BIND_HOST: "0.0.0.0",
      TANDEM_APP_DATA_DIR: path.join(tmp, "app-data"),
      HOME: tmp,
      USERPROFILE: tmp,
      APPDATA: path.join(tmp, "AppData", "Roaming"),
      LOCALAPPDATA: path.join(tmp, "AppData", "Local"),
      XDG_DATA_HOME: path.join(tmp, ".local", "share"),
      XDG_CONFIG_HOME: path.join(tmp, ".config"),
    });

    const proc = spawn(process.execPath, ["--import", "tsx", SERVER_ENTRY], {
      env,
      stdio: ["ignore", "pipe", "pipe"],
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
  }, 60_000);
});
