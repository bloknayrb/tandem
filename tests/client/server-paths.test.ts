import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openServerPath } from "../../src/client/utils/server-paths.js";

function makeResponse(opts: {
  ok: boolean;
  status?: number;
  body?: unknown;
  rejectJson?: boolean;
}): Response {
  return {
    ok: opts.ok,
    status: opts.status ?? (opts.ok ? 200 : 500),
    json: opts.rejectJson
      ? () => Promise.reject(new SyntaxError("invalid JSON"))
      : () => Promise.resolve(opts.body ?? {}),
  } as unknown as Response;
}

describe("openServerPath", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns { ok: true } on 2xx and posts filePath + readOnly", async () => {
    fetchMock.mockResolvedValue(makeResponse({ ok: true }));
    const result = await openServerPath("/path/to/file.md");
    expect(result).toEqual({ ok: true });
    expect(fetchMock).toHaveBeenCalledOnce();
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body as string)).toEqual({
      filePath: "/path/to/file.md",
      readOnly: false,
      force: false,
    });
  });

  it("threads readOnly option through to the body", async () => {
    fetchMock.mockResolvedValue(makeResponse({ ok: true }));
    await openServerPath("/changelog.md", { readOnly: true });
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(init.body as string).readOnly).toBe(true);
  });

  it("threads force option through to the body (Replay tutorial)", async () => {
    fetchMock.mockResolvedValue(makeResponse({ ok: true }));
    await openServerPath("/sample/welcome.md", { force: true });
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(init.body as string).force).toBe(true);
  });

  it("returns server-provided message on non-2xx with JSON body", async () => {
    fetchMock.mockResolvedValue(
      makeResponse({ ok: false, status: 400, body: { message: "Path outside allowlist" } }),
    );
    const result = await openServerPath("/bad/path");
    expect(result).toEqual({ ok: false, error: "Path outside allowlist" });
  });

  it("uses notFoundMessage on 404 regardless of server body", async () => {
    fetchMock.mockResolvedValue(
      makeResponse({ ok: false, status: 404, body: { message: "Not found on disk" } }),
    );
    const result = await openServerPath("/missing.md", {
      notFoundMessage: "Custom missing message.",
    });
    expect(result).toEqual({ ok: false, error: "Custom missing message." });
  });

  it("falls back to failureMessage when server response has no JSON body", async () => {
    fetchMock.mockResolvedValue(makeResponse({ ok: false, status: 500, rejectJson: true }));
    const result = await openServerPath("/path.md", { failureMessage: "Custom failure." });
    expect(result).toEqual({ ok: false, error: "Custom failure." });
  });

  it("returns 'Server unavailable.' when fetch rejects (network error)", async () => {
    fetchMock.mockRejectedValue(new TypeError("Failed to fetch"));
    const result = await openServerPath("/path.md");
    expect(result).toEqual({ ok: false, error: "Server unavailable." });
  });

  it("does not leak the filePath into the returned error", async () => {
    // Defensive — callers can log results without exposing filesystem layout
    // beyond what the server itself surfaces via `message`.
    fetchMock.mockResolvedValue(
      makeResponse({ ok: false, status: 400, body: { message: "rejected" } }),
    );
    const result = await openServerPath("/secret/path/with/api-key-in-name.md");
    expect(result).toEqual({ ok: false, error: "rejected" });
  });
});
