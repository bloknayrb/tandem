import fs from "fs/promises";
import os from "os";
import path from "path";
import { afterEach, describe, expect, it } from "vitest";
import { removeDoc } from "../../src/server/documents/registry-testing.js";
import {
  getActiveDocEpoch,
  getActiveDocId,
  getOpenDocs,
} from "../../src/server/mcp/document-service.js";
import { maybeOpenStartupFile } from "../../src/server/startup-file.js";
import { getOrCreateDocument, removeDocument } from "../../src/server/yjs/provider.js";
import {
  CTRL_ROOM,
  Y_MAP_ACTIVE_DOCUMENT_ID,
  Y_MAP_DOCUMENT_META,
} from "../../src/shared/constants.js";

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

    // …and PUBLISHES it. `maybeOpenStartupFile` does not activate at all now
    // (ADR-033) — `openFileByPath` already did, in the same broadcast that
    // registered the doc. So this is the assertion that would catch the open
    // path quietly dropping its activation: module state alone cannot, because
    // `getActiveDocId()` above reads the half that was already right before
    // any of this and would agree either way.
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

  it("advances the activation epoch exactly once for one startup gesture", async () => {
    // `maybeOpenStartupFile` used to re-activate the document `openFileByPath`
    // had just activated. Harmless-looking, and it was there before ADR-033 —
    // but the client reads an epoch advance as an intentional focus event, so
    // one startup gesture publishing two is the exact double-advance the
    // registry's composite surface exists to make unrepresentable.
    //
    // Pinned as a delta rather than an absolute, because the epoch is
    // module-global and every earlier test in this file has already moved it.
    const dir = await makeTmpDir();
    const filePath = path.join(dir, "one-gesture.md");
    await fs.writeFile(filePath, "# one gesture\n");

    const before = getActiveDocEpoch();
    const ok = await maybeOpenStartupFile(filePath);

    // Control: an open that failed would advance nothing and pass the delta
    // check below by doing nothing at all.
    expect(ok, "control: the open actually succeeded").toBe(true);
    expect(getActiveDocEpoch() - before, "one gesture, one focus event").toBe(1);
  });
});
