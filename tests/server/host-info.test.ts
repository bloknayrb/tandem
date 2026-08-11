import os from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import { collectHostInfo } from "../../src/server/mcp/host-info.js";

/**
 * `collectHostInfo` feeds a payload that ends up in a public GitHub issue, so
 * the two properties under test are: nothing identifying leaks, and no field
 * can be shaped in a way that breaks the consumer downstream.
 */

afterEach(() => {
  vi.restoreAllMocks();
});

describe("collectHostInfo", () => {
  it("returns the runtime fields unconditionally", () => {
    const info = collectHostInfo();
    expect(info.platform).toBe(process.platform);
    expect(info.arch).toBe(process.arch);
    expect(info.nodeVersion).toBe(process.version);
    expect(typeof info.tauriSidecar).toBe("boolean");
  });

  it("omits the CPU fields rather than defaulting them when os.cpus() is empty", () => {
    // Real behaviour on some cgroup-restricted containers. The fields are
    // optional precisely so this host does not fail schema validation.
    vi.spyOn(os, "cpus").mockReturnValue([]);
    const info = collectHostInfo();
    expect(info.cpuModel).toBeUndefined();
    expect(info.cpuCount).toBeUndefined();
    expect(info.platform).toBe(process.platform);
  });

  it("survives a throwing os call instead of failing the whole payload", () => {
    vi.spyOn(os, "version").mockImplementation(() => {
      throw new Error("unsupported");
    });
    const info = collectHostInfo();
    expect(info.osVersion).toBeUndefined();
    expect(info.nodeVersion).toBe(process.version);
  });

  it("truncates a long os.version() on a code-point boundary", () => {
    // A plain .slice() here would bisect the surrogate pair straddling index
    // 120, and the lone surrogate left behind makes encodeURIComponent throw —
    // which silently drops the entire Report-a-bug prefill.
    vi.spyOn(os, "version").mockReturnValue(`${"a".repeat(119)}😀${"b".repeat(50)}`);
    const version = collectHostInfo().osVersion as string;

    expect(version.length).toBeLessThanOrEqual(121);
    expect(() => encodeURIComponent(version)).not.toThrow();
    // No unpaired surrogate anywhere in the result.
    expect(version).not.toMatch(
      /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/,
    );
  });

  it("keeps a short os.version() intact", () => {
    vi.spyOn(os, "version").mockReturnValue("Windows 11 Pro");
    expect(collectHostInfo().osVersion).toBe("Windows 11 Pro");
  });

  it("reports 0 MB free rather than dropping the field", () => {
    // Unlike a 0 CPU count (which only means "unknown"), 0 free memory is a
    // real and rather interesting reading.
    vi.spyOn(os, "freemem").mockReturnValue(0);
    expect(collectHostInfo().freeMemoryMb).toBe(0);
  });

  it("carries nothing identifying", () => {
    const info = collectHostInfo() as Record<string, unknown>;
    expect(Object.keys(info).sort()).toEqual([
      "arch",
      "cpuCount",
      "cpuModel",
      "freeMemoryMb",
      "nodeVersion",
      "osRelease",
      "osVersion",
      "platform",
      "tauriSidecar",
      "totalMemoryMb",
    ]);
    const wire = JSON.stringify(info);
    expect(wire).not.toContain(os.hostname());
    expect(wire).not.toContain(os.homedir());
  });
});
