/**
 * #1619 / #1710 — the audience gate was closed on push only.
 *
 * `narrowForChannel` has required `audience === "outbound" && type !== "note"`
 * since it landed, but the PULL surfaces — the ones CLAUDE.md makes
 * authoritative over every push path — tested type alone:
 * `tandem_getAnnotations` and `tandem_exportAnnotations` on `type !== "note"`,
 * `channelVisibleReplies` on `type === "comment"`, and both `checkInbox`
 * buckets on their own type predicates. So a stored
 * `{comment, audience: "private"}` record was withheld from the channel and
 * delivered on the next poll — and every user HIGHLIGHT, which ADR-027 has said
 * is "not sent to Claude" since the ADR was written, was returned on every read.
 *
 * All four now share `isClaudeFacing`, stated once beside the push-side
 * conjunction it mirrors.
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type * as Y from "yjs";
import { isClaudeFacing, narrowForChannel } from "../../src/server/annotations/projection.js";
import { addDoc, setActiveDocId } from "../../src/server/documents/registry-testing.js";
import {
  channelVisibleReplies,
  registerAnnotationTools,
} from "../../src/server/mcp/annotations.js";
import {
  processInboxAnnotations,
  registerAwarenessTools,
  resetInbox,
} from "../../src/server/mcp/awareness.js";
import { populateYDoc } from "../../src/server/mcp/document.js";
import { getOrCreateDocument, removeDocument } from "../../src/server/yjs/provider.js";
import { Y_MAP_ANNOTATION_REPLIES, Y_MAP_ANNOTATIONS } from "../../src/shared/constants.js";
import { withInternal } from "../../src/shared/origins.js";
import { sanitizeAnnotation } from "../../src/shared/sanitize.js";
import type { Annotation, AnnotationReply } from "../../src/shared/types.js";
import { setCtrlMode } from "../helpers/ctrl-mode.js";
import { clearOpenDocs } from "../helpers/doc-service.js";
import { noRelay } from "../helpers/ydoc-factory.js";

const DOC_ID = "read-audience-doc";

let doc: Y.Doc;
let client: Client;

type CallToolResponse = Awaited<ReturnType<Client["callTool"]>>;

function parseResult(result: CallToolResponse) {
  const content = result.content as Array<{ type: string; text?: string }>;
  const text = content.find((c) => c.type === "text");
  return text?.text ? JSON.parse(text.text) : null;
}

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

/** The three fixtures every row below shares, plus one non-private reply. */
function seedFixtures(): void {
  const map = doc.getMap(Y_MAP_ANNOTATIONS);
  const replies = doc.getMap(Y_MAP_ANNOTATION_REPLIES);
  withInternal(doc, () => {
    // The private user comment: reachable by a legacy envelope or a stale-tab
    // merge, and `sanitizeAnnotation` does not heal one.
    map.set("priv", {
      id: "priv",
      author: "user",
      type: "comment",
      audience: "private",
      range: { from: 0, to: 5 },
      content: "private comment",
      status: "pending",
      timestamp: 1,
      rev: 1,
    });
    // The control.
    map.set("ctl", {
      id: "ctl",
      author: "claude",
      type: "comment",
      audience: "outbound",
      range: { from: 6, to: 11 },
      content: "claude comment",
      status: "pending",
      timestamp: 2,
      rev: 1,
    });
    // #1710: a USER highlight with NO stored audience — sanitize derives
    // `private`. Kills a filter that reads the stored field instead of the
    // sanitized one.
    map.set("hl", {
      id: "hl",
      author: "user",
      type: "highlight",
      range: { from: 0, to: 5 },
      content: "",
      status: "pending",
      timestamp: 3,
      rev: 1,
    });
    replies.set("r1", {
      id: "r1",
      annotationId: "priv",
      author: "user",
      text: "a reply on the private parent",
      timestamp: 4,
      rev: 1,
    });
  });
}

beforeEach(async () => {
  clearOpenDocs();
  removeDocument(DOC_ID);
  resetInbox();
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
  seedFixtures();
  setCtrlMode("tandem");
  client = await setupMcpClient();
});

afterEach(async () => {
  await client.close();
  clearOpenDocs();
  removeDocument(DOC_ID);
  setCtrlMode(null);
  resetInbox();
});

describe("the Claude-facing reads honour audience (#1619, #1710)", () => {
  it("tandem_getAnnotations returns only the outbound control and discloses the count", async () => {
    const parsed = parseResult(
      await client.callTool({ name: "tandem_getAnnotations", arguments: {} }),
    );

    expect(parsed.data.annotations.map((a: Annotation) => a.id)).toEqual(["ctl"]);
    expect(parsed.data.privateExcluded).toBe(2);
    expect(parsed.data.notesExcluded).toBeUndefined();
  });

  it("returns a CLAUDE-authored outbound highlight, so highlights are not dropped by type", async () => {
    // #1710 row 2 — the tutorial's first card is exactly this shape, and a fix
    // that filtered highlights by type would erase it from Claude's view.
    withInternal(doc, () => {
      doc.getMap(Y_MAP_ANNOTATIONS).set("chl", {
        id: "chl",
        author: "claude",
        type: "highlight",
        audience: "outbound",
        range: { from: 6, to: 11 },
        content: "",
        status: "pending",
        timestamp: 5,
        rev: 1,
      });
    });

    const parsed = parseResult(
      await client.callTool({
        name: "tandem_getAnnotations",
        arguments: { type: "highlight" },
      }),
    );

    expect(parsed.data.annotations.map((a: Annotation) => a.id)).toEqual(["chl"]);
    expect(parsed.data.privateExcluded).toBe(1);
  });

  it("tandem_exportAnnotations carries the two floors side by side", async () => {
    const jsonParsed = parseResult(
      await client.callTool({
        name: "tandem_exportAnnotations",
        arguments: { format: "json" },
      }),
    );
    expect(jsonParsed.data.annotations.map((a: Annotation) => a.id)).toEqual(["ctl"]);
    expect(jsonParsed.data.privateExcluded).toBe(2);
    expect(jsonParsed.data.heldFromExport).toBeUndefined();

    // In Solo an outbound USER comment is held — a SECOND, independent floor.
    withInternal(doc, () => {
      doc.getMap(Y_MAP_ANNOTATIONS).set("uo", {
        id: "uo",
        author: "user",
        type: "comment",
        audience: "outbound",
        range: { from: 6, to: 11 },
        content: "outbound user comment",
        status: "pending",
        timestamp: 6,
        rev: 1,
      });
    });
    setCtrlMode("solo");

    const solo = parseResult(
      await client.callTool({
        name: "tandem_exportAnnotations",
        arguments: { format: "json" },
      }),
    );
    expect(solo.data.heldFromExport).toBe(1);
    expect(solo.data.privateExcluded).toBe(2);

    const md = parseResult(
      await client.callTool({
        name: "tandem_exportAnnotations",
        arguments: { format: "markdown" },
      }),
    );
    expect(md.data.heldFromExport).toBe(1);
    expect(md.data.privateExcluded).toBe(2);
    // The markdown TEXT carries neither count — no footer exists and none is added.
    expect(md.data.markdown).not.toContain("privateExcluded");
    expect(md.data.markdown).not.toContain("heldFromExport");
  });

  it("processInboxAnnotations puts a private record in neither bucket and writes no ledger entry", () => {
    // The ledger check is what kills a filter placed AFTER `surfaced.set`: such
    // a filter would return nothing this poll AND permanently dedup-skip the
    // record, so an arm-only assertion cannot see it.
    const map = doc.getMap(Y_MAP_ANNOTATIONS);
    withInternal(doc, () => {
      map.set("cpriv", {
        id: "cpriv",
        author: "claude",
        type: "comment",
        audience: "private",
        range: { from: 0, to: 5 },
        content: "claude private",
        status: "dismissed",
        timestamp: 7,
        rev: 1,
      });
    });
    const all = [...map.values()].map((v) => sanitizeAnnotation(v as Annotation, noRelay));
    const ledger = new Map<string, number>();

    const { userActions, userResponses } = processInboxAnnotations(
      all,
      "Hello world here",
      ledger,
      (anns) => anns,
      DOC_ID,
      "tandem",
      () => false,
    );

    expect(userActions.map((a) => a.id)).toEqual([]);
    expect(userResponses.map((a) => a.id)).toEqual([]);
    expect([...ledger.keys()].some((k) => k.includes("priv"))).toBe(false);
    expect([...ledger.keys()].some((k) => k.includes("cpriv"))).toBe(false);
  });

  it("channelVisibleReplies refuses a private parent and serves an outbound one", () => {
    const map = doc.getMap(Y_MAP_ANNOTATIONS);
    const priv = sanitizeAnnotation(map.get("priv") as Annotation, noRelay);
    const ctl = sanitizeAnnotation(map.get("ctl") as Annotation, noRelay);
    const load = (id: string): AnnotationReply[] => [
      { id: "x", annotationId: id, author: "user", text: "hi", timestamp: 1 },
    ];

    expect(channelVisibleReplies(priv, load)).toEqual([]);
    expect(channelVisibleReplies(ctl, load)).toHaveLength(1);
  });

  it("agrees with narrowForChannel over every (type × audience) cell", () => {
    // The grid pin: `isClaudeFacing` and the push-side pair are the same
    // conjunction written twice, and this is what stops them drifting.
    //
    // CLAUDE-authored on purpose: sanitize demotes a USER outbound
    // note/highlight/flag, which would collapse two cells into their private
    // twins. The `{highlight, outbound}` cell is what separates
    // `type !== "note"` from `type === "comment"`.
    for (const type of ["highlight", "note", "comment"] as const) {
      for (const audience of ["private", "outbound"] as const) {
        const ann = sanitizeAnnotation(
          {
            id: `g_${type}_${audience}`,
            author: "claude",
            type,
            audience,
            range: { from: 0, to: 5 },
            content: "x",
            status: "pending",
            timestamp: 1,
          } as unknown as Annotation,
          noRelay,
        );
        // Pre-assert the cell survived sanitize, or the row below compares
        // two functions on a record that is no longer the cell under test.
        expect([ann.type, ann.audience], `cell ${type}/${audience}`).toEqual([type, audience]);
        expect(isClaudeFacing(ann), `cell ${type}/${audience}`).toBe(
          narrowForChannel(ann, {}) !== null,
        );
      }
    }
  });
});
