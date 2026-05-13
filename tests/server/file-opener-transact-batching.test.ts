import fs from "fs/promises";
import os from "os";
import path from "path";
import { fileURLToPath } from "url";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as Y from "yjs";

// Match the isolation pattern in file-opener-lifecycle.test.ts so this file
// does not collide with concurrent test files using the same app-data dir.
vi.mock("../../src/server/platform", async (importOriginal) => {
  const original = await importOriginal<typeof import("../../src/server/platform")>();
  const osMod = await import("os");
  const pathMod = await import("path");
  const cryptoMod = await import("crypto");
  const appDataDir = pathMod.join(osMod.tmpdir(), `tandem-test-transact-${cryptoMod.randomUUID()}`);
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

// Mocked so M1a can assert that the docx-with-comments success path does NOT
// fire either the extract-failure or the inject-failure notification. Pattern
// from tests/server/annotations/store.test.ts:17-22.
vi.mock("../../src/server/notifications.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/server/notifications.js")>();
  return { ...actual, pushNotification: vi.fn() };
});

// Mock node:crypto's randomUUID so the upload-path test can pre-compute the
// synthetic docId that openFileFromContent will mint, then pre-subscribe to
// the matching Y.Doc before invoking the opener. The mock falls through to
// the real implementation unless an explicit one-shot return is queued.
const cryptoMocks = vi.hoisted(() => ({ randomUUID: vi.fn() }));
vi.mock("node:crypto", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:crypto")>();
  return {
    ...actual,
    randomUUID: (...args: Parameters<typeof actual.randomUUID>) => {
      const next = cryptoMocks.randomUUID.getMockImplementation();
      if (next) return cryptoMocks.randomUUID(...args);
      return actual.randomUUID(...args);
    },
  };
});

import { MCP_ORIGIN } from "../../src/server/events/queue.js";
import { docIdFromPath } from "../../src/server/mcp/document-model.js";
import { getOpenDocs, removeDoc, setActiveDocId } from "../../src/server/mcp/document-service.js";
import { openFileByPath, openFileFromContent } from "../../src/server/mcp/file-opener.js";
import { pushNotification } from "../../src/server/notifications.js";
import { getOrCreateDocument } from "../../src/server/yjs/provider.js";
import { Y_MAP_ANNOTATIONS } from "../../src/shared/constants.js";
import { UPLOAD_PREFIX } from "../../src/shared/paths.js";
import { buildDocxWithComments } from "../helpers/docx-fixtures.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DOCX_FIXTURE = path.resolve(__dirname, "../e2e/fixtures/single-paragraph.docx");

let tmpDir: string;

beforeEach(async () => {
  for (const id of [...getOpenDocs().keys()]) {
    removeDoc(id);
  }
  setActiveDocId(null);
  vi.clearAllMocks();
  cryptoMocks.randomUUID.mockReset();
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "tandem-transact-"));
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
});

afterAll(async () => {
  const appDataDir = process.env.TANDEM_APP_DATA_DIR;
  if (appDataDir) await fs.rm(appDataDir, { recursive: true, force: true }).catch(() => {});
  delete process.env.TANDEM_APP_DATA_DIR;
});

// Build a stress-shape markdown: many headings, nested lists, inline code,
// bold/italic — mirrors the document that surfaced the pre-batching freeze.
function buildStressMarkdown(sectionCount: number): string {
  const sections: string[] = ["# Stress fixture", ""];
  for (let i = 0; i < sectionCount; i++) {
    sections.push(
      `## Section ${i}`,
      "",
      `Paragraph with **bold**, *italic*, and \`inline code\` plus a [link](https://example.test).`,
      "",
      `- Bullet one with \`code\` and **emphasis**.`,
      `- Bullet two referencing \`section-${i}\`.`,
      `  - Nested bullet with *italic*.`,
      "",
      "```ts",
      `const value${i} = "fenced code block ${i}";`,
      "```",
      "",
    );
  }
  return sections.join("\n");
}

interface UpdateRecord {
  origin: unknown;
  // Captures the type *instance refs* from txn.changed.keys() so callers can
  // identity-test against a specific Y.AbstractType (e.g. the doc's
  // XmlFragment) rather than name-comparing (which can't distinguish YMap
  // variants ANNOTATIONS/REPLIES/AWARENESS — all have constructor.name "YMap").
  changedTypes: Set<Y.AbstractType<unknown>>;
}

function listenForUpdates(doc: Y.Doc): { updates: UpdateRecord[]; detach: () => void } {
  const updates: UpdateRecord[] = [];
  const listener = (txn: {
    origin: unknown;
    changed: Map<Y.AbstractType<unknown>, Set<string | null>>;
  }) => {
    updates.push({ origin: txn.origin, changedTypes: new Set(txn.changed.keys()) });
  };
  doc.on("afterTransaction", listener);
  return { updates, detach: () => doc.off("afterTransaction", listener) };
}

// Pre-subscribe to the Y.Doc that openFileByPath will reuse, so we capture every
// update event during the open. getOrCreateDocument returns the same instance
// the opener later picks up via the same docId.
async function captureUpdatesDuringOpen(
  filePath: string,
): Promise<{ updates: UpdateRecord[]; doc: Y.Doc }> {
  const docId = docIdFromPath(filePath);
  const doc = getOrCreateDocument(docId);
  const { updates, detach } = listenForUpdates(doc);
  try {
    await openFileByPath(filePath);
  } finally {
    detach();
  }
  return { updates, doc };
}

// Same as above for the upload path. Pre-stubs randomUUID so we can pre-resolve
// the synthetic docId that openFileFromContent will mint.
async function captureUpdatesDuringOpenFromContent(
  fileName: string,
  content: string | Buffer,
): Promise<{ updates: UpdateRecord[]; doc: Y.Doc }> {
  const uuid = "test-uuid-batching";
  cryptoMocks.randomUUID.mockImplementation(() => uuid);
  const syntheticPath = `${UPLOAD_PREFIX}${uuid}/${fileName}`;
  const docId = docIdFromPath(syntheticPath);
  const doc = getOrCreateDocument(docId);
  const { updates, detach } = listenForUpdates(doc);
  try {
    await openFileFromContent(fileName, content);
  } finally {
    detach();
  }
  return { updates, doc };
}

// ---------------------------------------------------------------------------
// #609 contract: doc-content population must run inside a single MCP_ORIGIN
// transaction. Pre-fix, mdastToYDoc fired one Yjs update per fragment.insert /
// xmlText.insert — for the ~4500-token revision-request doc that meant
// thousands of tiny updates flooding y-prosemirror and freezing the client.
//
// Asserting on total transaction count would couple this test to unrelated
// finalizeDocOpen steps (writeDocMeta, initSavedBaseline, broadcastOpenDocs all
// transact too). Instead we assert on the *content-touching* contract: every
// XmlFragment change during open must arrive in a single batched transaction
// tagged MCP_ORIGIN. Applies to the success path only — the cleanup-on-failure
// path legitimately produces two XmlFragment touches (failed-populate flush +
// cleanup), so use the per-update origin loop instead.
// ---------------------------------------------------------------------------

function assertSingleBatchedPopulate(doc: Y.Doc, updates: UpdateRecord[]): void {
  const fragment = doc.getXmlFragment("default");
  const fragmentTouches = updates.filter((u) => u.changedTypes.has(fragment));
  expect(fragmentTouches.length).toBe(1);
  for (const u of fragmentTouches) {
    expect(u.origin).toBe(MCP_ORIGIN);
  }
}

describe("loadContentIntoDoc — batching contract (#609)", () => {
  it("md: stress-shape fixture populates inside a single XmlFragment transaction", async () => {
    const filePath = path.join(tmpDir, "stress.md");
    // ~80 sections → thousands of inline inserts pre-fix.
    await fs.writeFile(filePath, buildStressMarkdown(80));

    const { updates, doc } = await captureUpdatesDuringOpen(filePath);
    assertSingleBatchedPopulate(doc, updates);
  });

  it("txt: populate is batched into one XmlFragment transaction", async () => {
    const filePath = path.join(tmpDir, "stress.txt");
    const lines = Array.from({ length: 500 }, (_, i) => `line ${i}: ${"lorem ".repeat(8)}`);
    await fs.writeFile(filePath, lines.join("\n"));

    const { updates, doc } = await captureUpdatesDuringOpen(filePath);
    assertSingleBatchedPopulate(doc, updates);
  });

  it("docx: populate is batched into one XmlFragment transaction", async () => {
    // Use the e2e docx fixture (no embedded comments). Exercises the docx
    // structural branch (loadDocx + htmlToYDoc) rather than the markdown
    // branch — guards against a refactor that hoists htmlToYDoc out of the
    // shared transact closure.
    const buffer = await fs.readFile(DOCX_FIXTURE);
    const filePath = path.join(tmpDir, "single-paragraph.docx");
    await fs.writeFile(filePath, buffer);

    const { updates, doc } = await captureUpdatesDuringOpen(filePath);
    assertSingleBatchedPopulate(doc, updates);
  });

  // M1a — Docx-with-comments success path. The PR's batching test only used a
  // comment-free fixture, so injectCommentsAsAnnotations' inner-transact flatten
  // had no regression coverage. This test proves comments actually land as
  // annotations, the inner transact flattens into the outer (annotations land
  // in the SAME transaction as the fragment), and the success path emits no
  // notifications.
  it("docx-with-comments: annotations land in the SAME flattened populate transact", async () => {
    const buffer = await buildDocxWithComments(3);
    const filePath = path.join(tmpDir, "with-comments.docx");
    await fs.writeFile(filePath, buffer);

    const { updates, doc } = await captureUpdatesDuringOpen(filePath);

    assertSingleBatchedPopulate(doc, updates);

    const fragment = doc.getXmlFragment("default");
    const annotations = doc.getMap(Y_MAP_ANNOTATIONS);
    const fragmentTouch = updates.find((u) => u.changedTypes.has(fragment));
    expect(fragmentTouch).toBeDefined();
    // Inner-transact flatten: the same transaction that touched the fragment
    // also touched the annotations map. A refactor that hoisted
    // injectCommentsAsAnnotations OUT of the outer transact (or that no-op'd
    // it) would fail this assertion.
    expect(fragmentTouch?.changedTypes.has(annotations)).toBe(true);

    // 3 comments actually landed as annotations.
    expect(annotations.size).toBe(3);

    // Success path: no notifications.
    expect(pushNotification).not.toHaveBeenCalled();
  });
});

describe("openFileFromContent — batching contract (#609)", () => {
  it("md upload: populate is batched into one XmlFragment transaction", async () => {
    const content = buildStressMarkdown(80);
    const { updates, doc } = await captureUpdatesDuringOpenFromContent("stress.md", content);
    assertSingleBatchedPopulate(doc, updates);
  });

  it("docx upload: populate is batched into one XmlFragment transaction", async () => {
    const buffer = await fs.readFile(DOCX_FIXTURE);
    const { updates, doc } = await captureUpdatesDuringOpenFromContent(
      "single-paragraph.docx",
      buffer,
    );
    assertSingleBatchedPopulate(doc, updates);
  });
});
