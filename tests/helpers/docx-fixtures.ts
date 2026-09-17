/**
 * Synthetic .docx Buffer with N inline Word comments anchored to short text
 * ranges. Used by the file-opener batching/cleanup test suites.
 */
export async function buildDocxWithComments(commentCount: number): Promise<Buffer> {
  const JSZip = (await import("jszip")).default;
  const zip = new JSZip();

  const runs: string[] = [];
  const commentEls: string[] = [];
  for (let i = 1; i <= commentCount; i++) {
    runs.push(
      `<w:commentRangeStart w:id="${i}"/>` +
        `<w:r><w:t>Word${i}</w:t></w:r>` +
        `<w:commentRangeEnd w:id="${i}"/>` +
        `<w:r><w:t> spacer </w:t></w:r>`,
    );
    commentEls.push(
      `<w:comment w:id="${i}" w:author="Author${i}" w:date="2026-01-01T00:00:00Z">` +
        `<w:p><w:r><w:t>Body of comment ${i}</w:t></w:r></w:p>` +
        `</w:comment>`,
    );
  }

  zip.file(
    "word/document.xml",
    `<?xml version="1.0"?>` +
      `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">` +
      `<w:body><w:p>${runs.join("")}</w:p></w:body>` +
      `</w:document>`,
  );
  zip.file(
    "word/comments.xml",
    `<?xml version="1.0"?>` +
      `<w:comments xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">` +
      `${commentEls.join("")}` +
      `</w:comments>`,
  );

  return (await zip.generateAsync({ type: "nodebuffer" })) as Buffer;
}

/**
 * Sibling of {@link buildDocxWithComments} for the id-sensitive suites (#1693):
 * one Word comment per SUPPLIED `w:id` string, rather than `1..N`.
 *
 * The count-based helper hard-codes `w:id="${i}"`, so running it verbatim tests
 * canonical ids only and is green on unfixed code. It is left untouched — its
 * callers depend on the exact document it builds.
 *
 * Deliberate differences from that helper, each load-bearing for the offset pin
 * in `docx-comment-id-roundtrip.test.ts`:
 *   - **no ` spacer ` run.** That run carries leading and trailing whitespace a
 *     markdown round trip normalises, and the pin is an equality across exactly
 *     that round trip.
 *   - single paragraph, plain text, no leading or trailing whitespace, and no
 *     `w:tab` / `w:br` / `w:sym` — the three elements whose flat-text width the
 *     `.docx` walker maps per-element. The pin is an offset-STABILITY check,
 *     not a check on that mapping (`docx-walker.test.ts` owns that).
 *
 * Asserts before returning that every requested `w:id` reached
 * `word/comments.xml` verbatim, so a fixture that silently mangled a hostile id
 * fails here rather than as a confusing assertion three layers down.
 */
export async function buildDocxWithCommentIds(ids: readonly string[]): Promise<Buffer> {
  const JSZip = (await import("jszip")).default;
  const zip = new JSZip();

  const esc = (v: string): string =>
    v.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

  const runs: string[] = [];
  const commentEls: string[] = [];
  ids.forEach((id, index) => {
    const label = `Word${index + 1}`;
    runs.push(
      `<w:commentRangeStart w:id="${esc(id)}"/>` +
        `<w:r><w:t>${label}</w:t></w:r>` +
        `<w:commentRangeEnd w:id="${esc(id)}"/>`,
    );
    commentEls.push(
      `<w:comment w:id="${esc(id)}" w:author="Author${index + 1}" w:date="2026-01-01T00:00:00Z">` +
        `<w:p><w:r><w:t>Body of comment ${index + 1}</w:t></w:r></w:p>` +
        `</w:comment>`,
    );
  });

  const commentsXml =
    `<?xml version="1.0"?>` +
    `<w:comments xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">` +
    `${commentEls.join("")}` +
    `</w:comments>`;

  for (const id of ids) {
    if (!commentsXml.includes(`w:id="${esc(id)}"`)) {
      throw new Error(`buildDocxWithCommentIds: w:id "${id}" did not reach comments.xml`);
    }
  }

  zip.file(
    "word/document.xml",
    `<?xml version="1.0"?>` +
      `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">` +
      `<w:body><w:p>${runs.join("")}</w:p></w:body>` +
      `</w:document>`,
  );
  zip.file("word/comments.xml", commentsXml);

  return (await zip.generateAsync({ type: "nodebuffer" })) as Buffer;
}
