import { describe, expect, it } from "vitest";

describe("monitor exports", () => {
  it("exposes entry points for testing", async () => {
    const mod = await import("../../src/monitor/index.js");
    expect(typeof mod.main).toBe("function");
    expect(typeof mod.connectAndStream).toBe("function");
    expect(typeof mod.getCachedMode).toBe("function");
    expect(typeof mod._resetMonitorStateForTests).toBe("function");
  });
});
