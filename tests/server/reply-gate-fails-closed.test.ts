/**
 * #2460 — the pull reply gate fails closed, at the tool level.
 *
 * The push gate (`narrowReplyForChannel`) has always refused a reply whose
 * `private` is anything but literally `false` or absent, and any reply not
 * authored by the user. The pull gate, `channelVisibleReplies`, kept
 * `private !== true` and had no author rule, so a stored `"true"`, `1`, `null`
 * … — or an imported Word reply missing its `private` stamp, or a reply with an
 * unknown author — reached Claude on every pull read. These rows drive the
 * REGISTERED handlers through a validating client:
 *
 *  - B1: each non-boolean `private` is withheld from `tandem_getAnnotations`,
 *    `tandem_exportAnnotations` (JSON and markdown) and `tandem_checkInbox`'s
 *    `userReplies`; the absent case is shown on all four, `false` on export and
 *    the inbox (`tandem_getAnnotations` declares no `private` key on a reply, so
 *    a validating client rejects that row until the declared-shape strip lands).
 *  - B2 / B3: an import reply with no `private`, an author `"local"` and a
 *    missing author are withheld from getAnnotations (whose call used to fail
 *    output validation on them) and from export.
 *  - B4: Claude's own reply survives getAnnotations and export.
 *
 * Every "omits" row also asserts the call succeeded and that an absent-private
 * user sibling under the same parent arrived in the SAME response — otherwise a
 * failed call, an unread document or a dropped parent would pass it too.
 * The mode is written BEFORE any fixture: with the key absent the reply seam's
 * Solo hold would hide user replies for the wrong reason.
 */

import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type * as Y from "yjs";
import { addDoc, setActiveDocId } from "../../src/server/documents/registry-testing.js";
import { registerAnnotationTools } from "../../src/server/mcp/annotations.js";
import { registerAwarenessTools, resetInbox } from "../../src/server/mcp/awareness.js";
import { populateYDoc } from "../../src/server/mcp/document.js";
import { getOrCreateDocument, removeDocument } from "../../src/server/yjs/provider.js";
import { Y_MAP_ANNOTATION_REPLIES, Y_MAP_ANNOTATIONS } from "../../src/shared/constants.js";
import { withInternal } from "../../src/shared/origins.js";
import { setCtrlMode } from "../helpers/ctrl-mode.js";
import { clearOpenDocs } from "../helpers/doc-service.js";
import { parseResult, setupMcpServer } from "../helpers/mcp-harness.js";
import { ownershipTestDispatch, registerTestCallerRecord } from "../helpers/ownership-caller.js";

// Flag on, a poll reads only what the caller's record holds or may claim.
registerTestCallerRecord();

const DOC_ID = "reply-gate-fails-closed-doc";
const PARENT = "ctl";
const SIBLING_TEXT = "absent-private sibling";
const BAD_TEXT = "WITHHELD REPLY BODY";

const NON_BOOLEAN: ReadonlyArray<[string, unknown]> = [
  ['"true"', "true"],
  ["1", 1],
  ['"yes"', "yes"],
  ["{}", {}],
  ["null", null],
  ["0", 0],
  ['""', ""],
];

let doc: Y.Doc;
let client: Client;
let close: (() => Promise<void>) | undefined;

/** Claude's outbound comment, the sibling, and `extra` replies on it. */
function seed(extra: Array<Record<string, unknown>>): void {
  withInternal(doc, () => {
    doc.getMap(Y_MAP_ANNOTATIONS).set(PARENT, {
      id: PARENT,
      author: "claude",
      type: "comment",
      audience: "outbound",
      range: { from: 0, to: 5 },
      content: "claude comment",
      status: "pending",
      timestamp: 1,
      rev: 1,
    });
    const replies = doc.getMap(Y_MAP_ANNOTATION_REPLIES);
    replies.set("sib", {
      id: "sib",
      annotationId: PARENT,
      author: "user",
      text: SIBLING_TEXT,
      timestamp: 2,
      rev: 1,
    });
    extra.forEach((fields, i) => {
      const id = `x${i}`;
      replies.set(id, {
        id,
        annotationId: PARENT,
        author: "user",
        text: BAD_TEXT,
        timestamp: 3 + i,
        rev: 1,
        ...fields,
      });
    });
  });
}

async function call(name: string, args: Record<string, unknown> = {}) {
  const result = await client.callTool({ name, arguments: args });
  expect(result.isError, JSON.stringify(result.content)).toBeFalsy();
  return parseResult(result);
}

/** The reply texts the parent carries in a getAnnotations / export JSON payload. */
function replyTexts(data: { annotations: Array<{ id: string; replies?: unknown }> }): string[] {
  const parent = data.annotations.find((a) => a.id === PARENT);
  expect(parent, "the parent must be returned").toBeDefined();
  return ((parent?.replies ?? []) as Array<{ text: string }>).map((r) => r.text);
}

async function getAnnotationsTexts(): Promise<string[]> {
  return replyTexts((await call("tandem_getAnnotations")).data);
}

async function exportJsonTexts(): Promise<string[]> {
  return replyTexts((await call("tandem_exportAnnotations", { format: "json" })).data);
}

async function exportMarkdown(): Promise<string> {
  return (await call("tandem_exportAnnotations", { format: "markdown" })).data.markdown;
}

async function inboxReplyTexts(): Promise<string[]> {
  const parsed = await call("tandem_checkInbox");
  return (parsed.data.userReplies as Array<{ text: string }>).map((r) => r.text);
}

beforeEach(async () => {
  clearOpenDocs();
  removeDocument(DOC_ID);
  resetInbox();
  // The fixture rule: the mode before any fixture.
  setCtrlMode("tandem");
  doc = getOrCreateDocument(DOC_ID);
  populateYDoc(doc, "Hello world here");
  addDoc(DOC_ID, {
    id: DOC_ID,
    filePath: `/tmp/${DOC_ID}.md`,
    format: "md",
    readOnly: false,
    source: "file",
  });
  setActiveDocId(DOC_ID);
  ({ client, close } = await setupMcpServer([registerAnnotationTools, registerAwarenessTools], {
    dispatch: ownershipTestDispatch,
  }));
  // Fetch the tool list so the client validates every structured result.
  await client.listTools();
});

afterEach(async () => {
  await close?.();
  close = undefined;
  clearOpenDocs();
  removeDocument(DOC_ID);
  setCtrlMode(null);
  resetInbox();
});

describe("B1: a non-boolean private flag is withheld from every pull path", () => {
  it.each(NON_BOOLEAN)("tandem_getAnnotations omits private %s", async (_label, value) => {
    seed([{ private: value }]);
    expect(await getAnnotationsTexts()).toEqual([SIBLING_TEXT]);
  });

  it.each(NON_BOOLEAN)("tandem_exportAnnotations JSON omits private %s", async (_label, value) => {
    seed([{ private: value }]);
    expect(await exportJsonTexts()).toEqual([SIBLING_TEXT]);
  });

  it.each(NON_BOOLEAN)(
    "tandem_exportAnnotations markdown omits private %s",
    async (_label, value) => {
      seed([{ private: value }]);
      const md = await exportMarkdown();
      expect(md).toContain(SIBLING_TEXT);
      expect(md).not.toContain(BAD_TEXT);
    },
  );

  it.each(NON_BOOLEAN)("tandem_checkInbox userReplies omits private %s", async (_label, value) => {
    seed([{ private: value }]);
    expect(await inboxReplyTexts()).toEqual([SIBLING_TEXT]);
  });
});

describe("B1 guards: the shapes first-party writers produce stay visible", () => {
  it("private absent is shown on all four paths", async () => {
    seed([]);
    expect(await getAnnotationsTexts()).toEqual([SIBLING_TEXT]);
    expect(await exportJsonTexts()).toEqual([SIBLING_TEXT]);
    expect(await exportMarkdown()).toContain(SIBLING_TEXT);
    expect(await inboxReplyTexts()).toEqual([SIBLING_TEXT]);
  });

  it("private false is shown by export (JSON and markdown) and the inbox", async () => {
    seed([{ private: false }]);
    expect((await exportJsonTexts()).sort()).toEqual([BAD_TEXT, SIBLING_TEXT].sort());
    expect(await exportMarkdown()).toContain(BAD_TEXT);
    expect((await inboxReplyTexts()).sort()).toEqual([BAD_TEXT, SIBLING_TEXT].sort());
  });
});

describe("B2 / B3: only user and Claude authors pass (an allow-list)", () => {
  const AUTHORS: ReadonlyArray<[string, Record<string, unknown>]> = [
    ["import with no private (B2)", { author: "import" }],
    ['"local" (B3)', { author: "local" }],
    ["missing (B3)", { author: undefined }],
  ];

  it.each(AUTHORS)("author %s is withheld from getAnnotations and export", async (_l, fields) => {
    seed([fields]);
    // The getAnnotations call itself now succeeds (`call` asserts no isError).
    expect(await getAnnotationsTexts()).toEqual([SIBLING_TEXT]);
    expect(await exportJsonTexts()).toEqual([SIBLING_TEXT]);
    const md = await exportMarkdown();
    expect(md).toContain(SIBLING_TEXT);
    expect(md).not.toContain(BAD_TEXT);
  });
});

describe("B4: Claude's own replies survive", () => {
  it("a Claude reply with no private is returned by getAnnotations and export", async () => {
    seed([{ author: "claude" }]);
    expect((await getAnnotationsTexts()).sort()).toEqual([BAD_TEXT, SIBLING_TEXT].sort());
    expect((await exportJsonTexts()).sort()).toEqual([BAD_TEXT, SIBLING_TEXT].sort());
    expect(await exportMarkdown()).toContain(BAD_TEXT);
  });
});
