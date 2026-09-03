/**
 * #1752 — caller-supplied offsets must not reach a Y.Doc write or the
 * annotation store unvalidated.
 *
 * The unit-level rules live in `positions.test.ts`. This file pins the
 * BOUNDARY: the real MCP tool registrations, the two `.docx` resolvers that
 * carry STORED offsets (which are deliberately exempt from the surrogate rule),
 * the export resolver (which is deliberately NOT exempt — it writes a file), and
 * the file watcher's relocation pass.
 *
 * Why tool-level and not just `validateRange`: a clamp planted at
 * `document-store.anchorRange` — the same `Math.min` shape this change
 * deliberately sanctions at the `.docx` import site — passes every
 * `tandem_edit` and `tandem_getContext` case while `tandem_comment` still spans
 * to end-of-document. `tandem_comment` is the only live MCP annotation creator
 * (`tandem_highlight`/`tandem_suggest`/`tandem_flag` return DEPRECATED before
 * touching a range), so it is the case that discriminates.
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import JSZip from "jszip";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import { __testNotifyIssue } from "../../src/server/documents/populate.js";
import { addDoc, removeDoc, setActiveDocId } from "../../src/server/documents/registry-testing.js";
import { captureModel } from "../../src/server/file-io/docx-capture.js";
import type { ExportSkipReason } from "../../src/server/file-io/docx-comment-export.js";
import { prepareExportComments } from "../../src/server/file-io/docx-comment-export.js";
import { injectCommentsAsAnnotations } from "../../src/server/file-io/docx-comments.js";
import { exportYDocToDocx } from "../../src/server/file-io/docx-export.js";
import { getAdapter } from "../../src/server/file-io/index.js";
import { registerAnnotationTools } from "../../src/server/mcp/annotations.js";
import { populateYDoc, registerDocumentTools } from "../../src/server/mcp/document.js";
import { extractText } from "../../src/server/mcp/document-model.js";
import { getDocumentStore } from "../../src/server/mcp/document-store.js";
import { registerNavigationTools } from "../../src/server/mcp/navigation.js";
import { pushNotification } from "../../src/server/notifications.js";
import { anchoredRange } from "../../src/server/positions.js";
import { getOrCreateDocument } from "../../src/server/yjs/provider.js";
import { Y_MAP_ANNOTATIONS } from "../../src/shared/constants.js";
import { withInternal } from "../../src/shared/origins.js";
import { toFlatOffset } from "../../src/shared/positions/index.js";
import type { Annotation } from "../../src/shared/types.js";
import { off } from "../helpers/positions.js";

// The clamp notification is asserted by what it PUSHES, so the sink is mocked
// rather than the real notification queue inspected.
vi.mock("../../src/server/notifications.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/server/notifications.js")>()),
  pushNotification: vi.fn(),
}));

// ---------------------------------------------------------------------------
// MCP tool boundary
// ---------------------------------------------------------------------------

type CallToolResponse = Awaited<ReturnType<Client["callTool"]>>;

let client: Client;
const registered: string[] = [];

async function setupMcpClient(): Promise<Client> {
  const server = new McpServer({ name: "tandem-test", version: "0.0.1" });
  registerDocumentTools(server);
  registerAnnotationTools(server);
  registerNavigationTools(server);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const mcpClient = new Client({ name: "test-client", version: "0.0.1" });
  await server.connect(serverTransport);
  await mcpClient.connect(clientTransport);
  return mcpClient;
}

function parseResult(result: CallToolResponse) {
  const content = result.content as Array<{ type: string; text?: string }>;
  const textContent = content.find((c) => c.type === "text");
  return textContent?.text ? JSON.parse(textContent.text) : null;
}

function setupDoc(id: string, text: string) {
  const ydoc = getOrCreateDocument(id);
  populateYDoc(ydoc, text);
  addDoc(id, { id, filePath: `/tmp/${id}.md`, format: "md", readOnly: false, source: "file" });
  setActiveDocId(id);
  registered.push(id);
  return ydoc;
}

describe("MCP tool boundary rejects out-of-range offsets", () => {
  beforeEach(async () => {
    client = await setupMcpClient();
  });

  afterEach(async () => {
    for (const id of registered.splice(0)) removeDoc(id);
    await client?.close();
  });

  it("tandem_edit(6, 99999) is refused and the document is unchanged", async () => {
    const ydoc = setupDoc("bounds-edit", "First paragraph here\nSecond paragraph\nThird para");
    const before = extractText(ydoc);
    const res = parseResult(
      await client.callTool({
        name: "tandem_edit",
        arguments: { from: 6, to: 99999, newText: "X" },
      }),
    );
    expect(res.error).toBe(true);
    expect(res.code).toBe("INVALID_RANGE");
    expect(res.details?.reason).toBe("out-of-bounds");
    expect(extractText(ydoc)).toBe(before);
  });

  it("tandem_edit(-7, 5) is refused and the document is unchanged", async () => {
    const ydoc = setupDoc("bounds-edit-neg", "Alpha beta gamma\nDelta");
    const before = extractText(ydoc);
    const res = parseResult(
      await client.callTool({
        name: "tandem_edit",
        arguments: { from: -7, to: 5, newText: "Z" },
      }),
    );
    expect(res.error).toBe(true);
    expect(res.code).toBe("INVALID_RANGE");
    expect(res.details?.reason).toBe("out-of-bounds");
    expect(extractText(ydoc)).toBe(before);
  });

  it("tandem_edit(1.5, 3) is refused by the SCHEMA (.int()), before any handler runs", async () => {
    // Stated explicitly because the spec allows either answer: `.int()` on the
    // three live schema sites means the MCP SDK rejects it as a protocol error
    // rather than the handler returning INVALID_RANGE.
    const ydoc = setupDoc("bounds-edit-frac", "Alpha beta gamma\nDelta");
    const before = extractText(ydoc);
    const res = (await client.callTool({
      name: "tandem_edit",
      arguments: { from: 1.5, to: 3, newText: "Z" },
    })) as { isError?: boolean; content: Array<{ type: string; text?: string }> };
    // A protocol-level -32602, surfaced as an isError envelope rather than an
    // INVALID_RANGE from the handler. Stated because the spec permits either.
    expect(res.isError).toBe(true);
    // Matched loosely. "Expected integer, received float" is Zod's wording, not
    // this codebase's contract; pinning the literal makes a Zod bump read as a
    // range-validation regression.
    expect(res.content[0]?.text).toMatch(/integer/i);
    expect(extractText(ydoc)).toBe(before);
  });

  it("tandem_edit(n, n, 'x') INSERTS at n — point insertion is a supported capability", async () => {
    // `replaceFlatRangeInElement` guards only its DELETE on `to > from` and
    // always inserts, so this has always worked and is the only mid-document
    // insert path (`tandem_appendContent` appends at the document END and is
    // markdown-only). A blanket `from === to` refusal removed it with no
    // replacement.
    const ydoc = setupDoc("bounds-edit-point", "Alpha beta gamma");
    const res = parseResult(
      await client.callTool({
        name: "tandem_edit",
        arguments: { from: 5, to: 5, newText: " INSERTED" },
      }),
    );
    expect(res.error).toBe(false);
    expect(res.data?.edited).toBe(true);
    expect(extractText(ydoc)).toBe("Alpha INSERTED beta gamma");
  });

  it("tandem_edit(n, n) with a textSnapshot is refused rather than relocated", async () => {
    // The collision between point insertion and the standing "always pass
    // textSnapshot" rule, and it is destructive if allowed through: a
    // zero-length range slices to "", which never equals a non-empty snapshot,
    // so staleness fires and RANGE_MOVED names the span of the SNAPSHOT TEXT.
    // An agent following the documented retry then replaces those 18 characters
    // with newText — it asked to insert and got a deletion, having obeyed both
    // documented rules.
    const ydoc = setupDoc("bounds-edit-point-snap", "Revenue hit the $42,500 figure last year");
    const before = extractText(ydoc);
    const res = parseResult(
      await client.callTool({
        name: "tandem_edit",
        arguments: {
          from: 16,
          to: 16,
          newText: "roughly ",
          textSnapshot: "the $42,500 figure",
        },
      }),
    );
    expect(res.error).toBe(true);
    expect(res.code).toBe("INVALID_ARGUMENT");
    expect(res.code).not.toBe("RANGE_MOVED");
    expect(res.message).toMatch(/omit textsnapshot/i);
    expect(extractText(ydoc)).toBe(before);
  });

  it("tandem_edit(n, n, '') is the one genuine no-op and reports reason 'empty'", async () => {
    const ydoc = setupDoc("bounds-edit-noop", "Alpha beta gamma");
    const before = extractText(ydoc);
    const res = parseResult(
      await client.callTool({
        name: "tandem_edit",
        arguments: { from: 5, to: 5, newText: "" },
      }),
    );
    expect(res.error).toBe(true);
    expect(res.code).toBe("INVALID_RANGE");
    expect(res.details?.reason).toBe("empty");
    expect(extractText(ydoc)).toBe(before);
  });

  it("tandem_edit(1, 1, 'x') inside a heading prefix is still HEADING_OVERLAP", async () => {
    // The heading check runs AFTER the text-side checks, so `allowEmpty` (which
    // point insertion needs) must not swallow it: an empty range inside `"## "`
    // still answers HEADING_OVERLAP, exactly as master did.
    const ydoc = setupDoc("bounds-edit-point-heading", "## Head\nBody text");
    const before = extractText(ydoc);
    const res = parseResult(
      await client.callTool({
        name: "tandem_edit",
        arguments: { from: 1, to: 1, newText: "x" },
      }),
    );
    expect(res.error).toBe(true);
    expect(res.code).toBe("INVALID_RANGE");
    expect(res.message).toMatch(/heading markup/i);
    expect(extractText(ydoc)).toBe(before);
  });

  it("tandem_getContext(5, 5) succeeds — a zero-length context query is legitimate", async () => {
    // `allowEmpty: true` at the getContext call site was unpinned; nothing
    // stopped a later tidy from dropping it and turning every cursor-position
    // context read into INVALID_RANGE.
    setupDoc("bounds-ctx-point", "Alpha beta gamma\nDelta");
    const res = parseResult(
      await client.callTool({ name: "tandem_getContext", arguments: { from: 5, to: 5 } }),
    );
    expect(res.error).toBe(false);
  });

  it("tandem_edit splitting a surrogate pair is refused, and writes no U+FFFD", async () => {
    const ydoc = setupDoc("bounds-edit-emoji", "Hello \u{1F44B} world");
    const before = extractText(ydoc);
    expect(before).toBe("Hello \u{1F44B} world");
    const res = parseResult(
      await client.callTool({
        name: "tandem_edit",
        arguments: { from: 7, to: 9, newText: "X" },
      }),
    );
    expect(res.error).toBe(true);
    expect(res.code).toBe("INVALID_RANGE");
    expect(res.details?.reason).toBe("surrogate");
    expect(extractText(ydoc)).toBe(before);
    expect(extractText(ydoc)).not.toContain("�");
  });

  it("tandem_getContext(-1, 5) is refused rather than clamped", async () => {
    setupDoc("bounds-ctx", "Alpha beta gamma\nDelta");
    const res = parseResult(
      await client.callTool({ name: "tandem_getContext", arguments: { from: -1, to: 5 } }),
    );
    expect(res.error).toBe(true);
    expect(res.code).toBe("INVALID_RANGE");
    expect(res.details?.reason).toBe("out-of-bounds");
  });

  it("tandem_comment(6, 99999) is refused and adds NOTHING to the annotation map", async () => {
    const ydoc = setupDoc("bounds-comment", "Alpha beta gamma\nDelta");
    const map = ydoc.getMap(Y_MAP_ANNOTATIONS);
    expect(map.size).toBe(0);
    const res = parseResult(
      await client.callTool({
        name: "tandem_comment",
        arguments: { from: 6, to: 99999, text: "past the end" },
      }),
    );
    expect(res.error).toBe(true);
    expect(res.code).toBe("INVALID_RANGE");
    expect(res.details?.reason).toBe("out-of-bounds");
    // The discriminating assertion: a clamp at document-store.anchorRange would
    // pass every case above and still store a range spanning to end-of-document.
    expect(map.size).toBe(0);
  });

  it("LOGS the authorship stamp it skips after an edit, instead of dropping it silently", async () => {
    // `stampClaudeRange` returns silently on `!ok`, and that stays the
    // behaviour — the edit itself landed, so a missing overlay entry is
    // cosmetic. What is NOT cosmetic is the skip being invisible: the argument
    // for silence covers `surrogate` only, while `out-of-bounds` there would
    // mean the caller derived `from + newText.length` against a document state
    // it did not just write.
    //
    // Reaching it: the document holds a lone LOW surrogate at index 2, and
    // `newText` ends on a lone HIGH one. After the edit the two are adjacent, so
    // the stamp's end offset lands exactly between them.
    const ydoc = setupDoc("bounds-stamp-log", "ab\uDE00cd");
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const res = parseResult(
        await client.callTool({
          name: "tandem_edit",
          arguments: { from: 0, to: 2, newText: "Z\uD83D" },
        }),
      );
      expect(res.error).toBe(false);
      const lines = spy.mock.calls.map((a) => a.map(String).join(" "));
      const stampLine = lines.find((l) => l.includes("Authorship stamp skipped"));
      expect(stampLine, "the skip must not be silent").toBeDefined();
      expect(stampLine).toContain("surrogate");
      expect(stampLine).toContain("[0, 2]");
    } finally {
      spy.mockRestore();
    }
    // The edit itself still landed — the log is about the overlay, not the write.
    expect(extractText(ydoc)).toBe("Z😀cd");
  });

  it("unit twin: store.anchorRange past the end is not ok", async () => {
    const ydoc = setupDoc("bounds-store", "Alpha beta gamma\nDelta");
    const len = extractText(ydoc).length;
    const store = getDocumentStore("bounds-store");
    expect(store).toBeDefined();
    expect(store?.anchorRange(off(0), off(len + 1)).ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// .docx import: STORED offsets keep their clamp and their empty ranges
// ---------------------------------------------------------------------------

describe(".docx comment import", () => {
  let doc: Y.Doc;

  afterEach(() => {
    doc?.destroy();
    vi.restoreAllMocks();
  });

  function makeDoc(text: string): Y.Doc {
    doc = new Y.Doc();
    populateYDoc(doc, text);
    return doc;
  }

  function comment(commentId: string, from: number, to: number) {
    return {
      commentId,
      authorName: "Reviewer",
      authorInitials: "R",
      date: "2026-01-01T00:00:00Z",
      bodyText: `body ${commentId}`,
      from: toFlatOffset(from),
      to: toFlatOffset(to),
      replies: [],
    };
  }

  it("imports an insertion-point (from === to) comment rather than skipping it", () => {
    // `calculateCommentRanges` emits from === to for adjacent
    // commentRangeStart/End — reachable, and dropping it is the #1142 class.
    const d = makeDoc("Alpha beta gamma");
    const injected = injectCommentsAsAnnotations(d, [comment("c1", 6, 6)], "review.docx");
    expect(injected).toBe(1);
    expect(d.getMap(Y_MAP_ANNOTATIONS).size).toBe(1);
  });

  it("clamps a commentRangeEnd past the flat length instead of skipping the comment", () => {
    const d = makeDoc("Alpha beta gamma");
    const len = extractText(d).length;
    const injected = injectCommentsAsAnnotations(d, [comment("c2", 6, len + 40)], "review.docx");
    expect(injected).toBe(1);
    const stored = [...d.getMap(Y_MAP_ANNOTATIONS).values()] as Annotation[];
    expect(stored[0]?.range.to).toBe(len);
  });

  it("clamps BOTH ends when the OOXML accounting diverges past the end", () => {
    // Clamping `to` alone leaves a divergent `from` greater than the clamped
    // `to`, which is `inverted` BEFORE the upper bound runs — a logged skip,
    // the invisible loss the clamp exists to prevent.
    const d = makeDoc("Alpha beta gamma");
    const len = extractText(d).length;
    const injected = injectCommentsAsAnnotations(
      d,
      [comment("c3", len + 20, len + 40)],
      "review.docx",
    );
    expect(injected).toBe(1);
    const stored = [...d.getMap(Y_MAP_ANNOTATIONS).values()] as Annotation[];
    expect(stored[0]?.range).toEqual({ from: len, to: len });
  });

  it("imports a Word comment whose stored range splits an emoji, rather than skipping it", () => {
    // The import site inherits the same OOXML-vs-mdast accounting divergence the
    // clamp above exists for, and that divergence can land an offset BETWEEN the
    // halves of a pair as easily as past the end. Under the default
    // `surrogates: "reject"` the comment was never injected at all — absent from
    // `Y.Map('annotations')`, so the #1448 scoreboard cannot score it -1 and the
    // loss is invisible. Driven through `injectCommentsAsAnnotations`, NOT
    // `captureModel`: capture reads what import already stored, so a capture-only
    // spec passes vacuously on an empty map.
    const d = makeDoc("Hello \u{1F44B} world");
    expect(extractText(d)).toBe("Hello \u{1F44B} world");
    const injected = injectCommentsAsAnnotations(d, [comment("c-emoji", 0, 7)], "review.docx");
    expect(injected).toBe(1);
    const stored = [...d.getMap(Y_MAP_ANNOTATIONS).values()] as Annotation[];
    expect(stored).toHaveLength(1);
    expect(stored[0]?.range).toEqual({ from: 0, to: 7 });
  });

  it("reports ONE aggregate clamp signal carrying the count, not one per comment", () => {
    const d = makeDoc("Alpha beta gamma");
    const len = extractText(d).length;
    const clamps: Array<{ count: number; maxClamp: number }> = [];
    injectCommentsAsAnnotations(
      d,
      [comment("c-oob1", 2, len + 5), comment("c-oob2", 3, len + 11)],
      "review.docx",
      (info) => clamps.push(info),
    );
    expect(clamps).toHaveLength(1);
    expect(clamps[0]?.count).toBe(2);
    expect(clamps[0]?.maxClamp).toBe(11);
  });

  it("fires no clamp signal when nothing was clamped", () => {
    const d = makeDoc("Alpha beta gamma");
    const clamps: unknown[] = [];
    injectCommentsAsAnnotations(d, [comment("c-ok", 2, 7)], "review.docx", (i) => clamps.push(i));
    expect(clamps).toEqual([]);
  });

  it("the docx adapter turns the clamp into a LoadIssue on its apply() return", () => {
    // The seam between the callback and the issue list. `injectCommentsAsAnnotations`
    // firing `onClamp` proves nothing on its own: the adapter is what has to
    // catch it and put it where a caller will look.
    const d = makeDoc("Alpha beta gamma");
    const len = extractText(d).length;
    const issues = getAdapter("docx").apply(
      d,
      {
        format: "docx",
        html: "<p>Alpha beta gamma</p>",
        comments: [comment("c-adapter1", 2, len + 5), comment("c-adapter2", 3, len + 11)],
        footnoteBodies: {},
        issues: [],
      },
      { fileName: "review.docx" },
    );
    const clamped = issues.filter((i) => i.kind === "comments-clamped");
    expect(clamped).toHaveLength(1);
    expect(clamped[0]).toMatchObject({ count: 2, maxClamp: 11 });
  });

  it("the clamp LoadIssue reaches the user as a notification", () => {
    // The other half, and the one nothing pinned: an arm that pushes no
    // notification is a document that silently lost something. Asserted on the
    // WORDING too, because "moved to the end" was wrong — the clamp is a
    // `Math.min` per end, so a comment whose `from` is in range is STRETCHED to
    // the end rather than moved there.
    const pushed = vi.mocked(pushNotification);
    pushed.mockClear();
    __testNotifyIssue(
      { kind: "comments-clamped", count: 2, maxClamp: 11 },
      { displayName: "review.docx", dedupSource: "/tmp/review.docx" },
    );
    expect(pushed).toHaveBeenCalledTimes(1);
    const msg = String(pushed.mock.calls[0]?.[0]?.message);
    expect(msg).toContain("2 Word comments");
    expect(msg).toContain("review.docx");
    expect(msg).toMatch(/shortened or moved to the end/);
    expect(msg).toContain("11 characters");
  });

  it("captureModel scores an imported point comment with a real range, not -1/-1", () => {
    const d = makeDoc("Alpha beta gamma");
    injectCommentsAsAnnotations(d, [comment("c4", 6, 6)], "review.docx");
    const captured = captureModel(d);
    expect(captured.annotations).toHaveLength(1);
    expect(captured.annotations[0]?.from).toBe(6);
    expect(captured.annotations[0]?.to).toBe(6);
  });

  it("captureModel scores a stored range that ends mid-pair, rather than -1/-1", () => {
    // Stored offsets, not caller-supplied: after a CRDT edit inside an emoji a
    // refreshed range can legitimately end mid-pair (Word's own offsets are
    // UTF-16). Rejecting it here would score a real comment as lost.
    const d = makeDoc("Hello \u{1F44B} world");
    const map = d.getMap(Y_MAP_ANNOTATIONS);
    withInternal(d, () => {
      map.set("mid-pair", {
        id: "mid-pair",
        author: "import",
        type: "note",
        audience: "private",
        range: { from: 0, to: 7 },
        content: "Word comment",
        status: "pending",
        timestamp: 1700000000000,
        rev: 1,
        importSource: { author: "Reviewer", file: "review.docx", commentId: "c5" },
      });
    });
    const captured = captureModel(d);
    expect(captured.annotations).toHaveLength(1);
    expect(captured.annotations[0]?.from).toBe(0);
    expect(captured.annotations[0]?.to).toBe(7);
  });
});

// ---------------------------------------------------------------------------
// .docx comment export: NOT symmetric with capture — snap, don't ignore
// ---------------------------------------------------------------------------

describe(".docx comment export resolver", () => {
  let doc: Y.Doc;

  afterEach(() => {
    doc?.destroy();
    vi.restoreAllMocks();
  });

  function docWith(text: string, ranges: Array<{ from: number; to: number }>): Y.Doc {
    doc = new Y.Doc();
    populateYDoc(doc, text);
    const map = doc.getMap(Y_MAP_ANNOTATIONS);
    withInternal(doc, () => {
      ranges.forEach((r, i) => {
        const anchored = anchoredRange(doc, toFlatOffset(r.from), toFlatOffset(r.to), undefined, {
          allowEmpty: true,
          surrogates: "ignore",
        });
        map.set(`exp-${i}`, {
          id: `exp-${i}`,
          author: "claude",
          type: "comment",
          audience: "outbound",
          range: { from: r.from, to: r.to },
          content: `Comment ${i}`,
          status: "pending",
          timestamp: 1700000000000,
          rev: 1,
          ...(anchored.ok && anchored.fullyAnchored ? { relRange: anchored.relRange } : {}),
        });
      });
    });
    return doc;
  }

  it("exports a point comment (from === to) rather than dropping it", () => {
    const d = docWith("Alpha beta gamma", [{ from: 6, to: 6 }]);
    const skips: ExportSkipReason[] = [];
    const out = prepareExportComments(d, (r) => skips.push(r));
    expect(skips).toEqual([]);
    expect(out).toHaveLength(1);
  });

  it("counts an out-of-bounds stored range as out-of-bounds in onSkip", () => {
    const d = docWith("Alpha beta gamma", []);
    const map = d.getMap(Y_MAP_ANNOTATIONS);
    withInternal(d, () => {
      map.set("oob", {
        id: "oob",
        author: "claude",
        type: "comment",
        audience: "outbound",
        range: { from: 2, to: 9999 },
        content: "past the end",
        status: "pending",
        timestamp: 1700000000000,
        rev: 1,
      });
    });
    const skips: ExportSkipReason[] = [];
    prepareExportComments(d, (r) => skips.push(r));
    expect(skips).toEqual(["out-of-bounds"]);
  });

  it("counts an INVERTED stored range as invalid-range in onSkip", () => {
    // The `invalid-range` arm of the skip taxonomy had no spec at all — every
    // existing case landed in `out-of-bounds` or `range-failed`, so the arm was
    // reachable only by reading the code.
    const d = docWith("Alpha beta gamma", []);
    const map = d.getMap(Y_MAP_ANNOTATIONS);
    withInternal(d, () => {
      map.set("inverted", {
        id: "inverted",
        author: "claude",
        type: "comment",
        audience: "outbound",
        range: { from: 9, to: 2 },
        content: "backwards",
        status: "pending",
        timestamp: 1700000000000,
        rev: 1,
      });
    });
    const skips: ExportSkipReason[] = [];
    prepareExportComments(d, (r) => skips.push(r));
    expect(skips).toEqual(["invalid-range"]);
  });

  it("snaps the FROM half of a mid-pair range outward too", () => {
    // The `from--` half of the snap had no spec: every existing case exercised
    // only `to++`. On "Hello 👋 world" the pair occupies units 6-7, so from: 7
    // is mid-pair and must snap DOWN to 6.
    const d = docWith("Hello \u{1F44B} world", [{ from: 7, to: 13 }]);
    const out = prepareExportComments(d);
    expect(out).toHaveLength(1);
    expect(out[0]?.from).toBe(6);
    expect(out[0]?.to).toBe(13);
  });

  it("does NOT snap at offset 0 of a text beginning with a lone low surrogate", () => {
    // The one-sided `isLowSurrogate(charCodeAt(from))` predicate this replaced
    // fired here, producing `from = -1` and then an `out-of-bounds` skip — a
    // comment silently dropped from the exported file. The paired predicate
    // returns false at i <= 0, so the comment exports unchanged.
    const d = docWith("\uDC4B tail text", [{ from: 0, to: 5 }]);
    const skips: ExportSkipReason[] = [];
    const out = prepareExportComments(d, (r) => skips.push(r));
    expect(skips).toEqual([]);
    expect(out).toHaveLength(1);
    expect(out[0]?.from).toBe(0);
  });

  it("does NOT widen a range ending on a lone low surrogate that splits nothing", () => {
    // The second half of the one-sided predicate's defect, and the half a
    // `"😀😀"` fixture cannot show: at offset 2 of two adjacent emoji the unit is
    // a HIGH surrogate, so `isLowSurrogate` was already false there and such a
    // spec is green under the OLD code too.
    //
    // `"a\uDC4B"` is the discriminating shape — a lone LOW surrogate at index 1,
    // preceded by "a". `to = 1` splits nothing (there is no pair), but the old
    // one-sided check sees a low surrogate at `to` and widens to 2. The paired
    // predicate asks what precedes it, finds "a", and leaves the range alone.
    const d = docWith("a\uDC4B tail", [{ from: 0, to: 1 }]);
    const skips: ExportSkipReason[] = [];
    const out = prepareExportComments(d, (r) => skips.push(r));
    expect(skips).toEqual([]);
    expect(out).toHaveLength(1);
    expect(out[0]?.from).toBe(0);
    expect(out[0]?.to).toBe(1);
  });

  it("snaps a stored range that ends mid-pair OUTWARD, keeping the emoji intact in the .docx", async () => {
    // The discriminating case. `surrogates: "ignore"` here would let the
    // mid-pair offset through to `emitTextSegments`, which splits a run with
    // `s.slice(0, take)` — ending one TextRun on a lone high surrogate and
    // starting the next on a lone low one. The zip's UTF-8 encode then writes
    // two U+FFFD into the user's saved document.
    const d = docWith("Hello \u{1F44B} world", [{ from: 0, to: 7 }]);
    const out = prepareExportComments(d);
    expect(out).toHaveLength(1);
    expect(out[0]?.to).toBe(8); // snapped outward past the low surrogate

    const buf = await exportYDocToDocx(d);
    const zip = await JSZip.loadAsync(buf);
    const xml = await zip.file("word/document.xml")?.async("string");
    expect(xml).toBeDefined();
    expect(xml).toContain("\u{1F44B}");
    expect(xml).not.toContain("�");
  });
});
