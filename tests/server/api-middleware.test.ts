import type { Response } from "express";
import { describe, expect, it, vi } from "vitest";
import { DocxTooLargeError } from "../../src/server/file-io/docx-size-gate.js";
import {
  createApiMiddleware,
  errorCodeToHttpStatus,
  isHostAllowed,
  isLocalhostOrigin,
} from "../../src/server/mcp/api-routes.js";
import { sendApiError } from "../../src/server/mcp/routes/_shared.js";
import { jsonrpcId } from "../../src/server/mcp/server.js";

describe("isHostAllowed (DNS rebinding protection)", () => {
  // #477 PR 2 narrowed the allowlist: `localhost` hostname is rejected; only
  // 127.0.0.1 (sidecar / dev fetch) and tauri.localhost (Tauri WebView).
  it("rejects the localhost hostname (#477 PR 2)", () => {
    expect(isHostAllowed("localhost:3479")).toBe(false);
    expect(isHostAllowed("localhost")).toBe(false);
  });

  it("allows 127.0.0.1", () => {
    expect(isHostAllowed("127.0.0.1:3479")).toBe(true);
  });

  it("rejects external hostnames", () => {
    expect(isHostAllowed("evil.com")).toBe(false);
    expect(isHostAllowed("attacker.com:3479")).toBe(false);
  });

  it("accepts tauri.localhost", () => {
    expect(isHostAllowed("tauri.localhost")).toBe(true);
    expect(isHostAllowed("tauri.localhost:3479")).toBe(true);
  });

  it("rejects DNS rebinding attempts", () => {
    expect(isHostAllowed("evil.localhost")).toBe(false);
    expect(isHostAllowed("127.0.0.2")).toBe(false);
  });

  it("rejects empty/missing host", () => {
    expect(isHostAllowed(undefined)).toBe(false);
    expect(isHostAllowed("")).toBe(false);
  });

  it("rejects IPv6 loopback", () => {
    expect(isHostAllowed("[::1]")).toBe(false);
  });

  it("rejects case variations (LOCALHOST)", () => {
    // The production code uses strict equality, so uppercase fails
    expect(isHostAllowed("LOCALHOST")).toBe(false);
  });

  it("rejects trailing dot (localhost.)", () => {
    expect(isHostAllowed("localhost.")).toBe(false);
  });
});

describe("isLocalhostOrigin (CORS validation)", () => {
  // #477 PR 2 narrowed CORS: only 127.0.0.1 and tauri.localhost are accepted.
  it("rejects the localhost hostname (#477 PR 2)", () => {
    expect(isLocalhostOrigin("http://localhost:5173")).toBe(false);
    expect(isLocalhostOrigin("http://localhost:5174")).toBe(false);
    expect(isLocalhostOrigin("http://localhost")).toBe(false);
    expect(isLocalhostOrigin("https://localhost:3000")).toBe(false);
  });

  it("allows http://127.0.0.1:5173", () => {
    expect(isLocalhostOrigin("http://127.0.0.1:5173")).toBe(true);
  });

  it("accepts http://tauri.localhost origins", () => {
    expect(isLocalhostOrigin("http://tauri.localhost")).toBe(true);
    expect(isLocalhostOrigin("http://tauri.localhost:3479")).toBe(true);
  });

  it("accepts the Linux Tauri custom-scheme origin tauri://localhost", () => {
    // On Linux the WebView serves from the `tauri://` scheme (Windows uses
    // http://tauri.localhost). Unforgeable by remote content → trusted.
    expect(isLocalhostOrigin("tauri://localhost")).toBe(true);
  });

  it("rejects tauri:// variants that are not the exact Linux origin", () => {
    // Exact-string match only — no `tauri://*` wildcard. A port, suffix, or
    // different host must all fail so a forged custom-scheme origin can't slip in.
    expect(isLocalhostOrigin("tauri://localhost:1234")).toBe(false);
    expect(isLocalhostOrigin("tauri://localhost.evil")).toBe(false);
    expect(isLocalhostOrigin("tauri://evil.example")).toBe(false);
  });

  it("rejects external origins", () => {
    expect(isLocalhostOrigin("http://evil.com:5173")).toBe(false);
    expect(isLocalhostOrigin("http://attacker.localhost:5173")).toBe(false);
  });

  it("rejects non-URL strings", () => {
    expect(isLocalhostOrigin("localhost:5173")).toBe(false);
    expect(isLocalhostOrigin("")).toBe(false);
  });

  it("rejects undefined origin", () => {
    expect(isLocalhostOrigin(undefined)).toBe(false);
  });
});

describe("errorCodeToHttpStatus", () => {
  it("maps ENOENT to 404", () => {
    expect(errorCodeToHttpStatus("ENOENT")).toBe(404);
  });

  it("maps FILE_NOT_FOUND to 404", () => {
    expect(errorCodeToHttpStatus("FILE_NOT_FOUND")).toBe(404);
  });

  it("maps INVALID_PATH to 400", () => {
    expect(errorCodeToHttpStatus("INVALID_PATH")).toBe(400);
  });

  it("maps UNSUPPORTED_FORMAT to 400", () => {
    expect(errorCodeToHttpStatus("UNSUPPORTED_FORMAT")).toBe(400);
  });

  it("maps FILE_TOO_LARGE to 413", () => {
    expect(errorCodeToHttpStatus("FILE_TOO_LARGE")).toBe(413);
  });

  it("maps EBUSY to 423 (locked)", () => {
    expect(errorCodeToHttpStatus("EBUSY")).toBe(423);
  });

  it("maps EPERM to 423 (locked)", () => {
    expect(errorCodeToHttpStatus("EPERM")).toBe(423);
  });

  it("maps EACCES to 403", () => {
    expect(errorCodeToHttpStatus("EACCES")).toBe(403);
  });

  it("maps NOT_FOUND to 404 (annotation tool codes)", () => {
    expect(errorCodeToHttpStatus("NOT_FOUND")).toBe(404);
  });

  it("maps INVALID_ARGUMENT to 400 (annotation tool codes)", () => {
    expect(errorCodeToHttpStatus("INVALID_ARGUMENT")).toBe(400);
  });

  it("maps ANNOTATION_RESOLVED to 409 (annotation tool codes)", () => {
    expect(errorCodeToHttpStatus("ANNOTATION_RESOLVED")).toBe(409);
  });

  it("maps unknown errors to 500", () => {
    expect(errorCodeToHttpStatus(undefined)).toBe(500);
    expect(errorCodeToHttpStatus("UNKNOWN")).toBe(500);
  });

  it("maps errors with no code property to 500", () => {
    expect(errorCodeToHttpStatus("")).toBe(500);
  });
});

describe("jsonrpcId", () => {
  it("extracts id from valid JSON-RPC request", () => {
    expect(jsonrpcId({ jsonrpc: "2.0", method: "test", id: 42 })).toBe(42);
  });

  it("extracts string id", () => {
    expect(jsonrpcId({ id: "abc-123" })).toBe("abc-123");
  });

  it("returns null for array (batch request)", () => {
    expect(jsonrpcId([{ id: 1 }, { id: 2 }])).toBeNull();
  });

  it("returns null for null body", () => {
    expect(jsonrpcId(null)).toBeNull();
  });

  it("returns null for non-object body", () => {
    expect(jsonrpcId("string")).toBeNull();
    expect(jsonrpcId(42)).toBeNull();
  });

  it("returns null when no id field", () => {
    expect(jsonrpcId({ method: "notify" })).toBeNull();
  });
});

/**
 * Emitted-header tests for the middleware itself (#1291).
 *
 * The `isLocalhostOrigin` tests above are thorough and every one of them passed
 * on the vulnerable code — the predicate was always correct. What was never
 * tested is what the middleware DID with the answer: it sent
 * `Access-Control-Allow-Origin: null` for a rejected origin, which is not a
 * deny value but the origin serialization of an opaque context, so a sandboxed
 * iframe on any page could read every loopback-gated response.
 *
 * These drive real requests through `createApiMiddleware()` and assert on the
 * response headers. The `Origin: null` case is the load-bearing one: a test
 * written against `https://evil.com` alone passes on the vulnerable code too.
 */
describe("createApiMiddleware — CORS headers (#1291)", () => {
  const TAURI_LINUX = "tauri://localhost";

  /** Drive one request through the middleware, return what it emitted. */
  function run(
    headers: Record<string, string>,
    method = "GET",
  ): { headers: Record<string, string>; nextCalled: boolean; status?: number } {
    const emitted: Record<string, string> = {};
    let nextCalled = false;
    let status: number | undefined;

    const req = { headers: { host: "127.0.0.1:3479", ...headers }, method } as never;
    const res = {
      header(name: string, value: string) {
        emitted[name] = value;
        return this;
      },
      status(code: number) {
        status = code;
        return this;
      },
      json() {
        return this;
      },
      sendStatus(code: number) {
        status = code;
        return this;
      },
    } as never;

    createApiMiddleware()(req, res, () => {
      nextCalled = true;
    });
    return { headers: emitted, nextCalled, status };
  }

  it("sends NO Access-Control-Allow-Origin for the opaque `null` origin", () => {
    // The regression test for #1291. `null` is what a sandboxed iframe sends.
    const { headers } = run({ origin: "null" });
    expect(headers["Access-Control-Allow-Origin"]).toBeUndefined();
  });

  it("sends NO Access-Control-Allow-Origin for an external origin", () => {
    const { headers } = run({ origin: "https://evil.com" });
    expect(headers["Access-Control-Allow-Origin"]).toBeUndefined();
  });

  it("echoes an allowlisted 127.0.0.1 origin exactly", () => {
    const { headers } = run({ origin: "http://127.0.0.1:5173" });
    expect(headers["Access-Control-Allow-Origin"]).toBe("http://127.0.0.1:5173");
  });

  it("echoes the Tauri WebView origin", () => {
    const { headers } = run({ origin: "http://tauri.localhost" });
    expect(headers["Access-Control-Allow-Origin"]).toBe("http://tauri.localhost");
  });

  it("echoes the Linux Tauri custom-scheme origin", () => {
    const { headers } = run({ origin: TAURI_LINUX });
    expect(headers["Access-Control-Allow-Origin"]).toBe(TAURI_LINUX);
  });

  it("passes a request with NO Origin header through without a CORS header", () => {
    // The compatibility guard: the CLI, `tandem doctor` and every non-browser
    // caller send no Origin and never enforced CORS. They must keep working.
    const { headers, nextCalled } = run({});
    expect(headers["Access-Control-Allow-Origin"]).toBeUndefined();
    expect(nextCalled).toBe(true);
  });

  it("sets Vary: Origin on both the allowed and the denied response", () => {
    expect(run({ origin: "http://127.0.0.1:5173" }).headers.Vary).toBe("Origin");
    expect(run({ origin: "null" }).headers.Vary).toBe("Origin");
  });

  it("answers an opaque-origin preflight 204 with no CORS grant", () => {
    // 204 rather than 403 is deliberate: without ACAO the browser blocks the
    // real request anyway, and the Allow-Methods/Allow-Headers values are inert
    // because the origin check is evaluated first.
    const { headers, status } = run({ origin: "null" }, "OPTIONS");
    expect(status).toBe(204);
    expect(headers["Access-Control-Allow-Origin"]).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// sendApiError — the DOCX_TOO_LARGE mapping (#1310)
// ---------------------------------------------------------------------------

describe("sendApiError with a decompressed-size refusal", () => {
  // `remoteAddress` is load-bearing since #1294: `sendApiError` reads the peer off `res.req` and
  // fails CLOSED, so a double that omits it is treated as a LAN caller and gets the generic copy —
  // which is not what the local UI receives, and would silently weaken every message assertion
  // below into a test of the scrub instead of the refusal. Default models the local UI.
  function capture(err: unknown, remoteAddress = "127.0.0.1") {
    let status = 0;
    let body: unknown;
    const res = {
      req: { socket: { remoteAddress } },
      status(code: number) {
        status = code;
        return this;
      },
      json(payload: unknown) {
        body = payload;
        return this;
      },
    } as unknown as Response;
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      sendApiError(res, err);
      // Snapshot the calls BEFORE restoring: `mockRestore` clears the recorded calls, so asserting
      // on the spy afterwards asserts on an emptied array and passes no matter what was logged.
      return {
        status,
        body: body as { error: string; message: string },
        errors: errorSpy.mock.calls.map((c) => String(c[0])),
        warns: warnSpy.mock.calls.map((c) => String(c[0])),
      };
    } finally {
      errorSpy.mockRestore();
      warnSpy.mockRestore();
    }
  }

  it("answers 413, not 500, for an over-expanding .docx", () => {
    // The gate refuses hostile INPUT. Reported as 500 it is indistinguishable from a Tandem fault,
    // and no caller can tell a policy refusal from a server bug.
    const { status, body } = capture(
      new DocxTooLargeError("A part of this .docx expands past…", 3),
    );
    expect(status).toBe(413);
    expect(body.error).toBe("FILE_TOO_LARGE");
    expect(body.message).toContain("expands past");
  });

  it("gives a non-loopback caller the generic copy, still as a 413 (#1294)", () => {
    // The refusal message carries no path, so this is the scrub being uniform rather than a leak
    // being closed — and uniformity is the point: a message allowlisted case-by-case is how the
    // convention drifted before. What must survive for every caller is the actionable part: a 413
    // with the FILE_TOO_LARGE label, so a client can tell a refused file from a server fault.
    const { status, body } = capture(
      new DocxTooLargeError("A part of this .docx expands past…", 3),
      "192.168.1.50",
    );
    expect(status).toBe(413);
    expect(body.error).toBe("FILE_TOO_LARGE");
    expect(body.message).not.toContain("expands past");
  });

  it("does not log it as an unhandled server error", () => {
    // `[Tandem] Unhandled API error:` plus a stack is what Copy Diagnostics shows the user, and it
    // is what a 5xx status triggers. Refusing a bomb is not a crash.
    const { errors, warns } = capture(new DocxTooLargeError("too big", 1));
    expect(errors).toEqual([]);
    // Positive control on the same sample: the refusal IS logged, just at the level a rejected
    // request warrants. Without this, an assertion that nothing was logged as unhandled would also
    // pass if `sendApiError` had stopped logging entirely.
    expect(warns).toEqual([expect.stringContaining("API error (413)")]);
  });

  it("still maps the code through the exported status mapper", () => {
    expect(errorCodeToHttpStatus("DOCX_TOO_LARGE")).toBe(413);
  });
});
