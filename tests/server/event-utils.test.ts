import { describe, expect, it } from "vitest";
import { generateEventId } from "../../src/shared/utils.js";

describe("generateEventId", () => {
  it("matches expected format", () => {
    const id = generateEventId();
    expect(id).toMatch(/^evt_\d+_[a-z0-9]+$/);
  });

  it("successive calls produce different IDs", () => {
    const a = generateEventId();
    const b = generateEventId();
    expect(a).not.toBe(b);
  });

  it("timestamp portion is within 1 second of Date.now()", () => {
    const before = Date.now();
    const id = generateEventId();
    const after = Date.now();
    const ts = Number(id.split("_")[1]);
    expect(ts).toBeGreaterThanOrEqual(before);
    expect(ts).toBeLessThanOrEqual(after);
  });
});
