import type { Server } from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  closeMcpSession,
  mcpSessionOwnerIdsForTests,
  startMcpServerHttp,
} from "../../src/server/mcp/server.js";
import { sessionIdForLog } from "../../src/server/sessions/log-id.js";
import {
  getOwnerRecord,
  ownershipSnapshotForTests,
  resetOwnershipForTests,
  setGraceMsForTests,
} from "../../src/server/sessions/ownership.js";
import { allocPort } from "../helpers/alloc-port.js";

/**
 * Owner records through the real HTTP server (#2358, ADR-054; ownership design
 * §3.1, §3.4, §11.1): what each `initialize` header shape resolves to, the
 * caller a tool call carries, attachment from real streams, the log lines, and
 * — flag off — that none of it happens.
 */

const MCP_ACCEPT = "application/json, text/event-stream";
let httpServer: Server;
let baseUrl: string;
let logs: string[];

beforeEach(async () => {
  logs = [];
  vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
    logs.push(args.map(String).join(" "));
  });
  const port = await allocPort();
  baseUrl = `http://127.0.0.1:${port}`;
});

afterEach(async () => {
  await closeMcpSession();
  if (httpServer) await new Promise<void>((resolve) => httpServer.close(() => resolve()));
  resetOwnershipForTests();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

async function boot(flag: "1" | "") {
  vi.stubEnv("TANDEM_OWNERSHIP", flag);
  httpServer = await startMcpServerHttp(Number(new URL(baseUrl).port), "127.0.0.1");
}

/** Initialize with the given identity headers; returns the minted Mcp-Session-Id. */
async function initialize(headers: Record<string, string>, clientName = "probe"): Promise<string> {
  const base = { "Content-Type": "application/json", Accept: MCP_ACCEPT, ...headers };
  const res = await fetch(`${baseUrl}/mcp`, {
    method: "POST",
    headers: base,
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: clientName, version: "1.0.0" },
      },
    }),
  });
  const id = res.headers.get("mcp-session-id") ?? "";
  await res.text();
  await fetch(`${baseUrl}/mcp`, {
    method: "POST",
    headers: { ...base, "mcp-session-id": id },
    body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
  }).then((r) => r.text());
  return id;
}

async function callTool(sessionId: string, name: string, args: Record<string, unknown> = {}) {
  const res = await fetch(`${baseUrl}/mcp`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: MCP_ACCEPT,
      "mcp-session-id": sessionId,
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name, arguments: args },
    }),
  });
  return { status: res.status, body: await res.text() };
}

async function deleteSession(sessionId: string) {
  const res = await fetch(`${baseUrl}/mcp`, {
    method: "DELETE",
    headers: { Accept: MCP_ACCEPT, "mcp-session-id": sessionId },
  });
  await res.text();
}

const waitFor = async (cond: () => boolean, ms = 3000) => {
  const end = Date.now() + ms;
  while (!cond() && Date.now() < end) await new Promise((r) => setTimeout(r, 10));
  return cond();
};

const CLAUDE = "4c7a9f2e-1b3d-4e5f-8a6b-0c1d2e3f4a5b";
const CLIENT = "9e8d7c6b-5a49-4382-9170-6f5e4d3c2b1a";

describe("flag on", () => {
  it("each initialize header shape resolves to its record kind, with no dangling owner", async () => {
    await boot("1");
    const a = await initialize({
      "X-Claude-Session-Id": CLAUDE.toUpperCase(),
      "X-Tandem-Client-Id": CLIENT,
    });
    const b = await initialize({ "X-Tandem-Client-Id": CLIENT });
    const c = await initialize({});
    expect(getOwnerRecord(`claude:${CLAUDE}`)?.recordKind).toBe("claude");
    expect(getOwnerRecord(`bridge:${CLIENT}`)?.recordKind).toBe("bridge");
    expect(getOwnerRecord(`http:${c}`)?.recordKind).toBe("http");
    expect(mcpSessionOwnerIdsForTests().sort()).toEqual(
      [`bridge:${CLIENT}`, `claude:${CLAUDE}`, `http:${c}`].sort(),
    );
    for (const id of mcpSessionOwnerIdsForTests())
      expect(getOwnerRecord(id as string)).toBeDefined();
    expect([a, b, c].every(Boolean)).toBe(true);
  });

  it("a malformed identity header is ignored, not trusted", async () => {
    await boot("1");
    const id = await initialize({ "X-Tandem-Client-Id": "x".repeat(300) });
    expect(getOwnerRecord(`http:${id}`)?.recordKind).toBe("http");
  });

  it("a tool call carries its transport's record (tandem_checkInbox stamps that record's poll time)", async () => {
    await boot("1");
    const id = await initialize({ "X-Tandem-Client-Id": CLIENT });
    expect(getOwnerRecord(`bridge:${CLIENT}`)?.lastPollAt).toBeUndefined();
    const res = await callTool(id, "tandem_checkInbox");
    expect(res.status).toBe(200);
    expect(res.body).not.toContain("no caller identity");
    expect(getOwnerRecord(`bridge:${CLIENT}`)?.lastPollAt).toBeTypeOf("number");
    // Only the inbox poll counts as a poll.
    const other = await initialize({
      "X-Tandem-Client-Id": "11111111-2222-4333-8444-555555555555",
    });
    await callTool(other, "tandem_listDocuments");
    expect(
      getOwnerRecord("bridge:11111111-2222-4333-8444-555555555555")?.lastPollAt,
    ).toBeUndefined();
  });

  it("DELETE of its last transport starts the grace; the record is deleted at lapse", async () => {
    await boot("1");
    setGraceMsForTests(50);
    const id = await initialize({ "X-Claude-Session-Id": CLAUDE });
    await deleteSession(id);
    expect(await waitFor(() => getOwnerRecord(`claude:${CLAUDE}`) === undefined)).toBe(true);
    expect(ownershipSnapshotForTests().timers).toBe(0);
  });

  it("a GET the server rejected never counts as having held a stream", async () => {
    await boot("1");
    setGraceMsForTests(50);
    const id = await initialize({ "X-Tandem-Client-Id": CLIENT });
    // Wrong Accept: rejected before any stream is established.
    const res = await fetch(`${baseUrl}/mcp`, {
      method: "GET",
      headers: { Accept: "application/json", "mcp-session-id": id },
    });
    await res.text();
    expect(res.status).not.toBe(200);
    await new Promise((r) => setTimeout(r, 150));
    // Still attached (no stream ever held): no grace ran, nothing lapsed.
    expect(getOwnerRecord(`bridge:${CLIENT}`)?.lapsed).toBeUndefined();
    expect(ownershipSnapshotForTests().timers).toBe(0);
  });

  it("an established stream that closes detaches the record, which lapses", async () => {
    await boot("1");
    setGraceMsForTests(50);
    const id = await initialize({ "X-Tandem-Client-Id": CLIENT });
    const ctrl = new AbortController();
    const stream = await fetch(`${baseUrl}/mcp`, {
      method: "GET",
      headers: { Accept: "text/event-stream", "mcp-session-id": id },
      signal: ctrl.signal,
    });
    expect(stream.status).toBe(200);
    ctrl.abort();
    expect(await waitFor(() => getOwnerRecord(`bridge:${CLIENT}`)?.lapsed === true)).toBe(true);
    // Its transport is still registered, so it keeps its record.
    expect(getOwnerRecord(`bridge:${CLIENT}`)).toBeDefined();
  });

  it("no log line carries a raw session id; the hash is stable; the client id is never logged", async () => {
    await boot("1");
    const a = await initialize({ "X-Claude-Session-Id": CLAUDE, "X-Tandem-Client-Id": CLIENT });
    await callTool(a, "tandem_listDocuments");
    await deleteSession(a);
    const b = await initialize({ "X-Claude-Session-Id": CLAUDE.toUpperCase() });
    await closeMcpSession(); // explicit closes of what is left
    const text = logs.join("\n");
    expect(text).toContain("MCP session established");
    for (const raw of [a, b, CLAUDE, CLAUDE.toUpperCase(), CLIENT]) expect(text).not.toContain(raw);
    expect(text).toContain(sessionIdForLog(a));
    // One Claude session sent in two cases logs as one hash.
    expect(sessionIdForLog(CLAUDE)).toBe(sessionIdForLog(CLAUDE.toUpperCase()));
    expect(text.split(sessionIdForLog(CLAUDE)).length - 1).toBe(2);
  });
});

describe("flag off: today's behaviour, and nothing created", () => {
  it("no record, no owner on any entry, and log lines print ids as received — but never the client id", async () => {
    await boot("");
    const a = await initialize({ "X-Claude-Session-Id": CLAUDE, "X-Tandem-Client-Id": CLIENT });
    const b = await initialize({ "X-Tandem-Client-Id": CLIENT });
    const c = await initialize({});
    for (const id of [a, b, c]) {
      const res = await callTool(id, "tandem_checkInbox");
      expect(res.status).toBe(200);
      expect(res.body).not.toContain("no caller identity");
    }
    const GET = new AbortController();
    const s = await fetch(`${baseUrl}/mcp`, {
      method: "GET",
      headers: { Accept: "text/event-stream", "mcp-session-id": a },
      signal: GET.signal,
    });
    expect(s.status).toBe(200);
    GET.abort();
    await deleteSession(c);
    expect(mcpSessionOwnerIdsForTests()).toEqual([undefined, undefined]);
    expect(ownershipSnapshotForTests()).toEqual({
      transportMode: undefined,
      records: [],
      ownerByDoc: [],
      handoverSeq: [],
      timers: 0,
    });
    const text = logs.join("\n");
    expect(text).toContain(
      `MCP session established: ${a} (claude session ${CLAUDE}) (client probe)`,
    );
    expect(text).toContain(`MCP session closed: ${c}`);
    expect(text).not.toContain(CLIENT);
    expect(text).not.toMatch(/#[0-9a-f]{8}/);
  });
});
