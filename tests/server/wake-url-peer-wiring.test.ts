/**
 * #1952 end to end: `server.ts` sets `peerIsLoopback` from the TCP peer, and the production
 * `tandem_status` hands `wakeUrl` to a loopback caller only.
 *
 * `wake-url-surfacing.test.ts` proves `wakeUrlField()`'s logic by wrapping `callTool` in a
 * context it builds itself, so it would stay green if `server.ts` never set the field, or set
 * it from the `Host` header. This file is the wiring half: a real `startMcpServerHttp`, which
 * attaches the real wake socket (so `getWakeEndpoint()` is live without mocking), driven over
 * raw HTTP.
 *
 * The non-loopback peer is a client socket bound to source address `127.0.0.2`: `isLoopback`
 * accepts exactly `127.0.0.1` / `::1` / `::ffff:127.0.0.1`, so the server sees a genuinely
 * non-loopback `req.socket.remoteAddress` while nothing leaves the machine. That needs a
 * bindable `127.0.0.2`, which only Linux's `lo` carries out of the box (see the PLATFORM note
 * in `server-security-invariants.test.ts`), so ONLY that describe is Linux-gated. The loopback
 * half runs everywhere, so a wiring regression that drops the field for every caller cannot
 * hide behind a skip.
 */

import { request as httpRequest, type Server } from "node:http";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { startMcpServerHttp } from "../../src/server/mcp/server.js";
import { allocPort } from "../helpers/alloc-port.js";

const TOKEN = "test-token-1952-wakeurl-peer";
const MCP_ACCEPT = "application/json, text/event-stream";

let port: number;
let httpServer: Server;

beforeEach(async () => {
  port = await allocPort();
  // A token, so the non-loopback peer can authenticate and reach the tool at all: the
  // assertion is about what an AUTHENTICATED remote client is handed, not about auth.
  httpServer = await startMcpServerHttp(port, "127.0.0.1", TOKEN);
});

afterEach(async () => {
  await new Promise<void>((resolve, reject) => {
    httpServer.close((err) => (err ? reject(err) : resolve()));
  });
});

interface PeerOpts {
  localAddress?: string;
  authorization?: string;
  host?: string;
}

function post(
  body: unknown,
  opts: PeerOpts,
  sessionId?: string,
): Promise<{ status: number; sessionId?: string; text: string }> {
  return new Promise((resolve, reject) => {
    const payload = Buffer.from(JSON.stringify(body), "utf8");
    const headers: Record<string, string | number> = {
      Host: opts.host ?? `127.0.0.1:${port}`,
      "Content-Type": "application/json",
      Accept: MCP_ACCEPT,
      "Content-Length": payload.length,
    };
    if (opts.authorization) headers.Authorization = opts.authorization;
    if (sessionId) headers["mcp-session-id"] = sessionId;
    const req = httpRequest(
      {
        host: "127.0.0.1",
        port,
        path: "/mcp",
        method: "POST",
        headers,
        ...(opts.localAddress ? { localAddress: opts.localAddress } : {}),
      },
      (res) => {
        let text = "";
        res.setEncoding("utf8");
        res.on("data", (c: string) => {
          text += c;
        });
        res.on("end", () => {
          const sid = res.headers["mcp-session-id"];
          resolve({
            status: res.statusCode ?? 0,
            sessionId: typeof sid === "string" ? sid : undefined,
            text,
          });
        });
      },
    );
    req.on("error", reject);
    req.end(payload);
  });
}

/** The JSON-RPC frame with `id`, from an SSE or plain-JSON body. */
function rpcFrame(text: string, id: number): Record<string, unknown> {
  const frames = text.trimStart().startsWith("{")
    ? [JSON.parse(text) as Record<string, unknown>]
    : text
        .split("\n")
        .map((l) => l.trim())
        .filter((l) => l.startsWith("data:"))
        .map((l) => JSON.parse(l.slice("data:".length).trim()) as Record<string, unknown>);
  const match = frames.find((f) => f.id === id);
  expect(match, `no JSON-RPC frame with id ${id} in ${text}`).toBeDefined();
  return match as Record<string, unknown>;
}

/** Initialize a session as this peer and return `tandem_status`'s parsed `data`. */
async function statusAs(opts: PeerOpts): Promise<Record<string, unknown>> {
  return statusOn(await openSession(opts), opts);
}

/** Initialize a session as this peer; returns its `Mcp-Session-Id`. */
async function openSession(opts: PeerOpts): Promise<string> {
  const init = await post(
    {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "wake-peer-test", version: "1.0.0" },
      },
    },
    opts,
  );
  expect(init.status, `initialize failed: ${init.text}`).toBe(200);
  const sid = init.sessionId;
  expect(sid, "initialize minted no session id").toBeTruthy();

  await post({ jsonrpc: "2.0", method: "notifications/initialized" }, opts, sid);
  return sid as string;
}

/** Call `tandem_status` on session `sid` as this peer and return its parsed `data`. */
async function statusOn(sid: string, opts: PeerOpts): Promise<Record<string, unknown>> {
  const call = await post(
    {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "tandem_status", arguments: {} },
    },
    opts,
    sid,
  );
  expect(call.status, `tools/call failed: ${call.text}`).toBe(200);
  const result = rpcFrame(call.text, 2).result as {
    isError?: boolean;
    content: Array<{ type: string; text?: string }>;
  };
  expect(result, `tools/call returned no result: ${call.text}`).toBeDefined();
  expect(result.isError ?? false, `tandem_status errored: ${call.text}`).toBe(false);
  const envelope = JSON.parse(result.content.find((c) => c.type === "text")?.text ?? "null") as {
    data: Record<string, unknown>;
  };
  return envelope.data;
}

describe("wakeUrl over real HTTP — a loopback peer (#1952)", () => {
  it("is handed the live wake address", async () => {
    const data = await statusAs({});
    expect(data.wakeUrl).toBe(`ws://127.0.0.1:${port}/api/wake`);
  });
});

describe.skipIf(process.platform !== "linux")(
  "wakeUrl over real HTTP — a non-loopback peer (#1952; Linux only — needs a bindable 127.0.0.2 source address)",
  () => {
    const REMOTE: PeerOpts = { localAddress: "127.0.0.2", authorization: `Bearer ${TOKEN}` };

    it("control: 127.0.0.2 really is non-loopback to the server (no token → 401)", async () => {
      // If isLoopback ever widens to 127/8 this source address stops being remote, and the
      // absence spec below would then be testing a loopback caller. Fail here instead.
      const res = await post(
        { jsonrpc: "2.0", id: 1, method: "initialize", params: {} },
        { localAddress: "127.0.0.2" },
      );
      expect(res.status).toBe(401);
    });

    it("an authenticated remote client is not handed wakeUrl", async () => {
      // Same-server loopback control, so a broken wake socket cannot make the absence vacuous.
      expect((await statusAs({})).wakeUrl).toBe(`ws://127.0.0.1:${port}/api/wake`);
      const data = await statusAs(REMOTE);
      expect(
        Object.keys(data),
        "control: tandem_status returned an empty payload",
      ).not.toHaveLength(0);
      expect(Object.keys(data)).not.toContain("wakeUrl");
    });

    it("a loopback-looking Host header does not make the peer loopback", async () => {
      // The peer fact comes from req.socket.remoteAddress; a remote client controls the Host
      // header. Every request here already sends `Host: 127.0.0.1:<port>`, so this adds the
      // other spelling the SDK's Host check admits.
      const viaLocalhost = await statusAs({ ...REMOTE, host: `localhost:${port}` });
      expect(Object.keys(viaLocalhost)).not.toContain("wakeUrl");
    });

    it("is decided per request, not per session: the same session flips with its peer", async () => {
      // A session id is a bearer value any peer holding it can present, so the peer fact must
      // be read on every request. A change that cached it on the registry entry at initialize
      // would pass every other spec here.
      const local = await openSession({});
      expect(Object.keys(await statusOn(local, REMOTE))).not.toContain("wakeUrl");
      expect((await statusOn(local, {})).wakeUrl).toBe(`ws://127.0.0.1:${port}/api/wake`);

      const remote = await openSession(REMOTE);
      expect((await statusOn(remote, {})).wakeUrl).toBe(`ws://127.0.0.1:${port}/api/wake`);
      expect(Object.keys(await statusOn(remote, REMOTE))).not.toContain("wakeUrl");
    });
  },
);
