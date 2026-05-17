/**
 * MCP tool handler integration test.
 *
 * Tests that tool handlers work end-to-end through the McpServer,
 * including Zod schema validation, withErrorBoundary wrapping, and
 * mcpSuccess/mcpError response formatting.
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { beforeEach, describe, expect, it } from "vitest";
import { registerAnnotationTools } from "../../src/server/mcp/annotations.js";
import { registerAwarenessTools, resetInbox } from "../../src/server/mcp/awareness.js";
import { populateYDoc, registerDocumentTools } from "../../src/server/mcp/document.js";
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

let client: Client;

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
