/**
 * Single-concern .docx corpus for the round-trip fidelity harness (Phase 0d).
 *
 * Every fixture materializes REAL .docx bytes so the harness exercises the
 * mammoth import ceiling (no HTML shortcut). Word-native features use the
 * `docx` package; the style-divergence, comment, and tracked-change cases use
 * hand-authored raw OOXML (JSZip) for precise control — including a FIXED
 * `w:date` on comments/revisions so import is timestamp-deterministic.
 *
 * Scope is Word-PRODUCIBLE features only. Markdown/HTML-origin constructs
 * (code blocks, <hr>, remote images, link tooltips) don't arise from a real
 * .docx import, so testing them here would be testing fiction.
 */

import {
  Document,
  EndnoteReferenceRun,
  ExternalHyperlink,
  Footer,
  FootnoteReferenceRun,
  Header,
  HeadingLevel,
  ImageRun,
  Packer,
  Paragraph,
  Table,
  TableCell,
  TableRow,
  TextRun,
  WidthType,
} from "docx";
import JSZip from "jszip";

async function pack(doc: Document): Promise<Buffer> {
  return (await Packer.toBuffer(doc)) as Buffer;
}

function singleSection(children: Paragraph[] | Table[]): Document {
  return new Document({ sections: [{ children: children as (Paragraph | Table)[] }] });
}

// 1x1 transparent PNG (smallest valid raster) for the embedded-image fixture.
const PNG_1x1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
  "base64",
);

// ---------------------------------------------------------------------------
// docx-package fixtures (Word-native features)
// ---------------------------------------------------------------------------

export const buildHeadings = (): Promise<Buffer> =>
  pack(
    singleSection([
      new Paragraph({ text: "Title One", heading: HeadingLevel.HEADING_1 }),
      new Paragraph({ text: "Section Two", heading: HeadingLevel.HEADING_2 }),
      new Paragraph({ text: "Subsection Three", heading: HeadingLevel.HEADING_3 }),
      new Paragraph("Body paragraph."),
    ]),
  );

export const buildMarks = (): Promise<Buffer> =>
  pack(
    singleSection([
      new Paragraph({
        children: [
          new TextRun({ text: "bold", bold: true }),
          new TextRun({ text: " italic", italics: true }),
          new TextRun({ text: " strike", strike: true }),
          new TextRun({ text: " under", underline: {} }),
          new TextRun({ text: " sup", superScript: true }),
          new TextRun({ text: " sub", subScript: true }),
        ],
      }),
    ]),
  );

export const buildLink = (): Promise<Buffer> =>
  pack(
    singleSection([
      new Paragraph({
        children: [
          new TextRun("See "),
          new ExternalHyperlink({
            children: [new TextRun({ text: "the site", style: "Hyperlink" })],
            link: "https://example.com/page",
          }),
          new TextRun("."),
        ],
      }),
    ]),
  );

/** A hyperlink whose run carries a DIRECT underline (`underline: {}`), not just
 * the inherited Hyperlink character style. mammoth's `u` matcher fires on direct
 * `<w:u>` only, so this run gets BOTH the link and underline marks — a faithful
 * round-trip (the author did direct-underline it), not double-decoration. Pins
 * that link+underline co-occurrence survives import→export without corruption. */
export const buildUnderlinedLink = (): Promise<Buffer> =>
  pack(
    singleSection([
      new Paragraph({
        children: [
          new TextRun("See "),
          new ExternalHyperlink({
            children: [new TextRun({ text: "the site", underline: {} })],
            link: "https://example.com/page",
          }),
          new TextRun("."),
        ],
      }),
    ]),
  );

export const buildBulletList = (): Promise<Buffer> =>
  pack(
    singleSection([
      new Paragraph({ text: "Alpha", bullet: { level: 0 } }),
      new Paragraph({ text: "Beta", bullet: { level: 0 } }),
    ]),
  );

export const buildNestedList = (): Promise<Buffer> =>
  pack(
    singleSection([
      new Paragraph({ text: "Top", bullet: { level: 0 } }),
      new Paragraph({ text: "Child", bullet: { level: 1 } }),
      new Paragraph({ text: "Top two", bullet: { level: 0 } }),
    ]),
  );

export const buildOrderedList = (): Promise<Buffer> =>
  pack(
    new Document({
      numbering: {
        config: [
          {
            reference: "ord",
            levels: [{ level: 0, format: "decimal", text: "%1.", alignment: "left" }],
          },
        ],
      },
      sections: [
        {
          children: [
            new Paragraph({ text: "First", numbering: { reference: "ord", level: 0 } }),
            new Paragraph({ text: "Second", numbering: { reference: "ord", level: 0 } }),
          ],
        },
      ],
    }),
  );

const cell = (text: string, opts?: { columnSpan?: number; rowSpan?: number }): TableCell =>
  new TableCell({ children: [new Paragraph(text)], ...opts });

export const buildSimpleTable = (): Promise<Buffer> =>
  pack(
    singleSection([
      new Table({
        width: { size: 100, type: WidthType.PERCENTAGE },
        rows: [
          new TableRow({ children: [cell("R1C1"), cell("R1C2")] }),
          new TableRow({ children: [cell("R2C1"), cell("R2C2")] }),
        ],
      }),
    ]),
  );

export const buildMergedTable = (): Promise<Buffer> =>
  pack(
    singleSection([
      new Table({
        width: { size: 100, type: WidthType.PERCENTAGE },
        rows: [
          new TableRow({ children: [cell("Spanning header", { columnSpan: 2 })] }),
          new TableRow({ children: [cell("B1"), cell("B2")] }),
        ],
      }),
    ]),
  );

export const buildFootnote = (): Promise<Buffer> =>
  pack(
    new Document({
      footnotes: { 1: { children: [new Paragraph("The footnote body text.")] } },
      sections: [
        {
          children: [
            new Paragraph({
              children: [
                new TextRun("A claim with a note"),
                new FootnoteReferenceRun(1),
                new TextRun("."),
              ],
            }),
          ],
        },
      ],
    }),
  );

/** A document with 11 footnotes so the round-trip exercises MULTI-DIGIT display
 * markers (`[10]`, `[11]`) — pins that the export cursor advances by the marker's
 * actual length (not a hard-coded 3) and that ids stay stable across generations. */
export const buildMultiFootnote = (): Promise<Buffer> => {
  const count = 11;
  const footnotes: Record<number, { children: Paragraph[] }> = {};
  const children: (TextRun | FootnoteReferenceRun)[] = [];
  for (let id = 1; id <= count; id++) {
    footnotes[id] = { children: [new Paragraph(`Body of footnote ${id}.`)] };
    if (id > 1) children.push(new TextRun(" "));
    children.push(new TextRun(`claim ${id}`), new FootnoteReferenceRun(id));
  }
  return pack(new Document({ footnotes, sections: [{ children: [new Paragraph({ children })] }] }));
};

export const buildEndnote = (): Promise<Buffer> =>
  pack(
    new Document({
      endnotes: { 1: { children: [new Paragraph("The endnote body text.")] } },
      sections: [
        {
          children: [
            new Paragraph({
              children: [
                new TextRun("A claim with an endnote"),
                new EndnoteReferenceRun(1),
                new TextRun("."),
              ],
            }),
          ],
        },
      ],
    }),
  );

export const buildHeaderFooter = (): Promise<Buffer> =>
  pack(
    new Document({
      sections: [
        {
          headers: { default: new Header({ children: [new Paragraph("Running header text")] }) },
          footers: { default: new Footer({ children: [new Paragraph("Running footer text")] }) },
          children: [new Paragraph("Body with a header and footer.")],
        },
      ],
    }),
  );

export const buildEmbeddedImage = (): Promise<Buffer> =>
  pack(
    singleSection([
      new Paragraph({
        children: [
          new ImageRun({ data: PNG_1x1, transformation: { width: 16, height: 16 }, type: "png" }),
        ],
      }),
    ]),
  );

// ---------------------------------------------------------------------------
// Raw-OOXML fixtures (style divergence, comments, tracked changes)
// ---------------------------------------------------------------------------

const WML = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";

/** Assemble a minimal .docx package from a document body + optional extra parts. */
async function rawDocx(opts: {
  body: string;
  /** Extra files keyed by zip path (e.g. "word/comments.xml"). */
  parts?: Record<string, string>;
  /** Content-type <Override> elements to add. */
  overrides?: string[];
  /** Relationship entries for word/_rels/document.xml.rels. */
  documentRels?: string[];
}): Promise<Buffer> {
  const zip = new JSZip();
  zip.file(
    "[Content_Types].xml",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
      `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
      `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>` +
      `<Default Extension="xml" ContentType="application/xml"/>` +
      `<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>` +
      (opts.overrides ?? []).join("") +
      `</Types>`,
  );
  zip.file(
    "_rels/.rels",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
      `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
      `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>` +
      `</Relationships>`,
  );
  zip.file(
    "word/document.xml",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
      `<w:document xmlns:w="${WML}"><w:body>${opts.body}</w:body></w:document>`,
  );
  if (opts.documentRels && opts.documentRels.length > 0) {
    zip.file(
      "word/_rels/document.xml.rels",
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
        `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
        opts.documentRels.join("") +
        `</Relationships>`,
    );
  }
  for (const [path, content] of Object.entries(opts.parts ?? {})) zip.file(path, content);
  return (await zip.generateAsync({ type: "nodebuffer" })) as Buffer;
}

/** A heading expressed via a CUSTOM (undefined) paragraph style — mammoth can't
 * recognize it, so it degrades to a plain paragraph. The synthetic-masking
 * antidote: real Word templates use custom style names, not canonical Heading1. */
export const buildCustomStyleHeading = (): Promise<Buffer> =>
  rawDocx({
    body:
      `<w:p><w:pPr><w:pStyle w:val="CorpHeadingAlpha"/></w:pPr>` +
      `<w:r><w:t>A heading via a corporate style</w:t></w:r></w:p>`,
  });

/** A single Word comment with a FIXED date (timestamp-deterministic). */
export const buildComment = (): Promise<Buffer> =>
  rawDocx({
    body:
      `<w:p>` +
      `<w:r><w:t xml:space="preserve">Before </w:t></w:r>` +
      `<w:commentRangeStart w:id="0"/>` +
      `<w:r><w:t>anchored text</w:t></w:r>` +
      `<w:commentRangeEnd w:id="0"/>` +
      `<w:r><w:commentReference w:id="0"/></w:r>` +
      `<w:r><w:t xml:space="preserve"> after.</w:t></w:r>` +
      `</w:p>`,
    overrides: [
      `<Override PartName="/word/comments.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.comments+xml"/>`,
    ],
    documentRels: [
      `<Relationship Id="rIdC1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/comments" Target="comments.xml"/>`,
    ],
    parts: {
      "word/comments.xml":
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
        `<w:comments xmlns:w="${WML}">` +
        `<w:comment w:id="0" w:author="Reviewer" w:date="2020-01-01T00:00:00Z" w:initials="R">` +
        `<w:p><w:r><w:t>A reviewer note.</w:t></w:r></w:p>` +
        `</w:comment></w:comments>`,
    },
  });

/** A comment anchored over an UNDERLINED run (direct `<w:u>`), FIXED date. Pins
 * that underline (an offset-neutral mark) does not shift the comment-anchor
 * offset: `walkDocumentBody` (raw XML, counts the run as text) and
 * `extractText(htmlToYDoc(mammoth(...)))` (underline as a delta attribute) must
 * still agree, so the comment resolves to the same "anchored text". */
export const buildUnderlinedComment = (): Promise<Buffer> =>
  rawDocx({
    body:
      `<w:p>` +
      `<w:r><w:t xml:space="preserve">Before </w:t></w:r>` +
      `<w:commentRangeStart w:id="0"/>` +
      `<w:r><w:rPr><w:u w:val="single"/></w:rPr><w:t>anchored text</w:t></w:r>` +
      `<w:commentRangeEnd w:id="0"/>` +
      `<w:r><w:commentReference w:id="0"/></w:r>` +
      `<w:r><w:t xml:space="preserve"> after.</w:t></w:r>` +
      `</w:p>`,
    overrides: [
      `<Override PartName="/word/comments.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.comments+xml"/>`,
    ],
    documentRels: [
      `<Relationship Id="rIdC1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/comments" Target="comments.xml"/>`,
    ],
    parts: {
      "word/comments.xml":
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
        `<w:comments xmlns:w="${WML}">` +
        `<w:comment w:id="0" w:author="Reviewer" w:date="2020-01-01T00:00:00Z" w:initials="R">` +
        `<w:p><w:r><w:t>A reviewer note.</w:t></w:r></w:p>` +
        `</w:comment></w:comments>`,
    },
  });

/** Tracked changes: an insertion + a deletion, fixed dates. mammoth accepts the
 * insertion as body text and drops the deletion + all revision metadata. */
export const buildTrackedChange = (): Promise<Buffer> =>
  rawDocx({
    body:
      `<w:p>` +
      `<w:r><w:t xml:space="preserve">Kept </w:t></w:r>` +
      `<w:ins w:id="1" w:author="A" w:date="2020-01-01T00:00:00Z"><w:r><w:t>added</w:t></w:r></w:ins>` +
      `<w:del w:id="2" w:author="A" w:date="2020-01-01T00:00:00Z"><w:r><w:delText>removed</w:delText></w:r></w:del>` +
      `<w:r><w:t xml:space="preserve"> end.</w:t></w:r>` +
      `</w:p>`,
  });
