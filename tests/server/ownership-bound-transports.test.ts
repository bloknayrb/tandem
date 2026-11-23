import type { Server } from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Supervisor } from "../../src/server/launcher/supervisor.js";
import {
  boundTransportKinds,
  closeMcpSession,
  startMcpServerHttp,
} from "../../src/server/mcp/server.js";
import {
  endSpawn,
  markSpawnStarted,
  registerSpawn,
  resetOwnerHandleBindForTests,
  type SpawnBind,
} from "../../src/server/sessions/owner-handle-bind.js";
import { resetOwnershipForTests } from "../../src/server/sessions/ownership.js";
import { API_LAUNCHER_STATUS } from "../../src/shared/api-paths.js";
import { TANDEM_CLIENT_ID_HEADER } from "../../src/shared/cli-runtime.js";
import type { LauncherStatus } from "../../src/shared/launcher/contract.js";
import { allocPort } from "../helpers/alloc-port.js";

/**
 * The Settings list of bound transports through the real HTTP server (#2358
 * PR 3b-2e1, ownership design §3.3's Ruling C): transports bind by the real
 * `initialize` (a spawn registered the way the supervisor does), and the list
 * is read both from `boundTransportKinds` and from the real
 * `GET /api/launcher/status`, whose supervisor is a stand-in reporting a
 * running child. The rows carry a kind and nothing else: no `Mcp-Session-Id`,
 * no owner id, no Claude session id, no handle.
 */

const MCP_ACCEPT = "application/json, text/event-stream";
const SID = "4c7a9f2e-1b3d-4e5f-8a6b-0c1d2e3f4a5b";
const CLIENT_ID = "7d6c5b4a-3928-4170-8a9b-0c1d2e3f4a5c";
const LIVE = `th_${"L".repeat(32)}`;

let httpServer: Server | undefined;
let baseUrl: string;
const mcpIds: string[] = [];

const RUNNING_SUP = {
  status: () => ({
    running: true,
    reaperPid: 4242,
    cwd: "/home/test",
    sessionId: SID,
    resuming: false,
    busy: false,
    spawnedAt: 0,
  }),
} as unknown as Supervisor;

beforeEach(async () => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  baseUrl = `http://127.0.0.1:${await allocPort()}`;
  mcpIds.length = 0;
});

afterEach(async () => {
  await closeMcpSession();
  if (httpServer) await new Promise<void>((r) => httpServer?.close(() => r()));
  httpServer = undefined;
  resetOwnershipForTests();
  resetOwnerHandleBindForTests();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

async function boot(flag: "1" | "") {
  vi.stubEnv("TANDEM_OWNERSHIP", flag);
  httpServer = await startMcpServerHttp(
    Number(new URL(baseUrl).port),
    "127.0.0.1",
    undefined,
    undefined,
    {
      getSupervisor: () => RUNNING_SUP,
      unavailableReason: () => "spawn-failed",
      startSupervisor: async () => {},
    },
  );
}

function startedSpawn(): SpawnBind {
  const s = registerSpawn({ handle: LIVE, sessionId: SID });
  markSpawnStarted(s);
  return s;
}

async function initialize(headers: Record<string, string>): Promise<void> {
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
  mcpIds.push(res.headers.get("mcp-session-id") ?? "");
  await res.text();
}

const bound = { "X-Tandem-Owner-Handle": LIVE, "X-Claude-Session-Id": SID };
const viaBridge = { ...bound, [TANDEM_CLIENT_ID_HEADER]: CLIENT_ID };

async function launcherStatus(): Promise<{ text: string; body: LauncherStatus }> {
  const res = await fetch(`${baseUrl}${API_LAUNCHER_STATUS}`);
  expect(res.status).toBe(200);
  const text = await res.text();
  return { text, body: JSON.parse(text) as LauncherStatus };
}

/** Nothing on the wire that looks like an id or a handle. */
function expectNoIds(text: string): void {
  expect(text).not.toMatch(/th_/);
  expect(text).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
  expect(text).not.toMatch(/claude:|http:|spawn:|private:|tandem:/);
  for (const id of [...mcpIds, SID, CLIENT_ID]) if (id) expect(text).not.toContain(id);
}

describe("flag on: the bound transports, by kind", () => {
  it("lists a bridge bind and a direct-HTTP bind, never an unbound transport, and labels only", async () => {
    await boot("1");
    startedSpawn();
    await initialize(viaBridge);
    await initialize(bound);
    await initialize({ "X-Claude-Session-Id": SID, [TANDEM_CLIENT_ID_HEADER]: CLIENT_ID });
    await initialize({});

    expect(
      boundTransportKinds()
        ?.map((r) => r.kind)
        .sort(),
    ).toEqual(["bridge", "direct-http"]);
    const { text, body } = await launcherStatus();
    expect(body).toMatchObject({ available: true, running: true });
    const rows = (body as Extract<LauncherStatus, { running: true }>).boundTransports;
    expect(rows?.map((r) => r.kind).sort()).toEqual(["bridge", "direct-http"]);
    for (const row of rows ?? []) expect(Object.keys(row)).toEqual(["kind"]);
    expectNoIds(text);
  });

  it("a spawn's teardown takes its transports off the list, and the field goes with them", async () => {
    await boot("1");
    const spawn = startedSpawn();
    await initialize(viaBridge);
    expect(boundTransportKinds()).toEqual([{ kind: "bridge" }]);
    endSpawn(spawn);
    expect(boundTransportKinds()).toEqual([]);
    const { body } = await launcherStatus();
    expect(body).not.toHaveProperty("boundTransports");
  });

  it("nothing bound: an empty list, and no field on the wire", async () => {
    await boot("1");
    startedSpawn();
    await initialize({ "X-Claude-Session-Id": SID });
    expect(boundTransportKinds()).toEqual([]);
    expect((await launcherStatus()).body).not.toHaveProperty("boundTransports");
  });
});

describe("flag off: no list and no field", () => {
  it("the same binds list nothing, and the status body has no `boundTransports`", async () => {
    await boot("");
    startedSpawn();
    await initialize(viaBridge);
    await initialize(bound);
    expect(boundTransportKinds()).toBeUndefined();
    const { body } = await launcherStatus();
    expect(body).toMatchObject({ available: true, running: true });
    expect(body).not.toHaveProperty("boundTransports");
    expect(body).not.toHaveProperty("bindFailed");
  });
});
