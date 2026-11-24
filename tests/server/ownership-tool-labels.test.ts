/**
 * The owner labels on `tandem_getAnnotations` and `tandem_listDocuments`
 * (#2358 PR 5c, ADR-054's 5c amendment; ownership design §5.7): each document
 * is labelled `owner: {label, displayKind, kind, you}`, or `null` when nobody
 * holds it. `you` says whether the holder is the calling session; nothing
 * names an owner id, a handle or a session id (ownership design §10.3).
 *
 * Every call goes through the real tools and a validating SDK client (the
 * client checks structured output against the schema it cached from
 * `tools/list`), with three registered records: A holds `a`, B holds `b`, C
 * holds nothing, `u` is unowned and the active `front` is unowned.
 *
 * Flag on for the whole file except the dark rows, which build their server
 * flag off. Each tool's `owner` field is decided when it is registered, so
 * every world stubs the flag before it builds its server.
 *
 * Platform: in-memory fixtures with synthetic paths; nothing is gated.
 */

import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import type * as Y from "yjs";
import { addDoc, removeDoc, setActiveDocId } from "../../src/server/documents/registry-testing.js";
import { registerAnnotationTools } from "../../src/server/mcp/annotations.js";
import { resetInbox } from "../../src/server/mcp/awareness.js";
import { populateYDoc, registerDocumentTools } from "../../src/server/mcp/document.js";
import { getOpenDocs } from "../../src/server/mcp/document-service.js";
import {
  getDocOwner,
  getOwnerRecord,
  noteTransportRegistered,
  resetOwnershipForTests,
  setDocOwner,
  setTransportView,
  TANDEM_OWNER_ID,
  type TransportViewEntry,
} from "../../src/server/sessions/ownership.js";
import { getOrCreateDocument } from "../../src/server/yjs/provider.js";
import { Y_MAP_ANNOTATIONS } from "../../src/shared/constants.js";
import { withInternal } from "../../src/shared/origins.js";
import { setCtrlMode } from "../helpers/ctrl-mode.js";
import { setupMcpServer } from "../helpers/mcp-harness.js";
import { asTestCaller } from "../helpers/ownership-caller.js";

const A = "claude:labels-a";
const B = "claude:labels-b";
const C = "claude:labels-c";

type Data = Record<string, unknown>;
type Listed = Data & { id: string; owner?: unknown };

let client: Client;
let close: (() => Promise<void>) | undefined;
let view: TransportViewEntry[];
let callingAs = A;
let run = 0;
let ids: { a: string; b: string; u: string; front: string };

function register(ownerId: string): void {
  view.push({ ownerId, openStreams: 0 });
  noteTransportRegistered(ownerId, { recordKind: "claude" });
}

function mkDoc(id: string): Y.Doc {
  const ydoc = getOrCreateDocument(id);
  populateYDoc(ydoc, "Hello world, this is a test document.");
  addDoc(id, { id, filePath: `/tmp/${id}.md`, format: "md", readOnly: false, source: "file" });
  return ydoc;
}

function comment(ydoc: Y.Doc, id: string, extra: Record<string, unknown> = {}): void {
  withInternal(ydoc, () =>
    ydoc.getMap(Y_MAP_ANNOTATIONS).set(id, {
      id,
      author: "user",
      type: "comment",
      audience: "outbound",
      range: { from: 0, to: 5 },
      content: `text of ${id}`,
      status: "pending",
      timestamp: 1000,
      rev: 1,
      ...extra,
    }),
  );
}

/** The world (see the header), its server built with the flag as given. */
async function buildWorld(flag: "1" | ""): Promise<void> {
  // Ownership state is written flag on (a dark server writes none), then the
  // flag is set as the world asks before the server is registered.
  vi.stubEnv("TANDEM_OWNERSHIP", "1");
  run++;
  ids = { a: `lab${run}-a`, b: `lab${run}-b`, u: `lab${run}-u`, front: `lab${run}-front` };
  resetInbox();
  resetOwnershipForTests();
  view = [];
  setTransportView(() => view);
  register(A);
  register(B);
  register(C);
  setCtrlMode("tandem");
  mkDoc(ids.front);
  comment(mkDoc(ids.a), "ca");
  mkDoc(ids.b);
  mkDoc(ids.u);
  setActiveDocId(ids.front);
  setDocOwner(ids.a, { ownerId: A, kind: "opened" }, "take", A);
  setDocOwner(ids.b, { ownerId: B, kind: "claimed" }, "claim", B);
  if (flag === "") vi.stubEnv("TANDEM_OWNERSHIP", "");
  ({ client, close } = await setupMcpServer([registerDocumentTools, registerAnnotationTools], {
    dispatch: (fn) => asTestCaller(fn, { ownerId: callingAs }),
  }));
  // The SDK client validates structured output only for a tool whose schema
  // it has cached, as a real client does.
  await client.listTools();
}

afterEach(async () => {
  await close?.();
  close = undefined;
  for (const [id] of [...getOpenDocs()]) removeDoc(id);
  setActiveDocId(null);
  resetOwnershipForTests();
  resetInbox();
  setCtrlMode(null);
  vi.unstubAllEnvs();
});

/** Call `name` as `owner` through the validating client: structuredContent and the text part's data. */
async function callAs(
  owner: string,
  name: string,
  args: Record<string, unknown> = {},
): Promise<{ structured: Data; text: Data; raw: string }> {
  callingAs = owner;
  const result = (await client.callTool({ name, arguments: args })) as {
    isError?: boolean;
    structuredContent?: Data;
    content: Array<{ type: string; text?: string }>;
  };
  expect(result.isError ?? false, JSON.stringify(result)).toBe(false);
  const raw = result.content.find((c) => c.type === "text")?.text ?? "null";
  const envelope = JSON.parse(raw) as { error: boolean; data: Data };
  expect(envelope.error).toBe(false);
  expect(result.structuredContent, "structuredContent equals the text part").toEqual(envelope.data);
  return { structured: result.structuredContent as Data, text: envelope.data, raw };
}

async function listAs(owner: string): Promise<Map<string, Listed>> {
  const { structured } = await callAs(owner, "tandem_listDocuments");
  const docs = structured.documents as Listed[];
  return new Map(docs.map((d) => [d.id, d]));
}

async function annotationsAs(owner: string, documentId?: string): Promise<Data> {
  const { structured } = await callAs(
    owner,
    "tandem_getAnnotations",
    documentId === undefined ? {} : { documentId },
  );
  return structured;
}

const labelOf = (ownerId: string) => getOwnerRecord(ownerId)?.label as string;

// ---------------------------------------------------------------------------

describe("flag on: tandem_listDocuments labels every listed document", () => {
  it("the holder's label, display kind and kind, `you` for the caller's own, null for unowned", async () => {
    await buildWorld("1");
    const asA = await listAs(A);

    expect(asA.get(ids.a)?.owner).toEqual({
      label: labelOf(A),
      displayKind: "terminal",
      kind: "opened",
      you: true,
    });
    expect(asA.get(ids.b)?.owner).toEqual({
      label: labelOf(B),
      displayKind: "terminal",
      kind: "claimed",
      you: false,
    });
    expect(asA.get(ids.u)?.owner).toBeNull();
    expect(asA.get(ids.front)?.owner).toBeNull();
    // Every other key is today's.
    expect(Object.keys(asA.get(ids.a) as Listed).sort()).toEqual(
      ["fileName", "filePath", "format", "id", "isActive", "owner", "readOnly", "source"].sort(),
    );

    const asB = await listAs(B);
    expect((asB.get(ids.a)?.owner as { you: boolean }).you).toBe(false);
    expect((asB.get(ids.b)?.owner as { you: boolean }).you).toBe(true);

    // A session holding nothing is `you` nowhere.
    const asC = await listAs(C);
    for (const d of asC.values()) {
      if (d.owner !== null) expect((d.owner as { you: boolean }).you, d.id).toBe(false);
    }
  });

  it("Tandem's Claude is named so, with its kind", async () => {
    await buildWorld("1");
    setDocOwner(ids.u, { ownerId: TANDEM_OWNER_ID, kind: "default" }, "presence");
    const asA = await listAs(A);
    expect(asA.get(ids.u)?.owner).toEqual({
      label: labelOf(TANDEM_OWNER_ID),
      displayKind: "Tandem's Claude",
      kind: "default",
      you: false,
    });
  });

  it("a read claims nothing and changes no owner", async () => {
    await buildWorld("1");
    await listAs(C);
    expect(getDocOwner(ids.u)).toBeUndefined();
    expect(getDocOwner(ids.front)).toBeUndefined();
    expect(getDocOwner(ids.a)?.ownerId).toBe(A);
  });

  it("names no owner id, handle or session id", async () => {
    await buildWorld("1");
    const { raw } = await callAs(A, "tandem_listDocuments");
    for (const id of [A, B, C, TANDEM_OWNER_ID]) expect(raw).not.toContain(id);
    expect(raw).not.toMatch(/th_[A-Za-z0-9_-]{8}/);
  });
});

describe("flag on: tandem_getAnnotations labels the document it read", () => {
  it("the named document's owner, `you` from the caller", async () => {
    await buildWorld("1");
    const asA = await annotationsAs(A, ids.a);
    expect((asA.annotations as Data[]).map((x) => x.id)).toEqual(["ca"]);
    expect(asA.owner).toEqual({
      label: labelOf(A),
      displayKind: "terminal",
      kind: "opened",
      you: true,
    });
    const asB = await annotationsAs(B, ids.a);
    expect(asB.owner).toEqual({
      label: labelOf(A),
      displayKind: "terminal",
      kind: "opened",
      you: false,
    });
    expect((await annotationsAs(A, ids.b)).owner).toMatchObject({ kind: "claimed", you: false });
  });

  it("with no documentId, the active document's owner (the document the read resolved)", async () => {
    await buildWorld("1");
    setActiveDocId(ids.a);
    const asA = await annotationsAs(A);
    expect((asA.annotations as Data[]).map((x) => x.id)).toEqual(["ca"]);
    expect(asA.owner).toMatchObject({ label: labelOf(A), you: true });
  });

  it("null on an unowned document, the active one included, and the read claims nothing", async () => {
    await buildWorld("1");
    comment(getOrCreateDocument(ids.u), "cu");
    expect((await annotationsAs(C, ids.u)).owner).toBeNull();
    expect((await annotationsAs(C)).owner, "the active document").toBeNull();
    expect(getDocOwner(ids.u)).toBeUndefined();
    expect(getDocOwner(ids.front)).toBeUndefined();
  });

  it("present beside the note count, and a note's content never appears", async () => {
    await buildWorld("1");
    comment(getOrCreateDocument(ids.a), "secret-note", {
      type: "note",
      audience: "private",
      content: "a private note body",
    });
    const { structured, raw } = await callAs(A, "tandem_getAnnotations", { documentId: ids.a });
    expect(structured.notesExcluded).toBe(1);
    expect((structured.owner as { you: boolean }).you).toBe(true);
    expect(raw).not.toContain("a private note body");
    for (const id of [A, B, C]) expect(raw).not.toContain(id);
  });
});

describe("dark: both tools are exactly today's", () => {
  it("a flag-off server sends no owner key and advertises none", async () => {
    await buildWorld("");
    const list = await callAs(A, "tandem_listDocuments");
    expect(list.raw).not.toContain('"owner"');
    for (const d of list.structured.documents as Listed[]) {
      expect(Object.keys(d).sort(), d.id).toEqual(
        ["fileName", "filePath", "format", "id", "isActive", "readOnly", "source"].sort(),
      );
    }
    const annotations = await callAs(A, "tandem_getAnnotations", { documentId: ids.a });
    expect(annotations.raw).not.toContain('"owner"');
    expect(Object.keys(annotations.structured).sort()).toEqual(["annotations", "count"]);

    const { tools } = await client.listTools();
    for (const name of ["tandem_listDocuments", "tandem_getAnnotations"]) {
      const tool = tools.find((t) => t.name === name);
      expect(JSON.stringify(tool?.outputSchema), name).not.toContain('"owner"');
    }
  });

  it("a server registered flag-off and called flag-on still sends no owner key", async () => {
    await buildWorld("");
    vi.stubEnv("TANDEM_OWNERSHIP", "1");
    expect((await callAs(A, "tandem_listDocuments")).raw).not.toContain('"owner"');
    expect((await callAs(A, "tandem_getAnnotations", { documentId: ids.a })).raw).not.toContain(
      '"owner"',
    );
  });

  it("a server registered flag-on and called flag-off answers within its schema, with no owner key", async () => {
    await buildWorld("1");
    vi.stubEnv("TANDEM_OWNERSHIP", "");
    expect((await callAs(A, "tandem_listDocuments")).raw).not.toContain('"owner"');
    expect((await callAs(A, "tandem_getAnnotations", { documentId: ids.a })).raw).not.toContain(
      '"owner"',
    );
  });
});
