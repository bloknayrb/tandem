import fs from "fs/promises";
import os from "os";
import path from "path";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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

// Build a stress-shape markdown that mirrors the document that triggered #609:
// many headings, nested lists, inline code spans, bold/italic runs.
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
  changedTypes: string[];
}

// Pre-subscribe to the Y.Doc that openFileByPath will reuse, so we capture every
// update event during the open. getOrCreateDocument returns the same instance
// the opener later picks up via the same docId.
async function captureUpdatesDuringOpen(filePath: string): Promise<UpdateRecord[]> {
  const docId = docIdFromPath(filePath);
  const doc = getOrCreateDocument(docId);
  const updates: UpdateRecord[] = [];
  const listener = (txn: { origin: unknown; changed: Map<unknown, Set<string | null>> }) => {
    const changedTypes: string[] = [];
    for (const type of txn.changed.keys()) {
      changedTypes.push((type as { constructor: { name: string } }).constructor.name);
    }
    updates.push({ origin: txn.origin, changedTypes });
  };
  doc.on("afterTransaction", listener);
  try {
    await openFileByPath(filePath);
  } finally {
    doc.off("afterTransaction", listener);
  }
  return updates;
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
// XmlFragment change during open must arrive in a single batched transaction,
// and every transaction during open must be MCP_ORIGIN.
// ---------------------------------------------------------------------------

function assertSingleBatchedPopulate(updates: UpdateRecord[]): void {
  const fragmentTouches = updates.filter((u) => u.changedTypes.includes("YXmlFragment"));
  expect(fragmentTouches.length).toBe(1);
  for (const u of fragmentTouches) {
    expect(u.origin).toBe(MCP_ORIGIN);
  }
  // Every transaction during open must be MCP_ORIGIN; an un-tagged transaction
  // would either be a missing-origin bug (Critical Rule #2) or the regression
  // pre-fix mdastToYDoc shape leaking back in.
  for (const u of updates) {
    expect(u.origin).toBe(MCP_ORIGIN);
  }
}

describe("loadContentIntoDoc — batching contract (#609)", () => {
  it("md: stress-shape fixture populates inside a single XmlFragment transaction", async () => {
    const filePath = path.join(tmpDir, "stress.md");
    // ~80 sections → thousands of inline inserts pre-fix.
    await fs.writeFile(filePath, buildStressMarkdown(80));

    const updates = await captureUpdatesDuringOpen(filePath);
    assertSingleBatchedPopulate(updates);
  });

  it("txt: populate is batched into one XmlFragment transaction", async () => {
    const filePath = path.join(tmpDir, "stress.txt");
    const lines = Array.from({ length: 500 }, (_, i) => `line ${i}: ${"lorem ".repeat(8)}`);
    await fs.writeFile(filePath, lines.join("\n"));

    const updates = await captureUpdatesDuringOpen(filePath);
    assertSingleBatchedPopulate(updates);
  });
});
