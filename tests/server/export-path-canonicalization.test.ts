/**
 * The post-`realpath` prefix re-check, on the path it was never running on.
 *
 * `convert.ts` and `annotations.ts` both canonicalize a caller-supplied
 * `outputPath` with `fs.realpath` and then re-screen the result for UNC and
 * `\\?\` prefixes — a symlinked export directory is legitimate, and following
 * it is the point. Both then swallowed the `ENOENT` that `realpath` throws when
 * the LEAF does not exist yet, which is the normal case for an export. So the
 * re-check ran on overwrite and never on create-new: the branch the guard
 * exists for was the branch it skipped. CodeQL alert 94 is `convert.ts:119`.
 *
 * These specs pin the create-new path. The discriminator is a **symlinked
 * parent with a missing leaf**, deliberately not a Windows junction: a
 * Windows-gated `describe` that no Windows job runs is green forever and reads
 * exactly like a pass (#1529), and the only Windows job is `windows-acl-proof`,
 * whose script requires each named describe to be registered with it.
 *
 * `runIf(!win32)` for the symlink half, so ubuntu's `check` is what runs it.
 * The non-symlink controls below run everywhere and exist so a broken fixture
 * cannot be mistaken for a fixed defect — if the plain case stopped returning a
 * path at all, the symlink assertions would be comparing two absences.
 */

import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { beforeEach, describe, expect, it } from "vitest";
import { addDoc, removeDoc, setActiveDocId } from "../../src/server/documents/registry-testing.js";
import { registerAnnotationTools } from "../../src/server/mcp/annotations.js";
import { convertToMarkdown } from "../../src/server/mcp/convert.js";
import { populateYDoc } from "../../src/server/mcp/document.js";
import { getOpenDocs } from "../../src/server/mcp/document-service.js";
import { getOrCreateDocument } from "../../src/server/yjs/provider.js";

const POSIX = process.platform !== "win32";

/**
 * A tmpdir and a symlink pointing at it.
 *
 * The expectation is built from `fsp.realpath(realDir)`, never from
 * `os.tmpdir()`: on macOS `/var/folders` is itself a symlink, so the
 * uncanonicalized and canonicalized values would coincide and the assertion
 * would pass against the unfixed code.
 */
async function symlinkedDir(): Promise<{ realDir: string; linkDir: string }> {
  const base = await fsp.mkdtemp(path.join(os.tmpdir(), "tandem-export-"));
  const realDir = await fsp.realpath(path.join(base, "real"));
  const linkDir = path.join(base, "via-link");
  await fsp.symlink(realDir, linkDir);
  return { realDir, linkDir };
}

async function makeDir(): Promise<string> {
  const base = await fsp.mkdtemp(path.join(os.tmpdir(), "tandem-export-"));
  await fsp.mkdir(path.join(base, "real"));
  return base;
}

describe("export paths are canonicalized on create-new, not only on overwrite", () => {
  let counter = 0;

  beforeEach(() => {
    for (const id of [...getOpenDocs().keys()]) removeDoc(id);
    setActiveDocId(null);
    counter += 1;
  });

  describe("tandem_exportAnnotations", () => {
    async function mcpClient(): Promise<Client> {
      const server = new McpServer({ name: "tandem-test", version: "0.0.1" });
      registerAnnotationTools(server);
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      const client = new Client({ name: "test-client", version: "0.0.1" });
      await server.connect(serverTransport);
      await client.connect(clientTransport);
      return client;
    }

    function openDoc(): string {
      const id = `export-doc-${counter}`;
      populateYDoc(getOrCreateDocument(id), "Hello world");
      addDoc(id, {
        id,
        filePath: path.join(os.tmpdir(), `${id}.md`),
        format: "md",
        readOnly: false,
        source: "file",
      });
      setActiveDocId(id);
      return id;
    }

    async function exportTo(outputPath: string): Promise<Record<string, unknown>> {
      const client = await mcpClient();
      const result = (await client.callTool({
        name: "tandem_exportAnnotations",
        arguments: { outputPath, format: "json", writeToDisk: true },
      })) as { content: Array<{ type: string; text?: string }> };
      const text = result.content.find((c) => c.type === "text")?.text;
      // The tool wraps its payload as { error, data }.
      return text ? (JSON.parse(text).data ?? {}) : {};
    }

    it("writes a fresh sidecar at all (the control)", async () => {
      openDoc();
      const base = await makeDir();
      const out = path.join(base, "real", "fresh.annotations.json");

      const body = await exportTo(out);
      expect(body.writtenPath, `export failed outright: ${JSON.stringify(body)}`).toBeTruthy();
      await expect(fsp.access(body.writtenPath as string)).resolves.toBeUndefined();
    });

    it.runIf(POSIX)("resolves a symlinked parent when the leaf does not exist", async () => {
      openDoc();
      const { realDir, linkDir } = await symlinkedDir();

      const body = await exportTo(path.join(linkDir, "fresh.annotations.json"));

      expect(
        path.dirname(body.writtenPath as string),
        "the sidecar path was returned uncanonicalized, which means realpath's " +
          "ENOENT was swallowed and the post-resolve prefix re-check never ran",
      ).toBe(realDir);
    });
  });

  describe("tandem_convertToMarkdown", () => {
    function openDocxDoc(dir: string): string {
      const id = `convert-doc-${counter}`;
      populateYDoc(getOrCreateDocument(id), "Hello world");
      addDoc(id, {
        id,
        filePath: path.join(dir, `${id}.docx`),
        format: "docx",
        readOnly: false,
        source: "file",
      });
      setActiveDocId(id);
      return id;
    }

    it("converts to a fresh path at all (the control)", async () => {
      const base = await makeDir();
      const id = openDocxDoc(base);
      const out = path.join(base, "real", "fresh.md");

      const result = await convertToMarkdown(id, out);
      expect(result.outputPath).toBeTruthy();
      await expect(fsp.access(result.outputPath)).resolves.toBeUndefined();
    });

    it.runIf(POSIX)("resolves a symlinked parent when the leaf does not exist", async () => {
      const { realDir, linkDir } = await symlinkedDir();
      const id = openDocxDoc(realDir);

      const result = await convertToMarkdown(id, path.join(linkDir, "fresh.md"));

      // Deliberately not asserting a throw. `resolveAndValidatePath` realpaths
      // and does NOT reject symlinks, so the unfixed code succeeded — it just
      // returned an uncanonicalized `outputPath` while hashing the documentId
      // from the canonical one. The mismatch was the whole symptom.
      expect(
        path.dirname(result.outputPath),
        "outputPath came back uncanonicalized, so realpath's ENOENT was swallowed " +
          "and the post-resolve prefix re-check never ran on the create-new path",
      ).toBe(realDir);
    });

    it("reports a missing output directory as a coded error, not a raw ENOENT", async () => {
      const base = await makeDir();
      const id = openDocxDoc(base);

      // Previously this escaped `atomicWrite` as a bare ENOENT and surfaced as
      // 500 / INTERNAL — a caller-fixable path mistake reported as a server
      // fault.
      await expect(
        convertToMarkdown(id, path.join(base, "no-such-dir", "out.md")),
      ).rejects.toMatchObject({ code: "FILE_NOT_FOUND" });
    });
  });
});
