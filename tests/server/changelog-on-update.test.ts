import fs from "fs/promises";
import os from "os";
import path from "path";
import { afterEach, describe, expect, it } from "vitest";
import { checkVersionChange } from "../../src/server/version-check.js";

let tmpDir: string | null = null;

async function makeTmpDir(): Promise<string> {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "tandem-ver-test-"));
  return tmpDir;
}

afterEach(async () => {
  if (tmpDir) {
    await fs.rm(tmpDir, { recursive: true, force: true });
    tmpDir = null;
  }
});

describe("checkVersionChange", () => {
  it("returns 'first-install' and writes version when file does not exist", async () => {
    const dir = await makeTmpDir();
    const versionFile = path.join(dir, "last-seen-version");

    const result = await checkVersionChange("0.2.7", versionFile);

    expect(result).toBe("first-install");
    const written = await fs.readFile(versionFile, "utf-8");
    expect(written.trim()).toBe("0.2.7");
  });

  it("returns 'upgraded' and writes version when file has older version", async () => {
    const dir = await makeTmpDir();
    const versionFile = path.join(dir, "last-seen-version");
    await fs.writeFile(versionFile, "0.2.6");

    const result = await checkVersionChange("0.2.7", versionFile);

    expect(result).toBe("upgraded");
    const written = await fs.readFile(versionFile, "utf-8");
    expect(written.trim()).toBe("0.2.7");
  });

  it("returns 'current' when file matches version", async () => {
    const dir = await makeTmpDir();
    const versionFile = path.join(dir, "last-seen-version");
    await fs.writeFile(versionFile, "0.2.7");

    const result = await checkVersionChange("0.2.7", versionFile);

    expect(result).toBe("current");
  });

  it("trims whitespace from stored version before comparing", async () => {
    const dir = await makeTmpDir();
    const versionFile = path.join(dir, "last-seen-version");
    await fs.writeFile(versionFile, "0.2.7\n");

    const result = await checkVersionChange("0.2.7", versionFile);

    expect(result).toBe("current");
  });

  it("creates parent directory if it does not exist", async () => {
    const dir = await makeTmpDir();
    const nested = path.join(dir, "nested", "deep");
    const versionFile = path.join(nested, "last-seen-version");

    const result = await checkVersionChange("0.2.7", versionFile);

    expect(result).toBe("first-install");
    const written = await fs.readFile(versionFile, "utf-8");
    expect(written.trim()).toBe("0.2.7");
  });

  it("returns 'upgraded' on downgrade (treats any mismatch as upgrade)", async () => {
    const dir = await makeTmpDir();
    const versionFile = path.join(dir, "last-seen-version");
    await fs.writeFile(versionFile, "0.2.8");

    const result = await checkVersionChange("0.2.7", versionFile);

    expect(result).toBe("upgraded");
  });
});
