import fs from "fs/promises";
import os from "os";
import path from "path";
import { afterEach, describe, expect, it } from "vitest";
import { getActiveDocId, getOpenDocs, removeDoc } from "../../src/server/mcp/document-service.js";
import { maybeOpenStartupFile } from "../../src/server/startup-file.js";
import { removeDocument } from "../../src/server/yjs/provider.js";

let tmpDir: string | null = null;

async function makeTmpDir(): Promise<string> {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "tandem-startup-test-"));
  return tmpDir;
}

afterEach(async () => {
  for (const id of getOpenDocs().keys()) {
    removeDoc(id);
    removeDocument(id);
  }
  if (tmpDir) {
    await fs.rm(tmpDir, { recursive: true, force: true });
    tmpDir = null;
  }
});

describe("maybeOpenStartupFile", () => {
  it("returns false and is a no-op when env var is undefined", async () => {
    const ok = await maybeOpenStartupFile(undefined);
    expect(ok).toBe(false);
    expect(getOpenDocs().size).toBe(0);
  });

  it("returns false and is a no-op when env var is empty", async () => {
    const ok = await maybeOpenStartupFile("");
    expect(ok).toBe(false);
    expect(getOpenDocs().size).toBe(0);
  });

  it("returns false and is a no-op when env var is whitespace", async () => {
    const ok = await maybeOpenStartupFile("   ");
    expect(ok).toBe(false);
    expect(getOpenDocs().size).toBe(0);
  });

  it("opens the file and sets active doc when env var points to a valid .md", async () => {
    const dir = await makeTmpDir();
    const filePath = path.join(dir, "from-os.md");
    await fs.writeFile(filePath, "# Opened via file association\n");

    const ok = await maybeOpenStartupFile(filePath);
    expect(ok).toBe(true);
    expect(getOpenDocs().size).toBe(1);
    const [openDoc] = [...getOpenDocs().values()];
    expect(openDoc.filePath).toBe(filePath);
    expect(getActiveDocId()).toBe(openDoc.id);
  });

  it("returns false (does not throw) when env var points to a missing file", async () => {
    const ok = await maybeOpenStartupFile("/definitely/does/not/exist.md");
    expect(ok).toBe(false);
    expect(getOpenDocs().size).toBe(0);
  });

  it("returns false when env var points to an unsupported extension", async () => {
    const dir = await makeTmpDir();
    const filePath = path.join(dir, "binary.exe");
    await fs.writeFile(filePath, "MZ");
    const ok = await maybeOpenStartupFile(filePath);
    expect(ok).toBe(false);
    expect(getOpenDocs().size).toBe(0);
  });

  it("opens .txt files", async () => {
    const dir = await makeTmpDir();
    const filePath = path.join(dir, "plain.txt");
    await fs.writeFile(filePath, "Hello\n");
    const ok = await maybeOpenStartupFile(filePath);
    expect(ok).toBe(true);
    expect(getOpenDocs().size).toBe(1);
  });
});
