#!/usr/bin/env node
/**
 * Reproducible generator for the reviewer-comments .docx E2E fixture.
 *
 * Builds a minimal OOXML `.docx` zip containing one or more `<w:comment>`
 * elements anchored to short text ranges. The comment XML mirrors the helper
 * `tests/helpers/docx-fixtures.ts#buildDocxWithComments(N)` and the synthetic
 * documents constructed in `tests/server/docx-comments.test.ts`, so the
 * fixture's import behavior matches the deterministic server-side tests.
 *
 * Output: a committed binary fixture under `tests/e2e/fixtures/` consumed by
 * `tests/e2e/batch-promote.spec.ts` (AR5-T4). Regenerate with:
 *
 *   node scripts/fixtures/make-reviewer-docx.mjs
 *
 * The generator is deterministic: a fixed zip mtime means re-running it only
 * rewrites byte-identical content. Commit the result.
 */
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..", "..");
const OUTPUT_PATH = path.join(REPO_ROOT, "tests", "e2e", "fixtures", "reviewer-comments.docx");

/** How many reviewer comments to embed in the fixture. */
const COMMENT_COUNT = 2;

/**
 * Build a minimal `.docx` Buffer carrying `commentCount` inline Word comments.
 *
 * Mirrors `buildDocxWithComments` in `tests/helpers/docx-fixtures.ts`, but adds
 * the structural parts (`[Content_Types].xml`, `_rels/.rels`,
 * `word/_rels/document.xml.rels`) so the archive is a well-formed package that
 * the file-open flow accepts rather than a bare two-file zip.
 */
async function buildReviewerDocx(commentCount) {
  const JSZip = (await import("jszip")).default;
  const zip = new JSZip();

  const runs = [];
  const commentEls = [];
  for (let i = 1; i <= commentCount; i++) {
    runs.push(
      `<w:commentRangeStart w:id="${i}"/>` +
        `<w:r><w:t>Word${i}</w:t></w:r>` +
        `<w:commentRangeEnd w:id="${i}"/>` +
        `<w:r><w:t> spacer </w:t></w:r>`,
    );
    commentEls.push(
      `<w:comment w:id="${i}" w:author="Reviewer${i}" w:date="2026-01-01T00:00:00Z">` +
        `<w:p><w:r><w:t>Body of comment ${i}</w:t></w:r></w:p>` +
        `</w:comment>`,
    );
  }

  zip.file(
    "[Content_Types].xml",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
      `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
      `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>` +
      `<Default Extension="xml" ContentType="application/xml"/>` +
      `<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>` +
      `<Override PartName="/word/comments.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.comments+xml"/>` +
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
    "word/_rels/document.xml.rels",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
      `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
      `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/comments" Target="comments.xml"/>` +
      `</Relationships>`,
  );

  zip.file(
    "word/document.xml",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
      `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">` +
      `<w:body><w:p>${runs.join("")}</w:p></w:body>` +
      `</w:document>`,
  );

  zip.file(
    "word/comments.xml",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
      `<w:comments xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">` +
      `${commentEls.join("")}` +
      `</w:comments>`,
  );

  // Fixed mtime keeps the generated archive reproducible across runs.
  return zip.generateAsync({
    type: "nodebuffer",
    date: new Date("2026-01-01T00:00:00Z"),
  });
}

async function main() {
  const buf = await buildReviewerDocx(COMMENT_COUNT);
  await mkdir(path.dirname(OUTPUT_PATH), { recursive: true });
  await writeFile(OUTPUT_PATH, buf);
  console.log(`Wrote ${OUTPUT_PATH} (${buf.length} bytes, ${COMMENT_COUNT} reviewer comments)`);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
