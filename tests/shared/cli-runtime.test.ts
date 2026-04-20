import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Must use dynamic import after resetModules because of the module-level flag
async function importAuthFetch() {
  vi.resetModules();
  const mod = await import("../../src/shared/cli-runtime.js");
  return mod.authFetch;
}

describe("authFetch", () => {
  let fetchSpy: ReturnType<typeof vi.fn>;
  const originalEnv = { ...process.env };

  beforeEach(() => {
    fetchSpy = vi.fn().mockResolvedValue(new Response("ok"));
    vi.stubGlobal("fetch", fetchSpy);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    process.env = { ...originalEnv };
    vi.resetModules();
  });

  it("sends no Authorization header when TANDEM_AUTH_TOKEN is not set", async () => {
    delete process.env.TANDEM_AUTH_TOKEN;
    const authFetch = await importAuthFetch();
    await authFetch("http://localhost/test");
    expect(fetchSpy).toHaveBeenCalledOnce();
    const [, init] = fetchSpy.mock.calls[0];
    expect(
      init?.headers?.get?.("Authorization") ?? (init?.headers as any)?.Authorization,
    ).toBeUndefined();
  });

  it("sends no Authorization header when TANDEM_AUTH_TOKEN is empty string", async () => {
    process.env.TANDEM_AUTH_TOKEN = "";
    const authFetch = await importAuthFetch();
    await authFetch("http://localhost/test");
    const [, init] = fetchSpy.mock.calls[0];
    const headers = new Headers(init?.headers);
    expect(headers.has("Authorization")).toBe(false);
  });

  it("injects Bearer header when TANDEM_AUTH_TOKEN is valid (32+ alphanumeric chars)", async () => {
    process.env.TANDEM_AUTH_TOKEN = "A".repeat(32);
    const authFetch = await importAuthFetch();
    await authFetch("http://localhost/test");
    const [, init] = fetchSpy.mock.calls[0];
    const headers = new Headers(init?.headers);
    expect(headers.get("Authorization")).toBe(`Bearer ${"A".repeat(32)}`);
  });

  it("preserves existing Content-Type header when injecting Authorization", async () => {
    process.env.TANDEM_AUTH_TOKEN = "B".repeat(32);
    const authFetch = await importAuthFetch();
    await authFetch("http://localhost/test", { headers: { "Content-Type": "application/json" } });
    const [, init] = fetchSpy.mock.calls[0];
    const headers = new Headers(init?.headers);
    expect(headers.get("Content-Type")).toBe("application/json");
    expect(headers.get("Authorization")).toBe(`Bearer ${"B".repeat(32)}`);
  });

  it("logs a warning (once) and sends without auth when TANDEM_AUTH_TOKEN is set but malformed", async () => {
    process.env.TANDEM_AUTH_TOKEN = "short!"; // fails regex
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const authFetch = await importAuthFetch();
    await authFetch("http://localhost/test");
    // Warning fires
    expect(errorSpy).toHaveBeenCalledOnce();
    expect(errorSpy.mock.calls[0][0]).toMatch(/invalid/i);
    // Request sent without Authorization header
    const [, init] = fetchSpy.mock.calls[0];
    const headers = new Headers(init?.headers);
    expect(headers.has("Authorization")).toBe(false);
    errorSpy.mockRestore();
  });

  it("does NOT log a warning when TANDEM_AUTH_TOKEN is valid", async () => {
    process.env.TANDEM_AUTH_TOKEN = "C".repeat(32);
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const authFetch = await importAuthFetch();
    await authFetch("http://localhost/test");
    expect(errorSpy).not.toHaveBeenCalled();
    errorSpy.mockRestore();
  });
});
