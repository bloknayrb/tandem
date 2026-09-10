import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import render from "dom-serializer";
import JSZip from "jszip";
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import { sendNoteToClaude } from "../../src/client/panels/annotation-actions.js";
import {
  clearDirtyState,
  markDirty,
  registerDirtyObserver,
} from "../../src/server/documents/dirty.js";
import { addDoc, removeDoc, setActiveDocId } from "../../src/server/documents/registry-testing.js";
import { wireFileWatcher } from "../../src/server/documents/watcher.js";
import { listDocBackups } from "../../src/server/file-io/doc-backup.js";
import { loadDocx } from "../../src/server/file-io/docx.js";
import {
  applySingleSuggestion,
  applyTrackedChanges,
  buildOffsetMap,
  resolveWordComments,
} from "../../src/server/file-io/docx-apply.js";
import {
  importAnnotationId,
  injectCommentsAsAnnotations,
} from "../../src/server/file-io/docx-comments.js";
import { htmlToYDoc } from "../../src/server/file-io/docx-html.js";
import { walkDocumentBody } from "../../src/server/file-io/docx-walker.js";
import { unwatchFile } from "../../src/server/file-watcher.js";
import { extractText } from "../../src/server/mcp/document-model.js";
import { getOpenDocs } from "../../src/server/mcp/document-service.js";
import { applyChangesCore } from "../../src/server/mcp/docx-apply.js";
import { resolveAppDataDir } from "../../src/server/platform.js";
import { getOrCreateDocument } from "../../src/server/yjs/provider.js";
import {
  Y_MAP_ANNOTATIONS,
  Y_MAP_DOCUMENT_META,
  Y_MAP_EXTERNAL_CONFLICT,
  Y_MAP_SAVED_AT_VERSION,
} from "../../src/shared/constants.js";
import { withInternal } from "../../src/shared/origins.js";
import type { Annotation } from "../../src/shared/types.js";
import { toFlatOffset } from "../../src/shared/types.js";
import { timeoutMs } from "../helpers/timing.js";

/**
 * Headroom for the specs that perform a REAL .docx apply, over the project's
 * 15s default. Duration is not the property any of them asserts — they assert
 * `applied: 1`, a savedAtVersion, a snapshot count — so raising the ceiling
 * makes them slower real gates rather than blunting them. Where duration IS the
 * assertion, see `tests/helpers/timing.ts`.
 *
 * What it measures today (#1672, #1699). Measured 2026-09-06 with a single-file
 * `vitest run --reporter=verbose` — NOT under full-suite parallelism: the whole
 * file runs in the low-single-digit-seconds band over 53 specs, and every spec
 * carrying this ceiling lands in the single-digit-to-low-tens-of-ms band. The
 * two exceptions are "the watcher reload that completes an apply finally lands
 * (#1749) — clean doc" and "the watcher reload that completes an apply flags a
 * conflict on a DIRTY doc (#1749)", both in the sub-second band because they
 * wait on a real `fs.watch` debounce by design. Bands, not point values:
 * repeated runs move individual specs about twofold while the bands and the
 * file total reproduce, so a figure pinned in this comment would be the same
 * construction that sized — and misdescribed — this ceiling before.
 *
 * Which phase a red names. The carrying specs await one `applyChangesCore(...)`
 * plus cheap `fsp` calls; the two watcher specs additionally wait under their
 * own `vi.waitFor(…)`, which fails with its own assertion. So a bare
 * `Test timed out in 60000ms` is the apply, and a `vi.waitFor` failure is the
 * reload. The greppable literal is vitest's un-underscored 60000 (300000 under
 * a coverage run), not this file's `60_000`, which also appears below as
 * unrelated mtime arithmetic.
 *
 * What a red is NOT. At this distance from the ceiling it cannot be gradual
 * growth — it is a hang or a starved machine. Look first for a never-settling
 * `await` or an unreleased lock in the apply (the `wireFileWatcher` /
 * `unwatchFile` pairs in the two watcher specs); the machine case has a
 * precedent in #1672, where a leaked third-party process tree holding 30
 * abandoned sessions starved the shared worker pool and a suite that had failed
 * twice went green with no code change. Raising the number is the response to
 * neither.
 *
 * Via `timeoutMs` rather than a bare literal: an explicit second argument to
 * `it` beats `--testTimeout`, so a coverage run (1.1-1.5x instrumented) would
 * otherwise fail these on a clock for a reason unrelated to what they check.
 */
const REAL_APPLY_TIMEOUT_MS = timeoutMs(60_000, 300_000);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function wrapBody(bodyContent: string): string {
  return `<?xml version="1.0"?>
    <w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"
                xmlns:w14="http://schemas.microsoft.com/office/word/2010/wordml">
      <w:body>${bodyContent}</w:body>
    </w:document>`;
}

const W_NS = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
const W14_NS = "http://schemas.microsoft.com/office/word/2010/wordml";

/** Build a minimal word/comments.xml. Each comment lists its paragraph paraIds in order. */
function commentsXml(comments: Array<{ id: string; paraIds: string[] }>): string {
  const body = comments
    .map(
      (c) =>
        `<w:comment w:id="${c.id}" w:author="A" w:date="2026-01-01T00:00:00Z">` +
        c.paraIds.map((p) => `<w:p w14:paraId="${p}"><w:r><w:t>body</w:t></w:r></w:p>`).join("") +
        `</w:comment>`,
    )
    .join("");
  return `<?xml version="1.0"?><w:comments xmlns:w="${W_NS}" xmlns:w14="${W14_NS}">${body}</w:comments>`;
}

/**
 * A minimal but structurally valid .docx. `extraParts` adds package parts on
 * top of the four every caller needs — `word/comments.xml`, say — so a fixture
 * that only differs by one part does not restamp the other three.
 */
async function createTestDocx(
  documentXml: string,
  extraParts: Record<string, string> = {},
): Promise<Buffer> {
  const zip = new JSZip();
  zip.file("word/document.xml", documentXml);
  for (const [name, content] of Object.entries(extraParts)) zip.file(name, content);
  zip.file(
    "[Content_Types].xml",
    `<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/></Types>`,
  );
  zip.file(
    "_rels/.rels",
    `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`,
  );
  zip.file(
    "word/_rels/document.xml.rels",
    `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"/>`,
  );
  return Buffer.from(await zip.generateAsync({ type: "nodebuffer" }));
}

function makeYTableCell(text: string): Y.XmlElement {
  const cell = new Y.XmlElement("tableCell");
  const paragraph = new Y.XmlElement("paragraph");
  const xmlText = new Y.XmlText();
  xmlText.insert(0, text);
  paragraph.insert(0, [xmlText]);
  cell.insert(0, [paragraph]);
  return cell;
}

function makeYParagraph(text: string): Y.XmlElement {
  const paragraph = new Y.XmlElement("paragraph");
  const xmlText = new Y.XmlText();
  xmlText.insert(0, text);
  paragraph.insert(0, [xmlText]);
  return paragraph;
}

// ---------------------------------------------------------------------------
// buildOffsetMap
// ---------------------------------------------------------------------------

describe("buildOffsetMap", () => {
  it("maps offsets in a single run", () => {
    const xml = wrapBody(`<w:p><w:r><w:t>Hello</w:t></w:r></w:p>`);
    const map = buildOffsetMap(xml, new Set([0, 2, 5]));

    expect(map.flatText).toBe("Hello");
    expect(map.totalLength).toBe(5);

    const at0 = map.get(0);
    expect(at0).toBeDefined();
    expect(at0!.charIndex).toBe(0);

    const at2 = map.get(2);
    expect(at2).toBeDefined();
    expect(at2!.charIndex).toBe(2);

    // Offset 5 = end of document = end of text node
    const at5 = map.get(5);
    expect(at5).toBeDefined();
    expect(at5!.charIndex).toBe(5);
  });

  it("maps offsets across multiple runs", () => {
    const xml = wrapBody(`
      <w:p>
        <w:r><w:t>Hello</w:t></w:r>
        <w:r><w:t> World</w:t></w:r>
      </w:p>
    `);
    const map = buildOffsetMap(xml, new Set([0, 5, 7]));

    expect(map.flatText).toBe("Hello World");

    const at0 = map.get(0);
    expect(at0).toBeDefined();
    expect(at0!.charIndex).toBe(0);

    // Offset 5 is start of second run (" World")
    const at5 = map.get(5);
    expect(at5).toBeDefined();
    expect(at5!.charIndex).toBe(0);

    // Offset 7 is "Wo" -> charIndex 2 in second run
    const at7 = map.get(7);
    expect(at7).toBeDefined();
    expect(at7!.charIndex).toBe(2);
  });

  it("accounts for heading prefix in offsets", () => {
    const xml = wrapBody(`
      <w:p>
        <w:pPr><w:pStyle w:val="Heading2"/></w:pPr>
        <w:r><w:t>Title</w:t></w:r>
      </w:p>
    `);
    // "## " prefix is 3 chars, then "Title" starts at offset 3
    const map = buildOffsetMap(xml, new Set([3, 5]));

    expect(map.flatText).toBe("## Title");

    const at3 = map.get(3);
    expect(at3).toBeDefined();
    expect(at3!.charIndex).toBe(0); // start of "Title"

    const at5 = map.get(5);
    expect(at5).toBeDefined();
    expect(at5!.charIndex).toBe(2); // "Ti" -> index 2
  });

  it("returns flatText for comparison guard", () => {
    const xml = wrapBody(`
      <w:p><w:r><w:t>First</w:t></w:r></w:p>
      <w:p><w:r><w:t>Second</w:t></w:r></w:p>
    `);
    const map = buildOffsetMap(xml, new Set());
    expect(map.flatText).toBe("First\nSecond");
    expect(map.totalLength).toBe(12);
  });

  it("matches Y.Doc flat text for table cells followed by a paragraph", () => {
    const xml = wrapBody(`
      <w:tbl>
        <w:tr>
          <w:tc><w:p><w:r><w:t>A</w:t></w:r></w:p></w:tc>
          <w:tc><w:p><w:r><w:t>B</w:t></w:r></w:p></w:tc>
        </w:tr>
      </w:tbl>
      <w:p><w:r><w:t>After</w:t></w:r></w:p>
    `);
    const map = buildOffsetMap(xml, new Set());
    expect(map.flatText).toBe("A\nB\nAfter");
  });

  it("returns undefined for unmapped offsets", () => {
    const xml = wrapBody(`<w:p><w:r><w:t>Hi</w:t></w:r></w:p>`);
    const map = buildOffsetMap(xml, new Set([99]));
    expect(map.get(99)).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// applySingleSuggestion
// ---------------------------------------------------------------------------

describe("applySingleSuggestion", () => {
  it("replaces a single run with del + ins markup", () => {
    const xml = wrapBody(`<w:p><w:r><w:t>Hello World</w:t></w:r></w:p>`);
    const map = buildOffsetMap(xml, new Set([0, 11]));

    const result = applySingleSuggestion(map, {
      from: 0,
      to: 11,
      newText: "Hi Earth",
      author: "Test Author",
      date: "2024-01-01T00:00:00Z",
      revisionId: 100,
    });

    expect(result.ok).toBe(true);

    const output = render(map.body, { xmlMode: true });
    // Should contain w:del with w:delText
    expect(output).toContain("w:del");
    expect(output).toContain("w:delText");
    expect(output).toContain("Hello World");
    // Should contain w:ins with w:t
    expect(output).toContain("w:ins");
    expect(output).toContain("Hi Earth");
    // Should have author and date
    expect(output).toContain('w:author="Test Author"');
    expect(output).toContain('w:date="2024-01-01T00:00:00Z"');
  });

  it("inherits rPr from the first deleted run", () => {
    const xml = wrapBody(`<w:p><w:r><w:rPr><w:b/></w:rPr><w:t>Bold text</w:t></w:r></w:p>`);
    const map = buildOffsetMap(xml, new Set([0, 9]));

    const result = applySingleSuggestion(map, {
      from: 0,
      to: 9,
      newText: "New bold",
      author: "Author",
      date: "2024-01-01T00:00:00Z",
      revisionId: 200,
    });

    expect(result.ok).toBe(true);
    const output = render(map.body, { xmlMode: true });
    // The ins run should have w:rPr with w:b
    const insMatch = output.match(/<w:ins[^>]*>(.*?)<\/w:ins>/s);
    expect(insMatch).toBeTruthy();
    expect(insMatch![1]).toContain("<w:rPr><w:b/></w:rPr>");
  });

  it("handles partial-run split at start boundary", () => {
    const xml = wrapBody(`<w:p><w:r><w:t>Hello World</w:t></w:r></w:p>`);
    // Replace "World" (offset 6..11)
    const map = buildOffsetMap(xml, new Set([6, 11]));

    const result = applySingleSuggestion(map, {
      from: 6,
      to: 11,
      newText: "Earth",
      author: "Author",
      date: "2024-01-01T00:00:00Z",
      revisionId: 300,
    });

    expect(result.ok).toBe(true);
    const output = render(map.body, { xmlMode: true });
    // "Hello " should remain as a plain run (with xml:space preserve due to trailing space)
    expect(output).toContain('xml:space="preserve">Hello </w:t>');
    // "World" should be in w:delText
    expect(output).toContain("<w:delText>World</w:delText>");
    // "Earth" should be in w:ins
    expect(output).toContain("Earth");
  });

  it("handles partial-run split at end boundary", () => {
    const xml = wrapBody(`<w:p><w:r><w:t>Hello World</w:t></w:r></w:p>`);
    // Replace "Hello" (offset 0..5)
    const map = buildOffsetMap(xml, new Set([0, 5]));

    const result = applySingleSuggestion(map, {
      from: 0,
      to: 5,
      newText: "Hi",
      author: "Author",
      date: "2024-01-01T00:00:00Z",
      revisionId: 400,
    });

    expect(result.ok).toBe(true);
    const output = render(map.body, { xmlMode: true });
    // "Hello" should be in w:delText
    expect(output).toContain("<w:delText>Hello</w:delText>");
    // " World" should remain as a plain run (with xml:space preserve due to leading space)
    expect(output).toContain('xml:space="preserve"> World</w:t>');
    // "Hi" should be in w:ins
    expect(output).toContain("Hi");
  });

  it("handles deletion only (empty newText)", () => {
    const xml = wrapBody(`<w:p><w:r><w:t>Delete me</w:t></w:r></w:p>`);
    const map = buildOffsetMap(xml, new Set([0, 9]));

    const result = applySingleSuggestion(map, {
      from: 0,
      to: 9,
      newText: "",
      author: "Author",
      date: "2024-01-01T00:00:00Z",
      revisionId: 500,
    });

    expect(result.ok).toBe(true);
    const output = render(map.body, { xmlMode: true });
    expect(output).toContain("w:del");
    expect(output).toContain("<w:delText>Delete me</w:delText>");
    expect(output).not.toContain("w:ins");
  });

  it("handles cross-run replacement", () => {
    const xml = wrapBody(`
      <w:p>
        <w:r><w:t>Hello</w:t></w:r>
        <w:r><w:t> World</w:t></w:r>
      </w:p>
    `);
    // Replace "lo Wo" (offset 3..8) spanning two runs
    const map = buildOffsetMap(xml, new Set([3, 8]));

    const result = applySingleSuggestion(map, {
      from: 3,
      to: 8,
      newText: "LO WO",
      author: "Author",
      date: "2024-01-01T00:00:00Z",
      revisionId: 600,
    });

    expect(result.ok).toBe(true);
    const output = render(map.body, { xmlMode: true });
    // Should have del and ins
    expect(output).toContain("w:del");
    expect(output).toContain("w:ins");
    expect(output).toContain("LO WO");
    // "Hel" should remain
    expect(output).toContain("<w:t>Hel</w:t>");
    // "rld" should remain
    expect(output).toContain("<w:t>rld</w:t>");
  });
});

// ---------------------------------------------------------------------------
// applyTrackedChanges (end-to-end with JSZip)
// ---------------------------------------------------------------------------

describe("applyTrackedChanges", () => {
  it("applies a suggestion and round-trips through JSZip", async () => {
    const xml = wrapBody(`<w:p><w:r><w:t>Hello World</w:t></w:r></w:p>`);
    const docxBuffer = await createTestDocx(xml);

    const output = await applyTrackedChanges(
      docxBuffer,
      [{ id: "s1", from: 0, to: 5, newText: "Hi" }],
      { author: "Test", ydocFlatText: "Hello World" },
    );

    expect(output.applied).toBe(1);
    expect(output.rejected).toBe(0);

    // Verify the XML in the output buffer
    const zip = await JSZip.loadAsync(output.buffer);
    const resultXml = await zip.file("word/document.xml")!.async("text");
    expect(resultXml).toContain("w:del");
    expect(resultXml).toContain("w:ins");
    expect(resultXml).toContain("Hi");
    expect(resultXml).toContain("<w:delText>Hello</w:delText>");
  });

  it("rejects suggestions with textSnapshot mismatch", async () => {
    const xml = wrapBody(`<w:p><w:r><w:t>Hello World</w:t></w:r></w:p>`);
    const docxBuffer = await createTestDocx(xml);

    const output = await applyTrackedChanges(
      docxBuffer,
      [{ id: "s1", from: 0, to: 5, newText: "Hi", textSnapshot: "WRONG" }],
      { author: "Test", ydocFlatText: "Hello World" },
    );

    expect(output.applied).toBe(0);
    expect(output.rejected).toBe(1);
    expect(output.rejectedDetails[0].id).toBe("s1");
    expect(output.rejectedDetails[0].reason).toContain("snapshot mismatch");
  });

  it("distinguishes an ABSENT textSnapshot from a stored EMPTY one (#1631)", async () => {
    // The guard used to gate on `s.textSnapshot !== undefined`; it now calls
    // the shared `snapshotContradicts`, and the whole risk of that move was
    // collapsing these two into one. `snapshotSearchPrefix` returns "" for
    // both, so a carve-out keyed on IT would silently stop checking the second.
    //
    // Absent means nothing was captured ⇒ nothing to contradict ⇒ apply.
    // Empty means the range was captured and held no text ⇒ a real claim ⇒ a
    // non-empty range contradicts it.
    const xml = wrapBody(`<w:p><w:r><w:t>Hello World</w:t></w:r></w:p>`);
    const docxBuffer = await createTestDocx(xml);

    const absent = await applyTrackedChanges(
      docxBuffer,
      [{ id: "s1", from: 0, to: 5, newText: "Hi" }],
      { author: "Test", ydocFlatText: "Hello World" },
    );
    expect(absent.applied).toBe(1);
    expect(absent.rejected).toBe(0);

    const empty = await applyTrackedChanges(
      docxBuffer,
      [{ id: "s1", from: 0, to: 5, newText: "Hi", textSnapshot: "" }],
      { author: "Test", ydocFlatText: "Hello World" },
    );
    expect(empty.applied).toBe(0);
    expect(empty.rejected).toBe(1);
  });

  it("accepts a TRUNCATED textSnapshot that is still a prefix of the range (#1486)", async () => {
    // The snapshot is capped at 200 chars, so for any longer range it is a
    // prefix and can never equal the whole slice. Compared exactly, this
    // guard rejected every long suggestion and blamed the document — the one
    // failure mode that reads as "someone else edited this" when nobody had.
    const body = Array.from({ length: 30 }, (_, i) => `clause ${i} distinct.`).join(" ");
    const xml = wrapBody(`<w:p><w:r><w:t>${body}</w:t></w:r></w:p>`);
    const docxBuffer = await createTestDocx(xml);

    const output = await applyTrackedChanges(
      docxBuffer,
      [
        {
          id: "s1",
          from: 0,
          to: body.length,
          newText: "Replaced.",
          textSnapshot: body.slice(0, 200),
          textSnapshotTruncated: true,
        },
      ],
      { author: "Test", ydocFlatText: body },
    );

    expect(output.rejectedDetails).toEqual([]);
    expect(output.applied).toBe(1);
  });

  it("still rejects a truncated snapshot whose prefix no longer matches (#1486)", async () => {
    // The positive control. Relaxing the comparison to `startsWith` must not
    // relax it to "always true" — a truncated snapshot still has to detect
    // that the text underneath it changed, which is the guard's whole job.
    const body = Array.from({ length: 30 }, (_, i) => `clause ${i} distinct.`).join(" ");
    const xml = wrapBody(`<w:p><w:r><w:t>${body}</w:t></w:r></w:p>`);
    const docxBuffer = await createTestDocx(xml);

    const output = await applyTrackedChanges(
      docxBuffer,
      [
        {
          id: "s1",
          from: 0,
          to: body.length,
          newText: "Replaced.",
          textSnapshot: `something else entirely${body.slice(23, 200)}`,
          textSnapshotTruncated: true,
        },
      ],
      { author: "Test", ydocFlatText: body },
    );

    expect(output.applied).toBe(0);
    expect(output.rejectedDetails[0]?.reason).toContain("snapshot mismatch");
  });

  it("throws on comparison guard failure", async () => {
    const xml = wrapBody(`<w:p><w:r><w:t>Hello World</w:t></w:r></w:p>`);
    const docxBuffer = await createTestDocx(xml);

    await expect(
      applyTrackedChanges(docxBuffer, [{ id: "s1", from: 0, to: 5, newText: "Hi" }], {
        author: "Test",
        ydocFlatText: "TOTALLY DIFFERENT TEXT",
      }),
    ).rejects.toThrow("Flat text mismatch");
  });

  it("applies multiple suggestions in reverse order", async () => {
    // Each suggestion targets a separate run so the same-run check doesn't fire
    const xml = wrapBody(`
      <w:p>
        <w:r><w:t>Hello</w:t></w:r>
        <w:r><w:t> World </w:t></w:r>
        <w:r><w:t>Today</w:t></w:r>
      </w:p>
    `);
    const docxBuffer = await createTestDocx(xml);

    const output = await applyTrackedChanges(
      docxBuffer,
      [
        { id: "s1", from: 0, to: 5, newText: "Hi" },
        { id: "s2", from: 12, to: 17, newText: "Now" },
      ],
      { author: "Test", ydocFlatText: "Hello World Today" },
    );

    expect(output.applied).toBe(2);
    expect(output.rejected).toBe(0);

    const zip = await JSZip.loadAsync(output.buffer);
    const resultXml = await zip.file("word/document.xml")!.async("text");
    expect(resultXml).toContain("Hi");
    expect(resultXml).toContain("Now");
  });

  it("rejects overlapping ranges", async () => {
    const xml = wrapBody(`<w:p><w:r><w:t>Hello World</w:t></w:r></w:p>`);
    const docxBuffer = await createTestDocx(xml);

    const output = await applyTrackedChanges(
      docxBuffer,
      [
        { id: "s1", from: 0, to: 7, newText: "A" },
        { id: "s2", from: 5, to: 11, newText: "B" },
      ],
      { author: "Test", ydocFlatText: "Hello World" },
    );

    // One should be applied, the other rejected for overlap
    expect(output.applied + output.rejected).toBe(2);
    expect(output.rejected).toBeGreaterThanOrEqual(1);
    expect(output.rejectedDetails.some((r) => r.reason.includes("Overlapping"))).toBe(true);
  });

  it("rejects suggestions containing complex elements (footnoteReference)", async () => {
    const xml = wrapBody(`
      <w:p>
        <w:r><w:t>See note</w:t><w:footnoteReference w:id="1"/></w:r>
        <w:r><w:t> and more text</w:t></w:r>
      </w:p>
    `);
    const docxBuffer = await createTestDocx(xml);

    const output = await applyTrackedChanges(
      docxBuffer,
      [
        { id: "s1", from: 0, to: 8, newText: "Check note" },
        { id: "s2", from: 8, to: 22, newText: " plus extra" },
      ],
      { author: "Test", ydocFlatText: "See note and more text" },
    );

    // s1 targets the run with footnoteReference — should be rejected
    expect(
      output.rejectedDetails.some(
        (r) => r.id === "s1" && r.reason.includes("Overlaps a footnote, drawing, field"),
      ),
    ).toBe(true);
    // s2 targets the clean second run — should apply
    expect(output.applied).toBeGreaterThanOrEqual(1);
  });

  it("rejects later suggestion when two target the same run", async () => {
    const xml = wrapBody(`<w:p><w:r><w:t>Hello World Today</w:t></w:r></w:p>`);
    const docxBuffer = await createTestDocx(xml);

    const output = await applyTrackedChanges(
      docxBuffer,
      [
        { id: "s1", from: 0, to: 5, newText: "Hi" },
        { id: "s2", from: 6, to: 11, newText: "Earth" },
      ],
      { author: "Test", ydocFlatText: "Hello World Today" },
    );

    // Both target the same single run — one should apply, one rejected
    expect(output.applied).toBe(1);
    expect(output.rejected).toBeGreaterThanOrEqual(1);
    expect(output.rejectedDetails.some((r) => r.reason.includes("same text run"))).toBe(true);
  });

  it("rejects cross-paragraph suggestions", async () => {
    const xml = wrapBody(`
      <w:p><w:r><w:t>First paragraph</w:t></w:r></w:p>
      <w:p><w:r><w:t>Second paragraph</w:t></w:r></w:p>
    `);
    const docxBuffer = await createTestDocx(xml);

    // "paragraph\nSecond" spans the paragraph boundary (offset 6..22 in "First paragraph\nSecond paragraph")
    const output = await applyTrackedChanges(
      docxBuffer,
      [{ id: "s1", from: 6, to: 22, newText: "REPLACED" }],
      { author: "Test", ydocFlatText: "First paragraph\nSecond paragraph" },
    );

    expect(output.applied).toBe(0);
    expect(output.rejected).toBe(1);
    expect(output.rejectedDetails[0].reason).toContain("Cross-paragraph");
  });

  it("applies a suggestion after a table without flat-text mismatch", async () => {
    const xml = wrapBody(`
      <w:tbl>
        <w:tr>
          <w:tc><w:p><w:r><w:t>A</w:t></w:r></w:p></w:tc>
          <w:tc><w:p><w:r><w:t>B</w:t></w:r></w:p></w:tc>
        </w:tr>
      </w:tbl>
      <w:p><w:r><w:t>After</w:t></w:r></w:p>
    `);
    const docxBuffer = await createTestDocx(xml);

    const ydoc = new Y.Doc();
    const table = new Y.XmlElement("table");
    const row = new Y.XmlElement("tableRow");
    row.insert(0, [makeYTableCell("A"), makeYTableCell("B")]);
    table.insert(0, [row]);
    ydoc.getXmlFragment("default").insert(0, [table, makeYParagraph("After")]);
    const ydocFlatText = extractText(ydoc);
    expect(ydocFlatText).toBe("A\nB\nAfter");

    const from = ydocFlatText.indexOf("After");
    const output = await applyTrackedChanges(
      docxBuffer,
      [{ id: "s1", from, to: from + "After".length, newText: "Later" }],
      { author: "Test", ydocFlatText },
    );

    expect(output.applied).toBe(1);
    expect(output.rejected).toBe(0);
    ydoc.destroy();
  });
});

// ---------------------------------------------------------------------------
// resolveWordComments
// ---------------------------------------------------------------------------

describe("resolveWordComments", () => {
  function countCommentEx(xml: string): number {
    return (xml.match(/<w15:commentEx\b/g) || []).length;
  }

  it("marks a comment done using its OWN last-paragraph paraId, not the document anchor (#1007)", async () => {
    const zip = new JSZip();
    // The comment body has two paragraphs; CT_CommentEx must reference the LAST.
    zip.file("word/comments.xml", commentsXml([{ id: "42", paraIds: ["AAAA1111", "BBBB2222"] }]));
    zip.file("word/document.xml", "<stub/>");
    zip.file(
      "[Content_Types].xml",
      `<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/></Types>`,
    );
    zip.file(
      "word/_rels/document.xml.rels",
      `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"/>`,
    );

    const suggestions = [{ id: "s1", from: 0, to: 5, newText: "New", importCommentId: "42" }];
    const resolved = await resolveWordComments(zip, suggestions);
    expect(resolved).toBe(1);

    const extXml = await zip.file("word/commentsExtended.xml")!.async("text");
    expect(extXml).toContain('w15:paraId="BBBB2222"'); // the comment's last paragraph
    expect(extXml).not.toContain("AAAA1111"); // NOT the first/anchor paragraph
    expect(extXml).toContain('w15:done="1"');

    // Still wires up the content type + relationship for the new part.
    expect(await zip.file("[Content_Types].xml")!.async("text")).toContain("commentsExtended");
    expect(await zip.file("word/_rels/document.xml.rels")!.async("text")).toContain(
      "commentsExtended",
    );
  });

  it("uses the last TOP-LEVEL paragraph paraId even when the comment body contains an embedded table", async () => {
    // A comment whose body is: <w:p TOPLEVEL1/> <w:tbl><w:tr><w:tc><w:p NESTED/></w:tc></w:tr></w:tbl> <w:p TOPLEVEL2/>
    // CT_CommentEx @paraId must be TOPLEVEL2, not NESTED (the deepest/last in doc order).
    const zip = new JSZip();
    const xml =
      `<?xml version="1.0"?><w:comments xmlns:w="${W_NS}" xmlns:w14="${W14_NS}">` +
      `<w:comment w:id="55" w:author="A" w:date="2026-01-01T00:00:00Z">` +
      `<w:p w14:paraId="TOPLEVEL1"><w:r><w:t>intro</w:t></w:r></w:p>` +
      `<w:tbl><w:tr><w:tc><w:p w14:paraId="NESTED00"><w:r><w:t>cell</w:t></w:r></w:p></w:tc></w:tr></w:tbl>` +
      `<w:p w14:paraId="TOPLEVEL2"><w:r><w:t>conclusion</w:t></w:r></w:p>` +
      `</w:comment>` +
      `</w:comments>`;
    zip.file("word/comments.xml", xml);
    zip.file("word/document.xml", "<stub/>");
    zip.file(
      "[Content_Types].xml",
      `<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/></Types>`,
    );
    zip.file(
      "word/_rels/document.xml.rels",
      `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"/>`,
    );

    const suggestions = [{ id: "s1", from: 0, to: 3, newText: "X", importCommentId: "55" }];
    const resolved = await resolveWordComments(zip, suggestions);
    expect(resolved).toBe(1);

    const extXml = await zip.file("word/commentsExtended.xml")!.async("text");
    expect(extXml).toContain('w15:paraId="TOPLEVEL2"'); // last TOP-LEVEL paragraph
    expect(extXml).not.toContain("NESTED00"); // NOT the paragraph nested inside the table
    expect(extXml).not.toContain("TOPLEVEL1"); // NOT the first paragraph
    expect(extXml).toContain('w15:done="1"');
  });

  it("updates an existing commentEx entry in place rather than duplicating it (#1007)", async () => {
    const zip = new JSZip();
    zip.file("word/comments.xml", commentsXml([{ id: "7", paraIds: ["0BBB0002"] }]));
    // Word already tracks this comment with done="0".
    zip.file(
      "word/commentsExtended.xml",
      `<?xml version="1.0"?><w15:commentsEx xmlns:w15="http://schemas.microsoft.com/office/word/2012/wordml"><w15:commentEx w15:paraId="0BBB0002" w15:done="0"/></w15:commentsEx>`,
    );

    const suggestions = [{ id: "s1", from: 0, to: 5, newText: "X", importCommentId: "7" }];
    const resolved = await resolveWordComments(zip, suggestions);
    expect(resolved).toBe(1);

    const extXml = await zip.file("word/commentsExtended.xml")!.async("text");
    expect(countCommentEx(extXml)).toBe(1); // updated in place, not duplicated
    expect(extXml).toContain('w15:paraId="0BBB0002"');
    expect(extXml).toContain('w15:done="1"');
    expect(extXml).not.toContain('w15:done="0"');
  });

  it("adds done to an existing entry that had no done attribute", async () => {
    const zip = new JSZip();
    zip.file("word/comments.xml", commentsXml([{ id: "7", paraIds: ["0BBB0002"] }]));
    zip.file(
      "word/commentsExtended.xml",
      `<?xml version="1.0"?><w15:commentsEx xmlns:w15="http://schemas.microsoft.com/office/word/2012/wordml"><w15:commentEx w15:paraId="0BBB0002"/></w15:commentsEx>`,
    );

    const suggestions = [{ id: "s1", from: 0, to: 5, newText: "X", importCommentId: "7" }];
    expect(await resolveWordComments(zip, suggestions)).toBe(1);

    const extXml = await zip.file("word/commentsExtended.xml")!.async("text");
    expect(countCommentEx(extXml)).toBe(1);
    expect(extXml).toContain('w15:done="1"');
  });

  it("matches an existing entry case-insensitively (preserving its original case)", async () => {
    const zip = new JSZip();
    // comments.xml uses lowercase; the existing commentEx uses uppercase.
    zip.file("word/comments.xml", commentsXml([{ id: "7", paraIds: ["abcd1234"] }]));
    zip.file(
      "word/commentsExtended.xml",
      `<?xml version="1.0"?><w15:commentsEx xmlns:w15="http://schemas.microsoft.com/office/word/2012/wordml"><w15:commentEx w15:paraId="ABCD1234" w15:done="0"/></w15:commentsEx>`,
    );

    const suggestions = [{ id: "s1", from: 0, to: 5, newText: "X", importCommentId: "7" }];
    expect(await resolveWordComments(zip, suggestions)).toBe(1);

    const extXml = await zip.file("word/commentsExtended.xml")!.async("text");
    expect(countCommentEx(extXml)).toBe(1); // updated in place, not duplicated
    expect(extXml).toContain('w15:paraId="ABCD1234"'); // existing case preserved
    expect(extXml).toContain('w15:done="1"');
    expect(extXml).not.toContain('w15:done="0"');
  });

  it("appends a new entry alongside an unrelated existing one", async () => {
    const zip = new JSZip();
    zip.file("word/comments.xml", commentsXml([{ id: "99", paraIds: ["NEWPARA0"] }]));
    zip.file(
      "word/commentsExtended.xml",
      `<?xml version="1.0"?><w15:commentsEx xmlns:w15="http://schemas.microsoft.com/office/word/2012/wordml"><w15:commentEx w15:paraId="OTHER000" w15:done="0"/></w15:commentsEx>`,
    );

    const suggestions = [{ id: "s1", from: 0, to: 5, newText: "X", importCommentId: "99" }];
    const resolved = await resolveWordComments(zip, suggestions);
    expect(resolved).toBe(1);

    const extXml = await zip.file("word/commentsExtended.xml")!.async("text");
    expect(extXml).toContain('w15:paraId="OTHER000"'); // untouched
    expect(extXml).toContain('w15:paraId="NEWPARA0"'); // newly resolved
    expect(countCommentEx(extXml)).toBe(2);
  });

  it("resolves multiple distinct comments in one call, each to its own last paraId (#1012)", async () => {
    const zip = new JSZip();
    zip.file(
      "word/comments.xml",
      commentsXml([
        { id: "10", paraIds: ["AAAA0001", "AAAA0002"] },
        { id: "20", paraIds: ["BBBB0001"] },
      ]),
    );
    zip.file("word/document.xml", "<stub/>");
    zip.file(
      "[Content_Types].xml",
      `<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/></Types>`,
    );
    zip.file(
      "word/_rels/document.xml.rels",
      `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"/>`,
    );

    const suggestions = [
      { id: "s1", from: 0, to: 5, newText: "X", importCommentId: "10" },
      { id: "s2", from: 6, to: 9, newText: "Y", importCommentId: "20" },
    ];
    expect(await resolveWordComments(zip, suggestions)).toBe(2);

    const extXml = await zip.file("word/commentsExtended.xml")!.async("text");
    expect(countCommentEx(extXml)).toBe(2);
    expect(extXml).toContain('w15:paraId="AAAA0002"'); // comment 10's LAST paragraph
    expect(extXml).not.toContain("AAAA0001"); // NOT its first paragraph
    expect(extXml).toContain('w15:paraId="BBBB0001"'); // comment 20's only paragraph
  });

  it("dedups by commentId when two suggestions carry the same importCommentId (#1012)", async () => {
    const zip = new JSZip();
    zip.file("word/comments.xml", commentsXml([{ id: "30", paraIds: ["CCCC0001"] }]));
    zip.file("word/document.xml", "<stub/>");
    zip.file(
      "[Content_Types].xml",
      `<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/></Types>`,
    );
    zip.file(
      "word/_rels/document.xml.rels",
      `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"/>`,
    );

    const suggestions = [
      { id: "s1", from: 0, to: 5, newText: "X", importCommentId: "30" },
      { id: "s2", from: 6, to: 9, newText: "Y", importCommentId: "30" },
    ];
    // Both suggestions resolve the same comment → a single commentEx entry.
    expect(await resolveWordComments(zip, suggestions)).toBe(1);

    const extXml = await zip.file("word/commentsExtended.xml")!.async("text");
    expect(countCommentEx(extXml)).toBe(1);
    expect(extXml).toContain('w15:paraId="CCCC0001"');
  });

  it("returns 0 when no suggestions have importCommentId", async () => {
    const zip = new JSZip();
    const suggestions = [{ id: "s1", from: 0, to: 5, newText: "X" }];
    const resolved = await resolveWordComments(zip, suggestions);
    expect(resolved).toBe(0);
  });

  it("skips a comment with no paragraph id in comments.xml", async () => {
    const zip = new JSZip();
    // No word/comments.xml at all → nothing to resolve against.
    const suggestions = [{ id: "s1", from: 0, to: 5, newText: "X", importCommentId: "42" }];
    const resolved = await resolveWordComments(zip, suggestions);
    expect(resolved).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// applyChangesCore — UNC backupPath rejection
// ---------------------------------------------------------------------------

describe("applyChangesCore — UNC backupPath rejection", () => {
  const DOC_ID = "unc-test-doc";

  beforeEach(() => {
    for (const id of [...getOpenDocs().keys()]) removeDoc(id);
    setActiveDocId(null);

    // Register a fake .docx document so the format/source checks pass
    getOrCreateDocument(DOC_ID);
    addDoc(DOC_ID, {
      id: DOC_ID,
      filePath: "/tmp/test.docx",
      format: "docx",
      readOnly: false,
      source: "file",
    });
    setActiveDocId(DOC_ID);
  });

  // These used to early-return on non-Windows, which made them assertion-free
  // no-ops on Ubuntu CI — the only place they actually run. They pass now
  // because the guard checks the RAW `backupPath` before `path.resolve`;
  // checking only the resolved form is inert on POSIX, where `path.resolve`
  // destroys every prefix the check looks for (`//evil/share` → `/evil/share`,
  // and `\\evil\share` → `<cwd>/\\evil\share`).
  it.each([
    ["\\\\attacker.com\\share\\backup.docx", "backslash UNC", /UNC paths are not supported/],
    ["//attacker.com/share/backup.docx", "forward-slash UNC", /UNC paths are not supported/],
    // Message, not just verdict: as a boolean this is indistinguishable from
    // the bare-UNC rows above.
    ["\\\\?\\UNC\\attacker.com\\share\\b.docx", "extended UNC", /Extended-length/],
    ["\\\\.\\pipe\\backup.docx", "device namespace", /Extended-length/],
  ])("rejects a %s backupPath (%s) on every platform", async (badPath, _label, message) => {
    await expect(applyChangesCore(DOC_ID, "Test Author", badPath)).rejects.toMatchObject({
      code: "INVALID_PATH",
      message,
    });
  });
});

// ---------------------------------------------------------------------------
// applyChangesCore — write guards (#1448 W1)
// ---------------------------------------------------------------------------

describe("applyChangesCore — write guards", () => {
  // A fresh id per test: `getOrCreateDocument` is a module-level registry, so a
  // shared id accumulates a paragraph per `beforeEach` and every case after the
  // first fails on a flat-text mismatch instead of on the guard under test.
  let counter = 0;
  let DOC_ID: string;
  let docPath: string;

  beforeEach(async () => {
    for (const id of [...getOpenDocs().keys()]) removeDoc(id);
    setActiveDocId(null);

    counter += 1;
    DOC_ID = `guard-test-doc-${counter}`;
    docPath = path.join(
      await fsp.mkdtemp(path.join(os.tmpdir(), "tandem-apply-guard-")),
      "doc.docx",
    );
    await fsp.writeFile(
      docPath,
      await createTestDocx(wrapBody("<w:p><w:r><w:t>Hello world</w:t></w:r></w:p>")),
    );

    const doc = getOrCreateDocument(DOC_ID);
    doc.getXmlFragment("default").insert(0, [makeYParagraph("Hello world")]);
    // One accepted suggestion, so the guards below are the ONLY thing that can
    // stop the write. Without it every case would fail on NO_SUGGESTIONS and
    // pass for the wrong reason.
    doc.getMap(Y_MAP_ANNOTATIONS).set("a1", {
      id: "a1",
      type: "comment",
      author: "claude",
      status: "accepted",
      range: { from: 0, to: 5 },
      content: "swap it",
      suggestedText: "Howdy",
      textSnapshot: "Hello",
      timestamp: Date.now(),
    });

    addDoc(DOC_ID, {
      id: DOC_ID,
      filePath: docPath,
      format: "docx",
      readOnly: false,
      source: "file",
    });
    setActiveDocId(DOC_ID);
  });

  /** The on-disk bytes, so a guard can be shown to have left the file alone. */
  const onDisk = () => fsp.readFile(docPath);

  it("refuses a read-only document and leaves the file untouched", async () => {
    const before = await onDisk();
    addDoc(DOC_ID, {
      id: DOC_ID,
      filePath: docPath,
      format: "docx",
      readOnly: true,
      source: "file",
    });

    await expect(applyChangesCore(DOC_ID)).rejects.toMatchObject({ code: "READ_ONLY" });
    expect(await onDisk()).toEqual(before);
  });

  it("refuses while an external-edit conflict is pending", async () => {
    const before = await onDisk();
    getOrCreateDocument(DOC_ID).getMap(Y_MAP_DOCUMENT_META).set(Y_MAP_EXTERNAL_CONFLICT, {
      kind: "external-edit",
      diskChanged: true,
      detectedAt: Date.now(),
    });

    await expect(applyChangesCore(DOC_ID)).rejects.toMatchObject({ code: "EXTERNAL_CONFLICT" });
    expect(await onDisk()).toEqual(before);
  });

  // EVERY test in this block that expects applyChangesCore to RESOLVE carries
  // REAL_APPLY_TIMEOUT_MS -- they are the only ones here that perform a real
  // .docx apply. How the ceiling was sized, why it is safe, and what a red
  // names: that constant's comment at the top of this file.
  //
  // "Every" is load-bearing, and getting it wrong is what #1617 was. The first
  // pass at this budgeted the two specs that had been OBSERVED failing rather
  // than asking which specs do a real apply. There were four. The other two
  // kept the 15s ceiling and duly started failing later, and the green suite in
  // between could not have told anyone: an underfunded spec only fails under
  // load. The rule the file wants is name the SET that does the expensive
  // thing, never the members that happened to trip.
  //
  // The full-suite-parallelism slowdown that once sized this is retired by
  // #1672's evidence -- an unrelated leaked process tree starving the machine
  // -- and NOT by the at-rest measurement above, which is single-file and so
  // cannot by itself refute a parallelism claim. CI was green throughout, so
  // this was wall-clock headroom, not a defect.
  //
  // Proved honoured rather than ignored: set REAL_APPLY_TIMEOUT_MS to 1 and
  // every spec carrying it fails naming that value -- the only observation
  // available here that can come back negative.

  it(
    "allows an unsaved-restore conflict over an UNCHANGED disk",
    async () => {
      // Mirrors saveDocumentToDisk exactly: `diskChanged` is the discriminator,
      // not the flag's presence. A blanket block here would refuse every apply
      // after an ordinary restart-with-unsaved-edits.
      getOrCreateDocument(DOC_ID).getMap(Y_MAP_DOCUMENT_META).set(Y_MAP_EXTERNAL_CONFLICT, {
        kind: "unsaved-restore",
        diskChanged: false,
        detectedAt: Date.now(),
      });

      await expect(applyChangesCore(DOC_ID)).resolves.toMatchObject({ applied: 1 });
    },
    REAL_APPLY_TIMEOUT_MS,
  );

  it("refuses when the file was modified outside Tandem since our last write", async () => {
    const before = await onDisk();
    getOrCreateDocument(DOC_ID)
      .getMap(Y_MAP_DOCUMENT_META)
      .set(Y_MAP_SAVED_AT_VERSION, Date.now() - 60_000);
    await fsp.utimes(docPath, new Date(), new Date());

    await expect(applyChangesCore(DOC_ID)).rejects.toMatchObject({ code: "FILE_MODIFIED" });
    expect(await onDisk()).toEqual(before);
  });

  it(
    "does not refuse on mtime drift within the tolerance",
    async () => {
      // Positive control for the guard above: without this, a guard that always
      // threw would satisfy the FILE_MODIFIED test.
      getOrCreateDocument(DOC_ID)
        .getMap(Y_MAP_DOCUMENT_META)
        .set(Y_MAP_SAVED_AT_VERSION, Date.now());

      await expect(applyChangesCore(DOC_ID)).resolves.toMatchObject({ applied: 1 });
    },
    REAL_APPLY_TIMEOUT_MS,
  );

  it(
    "leaves savedAtVersion STALE so a save before the reload is refused",
    async () => {
      // The inverse of every other write path, and deliberate. What lands on disk is
      // tracked-changes markup the Y.Doc cannot represent — mammoth drops revisions on
      // import — so until the watcher's reload the Y.Doc is genuinely older than the
      // file, and an explicit Ctrl+S in that window would export it over the revisions
      // just written. The stale baseline is what makes saveDocumentToDisk refuse.
      const baseline = Date.now() - 60_000;
      const meta = getOrCreateDocument(DOC_ID).getMap(Y_MAP_DOCUMENT_META);
      meta.set(Y_MAP_SAVED_AT_VERSION, baseline);
      // Not a drift refusal: touch the file back to the baseline first, so the apply
      // itself is what moves mtime past it.
      await fsp.utimes(docPath, new Date(baseline), new Date(baseline));

      await expect(applyChangesCore(DOC_ID)).resolves.toMatchObject({ applied: 1 });

      expect(meta.get(Y_MAP_SAVED_AT_VERSION)).toBe(baseline);
      const stat = await fsp.stat(docPath);
      expect(stat.mtimeMs).toBeGreaterThan(baseline + 1000);
    },
    REAL_APPLY_TIMEOUT_MS,
  );

  it(
    "the watcher reload that completes an apply finally lands (#1749) — clean doc",
    async () => {
      // RED before #1749 on EVERY platform, which is the point. `applyChangesCore`
      // carries no `suppressNextChange` and no `recordSelfWrite` BY DESIGN — its
      // own comment says "between this write and the watcher's reload, the Y.Doc
      // is genuinely STALE … The reload re-baselines when it lands." That reload
      // had never landed: the write is a tmp+rename, so it emits only `rename`,
      // and `rename` was dropped at arrival.
      //
      // This is also the REAL gate for the `forbidden` rows in
      // `document-write-rearm.test.ts`. A symmetry-minded fold that adds
      // `rearmWatch` here closes the old inotify handle with the write's own
      // `rename` still queued against it — `uv_fs_event_stop` discards it, there
      // is no replay, and this test goes red in ubuntu `check` while passing on
      // Windows, where `rearmWatch` is a no-op.
      const doc = getOrCreateDocument(DOC_ID);
      const meta = doc.getMap(Y_MAP_DOCUMENT_META);
      const before = extractText(doc);
      const baseline = Date.now() - 60_000;
      meta.set(Y_MAP_SAVED_AT_VERSION, baseline);
      await fsp.utimes(docPath, new Date(baseline), new Date(baseline));

      wireFileWatcher(DOC_ID, docPath, "docx");
      try {
        await expect(applyChangesCore(DOC_ID)).resolves.toMatchObject({ applied: 1 });
        // Immediately after the apply the baseline is deliberately STALE — that
        // is what makes a Ctrl+S in this window refuse.
        expect(meta.get(Y_MAP_SAVED_AT_VERSION)).toBe(baseline);

        await vi.waitFor(
          () => {
            expect(meta.get(Y_MAP_SAVED_AT_VERSION)).not.toBe(baseline);
          },
          { timeout: 20_000, interval: 100 },
        );
        // The Y.Doc stopped being stale: mammoth re-imported the tracked-changes
        // markup this apply wrote.
        expect(extractText(doc)).not.toBe(before);
        // A clean document reloads rather than raising a banner.
        expect(meta.get(Y_MAP_EXTERNAL_CONFLICT)).toBeUndefined();
      } finally {
        unwatchFile(docPath);
      }
    },
    REAL_APPLY_TIMEOUT_MS,
  );

  it(
    "the watcher reload that completes an apply flags a conflict on a DIRTY doc (#1749)",
    async () => {
      // The dirty twin, and a genuine choice rather than a bug: the unsaved
      // Y.Doc edits were not written, and the disk now holds revisions. The
      // banner's "changed on disk" wording reads as external, which is out of
      // scope to reword here.
      const doc = getOrCreateDocument(DOC_ID);
      const meta = doc.getMap(Y_MAP_DOCUMENT_META);
      const before = extractText(doc);
      registerDirtyObserver(DOC_ID, doc);
      markDirty(DOC_ID);

      wireFileWatcher(DOC_ID, docPath, "docx");
      try {
        await expect(applyChangesCore(DOC_ID)).resolves.toMatchObject({ applied: 1 });
        await vi.waitFor(
          () => {
            expect(meta.get(Y_MAP_EXTERNAL_CONFLICT)).toBeDefined();
          },
          { timeout: 20_000, interval: 100 },
        );
        // Flagged, NOT reloaded.
        expect(extractText(doc)).toBe(before);
      } finally {
        unwatchFile(docPath);
        clearDirtyState(DOC_ID);
      }
    },
    REAL_APPLY_TIMEOUT_MS,
  );

  it("reports a source file deleted mid-apply as SOURCE_MISSING, not an fs crash", async () => {
    // An ordinary state (the user moved or deleted the file), so it has to come back
    // as a structured refusal. Unguarded it leaves as a raw ENOENT: an unhandled MCP
    // protocol failure on one side and a 500 logged as "Unhandled API error" with a
    // stack on the other — a Tandem crash report for something Tandem did not do.
    getOrCreateDocument(DOC_ID).getMap(Y_MAP_DOCUMENT_META).set(Y_MAP_SAVED_AT_VERSION, Date.now());
    await fsp.rm(docPath);

    await expect(applyChangesCore(DOC_ID)).rejects.toMatchObject({ code: "SOURCE_MISSING" });
  });

  it(
    "takes a pre-overwrite snapshot, not just the sidecar backup",
    async () => {
      // The `.backup.docx` sidecar lands wherever the CALLER says. The snapshot is
      // the swept, capped, app-data copy every other write path takes.
      await applyChangesCore(DOC_ID);
      const backups = await listDocBackups(docPath, resolveAppDataDir());
      expect(backups.length).toBe(1);
    },
    REAL_APPLY_TIMEOUT_MS,
  );
});

// ---------------------------------------------------------------------------
// applyChangesCore — the backup sidecar
//
// This whole block is new because NOTHING exercised the anti-clobber branch at
// `docx-apply.ts:249-258`. No existing spec creates a pre-existing backup
// destination, so every line of it was unreached, and two defects sat there in
// a file with 46 passing tests.
//
// Each spec was run against the unfixed code and shown red, because a green
// suite is evidence only if a broken version would have looked different — with
// one honest exception. The symlink spec is `runIf(!win32)` and the machine this
// was written on has no symlink privilege, so its red run happened on CI, not
// here. If you change that spec, you cannot verify it locally on Windows.
// ---------------------------------------------------------------------------

describe("applyChangesCore — the backup sidecar", () => {
  let counter = 0;
  let DOC_ID: string;
  let docPath: string;
  let tmpDir: string;

  beforeEach(async () => {
    for (const id of [...getOpenDocs().keys()]) removeDoc(id);
    setActiveDocId(null);

    counter += 1;
    DOC_ID = `backup-test-doc-${counter}`;
    tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "tandem-apply-backup-"));
    docPath = path.join(tmpDir, "doc.docx");
    await fsp.writeFile(
      docPath,
      await createTestDocx(wrapBody("<w:p><w:r><w:t>Hello world</w:t></w:r></w:p>")),
    );

    const doc = getOrCreateDocument(DOC_ID);
    doc.getXmlFragment("default").insert(0, [makeYParagraph("Hello world")]);
    doc.getMap(Y_MAP_ANNOTATIONS).set("a1", {
      id: "a1",
      type: "comment",
      author: "claude",
      status: "accepted",
      range: { from: 0, to: 5 },
      content: "swap it",
      suggestedText: "Howdy",
      textSnapshot: "Hello",
      timestamp: Date.now(),
    });

    addDoc(DOC_ID, {
      id: DOC_ID,
      filePath: docPath,
      format: "docx",
      readOnly: false,
      source: "file",
    });
    setActiveDocId(DOC_ID);
  });

  // Same headroom, same reason as the write-guards block above: these perform a
  // real .docx apply, and without it they fail as timeouts rather than as
  // assertions.

  it(
    "keeps an extensionless backupPath absolute instead of resolving it against cwd",
    async () => {
      // The `slice(0, -0)` bug. `path.extname` returns "" for an extensionless
      // path and `-0 === 0`, so `slice(0, -ext.length)` returned the empty
      // string and the backup name became a bare "-<timestamp>" — RELATIVE, so
      // resolved against the server process cwd, discarding the `path.resolve`
      // sanitizing done on the way in.
      //
      // It reported success either way: the size check downstream stats the
      // file that was actually written, so the sizes always matched. That is
      // what makes this worth a test rather than a glance.
      const backupPath = path.join(tmpDir, "sidecar-no-extension");
      await fsp.writeFile(backupPath, "an earlier backup");

      const strays: string[] = [];
      try {
        const result = await applyChangesCore(DOC_ID, undefined, backupPath);
        expect(
          path.isAbsolute(result.backupPath as string),
          `backup landed at a relative path (${result.backupPath}), which fs.copyFile ` +
            "resolves against the server cwd rather than next to the document",
        ).toBe(true);
        expect(path.dirname(result.backupPath as string)).toBe(tmpDir);
      } finally {
        // In `finally`, not after the assertion: on the red run the assertion
        // throws first and the junk file survives in the repo root, which is
        // the vitest cwd.
        for (const name of await fsp.readdir(process.cwd())) {
          if (/^-\d{10,}/.test(name)) {
            strays.push(name);
            await fsp.rm(path.join(process.cwd(), name), { force: true });
          }
        }
      }
      expect(strays, "the fix must not produce a cwd-relative backup").toEqual([]);
    },
    REAL_APPLY_TIMEOUT_MS,
  );

  it.runIf(process.platform !== "win32")(
    "refuses a symlinked backup destination instead of writing through it",
    async () => {
      // The write-through. `fs.access` follows symlinks, so a DANGLING link at
      // the destination reported ENOENT, took the "no existing backup" branch,
      // and `fs.copyFile` — which opens O_WRONLY|O_CREAT|O_TRUNC — created the
      // target and filled it with the user document.
      //
      // POSIX-only, and worth being blunt: the ubuntu `check` job is the only
      // leg that runs this, so Windows has no coverage of it at all. Creating a
      // symlink on Windows needs a privilege the dev machine lacks.
      const target = path.join(tmpDir, "attacker-chosen.txt");
      const link = path.join(tmpDir, "doc.backup.docx");
      await fsp.symlink(target, link);

      await expect(applyChangesCore(DOC_ID)).rejects.toMatchObject({ code: "BACKUP_SYMLINK" });
      await expect(
        fsp.access(target),
        "the symlink target was created, so the copy wrote through the link",
      ).rejects.toMatchObject({ code: "ENOENT" });
    },
    REAL_APPLY_TIMEOUT_MS,
  );

  it(
    "retries a colliding backup name a bounded number of times, without compounding",
    async () => {
      // The old code passed no COPYFILE_EXCL, so EEXIST could not arise from a
      // real filesystem, and the uniquified name embeds Date.now() so it cannot
      // be pre-created either. A spy is the only way to reach this path.
      //
      // Asserting only the terminal BACKUP_FAILED would be satisfied whether or
      // not the retry compounds — which is the actual hazard, since recomputing
      // from an already-uniquified name walks toward ENAMETOOLONG, not an
      // EEXIST, and would escape raw. So assert the destinations.
      const dests: string[] = [];
      const modes: (number | undefined)[] = [];
      const spy = vi.spyOn(fsp, "copyFile").mockImplementation(async (_src, dest, mode) => {
        dests.push(String(dest));
        modes.push(mode);
        throw Object.assign(new Error("EEXIST"), { code: "EEXIST" });
      });
      try {
        await expect(applyChangesCore(DOC_ID)).rejects.toMatchObject({ code: "BACKUP_FAILED" });
      } finally {
        spy.mockRestore();
      }

      expect(dests.length, "the retry must be bounded").toBe(5);
      for (const dest of dests) {
        expect(path.dirname(dest)).toBe(tmpDir);
        expect(
          path.basename(dest),
          `retry compounded onto an already-uniquified name (${dest}) instead of ` +
            "recomputing from the original base",
        ).toMatch(/^doc\.backup(-\d+-[0-9a-f]{8})?\.docx$/);
      }
      expect(new Set(dests).size, "a bare Date.now() collides within one millisecond").toBe(5);

      // Capture the mode, or this whole spec is satisfied by code that does not
      // pass COPYFILE_EXCL at all: a spy that throws EEXIST unconditionally
      // produces the retry sequence either way. COPYFILE_EXCL is what makes the
      // check-then-act atomic -- without it the lstat above only narrows the
      // race, and nothing here would notice it being deleted.
      for (const mode of modes) {
        expect(
          (mode ?? 0) & fs.constants.COPYFILE_EXCL,
          "copyFile was called without COPYFILE_EXCL, so the backup write is a " +
            "check-then-act again and a symlink planted after the lstat is followed",
        ).toBe(fs.constants.COPYFILE_EXCL);
      }
    },
    REAL_APPLY_TIMEOUT_MS,
  );
});

// ---------------------------------------------------------------------------
// applyChangesCore — deriving the originating Word comment id (#1682)
//
// The `resolveWordComments` block far above is thorough about the CONSUMER, and
// every one of its specs hand-writes `importCommentId: "42"` onto the
// suggestion. That is exactly why the producer could be dead for five releases
// without a red test: `src/server/mcp/docx-apply.ts` parsed the comment id out
// of `ann.id` in a `import-{commentId}-{timestamp}` shape the ids stopped using
// at #337, so `lastIndexOf("-")` was -1 and the field was ALWAYS undefined.
//
// So these specs build their input from the real producers — the annotation is
// minted by `injectCommentsAsAnnotations` (which mints the id through
// `importAnnotationId` and writes `importSource`) — and assert the field the
// code under test DERIVES, never one they set.
// ---------------------------------------------------------------------------

describe("applyChangesCore — the originating Word comment", () => {
  const COMMENT_ID = "42";
  const COMMENT_BODY = "Reword this greeting.";
  const ANCHOR_PARA_ID = "AAAA1111";
  const LAST_PARA_ID = "BBBB2222";

  let counter = 0;
  let DOC_ID: string;
  let docPath: string;

  /**
   * A .docx carrying one Word comment whose body is two paragraphs, so the
   * resolution assertion can name the LAST paraId and be wrong if the pass
   * resolved something else.
   */
  function createTestDocxWithComment(): Promise<Buffer> {
    return createTestDocx(wrapBody("<w:p><w:r><w:t>Hello world</w:t></w:r></w:p>"), {
      "word/comments.xml": commentsXml([
        { id: COMMENT_ID, paraIds: [ANCHOR_PARA_ID, LAST_PARA_ID] },
      ]),
    });
  }

  beforeEach(async () => {
    for (const id of [...getOpenDocs().keys()]) removeDoc(id);
    setActiveDocId(null);

    counter += 1;
    DOC_ID = `import-resolve-doc-${counter}`;
    docPath = path.join(
      await fsp.mkdtemp(path.join(os.tmpdir(), "tandem-apply-import-")),
      "doc.docx",
    );
    await fsp.writeFile(docPath, await createTestDocxWithComment());

    getOrCreateDocument(DOC_ID)
      .getXmlFragment("default")
      .insert(0, [makeYParagraph("Hello world")]);

    addDoc(DOC_ID, {
      id: DOC_ID,
      filePath: docPath,
      format: "docx",
      readOnly: false,
      source: "file",
    });
    setActiveDocId(DOC_ID);
  });

  /** The `word/commentsExtended.xml` of whatever is on disk now, or undefined. */
  async function savedCommentsExtended(): Promise<string | undefined> {
    const zip = await JSZip.loadAsync(await fsp.readFile(docPath));
    return zip.file("word/commentsExtended.xml")?.async("text");
  }

  it(
    "marks the imported Word comment done after its promoted suggestion is applied",
    async () => {
      const doc = getOrCreateDocument(DOC_ID);

      // PRODUCER, not a hand-built id: this is the same call `openFromDisk`
      // makes, so the record's key and its `importSource` are whatever the real
      // import writes.
      const injected = injectCommentsAsAnnotations(
        doc,
        [
          {
            commentId: COMMENT_ID,
            authorName: "Reviewer",
            bodyText: COMMENT_BODY,
            from: toFlatOffset(0),
            to: toFlatOffset(5),
          },
        ],
        "doc.docx",
      );
      expect(injected).toBe(1);

      const map = doc.getMap(Y_MAP_ANNOTATIONS);
      const entries = [...(map as Iterable<[string, Annotation]>)];
      expect(entries.length).toBe(1);
      const [importedId, note] = entries[0];

      // The discriminating precondition. Without these two the spec would still
      // pass against a build whose ids had gone back to a parseable shape, and
      // it would no longer be testing the thing that broke.
      expect(importedId).toBe(importAnnotationId(COMMENT_ID, 0, 5, COMMENT_BODY));
      expect(
        importedId.slice("import-".length),
        "a post-#337 id is a bare hash — the deleted parse needed a dash here",
      ).not.toContain("-");
      expect(note.importSource?.commentId).toBe(COMMENT_ID);

      // **The REAL promotion, not a hand-built copy of it.** `sendNoteToClaude`
      // is what the Send-to-Claude button calls, and it is the step that has to
      // carry `importSource` through. A spec that mirrors `promotedAnnotation`'s
      // field list instead would keep carrying the field itself, so it would
      // stay green on the day promotion stopped carrying it — the correspondence
      // bug this whole issue is an instance of.
      sendNoteToClaude(doc, importedId);
      const promoted = map.get(importedId) as Annotation;
      expect(promoted.type, "the promotion actually ran").toBe("comment");
      expect(promoted.importSource?.commentId, "and it carried the Word comment id through").toBe(
        COMMENT_ID,
      );

      // Claude attaches a suggestion and the user accepts. Neither touches
      // `importSource`.
      map.set(importedId, {
        ...promoted,
        status: "accepted" as const,
        suggestedText: "Howdy",
        textSnapshot: "Hello",
      });

      await expect(applyChangesCore(DOC_ID)).resolves.toMatchObject({
        applied: 1,
        commentsResolved: 1,
      });

      const extXml = await savedCommentsExtended();
      expect(extXml).toBeDefined();
      // The comment's OWN last body paragraph, not its document anchor.
      expect(extXml).toContain(`w15:paraId="${LAST_PARA_ID}"`);
      expect(extXml).not.toContain(ANCHOR_PARA_ID);
      expect(extXml).toContain('w15:done="1"');
    },
    REAL_APPLY_TIMEOUT_MS,
  );

  it(
    "resolves nothing for an accepted suggestion that carries no importSource",
    async () => {
      // Negative control. An ordinary Claude comment on the same document, with
      // the same .docx underneath it — so a build that manufactured a comment id
      // from somewhere other than the record would light this up.
      getOrCreateDocument(DOC_ID)
        .getMap(Y_MAP_ANNOTATIONS)
        .set("a1", {
          id: "a1",
          type: "comment",
          author: "claude",
          status: "accepted",
          range: { from: 0, to: 5 },
          content: "swap it",
          suggestedText: "Howdy",
          textSnapshot: "Hello",
          timestamp: Date.now(),
        });

      // `commentsResolved: 0` alone is a weak control: `resolveWordComments`
      // also returns 0 when it DID carry an id and simply failed to match one
      // in comments.xml. The warn at `file-io/docx-apply.ts`'s "No
      // comment-paragraph id" is the only observable that separates "never
      // attempted" from "attempted and missed", so spy on it rather than
      // inferring from the count.
      //
      // (An earlier draft justified this with an `import-reply-<hash>` id,
      // whose old parse yielded the literal "reply". The arithmetic is right
      // and the case is unreachable: `importReplyId` mints those only for
      // records in `Y_MAP_ANNOTATION_REPLIES`, and this loop walks
      // `Y_MAP_ANNOTATIONS`. The control is right; that reason for it was not.)
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      try {
        await expect(applyChangesCore(DOC_ID)).resolves.toMatchObject({
          applied: 1,
          commentsResolved: 0,
        });
        expect(
          warn.mock.calls.filter((c) => String(c[0]).includes("No comment-paragraph id")),
        ).toEqual([]);
      } finally {
        warn.mockRestore();
      }

      // Nothing was marked done, and the part was not created just to say so.
      expect(await savedCommentsExtended()).toBeUndefined();
    },
    REAL_APPLY_TIMEOUT_MS,
  );
});

// ---------------------------------------------------------------------------
// #1754 — tabbed documents apply, and the span fence
// ---------------------------------------------------------------------------

/** Re-read `word/document.xml` out of an apply's produced buffer. */
async function producedDocumentXml(buffer: Buffer): Promise<string> {
  const zip = await JSZip.loadAsync(buffer);
  const xml = await zip.file("word/document.xml")?.async("text");
  if (!xml) throw new Error("produced buffer has no word/document.xml");
  return xml;
}

/** Two declared tab STOPS — the shape the walker used to count as characters. */
const TAB_STOPS =
  `<w:pPr><w:tabs><w:tab w:val="left" w:pos="720"/>` +
  `<w:tab w:val="right" w:pos="9000"/></w:tabs></w:pPr>`;

describe("applyTrackedChanges on tab/break/symbol documents (#1754)", () => {
  it("applies cleanly to a tabbed document and leaves the tab in the output", async () => {
    // The issue's headline: this used to throw "Flat text mismatch" outright.
    // `applied === 1` is NOT an acceptable assertion here — it is green on the
    // very output that destroys the tab — so the produced bytes are re-walked.
    const xml = wrapBody(
      `<w:p>${TAB_STOPS}` +
        `<w:r><w:t>Name</w:t></w:r><w:r><w:tab/></w:r><w:r><w:t>Value</w:t></w:r></w:p>`,
    );
    const docxBuffer = await createTestDocx(xml);

    const output = await applyTrackedChanges(
      docxBuffer,
      [{ id: "s1", from: 0, to: 4, newText: "NEW" }],
      { author: "Test", ydocFlatText: "Name\tValue" },
    );

    expect(output.applied).toBe(1);
    expect(output.rejectedDetails).toEqual([]);
    const produced = await producedDocumentXml(output.buffer);
    expect(walkDocumentBody(produced).flatText).toBe("NEW\tValue");
  });

  it("REFUSES the single-run twin, which offset overlap alone lets through", async () => {
    // `applySingleSuggestion` destroys whole <w:r> elements, so a suggestion
    // over `Name` in a run that also holds the tab and `Value` would delete all
    // three. [0,4) does not overlap the tab's [4,5) span at all — only the
    // run-keyed predicate can see this.
    const xml = wrapBody(
      `<w:p>${TAB_STOPS}<w:r><w:t>Name</w:t><w:tab/><w:t>Value</w:t></w:r></w:p>`,
    );
    const docxBuffer = await createTestDocx(xml);

    const output = await applyTrackedChanges(
      docxBuffer,
      [{ id: "s1", from: 0, to: 4, newText: "NEW" }],
      { author: "Test", ydocFlatText: "Name\tValue" },
    );

    expect(output.applied).toBe(0);
    expect(output.rejectedDetails.some((r) => r.id === "s1" && r.reason.includes("tab"))).toBe(
      true,
    );
    const produced = await producedDocumentXml(output.buffer);
    expect(produced).toContain("<w:tab/>");
    expect(produced).toContain("Value");
  });

  it("a page-break document still throws, and the message names #1754", async () => {
    const xml = wrapBody(`<w:p><w:r><w:t>A</w:t><w:br w:type="page"/><w:t>B</w:t></w:r></w:p>`);
    const docxBuffer = await createTestDocx(xml);
    await expect(
      applyTrackedChanges(docxBuffer, [{ id: "s1", from: 0, to: 1, newText: "X" }], {
        author: "Test",
        ydocFlatText: "AB",
      }),
    ).rejects.toThrow(/#1754/);
  });
});

describe("the special-character span fence (#1754)", () => {
  /** Assert the fixture passes the flat-text guard, or a green means nothing. */
  function assertGuardPasses(xml: string, expected: string): void {
    expect(walkDocumentBody(xml).flatText).toBe(expected);
  }

  const SEPARATE_RUN_TAB = `<w:p><w:r><w:t>alpha</w:t></w:r><w:r><w:tab/></w:r><w:r><w:t>beta</w:t></w:r></w:p>`;
  const TRACKED_INS_TAB =
    `<w:p><w:r><w:t>alpha</w:t></w:r>` +
    `<w:ins w:id="90" w:author="X" w:date="2020-01-01T00:00:00Z"><w:r><w:tab/></w:r></w:ins>` +
    `<w:r><w:t>beta</w:t></w:r></w:p>`;
  /**
   * A second, tab-free paragraph so the sibling suggestion does not OVERLAP the
   * spanning one — the pre-existing overlap guard would reject it first, for a
   * reason that has nothing to do with this fence.
   */
  const SIBLING_PARAGRAPH = `<w:p><w:r><w:t>gamma</w:t></w:r></w:p>`;

  it.each([
    ["a tab in its own run", SEPARATE_RUN_TAB],
    ["a tab inside <w:ins>, at depth", TRACKED_INS_TAB],
  ])("rejects a suggestion spanning %s while a sibling still applies", async (_label, body) => {
    const xml = wrapBody(body + SIBLING_PARAGRAPH);
    assertGuardPasses(xml, "alpha\tbeta\ngamma");
    const docxBuffer = await createTestDocx(xml);

    const output = await applyTrackedChanges(
      docxBuffer,
      [
        { id: "spanning", from: 0, to: 10, newText: "X" },
        { id: "sibling", from: 11, to: 16, newText: "GAMMA" },
      ],
      { author: "Test", ydocFlatText: "alpha\tbeta\ngamma" },
    );

    expect(output.rejectedDetails.some((r) => r.id === "spanning")).toBe(true);
    // Per-suggestion rejection is the point.
    expect(output.rejectedDetails.some((r) => r.id === "sibling")).toBe(false);
    expect(output.applied).toBe(1);
  });

  // The ONLY cases that discriminate the interval. A closed-interval test would
  // pass every straddling fixture above identically while silently refusing
  // ordinary adjacent suggestions on any tabbed document.
  it.each([
    ["a suggestion ending exactly at the tab", 0, 5, "ALPHA"],
    ["a suggestion starting exactly at the tab's end", 6, 10, "BETA"],
  ])("applies %s", async (_label, from, to, newText) => {
    const xml = wrapBody(SEPARATE_RUN_TAB);
    assertGuardPasses(xml, "alpha\tbeta");
    const docxBuffer = await createTestDocx(xml);

    const output = await applyTrackedChanges(docxBuffer, [{ id: "s1", from, to, newText }], {
      author: "Test",
      ydocFlatText: "alpha\tbeta",
    });

    expect(output.rejectedDetails).toEqual([]);
    expect(output.applied).toBe(1);
    expect(await producedDocumentXml(output.buffer)).toContain("<w:tab/>");
  });

  // The two elements Fix 1 itself turns ZERO-WIDTH. The flat-text guard refused
  // their documents before; it now admits them, and a zero-length span can never
  // satisfy `from < offsetStart + 0` for a suggestion starting at or after it.
  it("rejects a suggestion spanning an unmapped w:sym in its own run", async () => {
    const xml = wrapBody(
      `<w:p><w:r><w:t>alpha</w:t></w:r>` +
        `<w:r><w:sym w:font="Wingdings" w:char="ZZ"/></w:r>` +
        `<w:r><w:t>beta</w:t></w:r></w:p>`,
    );
    assertGuardPasses(xml, "alphabeta");
    const docxBuffer = await createTestDocx(xml);

    const output = await applyTrackedChanges(
      docxBuffer,
      [{ id: "s1", from: 0, to: 9, newText: "X" }],
      { author: "Test", ydocFlatText: "alphabeta" },
    );

    expect(output.applied).toBe(0);
    expect(output.rejectedDetails.some((r) => r.id === "s1" && r.reason.includes("symbol"))).toBe(
      true,
    );
  });

  it("rejects a suggestion merely SHARING a run with an unmapped w:sym", async () => {
    // Only the run-keyed predicate REACHES this one: a zero-length span at
    // offset 5 can never satisfy `from < 5 + 0 && to > 5` for `[0,5)`. The
    // measured code does refuse it anyway further down ("No runs found in
    // deletion range", because `to` lands at the start of the same run) — a
    // fail-closed accident, not the fence — so the assertion below is on the
    // REASON, which is what discriminates the two.
    const xml = wrapBody(
      `<w:p><w:r><w:t>alpha</w:t><w:sym w:font="Wingdings" w:char="ZZ"/><w:t>beta</w:t></w:r></w:p>`,
    );
    assertGuardPasses(xml, "alphabeta");
    const docxBuffer = await createTestDocx(xml);

    const output = await applyTrackedChanges(
      docxBuffer,
      [{ id: "s1", from: 0, to: 5, newText: "X" }],
      { author: "Test", ydocFlatText: "alphabeta" },
    );

    expect(output.applied).toBe(0);
    expect(output.rejectedDetails.some((r) => r.id === "s1" && r.reason.includes("symbol"))).toBe(
      true,
    );
    expect(await producedDocumentXml(output.buffer)).toContain("beta");
  });

  it("applies a suggestion ending at the START of a tab-bearing run", async () => {
    // Review round 1. `buildOffsetMap` resolves an exclusive `to` into the START
    // of the next hit, so `to = 5` lands at charIndex 0 of the run that also
    // carries the trailing tab — a table-of-contents line's exact shape. The
    // apply's own step 3 breaks BEFORE that run, so it was never at risk;
    // keying the fence on the unfiltered touched-run set refused it anyway,
    // which is the residual of the false refusal #1754 exists to remove.
    const xml = wrapBody(
      `<w:p><w:r><w:t>alpha</w:t></w:r>` +
        `<w:r><w:t>beta</w:t><w:tab/></w:r>` +
        `<w:r><w:t>gamma</w:t></w:r></w:p>`,
    );
    assertGuardPasses(xml, "alphabeta\tgamma");
    const docxBuffer = await createTestDocx(xml);

    const output = await applyTrackedChanges(
      docxBuffer,
      [{ id: "s1", from: 0, to: 5, newText: "NEW" }],
      { author: "Test", ydocFlatText: "alphabeta\tgamma" },
    );

    expect(output.rejectedDetails).toEqual([]);
    expect(output.applied).toBe(1);
    // Re-walked, not asserted off `applied`: the tab and the run that holds it
    // must both survive untouched.
    expect(walkDocumentBody(await producedDocumentXml(output.buffer)).flatText).toBe(
      "NEWbeta\tgamma",
    );
  });

  it("REFUSES a suggestion whose runs are nested in a <w:hyperlink>", async () => {
    // Review round 1, and a corruption rather than a refusal if it gets through:
    // `collectTouchedRuns` scans paragraph-DIRECT children, so a hyperlinked run
    // yields an EMPTY set — both halves of the fence go inert without saying so,
    // and `splitRun`'s `indexOf(run) === -1` then splices the remainder run to
    // the FRONT of the paragraph while truncating the hyperlink's own text.
    // Newly reachable: before the tab fix this document died on the flat-text
    // guard instead.
    const xml = wrapBody(
      `<w:p><w:r><w:tab/></w:r>` +
        `<w:hyperlink r:id="rId4"><w:r><w:t>Example Site</w:t></w:r></w:hyperlink></w:p>`,
    );
    assertGuardPasses(xml, "\tExample Site");
    const docxBuffer = await createTestDocx(xml);

    const output = await applyTrackedChanges(
      docxBuffer,
      [{ id: "s1", from: 9, to: 13, newText: "NEW" }],
      { author: "Test", ydocFlatText: "\tExample Site" },
    );

    expect(output.applied).toBe(0);
    expect(output.rejectedDetails.some((r) => r.id === "s1" && r.reason.includes("nested"))).toBe(
      true,
    );
    // The whole point: the paragraph is byte-for-byte intact, tab included.
    const produced = await producedDocumentXml(output.buffer);
    expect(walkDocumentBody(produced).flatText).toBe("\tExample Site");
    expect(produced).toContain("<w:tab/>");
    expect(produced).not.toContain("<w:del ");
  });
});

// ---------------------------------------------------------------------------
// #1755 — the scope pin: applyChanges must NOT gain the image refusal
// ---------------------------------------------------------------------------

describe("applyTrackedChanges on an image-bearing .docx (#1755)", () => {
  it("still applies, and the picture is still in the output package", async () => {
    // `file-io/docx-apply.ts` edits the ORIGINAL word/document.xml in place and
    // re-zips, so the pictures survive it. Adding `tandem_save`'s refusal here
    // "for consistency" would break the one write path that preserves them.
    const { buildEmbeddedImageWithText } = await import("../helpers/docx-corpus.js");
    const docxBuffer = await buildEmbeddedImageWithText();
    const documentXml = await producedDocumentXml(docxBuffer);
    const flat = walkDocumentBody(documentXml).flatText;
    const from = flat.indexOf("Hello");
    expect(from).toBeGreaterThanOrEqual(0);
    // `ydocFlatText` below is the walker's own answer, so assert it is also the
    // REAL import's — otherwise the flat-text guard is satisfied trivially and
    // the fixture proves nothing about a genuine image-bearing document.
    const importDoc = new Y.Doc();
    const html = await loadDocx(docxBuffer);
    withInternal(importDoc, () => htmlToYDoc(importDoc, html));
    expect(flat).toBe(extractText(importDoc));
    importDoc.destroy();

    const output = await applyTrackedChanges(
      docxBuffer,
      [{ id: "s1", from, to: from + 5, newText: "Goodbye" }],
      { author: "Test", ydocFlatText: flat },
    );

    expect(output.applied).toBe(1);
    expect(output.rejectedDetails).toEqual([]);
    const zip = await JSZip.loadAsync(output.buffer);
    expect(Object.keys(zip.files).some((f) => f.startsWith("word/media/"))).toBe(true);
  });
});
