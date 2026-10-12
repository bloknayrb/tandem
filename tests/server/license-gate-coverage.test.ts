import type { Server } from "node:http";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The MCP half of the licence (#1521): one check at the transport, not one per
 * tool.
 *
 * Until #1521 this file was a table of 14 `gatedTool` rows — Claude's write
 * tools refused one by one while its reads, chat and push stayed open, which is
 * the opposite of the licence ("after the 14 day trial, tandem remains a usable
 * editor, but with no AI features"). The per-tool wrapper is gone; every tool
 * is registered with plain `withErrorBoundary`, and an unlicensed Claude never
 * reaches any of them because `POST /mcp` refuses the `initialize` itself.
 *
 * So this file pins two things:
 *  - **the handshake**, armed and through the real disk path: a restricted
 *    install's `initialize` gets the licence error and no session; a fresh
 *    trial's is admitted (the positive twin);
 *  - **the placement**: the refusal sits at the top of the POST handler, above
 *    the `isInit` branch, so no future branch (a sessionless 2026-07-28 one,
 *    say) can be added outside it.
 *
 * The wider armed probe — mid-session flips, GET, SSE, the wake socket, chat —
 * is `license-armed-restricted.test.ts`.
 */
vi.hoisted(() => {
  process.env.TANDEM_LICENSE_GATE = "1";
});

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { trialFilePath } from "../../src/server/license/paths.js";
import {
  closeMcpSession,
  hasAnyMcpSession,
  startMcpServerHttp,
} from "../../src/server/mcp/server.js";
import { LICENSE_REQUIRED, LICENSE_REQUIRED_RPC_CODE } from "../../src/shared/license-copy.js";
import { allocPort } from "../helpers/alloc-port.js";
import { allMcpSource, registeredToolNames, wrappedToolNames } from "../helpers/mcp-source.js";

const DAY = 86_400_000;
const createdDirs: string[] = [];
let savedAppDataDir: string | undefined;
let savedGateFlag: string | undefined;
let httpServer: Server;
let baseUrl: string;

function useTrial(daysAgo: number): void {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tandem-license-handshake-"));
  createdDirs.push(dir);
  fs.writeFileSync(
    trialFilePath(dir),
    JSON.stringify({ version: 1, firstRunAt: new Date(Date.now() - daysAgo * DAY).toISOString() }),
  );
  process.env.TANDEM_APP_DATA_DIR = dir;
}

beforeAll(async () => {
  savedAppDataDir = process.env.TANDEM_APP_DATA_DIR;
  savedGateFlag = process.env.TANDEM_LICENSE_GATE;
  const port = await allocPort();
  baseUrl = `http://127.0.0.1:${port}`;
  httpServer = await startMcpServerHttp(port, "127.0.0.1");
});

beforeEach(async () => {
  await closeMcpSession();
});

afterAll(async () => {
  await closeMcpSession();
  await new Promise<void>((resolve) => httpServer.close(() => resolve()));
  if (savedAppDataDir === undefined) delete process.env.TANDEM_APP_DATA_DIR;
  else process.env.TANDEM_APP_DATA_DIR = savedAppDataDir;
  if (savedGateFlag === undefined) delete process.env.TANDEM_LICENSE_GATE;
  else process.env.TANDEM_LICENSE_GATE = savedGateFlag;
  for (const dir of createdDirs) fs.rmSync(dir, { recursive: true, force: true });
});

async function initialize(): Promise<{ sessionId: string | null; body: Record<string, unknown> }> {
  const res = await fetch(`${baseUrl}/mcp`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "handshake-probe", version: "1.0.0" },
      },
    }),
  });
  const sessionId = res.headers.get("mcp-session-id");
  const text = await res.text();
  // An admitted initialize answers as SSE; read the JSON out of its data line.
  const json = text.startsWith("{") ? text : (text.match(/^data: (.*)$/m)?.[1] ?? "{}");
  return { sessionId, body: JSON.parse(json) as Record<string, unknown> };
}

describe("the MCP handshake is the licence check (#1521)", () => {
  it("refuses initialize when restricted: the licence error, and no session", async () => {
    useTrial(30);
    const { sessionId, body } = await initialize();
    expect(sessionId).toBeNull();
    expect(hasAnyMcpSession()).toBe(false);
    const error = body.error as { code: number; data: { error: string } };
    expect(error.code).toBe(LICENSE_REQUIRED_RPC_CODE);
    expect(error.data.error).toBe(LICENSE_REQUIRED);
  });

  it("admits initialize on a fresh trial (positive twin)", async () => {
    useTrial(1);
    const { sessionId, body } = await initialize();
    expect(sessionId).toBeTruthy();
    expect(hasAnyMcpSession()).toBe(true);
    expect(body.result).toBeDefined();
  });
});

describe("the refusal's placement", () => {
  const serverSrc = fs.readFileSync(
    path.join(import.meta.dirname, "..", "..", "src", "server", "mcp", "server.ts"),
    "utf-8",
  );

  it("sits above the isInit branch in POST /mcp", () => {
    const post = serverSrc.indexOf('mcpApp.post("/mcp"');
    expect(post).toBeGreaterThan(-1);
    const refusal = serverSrc.indexOf("aiRefusal()", post);
    const isInit = serverSrc.indexOf("const isInit", post);
    expect(refusal, "POST /mcp must call aiRefusal()").toBeGreaterThan(post);
    expect(isInit).toBeGreaterThan(post);
    expect(refusal, "the licence check must precede the isInit branch").toBeLessThan(isInit);
  });

  it("sits in the GET handler before dispatchToSession, never inside it", () => {
    const get = serverSrc.indexOf('mcpApp.get("/mcp"');
    const refusal = serverSrc.indexOf("aiRefusal()", get);
    const dispatch = serverSrc.indexOf("dispatchToSession(", get);
    expect(refusal).toBeGreaterThan(get);
    expect(refusal).toBeLessThan(dispatch);
    const helper = serverSrc.indexOf("async function dispatchToSession");
    const helperEnd = serverSrc.indexOf("\n  }\n", helper);
    expect(serverSrc.slice(helper, helperEnd)).not.toContain("aiRefusal");
  });
});

describe("no per-tool licence wrapper survives", () => {
  const SRC = allMcpSource();

  it("tools are registered with withErrorBoundary and no gatedTool remains", () => {
    // Anti-vacuity: both derivations found real tools.
    expect(registeredToolNames(SRC).size).toBeGreaterThan(0);
    expect(wrappedToolNames(SRC).size).toBeGreaterThan(0);
    expect(/\bgatedTool\(/.test(SRC)).toBe(false);
  });

  // tandem_resolveAnnotation is KEPT (D4): ADR-040 decision 2 planned to retire
  // it, but with the handshake refusing unlicensed Claude, retiring it would
  // only take dismissal away from licensed users. Split out of #1521.
  it("tandem_resolveAnnotation is still registered", () => {
    expect(wrappedToolNames(SRC).has("tandem_resolveAnnotation")).toBe(true);
  });
});
