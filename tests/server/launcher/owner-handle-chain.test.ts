/**
 * The chain (#2358 PR 3a, end of Requirement 3; R4.2, R5): the real
 * supervisor spawns the stub child, which reads the run MCP config from the
 * path in its own argv and starts the REAL stdio bridge from that entry's
 * `command`, `args` and `env`, adding what Claude Code adds for a server it
 * starts (`CLAUDECODE=1`, `CLAUDE_CODE_SESSION_ID` from its own argv). The
 * bridge reaches the real HTTP MCP server on a non-default port, and the
 * transport binds to that spawn. Nothing here takes the handle or the session
 * id from supervisor internals: a child handed the wrong values fails.
 *
 * The bridge script is a fixture at a `dist/stdio-bridge/index.js` path that
 * loads `src/stdio-bridge/index.ts` through tsx, as
 * setup-entry-session-id.test.ts runs it. `TANDEM_STDIO_BRIDGE_DIST` is
 * honoured only inside the desktop sidecar, so the supervisor's
 * `stdioBridgeScript` test seam names it.
 */

import fs from "node:fs";
import type { Server } from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { IntegrationsFile } from "../../../src/server/integrations/schema.js";
import { createIntegrationsStore } from "../../../src/server/integrations/storage.js";
import type { RunFileAcl } from "../../../src/server/launcher/run-files.js";
import { createSupervisor, type Supervisor } from "../../../src/server/launcher/supervisor.js";
import { installLogRedaction } from "../../../src/server/log-redact.js";
import {
  closeMcpSession,
  mcpSessionBindsForTests,
  mcpSessionOwnerIdsForTests,
  startMcpServerHttp,
} from "../../../src/server/mcp/server.js";
import {
  ownerHandleBindSnapshotForTests,
  resetOwnerHandleBindForTests,
} from "../../../src/server/sessions/owner-handle-bind.js";
import { resetOwnershipForTests } from "../../../src/server/sessions/ownership.js";
import { allocPort } from "../../helpers/alloc-port.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const STUB_SOURCE = path.join(HERE, "stub-claude-cli.cjs");
const BRIDGE_SRC = path.resolve(HERE, "../../../src/stdio-bridge/index.ts");
const TSX_API = path.resolve(HERE, "../../../node_modules/tsx/dist/esm/api/index.mjs");
const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "oh-chain-bridge-"));
const BRIDGE_SCRIPT = path.join(fixture, "Tandem", "dist", "stdio-bridge", "index.js");
fs.mkdirSync(path.dirname(BRIDGE_SCRIPT), { recursive: true });
fs.writeFileSync(path.join(path.dirname(BRIDGE_SCRIPT), "package.json"), '{ "type": "module" }\n');
fs.writeFileSync(
  BRIDGE_SCRIPT,
  `import { register } from ${JSON.stringify(pathToFileURL(TSX_API).href)};\n` +
    `register();\nawait import(${JSON.stringify(pathToFileURL(BRIDGE_SRC).href)});\n`,
);
afterAll(() => fs.rmSync(fixture, { recursive: true, force: true }));

const NO_ACL: RunFileAcl = {
  assertOwned: async () => {},
  lockDir: async () => {},
  verifyNoBroadAce: async () => {},
};
const HANDLE_RE = /th_[A-Za-z0-9_-]{32}/;
const ENV_KEYS = [
  "TANDEM_REAPER_PATH",
  "TANDEM_TAURI_SIDECAR",
  "NODE_ENV",
  "TANDEM_CLAUDE_CMD",
  "TANDEM_STUB_CLAUDE_RECORD_DIR",
  "TANDEM_STUB_CLAUDE_START_BRIDGE",
  "TANDEM_STUB_CLAUDE_LEAK",
  "TANDEM_STUB_CLAUDE_NOT_SIGNED_IN_ONCE",
  "TANDEM_STUB_CLAUDE_EXIT_DELAY_MS",
] as const;
const saved: Record<string, string | undefined> = {};

let tmpDir: string;
let spawnDir: string;
let recordDir: string;
let httpServer: Server;
let port: number;
let sup: Supervisor | undefined;
let lines: string[];
const realConsole: Partial<Console> = {};

function records<T>(prefix: string): T[] {
  return fs
    .readdirSync(recordDir)
    .filter((n) => n.startsWith(prefix) && n.endsWith(".json"))
    .map((n) => JSON.parse(fs.readFileSync(path.join(recordDir, n), "utf8")) as T);
}
async function waitFor<T>(probe: () => T | null | undefined | false, label: string, ms = 20_000) {
  const deadline = Date.now() + ms;
  for (;;) {
    const v = probe();
    if (v) return v;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${label}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

beforeEach(async () => {
  vi.stubEnv("TANDEM_OWNERSHIP", "1");
  for (const k of ENV_KEYS) saved[k] = process.env[k];
  // Every console line this file's process writes goes through the real
  // installer into `lines`, as the log sink does (R5.3).
  lines = [];
  for (const m of ["log", "info", "warn", "error", "debug", "trace", "dir"] as const) {
    realConsole[m] = console[m] as never;
  }
  installLogRedaction(console, (line) => lines.push(line));

  tmpDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "oh-chain-")));
  spawnDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "oh-chain-cwd-")));
  recordDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "oh-chain-rec-")));
  fs.copyFileSync(STUB_SOURCE, path.join(spawnDir, String(process.pid)));
  process.env.NODE_ENV = "test";
  delete process.env.TANDEM_TAURI_SIDECAR;
  process.env.TANDEM_REAPER_PATH = process.execPath;
  const sentinel = path.join(recordDir, `stub-claude${process.platform === "win32" ? ".exe" : ""}`);
  fs.writeFileSync(sentinel, "", { mode: 0o755 });
  process.env.TANDEM_CLAUDE_CMD = sentinel;
  process.env.TANDEM_STUB_CLAUDE_RECORD_DIR = recordDir;
  process.env.TANDEM_STUB_CLAUDE_START_BRIDGE = "1";

  port = await allocPort();
  httpServer = await startMcpServerHttp(port, "127.0.0.1");
  const file: IntegrationsFile = {
    schemaVersion: 3,
    integrations: [
      {
        kind: "claude-code",
        id: "active",
        label: "Active Claude",
        configPath: process.platform === "win32" ? "C:\\x\\.claude.json" : "/x/.claude.json",
        transport: "http",
        url: "http://127.0.0.1:3479/mcp",
        apply: "create",
        workingDirectory: spawnDir,
      },
    ],
  };
  await createIntegrationsStore(tmpDir).write(file);
});

afterEach(async () => {
  await sup?.stop().catch(() => {});
  sup = undefined;
  await closeMcpSession();
  await new Promise<void>((r) => httpServer.close(() => r()));
  resetOwnershipForTests();
  resetOwnerHandleBindForTests();
  Object.assign(console, realConsole);
  vi.unstubAllEnvs();
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  for (const dir of [tmpDir, spawnDir, recordDir]) {
    try {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
    } catch {
      // Windows can hold a just-exited child's cwd briefly; the dir is unique.
    }
  }
});

function start(extra: { leak?: string } = {}) {
  if (extra.leak) process.env.TANDEM_STUB_CLAUDE_LEAK = extra.leak;
  sup = createSupervisor({
    integrationsBase: tmpDir,
    homeOverride: fs.realpathSync(os.tmpdir()),
    getBoundMcpAddress: () => {
      const a = httpServer.address();
      return a && typeof a === "object" ? { address: a.address, port: a.port } : null;
    },
    stdioBridgeScript: BRIDGE_SCRIPT,
    runFileAcl: NO_ACL,
    claudeSettingsHome: path.join(tmpDir, "home"),
    storeLockHeld: () => false,
  });
  return sup;
}

interface RunRec {
  pid: number;
  mcpConfigPath: string;
  settingsPath: string;
  sessionId: string;
}

describe("the chain: launcher → child → real bridge → real server (R1–R3)", () => {
  it("binds the child's transport to its spawn; the run MCP config goes at first bind, the settings file at teardown; no handle anywhere", async () => {
    const s = start();
    await s.startFresh(spawnDir);
    const run = await waitFor(() => records<RunRec>("runfiles-")[0], "the run files record");
    const bound = await waitFor(
      () => mcpSessionBindsForTests().find((b) => b.boundSpawn !== null),
      "a bound transport",
    );
    const snap = ownerHandleBindSnapshotForTests();
    expect(bound.boundSpawn).toBe(snap.current);
    // Ruling A: the bound transport sits on the record it would without a handle.
    expect(mcpSessionOwnerIdsForTests()).toEqual([`claude:${run.sessionId}`]);
    // R4.2: the MCP config is deleted at first bind; the settings file stays.
    await waitFor(() => !fs.existsSync(run.mcpConfigPath), "the MCP config deleted at bind");
    expect(fs.existsSync(run.settingsPath)).toBe(true);
    expect(lines.some((l) => l.includes("bound to Tandem's Claude's current run"))).toBe(true);

    await s.stop();
    await waitFor(() => !fs.existsSync(run.settingsPath), "the settings file deleted at teardown");
    expect(mcpSessionBindsForTests().every((b) => b.boundSpawn === null)).toBe(true);

    // R5: no log line, bridge stderr or record a test could snapshot carries
    // a handle. Not vacuous: the transport bound above.
    for (const l of lines) expect(l).not.toMatch(HANDLE_RE);
    // Nothing even handed the handle to the console: the sink had nothing to
    // redact (the lines above were captured after redaction).
    for (const l of lines) expect(l).not.toContain("th_[redacted]");
    for (const r of records<{ text: string }>("bridge-stderr-")) {
      expect(r.text).not.toMatch(HANDLE_RE);
    }
    const health = await fetch(`http://127.0.0.1:${port}/health`).then((r) => r.text());
    expect(health).not.toMatch(HANDLE_RE);
  }, 60_000);

  it("the superseded spawn's late teardown leaves the newer spawn bound; its handle still binds a new transport (R4.3, design §17)", async () => {
    // Spawn 1 is tripped by the sign-in check (its run state ends then, R4.4)
    // and lingers 6 s before exiting, so its exit — and the second, late run
    // of its teardown — lands after spawn 2 has started and bound.
    process.env.TANDEM_STUB_CLAUDE_NOT_SIGNED_IN_ONCE = "1";
    process.env.TANDEM_STUB_CLAUDE_EXIT_DELAY_MS = "6000";
    const s = start();
    await s.startFresh(spawnDir);
    const first = await waitFor(() => records<RunRec>("runfiles-")[0], "spawn 1");
    await waitFor(() => records("not-signed-in-").length > 0, "the sign-in trip");
    await waitFor(() => s.status().running === false, "the trip's kill");
    await s.relaunch(spawnDir);
    const second = await waitFor(
      () => records<RunRec>("runfiles-").find((r) => r.pid !== first.pid),
      "spawn 2",
    );
    const serial2 = await waitFor(() => {
      const snap = ownerHandleBindSnapshotForTests();
      const live = snap.spawns.find((x) => x.serial === snap.current && x.bound.length > 0);
      return live?.serial;
    }, "spawn 2 bound");
    expect(records("exited-")).toEqual([]); // spawn 1 has not exited yet
    await waitFor(() => records("exited-").length > 0, "spawn 1's late exit", 15_000);
    await new Promise((r) => setTimeout(r, 300));

    expect(ownerHandleBindSnapshotForTests().current).toBe(serial2);
    expect(
      mcpSessionBindsForTests().filter((b) => b.boundSpawn === serial2).length,
    ).toBeGreaterThan(0);
    expect(fs.existsSync(second.settingsPath)).toBe(true);
    expect(fs.existsSync(first.settingsPath)).toBe(false);
    expect(fs.existsSync(first.mcpConfigPath)).toBe(false);

    // Spawn 2's handle still binds a new transport; spawn 1's binds nothing.
    const handleOf = (pid: number) =>
      (
        JSON.parse(fs.readFileSync(path.join(recordDir, `runfiles-${pid}.json`), "utf8")) as {
          mcp: { value: { mcpServers: { tandem: { env: Record<string, string> } } } };
        }
      ).mcp.value.mcpServers.tandem.env.TANDEM_OWNER_HANDLE;
    const init = async (handle: string, sid: string) => {
      const res = await fetch(`http://127.0.0.1:${port}/mcp`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
          "X-Tandem-Owner-Handle": handle,
          "X-Claude-Session-Id": sid,
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: {
            protocolVersion: "2025-06-18",
            capabilities: {},
            clientInfo: { name: "x", version: "1" },
          },
        }),
      });
      await res.text();
      return res.headers.get("mcp-session-id") ?? "";
    };
    const fresh = await init(handleOf(second.pid), second.sessionId);
    expect(mcpSessionBindsForTests().find((b) => b.sessionId === fresh)?.boundSpawn).toBe(serial2);
    const stale = await init(handleOf(first.pid), first.sessionId);
    expect(mcpSessionBindsForTests().find((b) => b.sessionId === stale)?.boundSpawn).toBeNull();
  }, 60_000);

  it("a handle-shaped string on the child's stderr and in a bad {-line on its stdout reaches the console redacted", async () => {
    const leak = `th_${"Lk9-_".repeat(6)}zz`;
    const s = start({ leak });
    await s.startFresh(spawnDir);
    await waitFor(() => lines.some((l) => l.includes("[Claude] leak")), "the stderr line");
    await waitFor(() => lines.some((l) => l.includes("{not json")), "the bad stdout line");
    for (const l of lines) expect(l).not.toContain(leak);
    expect(lines.find((l) => l.includes("[Claude] leak"))).toContain("th_[redacted]");
  }, 60_000);
});
