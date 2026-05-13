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
