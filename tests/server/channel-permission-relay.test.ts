/**
 * The channel permission relay's real shape (#1794).
 *
 * `docs/mcp-tools.md` described these three routes as a working relay: it
 * documented `POST /api/channel-permission`, `GET /api/channel-permission` and
 * `POST /api/channel-permission-verdict` as if a verdict reached Claude Code.
 * There is no return leg and there never was — nothing in `src/client/` reads
 * `pendingPermissions`, `permission_request` arrives at the shim as an MCP
 * *notification* that cannot be answered, and the verdict route deletes the
 * pending entry and echoes to its own caller. These specs pin what the routes
 * actually do, so the corrected doc cannot silently drift back.
 *
 * They also pin the one code change #1794 made: the server no longer stores,
 * serves or logs `inputPreview`, which carries Claude Code prompt content —
 * file bodies for a `Write`, the command line for a `Bash`. See #1884.
 *
 * And they pin #1884's partial fix: the GET refuses a non-loopback caller
 * (403, decided by peer address). That refusal is groundwork for ADR-056's
 * non-loopback-bind re-enable, not a same-machine control — a local process
 * chooses its own source address and can always connect from 127.0.0.1.
 *
 * `pendingPermissions` is module-level with no reset export, so every spec here
 * shares one map. Each opens by pushing a MONOTONIC fake clock past
 * `PERMISSION_TTL_MS` and issuing one draining `GET`, and `beforeEach` asserts
 * the map came back empty — so none depends on another's ordering, and a drain
 * that stops draining fails loudly instead of leaving the claim false.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerChannelRoutes } from "../../src/server/mcp/channel-routes.js";

const REQUEST_ID = "req_relay_spec";
const PERMISSION_TTL_MS = 30_000;

/**
 * Fake-clock base, carried ACROSS specs. `vi.useFakeTimers()` re-seeds
 * `Date.now()` to the real current time on every install, so a per-spec
 * `advanceTimersByTime(PERMISSION_TTL_MS)` computes a leftover entry's age as
 * a few milliseconds — the drain then evicts nothing and the independence
 * claim above is false. Advancing our own base is what actually ages the
 * leftovers. `afterEach` folds in any time a spec added so the base never
 * moves backwards.
 */
let clock = Date.now();

type Handler = (req: unknown, res: unknown, next?: unknown) => void;

/** Records `app.<method>(path, ...handlers)` so a spec can call the real one. */
function makeRecorderApp() {
  const routes = new Map<string, Handler[]>();
  const record =
    (method: string) =>
    (path: string, ...handlers: Handler[]) => {
      routes.set(`${method} ${path}`, handlers);
    };
  return {
    // `delete` is required: registerChannelRoutes calls app.delete(API_CHAT, …)
    // and throws without it.
    app: {
      get: record("GET"),
      post: record("POST"),
      options: record("OPTIONS"),
      delete: record("DELETE"),
    },
    routes,
  };
}

function makeRes() {
  const res = {
    _status: 200,
    _body: undefined as unknown,
    status(code: number) {
      res._status = code;
      return res;
    },
    json(body: unknown) {
      res._body = body;
      return res;
    },
  };
  return res;
}

let routes: Map<string, Handler[]>;

/** The peer a request arrives from: a socket shape, or `null` for no socket. */
type Peer = { remoteAddress?: string } | null;

const LOOPBACK_PEER: Peer = { remoteAddress: "127.0.0.1" };

/**
 * Invoke the last handler registered for `key` (the route's own body).
 *
 * `peer` defaults to loopback so every pre-#1884 spec (and the `beforeEach`
 * drain) stays a loopback call. A default parameter would also turn a passed
 * literal `undefined` into loopback, silently converting an "unknown address"
 * row into an admitted one — so that argument is refused outright: pass
 * `{ remoteAddress: undefined }` (a socket with no address) or `null` (no
 * socket) instead.
 */
function call(key: string, body: unknown, ...rest: [peer?: Peer]): ReturnType<typeof makeRes> {
  if (rest.length === 1 && rest[0] === undefined) {
    throw new Error("call(): pass a Peer shape or null, never a literal undefined");
  }
  const peer = rest.length === 0 ? LOOPBACK_PEER : (rest[0] as Peer);
  const handlers = routes.get(key);
  if (!handlers || handlers.length === 0) throw new Error(`no route registered for ${key}`);
  const res = makeRes();
  handlers[handlers.length - 1]!(peer === null ? { body } : { body, socket: peer }, res);
  return res;
}

beforeEach(() => {
  const recorder = makeRecorderApp();
  // biome-ignore lint/suspicious/noExplicitAny: minimal Express app double
  registerChannelRoutes(
    recorder.app as any,
    ((_req: unknown, _res: unknown, next: unknown) => {
      (next as () => void)?.();
    }) as never,
  );
  routes = recorder.routes;

  // Drain whatever a previous spec left behind: the GET evicts every entry
  // older than the TTL, and the map is module-level with no reset export.
  clock += PERMISSION_TTL_MS + 1;
  vi.useFakeTimers();
  vi.setSystemTime(clock);
  expect(call("GET /api/channel-permission", undefined)._body).toEqual({ pending: [] });
});

afterEach(() => {
  clock = Math.max(clock, Date.now());
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("channel permission relay (#1794)", () => {
  it("stores and serves the documented shape, and never the prompt payload", () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const description = "SENTINEL_DESCRIPTION_STRING";

    const posted = call("POST /api/channel-permission", {
      requestId: REQUEST_ID,
      toolName: "Bash",
      description,
      inputPreview: "rm -rf / --no-preserve-root",
    });
    expect(posted._body).toEqual({ ok: true });

    const listed = call("GET /api/channel-permission", undefined)._body as {
      pending: Array<Record<string, unknown>>;
    };
    expect(listed.pending).toHaveLength(1);
    const entry = listed.pending[0]!;
    expect(Object.keys(entry).sort()).toEqual([
      "createdAt",
      "description",
      "requestId",
      "toolName",
    ]);
    expect(entry.requestId).toBe(REQUEST_ID);
    expect(entry.toolName).toBe("Bash");
    // Still served whole to a loopback caller (#1884 refuses, never scrubs).
    expect(entry.description).toBe(description);
    expect(entry.inputPreview).toBeUndefined();

    // The other half of "no log line carries prompt content": the stderr line
    // used to interpolate `description` verbatim.
    const logged = errorSpy.mock.calls.map((c: unknown[]) => String(c[0])).join("\n");
    expect(logged).toContain("Bash");
    expect(logged).toContain(REQUEST_ID);
    expect(logged).not.toContain(description);
  });

  it("answers a verdict to its own caller and deletes the pending entry", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    call("POST /api/channel-permission", {
      requestId: REQUEST_ID,
      toolName: "Write",
      description: "Write a file",
    });

    const verdict = call("POST /api/channel-permission-verdict", {
      requestId: REQUEST_ID,
      approved: true,
    });
    // Deletion is the verdict's ONLY effect — the sentence the doc rewrite
    // turns on. Nothing carries this back to the shim or to Claude Code.
    expect(verdict._body).toEqual({ ok: true, requestId: REQUEST_ID, behavior: "allow" });
    expect(call("GET /api/channel-permission", undefined)._body).toEqual({ pending: [] });
  });

  it("evicts stale entries on the POST, not only on the GET nothing polls", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const base = Date.now();
    call("POST /api/channel-permission", {
      requestId: "req_relay_spec_stale",
      toolName: "Bash",
      description: "Run npm test",
    });

    // A second request arrives after the first has aged out. Nothing polls the
    // GET, so if the POST does not sweep, the stale entry (and its
    // `description`) stays resident for the life of the process — the exposure
    // bound docs/mcp-tools.md states and the #1884 register entry leans on.
    vi.setSystemTime(base + PERMISSION_TTL_MS + 1);
    call("POST /api/channel-permission", {
      requestId: REQUEST_ID,
      toolName: "Write",
      description: "Write a file",
    });

    // Read back at a moment when the GET's OWN sweep would spare the stale
    // entry — that is the only way to attribute the eviction to the POST.
    vi.setSystemTime(base + 1);
    const listed = call("GET /api/channel-permission", undefined)._body as {
      pending: Array<{ requestId: string }>;
    };
    expect(listed.pending.map((p) => p.requestId)).toEqual([REQUEST_ID]);

    // Leave the clock ahead of both entries so the next spec's drain works.
    vi.setSystemTime(base + PERMISSION_TTL_MS + 1);
  });

  it("does not mention inputPreview anywhere in channel-routes.ts", () => {
    // The spec above reads through the GET, so it cannot tell "removed from the
    // record" from "hidden behind a projection". This sweep is the smallest
    // assertion that turns red if the destructure, the `.set()` or the
    // `Map<string, {...}>` type declaration survives.
    const src = readFileSync(join(__dirname, "../../src/server/mcp/channel-routes.ts"), "utf-8");
    expect(src).not.toContain("inputPreview");
  });
});

describe("GET is loopback-only (#1884)", () => {
  const SENTINEL_TOOL = "SENTINEL_TOOL";
  const SENTINEL_DESCRIPTION = "SENTINEL_LAN_DESCRIPTION";
  const FORBIDDEN = { error: "FORBIDDEN", message: "Loopback only." };

  function postSentinel(requestId: string) {
    vi.spyOn(console, "error").mockImplementation(() => {});
    expect(
      call("POST /api/channel-permission", {
        requestId,
        toolName: SENTINEL_TOOL,
        description: SENTINEL_DESCRIPTION,
      })._body,
    ).toEqual({ ok: true });
  }

  // `127.0.0.2` pins `isLoopback`'s classification of the rest of 127/8 (it is
  // not loopback there), not a protection: a same-machine caller can always
  // connect from 127.0.0.1 instead.
  it.each<[string, Peer]>([
    ["LAN IPv4", { remoteAddress: "192.168.1.50" }],
    ["private 10/8", { remoteAddress: "10.0.0.7" }],
    ["IPv4-mapped LAN", { remoteAddress: "::ffff:192.168.1.50" }],
    ["127.0.0.2 (classification only)", { remoteAddress: "127.0.0.2" }],
    ["socket with no address", { remoteAddress: undefined }],
    ["no socket at all", null],
  ])("refuses %s with 403 and leaks nothing", (_label, peer) => {
    const requestId = "req_lan_refusal_spec";
    postSentinel(requestId);

    const refused = call("GET /api/channel-permission", undefined, peer);
    expect(refused._status).toBe(403);
    expect(refused._body).toEqual(FORBIDDEN);
    const serialized = JSON.stringify(refused._body);
    expect(serialized).not.toContain(SENTINEL_TOOL);
    expect(serialized).not.toContain(SENTINEL_DESCRIPTION);
    expect(serialized).not.toContain(requestId);

    // Positive control on the same map: the entry is still there, unaltered,
    // so the absence above is the gate's doing, not an empty map's.
    const admitted = call("GET /api/channel-permission", undefined, LOOPBACK_PEER);
    expect(admitted._status).toBe(200);
    expect((admitted._body as { pending: unknown[] }).pending).toEqual([
      expect.objectContaining({
        requestId,
        toolName: SENTINEL_TOOL,
        description: SENTINEL_DESCRIPTION,
      }),
    ]);
  });

  it.each(["127.0.0.1", "::1", "::ffff:127.0.0.1"])("admits loopback peer %s", (address) => {
    const requestId = "req_loopback_admit_spec";
    postSentinel(requestId);

    const res = call("GET /api/channel-permission", undefined, { remoteAddress: address });
    expect(res._status).toBe(200);
    const { pending } = res._body as { pending: Array<Record<string, unknown>> };
    expect(pending).toHaveLength(1);
    const entry = pending[0]!;
    expect(Object.keys(entry).sort()).toEqual([
      "createdAt",
      "description",
      "requestId",
      "toolName",
    ]);
    expect(entry).toMatchObject({
      requestId,
      toolName: SENTINEL_TOOL,
      description: SENTINEL_DESCRIPTION,
    });
  });

  it("a refused GET evicts nothing (the refusal runs before the sweep)", () => {
    const base = Date.now();
    postSentinel(REQUEST_ID);

    // At this moment a sweep WOULD evict the entry. A refused caller must not
    // trigger it.
    vi.setSystemTime(base + PERMISSION_TTL_MS + 1);
    expect(
      call("GET /api/channel-permission", undefined, { remoteAddress: "192.168.1.50" })._status,
    ).toBe(403);

    // Read back at a moment when the loopback GET's own sweep spares it.
    vi.setSystemTime(base + 1);
    const listed = call("GET /api/channel-permission", undefined)._body as {
      pending: Array<{ requestId: string }>;
    };
    expect(listed.pending.map((p) => p.requestId)).toEqual([REQUEST_ID]);

    // Leave the clock ahead of the entry so the next spec's drain works.
    vi.setSystemTime(base + PERMISSION_TTL_MS + 1);
  });

  it.each<[string, unknown]>([
    ["an object", { nested: "x" }],
    ["an array", ["x"]],
    ["a number", 42],
  ])("stores a non-string description (%s) as an empty string", (_label, description) => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    call("POST /api/channel-permission", {
      requestId: REQUEST_ID,
      toolName: "Bash",
      description,
    });
    const { pending } = call("GET /api/channel-permission", undefined)._body as {
      pending: Array<Record<string, unknown>>;
    };
    expect(pending).toHaveLength(1);
    expect(pending[0]!.description).toBe("");
  });
});
