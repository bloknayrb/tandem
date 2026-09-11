import fs from "fs/promises";
import os from "os";
import path from "path";
import { afterEach, describe, expect, it, vi } from "vitest";
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

describe("checkVersionChange — onUpgrade hook (#1792)", () => {
  it("writes the stamp only after the hook resolves", async () => {
    const dir = await makeTmpDir();
    const versionFile = path.join(dir, "last-seen-version");
    await fs.writeFile(versionFile, "0.2.6");

    const stamps: string[] = [];
    const onUpgrade = vi.fn(async () => {
      stamps.push(await fs.readFile(versionFile, "utf-8"));
    });

    const result = await checkVersionChange("0.2.7", versionFile, { onUpgrade });

    expect(result).toBe("upgraded");
    expect(onUpgrade).toHaveBeenCalledTimes(1);
    // The hook ran BEFORE the stamp — it still saw the old version.
    expect(stamps[0]?.trim()).toBe("0.2.6");
    expect((await fs.readFile(versionFile, "utf-8")).trim()).toBe("0.2.7");
  });

  it("leaves the stamp unwritten when the hook rejects, so the next start retries", async () => {
    const dir = await makeTmpDir();
    const versionFile = path.join(dir, "last-seen-version");
    await fs.writeFile(versionFile, "0.2.6");

    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const failing = await checkVersionChange("0.2.7", versionFile, {
      onUpgrade: async () => {
        throw new Error("CHANGELOG.md open failed");
      },
    });
    errorSpy.mockRestore();

    expect(failing).toBe("upgraded");
    // Unstamped — otherwise that release's notes would never open at all.
    expect((await fs.readFile(versionFile, "utf-8")).trim()).toBe("0.2.6");

    const retried = await checkVersionChange("0.2.7", versionFile, { onUpgrade: async () => {} });
    expect(retried).toBe("upgraded");
    expect((await fs.readFile(versionFile, "utf-8")).trim()).toBe("0.2.7");
  });

  it("never calls the hook on first-install, and still stamps", async () => {
    const dir = await makeTmpDir();
    const versionFile = path.join(dir, "last-seen-version");
    const onUpgrade = vi.fn(async () => {});

    const result = await checkVersionChange("0.2.7", versionFile, { onUpgrade });

    expect(result).toBe("first-install");
    expect(onUpgrade).not.toHaveBeenCalled();
    expect((await fs.readFile(versionFile, "utf-8")).trim()).toBe("0.2.7");
  });
});
