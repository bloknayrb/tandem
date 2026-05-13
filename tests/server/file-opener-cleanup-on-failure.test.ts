import fs from "fs/promises";
import os from "os";
import path from "path";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as Y from "yjs";

// Isolated app-data dir, mirroring file-opener-transact-batching.test.ts.
vi.mock("../../src/server/platform", async (importOriginal) => {
  const original = await importOriginal<typeof import("../../src/server/platform")>();
  const osMod = await import("os");
  const pathMod = await import("path");
  const cryptoMod = await import("crypto");
  const appDataDir = pathMod.join(osMod.tmpdir(), `tandem-test-cleanup-${cryptoMod.randomUUID()}`);
  process.env.TANDEM_APP_DATA_DIR = appDataDir;
  return {
    ...original,
    SESSION_DIR: pathMod.join(appDataDir, "sessions"),
  };
});

vi.mock("../../src/server/file-watcher", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/server/file-watcher")>()),
  watchFile: vi.fn(),
}));

// Mock loadMarkdown to land some content into the fragment, THEN throw. This
// exercises the catch-block cleanup path: without the cleanup transact, the
// partial XmlText would persist in the Hocuspocus-cached Y.Doc and a retry
// would inherit poisoned state. With the cleanup, the fragment ends empty.
//
// The factory imports yjs dynamically so the mock body can build a Y.XmlText
// at call time (vi.mock factories run at module-init before regular imports).
const PARTIAL_WRITE_MARKER = "partial-write-before-throw";
vi.mock("../../src/server/file-io/markdown", async () => {
  const Y_runtime = await import("yjs");
  return {
    loadMarkdown: vi.fn((doc: import("yjs").Doc) => {
      const fragment = doc.getXmlFragment("default");
      const xmlText = new Y_runtime.XmlText();
      fragment.push([xmlText]);
      xmlText.insert(0, PARTIAL_WRITE_MARKER);
      throw new Error("simulated populate failure after partial write");
    }),
  };
});

import { MCP_ORIGIN } from "../../src/server/events/queue.js";
import { docIdFromPath } from "../../src/server/mcp/document-model.js";
import { getOpenDocs, removeDoc, setActiveDocId } from "../../src/server/mcp/document-service.js";
import { openFileByPath } from "../../src/server/mcp/file-opener.js";
import { getOrCreateDocument } from "../../src/server/yjs/provider.js";

let tmpDir: string;

beforeEach(async () => {
  for (const id of [...getOpenDocs().keys()]) {
    removeDoc(id);
  }
  setActiveDocId(null);
  vi.clearAllMocks();
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "tandem-cleanup-"));
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
});

afterAll(async () => {
  const appDataDir = process.env.TANDEM_APP_DATA_DIR;
  if (appDataDir) await fs.rm(appDataDir, { recursive: true, force: true }).catch(() => {});
  delete process.env.TANDEM_APP_DATA_DIR;
});

interface UpdateRecord {
  origin: unknown;
  changedTypes: Set<Y.AbstractType<unknown>>;
}

describe("populateDocFromContent — cleanup on populate failure", () => {
  it("clears partial fragment content and rethrows the original error", async () => {
    const filePath = path.join(tmpDir, "doomed.md");
    await fs.writeFile(filePath, "# Header\n\nthis content never lands because the mock throws");

    // Pre-subscribe to the Y.Doc the opener will reuse.
    const docId = docIdFromPath(filePath);
    const doc = getOrCreateDocument(docId);
    const updates: UpdateRecord[] = [];
    const listener = (txn: {
      origin: unknown;
      changed: Map<Y.AbstractType<unknown>, Set<string | null>>;
    }) => {
      updates.push({ origin: txn.origin, changedTypes: new Set(txn.changed.keys()) });
    };
    doc.on("afterTransaction", listener);

    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    await expect(openFileByPath(filePath)).rejects.toThrow(
      "simulated populate failure after partial write",
    );

    doc.off("afterTransaction", listener);
    const errCalls = [...errSpy.mock.calls];
    errSpy.mockRestore();

    // Cleanup ran: partial XmlText was deleted from the fragment.
    expect(doc.getXmlFragment("default").length).toBe(0);

    // The fragment was touched at least twice: once when the partial write
    // landed (Yjs flushes via afterTransaction in the failed transact's
    // finally), and once by the cleanup transact. Both must be MCP_ORIGIN
    // (Critical Rule #2 across the failure path).
    const fragment = doc.getXmlFragment("default");
    const fragmentTouches = updates.filter((u) => u.changedTypes.has(fragment));
    expect(fragmentTouches.length).toBeGreaterThanOrEqual(2);
    for (const u of fragmentTouches) {
      expect(u.origin).toBe(MCP_ORIGIN);
    }

    // Structured-log shape fired with the static-literal first arg.
    const cleanupLog = errCalls.find(
      (call) =>
        typeof call[0] === "string" && call[0].includes("populateDocFromContent: populate failed"),
    );
    expect(cleanupLog).toBeDefined();
  });
});
