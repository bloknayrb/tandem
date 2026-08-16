import { describe, expect, it } from "vitest";
import { installIdFromStoragePath } from "../../src/client/utils/install-id";

/**
 * #1387 — the discriminator that keeps two Tandem servers on one machine from
 * reading each other's browser-local state. See the module docblock for why the
 * server's session-store path is the thing being hashed, and `generationId` is
 * not.
 */

describe("installIdFromStoragePath", () => {
  it("gives one id to one directory however its path is spelled", () => {
    // A restart must never look like a different installation, or recovery
    // silently stops working. The same directory reaches us spelled differently
    // depending on who resolved it — Windows APIs return backslashes and an
    // unpredictable drive-letter case.
    const a = installIdFromStoragePath("C:\\Users\\x\\AppData\\Local\\tandem\\Data\\sessions");
    const b = installIdFromStoragePath("c:/users/x/appdata/local/tandem/data/sessions");
    const c = installIdFromStoragePath("C:\\Users\\x\\AppData\\Local\\tandem\\Data\\sessions\\");
    expect(a).toBe(b);
    expect(a).toBe(c);
  });

  it("separates the real store from an isolated test store", () => {
    // The case that matters: E2E, perf, design-baselines and screenshots each
    // set their own TANDEM_APP_DATA_DIR.
    expect(installIdFromStoragePath("C:/Users/x/AppData/Local/tandem/Data/sessions")).not.toBe(
      installIdFromStoragePath("C:/tmp/tandem-e2e-data/sessions"),
    );
  });

  it("returns a stable, filesystem-safe token", () => {
    const id = installIdFromStoragePath("/home/x/.local/share/tandem/sessions");
    expect(id).toMatch(/^[0-9a-f]{8}$/);
    expect(installIdFromStoragePath("/home/x/.local/share/tandem/sessions")).toBe(id);
  });
});
