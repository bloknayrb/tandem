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
import { addDoc, removeDoc, setActiveDocId } from "../../src/server/documents/registry-testing.js";
import { captureModel } from "../../src/server/file-io/docx-capture.js";
import type { ExportSkipReason } from "../../src/server/file-io/docx-comment-export.js";
import { prepareExportComments } from "../../src/server/file-io/docx-comment-export.js";
import { injectCommentsAsAnnotations } from "../../src/server/file-io/docx-comments.js";
import { exportYDocToDocx } from "../../src/server/file-io/docx-export.js";
import { registerAnnotationTools } from "../../src/server/mcp/annotations.js";
import { populateYDoc, registerDocumentTools } from "../../src/server/mcp/document.js";
import { extractText } from "../../src/server/mcp/document-model.js";
import { getDocumentStore } from "../../src/server/mcp/document-store.js";
import { registerNavigationTools } from "../../src/server/mcp/navigation.js";
import { anchoredRange } from "../../src/server/positions.js";
import { getOrCreateDocument } from "../../src/server/yjs/provider.js";
import { Y_MAP_ANNOTATIONS } from "../../src/shared/constants.js";
import { withInternal } from "../../src/shared/origins.js";
import { toFlatOffset } from "../../src/shared/positions/index.js";
import type { Annotation } from "../../src/shared/types.js";
import { off } from "../helpers/positions.js";

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
    expect(res.content[0]?.text).toContain("Expected integer, received float");
    expect(extractText(ydoc)).toBe(before);
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
