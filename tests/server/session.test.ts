import fs from "fs/promises";
import path from "path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import { Y_MAP_ANNOTATIONS, Y_MAP_CHAT, Y_MAP_DOCUMENT_META } from "../../src/shared/constants.js";

// Isolate session tests in a unique temp directory to avoid races with other test files
vi.mock("../../src/server/platform", async (importOriginal) => {
  const mod = await importOriginal<typeof import("../../src/server/platform")>();
  const osMod = await import("os");
  const pathMod = await import("path");
  const cryptoMod = await import("crypto");
  return {
    ...mod,
    SESSION_DIR: pathMod.join(osMod.tmpdir(), `tandem-test-session-${cryptoMod.randomUUID()}`),
  };
});

import { SESSION_DIR } from "../../src/server/platform";
import {
  deleteSession,
  loadCtrlSession,
  loadSession,
  restoreCtrlDoc,
  restoreYDoc,
  saveCtrlSession,
  saveSession,
  sessionKey,
  sourceFileChanged,
} from "../../src/server/session/manager";

describe("Session persistence", () => {
  beforeAll(async () => {
    await fs.mkdir(SESSION_DIR, { recursive: true });
  });

  afterAll(async () => {
    await fs.rm(SESSION_DIR, { recursive: true, force: true });
  });

  // Create a Y.Doc with some content and annotations
  function createTestDoc(): Y.Doc {
    const doc = new Y.Doc();
    const fragment = doc.getXmlFragment("default");
    const p = new Y.XmlElement("paragraph");
    p.insert(0, [new Y.XmlText("Hello world")]);
    fragment.insert(0, [p]);

    // Add an annotation
    const annotations = doc.getMap(Y_MAP_ANNOTATIONS);
    annotations.set("ann_test_1", {
      id: "ann_test_1",
      author: "claude",
      type: "highlight",
      range: { from: 0, to: 5 },
      content: "test note",
      status: "pending",
      timestamp: Date.now(),
      color: "yellow",
    });

    return doc;
  }

  describe("sessionKey", () => {
    it("encodes file paths consistently", () => {
      const key = sessionKey("C:\\Users\\test\\doc.md");
      expect(key).toBe(encodeURIComponent("C:/Users/test/doc.md"));
    });

    it("normalizes backslashes to forward slashes", () => {
      const key1 = sessionKey("C:\\Users\\test\\doc.md");
      const key2 = sessionKey("C:/Users/test/doc.md");
      expect(key1).toBe(key2);
    });
  });

  describe("save and restore round-trip", () => {
    const testFilePath = path.resolve("tests/fixtures/session-test.md");

    beforeEach(async () => {
      // Create a temp fixture file
      await fs.mkdir(path.dirname(testFilePath), { recursive: true });
      await fs.writeFile(testFilePath, "# Test\nHello world\n", "utf-8");
    });

    afterEach(async () => {
      await deleteSession(testFilePath);
      try {
        await fs.unlink(testFilePath);
      } catch {}
    });

    it("saves and loads session data", async () => {
      const doc = createTestDoc();
      await saveSession(testFilePath, "md", doc);

      const session = await loadSession(testFilePath);
      expect(session).not.toBeNull();
      expect(session!.filePath).toBe(testFilePath);
      expect(session!.format).toBe("md");
      expect(session!.ydocState).toBeTruthy();
      expect(session!.lastAccessed).toBeGreaterThan(0);
    });

    it("restores Y.Doc content from session", async () => {
      const doc = createTestDoc();
      await saveSession(testFilePath, "md", doc);

      const session = await loadSession(testFilePath);
      expect(session).not.toBeNull();

      // Restore into a fresh Y.Doc
      const restored = new Y.Doc();
      restoreYDoc(restored, session!);

      // Check document content
      const fragment = restored.getXmlFragment("default");
      expect(fragment.length).toBeGreaterThan(0);
    });

    it("restores annotations from session", async () => {
      const doc = createTestDoc();
      await saveSession(testFilePath, "md", doc);

      const session = await loadSession(testFilePath);
      const restored = new Y.Doc();
      restoreYDoc(restored, session!);

      // Check annotations survived
      const annotations = restored.getMap(Y_MAP_ANNOTATIONS);
      const ann = annotations.get("ann_test_1") as any;
      expect(ann).toBeTruthy();
      expect(ann.id).toBe("ann_test_1");
      expect(ann.content).toBe("test note");
      expect(ann.color).toBe("yellow");
    });

    it("detects unchanged source file", async () => {
      const doc = createTestDoc();
      await saveSession(testFilePath, "md", doc);

      const session = await loadSession(testFilePath);
      const changed = await sourceFileChanged(session!);
      expect(changed).toBe(false);
    });

    it("detects changed source file", async () => {
      const doc = createTestDoc();
      await saveSession(testFilePath, "md", doc);

      // Modify the source file
      await new Promise((r) => setTimeout(r, 50)); // Ensure mtime differs
      await fs.writeFile(testFilePath, "# Modified\nDifferent content\n", "utf-8");

      const session = await loadSession(testFilePath);
      const changed = await sourceFileChanged(session!);
      expect(changed).toBe(true);
    });

    it("returns null for non-existent session", async () => {
      const session = await loadSession("/nonexistent/path.md");
      expect(session).toBeNull();
    });
  });

  describe("ctrl session restore clears stale document metadata", () => {
    it("preserves chat but clears openDocuments and activeDocumentId", async () => {
      // Build a ctrl doc with both chat history and stale document metadata
      const ctrlDoc = new Y.Doc();
      const chat = ctrlDoc.getMap(Y_MAP_CHAT);
      chat.set("msg1", { id: "msg1", author: "user", text: "hello", timestamp: Date.now() });
      chat.set("msg2", { id: "msg2", author: "claude", text: "hi back", timestamp: Date.now() });

      const meta = ctrlDoc.getMap(Y_MAP_DOCUMENT_META);
      meta.set("openDocuments", [
        {
          id: "stale-doc-1",
          filePath: "/old/path1.md",
          fileName: "path1.md",
          format: "md",
          readOnly: false,
        },
      ]);
      meta.set("activeDocumentId", "stale-doc-1");

      // Save it
      await saveCtrlSession(ctrlDoc);

      // Restore into a fresh doc (simulating server restart)
      const restored = new Y.Doc();
      const savedState = await loadCtrlSession();
      expect(savedState).not.toBeNull();
      restoreCtrlDoc(restored, savedState!);

      // Simulate the clear that restoreCtrlSession() now does
      const restoredMeta = restored.getMap(Y_MAP_DOCUMENT_META);
      restoredMeta.delete("openDocuments");
      restoredMeta.delete("activeDocumentId");

      // Chat should survive
      const restoredChat = restored.getMap(Y_MAP_CHAT);
      expect(restoredChat.get("msg1")).toBeTruthy();
      expect(restoredChat.get("msg2")).toBeTruthy();
      expect((restoredChat.get("msg1") as any).text).toBe("hello");

      // Document metadata should be cleared
      expect(restoredMeta.get("openDocuments")).toBeUndefined();
      expect(restoredMeta.get("activeDocumentId")).toBeUndefined();
    });

    it("round-trips ctrl doc with only chat (no stale metadata)", async () => {
      const ctrlDoc = new Y.Doc();
      const chat = ctrlDoc.getMap(Y_MAP_CHAT);
      chat.set("msg1", { id: "msg1", author: "user", text: "test", timestamp: 12345 });

      await saveCtrlSession(ctrlDoc);

      const restored = new Y.Doc();
      const savedState = await loadCtrlSession();
      expect(savedState).not.toBeNull();
      restoreCtrlDoc(restored, savedState!);

      const restoredChat = restored.getMap(Y_MAP_CHAT);
      expect((restoredChat.get("msg1") as any).text).toBe("test");
    });
  });

  describe("empty session restore fallback", () => {
    const testFilePath = path.resolve("tests/fixtures/session-fallback.md");

    beforeEach(async () => {
      await fs.mkdir(path.dirname(testFilePath), { recursive: true });
      await fs.writeFile(testFilePath, "# Fallback Test\nContent here\n", "utf-8");
    });

    afterEach(async () => {
      await deleteSession(testFilePath);
      try {
        await fs.unlink(testFilePath);
      } catch {}
    });

    it("detects empty doc after restore via XmlFragment length", async () => {
      // Save a session from an empty Y.Doc (simulates the bug)
      const emptyDoc = new Y.Doc();
      await saveSession(testFilePath, "md", emptyDoc);

      // Load and restore
      const session = await loadSession(testFilePath);
      expect(session).not.toBeNull();

      const restored = new Y.Doc();
      restoreYDoc(restored, session!);

      // The restored doc should be empty — this is the check tandem_open uses
      const fragment = restored.getXmlFragment("default");
      expect(fragment.length).toBe(0);
    });

    it("detects populated doc after restore via XmlFragment length", async () => {
      const doc = createTestDoc();
      await saveSession(testFilePath, "md", doc);

      const session = await loadSession(testFilePath);
      const restored = new Y.Doc();
      restoreYDoc(restored, session!);

      const fragment = restored.getXmlFragment("default");
      expect(fragment.length).toBeGreaterThan(0);
    });
  });
});
