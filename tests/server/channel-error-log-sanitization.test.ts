/**
 * Channel-route log injection (#1822 item 1).
 *
 * The `/api/channel-*` family is carved out of `enforceLoopbackMutation` in
 * `NON_LOOPBACK_ALLOWED`, so under a Cowork (non-loopback) bind a
 * bearer-authenticated LAN peer reaches these handlers. Every field they
 * interpolate into `console.error` therefore lands verbatim in the operator's
 * terminal: an ESC/OSC-0 sequence retitles the window, a bare LF forges a whole
 * log line, and an unbounded string floods the scrollback.
 *
 * These specs pin `sanitizeForLog` at all five interpolation sites — both
 * fields of the UNKNOWN_CODE arm, `message` on the valid-code arm,
 * `toolName`/`requestId` on the permission POST, and `requestId` on the verdict
 * POST — rather than at the one site the finding happened to quote.
 *
 * Handlers are driven through `makeRecorderApp()` (the shape
 * `channel-permission-relay.test.ts` uses) so the REAL handler bodies run.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LOG_FIELD_MAX, registerChannelRoutes } from "../../src/server/mcp/channel-routes.js";

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
    // `delete` is required: registerChannelRoutes calls app.delete(API_CHAT, …).
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
let errorSpy: ReturnType<typeof vi.spyOn>;

/** Invoke the last handler registered for `key` (the route's own body). */
function call(key: string, body: unknown): ReturnType<typeof makeRes> {
  const handlers = routes.get(key);
  if (!handlers || handlers.length === 0) throw new Error(`no route registered for ${key}`);
  const res = makeRes();
  handlers[handlers.length - 1]!({ body }, res);
  return res;
}

/** Everything written to console.error during the current spec, joined. */
function logged(): string {
  return (errorSpy.mock.calls as unknown[][])
    .map((args) => args.map((a) => String(a)).join(" "))
    .join("\n");
}

beforeEach(() => {
  const recorder = makeRecorderApp();
  registerChannelRoutes(
    // biome-ignore lint/suspicious/noExplicitAny: minimal Express app double
    recorder.app as any,
    ((_req: unknown, _res: unknown, next: unknown) => {
      (next as () => void)?.();
    }) as never,
  );
  routes = recorder.routes;
  errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  errorSpy.mockRestore();
});

// An OSC-0 window-title sequence, a BEL terminator, and a CRLF + forged line.
const ESCAPE_PAYLOAD = "a\u001b]0;pwned\u0007b\r\nFAKE [Channel] Error: all clear";

/** Assert a logged line carries none of the escape-sequence machinery. */
function expectNoControlChars(line: string): void {
  expect(line).not.toContain("\u001b");
  expect(line).not.toContain("\u0007");
  expect(line).not.toContain("\r");
  // The joiner above inserts "\n" BETWEEN calls, so assert per-call instead.
  for (const entry of errorSpy.mock.calls) {
    for (const arg of entry) expect(String(arg)).not.toContain("\n");
  }
  expect(line).not.toContain("\u202e");
}

describe("#1822 item 1 — channel route logs are sanitized before they reach the terminal", () => {
  it("(a) strips escapes from `message` on the VALID-code arm", () => {
    const res = call("POST /api/channel-error", {
      error: "CHANNEL_CONNECT_FAILED",
      message: ESCAPE_PAYLOAD,
    });
    expect(res._status).toBe(200);
    const line = logged();
    // The line still exists — the diagnostic trail is not deleted.
    expect(line).toContain("[Channel] Error: CHANNEL_CONNECT_FAILED");
    expectNoControlChars(line);
    // Sanitizing only the UNKNOWN_CODE arm would leave this intact.
    expect(line).not.toContain("\u001b]0;pwned");
  });

  it("(b) strips escapes from BOTH fields on the UNKNOWN_CODE arm, and still logs", () => {
    const res = call("POST /api/channel-error", {
      error: ESCAPE_PAYLOAD,
      message: ESCAPE_PAYLOAD,
    });
    // Out-of-schema code is still a 400 to the caller.
    expect(res._status).toBe(400);
    const line = logged();
    // Deleting the log to "fix" the injection is the other wrong repair.
    expect(line).toContain("UNKNOWN_CODE");
    expectNoControlChars(line);
    // Sanitizing `message` but leaving `String(error)` raw would keep this.
    expect(line).not.toContain("\u001b]0;pwned");
  });

  describe("(c) every clamped field is clamped", () => {
    const HUGE = "X".repeat(5000);
    // Independent of the implementer's prefix wording, which a total-line-length
    // bound is not: 300 > LOG_FIELD_MAX, so a clamped field cannot contain it.
    const OVER = "X".repeat(300);

    it("`error` and `message` on the UNKNOWN_CODE arm", () => {
      call("POST /api/channel-error", { error: HUGE, message: HUGE });
      expect(logged()).not.toContain(OVER);
    });

    it("`message` on the valid-code arm", () => {
      call("POST /api/channel-error", { error: "CHANNEL_CONNECT_FAILED", message: HUGE });
      expect(logged()).not.toContain(OVER);
    });

    it("`toolName` and `requestId` on /api/channel-permission", () => {
      call("POST /api/channel-permission", {
        requestId: HUGE,
        toolName: HUGE,
        description: "",
      });
      expect(logged()).not.toContain(OVER);
    });

    it("`requestId` on /api/channel-permission-verdict", () => {
      call("POST /api/channel-permission-verdict", { requestId: HUGE, approved: true });
      expect(logged()).not.toContain(OVER);
    });

    it("LOG_FIELD_MAX is under the 300-character probe these specs use", () => {
      // If someone raises the clamp above 300 the four specs above go quietly
      // green for the wrong reason; this is what turns that into a failure.
      expect(LOG_FIELD_MAX).toBeLessThan(300);
    });
  });

  it("(d) a benign non-ASCII message survives unchanged", () => {
    // Kills a lazy `replace(/[^\x20-\x7e]/g, "")`: accented Latin, an em dash
    // and CJK are all legitimate diagnostic text.
    const BENIGN = "connexion échouée — 日本語 ok";
    call("POST /api/channel-error", { error: "CHANNEL_CONNECT_FAILED", message: BENIGN });
    expect(logged()).toContain(BENIGN);
  });

  it("(e) a body field that cannot be stringified logs a placeholder, not a 500", () => {
    // `String(JSON.parse('{"toString":1,"valueOf":2}'))` throws a TypeError.
    // The throw would happen in an OUTER-app route handler, past every sub-app
    // error handler, and land on Express's HTML error page with the install
    // path in it — which is the very leak item 3 closes. The helper has to be
    // total; item 3's handler cannot cover for it.
    const unstringifiable = JSON.parse('{"toString":1,"valueOf":2}');
    const res = call("POST /api/channel-error", {
      error: "CHANNEL_CONNECT_FAILED",
      message: unstringifiable,
    });
    expect(res._status).toBe(200);
    expect(logged()).toContain("[unstringifiable]");
  });
});
