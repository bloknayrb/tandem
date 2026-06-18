// #1068 (#576 v1.1): Tandem comment-type annotations → Word comments on
// .docx export. XML-level assertions answer the three open questions carried
// from #576 empirically:
//   1. docx@9.6 marker placement → import-side `calculateCommentRanges`
//      recomputes the exact exported offsets.
//   2. Inline reformatting (marks) inside a comment range does not shift the
//      recomputed anchors (flat offsets ignore marks).
//   3. An imported Word comment promoted to a Tandem comment round-trips with
//      the SAME deterministic `importAnnotationId`, so the existing inject
//      dedup + durable LWW merge converge instead of duplicating.
// Plus the ADR-027 hard gate: note content must never appear in ANY generated
// XML part.

import JSZip from "jszip";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import { loadDocx } from "../../src/server/file-io/docx.js";
import { prepareExportComments } from "../../src/server/file-io/docx-comment-export.js";
import {
  calculateCommentRanges,
  extractDocxComments,
  importAnnotationId,
  injectCommentsAsAnnotations,
} from "../../src/server/file-io/docx-comments.js";
import { exportYDocToDocx } from "../../src/server/file-io/docx-export.js";
import { htmlToYDoc } from "../../src/server/file-io/docx-html.js";
import { extractText } from "../../src/server/mcp/document-model.js";
import { anchoredRange } from "../../src/server/positions.js";
import { Y_MAP_ANNOTATION_REPLIES, Y_MAP_ANNOTATIONS } from "../../src/shared/constants.js";
import { withInternal } from "../../src/shared/origins.js";
import { toFlatOffset } from "../../src/shared/positions/index.js";
import type { Annotation, AnnotationReply } from "../../src/shared/types.js";
import { buildDocxWithComments } from "../helpers/docx-fixtures.js";

let doc: Y.Doc;
let idCounter = 0;

beforeEach(() => {
  idCounter = 0;
});

afterEach(() => {
  doc?.destroy();
  vi.restoreAllMocks();
});

/** Build a Y.Doc from HTML, the same way a .docx import lands content. */
function docFromHtml(html: string): Y.Doc {
  doc = new Y.Doc();
  htmlToYDoc(doc, html);
  return doc;
}

/** Insert an annotation into the doc's map (CRDT-anchored when possible). */
function addAnnotation(
  d: Y.Doc,
  from: number,
  to: number,
  overrides: Partial<Annotation> & Record<string, unknown> = {},
): string {
  const id = (overrides.id as string) ?? `test-ann-${idCounter++}`;
  const anchored = anchoredRange(d, toFlatOffset(from), toFlatOffset(to));
  const ann = {
    id,
    author: "claude",
    type: "comment",
    audience: "outbound",
    range: { from, to },
    content: "Comment body",
    status: "pending",
    timestamp: 1700000000000,
    rev: 1,
    ...(anchored.ok && anchored.fullyAnchored ? { relRange: anchored.relRange } : {}),
    ...overrides,
  };
  withInternal(d, () => d.getMap(Y_MAP_ANNOTATIONS).set(id, ann));
  return id;
}

function addReply(d: Y.Doc, reply: Partial<AnnotationReply> & { annotationId: string }): void {
  const full: AnnotationReply = {
    id: `reply-${idCounter++}`,
    author: "user",
    text: "reply text",
    timestamp: 1700000001000,
    rev: 1,
    ...reply,
  };
  withInternal(d, () => d.getMap(Y_MAP_ANNOTATION_REPLIES).set(full.id, full));
}

async function unzip(buffer: Buffer): Promise<JSZip> {
  return JSZip.loadAsync(buffer);
}

async function readPart(zip: JSZip, name: string): Promise<string | undefined> {
  return zip.file(name)?.async("text");
}

/** Concatenated text of every XML part in the zip (privacy leak scan). */
async function allXmlText(zip: JSZip): Promise<string> {
  const parts: string[] = [];
  for (const name of Object.keys(zip.files)) {
    if (zip.files[name].dir) continue;
    parts.push(await zip.files[name].async("text"));
  }
  return parts.join("\n");
}

/** Re-import an exported buffer the way Tandem opens a .docx. */
async function reimport(buffer: Buffer): Promise<Y.Doc> {
  const html = await loadDocx(buffer);
  const out = new Y.Doc();
  htmlToYDoc(out, html);
  return out;
}

// ---------------------------------------------------------------------------
// Emission + anchoring (open question 1)
// ---------------------------------------------------------------------------

describe("exportYDocToDocx — comment emission", () => {
  it("emits a pending comment annotation as a Word comment with range markers", async () => {
    const d = docFromHtml("<p>Hello brave world</p>");
    addAnnotation(d, 6, 11, { content: "Tighten this" });

    const buffer = await exportYDocToDocx(d);
    const zip = await unzip(buffer);

    const commentsXml = await readPart(zip, "word/comments.xml");
    expect(commentsXml).toBeTruthy();
    expect(commentsXml).toContain("Tighten this");
    expect(commentsXml).toContain('w:author="Claude"');

    const documentXml = (await readPart(zip, "word/document.xml"))!;
    expect(documentXml).toContain("<w:commentRangeStart");
    expect(documentXml).toContain("<w:commentRangeEnd");
    expect(documentXml).toContain("<w:commentReference");

    // The import-side walker recomputes the EXACT offsets we anchored at.
    const ranges = calculateCommentRanges(documentXml);
    expect([...ranges.values()]).toEqual([{ from: 6, to: 11 }]);
  });

  it("round-trips through the real import path and anchors to the same text", async () => {
    const d = docFromHtml("<p>Hello brave world</p>");
    addAnnotation(d, 6, 11, { content: "Tighten this" });

    const buffer = await exportYDocToDocx(d);
    const extracted = await extractDocxComments(buffer);
    expect(extracted).toHaveLength(1);
    expect(extracted[0].bodyText).toBe("Tighten this");

    const back = await reimport(buffer);
    expect(extractText(back).slice(extracted[0].from, extracted[0].to)).toBe("brave");
    back.destroy();
  });

  it("anchors comments inside headings (flat offsets include the heading prefix)", async () => {
    const d = docFromHtml("<h2>Title here</h2><p>Body</p>");
    // "## Title here" — "Title" is [3, 8).
    addAnnotation(d, 3, 8, { content: "On the title" });

    const buffer = await exportYDocToDocx(d);
    const documentXml = (await readPart(await unzip(buffer), "word/document.xml"))!;
    const ranges = calculateCommentRanges(documentXml);
    expect([...ranges.values()]).toEqual([{ from: 3, to: 8 }]);

    const back = await reimport(buffer);
    expect(extractText(back).slice(3, 8)).toBe("Title");
    back.destroy();
  });

  it("anchors a range spanning two paragraphs", async () => {
    const d = docFromHtml("<p>One two</p><p>Three four</p>");
    // flat: "One two\nThree four" — [4, 13) = "two\nThree"
    addAnnotation(d, 4, 13, { content: "Crosses blocks" });

    const buffer = await exportYDocToDocx(d);
    const documentXml = (await readPart(await unzip(buffer), "word/document.xml"))!;
    expect([...calculateCommentRanges(documentXml).values()]).toEqual([{ from: 4, to: 13 }]);

    const back = await reimport(buffer);
    expect(extractText(back).slice(4, 13)).toBe("two\nThree");
    back.destroy();
  });

  it("anchors comments after lists and inside complex documents", async () => {
    const d = docFromHtml(
      "<h1>Doc</h1><ul><li><p>alpha</p></li><li><p>beta</p></li></ul><p>Final paragraph</p>",
    );
    const flat = extractText(d);
    const from = flat.indexOf("Final");
    const to = from + "Final".length;
    addAnnotation(d, from, to, { content: "After the list" });

    const buffer = await exportYDocToDocx(d);
    const extracted = await extractDocxComments(buffer);
    expect(extracted).toHaveLength(1);

    const back = await reimport(buffer);
    expect(extractText(back).slice(extracted[0].from, extracted[0].to)).toBe("Final");
    back.destroy();
  });

  it("keeps anchors stable when the range contains inline formatting (open question 2)", async () => {
    const d = docFromHtml("<p>plain <strong>bold</strong> tail</p>");
    // [0, 15) = "plain bold tail" — spans across mark boundaries.
    addAnnotation(d, 0, 15, { content: "Formatted span" });

    const buffer = await exportYDocToDocx(d);
    const documentXml = (await readPart(await unzip(buffer), "word/document.xml"))!;
    expect([...calculateCommentRanges(documentXml).values()]).toEqual([{ from: 0, to: 15 }]);

    const back = await reimport(buffer);
    expect(extractText(back).slice(0, 15)).toBe("plain bold tail");
    back.destroy();
  });

  it("resolves drifted flat offsets from the CRDT relRange before anchoring", async () => {
    const d = docFromHtml("<p>Hello brave world</p>");
    // Anchor "brave" with a live relRange...
    addAnnotation(d, 6, 11, { content: "Tighten this" });
    // ...then edit text BEFORE it so the stored flat offsets go stale.
    withInternal(d, () => {
      const p = d.getXmlFragment("default").get(0) as Y.XmlElement;
      const t = p.get(0) as Y.XmlText;
      t.insert(0, "XXXX ");
    });
    expect(extractText(d).slice(11, 16)).toBe("brave");

    const buffer = await exportYDocToDocx(d);
    const documentXml = (await readPart(await unzip(buffer), "word/document.xml"))!;
    // Markers follow the CRDT-resolved position, not the stale flat range.
    expect([...calculateCommentRanges(documentXml).values()]).toEqual([{ from: 11, to: 16 }]);
  });

  it("skips annotations whose ranges no longer resolve, without failing the save", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const d = docFromHtml("<p>Hello brave world</p>");
    addAnnotation(d, 6, 11, { content: "Good one" });
    // Out-of-bounds flat range with no CRDT anchor: relRange resolution can't
    // help, lazy re-anchoring fails, and the flat offsets exceed the document.
    addAnnotation(d, 500, 510, { content: "Stale one", relRange: undefined });

    const buffer = await exportYDocToDocx(d);
    const extracted = await extractDocxComments(buffer);
    expect(extracted).toHaveLength(1);
    expect(extracted[0].bodyText).toBe("Good one");
    expect(
      errSpy.mock.calls.some((args) => String(args[0]).includes("[docx-comment-export] Skipping")),
    ).toBe(true);
  });

  it("emits no comment entries when there is nothing to export", async () => {
    // Note: docx@9.x always writes an EMPTY word/comments.xml scaffold; the
    // assertion that matters is that no <w:comment> entries exist.
    const d = docFromHtml("<p>Hello</p>");
    const buffer = await exportYDocToDocx(d);
    expect(await extractDocxComments(buffer)).toHaveLength(0);
    const documentXml = (await readPart(await unzip(buffer), "word/document.xml"))!;
    expect(documentXml).not.toContain("commentRangeStart");
  });
});

// ---------------------------------------------------------------------------
// ADR-027 privacy gate
// ---------------------------------------------------------------------------

describe("exportYDocToDocx — ADR-027 privacy gate", () => {
  it("never emits note annotations or their content anywhere in the XML", async () => {
    const d = docFromHtml("<p>Hello brave world</p>");
    addAnnotation(d, 0, 5, {
      type: "note",
      author: "user",
      audience: "private",
      content: "SECRET-NOTE-CONTENT",
    });

    const buffer = await exportYDocToDocx(d);
    expect(await extractDocxComments(buffer)).toHaveLength(0);
    expect(await allXmlText(await unzip(buffer))).not.toContain("SECRET-NOTE-CONTENT");
  });

  it("writes un-promoted imported Word comments back to the file (round-trip, not Claude exposure)", async () => {
    const d = docFromHtml("<p>Hello brave world</p>");
    addAnnotation(d, 0, 5, {
      type: "note",
      author: "import",
      audience: "private",
      content: "REVIEWER-BODY",
      importSource: { author: "Alice", file: "review.docx", commentId: "7" },
    });

    const buffer = await exportYDocToDocx(d);
    // The import round-trips: it is content the user opened from THIS file and
    // expects to still be there on save (Bryan's directive). The byline is the
    // original reviewer; the original w:id is reused for re-import dedup.
    const reExtracted = await extractDocxComments(buffer);
    expect(reExtracted).toHaveLength(1);
    expect(reExtracted[0].commentId).toBe("7");
    expect(reExtracted[0].authorName).toBe("Alice");
    expect(reExtracted[0].bodyText).toBe("REVIEWER-BODY");
  });

  it("does NOT export an author:import record lacking importSource (provenance corroboration)", async () => {
    // The durable store's .passthrough() envelope leaves `author` its least-
    // validated field. A tampered/legacy record claiming author:"import" but
    // carrying user content (no importSource) must NOT bypass the gate, or it
    // leaks private content into a shared file. The carve-out requires BOTH.
    const d = docFromHtml("<p>Hello brave world</p>");
    addAnnotation(d, 0, 5, {
      type: "note",
      author: "import",
      audience: "private",
      content: "SMUGGLED-PRIVATE-CONTENT",
      // importSource deliberately absent
    });

    const buffer = await exportYDocToDocx(d);
    expect(await extractDocxComments(buffer)).toHaveLength(0);
    expect(await allXmlText(await unzip(buffer))).not.toContain("SMUGGLED-PRIVATE-CONTENT");
  });

  it("exports accepted/dismissed imports too (status is review state, not file content)", async () => {
    // Per the directive ("imported comments should not be dropped"), an import
    // round-trips regardless of pending/accepted/dismissed; only an explicit
    // delete (removal from the map) drops it. A user/Claude resolved comment
    // still drops (see the claude-resolved test above).
    const d = docFromHtml("<p>Hello brave world</p>");
    addAnnotation(d, 0, 5, {
      type: "note",
      author: "import",
      audience: "private",
      status: "dismissed",
      content: "DISMISSED-IMPORT-BODY",
      importSource: { author: "Bob", file: "review.docx", commentId: "9" },
    });

    expect(await allXmlText(await unzip(await exportYDocToDocx(d)))).toContain(
      "DISMISSED-IMPORT-BODY",
    );
  });

  it("never emits highlights", async () => {
    const d = docFromHtml("<p>Hello brave world</p>");
    addAnnotation(d, 0, 5, {
      type: "highlight",
      author: "user",
      audience: "private",
      color: "yellow",
      content: "HIGHLIGHT-CONTENT",
    });

    const buffer = await exportYDocToDocx(d);
    expect(await extractDocxComments(buffer)).toHaveLength(0);
    expect(await allXmlText(await unzip(buffer))).not.toContain("HIGHLIGHT-CONTENT");
  });

  it("excludes private-audience and resolved comments", async () => {
    const d = docFromHtml("<p>Hello brave world</p>");
    addAnnotation(d, 0, 5, { content: "PRIVATE-COMMENT", audience: "private" });
    addAnnotation(d, 0, 5, { content: "ACCEPTED-COMMENT", status: "accepted" });
    addAnnotation(d, 0, 5, { content: "DISMISSED-COMMENT", status: "dismissed" });
    addAnnotation(d, 6, 11, { content: "PENDING-COMMENT" });

    const zip = await unzip(await exportYDocToDocx(d));
    const all = await allXmlText(zip);
    expect(all).toContain("PENDING-COMMENT");
    expect(all).not.toContain("PRIVATE-COMMENT");
    expect(all).not.toContain("ACCEPTED-COMMENT");
    expect(all).not.toContain("DISMISSED-COMMENT");
  });

  it("never emits a USER-authored private reply, even on an exported comment", async () => {
    const d = docFromHtml("<p>Hello brave world</p>");
    const id = addAnnotation(d, 6, 11, { content: "Root comment" });
    addReply(d, { annotationId: id, text: "PUBLIC-REPLY", author: "claude" });
    // A user's private reply (e.g. typed on a note) is the user's own content
    // and never leaves Tandem — author !== "import", so the carve-out skips it.
    addReply(d, {
      annotationId: id,
      text: "USER-PRIVATE-REPLY",
      author: "user",
      private: true,
    });

    const zip = await unzip(await exportYDocToDocx(d));
    const all = await allXmlText(zip);
    expect(all).toContain("PUBLIC-REPLY");
    expect(all).not.toContain("USER-PRIVATE-REPLY");
  });

  it("round-trips an imported (author:import) reply back to the file", async () => {
    // Imported Word reply threads came FROM the file and go back to it, even
    // though they're private (Claude-invisible). They flatten into the body.
    const d = docFromHtml("<p>Hello brave world</p>");
    const id = addAnnotation(d, 0, 5, {
      type: "note",
      author: "import",
      audience: "private",
      content: "ROOT-IMPORT-COMMENT",
      importSource: { author: "Alice", file: "review.docx", commentId: "3" },
    });
    addReply(d, {
      annotationId: id,
      text: "IMPORTED-REPLY-BODY",
      author: "import",
      private: true,
      importAuthor: "Bob",
    });

    const all = await allXmlText(await unzip(await exportYDocToDocx(d)));
    expect(all).toContain("ROOT-IMPORT-COMMENT");
    expect(all).toContain("IMPORTED-REPLY-BODY");
  });
});

// ---------------------------------------------------------------------------
// Reply flattening (no commentsExtended.xml in docx@9.x)
// ---------------------------------------------------------------------------

describe("exportYDocToDocx — replies and suggestion text", () => {
  it("flattens non-private replies into the comment body with attribution", async () => {
    const d = docFromHtml("<p>Hello brave world</p>");
    const id = addAnnotation(d, 6, 11, { content: "Root comment" });
    addReply(d, { annotationId: id, text: "I agree", author: "user", timestamp: 2 });
    addReply(d, { annotationId: id, text: "Done", author: "claude", timestamp: 3 });

    const zip = await unzip(await exportYDocToDocx(d));
    const commentsXml = (await readPart(zip, "word/comments.xml"))!;
    expect(commentsXml).toContain("Reply from User: I agree");
    expect(commentsXml).toContain("Reply from Claude: Done");
    // docx@9.x cannot write the threading part — replies are flattened.
    expect(zip.file("word/commentsExtended.xml")).toBeNull();
  });

  it("appends suggestedText as a labeled paragraph", async () => {
    const d = docFromHtml("<p>Hello brave world</p>");
    addAnnotation(d, 6, 11, { content: "Wordy", suggestedText: "bold" });

    const commentsXml = (await readPart(
      await unzip(await exportYDocToDocx(d)),
      "word/comments.xml",
    ))!;
    expect(commentsXml).toContain("Suggested replacement: bold");
  });
});

// ---------------------------------------------------------------------------
// Import → promote → export → re-open idempotency (open question 3)
// ---------------------------------------------------------------------------

describe("exportYDocToDocx — import/export idempotency", () => {
  it("a promoted Word comment round-trips to the same importAnnotationId", async () => {
    // 1. Open a reviewer .docx the way Tandem does.
    const fixture = await buildDocxWithComments(1);
    const html = await loadDocx(fixture);
    doc = new Y.Doc();
    withInternal(doc, () => htmlToYDoc(doc, html));
    const comments = await extractDocxComments(fixture);
    injectCommentsAsAnnotations(doc, comments, "review.docx");

    const map = doc.getMap(Y_MAP_ANNOTATIONS);
    const originalId = [...map.keys()][0];
    const note = map.get(originalId) as Annotation;
    expect(note.type).toBe("note");
    expect(note.importSource?.commentId).toBe("1");

    // 2. Promote it (mirrors client promoteToComment: keep id + importSource).
    withInternal(doc, () =>
      map.set(originalId, {
        ...note,
        type: "comment",
        author: "user",
        audience: "outbound",
        promotedFrom: "note",
        rev: (note.rev ?? 0) + 1,
      }),
    );

    // 3. Save → 4. extract from the saved file as the next open would.
    const buffer = await exportYDocToDocx(doc);
    const reExtracted = await extractDocxComments(buffer);
    expect(reExtracted).toHaveLength(1);
    const c = reExtracted[0];

    // Original w:id, author, and body survive the round-trip...
    expect(c.commentId).toBe("1");
    expect(c.authorName).toBe("Author1");
    expect(c.bodyText).toBe(note.content);

    // ...so the deterministic import id matches and inject dedups instead of
    // duplicating (the durable store then overlays the promoted record by id).
    expect(importAnnotationId(c.commentId, c.from, c.to, c.bodyText)).toBe(originalId);

    // 5. Simulate the next fresh open: inject into a re-imported doc and
    // verify the SAME key lands in the map (LWW merge converges on one record).
    const reopened = await reimport(buffer);
    injectCommentsAsAnnotations(reopened, reExtracted, "review.docx");
    const reopenedKeys = [...reopened.getMap(Y_MAP_ANNOTATIONS).keys()];
    expect(reopenedKeys).toEqual([originalId]);
    reopened.destroy();
  });

  it("an UNPROMOTED imported comment round-trips and re-imports without duplicating", async () => {
    // Bryan's directive: a plain open → (edit) → save must not drop reviewer
    // comments. Open a reviewer .docx, leave the comment an unpromoted private
    // note, save, and re-open from the saved bytes into a FRESH Y.Doc (what a
    // real reopen is — imported notes inject under `withInternal`, which the
    // durable-sync observer skips, so they are re-derived each open, not loaded).
    const fixture = await buildDocxWithComments(1);
    const html = await loadDocx(fixture);
    doc = new Y.Doc();
    withInternal(doc, () => htmlToYDoc(doc, html));
    const comments = await extractDocxComments(fixture);
    injectCommentsAsAnnotations(doc, comments, "review.docx");

    const map = doc.getMap(Y_MAP_ANNOTATIONS);
    const originalId = [...map.keys()][0];
    const note = map.get(originalId) as Annotation;
    expect(note.type).toBe("note");
    expect(note.author).toBe("import");

    // Save WITHOUT promoting → the import is written back to the file...
    const buffer = await exportYDocToDocx(doc);
    const reExtracted = await extractDocxComments(buffer);
    expect(reExtracted).toHaveLength(1);
    expect(reExtracted[0].commentId).toBe(note.importSource?.commentId);
    expect(reExtracted[0].bodyText).toBe(note.content);

    // ...and reopening re-injects exactly ONE note with the SAME id (the
    // deterministic importAnnotationId converges; no duplicate accumulates).
    const reopened = await reimport(buffer);
    injectCommentsAsAnnotations(reopened, reExtracted, "review.docx");
    expect([...reopened.getMap(Y_MAP_ANNOTATIONS).keys()]).toEqual([originalId]);
    reopened.destroy();
  });

  it("allocates fresh non-colliding w:ids for Tandem-born comments", async () => {
    const d = docFromHtml("<p>Hello brave world</p>");
    addAnnotation(d, 0, 5, {
      content: "Promoted",
      author: "user",
      importSource: { author: "Alice", file: "r.docx", commentId: "1" },
    });
    addAnnotation(d, 6, 11, { content: "Claude-born" });

    const prepared = prepareExportComments(d);
    expect(prepared).toHaveLength(2);
    const ids = prepared.map((p) => p.id);
    expect(new Set(ids).size).toBe(2);
    expect(ids).toContain(1); // reused original Word id
  });

  it("does not reuse non-canonical or hostile stored comment ids", () => {
    const d = docFromHtml("<p>Hello brave world</p>");
    addAnnotation(d, 0, 5, {
      content: "Weird id",
      importSource: { author: "A", file: "f.docx", commentId: "01" },
    });
    addAnnotation(d, 6, 11, {
      content: "Huge id",
      importSource: { author: "A", file: "f.docx", commentId: "99999999999999" },
    });

    const prepared = prepareExportComments(d);
    expect(prepared.map((p) => p.id).sort()).toEqual([1, 2]);
  });
});
