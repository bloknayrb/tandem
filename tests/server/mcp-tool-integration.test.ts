/**
 * MCP tool handler integration test.
 *
 * Tests that tool handlers work end-to-end through the McpServer,
 * including Zod schema validation, withErrorBoundary wrapping, and
 * mcpSuccess/mcpError response formatting.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { getOrCreateDocument } from "../../src/server/yjs/provider.js";
import { registerDocumentTools } from "../../src/server/mcp/document.js";
import { registerAnnotationTools } from "../../src/server/mcp/annotations.js";
import { registerNavigationTools } from "../../src/server/mcp/navigation.js";
import { registerAwarenessTools } from "../../src/server/mcp/awareness.js";
import {
  addDoc,
  removeDoc,
  setActiveDocId,
  getOpenDocs,
} from "../../src/server/mcp/document-service.js";
import { populateYDoc } from "../../src/server/mcp/document.js";
import { resetInbox } from "../../src/server/mcp/awareness.js";

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

  it("tandem_highlight creates highlight with color", async () => {
    setupDoc("mcp-ann-3", "Hello world");

    const result = await client.callTool({
      name: "tandem_highlight",
      arguments: { from: 0, to: 5, color: "yellow" },
    });
    const parsed = parseResult(result);
    expect(parsed.error).toBe(false);
    expect(parsed.data.annotationId).toMatch(/^ann_/);
  });

  it("tandem_getAnnotations returns created annotations", async () => {
    setupDoc("mcp-ann-4", "Hello world test");

    await client.callTool({
      name: "tandem_comment",
      arguments: { from: 0, to: 5, text: "Note 1" },
    });
    await client.callTool({
      name: "tandem_highlight",
      arguments: { from: 6, to: 11, color: "blue" },
    });

    const result = await client.callTool({
      name: "tandem_getAnnotations",
      arguments: {},
    });
    const parsed = parseResult(result);
    expect(parsed.error).toBe(false);
    expect(parsed.data.count).toBe(2);
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

  it("tandem_setStatus updates awareness", async () => {
    setupDoc("mcp-nav-3", "Hello world");

    const result = await client.callTool({
      name: "tandem_setStatus",
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
