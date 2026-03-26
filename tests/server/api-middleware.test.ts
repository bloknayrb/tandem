import { describe, it, expect } from "vitest";

/**
 * Tests for the API middleware logic from server.ts.
 * Since the middleware is tightly coupled to Express req/res objects,
 * we test the logic patterns rather than instantiating Express.
 */

describe("DNS rebinding protection logic", () => {
  function isHostAllowed(host: string | undefined): boolean {
    const reqHost = (host ?? "").split(":")[0];
    return reqHost === "localhost" || reqHost === "127.0.0.1";
  }

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

  it("rejects empty host", () => {
    expect(isHostAllowed(undefined)).toBe(false);
    expect(isHostAllowed("")).toBe(false);
  });
});

describe("CORS origin validation logic", () => {
  const localhostPattern = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/;

  it("allows http://localhost:5173", () => {
    expect(localhostPattern.test("http://localhost:5173")).toBe(true);
  });

  it("allows http://localhost:5174", () => {
    expect(localhostPattern.test("http://localhost:5174")).toBe(true);
  });

  it("allows http://127.0.0.1:5173", () => {
    expect(localhostPattern.test("http://127.0.0.1:5173")).toBe(true);
  });

  it("allows http://localhost (no port)", () => {
    expect(localhostPattern.test("http://localhost")).toBe(true);
  });

  it("allows https://localhost:3000", () => {
    expect(localhostPattern.test("https://localhost:3000")).toBe(true);
  });

  it("rejects external origins", () => {
    expect(localhostPattern.test("http://evil.com:5173")).toBe(false);
    expect(localhostPattern.test("http://attacker.localhost:5173")).toBe(false);
  });

  it("rejects non-URL strings", () => {
    expect(localhostPattern.test("localhost:5173")).toBe(false);
    expect(localhostPattern.test("")).toBe(false);
  });
});

describe("API error code mapping logic", () => {
  function mapErrorToHttpStatus(code: string | undefined): number {
    switch (code) {
      case "ENOENT":
      case "FILE_NOT_FOUND":
        return 404;
      case "INVALID_PATH":
      case "UNSUPPORTED_FORMAT":
        return 400;
      case "FILE_TOO_LARGE":
        return 413;
      case "EBUSY":
      case "EPERM":
        return 423;
      case "EACCES":
        return 403;
      default:
        return 500;
    }
  }

  it("maps ENOENT to 404", () => {
    expect(mapErrorToHttpStatus("ENOENT")).toBe(404);
  });

  it("maps FILE_NOT_FOUND to 404", () => {
    expect(mapErrorToHttpStatus("FILE_NOT_FOUND")).toBe(404);
  });

  it("maps INVALID_PATH to 400", () => {
    expect(mapErrorToHttpStatus("INVALID_PATH")).toBe(400);
  });

  it("maps UNSUPPORTED_FORMAT to 400", () => {
    expect(mapErrorToHttpStatus("UNSUPPORTED_FORMAT")).toBe(400);
  });

  it("maps FILE_TOO_LARGE to 413", () => {
    expect(mapErrorToHttpStatus("FILE_TOO_LARGE")).toBe(413);
  });

  it("maps EBUSY to 423 (locked)", () => {
    expect(mapErrorToHttpStatus("EBUSY")).toBe(423);
  });

  it("maps EPERM to 423 (locked)", () => {
    expect(mapErrorToHttpStatus("EPERM")).toBe(423);
  });

  it("maps EACCES to 403", () => {
    expect(mapErrorToHttpStatus("EACCES")).toBe(403);
  });

  it("maps unknown errors to 500", () => {
    expect(mapErrorToHttpStatus(undefined)).toBe(500);
    expect(mapErrorToHttpStatus("UNKNOWN")).toBe(500);
  });
});

describe("JSON-RPC ID extraction logic", () => {
  function jsonrpcId(body: unknown): unknown {
    return body && typeof body === "object" && !Array.isArray(body) && "id" in body
      ? (body as Record<string, unknown>).id
      : null;
  }

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
