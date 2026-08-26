import fs from "fs/promises";
import os from "os";
import path from "path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { removeDoc } from "../../src/server/documents/registry-testing.js";
import { getActiveDocId, getOpenDocs } from "../../src/server/mcp/document-service.js";
import { maybeOpenStartupFile } from "../../src/server/startup-file.js";
import { getOrCreateDocument, removeDocument } from "../../src/server/yjs/provider.js";
import {
  CTRL_ROOM,
  Y_MAP_ACTIVE_DOCUMENT_ID,
  Y_MAP_DOCUMENT_META,
} from "../../src/shared/constants.js";

// Spy on activateDocument so a single test can simulate a programming-bug
// throw and verify the narrowed catch lets it propagate. vi.hoisted is
// required: vi.mock factories are hoisted above all top-level statements,
// so the spy must be declared in a hoisted block too. Defaults to the
// real implementation; tests that don't override it see normal behavior.
const { activateDocumentSpy } = vi.hoisted(() => ({ activateDocumentSpy: vi.fn() }));
vi.mock("../../src/server/mcp/document-service.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/server/mcp/document-service.js")>();
  activateDocumentSpy.mockImplementation(actual.activateDocument);
  return { ...actual, activateDocument: activateDocumentSpy };
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

    // …and PUBLISHES it. Before ADR-033 this activated with a bare
    // `setActiveDocId`: openFileByPath had already broadcast, but with the
    // previous active id, so module state and published state disagreed until
    // some unrelated broadcast happened to fire. Asserting module state alone
    // could not see that — it was the half that was already right.
    const published = getOrCreateDocument(CTRL_ROOM).getMap(Y_MAP_DOCUMENT_META);
    expect(published.get(Y_MAP_ACTIVE_DOCUMENT_ID)).toBe(openDoc.id);
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

  it("propagates activateDocument failures (narrowed-catch contract)", async () => {
    // The catch in maybeOpenStartupFile wraps openFileByPath ONLY. A throw
    // from activateDocument — which would indicate a programming bug, not an
    // expected I/O error — must surface to the caller.
    //
    // This used to arm on the SECOND call, because openFileByPath activated
    // the newly-opened doc through the same exported function. Since ADR-033
    // it activates through the registry's private primitive inside
    // `openDocumentWhenReady`, so the only call this spy ever sees is the one
    // in maybeOpenStartupFile — asserted below rather than assumed, because a
    // stale `>= 2` guard would simply never fire and the test would pass by
    // never throwing at all.
    const dir = await makeTmpDir();
    const filePath = path.join(dir, "valid.md");
    await fs.writeFile(filePath, "# valid\n");

    let callCount = 0;
    const realImpl = activateDocumentSpy.getMockImplementation();
    activateDocumentSpy.mockImplementation((_id: string | null) => {
      callCount += 1;
      throw new Error("simulated activateDocument bug");
    });

    try {
      await expect(maybeOpenStartupFile(filePath)).rejects.toThrow(
        "simulated activateDocument bug",
      );
    } finally {
      // Restore the default-passthrough impl so afterEach cleanup works.
      if (realImpl) activateDocumentSpy.mockImplementation(realImpl);
    }
    expect(callCount, "maybeOpenStartupFile activates exactly once").toBe(1);
  });
});
