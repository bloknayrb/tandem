import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { closeDocumentById, getOpenDocs } from "../../src/server/mcp/document-service.js";
import {
  closeMcpSession,
  mcpSessionBindsForTests,
  mcpSessionOwnerIdsForTests,
  reapIdleMcpSessions,
  startMcpServerHttp,
} from "../../src/server/mcp/server.js";
import {
  endSpawn,
  markSpawnStarted,
  ownerHandleBindSnapshotForTests,
  registerSpawn,
  resetOwnerHandleBindForTests,
  type SpawnBind,
} from "../../src/server/sessions/owner-handle-bind.js";
import {
  getOwnerRecord,
  heldDocumentIds,
  resetOwnershipForTests,
  TANDEM_OWNER_ID,
} from "../../src/server/sessions/ownership.js";
import { allocPort } from "../helpers/alloc-port.js";

/**
 * The bind fact through the real HTTP server's `initialize` (#2358 PR 3a,
 * Requirement 3; Rulings A, B, D7). Handles are supplied by the test and
 * registered as a spawn the way the supervisor does; the fact is read through
 * the test-only snapshot. The launcher half and the chain are in
 * tests/server/launcher/owner-handle-spawn.test.ts.
 */

const MCP_ACCEPT = "application/json, text/event-stream";
const SID = "4c7a9f2e-1b3d-4e5f-8a6b-0c1d2e3f4a5b";
const OTHER_SID = "9e8d7c6b-5a49-4382-9170-6f5e4d3c2b1a";
const handle = (c: string) => `th_${c.repeat(32)}`;
const LIVE = handle("L");

let httpServer: Server | undefined;
let baseUrl: string;
let logs: string[];
let docDir: string | undefined;

beforeEach(async () => {
  logs = [];
  vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
    logs.push(args.map(String).join(" "));
  });
  baseUrl = `http://127.0.0.1:${await allocPort()}`;
});

afterEach(async () => {
  for (const id of [...getOpenDocs().keys()]) await closeDocumentById(id).catch(() => {});
  await closeMcpSession();
  if (httpServer) await new Promise<void>((r) => httpServer?.close(() => r()));
  httpServer = undefined;
  resetOwnershipForTests();
  resetOwnerHandleBindForTests();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.useRealTimers();
  if (docDir) rmSync(docDir, { recursive: true, force: true });
  docDir = undefined;
});

async function boot(flag: "1" | "") {
  vi.stubEnv("TANDEM_OWNERSHIP", flag);
  httpServer = await startMcpServerHttp(Number(new URL(baseUrl).port), "127.0.0.1");
}

function startedSpawn(h = LIVE, sessionId = SID): SpawnBind {
  const s = registerSpawn({ handle: h, sessionId });
  markSpawnStarted(s);
  return s;
}

async function initialize(headers: Record<string, string>): Promise<string> {
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
        clientInfo: { name: "probe", version: "1.0.0" },
      },
    }),
  });
  expect(res.status).toBe(200);
  const id = res.headers.get("mcp-session-id") ?? "";
  await res.text();
  await post(id, { jsonrpc: "2.0", method: "notifications/initialized" }, headers);
  return id;
}

async function post(sessionId: string, body: unknown, headers: Record<string, string> = {}) {
  const res = await fetch(`${baseUrl}/mcp`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: MCP_ACCEPT,
      "mcp-session-id": sessionId,
      ...headers,
    },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.text() };
}

const callTool = (id: string, name: string, args: Record<string, unknown>, headers = {}) =>
  post(
    id,
    { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name, arguments: args } },
    headers,
  );

const bindOf = (id: string) =>
  mcpSessionBindsForTests().find((b) => b.sessionId === id)?.boundSpawn;
const withHandle = (h: string, sid?: string): Record<string, string> => ({
  "X-Tandem-Owner-Handle": h,
  ...(sid !== undefined ? { "X-Claude-Session-Id": sid } : {}),
});
const unboundLines = () =>
  logs.filter((l) => l.includes("presented an owner handle that does not bind"));
const boundLines = () => logs.filter((l) => l.includes("bound to Tandem's Claude's current run"));

describe("flag on: the bind fact (R3)", () => {
  it("binds the live handle with the spawn's session id; the record is claude:<id> as without a handle (Ruling A)", async () => {
    await boot("1");
    const spawn = startedSpawn();
    const id = await initialize(withHandle(LIVE, SID));
    expect(bindOf(id)).toBe(spawn.serial);
    expect(mcpSessionOwnerIdsForTests()).toEqual([`claude:${SID}`]);
    expect(getOwnerRecord(TANDEM_OWNER_ID)).toBeUndefined();
    expect(boundLines()).toHaveLength(1);
    for (const l of logs) {
      expect(l).not.toContain(LIVE);
      expect(l).not.toContain(SID);
    }

    // The bound transport writes; the `tandem` record holds nothing.
    docDir = mkdtempSync(join(tmpdir(), "owner-handle-bind-"));
    const file = join(docDir, "d.md");
    writeFileSync(file, "Hello world\n");
    const opened = await callTool(id, "tandem_open", { filePath: file });
    expect(opened.status).toBe(200);
    const commented = await callTool(id, "tandem_comment", { from: 0, to: 5, text: "c" });
    expect(commented.status).toBe(200);
    expect(commented.body).not.toContain('"error"');
    expect(heldDocumentIds(TANDEM_OWNER_ID)).toEqual([]);
    expect(getOwnerRecord(TANDEM_OWNER_ID)).toBeUndefined();
    expect(heldDocumentIds(`claude:${SID}`).length).toBeGreaterThan(0);
  });

  it.each([
    ["an old spawn's handle", () => handle("O"), SID],
    ["a random well-formed handle", () => handle("R"), SID],
    ["a malformed handle", () => "th_nope", SID],
    ["the live handle with no session id", () => LIVE, undefined],
    ["the live handle with another session id", () => LIVE, OTHER_SID],
  ])("does not bind %s, and the initialize succeeds", async (_n, h, sid) => {
    await boot("1");
    const old = startedSpawn(handle("O"), SID);
    endSpawn(old);
    startedSpawn();
    const id = await initialize(withHandle(h(), sid));
    expect(id).not.toBe("");
    expect(bindOf(id)).toBeNull();
    expect(unboundLines()).toHaveLength(1);
  });

  it("logs one not-bound line for the first of them in a spawn, none for the rest (Ruling D7)", async () => {
    await boot("1");
    startedSpawn();
    for (const [h, sid] of [
      [handle("O"), SID],
      [handle("R"), SID],
      ["th_nope", SID],
      [LIVE, undefined],
      [LIVE, OTHER_SID],
    ] as const) {
      await initialize(withHandle(h, sid));
    }
    expect(unboundLines()).toHaveLength(1);
    // A terminal that sends no handle logs nothing new.
    await initialize({ "X-Claude-Session-Id": OTHER_SID });
    expect(unboundLines()).toHaveLength(1);
    // A new spawn may log once more.
    startedSpawn(handle("N"), SID);
    await initialize(withHandle(handle("R"), SID));
    expect(unboundLines()).toHaveLength(2);
  });

  it("with no current spawn, logs at most once a minute", async () => {
    await boot("1");
    vi.useFakeTimers({ toFake: ["Date"] });
    await initialize(withHandle(LIVE, SID));
    await initialize(withHandle(LIVE, SID));
    expect(unboundLines()).toHaveLength(1);
    vi.setSystemTime(Date.now() + 61_000);
    await initialize(withHandle(LIVE, SID));
    expect(unboundLines()).toHaveLength(2);
  });

  it("later requests never change the fact (R3.3)", async () => {
    await boot("1");
    const spawn = startedSpawn();
    const bound = await initialize(withHandle(LIVE, SID));
    const unbound = await initialize({ "X-Claude-Session-Id": SID });
    await callTool(bound, "tandem_listDocuments", {}, withHandle(handle("X"), SID));
    await callTool(bound, "tandem_listDocuments", {});
    await callTool(unbound, "tandem_listDocuments", {}, withHandle(LIVE, SID));
    expect(bindOf(bound)).toBe(spawn.serial);
    expect(bindOf(unbound)).toBeNull();
  });

  it("a re-initialize after a 404 binds again, while the spawn is current", async () => {
    await boot("1");
    const spawn = startedSpawn();
    const first = await initialize(withHandle(LIVE, SID));
    const gone = await post("no-such-session", { jsonrpc: "2.0", id: 9, method: "tools/list" });
    expect(gone.status).toBe(404);
    const again = await initialize(withHandle(LIVE, SID));
    expect(again).not.toBe(first);
    expect(bindOf(again)).toBe(spawn.serial);
  });

  it("an LRU eviction removes a bound transport's fact, and its re-initialize binds again", async () => {
    await boot("1");
    const spawn = startedSpawn();
    const bound = await initialize(withHandle(LIVE, SID));
    for (let i = 0; i < 16; i++) await initialize({});
    expect(bindOf(bound)).toBeUndefined();
    expect(ownerHandleBindSnapshotForTests().spawns[0].bound).not.toContain(bound);
    const again = await initialize(withHandle(LIVE, SID));
    expect(bindOf(again)).toBe(spawn.serial);
  });

  it("the idle reaper and a DELETE remove a bound transport's fact", async () => {
    await boot("1");
    startedSpawn();
    const reaped = await initialize(withHandle(LIVE, SID));
    const deleted = await initialize(withHandle(LIVE, SID));
    await fetch(`${baseUrl}/mcp`, {
      method: "DELETE",
      headers: { Accept: MCP_ACCEPT, "mcp-session-id": deleted },
    }).then((r) => r.text());
    expect(bindOf(deleted)).toBeUndefined();
    expect(await reapIdleMcpSessions(-1)).toBeGreaterThan(0);
    expect(bindOf(reaped)).toBeUndefined();
    expect(ownerHandleBindSnapshotForTests().spawns[0].bound).toEqual([]);
  });

  it("after the spawn's teardown the fact is gone for its transports and its handle binds nothing new", async () => {
    await boot("1");
    const spawn = startedSpawn();
    const id = await initialize(withHandle(LIVE, SID));
    expect(bindOf(id)).toBe(spawn.serial);
    endSpawn(spawn);
    expect(bindOf(id)).toBeNull();
    const later = await initialize(withHandle(LIVE, SID));
    expect(bindOf(later)).toBeNull();
    // The transport keeps its record (Ruling A: teardown moves nothing).
    expect(mcpSessionOwnerIdsForTests()).toEqual([`claude:${SID}`, `claude:${SID}`]);
  });

  it("a late teardown of an older spawn leaves a newer, bound spawn alone (R4.3, every platform)", async () => {
    await boot("1");
    const older = startedSpawn(handle("O"), SID);
    const newer = startedSpawn(LIVE, SID);
    const id = await initialize(withHandle(LIVE, SID));
    expect(bindOf(id)).toBe(newer.serial);
    endSpawn(older); // the superseded spawn's teardown lands late
    expect(ownerHandleBindSnapshotForTests().current).toBe(newer.serial);
    expect(bindOf(id)).toBe(newer.serial);
    const again = await initialize(withHandle(LIVE, SID));
    expect(bindOf(again)).toBe(newer.serial);
    const stale = await initialize(withHandle(handle("O"), SID));
    expect(bindOf(stale)).toBeNull();
  });

  it("a spawn registered but not started binds nothing (Terms: not current)", async () => {
    await boot("1");
    registerSpawn({ handle: LIVE, sessionId: SID });
    const id = await initialize(withHandle(LIVE, SID));
    expect(bindOf(id)).toBeNull();
  });

  it("a teardown landing during registry.add's await is not recorded as bound (R3.9)", async () => {
    await boot("1");
    const spawn = startedSpawn();
    // Fill the registry so the next add awaits an LRU eviction, and end the
    // spawn from inside that eviction's removal.
    for (let i = 0; i < 16; i++) await initialize({});
    const origError = console.error as unknown as (...a: unknown[]) => void;
    vi.mocked(console.error).mockImplementation((...args: unknown[]) => {
      const line = args.map(String).join(" ");
      if (line.includes("evicting least-recently-used")) endSpawn(spawn);
      logs.push(line);
      void origError;
    });
    const id = await initialize(withHandle(LIVE, SID));
    expect(id).not.toBe("");
    expect(bindOf(id)).toBeNull();
    expect(boundLines()).toHaveLength(0);
    expect(mcpSessionOwnerIdsForTests()).toContain(`claude:${SID}`);
  });
});

describe("flag off: the server ignores the header", () => {
  it("no fact, no log line, no state", async () => {
    await boot("");
    startedSpawn();
    const id = await initialize(withHandle(LIVE, SID));
    await initialize(withHandle("th_nope", SID));
    expect(mcpSessionBindsForTests().every((b) => b.boundSpawn === null)).toBe(true);
    expect(bindOf(id)).toBeNull();
    expect(boundLines()).toHaveLength(0);
    expect(unboundLines()).toHaveLength(0);
    expect(ownerHandleBindSnapshotForTests().spawns[0].bound).toEqual([]);
  });
});
