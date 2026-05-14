import fs from "fs/promises";
import os from "os";
import path from "path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getActiveDocId, getOpenDocs, removeDoc } from "../../src/server/mcp/document-service.js";
import { maybeOpenStartupFile } from "../../src/server/startup-file.js";
import { removeDocument } from "../../src/server/yjs/provider.js";

// Spy on setActiveDocId so a single test can simulate a programming-bug
// throw and verify the narrowed catch lets it propagate. vi.hoisted is
// required: vi.mock factories are hoisted above all top-level statements,
// so the spy must be declared in a hoisted block too. Defaults to the
// real implementation; tests that don't override it see normal behavior.
const { setActiveDocIdSpy } = vi.hoisted(() => ({ setActiveDocIdSpy: vi.fn() }));
vi.mock("../../src/server/mcp/document-service.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/server/mcp/document-service.js")>();
  setActiveDocIdSpy.mockImplementation(actual.setActiveDocId);
  return { ...actual, setActiveDocId: setActiveDocIdSpy };
});

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

  it("propagates setActiveDocId failures (narrowed-catch contract)", async () => {
    // The catch in maybeOpenStartupFile wraps openFileByPath ONLY. A throw
    // from setActiveDocId — which would indicate a programming bug, not an
    // expected I/O error — must surface to the caller.
    //
    // openFileByPath itself calls setActiveDocId internally (to mark the
    // newly-opened doc active), so we let the first call execute the real
    // implementation and only throw on the SECOND call (the one inside
    // maybeOpenStartupFile after openFileByPath returns).
    const dir = await makeTmpDir();
    const filePath = path.join(dir, "valid.md");
    await fs.writeFile(filePath, "# valid\n");

    let callCount = 0;
    const realImpl = setActiveDocIdSpy.getMockImplementation();
    setActiveDocIdSpy.mockImplementation((id: string | null) => {
      callCount += 1;
      if (callCount >= 2) {
        throw new Error("simulated setActiveDocId bug");
      }
      return realImpl?.(id);
    });

    try {
      await expect(maybeOpenStartupFile(filePath)).rejects.toThrow("simulated setActiveDocId bug");
    } finally {
      // Restore the default-passthrough impl so afterEach cleanup works.
      if (realImpl) setActiveDocIdSpy.mockImplementation(realImpl);
    }
  });
});
