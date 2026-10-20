/**
 * The four id-keyed annotation tools find the open document that holds the id
 * when `documentId` is omitted (PR #2225 review, after #2187).
 *
 * Since #2187 a default `tandem_checkInbox` hands Claude annotation ids from
 * BACKGROUND documents. `tandem_resolveAnnotation`, `tandem_removeAnnotation`,
 * `tandem_editAnnotation` and `tandem_annotationReply` defaulted to the active
 * document alone, so acting on such an id without echoing its `documentId`
 * answered NOT_FOUND for a record Claude had just been shown.
 * `resolveAnnotationStore` (`mcp/document-store.ts`) now picks the one open
 * document where the id is Claude-facing; these specs drive the REGISTERED
 * handlers through the in-memory MCP harness.
 *
 * The privacy half is the part a looser resolver gets wrong silently: a note
 * (ADR-027), a private comment, a legacy `flag` or an unknown-type record in
 * another document must never steer the choice — neither by being acted on nor
 * by turning a unique id into an `ambiguous-document` refusal that names the
 * document holding it.
 */

import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type * as Y from "yjs";
import { addDoc, removeDoc, setActiveDocId } from "../../src/server/documents/registry-testing.js";
import { registerAnnotationTools } from "../../src/server/mcp/annotations.js";
import { populateYDoc } from "../../src/server/mcp/document.js";
import { getOpenDocs } from "../../src/server/mcp/document-service.js";
import { YDocStore } from "../../src/server/mcp/document-store.js";
import { getOrCreateDocument } from "../../src/server/yjs/provider.js";
import {
  CTRL_ROOM,
  Y_MAP_ANNOTATION_REPLIES,
  Y_MAP_ANNOTATIONS,
  Y_MAP_AWARENESS,
  Y_MAP_CLAUDE,
  Y_MAP_MODE,
  Y_MAP_USER_AWARENESS,
} from "../../src/shared/constants.js";
import { withInternal } from "../../src/shared/origins.js";
import type { ClaudeAwareness } from "../../src/shared/types.js";
import { parseResult, setupMcpServer } from "../helpers/mcp-harness.js";

let client: Client;
let close: (() => Promise<void>) | undefined;

/**
 * Per-test document-id prefix. `getOrCreateDocument` keeps every Y.Doc for the
 * life of the worker and `removeDoc` only unregisters it, so reusing a name
 * would inherit the previous test's annotations map.
 */
let run = 0;
let prefix = "";

const docId = (name: string) => `${prefix}-${name}`;

function setupDoc(name: string): Y.Doc {
  const id = docId(name);
  const ydoc = getOrCreateDocument(id);
  populateYDoc(ydoc, "Hello world, this is a test document.");
  addDoc(id, { id, filePath: `/tmp/${id}.md`, format: "md", readOnly: false, source: "file" });
  return ydoc;
}

/** A pending, Claude-facing record Claude authored — every one of the four tools accepts it. */
function seed(ydoc: Y.Doc, id: string, extra: Record<string, unknown> = {}): void {
  withInternal(ydoc, () =>
    ydoc.getMap(Y_MAP_ANNOTATIONS).set(id, {
      id,
      author: "claude",
      type: "comment",
      audience: "outbound",
      range: { from: 0, to: 5 },
      content: "original",
      status: "pending",
      timestamp: 1000,
      rev: 1,
      ...extra,
    }),
  );
}

/** Raw write for shapes `seed` must not normalize (a non-object, a range-less record). */
function seedRaw(ydoc: Y.Doc, id: string, value: unknown): void {
  withInternal(ydoc, () => ydoc.getMap(Y_MAP_ANNOTATIONS).set(id, value));
}

/** Everything a tool could have written to a document: its annotations and its replies. */
function snapshot(ydoc: Y.Doc): string {
  return JSON.stringify({
    annotations: ydoc.getMap(Y_MAP_ANNOTATIONS).toJSON(),
    replies: ydoc.getMap(Y_MAP_ANNOTATION_REPLIES).toJSON(),
  });
}

function repliesTo(ydoc: Y.Doc, annotationId: string): unknown[] {
  return [...ydoc.getMap(Y_MAP_ANNOTATION_REPLIES).values()].filter(
    (r) => (r as { annotationId?: string }).annotationId === annotationId,
  );
}

type ToolName =
  | "tandem_resolveAnnotation"
  | "tandem_removeAnnotation"
  | "tandem_editAnnotation"
  | "tandem_annotationReply";

/** The four tools, each with the argument shape and the effect it has on success. */
const TOOLS: Array<{
  tool: ToolName;
  args: (id: string) => Record<string, unknown>;
  /** Did the call land on `ydoc`? */
  landed: (ydoc: Y.Doc, id: string) => boolean;
}> = [
  {
    tool: "tandem_resolveAnnotation",
    args: (id) => ({ id, action: "dismiss" }),
    landed: (ydoc, id) =>
      (ydoc.getMap(Y_MAP_ANNOTATIONS).get(id) as { status?: string } | undefined)?.status ===
      "dismissed",
  },
  {
    tool: "tandem_removeAnnotation",
    args: (id) => ({ id }),
    landed: (ydoc, id) => !ydoc.getMap(Y_MAP_ANNOTATIONS).has(id),
  },
  {
    tool: "tandem_editAnnotation",
    args: (id) => ({ id, content: "edited" }),
    landed: (ydoc, id) =>
      (ydoc.getMap(Y_MAP_ANNOTATIONS).get(id) as { content?: string } | undefined)?.content ===
      "edited",
  },
  {
    tool: "tandem_annotationReply",
    args: (id) => ({ annotationId: id, text: "a reply" }),
    landed: (ydoc, id) => repliesTo(ydoc, id).length === 1,
  },
];

async function call(tool: ToolName, args: Record<string, unknown>) {
  const result = await client.callTool({ name: tool, arguments: args });
  const text = (result.content as Array<{ type: string; text?: string }>)[0]?.text ?? "";
  return { body: parseResult(result), text };
}

beforeEach(async () => {
  run++;
  prefix = `idres${run}`;
  for (const id of [...getOpenDocs().keys()]) removeDoc(id);
  setActiveDocId(null);
  const ctrl = getOrCreateDocument(CTRL_ROOM);
  withInternal(ctrl, () => ctrl.getMap(Y_MAP_USER_AWARENESS).delete(Y_MAP_MODE));
  ({ client, close } = await setupMcpServer([registerAnnotationTools]));
});

afterEach(async () => {
  await close?.();
  close = undefined;
  for (const id of [...getOpenDocs().keys()]) removeDoc(id);
  setActiveDocId(null);
});

describe("a background-document id resolves without documentId", () => {
  it.each(TOOLS)("$tool acts on the document that holds the id", async ({ tool, args, landed }) => {
    const active = setupDoc("active");
    const background = setupDoc("background");
    setActiveDocId(docId("active"));
    seed(background, "ann_bg");
    const activeBefore = snapshot(active);

    const { body } = await call(tool, args("ann_bg"));

    expect(body.error, JSON.stringify(body)).toBe(false);
    expect(body.data.documentId).toBe(docId("background"));
    expect(landed(background, "ann_bg")).toBe(true);
    expect(snapshot(active)).toBe(activeBefore);
  });
});

describe("the same Claude-facing id in two documents is refused, not guessed", () => {
  it.each(TOOLS)("$tool answers ambiguous-document and touches neither", async ({ tool, args }) => {
    const a = setupDoc("a");
    const b = setupDoc("b");
    // A third document holding the id as a NOTE: it must not be counted, and
    // must not be named in the refusal (ADR-027 — naming it discloses the note).
    const c = setupDoc("c");
    setActiveDocId(docId("a"));
    seed(a, "ann_dup");
    seed(b, "ann_dup");
    seed(c, "ann_dup", { type: "note", author: "user", audience: "private" });
    const before = [snapshot(a), snapshot(b), snapshot(c)];

    const { body, text } = await call(tool, args("ann_dup"));

    expect(body.error).toBe(true);
    expect(body.code).toBe("INVALID_ARGUMENT");
    expect(body.message).toBe("Annotation ann_dup is in 2 open documents; pass documentId");
    expect(body.details).toEqual({
      reason: "ambiguous-document",
      documentIds: [docId("a"), docId("b")],
    });
    expect(text).not.toContain(docId("c"));
    expect([snapshot(a), snapshot(b), snapshot(c)]).toEqual(before);
  });

  it.each(TOOLS)("$tool with an explicit documentId still wins", async ({ tool, args, landed }) => {
    const a = setupDoc("a");
    const b = setupDoc("b");
    setActiveDocId(docId("a"));
    seed(a, "ann_dup");
    seed(b, "ann_dup");
    const aBefore = snapshot(a);

    const { body } = await call(tool, { ...args("ann_dup"), documentId: docId("b") });

    expect(body.error, JSON.stringify(body)).toBe(false);
    expect(body.data.documentId).toBe(docId("b"));
    expect(landed(b, "ann_dup")).toBe(true);
    expect(snapshot(a)).toBe(aBefore);
  });

  it("an explicit documentId is never widened to a search", async () => {
    setupDoc("active");
    const background = setupDoc("background");
    setActiveDocId(docId("active"));
    seed(background, "ann_bg");
    const before = snapshot(background);

    const { body } = await call("tandem_resolveAnnotation", {
      id: "ann_bg",
      action: "dismiss",
      documentId: docId("active"),
    });

    expect(body.code).toBe("NOT_FOUND");
    expect(snapshot(background)).toBe(before);
  });
});

describe("records the reads withhold never steer the choice (ADR-027)", () => {
  it.each(TOOLS)(
    "$tool: a note sharing the id does not make it ambiguous",
    async ({ tool, args, landed }) => {
      // The note sits in the ACTIVE document, so both the pre-fix handler (which
      // would have hit the note) and a resolver that counted raw presence (which
      // would have refused as ambiguous, naming it) fail here.
      const withNote = setupDoc("withnote");
      const withComment = setupDoc("withcomment");
      setActiveDocId(docId("withnote"));
      seed(withNote, "ann_shared", { type: "note", author: "user", audience: "private" });
      seed(withComment, "ann_shared");
      const noteBefore = snapshot(withNote);

      const { body, text } = await call(tool, args("ann_shared"));

      expect(body.error, JSON.stringify(body)).toBe(false);
      expect(body.data.documentId).toBe(docId("withcomment"));
      expect(landed(withComment, "ann_shared")).toBe(true);
      expect(text).not.toContain(docId("withnote"));
      expect(snapshot(withNote)).toBe(noteBefore);
    },
  );

  const WITHHELD: Array<[string, Record<string, unknown>]> = [
    ["a note", { type: "note", author: "user", audience: "private" }],
    ["a private comment", { type: "comment", author: "user", audience: "private" }],
    // A legacy flag is a note only once sanitized — the guard must run after it.
    ["a legacy flag", { type: "flag", author: "user", audience: undefined }],
    // Sanitize coerces an unknown type to {comment, outbound}; only the
    // unknown-type refusal keeps it from passing `isClaudeFacing`.
    ["an unknown-type record", { type: "bogus", author: "user", audience: "outbound" }],
  ];

  for (const [label, extra] of WITHHELD) {
    it.each(TOOLS)(
      `$tool: ${label} unique to a background document answers from the active one`,
      async ({ tool, args }) => {
        const active = setupDoc("active");
        const background = setupDoc("background");
        setActiveDocId(docId("active"));
        seed(background, "ann_private", extra);
        const before = [snapshot(active), snapshot(background)];

        const { body, text } = await call(tool, args("ann_private"));

        // Today's envelope: the active document does not hold the id.
        expect(body.error).toBe(true);
        expect(body.code).toBe("NOT_FOUND");
        expect(body.message).toBe("Annotation ann_private not found");
        expect(text).not.toContain(docId("background"));
        expect([snapshot(active), snapshot(background)]).toEqual(before);
      },
    );
  }
});

describe("corrupt records in other documents", () => {
  it.each(TOOLS)(
    "$tool: a non-object and a malformed record elsewhere do not break or steer a resolve",
    async ({ tool, args, landed }) => {
      const active = setupDoc("active");
      const background = setupDoc("background");
      const corruptString = setupDoc("corruptstring");
      const corruptShape = setupDoc("corruptshape");
      setActiveDocId(docId("active"));
      seed(background, "ann_bg");
      seedRaw(corruptString, "ann_bg", "not an annotation");
      // Claude-facing by type and audience, but range-less: `tandem_getAnnotations`
      // skips it as malformed, so it must not become a candidate either.
      seedRaw(corruptShape, "ann_bg", {
        id: "ann_bg",
        author: "claude",
        type: "comment",
        audience: "outbound",
        status: "pending",
        content: "no range",
      });
      const activeBefore = snapshot(active);

      const { body } = await call(tool, args("ann_bg"));

      expect(body.error, JSON.stringify(body)).toBe(false);
      expect(body.data.documentId).toBe(docId("background"));
      expect(landed(background, "ann_bg")).toBe(true);
      expect(snapshot(active)).toBe(activeBefore);
    },
  );
});

describe("tandem_annotationReply typing presence follows the resolved document", () => {
  it("marks typing on the background document that received the reply, not the active one", async () => {
    const active = setupDoc("active");
    const background = setupDoc("background");
    setActiveDocId(docId("active"));
    seed(background, "ann_bg");

    // Presence is set before the handler and cleared after it, so capture every
    // `working` value written while the call runs.
    const seen = new Map<string, Array<NonNullable<ClaudeAwareness["working"]>>>();
    for (const [name, ydoc] of [
      ["active", active],
      ["background", background],
    ] as const) {
      seen.set(name, []);
      const awareness = ydoc.getMap(Y_MAP_AWARENESS);
      awareness.observe(() => {
        const working = (awareness.get(Y_MAP_CLAUDE) as ClaudeAwareness | undefined)?.working;
        if (working) seen.get(name)?.push(working);
      });
    }

    const { body } = await call("tandem_annotationReply", { annotationId: "ann_bg", text: "hi" });

    expect(body.error, JSON.stringify(body)).toBe(false);
    expect(seen.get("active")).toEqual([]);
    expect(seen.get("background")).toEqual([
      expect.objectContaining({ tool: "tandem_annotationReply", annotationId: "ann_bg" }),
    ]);
  });
});

describe("YDocStore.refreshAnnotations", () => {
  it("opens no transaction for an empty subset", () => {
    const ydoc = setupDoc("refresh");
    seed(ydoc, "ann_r");
    const store = new YDocStore(ydoc, `/tmp/${docId("refresh")}.md`, docId("refresh"));
    let transactions = 0;
    const count = () => transactions++;
    ydoc.on("afterTransaction", count);
    try {
      expect(store.refreshAnnotations([])).toEqual([]);
      expect(transactions).toBe(0);
      // The probe can see a transaction: a non-empty subset opens exactly one.
      store.refreshAnnotations(store.listAnnotations());
      expect(transactions).toBe(1);
    } finally {
      ydoc.off("afterTransaction", count);
    }
  });
});
