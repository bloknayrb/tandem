/**
 * Tests for tandem_resolveAnnotation MCP tool.
 * Locks in PR-A3 error-code change (NOT_FOUND on missing annotation, both
 * action: "accept" and action: "dismiss" branches against the same handler).
 *
 * Uses in-memory MCP client to exercise the actual tool handler, matching the
 * pattern in edit-annotation.test.ts.
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

describe("tandem_resolveAnnotation NOT_FOUND error code", () => {
  it("returns NOT_FOUND when action: accept targets a missing annotation", async () => {
    setupDoc("resolve-1", "Hello world");

    const result = await client.callTool({
      name: "tandem_resolveAnnotation",
      arguments: { id: "fake-id", action: "accept" },
    });
    const parsed = parseResult(result as { content: Array<{ type: string; text?: string }> });
    expect(parsed.message).toContain("not found");
    expect(parsed.code).toBe("NOT_FOUND");
  });

  it("returns NOT_FOUND when action: dismiss targets a missing annotation", async () => {
    setupDoc("resolve-2", "Hello world");

    const result = await client.callTool({
      name: "tandem_resolveAnnotation",
      arguments: { id: "fake-id", action: "dismiss" },
    });
    const parsed = parseResult(result as { content: Array<{ type: string; text?: string }> });
    expect(parsed.message).toContain("not found");
    expect(parsed.code).toBe("NOT_FOUND");
  });
});

describe("tandem_resolveAnnotation precondition (issue #694)", () => {
  it("rejects re-accept on an already-accepted annotation without bumping rev", async () => {
    const ydoc = setupDoc("resolve-pre-1", "Hello world");
    const map = ydoc.getMap(Y_MAP_ANNOTATIONS);
    const id = createAnnotation(map, ydoc, "comment", rangeOf(0, 5, ydoc), "Original");

    await client.callTool({
      name: "tandem_resolveAnnotation",
      arguments: { id, action: "accept" },
    });

    const accepted = map.get(id) as Annotation;
    expect(accepted.status).toBe("accepted");
    const revAfterFirst = accepted.rev;

    const result = await client.callTool({
      name: "tandem_resolveAnnotation",
      arguments: { id, action: "accept" },
    });
    const parsed = parseResult(result as { content: Array<{ type: string; text?: string }> });
    expect(parsed.code).toBe("ANNOTATION_NOT_PENDING");
    expect(parsed.message).toContain("already accepted");

    const after = map.get(id) as Annotation;
    expect(after.status).toBe("accepted");
    expect(after.rev).toBe(revAfterFirst);
  });

  it("rejects re-dismiss on an already-dismissed annotation without bumping rev", async () => {
    const ydoc = setupDoc("resolve-pre-2", "Hello world");
    const map = ydoc.getMap(Y_MAP_ANNOTATIONS);
    const id = createAnnotation(map, ydoc, "comment", rangeOf(0, 5, ydoc), "Original");

    const ann = map.get(id) as Annotation;
    ydoc.transact(() => map.set(id, { ...ann, status: "dismissed" as const }), MCP_ORIGIN);
    const revBefore = (map.get(id) as Annotation).rev;

    const result = await client.callTool({
      name: "tandem_resolveAnnotation",
      arguments: { id, action: "dismiss" },
    });
    const parsed = parseResult(result as { content: Array<{ type: string; text?: string }> });
    expect(parsed.code).toBe("ANNOTATION_NOT_PENDING");
    expect(parsed.message).toContain("already dismissed");

    const after = map.get(id) as Annotation;
    expect(after.status).toBe("dismissed");
    expect(after.rev).toBe(revBefore);
  });

  it("rejects accept on an already-dismissed annotation (cross-action)", async () => {
    const ydoc = setupDoc("resolve-pre-3", "Hello world");
    const map = ydoc.getMap(Y_MAP_ANNOTATIONS);
    const id = createAnnotation(map, ydoc, "comment", rangeOf(0, 5, ydoc), "Original");

    const ann = map.get(id) as Annotation;
    ydoc.transact(() => map.set(id, { ...ann, status: "dismissed" as const }), MCP_ORIGIN);

    const result = await client.callTool({
      name: "tandem_resolveAnnotation",
      arguments: { id, action: "accept" },
    });
    const parsed = parseResult(result as { content: Array<{ type: string; text?: string }> });
    expect(parsed.code).toBe("ANNOTATION_NOT_PENDING");

    const after = map.get(id) as Annotation;
    expect(after.status).toBe("dismissed");
  });
});
