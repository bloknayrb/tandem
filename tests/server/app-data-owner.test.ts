import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  type AppDataFlavor,
  claimAppDataDir,
  MIGRATION_MARKER_FILE,
  OWNER_STAMP_FILE,
  refusalMessage,
} from "../../src/server/app-data-owner.js";
import { ATOMIC_TEMP_PREFIX } from "../../src/server/file-io/index.js";
import { TOKEN_FILE_NAME } from "../../src/shared/constants.js";

/**
 * #1787 — the desktop sidecar and an npm `tandem` shared one app-data root.
 * Separation is the mechanism (the sidecar now exports `TANDEM_APP_DATA_DIR`);
 * these cover the ownership stamp that makes any residual sharing loud.
 *
 * Every case runs against `mkdtemp` directories, and **`env-paths` is mocked
 * for the whole file**. That is not tidiness: `env-paths` is how the module
 * finds the legacy npm root to migrate FROM, so an unmocked `flavor: "desktop"`
 * claim would `fs.cp` the operator's real app-data directory into a temp dir.
 * It also turned two cases into 15s timeouts under a full-suite run, which is
 * how it was caught.
 */

const legacy = vi.hoisted(() => ({ root: "" }));
vi.mock("env-paths", () => ({
  default: () => ({ data: legacy.root }),
}));

const created: string[] = [];

function tempDir(label: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `tandem-${label}-`));
  created.push(dir);
  return dir;
}

/** Point the module's legacy-root derivation at `dir`. */
function withLegacyRoot(dir: string): void {
  legacy.root = dir;
}

function readStamp(dir: string): unknown {
  return JSON.parse(fs.readFileSync(path.join(dir, OWNER_STAMP_FILE), "utf8"));
}

beforeEach(() => {
  // Default: an EMPTY legacy root, so a case that does not care about the
  // migration cannot accidentally reach a real one.
  withLegacyRoot(tempDir("legacy-empty"));
});

afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of created.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("claimAppDataDir", () => {
  it("stamps an unowned directory and claims it", async () => {
    const dir = tempDir("claim");
    await expect(claimAppDataDir(dir, "1.2.3", "npm")).resolves.toBe("claimed");
    expect(readStamp(dir)).toEqual({ version: "1.2.3", flavor: "npm" });
  });

  it("creates the directory when it does not exist yet", async () => {
    const parent = tempDir("mkdir");
    const dir = path.join(parent, "nested", "app-data");
    await expect(claimAppDataDir(dir, "1.0.0", "desktop")).resolves.toBe("claimed");
    expect(readStamp(dir)).toEqual({ version: "1.0.0", flavor: "desktop" });
  });

  // Kills a rule that refuses on any version difference, which would brick
  // every upgrade.
  it("overwrites the stamp for the same flavor at a different version", async () => {
    const dir = tempDir("upgrade");
    await claimAppDataDir(dir, "1.0.0", "npm");
    await expect(claimAppDataDir(dir, "2.0.0", "npm")).resolves.toBe("claimed");
    expect(readStamp(dir)).toEqual({ version: "2.0.0", flavor: "npm" });
  });

  // The refusal is on FLAVOR, not version ordering: an older build cannot read
  // the stamp at all, so a version-ordered rule protects nothing separation has
  // not already made impossible.
  it("refuses a directory the other flavor owns, returning the owner", async () => {
    const dir = tempDir("mixed");
    await claimAppDataDir(dir, "1.0.0", "desktop");
    const result = await claimAppDataDir(dir, "1.0.0", "npm");
    expect(result).toEqual({ refused: { version: "1.0.0", flavor: "desktop" } });
    // The result is what index.ts turns into `process.exit(1)` — this module
    // never exits on its own.
    expect(readStamp(dir)).toEqual({ version: "1.0.0", flavor: "desktop" });
  });

  // Kills a throw that would make a truncated write unrecoverable.
  it.each([
    ["non-JSON", "not json at all"],
    ["a JSON array", "[]"],
    ["a missing flavor", '{"version":"1.0.0"}'],
    ["an unknown flavor", '{"version":"1.0.0","flavor":"snap"}'],
  ])("treats %s as unowned and overwrites it", async (_label, contents) => {
    const dir = tempDir("corrupt");
    fs.writeFileSync(path.join(dir, OWNER_STAMP_FILE), contents, "utf8");
    await expect(claimAppDataDir(dir, "3.0.0", "npm")).resolves.toBe("claimed");
    expect(readStamp(dir)).toEqual({ version: "3.0.0", flavor: "npm" });
  });
});

describe("claimAppDataDir — one-time legacy migration", () => {
  it("copies the legacy tree once, leaves it intact, and does not re-copy", async () => {
    const source = tempDir("legacy");
    const target = tempDir("desktop");
    withLegacyRoot(source);
    fs.mkdirSync(path.join(source, "sessions"), { recursive: true });
    fs.mkdirSync(path.join(source, "annotations"), { recursive: true });
    fs.writeFileSync(path.join(source, "sessions", "a.json"), "{}", "utf8");
    fs.writeFileSync(path.join(source, "annotations", "b.json"), "{}", "utf8");

    await expect(claimAppDataDir(target, "1.0.0", "desktop")).resolves.toBe("claimed");

    expect(fs.existsSync(path.join(target, "sessions", "a.json"))).toBe(true);
    expect(fs.existsSync(path.join(target, "annotations", "b.json"))).toBe(true);
    expect(fs.existsSync(path.join(source, "sessions", "a.json"))).toBe(true);
    expect(readStamp(target)).toEqual({ version: "1.0.0", flavor: "desktop" });

    // A second claim finds a stamp, so the migration must not run again — a
    // file deleted from the target in between stays deleted.
    fs.rmSync(path.join(target, "sessions", "a.json"));
    await expect(claimAppDataDir(target, "1.0.0", "desktop")).resolves.toBe("claimed");
    expect(fs.existsSync(path.join(target, "sessions", "a.json"))).toBe(false);
  });

  // Kills a migration that fires for the npm install too, which would copy the
  // desktop's state sideways.
  it("does not migrate for the npm flavor", async () => {
    const source = tempDir("legacy-npm");
    const target = tempDir("npm-target");
    withLegacyRoot(source);
    fs.mkdirSync(path.join(source, "sessions"), { recursive: true });
    fs.writeFileSync(path.join(source, "sessions", "a.json"), "{}", "utf8");

    await expect(claimAppDataDir(target, "1.0.0", "npm")).resolves.toBe("claimed");
    expect(fs.existsSync(path.join(target, "sessions"))).toBe(false);
  });

  /**
   * The exclusion filter, one assertion per excluded item, plus the
   * interrupted-copy recovery.
   *
   * The two worst outcomes of an unfiltered `fs.cp` are a copied live
   * `store.lock` (the migrated directory is read-only for annotations forever)
   * and a copied `owner.json` (the app is permanently unstartable, with the
   * refusal pointing at an env var rather than at a file to delete).
   */
  it("excludes the stamp, the store lock, atomic temps and the auth token", async () => {
    const source = tempDir("legacy-filter");
    const target = tempDir("desktop-filter");
    withLegacyRoot(source);
    fs.mkdirSync(path.join(source, "sessions"), { recursive: true });
    fs.mkdirSync(path.join(source, "annotations"), { recursive: true });
    fs.mkdirSync(path.join(source, "doc-backups"), { recursive: true });
    fs.writeFileSync(path.join(source, OWNER_STAMP_FILE), '{"version":"0.1.0","flavor":"npm"}');
    fs.writeFileSync(path.join(source, "annotations", "store.lock"), '{"pid":1}');
    // The real shape production writes — a PREFIX, never a `*.tmp` fixture,
    // which nothing produces and which would therefore pass a no-op filter.
    const temp = `${ATOMIC_TEMP_PREFIX}1700000000-abc`;
    fs.writeFileSync(path.join(source, "sessions", temp), "partial");
    fs.writeFileSync(path.join(source, TOKEN_FILE_NAME), "s3cret");
    fs.writeFileSync(path.join(source, "sessions", "a.json"), "{}");
    fs.writeFileSync(path.join(source, "doc-backups", "y.md"), "# y");

    await expect(claimAppDataDir(target, "1.0.0", "desktop")).resolves.toBe("claimed");

    expect(fs.existsSync(path.join(target, "annotations", "store.lock"))).toBe(false);
    expect(fs.existsSync(path.join(target, "sessions", temp))).toBe(false);
    expect(fs.existsSync(path.join(target, TOKEN_FILE_NAME))).toBe(false);
    expect(fs.existsSync(path.join(target, "sessions", "a.json"))).toBe(true);
    expect(fs.existsSync(path.join(target, "doc-backups", "y.md"))).toBe(true);
    // The legacy stamp said `npm`; ours must be the one on disk.
    expect(readStamp(target)).toEqual({ version: "1.0.0", flavor: "desktop" });

    // An interruption AFTER the copy and BEFORE the stamp must re-claim, not
    // refuse. This is only true because `owner.json` is the one file never
    // copied — `fs.cp` gives no ordering guarantee.
    fs.rmSync(path.join(target, OWNER_STAMP_FILE));
    await expect(claimAppDataDir(target, "1.0.0", "desktop")).resolves.toBe("claimed");
    expect(readStamp(target)).toEqual({ version: "1.0.0", flavor: "desktop" });
  });
});

/**
 * #1787 review — the migration is gated on its OWN completion marker, not on
 * the stamp.
 *
 * The desktop refusal message tells the user to delete `owner.json`. While the
 * migration was stamp-gated, following that advice silently re-ran `fs.cp` over
 * the whole legacy npm tree: `force: false` protects only files that still
 * EXIST, so sessions, annotation envelopes and doc backups the user had since
 * deleted came back. The same path was reachable with no user action at all,
 * because a truncated stamp reads as "unowned" — which is also why the stamp is
 * now written through `atomicWrite`.
 */
describe("claimAppDataDir — migration completion marker", () => {
  async function migrateOnce(): Promise<{ source: string; target: string }> {
    const source = tempDir("legacy-marker");
    const target = tempDir("desktop-marker");
    withLegacyRoot(source);
    fs.mkdirSync(path.join(source, "sessions"), { recursive: true });
    fs.writeFileSync(path.join(source, "sessions", "a.json"), "{}", "utf8");
    await expect(claimAppDataDir(target, "1.0.0", "desktop")).resolves.toBe("claimed");
    expect(fs.existsSync(path.join(target, "sessions", "a.json"))).toBe(true);
    return { source, target };
  }

  it("records the completed migration in its own file", async () => {
    const { target } = await migrateOnce();
    expect(fs.existsSync(path.join(target, MIGRATION_MARKER_FILE))).toBe(true);
  });

  // The headline regression: the product's own printed remedy must not
  // resurrect deleted state.
  it("does not re-import the legacy tree after the stamp is deleted", async () => {
    const { target } = await migrateOnce();
    fs.rmSync(path.join(target, "sessions", "a.json"));
    fs.rmSync(path.join(target, OWNER_STAMP_FILE));

    await expect(claimAppDataDir(target, "1.0.0", "desktop")).resolves.toBe("claimed");

    expect(fs.existsSync(path.join(target, "sessions", "a.json"))).toBe(false);
    expect(readStamp(target)).toEqual({ version: "1.0.0", flavor: "desktop" });
  });

  // `readStamp` reports a malformed stamp as "unowned" too, so a stamp-gated
  // migration re-ran on a crash mid-write with nobody having touched anything.
  it("does not re-import the legacy tree behind a truncated stamp", async () => {
    const { target } = await migrateOnce();
    fs.rmSync(path.join(target, "sessions", "a.json"));
    fs.writeFileSync(path.join(target, OWNER_STAMP_FILE), '{"version":"1.0.0","fla', "utf8");

    await expect(claimAppDataDir(target, "1.0.0", "desktop")).resolves.toBe("claimed");
    expect(fs.existsSync(path.join(target, "sessions", "a.json"))).toBe(false);
  });

  // The marker is the completion record, so a legacy copy of one must not be
  // able to precede an interrupted `fs.cp` (which gives no ordering guarantee)
  // and make a half-migrated directory read as finished.
  it("never copies a legacy marker in", async () => {
    const source = tempDir("legacy-marker-src");
    const target = tempDir("desktop-marker-src");
    withLegacyRoot(source);
    fs.writeFileSync(path.join(source, MIGRATION_MARKER_FILE), "{}", "utf8");
    fs.writeFileSync(path.join(source, "keep.json"), "{}", "utf8");

    await expect(claimAppDataDir(target, "1.0.0", "desktop")).resolves.toBe("claimed");
    expect(fs.existsSync(path.join(target, "keep.json"))).toBe(true);
    // Present, but written by US after the copy — never the legacy one.
    expect(fs.readFileSync(path.join(target, MIGRATION_MARKER_FILE), "utf8")).not.toBe("{}");
  });

  /**
   * The stamp goes down through `atomicWrite` — temp sibling, then rename — so
   * a crash mid-write cannot leave a truncated `owner.json` that hands the
   * directory to the other flavor.
   *
   * Asserted on the rename because that IS the guarantee: no state where the
   * final path holds a partial file.
   */
  it("writes the stamp atomically rather than in place", async () => {
    const dir = tempDir("stamp-atomic");
    const rename = vi.spyOn(fs.promises, "rename");
    await expect(claimAppDataDir(dir, "1.0.0", "npm")).resolves.toBe("claimed");

    const stamp = path.join(dir, OWNER_STAMP_FILE);
    const call = rename.mock.calls.find(([, to]) => to === stamp);
    expect(call, "the stamp must arrive by rename, not by a direct write").toBeDefined();
    expect(path.basename(String(call?.[0]))).toMatch(
      new RegExp(`^${ATOMIC_TEMP_PREFIX.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`),
    );
    expect(readStamp(dir)).toEqual({ version: "1.0.0", flavor: "npm" });
  });
});

describe("claimAppDataDir — failure contract", () => {
  /**
   * It is called where `main().catch(...) => process.exit(1)` turns any throw
   * into a startup abort — for the desktop, `wait_for_health` failing through
   * `MAX_RESTARTS` into the "Retry Server Start" dialog, i.e. an app that never
   * starts with no in-product recovery.
   */
  it("never throws when the migration fails, and writes no stamp", async () => {
    const source = tempDir("legacy-throw");
    const target = tempDir("desktop-throw");
    withLegacyRoot(source);
    fs.mkdirSync(path.join(source, "sessions"), { recursive: true });
    fs.writeFileSync(path.join(source, "sessions", "a.json"), "{}", "utf8");

    const cp = vi.spyOn(fs.promises, "cp").mockRejectedValue(new Error("EBUSY"));
    await expect(claimAppDataDir(target, "1.0.0", "desktop")).resolves.toBe("claimed");
    expect(fs.existsSync(path.join(target, OWNER_STAMP_FILE))).toBe(false);

    // No stamp means the NEXT launch re-attempts the migration rather than
    // recording a copy that did not happen.
    cp.mockRestore();
    await expect(claimAppDataDir(target, "1.0.0", "desktop")).resolves.toBe("claimed");
    expect(fs.existsSync(path.join(target, "sessions", "a.json"))).toBe(true);
  });

  it("never throws when the stamp write fails", async () => {
    const dir = tempDir("stamp-throw");
    const write = vi.spyOn(fs.promises, "writeFile").mockRejectedValue(new Error("EACCES"));
    await expect(claimAppDataDir(dir, "1.0.0", "npm")).resolves.toBe("claimed");
    write.mockRestore();
    expect(fs.existsSync(path.join(dir, OWNER_STAMP_FILE))).toBe(false);
  });
});

describe("refusalMessage", () => {
  const owner = { version: "1.0.0", flavor: "desktop" as AppDataFlavor };

  it("offers TANDEM_APP_DATA_DIR to the npm install", () => {
    const message = refusalMessage("/tmp/x", owner, "npm", {});
    expect(message).toContain("TANDEM_APP_DATA_DIR");
    expect(message).toContain("desktop install");
  });

  /**
   * #1787 review — "Set TANDEM_APP_DATA_DIR" reads as a no-op when the variable
   * is already set, invisibly, by an ancestor process. `supervisor.ts`'s
   * `childEnv` strips it for the auto-launched session, but a hand-exported one
   * still arrives, so the message states the value it is actually running with.
   */
  it("names the current TANDEM_APP_DATA_DIR when one is already set", () => {
    const message = refusalMessage("/tmp/x", owner, "npm", {
      TANDEM_APP_DATA_DIR: "/desktop/root",
    });
    expect(message).toContain("/desktop/root");
    expect(message).toContain("inherited");
  });

  // The env-var remedy is inert on the desktop arm: the sidecar sets that
  // variable explicitly on the child, and an explicit `.env()` overrides an
  // inherited value.
  it("points the desktop at the stamp file instead of the env var", () => {
    const message = refusalMessage("/tmp/x", { version: "2.0.0", flavor: "npm" }, "desktop");
    expect(message).not.toContain("TANDEM_APP_DATA_DIR");
    expect(message).toContain(OWNER_STAMP_FILE);
  });
});
