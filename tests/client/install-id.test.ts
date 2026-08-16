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

  it("pins the exact hash, so a silent re-key of every user is impossible", () => {
    // Golden vectors, and they earn their keep: swapping `Math.imul` for plain
    // `*` — which loses low bits once the product passes 2^53 — leaves every
    // other assertion in this file passing (sampled paths stay distinct, output
    // is still 8 hex chars, still deterministic). Any drift in the hash OR the
    // normalisation re-keys every existing user, and their orphaned 4-segment
    // keys are exactly what the legacy purge (3-segment only) will never
    // collect. Regenerate these only with a deliberate migration.
    expect(installIdFromStoragePath("/home/x/.local/share/tandem/sessions")).toBe("53640ea4");
    expect(installIdFromStoragePath("C:\\Users\\x\\AppData\\Local\\tandem\\Data\\sessions")).toBe(
      "de3381f5",
    );
  });

  it("separates the real store from an isolated test store", () => {
    // The case that matters: E2E, perf and design baselines each set their own
    // TANDEM_APP_DATA_DIR. (Screenshots do not — that config spreads the root
    // Playwright webServer, so it shares E2E's dir and id.)
    expect(installIdFromStoragePath("C:/Users/x/AppData/Local/tandem/Data/sessions")).not.toBe(
      installIdFromStoragePath("C:/tmp/tandem-e2e-data/sessions"),
    );
  });

  it("returns a filesystem- and key-safe token", () => {
    // The shape matters independently of the value above: the legacy purge
    // discriminates on colon count, so an id containing a colon would make a
    // scoped key look like a legacy one and get swept on every start.
    const id = installIdFromStoragePath("/home/x/.local/share/tandem/sessions");
    expect(id).toMatch(/^[0-9a-f]{8}$/);
    expect(id).not.toContain(":");
  });
});
