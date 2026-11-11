/**
 * Which refusal each write tool answers when more than one applies — today's
 * order, pinned (#2358, ADR-054; ownership design §5.1, §12: "flag-off, a
 * per-tool precedence pin keeps today's error order").
 *
 * Ownership enforcement (PR 1c) wraps every write tool. With ownership off it
 * must change nothing; with it on, a lone session — one that holds or may
 * claim every document it touches — must be answered exactly as before, apart
 * from the one difference this file names (the typing marker of a call refused
 * before the queue). So every row runs
 * both ways.
 *
 * It imports nothing ownership-specific beyond the caller helper, so it runs
 * unchanged against the commit before PR 1c: that is how the rows were
 * checked to be today's behaviour and not this PR's.
 */

import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as Y from "yjs";
import { addDoc, removeDoc, setActiveDocId } from "../../src/server/documents/registry-testing.js";
import { registerAnnotationTools } from "../../src/server/mcp/annotations.js";
import { populateYDoc, registerDocumentTools } from "../../src/server/mcp/document.js";
import { getOpenDocs } from "../../src/server/mcp/document-service.js";
import { getOrCreateDocument } from "../../src/server/yjs/provider.js";
import { Y_MAP_ANNOTATIONS } from "../../src/shared/constants.js";
import { withInternal } from "../../src/shared/origins.js";
import { parseResult, setupMcpServer } from "../helpers/mcp-harness.js";
import { ownershipTestDispatch } from "../helpers/ownership-caller.js";

let client: Client;
let close: (() => Promise<void>) | undefined;
let run = 0;
let prefix = "";
const docId = (name: string) => `${prefix}-${name}`;

function doc(
  name: string,
  opts: { text?: string; format?: string; readOnly?: boolean } = {},
): Y.Doc {
  const id = docId(name);
  const ydoc = getOrCreateDocument(id);
  if (opts.text !== undefined) populateYDoc(ydoc, opts.text);
  const format = opts.format ?? "md";
  addDoc(id, {
    id,
    filePath: `/tmp/${id}.${format}`,
    format,
    readOnly: opts.readOnly ?? false,
    source: "file",
  });
  return ydoc;
}

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

type Body = { error: boolean; code?: string; message?: string; details?: Record<string, unknown> };

async function call(tool: string, args: Record<string, unknown>): Promise<Body> {
  return parseResult(await client.callTool({ name: tool, arguments: args })) as Body;
}

describe.each([
  { flag: "", name: "ownership off" },
  { flag: "1", name: "ownership on, a lone session" },
])("write-tool refusal precedence — $name", ({ flag }) => {
  beforeEach(async () => {
    // Literal calls, so the reviewed lists in ownership-module-seam.test.ts see
    // which files turn the flag on and which turn it off.
    if (flag === "1") vi.stubEnv("TANDEM_OWNERSHIP", "1");
    else vi.stubEnv("TANDEM_OWNERSHIP", "");
    run++;
    prefix = `prec${run}`;
    for (const id of [...getOpenDocs().keys()]) removeDoc(id);
    ({ client, close } = await setupMcpServer([registerDocumentTools, registerAnnotationTools], {
      dispatch: ownershipTestDispatch,
    }));
  });

  afterEach(async () => {
    await close?.();
    close = undefined;
    for (const id of [...getOpenDocs().keys()]) removeDoc(id);
    vi.unstubAllEnvs();
  });

  describe("tandem_edit", () => {
    it("an empty document outranks a point insert that carries a textSnapshot", async () => {
      doc("empty");
      const body = await call("tandem_edit", {
        from: 0,
        to: 0,
        newText: "x",
        textSnapshot: "y",
        documentId: docId("empty"),
      });
      expect(body.code).toBe("EMPTY_DOCUMENT");
    });

    it("the empty no-op outranks the point-insert-with-snapshot refusal", async () => {
      doc("d", { text: "Hello world." });
      const body = await call("tandem_edit", {
        from: 2,
        to: 2,
        newText: "",
        textSnapshot: "He",
        documentId: docId("d"),
      });
      expect(body.code).toBe("INVALID_RANGE");
      expect(body.details).toEqual({ reason: "empty" });
    });

    it("read-only outranks a newline into plaintext, which outranks an empty document", async () => {
      doc("ro", { text: "text", format: "txt", readOnly: true });
      expect(
        (await call("tandem_edit", { from: 0, to: 1, newText: "a\nb", documentId: docId("ro") }))
          .code,
      ).toBe("READ_ONLY");
      doc("txt", { format: "txt" });
      expect(
        (await call("tandem_edit", { from: 0, to: 0, newText: "a\nb", documentId: docId("txt") }))
          .code,
      ).toBe("INVALID_ARGUMENT");
    });

    it("a document that is not open is NO_DOCUMENT whatever else is wrong", async () => {
      const body = await call("tandem_edit", {
        from: 0,
        to: 0,
        newText: "",
        documentId: docId("nope"),
      });
      expect(body.code).toBe("NO_DOCUMENT");
    });
  });

  describe("tandem_editList", () => {
    it("format outranks an empty document, which outranks a missing `checked`", async () => {
      doc("txt", { format: "txt" });
      expect(
        (await call("tandem_editList", { at: 0, op: "setChecked", documentId: docId("txt") })).code,
      ).toBe("FORMAT_ERROR");
      doc("empty");
      expect(
        (await call("tandem_editList", { at: 0, op: "setChecked", documentId: docId("empty") }))
          .code,
      ).toBe("EMPTY_DOCUMENT");
    });

    it("an offset outside the document outranks a missing `markdown`", async () => {
      doc("d", { text: "Hello world." });
      const body = await call("tandem_editList", {
        at: 9999,
        op: "insertAfter",
        documentId: docId("d"),
      });
      expect(body.code).toBe("INVALID_RANGE");
    });
  });

  describe("tandem_appendContent", () => {
    it("read-only, then format, then size", async () => {
      doc("ro", { text: "t", format: "txt", readOnly: true });
      expect(
        (await call("tandem_appendContent", { content: "x", documentId: docId("ro") })).code,
      ).toBe("READ_ONLY");
      doc("txt", { text: "t", format: "txt" });
      expect(
        (
          await call("tandem_appendContent", {
            content: "x".repeat(1_000_001),
            documentId: docId("txt"),
          })
        ).code,
      ).toBe("FORMAT_ERROR");
      doc("md", { text: "t" });
      expect(
        (
          await call("tandem_appendContent", {
            content: "x".repeat(1_000_001),
            documentId: docId("md"),
          })
        ).code,
      ).toBe("FILE_TOO_LARGE");
    });
  });

  describe("tandem_save, tandem_close, tandem_rename", () => {
    it("an id that is not open, and an empty id, keep their own answers", async () => {
      doc("d", { text: "t" });
      setActiveDocId(docId("d"));
      expect((await call("tandem_save", { documentId: docId("nope") })).code).toBe("NO_DOCUMENT");
      const closed = await call("tandem_close", { documentId: docId("nope") });
      expect(closed.code).toBe("NO_DOCUMENT");
      const emptyClose = await call("tandem_close", { documentId: "" });
      expect(emptyClose).toMatchObject({ code: "NO_DOCUMENT", message: "No document to close." });
      // Neither closed the active document.
      expect(getOpenDocs().has(docId("d"))).toBe(true);
      expect(
        (await call("tandem_rename", { newName: "n.md", documentId: docId("nope") })).code,
      ).toBe("NOT_FOUND");
      expect((await call("tandem_rename", { newName: "n.md", documentId: "" })).code).toBe(
        "NO_DOCUMENT",
      );
    });

    it("rename: an empty name outranks everything renameDocument would say", async () => {
      doc("ro", { text: "t", readOnly: true });
      expect((await call("tandem_rename", { newName: "", documentId: docId("ro") })).code).toBe(
        "INVALID_NAME",
      );
    });
  });

  describe("the four id-keyed annotation tools", () => {
    it("an id the document does not hold is NOT_FOUND, even with nothing to change", async () => {
      doc("d", { text: "Hello world." });
      expect(
        (await call("tandem_editAnnotation", { id: "missing", documentId: docId("d") })).code,
      ).toBe("NOT_FOUND");
      expect(
        (await call("tandem_removeAnnotation", { id: "missing", documentId: docId("d") })).code,
      ).toBe("NOT_FOUND");
    });

    it("privacy, then authorship, then status, then the empty patch", async () => {
      const ydoc = doc("d", { text: "Hello world." });
      seed(ydoc, "note", { type: "note", audience: "private", author: "user", status: "accepted" });
      seed(ydoc, "users", { author: "user", status: "accepted" });
      seed(ydoc, "resolved", { status: "accepted" });
      seed(ydoc, "mine");
      const edit = (id: string) => call("tandem_editAnnotation", { id, documentId: docId("d") });
      expect((await edit("note")).code).toBe("INVALID_ARGUMENT");
      expect((await edit("users")).code).toBe("NOT_OWNED");
      expect((await edit("resolved")).code).toBe("ANNOTATION_RESOLVED");
      expect((await edit("mine")).code).toBe("INVALID_ARGUMENT");
    });

    it("an id in two open documents is INVALID_ARGUMENT / ambiguous-document", async () => {
      seed(doc("one", { text: "Hello world." }), "dup");
      seed(doc("two", { text: "Hello world." }), "dup");
      const body = await call("tandem_editAnnotation", { id: "dup", content: "x" });
      expect(body.code).toBe("INVALID_ARGUMENT");
      expect(body.details).toEqual({
        reason: "ambiguous-document",
        documentIds: [docId("one"), docId("two")],
      });
    });
  });

  it("a write refused before any work still sets and clears the typing marker — off; none when ownership answers it before the queue", async () => {
    const ydoc = doc("ro", { text: "text", format: "html", readOnly: true });
    let transactions = 0;
    ydoc.on("afterTransaction", () => {
      transactions++;
    });
    const body = await call("tandem_edit", {
      from: 0,
      to: 1,
      newText: "x",
      documentId: docId("ro"),
    });
    expect(body.code).toBe("READ_ONLY");
    // Today the marker is written and cleared around the refusal (two
    // transactions). With ownership on the refusal is answered before the
    // document's queue, so the marker is never set.
    expect(transactions).toBe(flag === "1" ? 0 : 2);
  });
});
