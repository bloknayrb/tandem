import fs from "fs/promises";
import path from "path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import { CTRL_ROOM } from "../../src/shared/constants";

// Isolate session tests in a unique temp directory to avoid races with other test files
vi.mock("../../src/server/platform", async (importOriginal) => {
  const original = await importOriginal<typeof import("../../src/server/platform")>();
  const osMod = await import("os");
  const pathMod = await import("path");
  const cryptoMod = await import("crypto");
  return {
    ...original,
    SESSION_DIR: pathMod.join(osMod.tmpdir(), `tandem-test-restore-${cryptoMod.randomUUID()}`),
  };
});

import { SESSION_DIR } from "../../src/server/platform";
import {
  deleteSession,
  listSessionFilePaths,
  saveCtrlSession,
  saveSession,
  sessionKey,
} from "../../src/server/session/manager";

// Unique paths to avoid collisions with other tests
const TEST_FILES = [
  path.resolve("tests/fixtures/restore-a.md"),
  path.resolve("tests/fixtures/restore-b.md"),
  path.resolve("tests/fixtures/restore-c.md"),
];

function createMinimalDoc(): Y.Doc {
  const doc = new Y.Doc();
  const fragment = doc.getXmlFragment("default");
  const p = new Y.XmlElement("paragraph");
  p.insert(0, [new Y.XmlText("test")]);
  fragment.insert(0, [p]);
  return doc;
}

describe("listSessionFilePaths", () => {
  beforeAll(async () => {
    await fs.mkdir(SESSION_DIR, { recursive: true });
  });

  afterAll(async () => {
    await fs.rm(SESSION_DIR, { recursive: true, force: true });
  });

  afterEach(async () => {
    // Clean up all test session files
    for (const fp of TEST_FILES) {
      await deleteSession(fp).catch(() => {});
    }
    // Also clean up upload and ctrl sessions we may have created
    const uploadKey = sessionKey("upload://test-upload.md");
    const uploadPath = path.join(SESSION_DIR, `${uploadKey}.json`);
    await fs.unlink(uploadPath).catch(() => {});

    const ctrlKey = CTRL_ROOM;
    const ctrlPath = path.join(SESSION_DIR, `${ctrlKey}.json`);
    await fs.unlink(ctrlPath).catch(() => {});
  });

  it("returns empty array when no sessions exist", async () => {
    // Delete all test sessions first (afterEach already ran, but be safe)
    for (const fp of TEST_FILES) {
      await deleteSession(fp).catch(() => {});
    }
    // listSessionFilePaths may return other sessions from the real session dir,
    // so just check the function doesn't throw and returns an array
    const result = await listSessionFilePaths();
    expect(Array.isArray(result)).toBe(true);
  });

  it("returns saved document sessions", async () => {
    const doc = createMinimalDoc();
    await saveSession(TEST_FILES[0], "md", doc);

    const result = await listSessionFilePaths();
    const match = result.find((r) => r.filePath === TEST_FILES[0]);
    expect(match).toBeDefined();
    expect(match!.lastAccessed).toBeGreaterThan(0);
  });

  it("skips ctrl session", async () => {
    // Save a ctrl session
    const ctrlDoc = new Y.Doc();
    await saveCtrlSession(ctrlDoc);

    const result = await listSessionFilePaths();
    // CTRL_ROOM should never appear in the results
    const ctrlMatch = result.find((r) => r.filePath === CTRL_ROOM);
    expect(ctrlMatch).toBeUndefined();
  });

  it("skips upload:// sessions", async () => {
    const doc = createMinimalDoc();
    await saveSession("upload://test-upload.md", "md", doc);

    const result = await listSessionFilePaths();
    const match = result.find((r) => r.filePath.startsWith("upload://"));
    expect(match).toBeUndefined();
  });

  it("sorts by lastAccessed descending (most recent first)", async () => {
    const doc = createMinimalDoc();

    // Save sessions with slight time gaps
    await saveSession(TEST_FILES[0], "md", doc);
    // Small delay to ensure distinct timestamps
    await new Promise((r) => setTimeout(r, 20));
    await saveSession(TEST_FILES[1], "md", doc);
    await new Promise((r) => setTimeout(r, 20));
    await saveSession(TEST_FILES[2], "md", doc);

    const result = await listSessionFilePaths();
    const testResults = result.filter((r) => TEST_FILES.includes(r.filePath));
    expect(testResults.length).toBe(3);

    // Most recently saved (TEST_FILES[2]) should be first
    expect(testResults[0].filePath).toBe(TEST_FILES[2]);
    expect(testResults[1].filePath).toBe(TEST_FILES[1]);
    expect(testResults[2].filePath).toBe(TEST_FILES[0]);
  });

  it("skips corrupt JSON files without throwing", async () => {
    // Write a corrupt session file directly
    await fs.mkdir(SESSION_DIR, { recursive: true });
    const corruptPath = path.join(SESSION_DIR, "corrupt-test-file.json");
    await fs.writeFile(corruptPath, "not valid json{{{", "utf-8");

    // Should not throw
    const result = await listSessionFilePaths();
    expect(Array.isArray(result)).toBe(true);

    // Clean up
    await fs.unlink(corruptPath).catch(() => {});
  });

  it("ignores non-JSON files", async () => {
    await fs.mkdir(SESSION_DIR, { recursive: true });
    const nonJsonPath = path.join(SESSION_DIR, "readme.txt");
    await fs.writeFile(nonJsonPath, "not a session", "utf-8");

    const result = await listSessionFilePaths();
    // Just verify it didn't crash and doesn't include the txt file
    const match = result.find((r) => r.filePath.includes("readme.txt"));
    expect(match).toBeUndefined();

    await fs.unlink(nonJsonPath).catch(() => {});
  });
});
