/**
 * MCP tool handler integration test.
 *
 * Tests that tool handlers work end-to-end through the McpServer,
 * including Zod schema validation, withErrorBoundary wrapping, and
 * mcpSuccess/mcpError response formatting.
 */

import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as Y from "yjs";
import { addDoc, removeDoc, setActiveDocId } from "../../src/server/documents/registry-testing.js";
import {
  getDeliveryState,
  recordWakeForward,
  resetDeliveryStateForTests,
} from "../../src/server/events/delivery-state.js";
import { registerAnnotationTools } from "../../src/server/mcp/annotations.js";
import { registerAwarenessTools, resetInbox } from "../../src/server/mcp/awareness.js";
import { populateYDoc, registerDocumentTools } from "../../src/server/mcp/document.js";
import { extractMarkdown, extractText } from "../../src/server/mcp/document-model.js";
import { getOpenDocs } from "../../src/server/mcp/document-service.js";
import { registerNavigationTools } from "../../src/server/mcp/navigation.js";
import {
  getBuffer as getNotificationBuffer,
  resetForTesting as resetNotifications,
} from "../../src/server/notifications.js";
import { getOrCreateDocument } from "../../src/server/yjs/provider.js";
import {
  CTRL_ROOM,
  Y_MAP_ACTIVITY,
  Y_MAP_ANNOTATIONS,
  Y_MAP_AUTHORSHIP,
  Y_MAP_MODE,
  Y_MAP_SELECTION,
  Y_MAP_USER_AWARENESS,
} from "../../src/shared/constants.js";
import { MCP_ORIGIN, withInternal } from "../../src/shared/origins.js";
import { SNAPSHOT_CAP } from "../../src/shared/snapshot.js";
import type { Annotation } from "../../src/shared/types.js";
import { range } from "../helpers/positions.js";
import { createAnnotation, rangeOf } from "../helpers/ydoc-factory.js";

let client: Client;
const sidecarTempFiles: string[] = [];

type CallToolResponse = Awaited<ReturnType<Client["callTool"]>>;

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

function parseResult(result: CallToolResponse) {
  // `result.content` is fine to read directly, but TS's deep Zod-inferred
  // union type for it blows up ("is of type 'unknown'") the moment it's
  // iterated (`.find`, `for...of`, etc.) — casting once to a plain shape
  // sidesteps that without changing what's actually in the array.
  const content = result.content as Array<{ type: string; text?: string }>;
  const textContent = content.find((c) => c.type === "text");
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
  // Clear CTRL_ROOM mode so a Solo-hold test can't bleed into the next test.
  const ctrl = getOrCreateDocument(CTRL_ROOM);
  withInternal(ctrl, () => ctrl.getMap(Y_MAP_USER_AWARENESS).delete(Y_MAP_MODE));
  client = await setupMcpClient();
});

function setMode(mode: "solo" | "tandem") {
  const ctrl = getOrCreateDocument(CTRL_ROOM);
  withInternal(ctrl, () => ctrl.getMap(Y_MAP_USER_AWARENESS).set(Y_MAP_MODE, mode));
}

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

  it("tandem_comment still honours textSnapshot after the store took over anchoring", async () => {
    // **The sibling argument to the one the heading spec below protects.**
    // `YDocStore.anchorRange(from, to, textSnapshot)` forwards three values to
    // `anchoredRange`; review pointed out that dropping the third —
    // `anchoredRange(this.#ydoc, from, to, undefined, {...})` — leaves every
    // suite green. `annotation-tools.test.ts`'s staleness spec calls
    // `verifyAndResolveRange` directly and never reaches this tool, and the
    // other `textSnapshot` assertion here is on `captureSnapshot`'s OUTPUT
    // record rather than on the drift-check input.
    //
    // Offsets name "Hello"; the snapshot names "world", which exists later in
    // the document. With the snapshot forwarded that is a RANGE_MOVED; without
    // it the call simply succeeds on the wrong span.
    setupDoc("mcp-ann-snapshot", "Hello world");

    const moved = parseResult(
      await client.callTool({
        name: "tandem_comment",
        arguments: { from: 0, to: 5, text: "on the wrong span", textSnapshot: "world" },
      }),
    );
    expect(moved.error).toBe(true);
    expect(moved.code).toBe("RANGE_MOVED");

    // The control: same tool, same document, a snapshot that MATCHES its
    // offsets must succeed — otherwise the assertion above is satisfied by a
    // tool that rejects every snapshot it is given.
    const ok = parseResult(
      await client.callTool({
        name: "tandem_comment",
        arguments: { from: 0, to: 5, text: "on Hello", textSnapshot: "Hello" },
      }),
    );
    expect(ok.error).toBe(false);
    expect(ok.data.annotationId).toMatch(/^ann_/);
  });

  it("tandem_comment refuses a range overlapping a heading prefix (Critical Rule 6)", async () => {
    // **Nothing pinned this at the handler level until ADR-035 Unit 8j-2.** The
    // only `INVALID_RANGE` assertions in the suite were in `positions.test.ts`,
    // against `validateRange` directly, with `rejectHeadingOverlap` passed by
    // the spec itself — so they measure the flag's implementation, never that a
    // caller supplies it. `document-edit.test.ts`'s "heading prefix rejection"
    // is a hand-copied mirror of `applyEdit` that its own comment admits must
    // be kept in sync, and it reaches neither `anchoredRange` nor this tool.
    //
    // That gap is why `YDocStore.anchorRange` hardcodes the flag instead of
    // taking it as a parameter: a boolean argument is the shape a later edit
    // drops with no type error and no red. This spec is the thing that would
    // have gone red, and it drives the REGISTERED tool rather than a helper.
    //
    // Flat offsets include heading markup (see the coordinate systems in
    // `positions.ts`), so `0..6` starts inside `## ` and ends inside the text.
    setupDoc("mcp-ann-heading", "## Title\n\nBody text here");

    const result = await client.callTool({
      name: "tandem_comment",
      arguments: { from: 0, to: 6, text: "on the heading" },
    });
    const parsed = parseResult(result);
    expect(parsed.error).toBe(true);
    expect(parsed.code).toBe("INVALID_RANGE");

    // **The control, and it is what makes the assertion above mean anything.**
    // `INVALID_RANGE` has several producers, so a refusal alone does not show
    // the HEADING branch fired — a wrong document, an unresolvable offset or an
    // inverted range would read identically. Same document, same tool, a range
    // that clears the prefix: it must succeed. Without this line the spec stays
    // green against a fixture that could never have been accepted at all.
    const ok = await client.callTool({
      name: "tandem_comment",
      arguments: { from: 10, to: 14, text: "on the body" },
    });
    const okParsed = parseResult(ok);
    expect(okParsed.error).toBe(false);
    expect(okParsed.data.annotationId).toMatch(/^ann_/);
  });

  it("tandem_comment records textSnapshotTruncated when the range exceeds the cap (#1486)", async () => {
    // The call site, not the helper. `captureSnapshot` returns `{text, truncated}`
    // and the handler has to spread the second half onto the annotation — a
    // one-line deletion there reverts the entire fix while every unit test of
    // `captureSnapshot` and `isSnapshotTruncated` stays green, because neither
    // of them can see whether the flag reaches the stored record.
    const body = Array.from(
      { length: 30 },
      (_, i) => `clause ${i} with wording that does not repeat.`,
    ).join(" ");
    const ydoc = setupDoc("mcp-ann-trunc", body);
    const map = ydoc.getMap<Annotation>(Y_MAP_ANNOTATIONS);

    const result = await client.callTool({
      name: "tandem_comment",
      arguments: { from: 0, to: body.length, text: "on the whole thing" },
    });
    const parsed = parseResult(result);
    expect(parsed.error).toBe(false);

    const stored = map.get(parsed.data.annotationId);
    expect(stored?.textSnapshot).toHaveLength(SNAPSHOT_CAP);
    expect(stored?.textSnapshotTruncated).toBe(true);
    // And the marker is out of band: the three characters that used to be
    // written into the user's document on undo are gone from the text itself.
    expect(stored?.textSnapshot?.endsWith("...")).toBe(false);
  });

  it("tandem_comment leaves the flag off a short range (#1486)", async () => {
    // The positive control. A handler that set the flag unconditionally would
    // satisfy the test above and refuse every undo in the product.
    const ydoc = setupDoc("mcp-ann-short", "Hello world test content");
    const map = ydoc.getMap<Annotation>(Y_MAP_ANNOTATIONS);

    const result = await client.callTool({
      name: "tandem_comment",
      arguments: { from: 0, to: 11, text: "on the greeting" },
    });
    const stored = map.get(parseResult(result).data.annotationId);
    expect(stored?.textSnapshot).toBe("Hello world");
    expect(stored?.textSnapshotTruncated).toBeUndefined();
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

  it("tandem_getAnnotations hides the user's own comment in Solo, keeps Claude's, releases on flip (WS-A2)", async () => {
    const ydoc = setupDoc("mcp-ann-solo", "Hello world test content");
    const map = ydoc.getMap(Y_MAP_ANNOTATIONS);

    // Claude comment via MCP tool (author "claude" — must stay visible in Solo).
    await client.callTool({
      name: "tandem_comment",
      arguments: { from: 0, to: 5, text: "Claude comment" },
    });
    // User comment seeded directly (browser-origin analog) — must be hidden in Solo.
    const userComment: Annotation = {
      id: "ann_user_solo",
      author: "user",
      type: "comment",
      range: range(6, 11),
      content: "my private WIP comment",
      status: "pending",
      timestamp: Date.now(),
      rev: 1,
    };
    ydoc.transact(() => map.set(userComment.id, userComment), MCP_ORIGIN);

    setMode("solo");
    const soloResult = parseResult(
      await client.callTool({ name: "tandem_getAnnotations", arguments: {} }),
    );
    expect(soloResult.error).toBe(false);
    const soloIds = soloResult.data.annotations.map((a: Annotation) => a.id);
    expect(soloIds).not.toContain("ann_user_solo"); // held
    expect(soloResult.data.annotations.some((a: Annotation) => a.author === "claude")).toBe(true);

    // Flip to Tandem — the held user comment is now visible (pull-driven release).
    setMode("tandem");
    const tandemResult = parseResult(
      await client.callTool({ name: "tandem_getAnnotations", arguments: {} }),
    );
    const tandemIds = tandemResult.data.annotations.map((a: Annotation) => a.id);
    expect(tandemIds).toContain("ann_user_solo");
  });

  it("tandem_getAnnotations fails closed after a restart mid-Solo — keeps held markers hidden (WS-A2 Phase 8)", async () => {
    // Restart mid-Solo loses the in-memory mode; the CTRL_ROOM mode key is absent
    // (beforeEach cleared it), so readModeState() is "indeterminate". The ONLY
    // thing keeping a Solo comment hidden across that restart is the PERSISTED
    // heldInSolo marker — hideFromAI(indeterminate) hides exactly the marked
    // records. A held comment must stay hidden; an ordinary (unmarked) user
    // comment must NOT be over-hidden.
    const ydoc = setupDoc("mcp-ann-restart", "Hello world test content");
    const map = ydoc.getMap(Y_MAP_ANNOTATIONS);

    const held: Annotation = {
      id: "ann_held_restart",
      author: "user",
      type: "comment",
      range: range(0, 5),
      content: "held across restart",
      status: "pending",
      timestamp: Date.now(),
      rev: 1,
      heldInSolo: true,
    };
    const ordinary: Annotation = {
      id: "ann_ordinary_restart",
      author: "user",
      type: "comment",
      range: range(6, 11),
      content: "ordinary comment",
      status: "pending",
      timestamp: Date.now(),
      rev: 1,
    };
    ydoc.transact(() => {
      map.set(held.id, held);
      map.set(ordinary.id, ordinary);
    }, MCP_ORIGIN);

    // No setMode call → mode key absent → indeterminate (the restart state).
    const result = parseResult(
      await client.callTool({ name: "tandem_getAnnotations", arguments: {} }),
    );
    expect(result.error).toBe(false);
    const ids = result.data.annotations.map((a: Annotation) => a.id);
    expect(ids).not.toContain("ann_held_restart"); // fail-closed: stays hidden
    expect(ids).toContain("ann_ordinary_restart"); // unmarked → not over-hidden
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
      range: range(6, 11),
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
      range: range(6, 11),
      content: "[Reviewer] Reword this",
      status: "pending",
      timestamp: Date.now(),
      rev: 1,
    };
    const imported2: Annotation = {
      id: "imp_2",
      author: "import",
      type: "comment",
      range: range(12, 16),
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

  // #1654: this is the caller-named POSITIVE CONTROL for the suffix pin -- the
  // fixture name is `.annotations.json` deliberately, not incidentally. Without
  // it, a pin that refuses every caller-named path satisfies all the negatives
  // in `export-path-canonicalization.test.ts`. Do not "tidy" the suffix away.
  it("honors a custom outputPath", async () => {
    const docPath = uniqueDocPath();
    const customPath = join(
      tmpdir(),
      `tandem-custom-${Date.now()}-${Math.random().toString(36).slice(2)}.annotations.json`,
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
  function rawErrorText(result: CallToolResponse) {
    const content = result.content as Array<{ type: string; text?: string }>;
    const textContent = content.find((c) => c.type === "text");
    return textContent?.text ?? "";
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
    const expectedFile = join(targetDir, `${basename(docPath)}.annotations.json`);

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

  it("tandem_getActivity reports seeded typing activity, and nothing when there is none", async () => {
    // **This handler had no behavioural spec at all before Unit 8j-2.** Only
    // `license-gate-coverage.test.ts` named `tandem_getActivity`, and that
    // walks registration sites — it would pass against any handler body. The
    // unit repointed this one off a hand-rolled
    // `getOrCreateDocument(...).getMap(Y_MAP_USER_AWARENESS)` read onto
    // `store.getUserAwareness()`, which is a resolution path (equivalent by
    // construction: `getDocumentStore` IS `getCurrentDoc` +
    // `getOrCreateDocument`) that nothing would have reported breaking.
    //
    // Seeded on the DOCUMENT's map, not `CTRL_ROOM`'s: awareness is
    // per-document, unlike mode.
    const ydoc = setupDoc("mcp-aw-activity", "Hello world");
    withInternal(ydoc, () =>
      ydoc.getMap(Y_MAP_USER_AWARENESS).set(Y_MAP_ACTIVITY, {
        isTyping: true,
        cursor: 7,
        lastEdit: Date.now(),
      }),
    );

    const result = await client.callTool({
      name: "tandem_getActivity",
      arguments: {},
    });
    const parsed = parseResult(result);
    expect(parsed.error).toBe(false);
    expect(parsed.data.active).toBe(true);
    expect(parsed.data.isTyping).toBe(true);
    expect(parsed.data.cursor).toBe(7);

    // The control: a document with an empty awareness map takes the other
    // branch. Without it, a handler that returned a constant `active: true`
    // would satisfy every assertion above. `setupDoc` also makes THIS the
    // active document, so the seeded one is now reachable only by id.
    setupDoc("mcp-aw-activity-empty", "Hello world");
    const empty = parseResult(await client.callTool({ name: "tandem_getActivity", arguments: {} }));
    expect(empty.error).toBe(false);
    expect(empty.data.active).toBe(false);
    expect(empty.data.cursor).toBe(null);

    // **And the `documentId` argument must still route.** The handler was
    // repointed from a hand-rolled `getCurrentDoc(documentId)` +
    // `getOrCreateDocument(...)` pair onto `getDocumentStore(documentId)`;
    // dropping the argument (`getDocumentStore()`) collapses every call to the
    // active document, which the two assertions above cannot tell apart.
    const byId = parseResult(
      await client.callTool({
        name: "tandem_getActivity",
        arguments: { documentId: "mcp-aw-activity" },
      }),
    );
    expect(byId.error).toBe(false);
    expect(byId.data.active).toBe(true);
    expect(byId.data.cursor).toBe(7);
  });

  it("tandem_checkInbox refreshes every unsurfaced annotation in ONE mcp-tagged transaction", async () => {
    // **This is the only spec that observes Unit 8j-2's A2 at the handler.**
    // The batch spec in `awareness-tools.test.ts` drives the exported function
    // with a fake refresher; the transaction spec in `document-store.test.ts`
    // drives the store method. Neither can see the wiring between them — so
    // restoring the master-shaped inline loop in the handler and refreshing per
    // item left all of them green, with N transactions instead of one and the
    // duplication A2 removed back in place.
    const ydoc = setupDoc("mcp-inbox-txn", "Hello world content here");
    const map = ydoc.getMap(Y_MAP_ANNOTATIONS);
    const first = createAnnotation(map, ydoc, "comment", rangeOf(6, 11, ydoc), "on world", {
      author: "user",
    });
    const second = createAnnotation(map, ydoc, "comment", rangeOf(12, 19, ydoc), "on content", {
      author: "user",
    });

    // Shift both anchors so the refresh must actually WRITE. Without this the
    // refresh is a no-op, the observer never fires, and an empty origin list
    // would satisfy a "not more than one transaction" reading for the wrong
    // reason.
    const frag = ydoc.getXmlFragment("default");
    const para = frag.get(0) as Y.XmlElement;
    const xtext = para.get(0) as Y.XmlText;
    withInternal(ydoc, () => xtext.insert(0, "XXX "));

    const origins: unknown[] = [];
    const observer = (events: Array<Y.YEvent<any>>, txn: Y.Transaction) => {
      const touched = events.some((e) =>
        [...e.changes.keys.keys()].some((k) => k === first || k === second),
      );
      if (touched) origins.push(txn.origin);
    };
    map.observeDeep(observer);
    try {
      const parsed = parseResult(
        await client.callTool({ name: "tandem_checkInbox", arguments: {} }),
      );
      expect(parsed.error).toBe(false);
      expect(parsed.data.userActions.map((a: { id: string }) => a.id)).toStrictEqual([
        first,
        second,
      ]);
    } finally {
      map.unobserveDeep(observer);
    }

    expect(origins, "one batch, tagged mcp — not one transaction per annotation").toStrictEqual([
      MCP_ORIGIN,
    ]);
  });

  it("tandem_checkInbox reports the user's live selection", async () => {
    // `getUserAwareness()`'s `selection` half is written by this unit and was
    // read by nothing in the suite: swapping its key for `Y_MAP_ACTIVITY`, or
    // returning `undefined` outright, stayed green everywhere while
    // `tandem_checkInbox` silently stopped telling Claude what the user has
    // highlighted.
    const ydoc = setupDoc("mcp-inbox-selection", "Hello world");
    withInternal(ydoc, () =>
      ydoc
        .getMap(Y_MAP_USER_AWARENESS)
        .set(Y_MAP_SELECTION, { from: 6, to: 11, timestamp: Date.now() }),
    );

    const parsed = parseResult(await client.callTool({ name: "tandem_checkInbox", arguments: {} }));
    expect(parsed.error).toBe(false);
    expect(parsed.data.activity.selectedText).toBe("world");
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

// #979 — append structured content + seed empty docs.
describe("MCP tool integration — tandem_appendContent (#979)", () => {
  it("seeds an empty document with real block structure", async () => {
    const ydoc = setupDoc("append-empty", "");
    expect(ydoc.getXmlFragment("default").length).toBe(0);

    const result = await client.callTool({
      name: "tandem_appendContent",
      arguments: { content: "# Title\n\n- a\n- b\n\nClosing para" },
    });
    const parsed = parseResult(result);
    expect(parsed.error).toBe(false);
    // heading + bulletList + paragraph = 3 top-level blocks
    expect(parsed.data.appended).toBe(true);
    expect(parsed.data.blockCount).toBeGreaterThanOrEqual(3);

    const outline = parseResult(
      await client.callTool({ name: "tandem_getOutline", arguments: {} }),
    );
    expect(outline.data.outline.some((h: { text: string }) => h.text === "Title")).toBe(true);

    const text = parseResult(
      await client.callTool({ name: "tandem_getTextContent", arguments: {} }),
    ).data.text;
    expect(text).toContain("# Title");
    expect(text).toContain("a");
    expect(text).toContain("b");
    expect(text).toContain("Closing para");
  });

  it("appends without disturbing an annotation on the pre-existing last block", async () => {
    const ydoc = setupDoc("append-preserve", "Hello world\n\nSecond block");
    const map = ydoc.getMap(Y_MAP_ANNOTATIONS);
    // "Second block" occupies flat offsets [13, 25] (see extractText layout).
    expect(extractText(ydoc).slice(13, 25)).toBe("Second block");
    const annId = createAnnotation(map, ydoc, "comment", rangeOf(13, 25, ydoc), "on last block");

    await client.callTool({
      name: "tandem_appendContent",
      arguments: { content: "## Appended\n\nNew tail." },
    });

    // Annotation survives and its range still resolves to the same text.
    const ann = map.get(annId) as { range: { from: number; to: number } } | undefined;
    expect(ann).toBeDefined();
    if (ann) {
      expect(extractText(ydoc).slice(ann.range.from, ann.range.to)).toBe("Second block");
    }
  });

  it("stamps only the appended blocks as Claude authorship, preserving earlier authorship", async () => {
    const ydoc = setupDoc("append-authorship", "Existing para");
    const authMap = ydoc.getMap(Y_MAP_AUTHORSHIP);
    // Pre-existing user authorship on block 0 must NOT be overwritten/re-stamped.
    authMap.set("user-pre", {
      id: "user-pre",
      author: "user",
      range: rangeOf(0, 13, ydoc).range,
      timestamp: Date.now(),
    });

    await client.callTool({
      name: "tandem_appendContent",
      arguments: { content: "# New" },
    });

    // The user entry is untouched.
    expect((authMap.get("user-pre") as { author: string }).author).toBe("user");

    // Exactly one new Claude entry, anchored over the APPENDED text ("New"),
    // NOT over the pre-existing "Existing para" (the flatCursor-priming bug).
    const claudeEntries = [...authMap.values()].filter(
      (e): e is { author: string; range: { from: number; to: number } } =>
        (e as { author?: string }).author === "claude",
    );
    expect(claudeEntries).toHaveLength(1);
    const full = extractText(ydoc);
    expect(full.slice(claudeEntries[0].range.from, claudeEntries[0].range.to)).toBe("New");
  });

  it("treats whitespace-only content as a no-op", async () => {
    const ydoc = setupDoc("append-blank", "Keep me");
    const before = extractText(ydoc);
    const parsed = parseResult(
      await client.callTool({ name: "tandem_appendContent", arguments: { content: "   \n\n  " } }),
    );
    expect(parsed.error).toBe(false);
    expect(parsed.data.blockCount).toBe(0);
    expect(extractText(ydoc)).toBe(before);
  });

  it("appends a code block as a real block", async () => {
    setupDoc("append-code", "");
    const parsed = parseResult(
      await client.callTool({
        name: "tandem_appendContent",
        arguments: { content: "```js\nconst x = 1;\n```" },
      }),
    );
    expect(parsed.error).toBe(false);
    expect(parsed.data.blockCount).toBeGreaterThanOrEqual(1);
    const text = parseResult(
      await client.callTool({ name: "tandem_getTextContent", arguments: {} }),
    ).data.text;
    expect(text).toContain("const x = 1;");
  });

  it("rejects read-only documents", async () => {
    const ydoc = getOrCreateDocument("append-ro");
    populateYDoc(ydoc, "read only");
    addDoc("append-ro", {
      id: "append-ro",
      filePath: "/tmp/append-ro.docx",
      format: "docx",
      readOnly: true,
      source: "file",
    });
    setActiveDocId("append-ro");

    const parsed = parseResult(
      await client.callTool({ name: "tandem_appendContent", arguments: { content: "# nope" } }),
    );
    expect(parsed.error).toBe(true);
    expect(parsed.code).toBe("FORMAT_ERROR");
  });

  it("rejects non-markdown documents", async () => {
    const ydoc = getOrCreateDocument("append-txt");
    populateYDoc(ydoc, "plain text");
    addDoc("append-txt", {
      id: "append-txt",
      filePath: "/tmp/append-txt.txt",
      format: "txt",
      readOnly: false,
      source: "file",
    });
    setActiveDocId("append-txt");

    const parsed = parseResult(
      await client.callTool({ name: "tandem_appendContent", arguments: { content: "# nope" } }),
    );
    expect(parsed.error).toBe(true);
    expect(parsed.code).toBe("FORMAT_ERROR");
  });
});

describe("MCP tool integration — tandem_scratchpad content seeding (#979)", () => {
  it("seeds a new scratchpad with structured content", async () => {
    const created = parseResult(
      await client.callTool({
        name: "tandem_scratchpad",
        arguments: { content: "# H\n\n- a\n- b" },
      }),
    );
    expect(created.error).toBe(false);
    expect(created.data.documentId).toBeTruthy();

    // openScratchpad sets the new doc active, so getOutline targets it.
    const outline = parseResult(
      await client.callTool({ name: "tandem_getOutline", arguments: {} }),
    );
    expect(outline.data.outline.some((h: { text: string }) => h.text === "H")).toBe(true);

    // Scratchpad content is deliberately NOT authorship-stamped (ephemeral).
    const ydoc = getOrCreateDocument(created.data.documentId);
    expect(ydoc.getMap(Y_MAP_AUTHORSHIP).size).toBe(0);
  });
});

describe("MCP tool integration — tandem_edit empty-doc guidance (#979)", () => {
  it("returns EMPTY_DOCUMENT pointing at the seeding path", async () => {
    setupDoc("edit-empty", "");
    const parsed = parseResult(
      await client.callTool({
        name: "tandem_edit",
        arguments: { from: 0, to: 0, newText: "x" },
      }),
    );
    expect(parsed.error).toBe(true);
    expect(parsed.code).toBe("EMPTY_DOCUMENT");
    expect(parsed.message).toContain("tandem_appendContent");
  });
});

/**
 * `tandem_edit` refuses a newline in a plaintext document (#1460, surface 3).
 *
 * The AI is the fourth producer of an unrepresentable break. `.txt` and every
 * other format routed through `plaintextAdapter` spell a paragraph boundary and
 * an intra-paragraph break identically as `"\n"`, so a newline inserted inside a
 * paragraph reopens as two paragraphs — the model and the bytes disagree and the
 * bytes win.
 *
 * It REFUSES rather than splitting. `tandem_edit` is documented and shaped as a
 * single-paragraph replacement, and `RANGE_MOVED`'s retry contract assumes the
 * range stays inside one block; silently turning one call into a structural
 * split would break that for a caller that cannot see it happened.
 *
 * Driven through the real McpServer, not a replica of the handler: the claim is
 * about where the guard sits relative to the readOnly check and the mutation, and
 * a hand-rolled copy of the branch would pass with the guard deleted from the
 * tool.
 */
describe("tandem_edit — plaintext newline guard (#1460)", () => {
  /** Same as `setupDoc` but with the format under test. */
  function setupPlaintextDoc(id: string, text: string, format: string) {
    const ydoc = getOrCreateDocument(id);
    populateYDoc(ydoc, text);
    addDoc(id, {
      id,
      filePath: `/tmp/${id}.${format}`,
      format,
      readOnly: false,
      source: "file",
    });
    setActiveDocId(id);
    return ydoc;
  }

  it("rejects a newline in a .txt document and leaves the text untouched", async () => {
    const ydoc = setupPlaintextDoc("edit-txt-nl", "alpha bravo", "txt");
    const parsed = parseResult(
      await client.callTool({
        name: "tandem_edit",
        arguments: { from: 0, to: 5, newText: "one\ntwo" },
      }),
    );

    expect(parsed.error).toBe(true);
    expect(parsed.code).toBe("INVALID_ARGUMENT");
    expect(parsed.message).toContain("txt");
    // The remedy has to be in the message: the AI cannot see the format.
    expect(parsed.message).toContain("tandem_edit per line");
    // tandem_appendContent is not a valid fallback — it refuses non-markdown
    // documents outright, so suggesting it here is a dead end (#1460 review).
    expect(parsed.message).not.toContain("tandem_appendContent");
    expect(extractText(ydoc), "refused, not partially applied").toBe("alpha bravo");
  });

  it("rejects a bare CR too", async () => {
    // `\r` alone is a line ending on classic Mac files, and `toLf` collapses it —
    // so it reaches the file as a break exactly like `\n` would.
    setupPlaintextDoc("edit-txt-cr", "alpha bravo", "txt");
    const parsed = parseResult(
      await client.callTool({
        name: "tandem_edit",
        arguments: { from: 0, to: 5, newText: "one\rtwo" },
      }),
    );
    expect(parsed.code).toBe("INVALID_ARGUMENT");
  });

  it("covers every plaintext-routed format, not just .txt", async () => {
    // The defect lives in the LOADER, and `getAdapter` falls back to
    // `plaintextAdapter` for anything that is not `md` or `docx` — so `html`,
    // `log`, `csv` and unknown extensions are all exposed. A guard keyed on the
    // literal string "txt" would have looked correct and covered one of them.
    for (const format of ["html", "log", "csv", "conf"]) {
      setupPlaintextDoc(`edit-${format}-nl`, "alpha bravo", format);
      const parsed = parseResult(
        await client.callTool({
          name: "tandem_edit",
          arguments: { from: 0, to: 5, newText: "one\ntwo" },
        }),
      );
      expect(parsed.code, format).toBe("INVALID_ARGUMENT");
    }
  });

  it("ALLOWS a newline in markdown — the negative control", async () => {
    // Without this the guard could be rejecting every newline everywhere and the
    // three tests above would all still pass. Markdown can represent an
    // intra-paragraph break, so this one must go through.
    const ydoc = setupPlaintextDoc("edit-md-nl", "alpha bravo", "md");
    const parsed = parseResult(
      await client.callTool({
        name: "tandem_edit",
        arguments: { from: 0, to: 5, newText: "one\ntwo" },
      }),
    );
    expect(parsed.error).toBeFalsy();
    expect(extractText(ydoc)).toBe("one\ntwo bravo");
  });

  it("ALLOWS a newline-free edit in .txt — the other control", async () => {
    const ydoc = setupPlaintextDoc("edit-txt-plain", "alpha bravo", "txt");
    const parsed = parseResult(
      await client.callTool({
        name: "tandem_edit",
        arguments: { from: 0, to: 5, newText: "one" },
      }),
    );
    expect(parsed.error).toBeFalsy();
    expect(extractText(ydoc)).toBe("one bravo");
  });
});

/**
 * The delivery-state join's pull half (Track B-1).
 *
 * Driven through the real McpServer rather than by calling the recorder
 * directly, because the fact under test is a property of WHERE the call sits in
 * `tandem_checkInbox`'s body — a unit test of `recordInboxPoll` would pass with
 * the call deleted from the tool entirely.
 */
describe("checkInbox stamps the pull path", () => {
  beforeEach(resetDeliveryStateForTests);
  afterEach(resetDeliveryStateForTests);

  it("records a poll when the tool dispatches", async () => {
    setupDoc("inbox-poll-doc", "Hello world");
    expect(getDeliveryState(Date.now(), 1).pollCount).toBe(0);

    await client.callTool({ name: "tandem_checkInbox", arguments: {} });

    const state = getDeliveryState(Date.now(), 1);
    expect(state.pollCount).toBe(1);
    // `sincePollMs`, not `lastPollAt` — the latter is a module-local, absent
    // from the exported `DeliveryState`, so asserting on it read as pinning the
    // timestamp while comparing `undefined` to null and passing for every
    // possible behaviour of `recordInboxPoll`. Nothing catches that: tsconfig
    // includes only `src/**`, and vitest strips types.
    expect(state.sincePollMs).not.toBeNull();
  });

  it("records a poll even when no document is open", async () => {
    // The ordering decision, pinned. `recordInboxPoll` sits ABOVE the
    // `noDocumentError` guard because the fact being recorded is "a model
    // reached for the inbox" — the only signal here written by a model rather
    // than by a transport — and that is equally true when the poll lands on a
    // closed document. Below the guard, the pull path would read as dead during
    // exactly the window a user is most likely to be told that it is.
    setActiveDocId(null);

    await client.callTool({ name: "tandem_checkInbox", arguments: {} });

    expect(getDeliveryState(Date.now(), 1).pollCount).toBe(1);
  });

  it("clears an outstanding forward, closing the join", async () => {
    setupDoc("inbox-join-doc", "Hello world");
    recordWakeForward(1_000);
    expect(getDeliveryState(1_500, 1).state).toBe("awaiting-poll");

    await client.callTool({ name: "tandem_checkInbox", arguments: {} });

    expect(getDeliveryState(Date.now(), 1).state).toBe("polled");
  });

  it("does NOT close the join when the tool bails out on a closed document", async () => {
    // The other half of the split, through the real tool rather than the
    // recorder: a poll that returns `noDocumentError` marked nothing read, so
    // the user's message is still unseen and the round must stay open. Driven
    // here rather than as a unit test because the fact under test is WHERE the
    // two calls sit relative to the document guard.
    setActiveDocId(null);
    recordWakeForward(1_000);

    await client.callTool({ name: "tandem_checkInbox", arguments: {} });

    const state = getDeliveryState(Date.now(), 1);
    expect(state.state).toBe("awaiting-poll");
    expect(state.latencyMs).toBeNull();
    expect(state.pollCount).toBe(1); // liveness still stamped
  });
});
