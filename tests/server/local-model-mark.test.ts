/**
 * The local model's records are marked for Claude (#1123, ADR-039 item 31,
 * F1): `tandem_getAnnotations` and `tandem_exportAnnotations` carry
 * `byLocalModel: true` on a `claude`-authored record or reply that carries the
 * local model's `agentIdentity` stamp, and only once local-period records are
 * honoured (never while `BYO_MODELS_ENABLED` is off).
 *
 * The output schema is fixed at registration and the field is derived per
 * call, so every case sets the honour seam BEFORE `setupMcpServer` (`start`)
 * and resets it after. A seam flipped after the server was built would derive
 * the field and then strip it, or the reverse.
 *
 * Everything is read through the real MCP output — `structuredContent` and the
 * text part both — with a validating client (`listTools()` first).
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as Y from "yjs";

// Real fs.watch leaks handles and races the tests' own writes.
vi.mock(import("../../src/server/file-watcher"), async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/server/file-watcher")>()),
  watchFile: vi.fn(),
  unwatchFile: vi.fn(),
}));

import { addDoc, removeDoc, setActiveDocId } from "../../src/server/documents/registry-testing.js";
import { registerAnnotationTools } from "../../src/server/mcp/annotations.js";
import { registerAwarenessTools, resetInbox } from "../../src/server/mcp/awareness.js";
import { populateYDoc } from "../../src/server/mcp/document.js";
import { getOpenDocs } from "../../src/server/mcp/document-service.js";
import {
  __resetLocalPeriodForTests,
  __setHonourLocalPeriodRecordsForTests,
} from "../../src/server/models/local-period.js";
import { resetOwnershipForTests } from "../../src/server/sessions/ownership.js";
import { getOrCreateDocument, removeDocument } from "../../src/server/yjs/provider.js";
import { Y_MAP_ANNOTATION_REPLIES, Y_MAP_ANNOTATIONS } from "../../src/shared/constants.js";
import { withBrowser, withMcp } from "../../src/shared/origins.js";
import { setCtrlMode } from "../helpers/ctrl-mode.js";
import { setupMcpServer } from "../helpers/mcp-harness.js";
import { ownershipTestDispatch, registerTestCallerRecord } from "../helpers/ownership-caller.js";

// Flag on (the ownership job), a read by a caller with no record reads nothing.
registerTestCallerRecord();

const DOC_TEXT = "Alpha paragraph text for the mark.\n\nBeta paragraph follows here.\n";
const STAMP = { provider: "ollama", displayName: "My local helper" };

type Item = Record<string, unknown>;

let tmpDir: string;
let docId: string;
let filePath: string;
let ydoc: Y.Doc;
let client: Client | undefined;
let close: (() => Promise<void>) | undefined;
let run = 0;

beforeEach(() => {
  run++;
  resetInbox();
  // No `resetOwnershipForTests()` here: it would wipe the test caller's
  // record that `registerTestCallerRecord()` installs in its own `beforeEach`,
  // and with ownership on a poll would then read no document. `afterEach`
  // resets it.
  __resetLocalPeriodForTests();
  setCtrlMode("tandem");
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "tandem-local-model-mark-"));
  filePath = path.join(tmpDir, "doc.md");
  fs.writeFileSync(filePath, DOC_TEXT);
  docId = `lmmark${run}`;
  ydoc = getOrCreateDocument(docId);
  populateYDoc(ydoc, DOC_TEXT);
  addDoc(docId, { id: docId, filePath, format: "md", readOnly: false, source: "file" });
  setActiveDocId(docId);
});

afterEach(async () => {
  await close?.();
  close = undefined;
  client = undefined;
  for (const id of [...getOpenDocs().keys()]) removeDoc(id);
  removeDocument(docId);
  setActiveDocId(null);
  __setHonourLocalPeriodRecordsForTests(null);
  __resetLocalPeriodForTests();
  resetOwnershipForTests();
  setCtrlMode(null);
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

/** Set the honour seam, THEN build the server, so the registration sees it. */
async function start(lit: boolean): Promise<void> {
  __setHonourLocalPeriodRecordsForTests(lit);
  ({ client, close } = await setupMcpServer([registerAwarenessTools, registerAnnotationTools], {
    dispatch: ownershipTestDispatch,
  }));
  await client.listTools();
}

function record(id: string, author: "user" | "claude", extra: Item = {}): Item {
  return {
    id,
    author,
    type: "comment",
    audience: "outbound",
    range: { from: 0, to: 5 },
    content: `content of ${id}`,
    status: "pending",
    timestamp: 1_700_000_000_000,
    rev: 1,
    ...extra,
  };
}

function writeAnnotation(rec: Item): void {
  const write = rec.author === "user" ? withBrowser : withMcp;
  write(ydoc, () => ydoc.getMap(Y_MAP_ANNOTATIONS).set(rec.id as string, rec));
}

function writeReply(
  id: string,
  annotationId: string,
  author: "user" | "claude",
  extra: Item = {},
): void {
  const reply = {
    id,
    annotationId,
    author,
    text: `text of ${id}`,
    timestamp: 1_700_000_001_000,
    rev: 1,
    ...extra,
  };
  const write = author === "user" ? withBrowser : withMcp;
  write(ydoc, () => ydoc.getMap(Y_MAP_ANNOTATION_REPLIES).set(id, reply));
}

/**
 * The fixture both sides of every case read:
 * - `lm-comment`: the local model's comment (stamped, `claude`) — marked;
 * - `claude-parent`: Claude's own comment, carrying a local-model reply
 *   (stamped, `claude`) — marked — and a Claude reply — not;
 * - `user-parent`: the user's comment carrying a local-model reply — marked.
 */
function markedFixture(): void {
  writeAnnotation(record("lm-comment", "claude", { agentIdentity: STAMP }));
  writeAnnotation(record("claude-parent", "claude"));
  writeReply("lm-reply", "claude-parent", "claude", { agentIdentity: STAMP });
  writeReply("claude-reply", "claude-parent", "claude");
  writeAnnotation(record("user-parent", "user"));
  writeReply("lm-reply-on-user", "user-parent", "claude", { agentIdentity: STAMP });
}

/** Forged stamps: on a user comment and on a user reply. Never marked. */
function forgedFixture(): void {
  writeAnnotation(record("user-stamped", "user", { agentIdentity: STAMP }));
  writeAnnotation(record("claude-parent-2", "claude"));
  writeReply("user-stamped-reply", "claude-parent-2", "user", { agentIdentity: STAMP });
}

async function callTool(name: string, args: Item): Promise<Item> {
  if (!client) throw new Error("start() first");
  const result = (await client.callTool({ name, arguments: args })) as {
    isError?: boolean;
    structuredContent?: Item;
    content: Array<{ type: string; text?: string }>;
  };
  expect(result.isError ?? false, JSON.stringify(result)).toBe(false);
  const envelope = JSON.parse(result.content.find((c) => c.type === "text")?.text ?? "null") as {
    error: boolean;
    data: Item;
  };
  expect(envelope.error).toBe(false);
  if (result.structuredContent !== undefined) {
    expect(envelope.data, "the text part agrees with structuredContent").toEqual(
      result.structuredContent,
    );
  }
  return envelope.data;
}

async function getAnnotations(): Promise<Item[]> {
  const data = await callTool("tandem_getAnnotations", { documentId: docId });
  return data.annotations as Item[];
}

/** id → whether it carries `byLocalModel: true`, over annotations and replies. */
function marks(annotations: Item[]): Record<string, boolean> {
  const out: Record<string, boolean> = {};
  const visit = (item: Item) => {
    expect("agentIdentity" in item, `${String(item.id)} carries no agentIdentity`).toBe(false);
    if ("byLocalModel" in item) expect(item.byLocalModel).toBe(true);
    out[item.id as string] = item.byLocalModel === true;
  };
  for (const a of annotations) {
    visit(a);
    for (const r of (a.replies as Item[] | undefined) ?? []) visit(r);
  }
  return out;
}

async function getAnnotationsTool() {
  if (!client) throw new Error("start() first");
  const { tools } = await client.listTools();
  const tool = tools.find((t) => t.name === "tandem_getAnnotations");
  if (!tool) throw new Error("tandem_getAnnotations is not listed");
  return tool;
}

describe("tandem_getAnnotations: the local-model mark (lit)", () => {
  it("marks only the stamped claude records and replies; none carries agentIdentity", async () => {
    await start(true);
    markedFixture();

    const got = marks(await getAnnotations());

    expect(got).toEqual({
      "lm-comment": true,
      "claude-parent": false,
      "lm-reply": true,
      "claude-reply": false,
      "user-parent": false,
      "lm-reply-on-user": true,
    });
  });

  it("advertises byLocalModel (const true) on annotation and reply items", async () => {
    await start(true);
    const tool = await getAnnotationsTool();
    type Obj = { properties: Record<string, Item> };
    const schema = tool.outputSchema as unknown as {
      properties: { annotations: { items: Obj & { properties: { replies: { items: Obj } } } } };
    };
    const item = schema.properties.annotations.items;
    expect(item.properties.byLocalModel).toMatchObject({ const: true });
    expect(item.properties.replies.items.properties.byLocalModel).toMatchObject({ const: true });
    expect(item.properties.agentIdentity, "the stamp itself is never declared").toBeUndefined();
  });

  it("a forged stamp on a user comment or user reply marks nothing", async () => {
    await start(true);
    forgedFixture();

    const got = marks(await getAnnotations());

    expect(got).toEqual({
      "user-stamped": false,
      "claude-parent-2": false,
      "user-stamped-reply": false,
    });
  });

  it("a claude record with a malformed stamp (bad provider, 500-char displayName) still succeeds and is marked", async () => {
    await start(true);
    writeAnnotation(
      record("bad-stamp", "claude", {
        agentIdentity: { provider: "not-a-provider", displayName: "x".repeat(500) },
      }),
    );

    const annotations = await getAnnotations();

    expect(marks(annotations)).toEqual({ "bad-stamp": true });
    expect(JSON.stringify(annotations)).not.toContain("x".repeat(500));
  });
});

describe("tandem_getAnnotations: a byLocalModel key stored on a record is never the mark (lit)", () => {
  it("a stored true on a user comment or user reply marks nothing; a stored false fails nothing", async () => {
    await start(true);
    writeAnnotation(record("user-stored", "user", { byLocalModel: true }));
    writeAnnotation(record("claude-parent-3", "claude", { byLocalModel: false }));
    writeReply("user-reply-stored", "claude-parent-3", "user", { byLocalModel: true });
    writeReply("claude-reply-false", "claude-parent-3", "claude", { byLocalModel: false });
    writeReply("lm-reply-false", "claude-parent-3", "claude", {
      byLocalModel: false,
      agentIdentity: STAMP,
    });

    const got = marks(await getAnnotations());

    expect(got).toEqual({
      "user-stored": false,
      "claude-parent-3": false,
      "user-reply-stored": false,
      "claude-reply-false": false,
      "lm-reply-false": true,
    });
  });

  it("export: a stored key neither marks nor labels a user record or reply, lit", async () => {
    await start(true);
    writeAnnotation(record("claude-parent-4", "claude"));
    writeReply("user-reply-stored-2", "claude-parent-4", "user", { byLocalModel: true });
    writeAnnotation(record("user-stored-2", "user", { byLocalModel: true }));

    const json = await callTool("tandem_exportAnnotations", { documentId: docId, format: "json" });
    expect(JSON.stringify(json)).not.toContain("byLocalModel");
    const md = (
      await callTool("tandem_exportAnnotations", { documentId: docId, format: "markdown" })
    ).markdown as string;
    expect(md).not.toContain("Local model");
  });
});

describe("tandem_getAnnotations: dark (honour seam off)", () => {
  it("no item carries byLocalModel, and the tool's schema and description are master's", async () => {
    await start(false);
    markedFixture();
    forgedFixture();

    const annotations = await getAnnotations();

    expect(Object.values(marks(annotations)).some(Boolean)).toBe(false);
    expect(JSON.stringify(annotations)).not.toContain("byLocalModel");

    // Master's bytes, frozen: `tools/list`'s tandem_getAnnotations as
    // origin/master 3da09da8 served it (identical with ownership on and off).
    const tool = await getAnnotationsTool();
    const frozen = JSON.parse(
      fs.readFileSync(
        path.join(process.cwd(), "tests/fixtures/local-period/master-getannotations-tool.json"),
        "utf8",
      ),
    ) as { description: string; outputSchema: unknown };
    expect(tool.description).toBe(frozen.description);
    expect(tool.outputSchema).toEqual(frozen.outputSchema);
  });
});

describe("tandem_checkInbox: no item is marked (lit)", () => {
  it("no inbox item carries byLocalModel or agentIdentity", async () => {
    await start(true);
    markedFixture();
    forgedFixture();
    // A user reply on Claude's own comment and an accepted Claude comment, so
    // the reply and response buckets hold something.
    writeReply("user-reply", "claude-parent", "user");
    writeAnnotation(record("claude-accepted", "claude", { status: "accepted" }));

    const data = await callTool("tandem_checkInbox", { cursor: "start" });

    const text = JSON.stringify(data);
    expect(text).not.toContain("byLocalModel");
    expect(text).not.toContain("agentIdentity");
    const ids = (bucket: string) => ((data[bucket] as Item[]) ?? []).map((i) => i.id);
    // The inbox holds something, so the absence above is not vacuous.
    expect(ids("userActions")).toContain("user-parent");
  });
});

describe("tandem_exportAnnotations: the mark (#1123 item 31, R1.3)", () => {
  async function exportAs(format: "json" | "markdown", writeToDisk = false) {
    return callTool("tandem_exportAnnotations", { documentId: docId, format, writeToDisk });
  }

  it("lit, JSON: stamped claude records and replies carry byLocalModel; stamped user ones do not", async () => {
    await start(true);
    markedFixture();
    forgedFixture();

    const data = await exportAs("json");

    const got: Record<string, boolean> = {};
    for (const a of data.annotations as Item[]) {
      got[a.id as string] = a.byLocalModel === true;
      for (const r of (a.replies as Item[]) ?? []) got[r.id as string] = r.byLocalModel === true;
    }
    expect(got).toEqual({
      "lm-comment": true,
      "claude-parent": false,
      "lm-reply": true,
      "claude-reply": false,
      "user-parent": false,
      "lm-reply-on-user": true,
      "user-stamped": false,
      "claude-parent-2": false,
      "user-stamped-reply": false,
    });
  });

  it('lit, markdown: "Local model" for stamped claude records and replies only; never the display name', async () => {
    await start(true);
    markedFixture();
    forgedFixture();

    const md = (await exportAs("markdown")).markdown as string;

    const lines = md.split("\n");
    const itemLine = (id: string) => {
      const i = lines.findIndex((l) => l.includes(`content of ${id}`));
      expect(i, `${id} is in the export`).toBeGreaterThan(0);
      // The byline is the item's first line, two lines above its content.
      return lines[i - 2];
    };
    const replyLine = (id: string) => lines.find((l) => l.includes(`text of ${id}`)) ?? "";
    expect(itemLine("lm-comment")).toMatch(/\(Local model\)$/);
    expect(itemLine("claude-parent")).toMatch(/\(Assistant\)$/);
    expect(itemLine("user-parent")).toMatch(/\(You\)$/);
    expect(itemLine("user-stamped")).toMatch(/\(You\)$/);
    expect(replyLine("lm-reply")).toMatch(/^\s+- Local model: /);
    expect(replyLine("claude-reply")).toMatch(/^\s+- Assistant: /);
    expect(replyLine("lm-reply-on-user")).toMatch(/^\s+- Local model: /);
    expect(replyLine("user-stamped-reply")).toMatch(/^\s+- You: /);
    expect(md).not.toContain(STAMP.displayName);
  });

  it("dark: neither format nor the sidecar carries byLocalModel or 'Local model'", async () => {
    await start(false);
    markedFixture();
    forgedFixture();

    const json = await exportAs("json", true);
    const md = await exportAs("markdown", true);

    for (const out of [JSON.stringify(json), JSON.stringify(md)]) {
      expect(out).not.toContain("byLocalModel");
      expect(out).not.toContain("Local model");
    }
    for (const ext of ["json", "md"]) {
      const sidecar = fs.readFileSync(`${filePath}.annotations.${ext}`, "utf8");
      expect(sidecar).not.toContain("byLocalModel");
      expect(sidecar).not.toContain("Local model");
    }
    expect((md.markdown as string).match(/Assistant/g)?.length).toBeGreaterThanOrEqual(3);
  });

  it("dark: a byLocalModel key stored on a claude record or reply does not change the markdown", async () => {
    await start(false);
    writeAnnotation(record("claude-stored", "claude", { byLocalModel: true }));
    writeReply("claude-reply-stored", "claude-stored", "claude", { byLocalModel: true });

    const md = (await exportAs("markdown")).markdown as string;

    expect(md).not.toContain("Local model");
    expect(md).toMatch(/\(Assistant\)/);
    expect(md).toMatch(/- Assistant: text of claude-reply-stored/);
  });
});
