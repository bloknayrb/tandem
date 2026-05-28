/**
 * MCP tool handler integration test.
 *
 * Tests that tool handlers work end-to-end through the McpServer,
 * including Zod schema validation, withErrorBoundary wrapping, and
 * mcpSuccess/mcpError response formatting.
 */

import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createAnnotation, registerAnnotationTools } from "../../src/server/mcp/annotations.js";
import { registerAwarenessTools, resetInbox } from "../../src/server/mcp/awareness.js";
import { populateYDoc, registerDocumentTools } from "../../src/server/mcp/document.js";
import { extractMarkdown, extractText } from "../../src/server/mcp/document-model.js";
import {
  addDoc,
  getOpenDocs,
  removeDoc,
  setActiveDocId,
} from "../../src/server/mcp/document-service.js";
import { registerNavigationTools } from "../../src/server/mcp/navigation.js";
import {
  getBuffer as getNotificationBuffer,
  resetForTesting as resetNotifications,
} from "../../src/server/notifications.js";
import { getOrCreateDocument } from "../../src/server/yjs/provider.js";
import { Y_MAP_ANNOTATIONS } from "../../src/shared/constants.js";
import { MCP_ORIGIN } from "../../src/shared/origins.js";
import type { Annotation } from "../../src/shared/types.js";
import { rangeOf } from "../helpers/ydoc-factory.js";

let client: Client;
const sidecarTempFiles: string[] = [];

async function setupMcpClient(): Promise<Client> {
  const server = new McpServer({ name: "tandem-test", version: "0.0.1" });
  registerDocumentTools(server);
  registerAnnotationTools(server);
  registerNavigationTools(server);
  registerAwarenessTools(server);

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

  const mcpClient = new Client({ name: "test-client", version: "0.0.1" });
  await server.connect(serverTransport);
  await mcpClient.connect(clientTransport);
  return mcpClient;
}

function parseResult(result: { content: Array<{ type: string; text?: string }> }) {
  const textContent = result.content.find((c) => c.type === "text");
  return textContent?.text ? JSON.parse(textContent.text) : null;
}

function setupDoc(id: string, text: string) {
  const ydoc = getOrCreateDocument(id);
  populateYDoc(ydoc, text);
  addDoc(id, { id, filePath: `/tmp/${id}.md`, format: "md", readOnly: false, source: "file" });
  setActiveDocId(id);
  return ydoc;
}

/** Register a doc at an explicit filePath (used for sidecar-export disk writes). */
function setupDocAtPath(id: string, text: string, filePath: string, source = "file") {
  const ydoc = getOrCreateDocument(id);
  populateYDoc(ydoc, text);
  addDoc(id, {
    id,
    filePath,
    format: "md",
    readOnly: false,
    source: source as "file" | "upload",
  });
  setActiveDocId(id);
  return ydoc;
}

beforeEach(async () => {
  resetInbox();
  for (const id of [...getOpenDocs().keys()]) removeDoc(id);
  setActiveDocId(null);
  client = await setupMcpClient();
});

describe("MCP tool integration — document tools", () => {
  it("tandem_getTextContent returns text for open document", async () => {
    setupDoc("mcp-doc-1", "Hello world");

    const result = await client.callTool({ name: "tandem_getTextContent", arguments: {} });
    const parsed = parseResult(result);
    expect(parsed.error).toBe(false);
    expect(parsed.data.text).toContain("Hello world");
  });

  it("tandem_getTextContent returns error when no document open", async () => {
    const result = await client.callTool({ name: "tandem_getTextContent", arguments: {} });
    const parsed = parseResult(result);
    expect(parsed.error).toBe(true);
    expect(parsed.code).toBe("NO_DOCUMENT");
  });

  // Critical Rule #5: tandem_getTextContent must use extractText, not
  // extractMarkdown — the two produce different character offsets for the
  // same Y.Doc, and Claude's annotation ranges are anchored to extractText's.
  it("tandem_getTextContent matches extractText() (not extractMarkdown())", async () => {
    const ydoc = setupDoc(
      "mcp-doc-extract",
      "# Heading One\n\nBody paragraph\n## Heading Two\nMore body",
    );

    const result = await client.callTool({ name: "tandem_getTextContent", arguments: {} });
    const parsed = parseResult(result);
    expect(parsed.error).toBe(false);
    expect(parsed.data.text).toBe(extractText(ydoc));
    expect(parsed.data.text).toContain("# Heading One");
    expect(parsed.data.text).toContain("## Heading Two");
    expect(parsed.data.text).not.toBe(extractMarkdown(ydoc));
  });

  it("tandem_getOutline returns headings", async () => {
    setupDoc("mcp-doc-2", "# Title\n## Section\nContent");

    const result = await client.callTool({ name: "tandem_getOutline", arguments: {} });
    const parsed = parseResult(result);
    expect(parsed.error).toBe(false);
    expect(parsed.data.outline).toHaveLength(2);
    expect(parsed.data.outline[0].text).toBe("Title");
  });

  it("tandem_status reports running and open documents", async () => {
    setupDoc("mcp-doc-3", "Content");

    const result = await client.callTool({ name: "tandem_status", arguments: {} });
    const parsed = parseResult(result);
    expect(parsed.error).toBe(false);
    expect(parsed.data.running).toBe(true);
    expect(parsed.data.documentCount).toBe(1);
  });
});

describe("MCP tool integration — annotation tools", () => {
  it("tandem_comment creates an annotation", async () => {
    setupDoc("mcp-ann-1", "Hello world test content");

    const result = await client.callTool({
      name: "tandem_comment",
      arguments: { from: 0, to: 5, text: "Nice intro" },
    });
    const parsed = parseResult(result);
    expect(parsed.error).toBe(false);
    expect(parsed.data.annotationId).toMatch(/^ann_/);
  });

  it("tandem_comment rejects invalid arguments (missing required field)", async () => {
    setupDoc("mcp-ann-2", "Hello world");

    // Missing 'text' field — Zod validation should reject
    try {
      await client.callTool({
        name: "tandem_comment",
        arguments: { from: 0, to: 5 },
      });
      // If no error thrown, check the response
    } catch {
      // Expected — SDK may throw on validation failure
    }
  });

  // The no-args variants verify that deprecated stubs accept calls missing the
  // legacy required params — the Zod schema must let them through so the handler
  // can return DEPRECATED rather than a validation error.
  it.each([
    ["tandem_highlight", { from: 0, to: 5, color: "yellow" }, "mcp-ann-hl"],
    ["tandem_highlight", {}, "mcp-ann-hl-noargs"],
    ["tandem_flag", { from: 0, to: 5 }, "mcp-ann-flag"],
    ["tandem_flag", {}, "mcp-ann-flag-noargs"],
    ["tandem_suggest", { from: 0, to: 5, newText: "Hi", reason: "brevity" }, "mcp-ann-sug"],
    ["tandem_suggest", {}, "mcp-ann-sug-noargs"],
  ] as const)("%s returns DEPRECATED error (args: %j)", async (toolName, args, docId) => {
    setupDoc(docId, "Hello world");
    resetNotifications();

    const result = await client.callTool({ name: toolName, arguments: args });
    const parsed = parseResult(result);
    expect(parsed.error).toBe(true);
    expect(parsed.code).toBe("DEPRECATED");

    // Deprecated stubs surface to the user via pushNotification — without it,
    // Claude sees DEPRECATED but the user has no idea the call happened.
    const notifications = getNotificationBuffer();
    const found = notifications.find(
      (n) => n.errorCode === "DEPRECATED" && n.toolName === toolName,
    );
    expect(found).toBeDefined();
    expect(found?.severity).toBe("warning");
    expect(found?.dedupKey).toBe(`deprecated:${toolName}`);
  });

  it("tandem_comment rejects directedAt with DEPRECATED error and creates no annotation", async () => {
    const ydoc = setupDoc("mcp-ann-da", "Hello world test content");
    const map = ydoc.getMap(Y_MAP_ANNOTATIONS);

    const result = await client.callTool({
      name: "tandem_comment",
      arguments: { from: 0, to: 5, text: "Nice intro", directedAt: "claude" },
    });
    const parsed = parseResult(result);
    expect(parsed.error).toBe(true);
    expect(parsed.code).toBe("DEPRECATED");
    // No annotation should have been created
    expect(map.size).toBe(0);
  });

  it("tandem_getAnnotations returns created annotations", async () => {
    setupDoc("mcp-ann-4", "Hello world test");

    await client.callTool({
      name: "tandem_comment",
      arguments: { from: 0, to: 5, text: "Note 1" },
    });
    await client.callTool({
      name: "tandem_comment",
      arguments: { from: 6, to: 11, text: "Note 2" },
    });

    const result = await client.callTool({
      name: "tandem_getAnnotations",
      arguments: {},
    });
    const parsed = parseResult(result);
    expect(parsed.error).toBe(false);
    expect(parsed.data.count).toBe(2);
  });

  it("tandem_getAnnotations excludes notes by default and reports notesExcluded", async () => {
    const ydoc = setupDoc("mcp-ann-notes-1", "Hello world test content");
    const map = ydoc.getMap(Y_MAP_ANNOTATIONS);

    // Seed a comment via MCP tool
    await client.callTool({
      name: "tandem_comment",
      arguments: { from: 0, to: 5, text: "A comment" },
    });

    // Seed a note directly into Y.Map (notes are not creatable via MCP tools)
    const note: Annotation = {
      id: "ann_test_note_1",
      author: "user",
      type: "note",
      range: { from: 6, to: 11 },
      content: "A private note",
      status: "pending",
      timestamp: Date.now(),
      rev: 1,
    };
    ydoc.transact(() => map.set(note.id, note), MCP_ORIGIN);

    const result = await client.callTool({
      name: "tandem_getAnnotations",
      arguments: {},
    });
    const parsed = parseResult(result);
    expect(parsed.error).toBe(false);
    // Only the comment is returned; the note is excluded
    expect(parsed.data.count).toBe(1);
    expect(parsed.data.annotations[0].type).toBe("comment");
    expect(parsed.data.notesExcluded).toBe(1);
  });

  it("tandem_getAnnotations rejects type: note (ADR-027 privacy)", async () => {
    setupDoc("mcp-ann-notes-2", "Hello world test content");
    const result = await client.callTool({
      name: "tandem_getAnnotations",
      arguments: { type: "note" },
    });
    expect(result.isError).toBe(true);
  });

  it("tandem_getAnnotations surfaces imported Word comments by default (#482)", async () => {
    const ydoc = setupDoc("mcp-ann-imports-1", "Hello world test content");
    const map = ydoc.getMap(Y_MAP_ANNOTATIONS);

    // Seed a Claude comment via MCP tool
    await client.callTool({
      name: "tandem_comment",
      arguments: { from: 0, to: 5, text: "Claude comment" },
    });

    // Seed two imported Word comments — post-#482 these are author=import,
    // type=comment (Claude-visible like any other comment).
    const imported1: Annotation = {
      id: "imp_1",
      author: "import",
      type: "comment",
      range: { from: 6, to: 11 },
      content: "[Reviewer] Reword this",
      status: "pending",
      timestamp: Date.now(),
      rev: 1,
    };
    const imported2: Annotation = {
      id: "imp_2",
      author: "import",
      type: "comment",
      range: { from: 12, to: 16 },
      content: "[Reviewer] Check fact",
      status: "pending",
      timestamp: Date.now(),
      rev: 1,
    };
    ydoc.transact(() => {
      map.set(imported1.id, imported1);
      map.set(imported2.id, imported2);
    }, MCP_ORIGIN);

    // Default call: imports surface alongside the Claude comment. No
    // importsExcluded field — the opt-in plumbing was removed in #482.
    const defaultResult = await client.callTool({
      name: "tandem_getAnnotations",
      arguments: {},
    });
    const defaultParsed = parseResult(defaultResult);
    expect(defaultParsed.data.count).toBe(3);
    expect(defaultParsed.data.importsExcluded).toBeUndefined();
    const authors = defaultParsed.data.annotations.map((a: Annotation) => a.author).sort();
    expect(authors).toEqual(["claude", "import", "import"]);
    const importedIds = defaultParsed.data.annotations
      .filter((a: Annotation) => a.author === "import")
      .map((a: Annotation) => a.id)
      .sort();
    expect(importedIds).toEqual(["imp_1", "imp_2"]);

    // Author filter still scopes to imports for users who want only those.
    const filteredResult = await client.callTool({
      name: "tandem_getAnnotations",
      arguments: { author: "import" },
    });
    const filteredParsed = parseResult(filteredResult);
    expect(filteredParsed.data.count).toBe(2);
    expect(filteredParsed.data.annotations.every((a: Annotation) => a.author === "import")).toBe(
      true,
    );
  });
});

describe("MCP tool integration — tandem_exportAnnotations sidecar write (#314)", () => {
  afterEach(async () => {
    for (const f of sidecarTempFiles.splice(0)) {
      await fs.rm(f, { force: true });
    }
  });

  function uniqueDocPath(): string {
    return join(tmpdir(), `tandem-export-${Date.now()}-${Math.random().toString(36).slice(2)}.md`);
  }

  it("writes a JSON sidecar next to the document and omits notes (ADR-027)", async () => {
    const docPath = uniqueDocPath();
    const sidecarPath = `${docPath}.annotations.json`;
    sidecarTempFiles.push(sidecarPath);

    const ydoc = setupDocAtPath("mcp-export-json", "Hello world test content", docPath);
    const map = ydoc.getMap(Y_MAP_ANNOTATIONS);

    // A Claude comment (should appear) and a user-private note (must NOT appear).
    createAnnotation(map, ydoc, "comment", rangeOf(0, 5, ydoc), "A public comment");
    createAnnotation(map, ydoc, "note", rangeOf(6, 11, ydoc), "A private reminder");

    const result = await client.callTool({
      name: "tandem_exportAnnotations",
      arguments: { format: "json", writeToDisk: true },
    });
    const parsed = parseResult(result);
    expect(parsed.error).toBe(false);
    expect(parsed.data.writtenPath).toBe(sidecarPath);
    // Response itself excludes the note.
    expect(parsed.data.count).toBe(1);

    const raw = await fs.readFile(sidecarPath, "utf-8");
    // The note content must be entirely absent from the on-disk sidecar.
    expect(raw).not.toContain("A private reminder");
    expect(raw).toContain("A public comment");

    const onDisk = JSON.parse(raw);
    expect(onDisk.count).toBe(1);
    expect(onDisk.annotations).toHaveLength(1);
    expect(onDisk.annotations[0].type).toBe("comment");
    expect(onDisk.annotations.some((a: Annotation) => a.type === "note")).toBe(false);
  });

  it("writes a markdown sidecar with the .annotations.md extension", async () => {
    const docPath = uniqueDocPath();
    const sidecarPath = `${docPath}.annotations.md`;
    sidecarTempFiles.push(sidecarPath);

    const ydoc = setupDocAtPath("mcp-export-md", "Hello world test content", docPath);
    const map = ydoc.getMap(Y_MAP_ANNOTATIONS);
    createAnnotation(map, ydoc, "comment", rangeOf(0, 5, ydoc), "A public comment");
    createAnnotation(map, ydoc, "note", rangeOf(6, 11, ydoc), "A private reminder");

    const result = await client.callTool({
      name: "tandem_exportAnnotations",
      arguments: { writeToDisk: true },
    });
    const parsed = parseResult(result);
    expect(parsed.error).toBe(false);
    expect(parsed.data.writtenPath).toBe(sidecarPath);

    const raw = await fs.readFile(sidecarPath, "utf-8");
    expect(raw).toContain("# Document Review");
    expect(raw).toContain("A public comment");
    expect(raw).not.toContain("A private reminder");
  });

  it("honors a custom outputPath", async () => {
    const docPath = uniqueDocPath();
    const customPath = join(
      tmpdir(),
      `tandem-custom-${Date.now()}-${Math.random().toString(36).slice(2)}.json`,
    );
    sidecarTempFiles.push(customPath);

    const ydoc = setupDocAtPath("mcp-export-custom", "Hello world", docPath);
    const map = ydoc.getMap(Y_MAP_ANNOTATIONS);
    createAnnotation(map, ydoc, "comment", rangeOf(0, 5, ydoc), "Custom path comment");

    const result = await client.callTool({
      name: "tandem_exportAnnotations",
      arguments: { format: "json", writeToDisk: true, outputPath: customPath },
    });
    const parsed = parseResult(result);
    expect(parsed.error).toBe(false);
    expect(parsed.data.writtenPath).toBe(customPath);
    const raw = await fs.readFile(customPath, "utf-8");
    expect(raw).toContain("Custom path comment");
  });

  it("rejects writeToDisk for upload:// (and scratchpad) documents", async () => {
    const ydoc = setupDocAtPath(
      "mcp-export-upload",
      "Hello world",
      "upload://abc123/uploaded.md",
      "upload",
    );
    const map = ydoc.getMap(Y_MAP_ANNOTATIONS);
    createAnnotation(map, ydoc, "comment", rangeOf(0, 5, ydoc), "Some comment");

    const result = await client.callTool({
      name: "tandem_exportAnnotations",
      arguments: { format: "json", writeToDisk: true },
    });
    const parsed = parseResult(result);
    expect(parsed.error).toBe(true);
    expect(parsed.code).toBe("INVALID_PATH");
  });

  it("does not write a sidecar when writeToDisk is omitted", async () => {
    const docPath = uniqueDocPath();
    const sidecarPath = `${docPath}.annotations.json`;

    const ydoc = setupDocAtPath("mcp-export-nodisk", "Hello world", docPath);
    const map = ydoc.getMap(Y_MAP_ANNOTATIONS);
    createAnnotation(map, ydoc, "comment", rangeOf(0, 5, ydoc), "A comment");

    const result = await client.callTool({
      name: "tandem_exportAnnotations",
      arguments: { format: "json" },
    });
    const parsed = parseResult(result);
    expect(parsed.error).toBe(false);
    expect(parsed.data.writtenPath).toBeUndefined();
    await expect(fs.access(sidecarPath)).rejects.toThrow();
  });

  // For Zod schema rejections (refine failures), the MCP server returns a
  // content payload whose `text` starts with "MCP error -32602: ...". This is
  // a separate response shape from handler-level mcpError() (which returns
  // structured JSON). Tests that expect Zod rejection use rawErrorText().
  function rawErrorText(result: { content: Array<{ type: string; text?: string }> }) {
    return result.content.find((c) => c.type === "text")?.text ?? "";
  }

  it("rejects a relative outputPath at schema level", async () => {
    const docPath = uniqueDocPath();
    const ydoc = setupDocAtPath("mcp-export-relative", "Hello world", docPath);
    const map = ydoc.getMap(Y_MAP_ANNOTATIONS);
    createAnnotation(map, ydoc, "comment", rangeOf(0, 5, ydoc), "x");

    const result = await client.callTool({
      name: "tandem_exportAnnotations",
      arguments: { format: "json", writeToDisk: true, outputPath: "subdir/foo.json" },
    });
    const errText = rawErrorText(result);
    expect(errText).toMatch(/MCP error/);
    expect(errText).toMatch(/absolute path/i);
  });

  it("appends default sidecar filename when outputPath is an existing directory", async () => {
    const docPath = uniqueDocPath();
    const targetDir = join(
      tmpdir(),
      `tandem-export-dir-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    await fs.mkdir(targetDir, { recursive: true });
    const expectedFile = join(targetDir, `${docPath.split("/").pop()}.annotations.json`);

    const ydoc = setupDocAtPath("mcp-export-dir", "Hello world", docPath);
    const map = ydoc.getMap(Y_MAP_ANNOTATIONS);
    createAnnotation(map, ydoc, "comment", rangeOf(0, 5, ydoc), "dir-target comment");

    try {
      const result = await client.callTool({
        name: "tandem_exportAnnotations",
        arguments: { format: "json", writeToDisk: true, outputPath: targetDir },
      });
      const parsed = parseResult(result);
      expect(parsed.error).toBe(false);
      expect(parsed.data.writtenPath).toBe(expectedFile);
      const raw = await fs.readFile(expectedFile, "utf-8");
      expect(raw).toContain("dir-target comment");
    } finally {
      await fs.rm(targetDir, { recursive: true, force: true });
    }
  });

  // Windows-prefix variants are rejected at the schema level (via the second
  // Zod refine) on every platform — defense in depth even on POSIX servers
  // since a Windows client can supply crafted paths to a Linux/macOS sidecar.
  // On Linux these inputs would also fail the isAbsolute refine; we just
  // confirm the MCP layer rejects them. The exact message can come from
  // either refine depending on platform ordering.
  it("rejects outputPath with \\\\?\\ extended-length prefix", async () => {
    const docPath = uniqueDocPath();
    const ydoc = setupDocAtPath("mcp-export-unc1", "Hello world", docPath);
    const map = ydoc.getMap(Y_MAP_ANNOTATIONS);
    createAnnotation(map, ydoc, "comment", rangeOf(0, 5, ydoc), "x");

    const result = await client.callTool({
      name: "tandem_exportAnnotations",
      arguments: {
        format: "json",
        writeToDisk: true,
        outputPath: "\\\\?\\C:\\Users\\foo\\out.json",
      },
    });
    const errText = rawErrorText(result);
    expect(errText).toMatch(/MCP error/);
  });

  it("rejects outputPath with \\\\?\\UNC\\ extended UNC prefix", async () => {
    const docPath = uniqueDocPath();
    const ydoc = setupDocAtPath("mcp-export-unc2", "Hello world", docPath);
    const map = ydoc.getMap(Y_MAP_ANNOTATIONS);
    createAnnotation(map, ydoc, "comment", rangeOf(0, 5, ydoc), "x");

    const result = await client.callTool({
      name: "tandem_exportAnnotations",
      arguments: {
        format: "json",
        writeToDisk: true,
        outputPath: "\\\\?\\UNC\\evil\\share\\out.json",
      },
    });
    const errText = rawErrorText(result);
    expect(errText).toMatch(/MCP error/);
  });

  it("rejects outputPath with bare \\\\server\\share UNC", async () => {
    const docPath = uniqueDocPath();
    const ydoc = setupDocAtPath("mcp-export-unc3", "Hello world", docPath);
    const map = ydoc.getMap(Y_MAP_ANNOTATIONS);
    createAnnotation(map, ydoc, "comment", rangeOf(0, 5, ydoc), "x");

    const result = await client.callTool({
      name: "tandem_exportAnnotations",
      arguments: {
        format: "json",
        writeToDisk: true,
        outputPath: "\\\\server\\share\\out.json",
      },
    });
    const errText = rawErrorText(result);
    expect(errText).toMatch(/MCP error/);
  });
});

describe("MCP tool integration — navigation tools", () => {
  it("tandem_search finds text matches", async () => {
    setupDoc("mcp-nav-1", "The quick brown fox jumps");

    const result = await client.callTool({
      name: "tandem_search",
      arguments: { query: "quick" },
    });
    const parsed = parseResult(result);
    expect(parsed.error).toBe(false);
    expect(parsed.data.count).toBe(1);
    expect(parsed.data.matches[0].text).toBe("quick");
  });

  it("tandem_resolveRange returns range for found text", async () => {
    setupDoc("mcp-nav-2", "Hello world");

    const result = await client.callTool({
      name: "tandem_resolveRange",
      arguments: { pattern: "world" },
    });
    const parsed = parseResult(result);
    expect(parsed.error).toBe(false);
    expect(parsed.data.from).toBe(6);
    expect(parsed.data.to).toBe(11);
  });

  it("tandem_status updates awareness when text param is provided", async () => {
    setupDoc("mcp-nav-3", "Hello world");

    const result = await client.callTool({
      name: "tandem_status",
      arguments: { text: "Reviewing..." },
    });
    const parsed = parseResult(result);
    expect(parsed.error).toBe(false);
    expect(parsed.data.status).toBe("Reviewing...");
  });
});

describe("MCP tool integration — awareness tools", () => {
  it("tandem_checkInbox returns inbox state", async () => {
    setupDoc("mcp-aw-1", "Hello world");

    const result = await client.callTool({
      name: "tandem_checkInbox",
      arguments: {},
    });
    const parsed = parseResult(result);
    expect(parsed.error).toBe(false);
    expect(parsed.data.summary).toBeDefined();
    expect(parsed.data.hasNew).toBe(false);
  });

  it("tandem_reply sends a chat message", async () => {
    setupDoc("mcp-aw-2", "Hello world");

    const result = await client.callTool({
      name: "tandem_reply",
      arguments: { text: "Got it, thanks!" },
    });
    const parsed = parseResult(result);
    expect(parsed.error).toBe(false);
    expect(parsed.data.sent).toBe(true);
    expect(parsed.data.messageId).toMatch(/^msg_/);
  });
});

describe("MCP tool integration — error handling", () => {
  it("withErrorBoundary catches unexpected errors gracefully", async () => {
    // Calling a tool that requires a document when none is open
    const result = await client.callTool({
      name: "tandem_search",
      arguments: { query: "test" },
    });
    const parsed = parseResult(result);
    expect(parsed.error).toBe(true);
    expect(parsed.code).toBe("NO_DOCUMENT");
  });
});
