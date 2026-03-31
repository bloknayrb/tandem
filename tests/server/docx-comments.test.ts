import { describe, it, expect, beforeEach } from "vitest";
import * as Y from "yjs";
import {
  parseCommentMetadata,
  calculateCommentRanges,
  extractDocxComments,
  injectCommentsAsAnnotations,
  type DocxComment,
} from "../../src/server/file-io/docx-comments.js";
import { htmlToYDoc } from "../../src/server/file-io/docx-html.js";
import { Y_MAP_ANNOTATIONS } from "../../src/shared/constants.js";

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

  it("injects comments as annotations with correct fields", () => {
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

    const count = injectCommentsAsAnnotations(doc, comments);
    expect(count).toBe(1);

    const map = doc.getMap(Y_MAP_ANNOTATIONS);
    expect(map.size).toBe(1);

    const entries = Array.from(map.entries());
    const [key, value] = entries[0];
    const ann = value as Record<string, unknown>;

    expect(key).toMatch(/^import-1-/);
    expect(ann.author).toBe("import");
    expect(ann.type).toBe("comment");
    expect(ann.status).toBe("pending");
    expect(ann.content).toBe("[Alice] Good point");
    expect(ann.range).toEqual({ from: 0, to: 5 });
    expect(ann.timestamp).toBe(new Date("2026-01-15T10:30:00Z").getTime());
  });

  it("omits author prefix when authorName is Unknown", () => {
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

  it("uses mcp origin tag on the transaction", () => {
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
    expect(origins).toContain("mcp");
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
});
