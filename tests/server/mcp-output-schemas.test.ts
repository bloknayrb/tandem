/**
 * Output-schema / structuredContent coverage for the six data-returning tools
 * migrated to `registerTool` in #1080: tandem_status, tandem_getAnnotations,
 * tandem_getTextContent, tandem_checkInbox, tandem_listDocuments,
 * tandem_search.
 *
 * Each tool must:
 *   1. advertise an `outputSchema` in tools/list,
 *   2. emit `structuredContent` identical to the legacy text envelope's
 *      `data` payload (text stays the source of truth for Claude),
 *   3. emit a payload the declared schema describes EXACTLY — validated by
 *      parsing with zod strip-mode and asserting the parsed result deep-equals
 *      the emitted payload (any undeclared key would be stripped and fail the
 *      comparison; any missing/mistyped declared key fails the parse).
 *
 * Also covers:
 *   - error envelopes from outputSchema'd tools are marked `isError: true`
 *     (the SDK requires structuredContent on non-error results),
 *   - channel-less degradation: this test environment has NO channel shim
 *     connected, so these tests double as proof that tandem_checkInbox /
 *     tandem_status return sensible results for generic MCP clients that
 *     never attach the SSE channel (`wasEmittedViaChannel` is always false →
 *     everything surfaces through polling).
 *   - ADR-027: notes never appear in structured payloads; the schemas don't
 *     even admit `type: "note"`.
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { beforeEach, describe, expect, it } from "vitest";
import { type ZodRawShape, z } from "zod";
import type { DoctorReport } from "../../src/cli/doctor.js";
import { createAnnotation, registerAnnotationTools } from "../../src/server/mcp/annotations.js";
import { registerAwarenessTools, resetInbox } from "../../src/server/mcp/awareness.js";
import { registerDiagnosticsTools } from "../../src/server/mcp/diagnostics.js";
import { populateYDoc, registerDocumentTools } from "../../src/server/mcp/document.js";
import {
  addDoc,
  getOpenDocs,
  removeDoc,
  setActiveDocId,
} from "../../src/server/mcp/document-service.js";
import { registerNavigationTools } from "../../src/server/mcp/navigation.js";
import {
  checkInboxOutputShape,
  diagnosticsOutputShape,
  getAnnotationsOutputShape,
  getTextContentOutputShape,
  listDocumentsOutputShape,
  searchOutputShape,
  statusOutputShape,
} from "../../src/server/mcp/output-schemas.js";
import { getOrCreateDocument } from "../../src/server/yjs/provider.js";
import { CTRL_ROOM, Y_MAP_ANNOTATIONS, Y_MAP_CHAT } from "../../src/shared/constants.js";
import { withInternal } from "../../src/shared/origins.js";
import type { Annotation, ChatMessage } from "../../src/shared/types.js";
import { toFlatOffset } from "../../src/shared/types.js";
import { rangeOf } from "../helpers/ydoc-factory.js";

let client: Client;

/** Deterministic doctor report so diagnostics tests never touch real ports. */
const STUB_DOCTOR_REPORT: DoctorReport = {
  ok: true,
  crashed: false,
  failures: 0,
  warnings: 1,
  summary: "1 warning(s) — Tandem should work, but check the items above.",
  error: null,
  results: [
    {
      check: "health",
      status: "pass",
      message: "MCP HTTP /health responded",
      data: { port: 3479, hasSession: true },
    },
    {
      check: "user-mcp-config",
      status: "warn",
      message: "No active MCP session — Claude Code hasn't connected yet",
      fix: "Restart Claude and run /mcp",
    },
  ],
};

async function setupMcpClient(): Promise<Client> {
  const server = new McpServer({ name: "tandem-test", version: "0.0.1" });
  registerDocumentTools(server);
  registerAnnotationTools(server);
  registerNavigationTools(server);
  registerAwarenessTools(server);
  registerDiagnosticsTools(server, {
    version: "9.9.9-test",
    transport: "http",
    collect: async () => STUB_DOCTOR_REPORT,
  });

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const mcpClient = new Client({ name: "test-client", version: "0.0.1" });
  await server.connect(serverTransport);
  await mcpClient.connect(clientTransport);
  return mcpClient;
}

type ToolResult = {
  content: Array<{ type: string; text?: string }>;
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
};

function textEnvelope(result: ToolResult): { error: boolean; data?: unknown } {
  const textContent = result.content.find((c) => c.type === "text");
  return textContent?.text ? JSON.parse(textContent.text) : { error: true };
}

/**
 * Assert that `structuredContent` (a) exists, (b) equals the text envelope's
 * `data`, and (c) is described EXACTLY by `shape`: zod strip-mode parsing
 * removes undeclared keys at every nesting level, so `parsed ≡ emitted`
 * proves there are no undeclared fields, while a successful parse proves all
 * declared fields are present/typed correctly.
 */
function expectStructuredMatch(result: ToolResult, shape: ZodRawShape): Record<string, unknown> {
  expect(result.isError).toBeFalsy();
  const sc = result.structuredContent;
  expect(sc).toBeDefined();
  const envelope = textEnvelope(result);
  expect(envelope.error).toBe(false);
  expect(sc).toEqual(envelope.data);

  const parsed = z.object(shape).parse(sc);
  expect(parsed).toEqual(sc);
  return sc as Record<string, unknown>;
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

describe("tools/list advertises outputSchema", () => {
  it("exactly the data-returning tools declare an outputSchema", async () => {
    const { tools } = await client.listTools();
    const withSchema = tools
      .filter((t) => t.outputSchema !== undefined)
      .map((t) => t.name)
      .sort();
    expect(withSchema).toEqual([
      "tandem_checkInbox",
      "tandem_diagnostics",
      "tandem_getAnnotations",
      "tandem_getTextContent",
      "tandem_listDocuments",
      "tandem_search",
      "tandem_status",
    ]);
  });
});

describe("tandem_diagnostics structured output (#1174 gap #2)", () => {
  it("returns the filtered doctor report plus environment fields", async () => {
    const result = (await client.callTool({
      name: "tandem_diagnostics",
      arguments: {},
    })) as ToolResult;
    const sc = expectStructuredMatch(result, diagnosticsOutputShape);
    expect(sc.ok).toBe(true);
    expect(sc.warnings).toBe(1);
    expect(sc.version).toBe("9.9.9-test");
    expect(sc.transport).toBe("http");
    expect(sc.platform).toBe(process.platform);
    const results = sc.results as Array<Record<string, unknown>>;
    expect(results.map((r) => r.check)).toEqual(["health", "user-mcp-config"]);
    // Per-check `data` bag (free-form record) survives schema validation.
    expect((results[0].data as Record<string, unknown>).port).toBe(3479);
  });

  it("drops dev-repo-only checks (node-modules / mcp-json) from the report", async () => {
    // A fresh client whose collector includes dev-repo checks — they must be
    // filtered out so a desktop/global install (arbitrary cwd) isn't told it
    // failed two meaningless checks.
    const server = new McpServer({ name: "tandem-test", version: "0.0.1" });
    registerDiagnosticsTools(server, {
      version: "9.9.9-test",
      transport: "http",
      collect: async () => ({
        ok: false,
        crashed: false,
        failures: 1,
        warnings: 0,
        summary: "1 issue(s) found.",
        error: null,
        results: [
          { check: "node-modules", status: "fail", message: "deps missing" },
          { check: "mcp-json", status: "fail", message: "no .mcp.json" },
          { check: "health", status: "pass", message: "ok" },
        ],
      }),
    });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    const c = new Client({ name: "test-client", version: "0.0.1" });
    await server.connect(st);
    await c.connect(ct);

    const result = (await c.callTool({
      name: "tandem_diagnostics",
      arguments: {},
    })) as ToolResult;
    const sc = expectStructuredMatch(result, diagnosticsOutputShape);
    const results = sc.results as Array<Record<string, unknown>>;
    expect(results.map((r) => r.check)).toEqual(["health"]);
    // Aggregates recomputed after filtering: the two dev-repo failures are gone.
    expect(sc.failures).toBe(0);
    expect(sc.ok).toBe(true);
  });
});

describe("tandem_status structured output", () => {
  it("read mode matches schema (no documents open — channel-less empty state)", async () => {
    const result = (await client.callTool({
      name: "tandem_status",
      arguments: {},
    })) as ToolResult;
    const sc = expectStructuredMatch(result, statusOutputShape);
    expect(sc.running).toBe(true);
    expect(sc.mode).toBe("tandem");
    expect(sc.activeDocument).toBeNull();
    expect(sc.openDocuments).toEqual([]);
    expect(sc.documentCount).toBe(0);
  });

  it("read mode matches schema with an open document", async () => {
    setupDoc("schema-status-doc", "# Title\nBody text here");
    const result = (await client.callTool({
      name: "tandem_status",
      arguments: {},
    })) as ToolResult;
    const sc = expectStructuredMatch(result, statusOutputShape);
    expect(sc.documentCount).toBe(1);
    expect((sc.activeDocument as { documentId: string }).documentId).toBe("schema-status-doc");
  });

  it("write mode matches schema and echoes status", async () => {
    setupDoc("schema-status-write", "# Title\nBody text here");
    const result = (await client.callTool({
      name: "tandem_status",
      arguments: { text: "Reviewing section 2" },
    })) as ToolResult;
    const sc = expectStructuredMatch(result, statusOutputShape);
    expect(sc.status).toBe("Reviewing section 2");
  });

  it("write mode with no document returns a warning (graceful, not an error)", async () => {
    const result = (await client.callTool({
      name: "tandem_status",
      arguments: { text: "hello" },
    })) as ToolResult;
    const sc = expectStructuredMatch(result, statusOutputShape);
    expect(sc.warning).toContain("No document open");
  });
});

describe("tandem_getTextContent structured output", () => {
  it("full-document read matches schema", async () => {
    setupDoc("schema-text-doc", "# Title\nFirst paragraph");
    const result = (await client.callTool({
      name: "tandem_getTextContent",
      arguments: {},
    })) as ToolResult;
    const sc = expectStructuredMatch(result, getTextContentOutputShape);
    expect(sc.text).toContain("First paragraph");
    expect(sc.documentId).toBe("schema-text-doc");
  });

  it("section read matches schema", async () => {
    setupDoc("schema-text-section", "# Title\nIntro\n## Costs\nNumbers");
    const result = (await client.callTool({
      name: "tandem_getTextContent",
      arguments: { section: "Costs" },
    })) as ToolResult;
    const sc = expectStructuredMatch(result, getTextContentOutputShape);
    expect(sc.section).toBe("Costs");
    expect(sc.text).toContain("Numbers");
  });
});

describe("tandem_getAnnotations structured output", () => {
  it("matches schema with replies, and excludes notes (ADR-027)", async () => {
    const ydoc = setupDoc("schema-ann-doc", "# Title\nHello annotated world");
    const map = ydoc.getMap(Y_MAP_ANNOTATIONS);

    // Claude comment with a suggestion + a reply thread
    const annId = createAnnotation(map, ydoc, "comment", rangeOf(8, 13, ydoc), "Tighten this", {
      suggestedText: "Hi",
      textSnapshot: "Hello",
    });
    const replyResult = (await client.callTool({
      name: "tandem_annotationReply",
      arguments: { annotationId: annId, text: "Done — see the new wording." },
    })) as ToolResult;
    expect(textEnvelope(replyResult).error).toBe(false);

    // Promoted Word-import comment — its importSource carries commentId
    // (round-trip identity), which the schema must declare or strict clients
    // strip it.
    const promotedImport: Annotation = {
      id: "import-promoted-1",
      author: "user",
      type: "comment",
      audience: "outbound",
      range: { from: toFlatOffset(8), to: toFlatOffset(13) },
      content: "From Word review",
      status: "pending",
      timestamp: Date.now(),
      importSource: { author: "Reviewer A", file: "draft.docx", commentId: "w-cmt-7" },
    };
    withInternal(ydoc, () => map.set(promotedImport.id, promotedImport));

    // User-private note — must never surface (ADR-027)
    const note: Annotation = {
      id: "note-private-1",
      author: "user",
      type: "note",
      audience: "private",
      range: { from: toFlatOffset(8), to: toFlatOffset(13) },
      content: "my private thought",
      status: "pending",
      timestamp: Date.now(),
    };
    withInternal(ydoc, () => map.set(note.id, note));

    const result = (await client.callTool({
      name: "tandem_getAnnotations",
      arguments: {},
    })) as ToolResult;
    const sc = expectStructuredMatch(result, getAnnotationsOutputShape);

    expect(sc.count).toBe(2);
    expect(sc.notesExcluded).toBe(1);
    const anns = sc.annotations as Array<Record<string, unknown>>;
    expect(anns).toHaveLength(2);
    const claudeAnn = anns.find((a) => a.id === annId);
    expect(claudeAnn?.type).toBe("comment");
    expect(claudeAnn?.suggestedText).toBe("Hi");
    expect((claudeAnn?.replies as unknown[]).length).toBe(1);
    // commentId survives schema validation (expectStructuredMatch already
    // proved parsed ≡ emitted; this pins the field itself)
    const imported = anns.find((a) => a.id === "import-promoted-1");
    expect((imported?.importSource as Record<string, unknown>).commentId).toBe("w-cmt-7");
    // The serialized payload must never contain the note's content
    expect(JSON.stringify(sc)).not.toContain("my private thought");
    // directedAt is deprecated and stripped on read — never re-introduced
    expect(JSON.stringify(sc)).not.toContain("directedAt");
  });
});

describe("tandem_checkInbox structured output (no channel shim attached)", () => {
  it("returns a sensible empty state for channel-less clients", async () => {
    setupDoc("schema-inbox-empty", "# Title\nNothing new here");
    const result = (await client.callTool({
      name: "tandem_checkInbox",
      arguments: {},
    })) as ToolResult;
    const sc = expectStructuredMatch(result, checkInboxOutputShape);
    expect(sc.hasNew).toBe(false);
    expect(sc.summary).toBe("No new actions.");
    expect(sc.userActions).toEqual([]);
    expect(sc.userResponses).toEqual([]);
    expect(sc.chatMessages).toEqual([]);
    expect(sc.mode).toBe("tandem");
  });

  it("surfaces user comments, decisions, and chat via polling when no channel emitted them", async () => {
    const ydoc = setupDoc("schema-inbox-full", "# Title\nHello annotated world");
    const map = ydoc.getMap(Y_MAP_ANNOTATIONS);

    // User comment (a user action Claude hasn't seen)
    const userComment: Annotation = {
      id: "user-comment-inbox-1",
      author: "user",
      type: "comment",
      audience: "outbound",
      range: { from: toFlatOffset(8), to: toFlatOffset(13) },
      content: "Please expand this",
      status: "pending",
      timestamp: Date.now(),
    };
    // Claude annotation the user accepted (a user response)
    const acceptedId = createAnnotation(map, ydoc, "comment", rangeOf(14, 23, ydoc), "Trim?", {});
    withInternal(ydoc, () => {
      map.set(userComment.id, userComment);
      const accepted = map.get(acceptedId) as Annotation;
      map.set(acceptedId, { ...accepted, status: "accepted" });
    });

    // Unread user chat message in CTRL_ROOM
    const ctrlDoc = getOrCreateDocument(CTRL_ROOM);
    const chatMap = ctrlDoc.getMap(Y_MAP_CHAT);
    const msg: ChatMessage = {
      id: `chat-inbox-${Date.now()}`,
      author: "user",
      text: "How is the draft going?",
      timestamp: Date.now(),
      read: false,
    };
    withInternal(ctrlDoc, () => chatMap.set(msg.id, msg));

    const result = (await client.callTool({
      name: "tandem_checkInbox",
      arguments: {},
    })) as ToolResult;
    const sc = expectStructuredMatch(result, checkInboxOutputShape);

    expect(sc.hasNew).toBe(true);
    const actions = sc.userActions as Array<Record<string, unknown>>;
    expect(actions.map((a) => a.id)).toContain("user-comment-inbox-1");
    expect(actions[0].textSnippet).toBeDefined();
    const responses = sc.userResponses as Array<Record<string, unknown>>;
    expect(responses.map((a) => a.id)).toContain(acceptedId);
    const chats = sc.chatMessages as Array<Record<string, unknown>>;
    expect(chats.map((c) => c.id)).toContain(msg.id);
  });

  it("never surfaces notes in any inbox bucket (ADR-027)", async () => {
    const ydoc = setupDoc("schema-inbox-note", "# Title\nHello annotated world");
    const map = ydoc.getMap(Y_MAP_ANNOTATIONS);
    const note: Annotation = {
      id: "note-inbox-1",
      author: "user",
      type: "note",
      audience: "private",
      range: { from: toFlatOffset(8), to: toFlatOffset(13) },
      content: "secret note content",
      status: "pending",
      timestamp: Date.now(),
    };
    withInternal(ydoc, () => map.set(note.id, note));

    const result = (await client.callTool({
      name: "tandem_checkInbox",
      arguments: {},
    })) as ToolResult;
    const sc = expectStructuredMatch(result, checkInboxOutputShape);
    expect(JSON.stringify(sc)).not.toContain("secret note content");
    expect(sc.userActions).toEqual([]);
  });
});

describe("tandem_listDocuments structured output", () => {
  it("matches schema with multiple documents", async () => {
    setupDoc("schema-list-a", "# A\nFirst");
    setupDoc("schema-list-b", "# B\nSecond");
    const result = (await client.callTool({
      name: "tandem_listDocuments",
      arguments: {},
    })) as ToolResult;
    const sc = expectStructuredMatch(result, listDocumentsOutputShape);
    expect(sc.count).toBe(2);
    expect(sc.activeDocumentId).toBe("schema-list-b");
    const docs = sc.documents as Array<Record<string, unknown>>;
    expect(docs.find((d) => d.id === "schema-list-b")?.isActive).toBe(true);
  });

  it("matches schema with no documents (activeDocumentId is null)", async () => {
    const result = (await client.callTool({
      name: "tandem_listDocuments",
      arguments: {},
    })) as ToolResult;
    const sc = expectStructuredMatch(result, listDocumentsOutputShape);
    expect(sc.count).toBe(0);
    expect(sc.activeDocumentId).toBeNull();
  });
});

describe("tandem_search structured output", () => {
  it("matches schema with matches", async () => {
    setupDoc("schema-search-doc", "# Title\nalpha beta alpha gamma");
    const result = (await client.callTool({
      name: "tandem_search",
      arguments: { query: "alpha" },
    })) as ToolResult;
    const sc = expectStructuredMatch(result, searchOutputShape);
    expect(sc.count).toBe(2);
    expect((sc.matches as Array<{ text: string }>)[0].text).toBe("alpha");
  });

  it("matches schema with zero matches", async () => {
    setupDoc("schema-search-empty", "# Title\nalpha beta");
    const result = (await client.callTool({
      name: "tandem_search",
      arguments: { query: "zeta" },
    })) as ToolResult;
    const sc = expectStructuredMatch(result, searchOutputShape);
    expect(sc.count).toBe(0);
    expect(sc.matches).toEqual([]);
  });
});

describe("error envelopes from outputSchema'd tools", () => {
  it("are marked isError and keep the legacy text envelope (no structuredContent)", async () => {
    // No document open → NO_DOCUMENT error from a tool with an outputSchema.
    const result = (await client.callTool({
      name: "tandem_getTextContent",
      arguments: {},
    })) as ToolResult;
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toBeUndefined();
    const envelope = textEnvelope(result) as { error: boolean; code?: string };
    expect(envelope.error).toBe(true);
    expect(envelope.code).toBe("NO_DOCUMENT");
  });

  it("checkInbox with no document degrades to a parseable NO_DOCUMENT envelope", async () => {
    const result = (await client.callTool({
      name: "tandem_checkInbox",
      arguments: {},
    })) as ToolResult;
    expect(result.isError).toBe(true);
    const envelope = textEnvelope(result) as { error: boolean; code?: string };
    expect(envelope.code).toBe("NO_DOCUMENT");
  });
});
