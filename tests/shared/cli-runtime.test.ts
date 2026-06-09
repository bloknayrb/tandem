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
    delete process.env.TANDEM_AUTH_TOKEN;
    delete process.env.CLAUDE_PLUGIN_OPTION_AUTH_TOKEN;
    // Clear the Claude-session vars too so the clean-wire assertions are
    // deterministic even when the suite itself runs inside Claude Code (where
    // CLAUDECODE=1 + a real CLAUDE_CODE_SESSION_ID would otherwise survive in
    // originalEnv and attach X-Claude-Session-Id to every request here).
    delete process.env.CLAUDECODE;
    delete process.env.CLAUDE_CODE_SESSION_ID;
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
    const headers = new Headers(init?.headers);
    expect(headers.has("Authorization")).toBe(false);
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

  it("prefers CLAUDE_PLUGIN_OPTION_AUTH_TOKEN over TANDEM_AUTH_TOKEN", async () => {
    process.env.TANDEM_AUTH_TOKEN = "T".repeat(32);
    process.env.CLAUDE_PLUGIN_OPTION_AUTH_TOKEN = "P".repeat(32);
    const authFetch = await importAuthFetch();
    await authFetch("http://localhost/test");
    const [, init] = fetchSpy.mock.calls[0];
    const headers = new Headers(init?.headers);
    expect(headers.get("Authorization")).toBe(`Bearer ${"P".repeat(32)}`);
  });

  it("falls back to TANDEM_AUTH_TOKEN when CLAUDE_PLUGIN_OPTION_AUTH_TOKEN is blank", async () => {
    process.env.TANDEM_AUTH_TOKEN = "T".repeat(32);
    process.env.CLAUDE_PLUGIN_OPTION_AUTH_TOKEN = "  ";
    const authFetch = await importAuthFetch();
    await authFetch("http://localhost/test");
    const [, init] = fetchSpy.mock.calls[0];
    const headers = new Headers(init?.headers);
    expect(headers.get("Authorization")).toBe(`Bearer ${"T".repeat(32)}`);
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

  it("preserves caller-provided signal when injecting Authorization", async () => {
    process.env.CLAUDE_PLUGIN_OPTION_AUTH_TOKEN = "D".repeat(32);
    const ctrl = new AbortController();
    const authFetch = await importAuthFetch();
    await authFetch("http://localhost/test", { signal: ctrl.signal });
    const [, init] = fetchSpy.mock.calls[0];
    expect(init?.signal).toBe(ctrl.signal);
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

  it("warns with the selected plugin auth source when the plugin token is malformed", async () => {
    process.env.TANDEM_AUTH_TOKEN = "T".repeat(32);
    process.env.CLAUDE_PLUGIN_OPTION_AUTH_TOKEN = "bad-plugin-token!";
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const authFetch = await importAuthFetch();
    await authFetch("http://localhost/test");
    expect(errorSpy).toHaveBeenCalledOnce();
    expect(errorSpy.mock.calls[0][0]).toContain("CLAUDE_PLUGIN_OPTION_AUTH_TOKEN");
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

  it("attaches X-Claude-Session-Id when spawned by Claude Code, no token", async () => {
    delete process.env.TANDEM_AUTH_TOKEN;
    process.env.CLAUDECODE = "1";
    process.env.CLAUDE_CODE_SESSION_ID = "11111111-2222-3333-4444-555555555555";
    const authFetch = await importAuthFetch();
    await authFetch("http://localhost/test");
    const [, init] = fetchSpy.mock.calls[0];
    const headers = new Headers(init?.headers);
    expect(headers.get("X-Claude-Session-Id")).toBe("11111111-2222-3333-4444-555555555555");
    expect(headers.has("Authorization")).toBe(false);
  });

  it("attaches both Authorization and X-Claude-Session-Id when token + session present", async () => {
    process.env.TANDEM_AUTH_TOKEN = "A".repeat(32);
    process.env.CLAUDECODE = "1";
    process.env.CLAUDE_CODE_SESSION_ID = "abc-session";
    const authFetch = await importAuthFetch();
    await authFetch("http://localhost/test");
    const [, init] = fetchSpy.mock.calls[0];
    const headers = new Headers(init?.headers);
    expect(headers.get("Authorization")).toBe(`Bearer ${"A".repeat(32)}`);
    expect(headers.get("X-Claude-Session-Id")).toBe("abc-session");
  });

  it("does NOT attach the session header outside a Claude Code launch (CLAUDECODE unset)", async () => {
    delete process.env.CLAUDECODE;
    process.env.CLAUDE_CODE_SESSION_ID = "leaked-from-user-shell";
    const authFetch = await importAuthFetch();
    await authFetch("http://localhost/test");
    const [, init] = fetchSpy.mock.calls[0];
    const headers = new Headers(init?.headers);
    expect(headers.has("X-Claude-Session-Id")).toBe(false);
  });
});

describe("resolveClaudeSessionId", () => {
  const originalEnv = { ...process.env };

  async function importResolver() {
    vi.resetModules();
    return (await import("../../src/shared/cli-runtime.js")).resolveClaudeSessionId;
  }

  beforeEach(() => {
    delete process.env.CLAUDECODE;
    delete process.env.CLAUDE_CODE_SESSION_ID;
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    vi.resetModules();
  });

  it("returns the trimmed id when CLAUDECODE=1 and the id is set", async () => {
    process.env.CLAUDECODE = "1";
    process.env.CLAUDE_CODE_SESSION_ID = "  sess-123  ";
    const resolve = await importResolver();
    expect(resolve()).toBe("sess-123");
  });

  it("returns undefined when CLAUDECODE is not exactly '1'", async () => {
    process.env.CLAUDECODE = "true";
    process.env.CLAUDE_CODE_SESSION_ID = "sess-123";
    const resolve = await importResolver();
    expect(resolve()).toBeUndefined();
  });

  it("returns undefined when the id is unset", async () => {
    process.env.CLAUDECODE = "1";
    const resolve = await importResolver();
    expect(resolve()).toBeUndefined();
  });

  it("returns undefined when the id is blank after trim", async () => {
    process.env.CLAUDECODE = "1";
    process.env.CLAUDE_CODE_SESSION_ID = "   ";
    const resolve = await importResolver();
    expect(resolve()).toBeUndefined();
  });

  it("rejects an id containing control chars (header-injection guard)", async () => {
    process.env.CLAUDECODE = "1";
    process.env.CLAUDE_CODE_SESSION_ID = "sess\r\nX-Evil: 1";
    const resolve = await importResolver();
    expect(resolve()).toBeUndefined();
  });

  it("rejects an oversized id", async () => {
    process.env.CLAUDECODE = "1";
    process.env.CLAUDE_CODE_SESSION_ID = "x".repeat(257);
    const resolve = await importResolver();
    expect(resolve()).toBeUndefined();
  });
});
