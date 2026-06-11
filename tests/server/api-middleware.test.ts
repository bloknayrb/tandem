import { describe, expect, it } from "vitest";
import {
  errorCodeToHttpStatus,
  isHostAllowed,
  isLocalhostOrigin,
} from "../../src/server/mcp/api-routes.js";
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
