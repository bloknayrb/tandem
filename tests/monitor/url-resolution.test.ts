import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resolveAuthToken, resolveTandemUrl } from "../../src/shared/cli-runtime.js";

// Isolate env mutations between tests
const originalEnv = process.env;

beforeEach(() => {
  process.env = { ...originalEnv };
  delete process.env.TANDEM_URL;
  delete process.env.TANDEM_AUTH_TOKEN;
  delete process.env.CLAUDE_PLUGIN_OPTION_SERVER_URL;
  delete process.env.CLAUDE_PLUGIN_OPTION_AUTH_TOKEN;
});

afterEach(() => {
  process.env = originalEnv;
});

describe("resolveTandemUrl precedence", () => {
  it("uses explicit override over all env vars", () => {
    process.env.CLAUDE_PLUGIN_OPTION_SERVER_URL = "http://plugin-host:1111";
    process.env.TANDEM_URL = "http://manual:2222";
    expect(resolveTandemUrl("http://override:3333")).toBe("http://override:3333");
  });

  it("uses CLAUDE_PLUGIN_OPTION_SERVER_URL over TANDEM_URL when no override", () => {
    process.env.CLAUDE_PLUGIN_OPTION_SERVER_URL = "http://plugin-host:1111";
    process.env.TANDEM_URL = "http://manual:2222";
    expect(resolveTandemUrl()).toBe("http://plugin-host:1111");
  });

  it("uses TANDEM_URL when CLAUDE_PLUGIN_OPTION_SERVER_URL is absent", () => {
    process.env.TANDEM_URL = "http://manual:2222";
    expect(resolveTandemUrl()).toBe("http://manual:2222");
  });

  it("uses TANDEM_URL when CLAUDE_PLUGIN_OPTION_SERVER_URL is blank", () => {
    process.env.CLAUDE_PLUGIN_OPTION_SERVER_URL = "";
    process.env.TANDEM_URL = "http://manual:2222";
    expect(resolveTandemUrl()).toBe("http://manual:2222");
  });

  it("uses TANDEM_URL when CLAUDE_PLUGIN_OPTION_SERVER_URL is whitespace only", () => {
    process.env.CLAUDE_PLUGIN_OPTION_SERVER_URL = "   ";
    process.env.TANDEM_URL = "http://manual:2222";
    expect(resolveTandemUrl()).toBe("http://manual:2222");
  });

  it("falls back to localhost default when all env vars absent", () => {
    expect(resolveTandemUrl()).toBe("http://localhost:3479");
  });

  it("falls back to localhost default when URL env vars are blank", () => {
    process.env.CLAUDE_PLUGIN_OPTION_SERVER_URL = "   ";
    process.env.TANDEM_URL = "";
    expect(resolveTandemUrl()).toBe("http://localhost:3479");
  });

  it("skips blank explicit override before plugin URL", () => {
    process.env.CLAUDE_PLUGIN_OPTION_SERVER_URL = "http://plugin-host:1111";
    process.env.TANDEM_URL = "http://manual:2222";
    expect(resolveTandemUrl("")).toBe("http://plugin-host:1111");
  });

  it("skips whitespace explicit override before TANDEM_URL", () => {
    process.env.TANDEM_URL = "http://manual:2222";
    expect(resolveTandemUrl("   ")).toBe("http://manual:2222");
  });

  it("falls back to localhost default when explicit override and env vars are blank", () => {
    process.env.CLAUDE_PLUGIN_OPTION_SERVER_URL = "   ";
    process.env.TANDEM_URL = "";
    expect(resolveTandemUrl("\t")).toBe("http://localhost:3479");
  });

  it("trims surrounding whitespace and strips trailing slashes", () => {
    process.env.CLAUDE_PLUGIN_OPTION_SERVER_URL = "  http://plugin-host:1111///  ";
    expect(resolveTandemUrl()).toBe("http://plugin-host:1111");
  });

  it("preserves pathful base URLs while stripping trailing slashes", () => {
    process.env.CLAUDE_PLUGIN_OPTION_SERVER_URL = "http://proxy.local/tandem/";
    expect(resolveTandemUrl()).toBe("http://proxy.local/tandem");
  });
});

describe("resolveAuthToken precedence", () => {
  it("uses explicit override over all env vars", () => {
    process.env.CLAUDE_PLUGIN_OPTION_AUTH_TOKEN = "plugin-token-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx";
    process.env.TANDEM_AUTH_TOKEN = "manual-token-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx";
    expect(resolveAuthToken("explicit-token-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxx")).toBe(
      "explicit-token-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
    );
  });

  it("uses CLAUDE_PLUGIN_OPTION_AUTH_TOKEN over TANDEM_AUTH_TOKEN when no override", () => {
    process.env.CLAUDE_PLUGIN_OPTION_AUTH_TOKEN = "plugin-token-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx";
    process.env.TANDEM_AUTH_TOKEN = "manual-token-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx";
    expect(resolveAuthToken()).toBe("plugin-token-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx");
  });

  it("uses TANDEM_AUTH_TOKEN when CLAUDE_PLUGIN_OPTION_AUTH_TOKEN is absent", () => {
    process.env.TANDEM_AUTH_TOKEN = "manual-token-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx";
    expect(resolveAuthToken()).toBe("manual-token-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx");
  });

  it("returns undefined when all auth env vars absent", () => {
    expect(resolveAuthToken()).toBeUndefined();
  });
});

describe("authFetch uses resolveAuthToken (integration)", () => {
  it("sends Authorization header from CLAUDE_PLUGIN_OPTION_AUTH_TOKEN", async () => {
    const validToken = "plugin-token-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx";
    process.env.CLAUDE_PLUGIN_OPTION_AUTH_TOKEN = validToken;

    const fetchSpy = vi.fn().mockResolvedValue(new Response("ok"));
    vi.stubGlobal("fetch", fetchSpy);

    const { authFetch } = await import("../../src/shared/cli-runtime.js");
    await authFetch("http://localhost:3479/test");

    expect(fetchSpy).toHaveBeenCalledOnce();
    const calledHeaders = new Headers(fetchSpy.mock.calls[0][1]?.headers);
    expect(calledHeaders.get("Authorization")).toBe(`Bearer ${validToken}`);

    vi.unstubAllGlobals();
  });

  it("sends no Authorization header when both auth env vars absent", async () => {
    const fetchSpy = vi.fn().mockResolvedValue(new Response("ok"));
    vi.stubGlobal("fetch", fetchSpy);

    const { authFetch } = await import("../../src/shared/cli-runtime.js");
    await authFetch("http://localhost:3479/test");

    expect(fetchSpy).toHaveBeenCalledOnce();
    const calledHeaders = new Headers(fetchSpy.mock.calls[0][1]?.headers);
    expect(calledHeaders.get("Authorization")).toBeNull();

    vi.unstubAllGlobals();
  });
});
