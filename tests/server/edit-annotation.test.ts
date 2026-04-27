/**
 * Tests for tandem_editAnnotation MCP tool.
 * Uses in-memory MCP client to exercise the actual tool handler.
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { beforeEach, describe, expect, it } from "vitest";
import { MCP_ORIGIN } from "../../src/server/events/queue.js";
import { createAnnotation, registerAnnotationTools } from "../../src/server/mcp/annotations.js";
import { populateYDoc } from "../../src/server/mcp/document.js";
import {
  addDoc,
  getOpenDocs,
  removeDoc,
  setActiveDocId,
} from "../../src/server/mcp/document-service.js";
import { getOrCreateDocument } from "../../src/server/yjs/provider.js";
import { Y_MAP_ANNOTATIONS } from "../../src/shared/constants.js";
import type { Annotation } from "../../src/shared/types.js";
import { rangeOf } from "../helpers/ydoc-factory.js";

let client: Client;

async function setupMcpClient(): Promise<Client> {
  const server = new McpServer({ name: "tandem-test", version: "0.0.1" });
  registerAnnotationTools(server);

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
  for (const id of [...getOpenDocs().keys()]) removeDoc(id);
  setActiveDocId(null);
  client = await setupMcpClient();
});

describe("tandem_editAnnotation", () => {
  it("edits a comment's content", async () => {
    const ydoc = setupDoc("edit-1", "Hello world");
    const map = ydoc.getMap(Y_MAP_ANNOTATIONS);
    const id = createAnnotation(map, ydoc, "comment", rangeOf(0, 5, ydoc), "Original comment");

    const result = await client.callTool({
      name: "tandem_editAnnotation",
      arguments: { id, content: "Updated comment" },
    });
    const parsed = parseResult(result as any);
    expect(parsed.error).toBe(false);
    expect(parsed.data.id).toBe(id);
    expect(parsed.data.content).toBe("Updated comment");
    expect(parsed.data.editedAt).toBeDefined();

    const ann = map.get(id) as Annotation;
    expect(ann.content).toBe("Updated comment");
    expect(ann.editedAt).toBeDefined();
  });

  it("edits a suggestion's newText, preserving reason", async () => {
    const ydoc = setupDoc("edit-2", "Hello world");
    const map = ydoc.getMap(Y_MAP_ANNOTATIONS);
    const id = createAnnotation(map, ydoc, "comment", rangeOf(0, 5, ydoc), "brevity", {
      suggestedText: "Hi",
    });

    const result = await client.callTool({
      name: "tandem_editAnnotation",
      arguments: { id, newText: "Hey" },
    });
    const parsed = parseResult(result as any);
    expect(parsed.error).toBe(false);
    expect(parsed.data.suggestedText).toBe("Hey");

    const ann = map.get(id) as Annotation;
    expect(ann.suggestedText).toBe("Hey");
    expect(ann.content).toBe("brevity"); // preserved
  });

  it("edits a suggestion's reason only", async () => {
    const ydoc = setupDoc("edit-3", "Hello world");
    const map = ydoc.getMap(Y_MAP_ANNOTATIONS);
    const id = createAnnotation(map, ydoc, "comment", rangeOf(0, 5, ydoc), "brevity", {
      suggestedText: "Hi",
    });

    await client.callTool({
      name: "tandem_editAnnotation",
      arguments: { id, reason: "more concise" },
    });

    const ann = map.get(id) as Annotation;
    expect(ann.suggestedText).toBe("Hi"); // preserved
    expect(ann.content).toBe("more concise");
  });

  it("rejects edit on a resolved annotation", async () => {
    const ydoc = setupDoc("edit-4", "Hello world");
    const map = ydoc.getMap(Y_MAP_ANNOTATIONS);
    const id = createAnnotation(map, ydoc, "comment", rangeOf(0, 5, ydoc), "Original");

    // Accept the annotation
    const ann = map.get(id) as Annotation;
    ydoc.transact(() => map.set(id, { ...ann, status: "accepted" as const }), MCP_ORIGIN);

    const result = await client.callTool({
      name: "tandem_editAnnotation",
      arguments: { id, content: "New text" },
    });
    const parsed = parseResult(result as any);
    expect(parsed.message).toContain("Cannot edit");

    // Content should be unchanged
    const after = map.get(id) as Annotation;
    expect(after.content).toBe("Original");
  });

  it("rejects when no editable fields provided for non-suggestion", async () => {
    const ydoc = setupDoc("edit-5", "Hello world");
    const map = ydoc.getMap(Y_MAP_ANNOTATIONS);
    const id = createAnnotation(map, ydoc, "comment", rangeOf(0, 5, ydoc), "Original");

    const result = await client.callTool({ name: "tandem_editAnnotation", arguments: { id } });
    const parsed = parseResult(result as any);
    expect(parsed.message).toContain("No editable fields");
  });

  it("rejects when no editable fields provided for comment with suggestedText", async () => {
    const ydoc = setupDoc("edit-6", "Hello world");
    const map = ydoc.getMap(Y_MAP_ANNOTATIONS);
    const id = createAnnotation(map, ydoc, "comment", rangeOf(0, 5, ydoc), "brevity", {
      suggestedText: "Hi",
    });

    const result = await client.callTool({ name: "tandem_editAnnotation", arguments: { id } });
    const parsed = parseResult(result as any);
    expect(parsed.message).toContain("No editable fields");
  });

  it("returns error for nonexistent annotation ID", async () => {
    setupDoc("edit-7", "Hello world");

    const result = await client.callTool({
      name: "tandem_editAnnotation",
      arguments: { id: "fake-id", content: "x" },
    });
    const parsed = parseResult(result as any);
    expect(parsed.message).toContain("not found");
  });

  it("preserves immutable fields when editing", async () => {
    const ydoc = setupDoc("edit-8", "Hello world");
    const map = ydoc.getMap(Y_MAP_ANNOTATIONS);
    const id = createAnnotation(map, ydoc, "comment", rangeOf(0, 5, ydoc), "Original", {
      textSnapshot: "Hello",
    });

    await client.callTool({ name: "tandem_editAnnotation", arguments: { id, content: "Edited" } });

    const ann = map.get(id) as Annotation;
    expect(ann.content).toBe("Edited");
    expect(ann.textSnapshot).toBe("Hello");
    expect(ann.type).toBe("comment");
    expect(ann.author).toBe("claude");
    expect(ann.status).toBe("pending");
    expect(ann.editedAt).toBeDefined();
  });

  it("edits suggestedText on a comment that already has it", async () => {
    const ydoc = setupDoc("edit-9", "Hello world");
    const map = ydoc.getMap(Y_MAP_ANNOTATIONS);
    const id = createAnnotation(map, ydoc, "comment", rangeOf(0, 5, ydoc), "reason", {
      suggestedText: "Old",
    });

    const result = await client.callTool({
      name: "tandem_editAnnotation",
      arguments: { id, newText: "New" },
    });
    const parsed = parseResult(result as any);
    expect(parsed.error).toBe(false);

    const ann = map.get(id) as Annotation;
    expect(ann.suggestedText).toBe("New");
    expect(ann.content).toBe("reason"); // preserved
  });

  it("rejects newText on a highlight annotation", async () => {
    const ydoc = setupDoc("edit-10", "Hello world");
    const map = ydoc.getMap(Y_MAP_ANNOTATIONS);
    const id = createAnnotation(map, ydoc, "highlight", rangeOf(0, 5, ydoc), "note", {
      color: "yellow",
    });

    const result = await client.callTool({
      name: "tandem_editAnnotation",
      arguments: { id, newText: "replacement" },
    });
    const parsed = parseResult(result as any);
    expect(parsed.message).toContain("Only comments support suggestedText");
  });
});

describe("tandem_comment via MCP", () => {
  it("creates annotation with suggestedText", async () => {
    const ydoc = setupDoc("comment-st-1", "Hello world");
    const map = ydoc.getMap(Y_MAP_ANNOTATIONS);

    const result = await client.callTool({
      name: "tandem_comment",
      arguments: { from: 0, to: 5, text: "more concise", suggestedText: "Hi" },
    });
    const parsed = parseResult(result as any);
    expect(parsed.error).toBe(false);

    const ann = map.get(parsed.data.annotationId) as Annotation;
    expect(ann.type).toBe("comment");
    expect(ann.suggestedText).toBe("Hi");
    expect(ann.content).toBe("more concise");
  });

  it("creates annotation with directedAt", async () => {
    const ydoc = setupDoc("comment-da-1", "Hello world");
    const map = ydoc.getMap(Y_MAP_ANNOTATIONS);

    const result = await client.callTool({
      name: "tandem_comment",
      arguments: { from: 0, to: 5, text: "Is this right?", directedAt: "claude" },
    });
    const parsed = parseResult(result as any);
    expect(parsed.error).toBe(false);

    const ann = map.get(parsed.data.annotationId) as Annotation;
    expect(ann.type).toBe("comment");
    expect(ann.directedAt).toBe("claude");
  });
});

describe("tandem_suggest deprecation stub", () => {
  it("returns DEPRECATED error regardless of arguments", async () => {
    setupDoc("suggest-deprecated-1", "Hello world");

    const result = await client.callTool({
      name: "tandem_suggest",
      arguments: { from: 0, to: 5, newText: "Hi", reason: "brevity" },
    });
    const parsed = parseResult(result as any);
    expect(parsed.error).toBe(true);
    expect(parsed.code).toBe("DEPRECATED");
    expect(parsed.message).toMatch(/deprecated/i);
  });
});
