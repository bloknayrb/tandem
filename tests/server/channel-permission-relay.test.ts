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
 * `pendingPermissions` is module-level with no reset export, so every spec here
 * shares one map. Each uses the same `requestId` and opens by advancing past
 * `PERMISSION_TTL_MS` and issuing one draining `GET`, so none depends on
 * another's ordering.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerChannelRoutes } from "../../src/server/mcp/channel-routes.js";

const REQUEST_ID = "req_relay_spec";
const PERMISSION_TTL_MS = 30_000;

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

/** Invoke the last handler registered for `key` (the route's own body). */
function call(key: string, body: unknown): ReturnType<typeof makeRes> {
  const handlers = routes.get(key);
  if (!handlers || handlers.length === 0) throw new Error(`no route registered for ${key}`);
  const res = makeRes();
  handlers[handlers.length - 1]!({ body }, res);
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
  vi.useFakeTimers();
  vi.advanceTimersByTime(PERMISSION_TTL_MS + 1);
  call("GET /api/channel-permission", undefined);
});

afterEach(() => {
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

  it("does not mention inputPreview anywhere in channel-routes.ts", () => {
    // The spec above reads through the GET, so it cannot tell "removed from the
    // record" from "hidden behind a projection". This sweep is the smallest
    // assertion that turns red if the destructure, the `.set()` or the
    // `Map<string, {...}>` type declaration survives.
    const src = readFileSync(join(__dirname, "../../src/server/mcp/channel-routes.ts"), "utf-8");
    expect(src).not.toContain("inputPreview");
  });
});
