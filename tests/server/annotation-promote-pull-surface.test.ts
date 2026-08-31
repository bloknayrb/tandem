/**
 * ADR-035 Unit 8g — note promotion, read through the PULL surface.
 *
 * Five suites already cover promotion, and **every one of them asserts either a
 * push-path event or the raw stored Y.Map record**:
 * `annotation-promote-event.test.ts` (the channel gate predicate),
 * `annotation-promote-e2e.test.ts` (stored shape after a real `.docx` import),
 * `annotation-actions.test.ts` (the client transform),
 * `channel-projection-characterization.test.ts:417-465` (a private reply across
 * a real promotion — on the channel), and `event-queue.test.ts` (the
 * cross-document id collision and the push-side Solo hold).
 *
 * CLAUDE.md makes the **pull** surface authoritative over all four push paths,
 * and nothing drove a promotion into it. The gap is not hypothetical:
 * `annotation-promote-e2e.test.ts:139` says its stored-shape assertion stands in
 * for "the MCP-read surface (audience/type≠note)", but `tandem_getAnnotations`
 * filters on `type !== "note"` and `hideFromAI` and never reads `audience` at
 * all, and `checkInbox`'s user-actions bucket requires `author === "user" &&
 * type === "comment"` and likewise never reads it. That comment asserts a field
 * its named surface does not consult — a proxy for running the filter, standing
 * where running it should be. (That the pull surfaces ignore `audience` is not a
 * discovery here: `annotations/projection.ts:20-27` says so in the source and
 * tracks it as #1619. What is new is only that a test claimed to cover it.)
 *
 * So this file runs the **registered handlers** — a real `McpServer` over
 * `InMemoryTransport`, driven by `client.callTool`, exactly as
 * `mcp-tool-integration.test.ts` does. The trap it is avoiding sits one file
 * over: `annotation-tools.test.ts:119`'s "tandem_getAnnotations tool logic"
 * describe block reimplements the filters in the test itself
 * (`.filter((a) => a.author === "claude")`) and never calls the handler, so the
 * note exclusion and the Solo hold inside the real handler are unexercised by
 * the suite that carries the tool's name.
 *
 * Every fixture is produced by the **real** client promoter. A record built by
 * hand can only confirm my own model of what promotion writes, which is the
 * failure this file exists to correct rather than repeat.
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type * as Y from "yjs";

import { promoteNotesToComments } from "../../src/client/panels/annotation-actions.js";
import { addUserReply } from "../../src/server/annotations/lifecycle.js";
import { addDoc, setActiveDocId } from "../../src/server/documents/registry-testing.js";
import {
  type DocxComment,
  injectCommentsAsAnnotations,
} from "../../src/server/file-io/docx-comments.js";
import { htmlToYDoc } from "../../src/server/file-io/docx-html.js";
import { registerAnnotationTools } from "../../src/server/mcp/annotations.js";
import { registerAwarenessTools, resetInbox } from "../../src/server/mcp/awareness.js";
import { extractText } from "../../src/server/mcp/document-model.js";
import { getOrCreateDocument } from "../../src/server/yjs/provider.js";
import type { Annotation } from "../../src/shared/types.js";
import { setCtrlMode } from "../helpers/ctrl-mode.js";
import { clearOpenDocs } from "../helpers/doc-service.js";
import { getAnnotationsMap, noRelay } from "../helpers/ydoc-factory.js";

const HTML =
  "<h2>Project Overview</h2>" +
  "<p>We should simplify the onboarding flow for new users.</p>" +
  "<p>The dashboard needs a refresh before launch.</p>";
const ANCHORS = ["simplify the onboarding flow", "dashboard needs a refresh"] as const;

let client: Client;

type CallToolResponse = Awaited<ReturnType<Client["callTool"]>>;

async function setupMcpClient(): Promise<Client> {
  const server = new McpServer({ name: "tandem-test", version: "0.0.1" });
  registerAnnotationTools(server);
  registerAwarenessTools(server);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const mcpClient = new Client({ name: "test-client", version: "0.0.1" });
  await server.connect(serverTransport);
  await mcpClient.connect(clientTransport);
  return mcpClient;
}

function parseResult(result: CallToolResponse) {
  const content = result.content as Array<{ type: string; text?: string }>;
  const text = content.find((c) => c.type === "text");
  return text?.text ? JSON.parse(text.text) : null;
}

/**
 * A registered document holding two imported Word comments, both private notes.
 *
 * Registration matters: `tandem_getAnnotations` resolves its store through the
 * document registry, so a bare `new Y.Doc()` — which is what the existing
 * promote suites use — is invisible to the handler.
 */
function setupImportedDoc(id: string): { ydoc: Y.Doc; noteIds: string[] } {
  const ydoc = getOrCreateDocument(id);
  htmlToYDoc(ydoc, HTML);
  addDoc(id, { id, filePath: `/tmp/${id}.docx`, format: "docx", readOnly: false, source: "file" });
  setActiveDocId(id);

  const flat = extractText(ydoc);
  const comments: DocxComment[] = ANCHORS.map((anchor, i) => {
    const from = flat.indexOf(anchor);
    if (from < 0) throw new Error(`anchor not found: ${anchor}`);
    return {
      commentId: `c${i + 1}`,
      authorName: `Reviewer ${i + 1}`,
      bodyText: `Please revisit: ${anchor}`,
      from: from as Annotation["range"]["from"],
      to: (from + anchor.length) as Annotation["range"]["to"],
    };
  });
  injectCommentsAsAnnotations(ydoc, comments, "review.docx");

  const noteIds = (Array.from(getAnnotationsMap(ydoc).values()) as Annotation[])
    .filter((a) => a.author === "import")
    .map((a) => a.id);
  expect(noteIds, "fixture: the real import path produced two private notes").toHaveLength(2);
  return { ydoc, noteIds };
}

const getAnnotations = async () =>
  parseResult(await client.callTool({ name: "tandem_getAnnotations", arguments: {} }));
const checkInbox = async () =>
  parseResult(await client.callTool({ name: "tandem_checkInbox", arguments: {} }));

/** The ids `checkInbox` actually handed the model this poll. */
const inboxActionIds = (parsed: { data?: { userActions?: Array<{ id: string }> } }) =>
  (parsed.data?.userActions ?? []).map((a) => a.id);

beforeEach(async () => {
  clearOpenDocs();
  resetInbox();
  setCtrlMode("tandem");
  client = await setupMcpClient();
});

afterEach(async () => {
  await client.close();
  setCtrlMode(null);
});

describe("Unit 8g G1 — a promoted note reaches Claude on the PULL surface", () => {
  it("tandem_getAnnotations returns the promoted note and still excludes its sibling", async () => {
    const { ydoc, noteIds } = setupImportedDoc("pull-g1-get");

    // Before: both are notes, so the handler returns neither and counts both.
    const before = await getAnnotations();
    expect(before.data.annotations).toHaveLength(0);
    expect(before.data.notesExcluded).toBe(2);

    // The REAL promoter, on exactly one of them.
    expect(promoteNotesToComments(ydoc, [noteIds[0]], "tandem")).toBe(1);

    const after = await getAnnotations();
    expect(after.data.annotations.map((a: Annotation) => a.id)).toStrictEqual([noteIds[0]]);
    // The un-promoted sibling is the control: without it, "the promoted one is
    // visible" passes for a handler that stopped filtering notes at all.
    expect(after.data.notesExcluded).toBe(1);
    // The author flip is what carries an IMPORT onto a Claude-visible surface,
    // and it is asserted here on what the handler returned rather than on the
    // stored record, which is the whole point of this file.
    expect(after.data.annotations[0].author).toBe("user");
    expect(after.data.annotations[0].type).toBe("comment");
  });

  it("tandem_checkInbox surfaces the promoted note as a user action", async () => {
    const { ydoc, noteIds } = setupImportedDoc("pull-g1-inbox");

    // **A baseline, NOT a control — labelled because it reads like one.** Both
    // records are `author: "import"` at this point, so they fail the bucket's
    // author half no matter what the note filtering does; this line would stay
    // green with the type gate deleted. What it actually establishes is that the
    // dedup ledger is empty going in, which is what makes the post-promotion
    // assertion below mean "surfaced now" rather than "surfaced at some point".
    expect(inboxActionIds(await checkInbox())).toStrictEqual([]);

    expect(promoteNotesToComments(ydoc, [noteIds[1]], "tandem")).toBe(1);

    // A fresh poll: the ledger dedups per id, so the first call above must not
    // have surfaced this one for the assertion to mean anything.
    const ids = inboxActionIds(await checkInbox());
    expect(ids).toStrictEqual([noteIds[1]]);
    // **No `notesExcluded` assertion here, deliberately.** That counter exists
    // only on `tandem_getAnnotations` (`mcp/annotations.ts:423,449`);
    // `awareness.ts` has none, so the checkInbox half asserts the sibling's
    // ABSENCE. Review caught the first draft asserting a field the surface does
    // not return, which would have read as a passing cross-surface claim.
    expect(ids).not.toContain(noteIds[0]);
  });
});

describe("Unit 8g G2 — a note promoted in Solo stays held until mode reads tandem", () => {
  /**
   * The client stamps `heldInSolo` (`annotation-actions.ts:83-85`) and the
   * server's `hideFromAI` (`mode.ts:84-91`) reads it — but only in the
   * INDETERMINATE state, i.e. after a restart has lost the mode key. Two files,
   * one invariant, and `event-queue.test.ts:1424-1499` pins the push half only
   * (and does so on a hand-built comment, never on a promoted record).
   */
  it("withholds it on both pull surfaces after a restart, then releases it", async () => {
    const { ydoc, noteIds } = setupImportedDoc("pull-g2");

    setCtrlMode("solo");
    expect(promoteNotesToComments(ydoc, [noteIds[0]], "solo")).toBe(1);
    const stored = getAnnotationsMap(ydoc).get(noteIds[0]) as Annotation & {
      heldInSolo?: boolean;
    };
    expect(stored.heldInSolo, "fixture: the real promoter stamped the marker").toBe(true);

    // The restart: the mode key is GONE, which is not the same as "solo" — it
    // is the state `hideFromAI` reads the marker in.
    setCtrlMode(null);
    expect((await getAnnotations()).data.annotations).toHaveLength(0);
    expect(inboxActionIds(await checkInbox())).toStrictEqual([]);

    // Release. The same record, the same poll surfaces, one field changed — so
    // the withholding above cannot have been the record being invisible for an
    // unrelated reason (a wrong type, a bad range, a filter that drops every
    // import).
    setCtrlMode("tandem");
    expect((await getAnnotations()).data.annotations.map((a: Annotation) => a.id)).toStrictEqual([
      noteIds[0],
    ]);
    expect(inboxActionIds(await checkInbox())).toStrictEqual([noteIds[0]]);
  });

  it("holds it in Solo itself, by author rather than by marker", async () => {
    // The other `hideFromAI` branch, and it is a different rule: in `solo` the
    // gate is `author === "user"` and the marker is not consulted at all. A
    // promoted import is author `user`, so promotion is what brings it under
    // that branch — before the promotion the same record is withheld for being
    // a note instead, which is why the assertion below is about the count
    // staying put rather than about it changing.
    const { ydoc, noteIds } = setupImportedDoc("pull-g2-solo");
    setCtrlMode("solo");
    expect(promoteNotesToComments(ydoc, [noteIds[0]], "solo")).toBe(1);

    expect((await getAnnotations()).data.annotations).toHaveLength(0);
    expect(inboxActionIds(await checkInbox())).toStrictEqual([]);
  });
});

describe("Unit 8g G3 — a private reply on a promoted parent stays private on PULL", () => {
  it("excludes the note-era reply while admitting one written after promotion", async () => {
    // `channel-projection-characterization.test.ts:417-465` pins exactly this on
    // the CHANNEL. Review found that leaving it there would reproduce this
    // unit's own complaint: the push path covered, the authoritative one not.
    const { ydoc, noteIds } = setupImportedDoc("pull-g3");
    const parent = noteIds[0];

    // Written through the real unguarded entry while the parent is still a note,
    // so `private` is stamped by production code rather than by this test.
    const noteEra = addUserReply(ydoc, parent, "my private thought", noRelay);
    expect(noteEra.kind).toBe("ok");

    expect(promoteNotesToComments(ydoc, [parent], "tandem")).toBe(1);

    const afterPromotion = addUserReply(ydoc, parent, "shared on purpose", noRelay);
    expect(afterPromotion.kind).toBe("ok");

    const [ann] = (await getAnnotations()).data.annotations as Array<{
      id: string;
      replies: Array<{ text: string }>;
    }>;
    expect(ann.id).toBe(parent);
    // Both halves. Asserting only the exclusion passes for a handler that
    // returns no replies at all; asserting only the inclusion passes for one
    // that returns every reply.
    expect(ann.replies.map((r) => r.text)).toStrictEqual(["shared on purpose"]);
  });
});
