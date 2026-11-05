import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  bridgeCopyPath,
  isOlderVersion,
  prepareBridgeCopy,
  pruneBridgeCopies,
} from "../../../src/server/integrations/bridge-copy.js";

/**
 * #2358 PR 2b — the Linux AppImage's app-data copy of the stdio bridge, so
 * Claude Code's entry names a path that outlives the per-run mount. Design
 * §3.6, "Rule: which script".
 */

const POSIX = process.platform !== "win32";
let root: string;
let appData: string;
let source: string;
let errSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "tandem-bridge-copy-"));
  appData = join(root, "appdata");
  mkdirSync(appData, { mode: 0o700 });
  source = join(root, "mount", "dist", "stdio-bridge", "index.js");
  mkdirSync(join(source, ".."), { recursive: true });
  writeFileSync(source, "// bridge v1\n");
  errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  errSpy.mockRestore();
  rmSync(root, { recursive: true, force: true });
});

describe("prepareBridgeCopy", () => {
  it("copies the bundle to bin/<version>/dist/stdio-bridge/index.js with an ESM marker", async () => {
    const dest = await prepareBridgeCopy({ source, appDataDir: appData, version: "0.31.0" });

    expect(dest).toBe(bridgeCopyPath(appData, "0.31.0"));
    expect(readFileSync(dest as string, "utf-8")).toBe("// bridge v1\n");
    expect(
      JSON.parse(readFileSync(join(appData, "bin", "0.31.0", "package.json"), "utf-8")),
    ).toEqual({ type: "module" });
    if (POSIX) {
      expect(statSync(dest as string).mode & 0o777).toBe(0o600);
      expect(statSync(join(appData, "bin")).mode & 0o777).toBe(0o700);
    }
  });

  it("does not rewrite a copy whose hash already matches", async () => {
    const dest = (await prepareBridgeCopy({
      source,
      appDataDir: appData,
      version: "0.31.0",
    })) as string;
    const before = statSync(dest).ino;

    await prepareBridgeCopy({ source, appDataDir: appData, version: "0.31.0" });

    expect(statSync(dest).ino).toBe(before);
  });

  it("recopies a copy that differs from the bundle", async () => {
    const dest = (await prepareBridgeCopy({
      source,
      appDataDir: appData,
      version: "0.31.0",
    })) as string;
    writeFileSync(dest, "// tampered\n");

    await prepareBridgeCopy({ source, appDataDir: appData, version: "0.31.0" });

    expect(readFileSync(dest, "utf-8")).toBe("// bridge v1\n");
  });

  it.runIf(POSIX)("refuses a link planted at bin/", async () => {
    const elsewhere = join(root, "elsewhere");
    mkdirSync(elsewhere);
    symlinkSync(elsewhere, join(appData, "bin"));

    expect(await prepareBridgeCopy({ source, appDataDir: appData, version: "0.31.0" })).toBeNull();
    expect(existsSync(join(elsewhere, "0.31.0"))).toBe(false);
  });

  it.runIf(POSIX)("refuses a link planted at the destination file", async () => {
    const dir = join(appData, "bin", "0.31.0", "dist", "stdio-bridge");
    mkdirSync(dir, { recursive: true });
    const target = join(root, "victim.js");
    writeFileSync(target, "// victim\n");
    symlinkSync(target, join(dir, "index.js"));

    expect(await prepareBridgeCopy({ source, appDataDir: appData, version: "0.31.0" })).toBeNull();
    expect(readFileSync(target, "utf-8")).toBe("// victim\n");
  });

  it.each(["../x", "0.31", "a/b", "", "0.31.0/../.."])("refuses version %j", async (version) => {
    expect(await prepareBridgeCopy({ source, appDataDir: appData, version })).toBeNull();
    expect(existsSync(join(appData, "bin"))).toBe(false);
  });

  it("reaps an orphaned copy temp older than an hour", async () => {
    const dir = join(appData, "bin", "0.31.0", "dist", "stdio-bridge");
    mkdirSync(dir, { recursive: true });
    const orphan = join(dir, ".index-00000000-0000-0000-0000-000000000000.tmp");
    writeFileSync(orphan, "x");
    const old = new Date(Date.now() - 2 * 60 * 60 * 1000);
    utimesSync(orphan, old, old);

    await prepareBridgeCopy({ source, appDataDir: appData, version: "0.31.0" });

    expect(existsSync(orphan)).toBe(false);
  });
});

describe("pruneBridgeCopies", () => {
  const make = async (v: string) => prepareBridgeCopy({ source, appDataDir: appData, version: v });

  it("removes OLDER, unreferenced versions only", async () => {
    await make("0.29.0");
    const referenced = (await make("0.30.0")) as string;
    await make("0.31.0");
    await make("0.32.0"); // a newer AppImage used side by side owns this one

    const removed = await pruneBridgeCopies({
      appDataDir: appData,
      keepVersion: "0.31.0",
      referenced: new Set([referenced]),
    });

    expect(removed).toEqual(["0.29.0"]);
    for (const v of ["0.30.0", "0.31.0", "0.32.0"]) {
      expect(existsSync(join(appData, "bin", v))).toBe(true);
    }
  });

  it("never touches a directory that is not version-shaped", async () => {
    mkdirSync(join(appData, "bin", "mine"), { recursive: true });
    await make("0.31.0");

    await pruneBridgeCopies({ appDataDir: appData, keepVersion: "0.32.0", referenced: new Set() });

    expect(existsSync(join(appData, "bin", "mine"))).toBe(true);
  });
});

describe("isOlderVersion", () => {
  it.each([
    ["0.30.0", "0.31.0", true],
    ["0.31.0", "0.31.0", false],
    ["0.32.0", "0.31.0", false],
    ["1.0.0-rc.1", "1.0.0", true],
    ["1.0.0", "1.0.0-rc.1", false],
    ["x", "0.31.0", false],
  ])("%s older than %s → %s", (a, b, want) => {
    expect(isOlderVersion(a, b)).toBe(want);
  });
});
