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
 * Driven end to end: the REAL bridge (`tandem mcp-stdio`, the entry `tandem
 * setup` now writes) against the REAL HTTP MCP server and its registry, with
 * the environment Claude Code gives an MCP server it spawns
 * (`CLAUDECODE=1`, `CLAUDE_CODE_SESSION_ID`). The contrast in each case is the
 * direct-HTTP entry Tandem used to write, which sends no id. The
 * supervisor-side half of (3) — an id that is not its child's is never tagged —
 * is `supervisor-turn-delivery.test.ts`'s "#2227" block.
 */

import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import type { Server } from "node:http";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { setGreetingReplyClassifier } from "../../../src/server/mcp/greeting-reply.js";
import {
  closeMcpSession,
  isClaudeSessionAttached,
  isOtherMcpClientLive,
  startMcpServerHttp,
} from "../../../src/server/mcp/server.js";
import { allocPort } from "../../helpers/alloc-port.js";

const CLI_ENTRY = resolve(import.meta.dirname, "../../../src/cli/index.ts");
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

/** Start the bridge as Claude Code starts the setup entry, for session `id`. */
function startBridge(id: string): {
  send: (msg: unknown) => void;
  reply: (id: number, timeoutMs?: number) => Promise<Record<string, unknown>>;
} {
  const env: NodeJS.ProcessEnv = { ...process.env, TANDEM_URL: `http://127.0.0.1:${port}` };
  env.CLAUDECODE = "1";
  env.CLAUDE_CODE_SESSION_ID = id;
  delete env.TANDEM_AUTH_TOKEN;
  const child = spawn(process.execPath, ["--import", "tsx", CLI_ENTRY, "mcp-stdio"], {
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
