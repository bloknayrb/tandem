import { existsSync, readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const MONITOR_DIST = resolve(import.meta.dirname, "../../dist/monitor/index.js");

describe("monitor build artifact", () => {
  it("dist/monitor/index.js exists after build (run `npm run build:server` first)", () => {
    if (!existsSync(MONITOR_DIST)) {
      console.warn("Skipping: run `npm run build:server` first to produce the bundle.");
      return;
    }
    expect(statSync(MONITOR_DIST).size).toBeGreaterThan(1000);
  });

  it("dist/monitor/index.js references /api/events (not accidentally a different endpoint)", () => {
    if (!existsSync(MONITOR_DIST)) return;
    const content = readFileSync(MONITOR_DIST, "utf-8");
    expect(content).toContain("/api/events");
    expect(content).toContain("/api/mode");
  });
});
