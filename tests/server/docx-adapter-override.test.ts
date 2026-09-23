/**
 * Proves `tests/helpers/docx-adapter-override.ts` reaches each real open path.
 *
 * The helper is only worth having if an overridden adapter is what those paths
 * actually call. A `vi.mock` that silently missed one (say, a module that
 * imported `getAdapter` through another route) would let a later test "pass"
 * against the production adapter while believing it drove another. So each row
 * opens a real `.docx` on disk through one path and asserts the COUNTING adapter
 * ran. The last row installs an adapter whose parse throws, so the open fails
 * only if the override is live, and then clears the hook and opens cleanly.
 *
 * A process restart is not covered here: it re-opens through `openFromDisk`,
 * which the rows below reach, but with a fresh module graph this file cannot
 * build.
 */

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DocxAdapterHook } from "../helpers/docx-adapter-override.js";

const docxHook = vi.hoisted((): DocxAdapterHook => ({ adapter: undefined }));
vi.mock(import("../../src/server/file-io/index.js"), async (importOriginal) =>
  (await import("../helpers/docx-adapter-override.js")).mockFileIoWithDocxOverride(
    await importOriginal(),
    docxHook,
  ),
);

vi.mock(import("../../src/server/notifications.js"), async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/server/notifications.js")>()),
  pushNotification: vi.fn(),
}));

vi.mock(import("../../src/server/file-watcher"), async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/server/file-watcher")>()),
  watchFile: vi.fn(),
}));

import { resetForTesting } from "../../src/server/annotations/store.js";
import { openFromDisk, openFromRestore } from "../../src/server/documents/open.js";
import { removeDoc, setActiveDocId } from "../../src/server/documents/registry-testing.js";
import { reloadFromDisk } from "../../src/server/documents/watcher.js";
import { type FormatAdapter, getAdapter } from "../../src/server/file-io/index.js";
import { docIdFromPath } from "../../src/server/mcp/document-model.js";
import { getOpenDocs } from "../../src/server/mcp/document-service.js";
import { stopAutoSave } from "../../src/server/session/manager.js";
import { useTmpAnnotationsEnvWithFlag } from "../helpers/annotation-store-env.js";
import { buildDocxWithComments } from "../helpers/docx-fixtures.js";

useTmpAnnotationsEnvWithFlag("tandem-docx-override-");

/** Wraps the production adapter and counts calls, so reach is observable. */
function countingAdapter(): { adapter: FormatAdapter; calls: { parse: number; apply: number } } {
  // Resolved with the hook cleared, so this is the real production adapter.
  const real = getAdapter("docx");
  const calls = { parse: 0, apply: 0 };
  const adapter: FormatAdapter = {
    ...real,
    async parse(content) {
      calls.parse++;
      return real.parse(content);
    },
    apply(doc, prepared, ctx) {
      calls.apply++;
      return real.apply(doc, prepared, ctx);
    },
  };
  return { adapter, calls };
}

let tmpDir: string;

beforeEach(async () => {
  resetForTesting();
  docxHook.adapter = undefined;
  for (const id of [...getOpenDocs().keys()]) removeDoc(id);
  setActiveDocId(null);
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "tandem-docx-override-doc-"));
});

afterEach(async () => {
  docxHook.adapter = undefined;
  stopAutoSave();
  for (const id of [...getOpenDocs().keys()]) removeDoc(id);
  await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
});

async function writeFixture(): Promise<string> {
  const filePath = path.join(tmpDir, "fixture.docx");
  await fs.writeFile(filePath, await buildDocxWithComments(2));
  return filePath;
}

describe("the .docx adapter override reaches each real open path", () => {
  it("cold open (openFromDisk)", async () => {
    const filePath = await writeFixture();
    const { adapter, calls } = countingAdapter();
    docxHook.adapter = adapter;
    await openFromDisk(filePath);
    expect(calls).toEqual({ parse: 1, apply: 1 });
  });

  it("force-open (openFromDisk with force: true)", async () => {
    const filePath = await writeFixture();
    await openFromDisk(filePath);
    const { adapter, calls } = countingAdapter();
    docxHook.adapter = adapter;
    await openFromDisk(filePath, { force: true });
    expect(calls).toEqual({ parse: 1, apply: 1 });
  });

  it("reopen after the document leaves the registry", async () => {
    const filePath = await writeFixture();
    await openFromDisk(filePath);
    removeDoc(docIdFromPath(filePath));
    const { adapter, calls } = countingAdapter();
    docxHook.adapter = adapter;
    await openFromDisk(filePath);
    expect(calls).toEqual({ parse: 1, apply: 1 });
  });

  it("watcher reload (reloadFromDisk)", async () => {
    const filePath = await writeFixture();
    await openFromDisk(filePath);
    const { adapter, calls } = countingAdapter();
    docxHook.adapter = adapter;
    const reloaded = await reloadFromDisk(docIdFromPath(filePath), filePath, "docx");
    expect(reloaded).toBe(true);
    expect(calls).toEqual({ parse: 1, apply: 1 });
  });

  it("session restore (openFromRestore)", async () => {
    const filePath = await writeFixture();
    const { adapter, calls } = countingAdapter();
    docxHook.adapter = adapter;
    await openFromRestore({ filePath, readOnly: false });
    expect(calls).toEqual({ parse: 1, apply: 1 });
  });

  it("an installed adapter decides the open, and clearing the hook restores production", async () => {
    const filePath = await writeFixture();
    docxHook.adapter = {
      ...getAdapter("docx"),
      async parse() {
        throw new Error("override adapter reached");
      },
    };
    await expect(openFromDisk(filePath)).rejects.toThrow("override adapter reached");
    docxHook.adapter = undefined;
    await openFromDisk(filePath);
    expect(getOpenDocs().has(docIdFromPath(filePath))).toBe(true);
  });
});
