/**
 * #2266 — files DERIVED from a document take the document's group/other bits
 * as a ceiling: `0o600 | (source & 0o066)`. The owner keeps read/write; group
 * and other get no more than the source gives them.
 *
 * Driven end to end through the two writers that apply it — the
 * `tandem_exportAnnotations` sidecar (live) and `convertToMarkdown` (dark under
 * `DOCX_ENABLED`, kept consistent) — rather than through
 * `derivedFileModeCeiling` alone, because a ceiling computed and then not
 * passed to `atomicWrite` is exactly the regression worth catching. The unit
 * table for the helper is in `tests/server/file-io/atomic-write-mode.test.ts`.
 *
 * POSIX only: on Windows mode bits carry no access control and no ceiling is
 * applied.
 */

import { statSync } from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { addDoc, removeDoc, setActiveDocId } from "../../src/server/documents/registry-testing.js";
import { registerAnnotationTools } from "../../src/server/mcp/annotations.js";
import { convertToMarkdown } from "../../src/server/mcp/convert.js";
import { populateYDoc } from "../../src/server/mcp/document.js";
import { getOpenDocs } from "../../src/server/mcp/document-service.js";
import { getOrCreateDocument } from "../../src/server/yjs/provider.js";
import { setupMcpServer } from "../helpers/mcp-harness.js";

const CASES = [
  { source: 0o444, expected: 0o644 },
  { source: 0o400, expected: 0o600 },
  { source: 0o640, expected: 0o640 },
  { source: 0o600, expected: 0o600 },
] as const;

function modeOf(p: string): number {
  return statSync(p).mode & 0o777;
}

describe.skipIf(process.platform === "win32")("derived files take the source's ceiling", () => {
  let savedUmask: number;
  let base: string;
  let counter = 0;

  beforeEach(async () => {
    savedUmask = process.umask(0o022);
    base = await fsp.mkdtemp(path.join(os.tmpdir(), "tandem-derived-modes-"));
    for (const id of [...getOpenDocs().keys()]) removeDoc(id);
    setActiveDocId(null);
    counter += 1;
  });

  afterEach(async () => {
    process.umask(savedUmask);
    for (const id of [...getOpenDocs().keys()]) removeDoc(id);
    setActiveDocId(null);
    await fsp.rm(base, { recursive: true, force: true });
  });

  /** A real source file at `mode`, registered as an open document. */
  async function openSource(
    ext: "md" | "docx",
    mode: number,
  ): Promise<{ id: string; file: string }> {
    const id = `derived-${ext}-${counter}-${mode.toString(8)}`;
    const file = path.join(base, `${id}.${ext}`);
    await fsp.writeFile(file, "Hello world");
    await fsp.chmod(file, mode);
    populateYDoc(getOrCreateDocument(id), "Hello world");
    addDoc(id, { id, filePath: file, format: ext, readOnly: false, source: "file" });
    setActiveDocId(id);
    return { id, file };
  }

  it.each(CASES)("the annotation sidecar of a $source source is $expected", async (c) => {
    const { file } = await openSource("md", c.source);
    const { client, close } = await setupMcpServer([registerAnnotationTools]);
    try {
      const result = (await client.callTool({
        name: "tandem_exportAnnotations",
        arguments: { format: "json", writeToDisk: true },
      })) as { content: Array<{ type: string; text?: string }> };
      const text = result.content.find((x) => x.type === "text")?.text ?? "{}";
      const written = (JSON.parse(text).data as { writtenPath?: string } | undefined)?.writtenPath;
      expect(written, `export failed: ${text}`).toBe(`${file}.annotations.json`);
      expect(modeOf(written as string)).toBe(c.expected);
    } finally {
      await close();
    }
  });

  it.each(CASES)("the convert output of a $source source is $expected", async (c) => {
    const { id } = await openSource("docx", c.source);
    const result = await convertToMarkdown(id);
    expect(modeOf(result.outputPath)).toBe(c.expected);
  });

  it("an existing sidecar wider than the ceiling is narrowed on overwrite", async () => {
    const { file } = await openSource("md", 0o600);
    const sidecar = `${file}.annotations.json`;
    await fsp.writeFile(sidecar, "{}");
    await fsp.chmod(sidecar, 0o644);

    const { client, close } = await setupMcpServer([registerAnnotationTools]);
    try {
      await client.callTool({
        name: "tandem_exportAnnotations",
        arguments: { format: "json", writeToDisk: true },
      });
    } finally {
      await close();
    }

    expect(modeOf(sidecar)).toBe(0o600);
  });
});
