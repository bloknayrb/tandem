import { beforeEach, describe, expect, it } from "vitest";
import * as Y from "yjs";
import { IMPORT_AUTHOR_MAX, IMPORT_REPLY_BODY_CAP } from "../../src/server/annotations/schema.js";
import {
  calculateCommentRanges,
  type DocxComment,
  extractDocxComments,
  importAnnotationId,
  importReplyId,
  injectCommentsAsAnnotations,
  parseCommentMetadata,
  parseCommentThreading,
} from "../../src/server/file-io/docx-comments.js";
import { htmlToYDoc } from "../../src/server/file-io/docx-html.js";
import { Y_MAP_ANNOTATION_REPLIES, Y_MAP_ANNOTATIONS } from "../../src/shared/constants.js";
import type { AnnotationReply } from "../../src/shared/types.js";

// ---------------------------------------------------------------------------
// parseCommentMetadata
// ---------------------------------------------------------------------------

describe("parseCommentMetadata", () => {
  it("parses comment id, author, body text, and date", () => {
    const xml = `<?xml version="1.0"?>
      <w:comments xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
        <w:comment w:id="1" w:author="Alice" w:date="2026-01-15T10:30:00Z">
          <w:p><w:r><w:t>Great point!</w:t></w:r></w:p>
        </w:comment>
      </w:comments>`;

    const map = parseCommentMetadata(xml);
    expect(map.size).toBe(1);

    const meta = map.get("1")!;
    expect(meta.authorName).toBe("Alice");
    expect(meta.bodyText).toBe("Great point!");
    expect(meta.date).toBe("2026-01-15T10:30:00Z");
  });

  it("handles missing author gracefully", () => {
    const xml = `<?xml version="1.0"?>
      <w:comments xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
        <w:comment w:id="2">
          <w:p><w:r><w:t>No author here</w:t></w:r></w:p>
        </w:comment>
      </w:comments>`;

    const map = parseCommentMetadata(xml);
    expect(map.get("2")!.authorName).toBe("Unknown");
  });

  it("handles empty comment body", () => {
    const xml = `<?xml version="1.0"?>
      <w:comments xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
        <w:comment w:id="3" w:author="Bob">
          <w:p><w:r></w:r></w:p>
        </w:comment>
      </w:comments>`;

    const map = parseCommentMetadata(xml);
    expect(map.get("3")!.bodyText).toBe("");
  });

  it("parses multiple comments", () => {
    const xml = `<?xml version="1.0"?>
      <w:comments xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
        <w:comment w:id="1" w:author="Alice"><w:p><w:r><w:t>First</w:t></w:r></w:p></w:comment>
        <w:comment w:id="2" w:author="Bob"><w:p><w:r><w:t>Second</w:t></w:r></w:p></w:comment>
      </w:comments>`;

    const map = parseCommentMetadata(xml);
    expect(map.size).toBe(2);
    expect(map.get("1")!.bodyText).toBe("First");
    expect(map.get("2")!.bodyText).toBe("Second");
  });

  it("concatenates text from multiple w:t elements", () => {
    const xml = `<?xml version="1.0"?>
      <w:comments xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
        <w:comment w:id="1" w:author="Alice">
          <w:p>
            <w:r><w:t>Hello </w:t></w:r>
            <w:r><w:t>World</w:t></w:r>
          </w:p>
        </w:comment>
      </w:comments>`;

    const map = parseCommentMetadata(xml);
    expect(map.get("1")!.bodyText).toBe("Hello World");
  });

  it("skips comment elements without w:id", () => {
    const xml = `<?xml version="1.0"?>
      <w:comments xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
        <w:comment w:author="NoId"><w:p><w:r><w:t>Skip me</w:t></w:r></w:p></w:comment>
      </w:comments>`;

    const map = parseCommentMetadata(xml);
    expect(map.size).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// calculateCommentRanges
// ---------------------------------------------------------------------------

describe("calculateCommentRanges", () => {
  it("calculates offsets for simple text with comment range", () => {
    // "Hello World" — comment on "World" (offset 6–11)
    const xml = `<?xml version="1.0"?>
      <w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
        <w:body>
          <w:p>
            <w:r><w:t>Hello </w:t></w:r>
            <w:commentRangeStart w:id="1"/>
            <w:r><w:t>World</w:t></w:r>
            <w:commentRangeEnd w:id="1"/>
          </w:p>
        </w:body>
      </w:document>`;

    const ranges = calculateCommentRanges(xml);
    expect(ranges.get("1")).toEqual({ from: 6, to: 11 });
  });

  it("handles multiple paragraphs with paragraph separator offsets", () => {
    // "First" (0–5), \n, "Second" (6–12)
    // Comment on "Second"
    const xml = `<?xml version="1.0"?>
      <w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
        <w:body>
          <w:p><w:r><w:t>First</w:t></w:r></w:p>
          <w:p>
            <w:commentRangeStart w:id="1"/>
            <w:r><w:t>Second</w:t></w:r>
            <w:commentRangeEnd w:id="1"/>
          </w:p>
        </w:body>
      </w:document>`;

    const ranges = calculateCommentRanges(xml);
    expect(ranges.get("1")).toEqual({ from: 6, to: 12 });
  });

  it("handles comment spanning multiple paragraphs", () => {
    // "AAA" (0–3), \n, "BBB" (4–7)
    // Comment starts before AAA, ends after BBB
    const xml = `<?xml version="1.0"?>
      <w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
        <w:body>
          <w:p>
            <w:commentRangeStart w:id="1"/>
            <w:r><w:t>AAA</w:t></w:r>
          </w:p>
          <w:p>
            <w:r><w:t>BBB</w:t></w:r>
            <w:commentRangeEnd w:id="1"/>
          </w:p>
        </w:body>
      </w:document>`;

    const ranges = calculateCommentRanges(xml);
    expect(ranges.get("1")).toEqual({ from: 0, to: 7 });
  });

  it("skips comments without range end marker", () => {
    const xml = `<?xml version="1.0"?>
      <w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
        <w:body>
          <w:p>
            <w:commentRangeStart w:id="1"/>
            <w:r><w:t>Orphan</w:t></w:r>
          </w:p>
        </w:body>
      </w:document>`;

    const ranges = calculateCommentRanges(xml);
    expect(ranges.has("1")).toBe(false);
  });

  it("accounts for heading prefix offsets", () => {
    // Heading1: "# " (2 chars) + "Title" (5 chars) = offset 0–7
    // \n separator
    // "Body" starts at offset 8
    const xml = `<?xml version="1.0"?>
      <w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
        <w:body>
          <w:p>
            <w:pPr><w:pStyle w:val="Heading1"/></w:pPr>
            <w:r><w:t>Title</w:t></w:r>
          </w:p>
          <w:p>
            <w:commentRangeStart w:id="1"/>
            <w:r><w:t>Body</w:t></w:r>
            <w:commentRangeEnd w:id="1"/>
          </w:p>
        </w:body>
      </w:document>`;

    const ranges = calculateCommentRanges(xml);
    // "# Title" = 7 chars, \n = 1, "Body" starts at 8
    expect(ranges.get("1")).toEqual({ from: 8, to: 12 });
  });

  it("accounts for heading level 2 prefix", () => {
    // Heading2: "## " (3 chars) + "Sub" (3 chars)
    const xml = `<?xml version="1.0"?>
      <w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
        <w:body>
          <w:p>
            <w:pPr><w:pStyle w:val="Heading2"/></w:pPr>
            <w:commentRangeStart w:id="1"/>
            <w:r><w:t>Sub</w:t></w:r>
            <w:commentRangeEnd w:id="1"/>
          </w:p>
        </w:body>
      </w:document>`;

    const ranges = calculateCommentRanges(xml);
    // "## " (3) + commentRangeStart at offset 3, "Sub" ends at 6
    expect(ranges.get("1")).toEqual({ from: 3, to: 6 });
  });

  it("handles multiple comments in same paragraph", () => {
    // "Hello beautiful World"
    // Comment 1 on "Hello" (0–5), Comment 2 on "World" (16–21)
    const xml = `<?xml version="1.0"?>
      <w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
        <w:body>
          <w:p>
            <w:commentRangeStart w:id="1"/>
            <w:r><w:t>Hello</w:t></w:r>
            <w:commentRangeEnd w:id="1"/>
            <w:r><w:t> beautiful </w:t></w:r>
            <w:commentRangeStart w:id="2"/>
            <w:r><w:t>World</w:t></w:r>
            <w:commentRangeEnd w:id="2"/>
          </w:p>
        </w:body>
      </w:document>`;

    const ranges = calculateCommentRanges(xml);
    expect(ranges.get("1")).toEqual({ from: 0, to: 5 });
    expect(ranges.get("2")).toEqual({ from: 16, to: 21 });
  });

  it("handles w:tab and w:br as single characters", () => {
    // "A\tB" — tab between A and B
    const xml = `<?xml version="1.0"?>
      <w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
        <w:body>
          <w:p>
            <w:r><w:t>A</w:t></w:r>
            <w:r><w:tab/></w:r>
            <w:commentRangeStart w:id="1"/>
            <w:r><w:t>B</w:t></w:r>
            <w:commentRangeEnd w:id="1"/>
          </w:p>
        </w:body>
      </w:document>`;

    const ranges = calculateCommentRanges(xml);
    // A(1) + tab(1) = 2, so B starts at offset 2
    expect(ranges.get("1")).toEqual({ from: 2, to: 3 });
  });
});

// ---------------------------------------------------------------------------
// extractDocxComments (integration — uses JSZip)
// ---------------------------------------------------------------------------

describe("extractDocxComments", () => {
  it("returns empty array for buffer without comments.xml", async () => {
    const JSZip = (await import("jszip")).default;
    const zip = new JSZip();
    zip.file(
      "word/document.xml",
      `<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Hello</w:t></w:r></w:p></w:body></w:document>`,
    );
    // No word/comments.xml
    const buffer = await zip.generateAsync({ type: "nodebuffer" });

    const result = await extractDocxComments(buffer);
    expect(result).toEqual([]);
  });

  it("returns empty array for buffer without document.xml", async () => {
    const JSZip = (await import("jszip")).default;
    const zip = new JSZip();
    zip.file(
      "word/comments.xml",
      `<?xml version="1.0"?><w:comments xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:comment w:id="1" w:author="A"><w:p><w:r><w:t>Hi</w:t></w:r></w:p></w:comment></w:comments>`,
    );
    // No word/document.xml
    const buffer = await zip.generateAsync({ type: "nodebuffer" });

    const result = await extractDocxComments(buffer);
    expect(result).toEqual([]);
  });

  it("extracts comments with ranges from a synthetic docx zip", async () => {
    const JSZip = (await import("jszip")).default;
    const zip = new JSZip();

    zip.file(
      "word/document.xml",
      `<?xml version="1.0"?>
      <w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
        <w:body>
          <w:p>
            <w:r><w:t>Hello </w:t></w:r>
            <w:commentRangeStart w:id="1"/>
            <w:r><w:t>World</w:t></w:r>
            <w:commentRangeEnd w:id="1"/>
          </w:p>
        </w:body>
      </w:document>`,
    );

    zip.file(
      "word/comments.xml",
      `<?xml version="1.0"?>
      <w:comments xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
        <w:comment w:id="1" w:author="Alice" w:date="2026-01-15T10:30:00Z">
          <w:p><w:r><w:t>Nice word choice</w:t></w:r></w:p>
        </w:comment>
      </w:comments>`,
    );

    const buffer = await zip.generateAsync({ type: "nodebuffer" });
    const result = await extractDocxComments(buffer);

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      commentId: "1",
      authorName: "Alice",
      bodyText: "Nice word choice",
      from: 6,
      to: 11,
      date: "2026-01-15T10:30:00Z",
    });
  });

  it("skips comments whose range markers are missing from document", async () => {
    const JSZip = (await import("jszip")).default;
    const zip = new JSZip();

    zip.file(
      "word/document.xml",
      `<?xml version="1.0"?>
      <w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
        <w:body><w:p><w:r><w:t>No markers</w:t></w:r></w:p></w:body>
      </w:document>`,
    );

    zip.file(
      "word/comments.xml",
      `<?xml version="1.0"?>
      <w:comments xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
        <w:comment w:id="99" w:author="Ghost">
          <w:p><w:r><w:t>Orphan comment</w:t></w:r></w:p>
        </w:comment>
      </w:comments>`,
    );

    const buffer = await zip.generateAsync({ type: "nodebuffer" });
    const result = await extractDocxComments(buffer);
    expect(result).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// injectCommentsAsAnnotations
// ---------------------------------------------------------------------------

describe("injectCommentsAsAnnotations", () => {
  let doc: Y.Doc;

  beforeEach(() => {
    doc = new Y.Doc();
    // Build a simple document: "Hello World" (single paragraph)
    htmlToYDoc(doc, "<p>Hello World</p>");
  });

  it("injects comments as private notes with importSource attribution (W8)", () => {
    const comments: DocxComment[] = [
      {
        commentId: "1",
        authorName: "Alice",
        bodyText: "Good point",
        from: 0,
        to: 5, // "Hello"
        date: "2026-01-15T10:30:00Z",
      },
    ];

    const count = injectCommentsAsAnnotations(doc, comments, "review.docx");
    expect(count).toBe(1);

    const map = doc.getMap(Y_MAP_ANNOTATIONS);
    expect(map.size).toBe(1);

    const entries = Array.from(map.entries());
    const [key, value] = entries[0];
    const ann = value as Record<string, unknown>;

    expect(key).toMatch(/^import-[0-9a-f]{12}$/);
    expect(ann.author).toBe("import");
    expect(ann.type).toBe("note");
    expect(ann.audience).toBe("private");
    expect(ann.status).toBe("pending");
    expect(ann.content).toBe("Good point");
    expect(ann.importSource).toEqual({ author: "Alice", file: "review.docx", commentId: "1" });
    expect(ann.range).toEqual({ from: 0, to: 5 });
    expect(ann.timestamp).toBe(new Date("2026-01-15T10:30:00Z").getTime());
  });

  it('falls back to "unknown" file when fileName is omitted', () => {
    const comments: DocxComment[] = [
      {
        commentId: "2",
        authorName: "Unknown",
        bodyText: "Just a note",
        from: 0,
        to: 5,
      },
    ];

    injectCommentsAsAnnotations(doc, comments);

    const map = doc.getMap(Y_MAP_ANNOTATIONS);
    const ann = Array.from(map.values())[0] as Record<string, unknown>;
    expect(ann.content).toBe("Just a note");
    expect(ann.importSource).toEqual({ author: "Unknown", file: "unknown", commentId: "2" });
  });

  it("returns 0 for empty comments array", () => {
    const count = injectCommentsAsAnnotations(doc, []);
    expect(count).toBe(0);

    const map = doc.getMap(Y_MAP_ANNOTATIONS);
    expect(map.size).toBe(0);
  });

  it("still injects comments with out-of-range offsets (anchoredRange clamps)", () => {
    // anchoredRange doesn't reject out-of-bounds offsets without a textSnapshot,
    // so these get injected with clamped positions. This is acceptable for imports
    // since the comment will still appear (possibly at end of document).
    const comments: DocxComment[] = [
      {
        commentId: "bad",
        authorName: "Alice",
        bodyText: "Out of bounds",
        from: 500,
        to: 600,
      },
    ];

    const count = injectCommentsAsAnnotations(doc, comments);
    expect(count).toBe(1);
  });

  it("uses internal origin tag on the transaction (ADR-031)", () => {
    const origins: unknown[] = [];
    doc.on("beforeTransaction", (tr: Y.Transaction) => {
      origins.push(tr.origin);
    });

    const comments: DocxComment[] = [
      {
        commentId: "1",
        authorName: "Test",
        bodyText: "Tagged",
        from: 0,
        to: 5,
      },
    ];

    injectCommentsAsAnnotations(doc, comments);
    // .docx comment injection happens during file open, before observers
    // attach — withInternal is the ADR-031 category. Channel skips internal;
    // durable-sync skips internal; tombstone observer skips internal.
    expect(origins).toContain("internal");
  });

  it("handles multiple comments", () => {
    // "Hello World" — two comments
    const comments: DocxComment[] = [
      { commentId: "1", authorName: "A", bodyText: "First", from: 0, to: 5 },
      { commentId: "2", authorName: "B", bodyText: "Second", from: 6, to: 11 },
    ];

    const count = injectCommentsAsAnnotations(doc, comments);
    expect(count).toBe(2);

    const map = doc.getMap(Y_MAP_ANNOTATIONS);
    expect(map.size).toBe(2);
  });

  it("re-importing the same comments is idempotent (content-hashed id + dedup)", () => {
    const comments: DocxComment[] = [
      { commentId: "1", authorName: "Alice", bodyText: "Good", from: 0, to: 5 },
      { commentId: "2", authorName: "Bob", bodyText: "Nice", from: 6, to: 11 },
    ];

    const first = injectCommentsAsAnnotations(doc, comments);
    expect(first).toBe(2);
    const idsAfterFirst = Array.from(doc.getMap(Y_MAP_ANNOTATIONS).keys()).sort();

    const second = injectCommentsAsAnnotations(doc, comments);
    expect(second).toBe(0); // dedup guard skips existing ids

    const idsAfterSecond = Array.from(doc.getMap(Y_MAP_ANNOTATIONS).keys()).sort();
    expect(doc.getMap(Y_MAP_ANNOTATIONS).size).toBe(2);
    expect(idsAfterSecond).toEqual(idsAfterFirst);
  });

  it('migrates legacy `type: "comment"` import records to the W8 private-note shape', () => {
    // Simulate a pre-W8 record: an import-author comment with `[author] ` content prefix
    // and no importSource. Re-importing the same .docx should rewrite it in place to
    // `type: "note"`, `audience: "private"` with the bodyText content + importSource.
    const map = doc.getMap(Y_MAP_ANNOTATIONS);
    const comment: DocxComment = {
      commentId: "legacy",
      authorName: "Carol",
      bodyText: "Original body",
      from: 0,
      to: 5,
    };
    // Stand in for a real importAnnotationId by writing directly under the id
    // we'll compute on re-import — the function is deterministic, so we mirror it:
    const reimportComments = [comment];
    injectCommentsAsAnnotations(doc, reimportComments, "old.docx");
    const realId = Array.from(map.keys())[0];
    const real = map.get(realId) as Record<string, unknown>;
    expect(real.type).toBe("note");

    // Now stomp the in-doc record back to the legacy shape and re-import:
    map.set(realId, {
      ...(real as Record<string, unknown>),
      type: "comment",
      content: "[Carol] Original body",
      audience: undefined,
      importSource: undefined,
    } as never);

    const migrated = injectCommentsAsAnnotations(doc, reimportComments, "new.docx");
    expect(migrated).toBe(0); // dedup hits — but migration runs
    const after = map.get(realId) as Record<string, unknown>;
    expect(after.type).toBe("note");
    expect(after.audience).toBe("private");
    expect(after.content).toBe("Original body");
    expect(after.importSource).toEqual({ author: "Carol", file: "new.docx", commentId: "legacy" });
  });
});

// ---------------------------------------------------------------------------
// importAnnotationId — content-hashed, deterministic, collision-resistant
// ---------------------------------------------------------------------------

describe("importAnnotationId", () => {
  it("returns the same id for identical inputs (determinism)", () => {
    const a = importAnnotationId("1", 0, 5, "body");
    const b = importAnnotationId("1", 0, 5, "body");
    expect(a).toBe(b);
    expect(a).toMatch(/^import-[0-9a-f]{12}$/);
  });

  it("returns different ids for different commentIds", () => {
    const a = importAnnotationId("1", 0, 5, "body");
    const b = importAnnotationId("2", 0, 5, "body");
    expect(a).not.toBe(b);
  });

  it("returns different ids for different ranges", () => {
    const a = importAnnotationId("1", 0, 5, "body");
    const b = importAnnotationId("1", 1, 5, "body");
    const c = importAnnotationId("1", 0, 6, "body");
    expect(a).not.toBe(b);
    expect(a).not.toBe(c);
    expect(b).not.toBe(c);
  });

  it("returns different ids for different body text", () => {
    const a = importAnnotationId("1", 0, 5, "hello");
    const b = importAnnotationId("1", 0, 5, "world");
    expect(a).not.toBe(b);
  });

  it("delimiter avoids trivial collisions across field boundaries", () => {
    // "1" + "0" + "5" + "body" naively concatenated matches "10" + "" + "5" + "body"
    // The NUL delimiter prevents this class of collision.
    const a = importAnnotationId("1", 0, 5, "body");
    const b = importAnnotationId("10", 5, 0, "body");
    expect(a).not.toBe(b);
  });
});

// ---------------------------------------------------------------------------
// Word threaded comments (#1000)
// ---------------------------------------------------------------------------

const W_NS = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
const W14_NS = "http://schemas.microsoft.com/office/word/2010/wordml";
const W15_NS = "http://schemas.microsoft.com/office/word/2012/wordml";

describe("parseCommentMetadata — threading paraId", () => {
  it("extracts the last paragraph's w14:paraId (lowercased)", () => {
    const xml = `<?xml version="1.0"?>
      <w:comments xmlns:w="${W_NS}" xmlns:w14="${W14_NS}">
        <w:comment w:id="7" w:author="Alice">
          <w:p w14:paraId="0AAA0001"><w:r><w:t>first para</w:t></w:r></w:p>
          <w:p w14:paraId="0BBB0002"><w:r><w:t>last para</w:t></w:r></w:p>
        </w:comment>
      </w:comments>`;
    const meta = parseCommentMetadata(xml).get("7")!;
    expect(meta.bodyText).toBe("first paralast para");
    // The LAST paragraph's paraId is the thread join key, lowercased.
    expect(meta.lastParaId).toBe("0bbb0002");
  });

  it("leaves lastParaId undefined when no paraId present", () => {
    const xml = `<?xml version="1.0"?>
      <w:comments xmlns:w="${W_NS}">
        <w:comment w:id="8" w:author="Bob"><w:p><w:r><w:t>x</w:t></w:r></w:p></w:comment>
      </w:comments>`;
    expect(parseCommentMetadata(xml).get("8")!.lastParaId).toBeUndefined();
  });
});

describe("parseCommentThreading", () => {
  it("maps child paraId → parent paraId (lowercased), replies only", () => {
    const xml = `<?xml version="1.0"?>
      <w15:commentsEx xmlns:w15="${W15_NS}">
        <w15:commentEx w15:paraId="0AAA0001" w15:done="0"/>
        <w15:commentEx w15:paraId="0AAA0002" w15:paraIdParent="0AAA0001" w15:done="0"/>
      </w15:commentsEx>`;
    const map = parseCommentThreading(xml);
    // Root (no parent) is omitted; only the reply link is recorded.
    expect(map.size).toBe(1);
    expect(map.get("0aaa0002")).toBe("0aaa0001");
  });
});

/** Build a docx zip buffer with the given parts. */
async function buildZip(parts: Record<string, string>): Promise<Buffer> {
  const JSZip = (await import("jszip")).default;
  const zip = new JSZip();
  for (const [path, content] of Object.entries(parts)) zip.file(path, content);
  return zip.generateAsync({ type: "nodebuffer" });
}

const ROOT_DOC_XML = `<?xml version="1.0"?>
  <w:document xmlns:w="${W_NS}"><w:body><w:p>
    <w:r><w:t>Hello </w:t></w:r>
    <w:commentRangeStart w:id="1"/><w:r><w:t>World</w:t></w:r><w:commentRangeEnd w:id="1"/>
  </w:p></w:body></w:document>`;

describe("extractDocxComments — Word threads (#1000)", () => {
  it("folds replies into the root comment, ordered by date", async () => {
    // Comment 1 = root; 2 and 3 reply to it. Reply 3 is dated BEFORE reply 2 to
    // prove chronological ordering (not document order). Replies have NO range
    // markers in document.xml — they must still survive (inherit root anchor).
    const buffer = await buildZip({
      "word/document.xml": ROOT_DOC_XML,
      "word/comments.xml": `<?xml version="1.0"?>
        <w:comments xmlns:w="${W_NS}" xmlns:w14="${W14_NS}">
          <w:comment w:id="1" w:author="Alice" w:date="2026-01-01T00:00:00Z"><w:p w14:paraId="0AAA0001"><w:r><w:t>Root</w:t></w:r></w:p></w:comment>
          <w:comment w:id="2" w:author="Bob" w:date="2026-01-03T00:00:00Z"><w:p w14:paraId="0AAA0002"><w:r><w:t>Later reply</w:t></w:r></w:p></w:comment>
          <w:comment w:id="3" w:author="Carol" w:date="2026-01-02T00:00:00Z"><w:p w14:paraId="0AAA0003"><w:r><w:t>Earlier reply</w:t></w:r></w:p></w:comment>
        </w:comments>`,
      "word/commentsExtended.xml": `<?xml version="1.0"?>
        <w15:commentsEx xmlns:w15="${W15_NS}">
          <w15:commentEx w15:paraId="0AAA0001" w15:done="0"/>
          <w15:commentEx w15:paraId="0AAA0002" w15:paraIdParent="0AAA0001" w15:done="0"/>
          <w15:commentEx w15:paraId="0AAA0003" w15:paraIdParent="0AAA0001" w15:done="0"/>
        </w15:commentsEx>`,
    });

    const result = await extractDocxComments(buffer);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ commentId: "1", bodyText: "Root", from: 6, to: 11 });
    expect(result[0].replies).toHaveLength(2);
    expect(result[0].replies!.map((r) => r.bodyText)).toEqual(["Earlier reply", "Later reply"]);
    expect(result[0].replies!.map((r) => r.authorName)).toEqual(["Carol", "Bob"]);
  });

  it("treats a reply with an unresolved parent paraId as a root", async () => {
    const buffer = await buildZip({
      "word/document.xml": `<?xml version="1.0"?>
        <w:document xmlns:w="${W_NS}"><w:body><w:p>
          <w:commentRangeStart w:id="1"/><w:r><w:t>Hello</w:t></w:r><w:commentRangeEnd w:id="1"/>
          <w:r><w:t> </w:t></w:r>
          <w:commentRangeStart w:id="2"/><w:r><w:t>World</w:t></w:r><w:commentRangeEnd w:id="2"/>
        </w:p></w:body></w:document>`,
      "word/comments.xml": `<?xml version="1.0"?>
        <w:comments xmlns:w="${W_NS}" xmlns:w14="${W14_NS}">
          <w:comment w:id="1" w:author="A"><w:p w14:paraId="0AAA0001"><w:r><w:t>One</w:t></w:r></w:p></w:comment>
          <w:comment w:id="2" w:author="B"><w:p w14:paraId="0AAA0002"><w:r><w:t>Two</w:t></w:r></w:p></w:comment>
        </w:comments>`,
      "word/commentsExtended.xml": `<?xml version="1.0"?>
        <w15:commentsEx xmlns:w15="${W15_NS}">
          <w15:commentEx w15:paraId="0AAA0002" w15:paraIdParent="DEADBEEF" w15:done="0"/>
        </w15:commentsEx>`,
    });

    const result = await extractDocxComments(buffer);
    // Both are roots (comment 2's parent paraId resolves to nothing).
    expect(result.map((c) => c.commentId).sort()).toEqual(["1", "2"]);
    expect(result.every((c) => c.replies === undefined)).toBe(true);
  });

  it("terminates on a parent cycle without hanging (both become roots)", async () => {
    const buffer = await buildZip({
      "word/document.xml": `<?xml version="1.0"?>
        <w:document xmlns:w="${W_NS}"><w:body><w:p>
          <w:commentRangeStart w:id="1"/><w:r><w:t>Hello</w:t></w:r><w:commentRangeEnd w:id="1"/>
          <w:r><w:t> </w:t></w:r>
          <w:commentRangeStart w:id="2"/><w:r><w:t>World</w:t></w:r><w:commentRangeEnd w:id="2"/>
        </w:p></w:body></w:document>`,
      "word/comments.xml": `<?xml version="1.0"?>
        <w:comments xmlns:w="${W_NS}" xmlns:w14="${W14_NS}">
          <w:comment w:id="1" w:author="A"><w:p w14:paraId="0AAA0001"><w:r><w:t>One</w:t></w:r></w:p></w:comment>
          <w:comment w:id="2" w:author="B"><w:p w14:paraId="0AAA0002"><w:r><w:t>Two</w:t></w:r></w:p></w:comment>
        </w:comments>`,
      // Mutual parent links: 1↔2.
      "word/commentsExtended.xml": `<?xml version="1.0"?>
        <w15:commentsEx xmlns:w15="${W15_NS}">
          <w15:commentEx w15:paraId="0AAA0001" w15:paraIdParent="0AAA0002" w15:done="0"/>
          <w15:commentEx w15:paraId="0AAA0002" w15:paraIdParent="0AAA0001" w15:done="0"/>
        </w15:commentsEx>`,
    });

    const result = await extractDocxComments(buffer);
    expect(result.map((c) => c.commentId).sort()).toEqual(["1", "2"]);
  });

  it("no commentsExtended.xml ⇒ every comment is a flat root (regression)", async () => {
    const buffer = await buildZip({
      "word/document.xml": ROOT_DOC_XML,
      "word/comments.xml": `<?xml version="1.0"?>
        <w:comments xmlns:w="${W_NS}" xmlns:w14="${W14_NS}">
          <w:comment w:id="1" w:author="Alice"><w:p w14:paraId="0AAA0001"><w:r><w:t>Root</w:t></w:r></w:p></w:comment>
        </w:comments>`,
    });
    const result = await extractDocxComments(buffer);
    expect(result).toHaveLength(1);
    expect(result[0].replies).toBeUndefined();
  });
});

describe("injectCommentsAsAnnotations — threaded replies (#1000)", () => {
  let doc: Y.Doc;
  beforeEach(() => {
    doc = new Y.Doc();
    htmlToYDoc(doc, "<p>Hello World</p>");
  });

  const rootWithReplies: DocxComment = {
    commentId: "1",
    authorName: "Alice",
    bodyText: "Root note",
    from: 0,
    to: 5,
    date: "2026-01-01T00:00:00Z",
    replies: [
      { commentId: "2", authorName: "Bob", bodyText: "Bob's reply", date: "2026-01-02T00:00:00Z" },
      { commentId: "3", authorName: "Carol", bodyText: "Carol's reply" },
    ],
  };

  it("injects replies as private import replies attached to the root note", () => {
    injectCommentsAsAnnotations(doc, [rootWithReplies], "review.docx");

    const annMap = doc.getMap(Y_MAP_ANNOTATIONS);
    expect(annMap.size).toBe(1);
    const noteId = Array.from(annMap.keys())[0];

    const repliesMap = doc.getMap(Y_MAP_ANNOTATION_REPLIES);
    expect(repliesMap.size).toBe(2);
    const replies = Array.from(repliesMap.values()) as AnnotationReply[];
    for (const r of replies) {
      expect(r.annotationId).toBe(noteId);
      expect(r.author).toBe("import");
      expect(r.private).toBe(true);
      expect(r.id).toMatch(/^import-reply-[0-9a-f]{12}$/);
    }
    const bob = replies.find((r) => r.text === "Bob's reply")!;
    expect(bob.importAuthor).toBe("Bob");
    expect(bob.timestamp).toBe(new Date("2026-01-02T00:00:00Z").getTime());
  });

  it("is idempotent across re-imports (no duplicate replies)", () => {
    injectCommentsAsAnnotations(doc, [rootWithReplies], "review.docx");
    injectCommentsAsAnnotations(doc, [rootWithReplies], "review.docx");
    expect(doc.getMap(Y_MAP_ANNOTATION_REPLIES).size).toBe(2);
    expect(doc.getMap(Y_MAP_ANNOTATIONS).size).toBe(1);
  });

  it("recreates replies with identical ids after the parent note is deleted", () => {
    injectCommentsAsAnnotations(doc, [rootWithReplies], "review.docx");
    const repliesMap = doc.getMap(Y_MAP_ANNOTATION_REPLIES);
    const idsBefore = Array.from(repliesMap.keys()).sort();

    // Simulate a cascade delete that orphans/removes the replies.
    doc.transact(() => repliesMap.clear());
    expect(repliesMap.size).toBe(0);

    injectCommentsAsAnnotations(doc, [rootWithReplies], "review.docx");
    expect(Array.from(repliesMap.keys()).sort()).toEqual(idsBefore);
  });

  it("bounds oversized imported reply bodies and author names", () => {
    const huge: DocxComment = {
      commentId: "1",
      authorName: "x".repeat(500),
      bodyText: "root",
      from: 0,
      to: 5,
      replies: [{ commentId: "2", authorName: "y".repeat(500), bodyText: "z".repeat(20_000) }],
    };
    injectCommentsAsAnnotations(doc, [huge]);
    const reply = Array.from(doc.getMap(Y_MAP_ANNOTATION_REPLIES).values())[0] as AnnotationReply;
    expect(reply.text.length).toBe(IMPORT_REPLY_BODY_CAP);
    expect(reply.importAuthor!.length).toBe(IMPORT_AUTHOR_MAX);
  });

  it("deterministic importReplyId differs across root/reply/body", () => {
    expect(importReplyId("1", "2", "body")).toBe(importReplyId("1", "2", "body"));
    expect(importReplyId("1", "2", "body")).not.toBe(importReplyId("1", "3", "body"));
    expect(importReplyId("1", "2", "a")).not.toBe(importReplyId("1", "2", "b"));
  });
});
