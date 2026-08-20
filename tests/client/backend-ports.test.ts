import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_MCP_PORT, DEFAULT_WS_PORT } from "../../src/shared/constants";

/**
 * src/client/utils/backend-ports.ts (#1492) — the one module every
 * client→backend URL flows through.
 *
 * The module resolves its ports at MODULE SCOPE, and vitest caches evaluated
 * modules — so `vi.stubEnv` after a static import changes nothing and every
 * case would silently exercise the fallback path (the review's FINDING 7).
 * Hence the shape here: `vi.resetModules()` THEN `vi.stubEnv` THEN a dynamic
 * import, per case. Load-bearing was verified by deleting the override branch
 * in `resolvePort` and watching the override case (and only it) go red.
 */
async function load() {
  return await import("../../src/client/utils/backend-ports");
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe("backend-ports — env unset (production and every non-harness build)", () => {
  it("falls back to the product ports and emits the exact pre-#1492 URLs", async () => {
    vi.resetModules();
    const mod = await load();
    expect(mod.MCP_PORT).toBe(DEFAULT_MCP_PORT);
    expect(mod.WS_PORT).toBe(DEFAULT_WS_PORT);
    // Byte-for-byte the literals the client used to bake in. If either drifts,
    // production behaviour changed — that is a bug in this module, full stop.
    expect(mod.MCP_BASE_URL).toBe("http://127.0.0.1:3479");
    expect(mod.WS_URL).toBe("ws://127.0.0.1:3478");
  });
});

describe("backend-ports — harness override", () => {
  it("uses VITE_TANDEM_* when set to valid ports", async () => {
    vi.resetModules();
    vi.stubEnv("VITE_TANDEM_MCP_PORT", "4729");
    vi.stubEnv("VITE_TANDEM_WS_PORT", "4728");
    const mod = await load();
    expect(mod.MCP_PORT).toBe(4729);
    expect(mod.WS_PORT).toBe(4728);
    expect(mod.MCP_BASE_URL).toBe("http://127.0.0.1:4729");
    expect(mod.WS_URL).toBe("ws://127.0.0.1:4728");
  });

  it("publishes the resolved ports as window.__TANDEM_PORTS__", async () => {
    // The perf harness's pre-seed assertion reads this — it is the only way a
    // built (no dev server) client can prove which backend it targets.
    vi.resetModules();
    vi.stubEnv("VITE_TANDEM_MCP_PORT", "4729");
    vi.stubEnv("VITE_TANDEM_WS_PORT", "4728");
    await load();
    expect(window.__TANDEM_PORTS__).toEqual({ ws: 4728, mcp: 4729 });
  });

  it.each([
    ["zero", "0"],
    ["not a number", "abc"],
    ["out of range", "99999"],
    ["empty", ""],
    ["trailing junk", "4729x"],
    ["too many digits", "472900"],
  ])("falls back on a garbage value (%s: %j) rather than fetching port NaN", async (_l, raw) => {
    vi.resetModules();
    vi.stubEnv("VITE_TANDEM_MCP_PORT", raw);
    const mod = await load();
    expect(mod.MCP_PORT).toBe(DEFAULT_MCP_PORT);
    expect(mod.MCP_BASE_URL).toBe(`http://127.0.0.1:${DEFAULT_MCP_PORT}`);
  });

  it("resolves the two ports independently", async () => {
    vi.resetModules();
    vi.stubEnv("VITE_TANDEM_WS_PORT", "4728");
    const mod = await load();
    expect(mod.WS_PORT).toBe(4728);
    expect(mod.MCP_PORT).toBe(DEFAULT_MCP_PORT);
  });
});
