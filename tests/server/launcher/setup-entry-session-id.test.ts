/**
 * #2358 PR 2b — what the setup entry's switch to the stdio bridge changes,
 * live (design v5 §3.6, §14): through the bridge, Tandem's Claude's MCP
 * connection carries its Claude Code session id, so
 *
 * 1. its own connection no longer counts as "another AI" (`isOtherMcpClientLive`);
 * 2. the status chip's `attached` (`isClaudeSessionAttached`) turns green with
 *    no plugin installed;
 * 3. the greeting classifier sees an id on every reply, so it is exact.
 *
 * Driven end to end from the WRITER: the entry is what `buildMcpEntries(…,
 * {targetKind: "claude-code"})` produces, and the test spawns that entry's own
 * `command`, `args` and `env` — so on a build whose writer still emits the
 * direct-HTTP shape, there is no `command` and this file fails. The bridge
 * pair is pinned to this checkout (Node = this process's, script = a fixture
 * at a `dist/stdio-bridge/index.js` path that loads `src/stdio-bridge/index.ts`
 * through tsx), against the REAL HTTP MCP server and its registry, with the
 * environment Claude Code adds for an MCP server it spawns (`CLAUDECODE=1`,
 * `CLAUDE_CODE_SESSION_ID`). One deviation, stated: the entry's `TANDEM_URL`
 * names the product port, so its port is moved to the test server's. The
 * contrast in each case is the direct-HTTP entry Tandem used to write, which
 * sends no id. The
 * supervisor-side half of (3) — an id that is not its child's is never tagged —
 * is `supervisor-turn-delivery.test.ts`'s "#2227" block.
 */

import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  _setClaudeCodeBridgeForTests,
  buildMcpEntries,
  CHANNEL_DIST,
} from "../../../src/server/integrations/apply.js";
import { setGreetingReplyClassifier } from "../../../src/server/mcp/greeting-reply.js";
import {
  closeMcpSession,
  isClaudeSessionAttached,
  isOtherMcpClientLive,
  startMcpServerHttp,
} from "../../../src/server/mcp/server.js";
import { allocPort } from "../../helpers/alloc-port.js";

const BRIDGE_SRC = resolve(import.meta.dirname, "../../../src/stdio-bridge/index.ts");
const TSX_API = resolve(import.meta.dirname, "../../../node_modules/tsx/dist/esm/api/index.mjs");
const fixture = mkdtempSync(join(tmpdir(), "tandem-setup-entry-"));
const BRIDGE_SCRIPT = join(fixture, "Tandem", "dist", "stdio-bridge", "index.js");
mkdirSync(join(BRIDGE_SCRIPT, ".."), { recursive: true });
writeFileSync(join(BRIDGE_SCRIPT, "..", "package.json"), '{ "type": "module" }\n');
writeFileSync(
  BRIDGE_SCRIPT,
  `import { register } from ${JSON.stringify(pathToFileURL(TSX_API).href)};\n` +
    `register();\nawait import(${JSON.stringify(pathToFileURL(BRIDGE_SRC).href)});\n`,
);
afterAll(() => {
  _setClaudeCodeBridgeForTests(undefined);
  rmSync(fixture, { recursive: true, force: true });
});
const CHILD_ID = "0b6f3c1e-5d2a-4c8e-9f17-2a4b6c8d0e1f";
const ACCEPT = "application/json, text/event-stream";

let httpServer: Server;
let port: number;
let bridge: ChildProcessWithoutNullStreams | undefined;

beforeEach(async () => {
  port = await allocPort();
  httpServer = await startMcpServerHttp(port, "127.0.0.1");
});

afterEach(async () => {
  bridge?.kill("SIGKILL");
  bridge = undefined;
  await closeMcpSession();
  await new Promise<void>((r) => httpServer.close(() => r()));
});

/** Start Claude Code's `tandem` entry, exactly as the writer built it, for session `id`. */
function startBridge(id: string): {
  send: (msg: unknown) => void;
  reply: (id: number, timeoutMs?: number) => Promise<Record<string, unknown>>;
} {
  _setClaudeCodeBridgeForTests({ command: process.execPath, script: BRIDGE_SCRIPT });
  const entry = buildMcpEntries(CHANNEL_DIST, { targetKind: "claude-code" }).tandem as {
    command?: string;
    args?: string[];
    env?: Record<string, string>;
  };
  expect(entry.command, `the writer did not emit a stdio entry: ${JSON.stringify(entry)}`).toBe(
    process.execPath,
  );
  expect(entry.args).toEqual([BRIDGE_SCRIPT]);
  const entryEnv = { ...entry.env };
  expect(Object.keys(entryEnv).sort()).toEqual(["TANDEM_URL"]);
  const url = new URL(entryEnv.TANDEM_URL as string);
  url.port = String(port);
  entryEnv.TANDEM_URL = url.origin;
  const env: NodeJS.ProcessEnv = { ...process.env, ...entryEnv };
  env.CLAUDECODE = "1";
  env.CLAUDE_CODE_SESSION_ID = id;
  delete env.TANDEM_AUTH_TOKEN;
  // The plugin's variables outrank the entry's own (`resolveTandemUrlCandidate`),
  // so one inherited from the developer's shell would point the bridge at the
  // real :3479 instead of the test server.
  delete env.CLAUDE_PLUGIN_OPTION_SERVER_URL;
  delete env.CLAUDE_PLUGIN_OPTION_AUTH_TOKEN;
  const child = spawn(entry.command as string, entry.args as string[], {
    env,
    stdio: ["pipe", "pipe", "pipe"],
  });
  bridge = child;
  let out = "";
  child.stdout.on("data", (c: Buffer) => {
    out += c.toString("utf8");
  });
  let err = "";
  child.stderr.on("data", (c: Buffer) => {
    err += c.toString("utf8");
  });
  return {
    send: (msg) => child.stdin.write(`${JSON.stringify(msg)}\n`),
    reply: (want, timeoutMs = 20_000) =>
      new Promise((res, rej) => {
        const started = Date.now();
        const tick = setInterval(() => {
          for (const line of out.split("\n")) {
            if (!line.trim()) continue;
            try {
              const parsed = JSON.parse(line) as Record<string, unknown>;
              if (parsed.id === want) {
                clearInterval(tick);
                res(parsed);
                return;
              }
            } catch {
              // a partial line
            }
          }
          if (Date.now() - started > timeoutMs) {
            clearInterval(tick);
            rej(new Error(`no reply ${want}; stderr=${err.slice(-800)}`));
          }
        }, 25);
      }),
  };
}

async function initializeThroughBridge(id: string) {
  const b = startBridge(id);
  b.send({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "claude-code", version: "2.1.0" },
    },
  });
  const init = await b.reply(1);
  expect(init.result, JSON.stringify(init)).toBeDefined();
  b.send({ jsonrpc: "2.0", method: "notifications/initialized" });
  return b;
}

/** The old direct-HTTP entry: an initialize with no `X-Claude-Session-Id`. */
async function initializeDirectHttp(): Promise<string> {
  const headers = { "Content-Type": "application/json", Accept: ACCEPT };
  const res = await fetch(`http://127.0.0.1:${port}/mcp`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "claude-code", version: "2.1.0" },
      },
    }),
  });
  const sessionId = res.headers.get("mcp-session-id") ?? "";
  await res.text();
  await fetch(`http://127.0.0.1:${port}/mcp`, {
    method: "POST",
    headers: { ...headers, "mcp-session-id": sessionId },
    body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
  }).then((r) => r.text());
  return sessionId;
}

async function eventually(check: () => boolean, what: string, timeoutMs = 10_000): Promise<void> {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

describe("the setup entry carries Tandem's Claude's session id (#2358 PR 2b, live)", () => {
  it("its own connection is not another AI; the old HTTP entry's is", async () => {
    await initializeThroughBridge(CHILD_ID);
    await eventually(() => isClaudeSessionAttached(CHILD_ID, 0), "the bridge's session");
    expect(isOtherMcpClientLive(new Set([CHILD_ID]))).toBe(false);

    // The same Claude through the direct-HTTP entry: no id, so it counts.
    await initializeDirectHttp();
    expect(isOtherMcpClientLive(new Set([CHILD_ID]))).toBe(true);
  }, 30_000);

  it("the status chip's `attached` turns green with no plugin, only through the bridge", async () => {
    const spawnedAt = Date.now();
    await initializeDirectHttp();
    expect(isClaudeSessionAttached(CHILD_ID, spawnedAt)).toBe(false);
    await initializeThroughBridge(CHILD_ID);
    await eventually(() => isClaudeSessionAttached(CHILD_ID, spawnedAt), "attached");
    // A spawn after this connection opened belongs to a later child.
    expect(isClaudeSessionAttached(CHILD_ID, Date.now() + 60_000)).toBe(false);
  }, 30_000);

  it("tandem_reply hands the greeting classifier the child's id, not 'no id'", async () => {
    const seen: (string | undefined)[] = [];
    const unregister = setGreetingReplyClassifier((q) => {
      seen.push(q.sessionId);
      return false;
    });
    try {
      const b = await initializeThroughBridge(CHILD_ID);
      b.send({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: { name: "tandem_reply", arguments: { text: "Hello" } },
      });
      await b.reply(2);
      expect(seen).toEqual([CHILD_ID]);
    } finally {
      unregister();
    }
  }, 30_000);
});
