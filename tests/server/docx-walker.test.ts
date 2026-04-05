import { describe, it, expect } from "vitest";
import {
  walkDocumentBody,
  detectHeadingLevel,
  findAllByName,
  type TextHit,
  type CommentStartHit,
} from "../../src/server/file-io/docx-walker.js";
import { parseDocument } from "htmlparser2";

// ---------------------------------------------------------------------------
// Helper: wrap body content in a minimal document.xml envelope
// ---------------------------------------------------------------------------

function wrapBody(bodyContent: string): string {
  return `<?xml version="1.0"?>
    <w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"
                xmlns:w14="http://schemas.microsoft.com/office/word/2010/wordml">
      <w:body>${bodyContent}</w:body>
    </w:document>`;
}

/** Parse a raw XML fragment and return the first element with the given name. */
function parseElement(xml: string, name: string) {
  const doc = parseDocument(xml, { xmlMode: true });
  return findAllByName(name, doc.children)[0];
}

// ---------------------------------------------------------------------------
// walkDocumentBody — offset counting
// ---------------------------------------------------------------------------

describe("walkDocumentBody", () => {
  it("counts simple paragraph text", () => {
    const xml = wrapBody(`
      <w:p><w:r><w:t>Hello World</w:t></w:r></w:p>
    `);
    const result = walkDocumentBody(xml);
    expect(result.totalLength).toBe(11);
    expect(result.flatText).toBe("Hello World");
  });

  it("adds paragraph separator between paragraphs", () => {
    const xml = wrapBody(`
      <w:p><w:r><w:t>First</w:t></w:r></w:p>
      <w:p><w:r><w:t>Second</w:t></w:r></w:p>
    `);
    const result = walkDocumentBody(xml);
    // "First" (5) + \n (1) + "Second" (6) = 12
    expect(result.totalLength).toBe(12);
    expect(result.flatText).toBe("First\nSecond");
  });

  it("does not add separator before first paragraph", () => {
    const xml = wrapBody(`
      <w:p><w:r><w:t>Only</w:t></w:r></w:p>
    `);
    const result = walkDocumentBody(xml);
    expect(result.totalLength).toBe(4);
    expect(result.flatText).toBe("Only");
  });

  it("adds heading prefix to offset", () => {
    const xml = wrapBody(`
      <w:p>
        <w:pPr><w:pStyle w:val="Heading1"/></w:pPr>
        <w:r><w:t>Title</w:t></w:r>
      </w:p>
    `);
    const result = walkDocumentBody(xml);
    // "# " (2) + "Title" (5) = 7
    expect(result.totalLength).toBe(7);
    expect(result.flatText).toBe("# Title");
  });

  it("adds heading level 3 prefix correctly", () => {
    const xml = wrapBody(`
      <w:p>
        <w:pPr><w:pStyle w:val="Heading3"/></w:pPr>
        <w:r><w:t>Sub</w:t></w:r>
      </w:p>
    `);
    const result = walkDocumentBody(xml);
    // "### " (4) + "Sub" (3) = 7
    expect(result.totalLength).toBe(7);
    expect(result.flatText).toBe("### Sub");
  });

  it("skips <w:del> subtrees", () => {
    const xml = wrapBody(`
      <w:p>
        <w:r><w:t>Keep</w:t></w:r>
        <w:del>
          <w:r><w:t>Delete</w:t></w:r>
        </w:del>
        <w:r><w:t>This</w:t></w:r>
      </w:p>
    `);
    const result = walkDocumentBody(xml);
    expect(result.totalLength).toBe(8); // "Keep" + "This"
    expect(result.flatText).toBe("KeepThis");
  });

  it("traverses <w:ins> subtrees normally", () => {
    const xml = wrapBody(`
      <w:p>
        <w:r><w:t>Before</w:t></w:r>
        <w:ins>
          <w:r><w:t>Inserted</w:t></w:r>
        </w:ins>
        <w:r><w:t>After</w:t></w:r>
      </w:p>
    `);
    const result = walkDocumentBody(xml);
    expect(result.totalLength).toBe(19); // "Before" + "Inserted" + "After"
    expect(result.flatText).toBe("BeforeInsertedAfter");
  });

  it("counts <w:tab> as 1 character", () => {
    const xml = wrapBody(`
      <w:p>
        <w:r><w:t>A</w:t></w:r>
        <w:r><w:tab/></w:r>
        <w:r><w:t>B</w:t></w:r>
      </w:p>
    `);
    const result = walkDocumentBody(xml);
    expect(result.totalLength).toBe(3); // A + tab + B
  });

  it("counts <w:br> as 1 character", () => {
    const xml = wrapBody(`
      <w:p>
        <w:r><w:t>A</w:t></w:r>
        <w:r><w:br/></w:r>
        <w:r><w:t>B</w:t></w:r>
      </w:p>
    `);
    const result = walkDocumentBody(xml);
    expect(result.totalLength).toBe(3);
  });

  it("counts <w:noBreakHyphen> as 1 character", () => {
    const xml = wrapBody(`
      <w:p>
        <w:r><w:t>A</w:t></w:r>
        <w:r><w:noBreakHyphen/></w:r>
        <w:r><w:t>B</w:t></w:r>
      </w:p>
    `);
    const result = walkDocumentBody(xml);
    expect(result.totalLength).toBe(3);
  });

  it("counts <w:softHyphen> as 1 character", () => {
    const xml = wrapBody(`
      <w:p>
        <w:r><w:t>A</w:t></w:r>
        <w:r><w:softHyphen/></w:r>
        <w:r><w:t>B</w:t></w:r>
      </w:p>
    `);
    const result = walkDocumentBody(xml);
    expect(result.totalLength).toBe(3);
  });

  it("counts <w:sym> as 1 character", () => {
    const xml = wrapBody(`
      <w:p>
        <w:r><w:t>A</w:t></w:r>
        <w:r><w:sym w:font="Wingdings" w:char="F0FC"/></w:r>
        <w:r><w:t>B</w:t></w:r>
      </w:p>
    `);
    const result = walkDocumentBody(xml);
    expect(result.totalLength).toBe(3);
  });

  it("skips <w:instrText>", () => {
    const xml = wrapBody(`
      <w:p>
        <w:r><w:t>Before</w:t></w:r>
        <w:r><w:instrText>PAGE</w:instrText></w:r>
        <w:r><w:t>After</w:t></w:r>
      </w:p>
    `);
    const result = walkDocumentBody(xml);
    expect(result.totalLength).toBe(11); // "Before" + "After"
    expect(result.flatText).toBe("BeforeAfter");
  });

  it("traverses <w:hyperlink> descendants", () => {
    const xml = wrapBody(`
      <w:p>
        <w:hyperlink>
          <w:r><w:t>Click here</w:t></w:r>
        </w:hyperlink>
      </w:p>
    `);
    const result = walkDocumentBody(xml);
    expect(result.totalLength).toBe(10);
    expect(result.flatText).toBe("Click here");
  });

  it("returns empty result for missing <w:body>", () => {
    const xml = `<?xml version="1.0"?>
      <w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
      </w:document>`;
    const result = walkDocumentBody(xml);
    expect(result.totalLength).toBe(0);
    expect(result.flatText).toBe("");
  });

  it("returns empty result for empty <w:body>", () => {
    const xml = wrapBody("");
    const result = walkDocumentBody(xml);
    expect(result.totalLength).toBe(0);
    expect(result.flatText).toBe("");
  });
});

// ---------------------------------------------------------------------------
// walkDocumentBody — onText callback
// ---------------------------------------------------------------------------

describe("walkDocumentBody onText callback", () => {
  it("fires with correct DOM references and offsets", () => {
    const xml = wrapBody(`
      <w:p>
        <w:r><w:t>Hello</w:t></w:r>
        <w:r><w:t> World</w:t></w:r>
      </w:p>
    `);

    const hits: TextHit[] = [];
    walkDocumentBody(xml, { onText: (hit) => hits.push(hit) });

    expect(hits).toHaveLength(2);

    expect(hits[0].text).toBe("Hello");
    expect(hits[0].offsetStart).toBe(0);
    expect(hits[0].run.name).toBe("w:r");
    expect(hits[0].textNode.name).toBe("w:t");
    expect(hits[0].paragraph.name).toBe("w:p");

    expect(hits[1].text).toBe(" World");
    expect(hits[1].offsetStart).toBe(5);
  });

  it("includes heading prefix in offsetStart", () => {
    const xml = wrapBody(`
      <w:p>
        <w:pPr><w:pStyle w:val="Heading2"/></w:pPr>
        <w:r><w:t>Title</w:t></w:r>
      </w:p>
    `);

    const hits: TextHit[] = [];
    walkDocumentBody(xml, { onText: (hit) => hits.push(hit) });

    expect(hits).toHaveLength(1);
    // "## " (3) then "Title" starts at 3
    expect(hits[0].offsetStart).toBe(3);
    expect(hits[0].text).toBe("Title");
  });

  it("provides paragraphId from w14:paraId attribute", () => {
    const xml = wrapBody(`
      <w:p w14:paraId="ABC123">
        <w:r><w:t>Hello</w:t></w:r>
      </w:p>
    `);

    const hits: TextHit[] = [];
    walkDocumentBody(xml, { onText: (hit) => hits.push(hit) });

    expect(hits[0].paragraphId).toBe("ABC123");
  });

  it("paragraphId is undefined when attribute is missing", () => {
    const xml = wrapBody(`
      <w:p>
        <w:r><w:t>Hello</w:t></w:r>
      </w:p>
    `);

    const hits: TextHit[] = [];
    walkDocumentBody(xml, { onText: (hit) => hits.push(hit) });

    expect(hits[0].paragraphId).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// walkDocumentBody — comment callbacks
// ---------------------------------------------------------------------------

describe("walkDocumentBody comment callbacks", () => {
  it("fires onCommentStart and onCommentEnd with correct offsets", () => {
    const xml = wrapBody(`
      <w:p>
        <w:r><w:t>Hello </w:t></w:r>
        <w:commentRangeStart w:id="1"/>
        <w:r><w:t>World</w:t></w:r>
        <w:commentRangeEnd w:id="1"/>
      </w:p>
    `);

    const starts: CommentStartHit[] = [];
    const ends: { commentId: string; offset: number }[] = [];

    walkDocumentBody(xml, {
      onCommentStart: (hit) => starts.push(hit),
      onCommentEnd: (id, offset) => ends.push({ commentId: id, offset }),
    });

    expect(starts).toHaveLength(1);
    expect(starts[0].commentId).toBe("1");
    expect(starts[0].offset).toBe(6); // after "Hello "

    expect(ends).toHaveLength(1);
    expect(ends[0].commentId).toBe("1");
    expect(ends[0].offset).toBe(11); // after "World"
  });

  it("provides paragraphId on comment start", () => {
    const xml = wrapBody(`
      <w:p w14:paraId="PARA1">
        <w:commentRangeStart w:id="1"/>
        <w:r><w:t>Text</w:t></w:r>
        <w:commentRangeEnd w:id="1"/>
      </w:p>
    `);

    const starts: CommentStartHit[] = [];
    walkDocumentBody(xml, { onCommentStart: (hit) => starts.push(hit) });

    expect(starts[0].paragraphId).toBe("PARA1");
  });

  it("handles multiple comments in same paragraph", () => {
    const xml = wrapBody(`
      <w:p>
        <w:commentRangeStart w:id="1"/>
        <w:r><w:t>Hello</w:t></w:r>
        <w:commentRangeEnd w:id="1"/>
        <w:r><w:t> </w:t></w:r>
        <w:commentRangeStart w:id="2"/>
        <w:r><w:t>World</w:t></w:r>
        <w:commentRangeEnd w:id="2"/>
      </w:p>
    `);

    const starts: CommentStartHit[] = [];
    const ends: { commentId: string; offset: number }[] = [];

    walkDocumentBody(xml, {
      onCommentStart: (hit) => starts.push(hit),
      onCommentEnd: (id, offset) => ends.push({ commentId: id, offset }),
    });

    expect(starts).toHaveLength(2);
    expect(starts[0]).toMatchObject({ commentId: "1", offset: 0 });
    expect(starts[1]).toMatchObject({ commentId: "2", offset: 6 });

    expect(ends).toHaveLength(2);
    expect(ends[0]).toMatchObject({ commentId: "1", offset: 5 });
    expect(ends[1]).toMatchObject({ commentId: "2", offset: 11 });
  });

  it("handles comment spanning multiple paragraphs", () => {
    const xml = wrapBody(`
      <w:p>
        <w:commentRangeStart w:id="1"/>
        <w:r><w:t>AAA</w:t></w:r>
      </w:p>
      <w:p>
        <w:r><w:t>BBB</w:t></w:r>
        <w:commentRangeEnd w:id="1"/>
      </w:p>
    `);

    const starts: CommentStartHit[] = [];
    const ends: { commentId: string; offset: number }[] = [];

    walkDocumentBody(xml, {
      onCommentStart: (hit) => starts.push(hit),
      onCommentEnd: (id, offset) => ends.push({ commentId: id, offset }),
    });

    expect(starts[0].offset).toBe(0);
    expect(ends[0].offset).toBe(7); // "AAA" (3) + \n (1) + "BBB" (3)
  });
});

// ---------------------------------------------------------------------------
// detectHeadingLevel
// ---------------------------------------------------------------------------

describe("detectHeadingLevel", () => {
  it("detects Heading1 through Heading6", () => {
    for (let level = 1; level <= 6; level++) {
      const el = parseElement(
        `<w:p xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
          <w:pPr><w:pStyle w:val="Heading${level}"/></w:pPr>
        </w:p>`,
        "w:p",
      );
      expect(detectHeadingLevel(el)).toBe(level);
    }
  });

  it("is case-insensitive", () => {
    const el = parseElement(
      `<w:p xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
        <w:pPr><w:pStyle w:val="heading2"/></w:pPr>
      </w:p>`,
      "w:p",
    );
    expect(detectHeadingLevel(el)).toBe(2);
  });

  it("returns 0 for non-heading styles", () => {
    const el = parseElement(
      `<w:p xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
        <w:pPr><w:pStyle w:val="Normal"/></w:pPr>
      </w:p>`,
      "w:p",
    );
    expect(detectHeadingLevel(el)).toBe(0);
  });

  it("returns 0 for paragraph with no style", () => {
    const el = parseElement(
      `<w:p xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
        <w:r><w:t>Plain</w:t></w:r>
      </w:p>`,
      "w:p",
    );
    expect(detectHeadingLevel(el)).toBe(0);
  });

  it("returns 0 for paragraph with no pPr", () => {
    const el = parseElement(
      `<w:p xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"></w:p>`,
      "w:p",
    );
    expect(detectHeadingLevel(el)).toBe(0);
  });
});
