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

// Hoisted so M1b/M2 can swap injectCommentsAsAnnotations / extractDocxComments
// implementations per-test without affecting other suites. The mock falls
// through to the real impl unless a test sets an explicit implementation.
const docxCommentsMocks = vi.hoisted(() => ({
  inject: vi.fn(),
  extract: vi.fn(),
}));
vi.mock("../../src/server/file-io/docx-comments", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/server/file-io/docx-comments")>();
  return {
    ...actual,
    injectCommentsAsAnnotations: (
      ...args: Parameters<typeof actual.injectCommentsAsAnnotations>
    ) => {
      const impl = docxCommentsMocks.inject.getMockImplementation();
      if (impl) return docxCommentsMocks.inject(...args);
      return actual.injectCommentsAsAnnotations(...args);
    },
    extractDocxComments: (...args: Parameters<typeof actual.extractDocxComments>) => {
      const impl = docxCommentsMocks.extract.getMockImplementation();
      if (impl) return docxCommentsMocks.extract(...args);
      return actual.extractDocxComments(...args);
    },
  };
});

// Mock pushNotification so M1b/M2 can assert on call shape. Pattern from
// tests/server/annotations/store.test.ts:17-22.
vi.mock("../../src/server/notifications.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/server/notifications.js")>();
  return { ...actual, pushNotification: vi.fn() };
});

import { docIdFromPath } from "../../src/server/mcp/document-model.js";
import { getOpenDocs, removeDoc, setActiveDocId } from "../../src/server/mcp/document-service.js";
import { openFileByPath } from "../../src/server/mcp/file-opener.js";
import { pushNotification } from "../../src/server/notifications.js";
import { getOrCreateDocument } from "../../src/server/yjs/provider.js";
import { Y_MAP_ANNOTATIONS } from "../../src/shared/constants.js";
import { INTERNAL_ORIGIN } from "../../src/shared/origins.js";
import { buildDocxWithComments } from "../helpers/docx-fixtures.js";

let tmpDir: string;

beforeEach(async () => {
  for (const id of [...getOpenDocs().keys()]) {
    removeDoc(id);
  }
  setActiveDocId(null);
  vi.clearAllMocks();
  // mockReset() drops implementations too — clearAllMocks only clears call
  // history, so without this M1b's inject impl could leak into M2.
  docxCommentsMocks.inject.mockReset();
  docxCommentsMocks.extract.mockReset();
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
    // finally), and once by the cleanup transact. Both must be INTERNAL_ORIGIN
    // post-ADR-031 (populate + cleanup-after-failure are both withInternal).
    const fragment = doc.getXmlFragment("default");
    const fragmentTouches = updates.filter((u) => u.changedTypes.has(fragment));
    expect(fragmentTouches.length).toBeGreaterThanOrEqual(2);
    for (const u of fragmentTouches) {
      expect(u.origin).toBe(INTERNAL_ORIGIN);
    }

    // Structured-log shape fired with the static-literal first arg.
    const cleanupLog = errCalls.find(
      (call) =>
        typeof call[0] === "string" && call[0].includes("populateDocFromContent: populate failed"),
    );
    expect(cleanupLog).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// M1b — injectCommentsAsAnnotations mid-throw partial-rollback contract.
// The PR's snapshot/undo dance is the most subtle code in the change: it
// records annotation keys before the inject call and deletes any new keys if
// the inject throws (Yjs does not roll back inner-transact writes). This test
// proves the dance works AND that the H1 notification fires.
// ---------------------------------------------------------------------------

describe("populateDocFromContent — injectCommentsAsAnnotations mid-throw", () => {
  it("undoes partial annotation writes, leaves HTML content, fires warning notification", async () => {
    // Mock inject to land a partial annotation BEFORE throwing. Without this
    // write the test would pass vacuously: an empty map stays empty whether
    // or not the production catch's snapshot/undo loop runs.
    docxCommentsMocks.inject.mockImplementation((doc: Y.Doc) => {
      const annot = doc.getMap(Y_MAP_ANNOTATIONS);
      annot.set("partial-write-marker", { id: "partial-write-marker" } as never);
      throw new Error("simulated inject failure after partial write");
    });

    const buffer = await buildDocxWithComments(1);
    const filePath = path.join(tmpDir, "inject-fail.docx");
    await fs.writeFile(filePath, buffer);

    const docId = docIdFromPath(filePath);
    const doc = getOrCreateDocument(docId);

    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    // The inner catch swallows the inject throw — populate succeeds.
    await expect(openFileByPath(filePath)).resolves.toBeDefined();

    errSpy.mockRestore();

    // Load-bearing: the partial key was actually written before the throw,
    // and the production catch's snapshot/before loop undid it.
    const annotations = doc.getMap(Y_MAP_ANNOTATIONS);
    expect(annotations.has("partial-write-marker")).toBe(false);
    expect(annotations.size).toBe(0);

    // HTML content still landed (htmlToYDoc ran before the inject call).
    expect(doc.getXmlFragment("default").length).toBeGreaterThan(0);

    // H1 notification fired with the right shape.
    const calls = vi.mocked(pushNotification).mock.calls;
    const injectFailureCalls = calls.filter(
      ([n]) => n.dedupKey === `docx-comments-inject:${filePath}`,
    );
    expect(injectFailureCalls).toHaveLength(1);
    const [n] = injectFailureCalls[0];
    expect(n.severity).toBe("warning");
    expect(n.type).toBe("annotation-error");
    expect(n.message).not.toContain("See server log"); // L3 trim verification
  });
});

// ---------------------------------------------------------------------------
// M2 — extractDocxComments failure notification path.
// The PR's extract-failure .catch returns an empty array and pushes a warning
// notification. Untested in the original PR.
// ---------------------------------------------------------------------------

describe("populateDocFromContent — extractDocxComments failure", () => {
  it("falls through to empty comments, fires warning notification, document still loads", async () => {
    docxCommentsMocks.extract.mockImplementation(async () => {
      throw new Error("simulated extract failure");
    });

    const buffer = await buildDocxWithComments(1);
    const filePath = path.join(tmpDir, "extract-fail.docx");
    await fs.writeFile(filePath, buffer);

    const docId = docIdFromPath(filePath);
    const doc = getOrCreateDocument(docId);

    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(openFileByPath(filePath)).resolves.toBeDefined();
    errSpy.mockRestore();

    // HTML content lands; no annotations.
    expect(doc.getXmlFragment("default").length).toBeGreaterThan(0);
    expect(doc.getMap(Y_MAP_ANNOTATIONS).size).toBe(0);

    const calls = vi.mocked(pushNotification).mock.calls;
    const extractFailureCalls = calls.filter(([n]) => n.dedupKey === `docx-comments:${filePath}`);
    expect(extractFailureCalls).toHaveLength(1);
    const [n] = extractFailureCalls[0];
    expect(n.severity).toBe("warning");
    expect(n.type).toBe("annotation-error");
    expect(n.message).not.toContain("See server log"); // L3 trim verification
  });
});
