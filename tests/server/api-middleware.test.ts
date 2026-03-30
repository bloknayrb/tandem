import { describe, it, expect } from "vitest";
import {
  isHostAllowed,
  isLocalhostOrigin,
  errorCodeToHttpStatus,
} from "../../src/server/mcp/api-routes.js";
import { jsonrpcId } from "../../src/server/mcp/server.js";

describe("isHostAllowed (DNS rebinding protection)", () => {
  it("allows localhost", () => {
    expect(isHostAllowed("localhost:3479")).toBe(true);
  });

  it("allows 127.0.0.1", () => {
    expect(isHostAllowed("127.0.0.1:3479")).toBe(true);
  });

  it("allows localhost without port", () => {
    expect(isHostAllowed("localhost")).toBe(true);
  });

  it("rejects external hostnames", () => {
    expect(isHostAllowed("evil.com")).toBe(false);
    expect(isHostAllowed("attacker.com:3479")).toBe(false);
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
  it("allows http://localhost:5173", () => {
    expect(isLocalhostOrigin("http://localhost:5173")).toBe(true);
  });

  it("allows http://localhost:5174", () => {
    expect(isLocalhostOrigin("http://localhost:5174")).toBe(true);
  });

  it("allows http://127.0.0.1:5173", () => {
    expect(isLocalhostOrigin("http://127.0.0.1:5173")).toBe(true);
  });

  it("allows http://localhost (no port)", () => {
    expect(isLocalhostOrigin("http://localhost")).toBe(true);
  });

  it("allows https://localhost:3000", () => {
    expect(isLocalhostOrigin("https://localhost:3000")).toBe(true);
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
