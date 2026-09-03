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
  await fsp.mkdir(path.join(base, "real"));
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

    /** The whole `{ error, code, message, data }` envelope. */
    async function exportEnvelope(outputPath: string): Promise<Record<string, unknown>> {
      const client = await mcpClient();
      const result = (await client.callTool({
        name: "tandem_exportAnnotations",
        arguments: { outputPath, format: "json", writeToDisk: true },
      })) as { content: Array<{ type: string; text?: string }> };
      const text = result.content.find((c) => c.type === "text")?.text;
      return text ? JSON.parse(text) : {};
    }

    async function exportTo(outputPath: string): Promise<Record<string, unknown>> {
      const envelope = await exportEnvelope(outputPath);
      return (envelope.data as Record<string, unknown>) ?? {};
    }

    /**
     * Assert a rejection BY ITS CODE AND MESSAGE, never by an absent
     * `writtenPath`. An unrelated failure -- a bad fixture, a symlink that was
     * never created, a doc that never opened -- also produces no `writtenPath`,
     * so the weaker assertion is satisfied by a test that never exercised the
     * pin at all.
     */
    async function expectSuffixRejection(outputPath: string): Promise<void> {
      const envelope = await exportEnvelope(outputPath);
      expect(envelope.error, `expected a rejection, got: ${JSON.stringify(envelope)}`).toBe(true);
      expect(envelope.code).toBe("INVALID_PATH");
      expect(String(envelope.message)).toContain(".annotations.json");
    }

    it("writes a fresh sidecar at all (the control)", async () => {
      openDoc();
      const base = await makeDir();
      const out = path.join(base, "real", "fresh.annotations.json");

      const body = await exportTo(out);
      expect(body.writtenPath, `export failed outright: ${JSON.stringify(body)}`).toBeTruthy();
      await expect(fsp.access(body.writtenPath as string)).resolves.toBeUndefined();
    });

    // #1654 suffix pin. Each negative below kills a specific weaker pin:
    // a bare `CLAUDE.md` reject is satisfied by almost anything, so it alone
    // proves nothing about WHICH pin shipped.
    it("refuses a caller-named CLAUDE.md, and does not create it", async () => {
      openDoc();
      const base = await makeDir();
      const target = path.join(base, "real", "CLAUDE.md");

      await expectSuffixRejection(target);
      await expect(fsp.access(target)).rejects.toBeTruthy();
    });

    it("refuses a same-extension non-sidecar name (kills an extension-only pin)", async () => {
      openDoc();
      const base = await makeDir();
      // `format: "json"` and the target ends in `.json`, so an `extname`-shaped
      // pin accepts this. Only the `.annotations.json` SUFFIX refuses it.
      await expectSuffixRejection(path.join(base, "real", "settings.json"));
    });

    it("refuses the other format's suffix (kills an either-suffix pin)", async () => {
      openDoc();
      const base = await makeDir();
      // `exportTo` sends `format: "json"`. A pin accepting either suffix would
      // let this through; the format-matched pin does not.
      await expectSuffixRejection(path.join(base, "real", "notes.annotations.md"));
    });

    it("accepts a conforming name in an arbitrary directory (the positive control)", async () => {
      openDoc();
      const base = await makeDir();
      // Without this, a pin that refuses EVERYTHING passes every negative above.
      // It also pins the half the narrowing deliberately keeps: the destination
      // directory is unrestricted; only the leaf name is.
      const out = path.join(base, "real", "anywhere.annotations.json");
      const body = await exportTo(out);
      expect(body.writtenPath).toBe(out);
    });

    it("accepts a case variant of the suffix", async () => {
      openDoc();
      const base = await makeDir();
      const out = path.join(base, "real", "Cased.Annotations.JSON");
      const body = await exportTo(out);
      expect(body.writtenPath).toBe(out);
    });

    it.runIf(POSIX)(
      "refuses a conforming leaf that is a symlink to a non-conforming target",
      async () => {
        openDoc();
        const { realDir } = await symlinkedDir();
        const victim = path.join(realDir, "CLAUDE.md");
        await fsp.writeFile(victim, "original");
        const leaf = path.join(realDir, "laundered.annotations.json");
        await fsp.symlink(victim, leaf);

        // THE placement test. `annotations.ts` assigns `sidecarPath = real` when
        // realpath hits an existing leaf, so a pin on the caller's string --
        // even one line earlier -- accepts `laundered.annotations.json` and then
        // writes CLAUDE.md. Every other negative in this file passes against
        // that mutation; only this one fails.
        await expectSuffixRejection(leaf);
        expect(await fsp.readFile(victim, "utf-8")).toBe("original");
      },
    );

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

    it("converts into a fresh directory at all (the control)", async () => {
      const base = await makeDir();
      const id = openDocxDoc(base);

      // #1654: `outputPath` names a DIRECTORY. The leaf is derived from the
      // source document, so the caller cannot choose the created filename.
      const result = await convertToMarkdown(id, path.join(base, "real"));
      expect(result.outputPath).toBe(path.join(base, "real", `${id}.md`));
      await expect(fsp.access(result.outputPath)).resolves.toBeUndefined();
    });

    it("refuses a caller-named file path (#1654)", async () => {
      const base = await makeDir();
      const id = openDocxDoc(base);

      // The pre-#1654 spelling. It is refused as a NON-DIRECTORY rather than
      // silently reinterpreted, so a caller cannot name the file created --
      // which is what a project CLAUDE.md in a repo lacking one requires.
      await fsp.writeFile(path.join(base, "real", "decoy.md"), "x");
      await expect(
        convertToMarkdown(id, path.join(base, "real", "decoy.md")),
      ).rejects.toMatchObject({ code: "INVALID_PATH" });
    });

    it.runIf(POSIX)("resolves a symlinked output directory", async () => {
      const { realDir, linkDir } = await symlinkedDir();
      const id = openDocxDoc(realDir);

      // #1654 made `outputPath` directory-only, so the ENOENT-on-leaf case the
      // #1650 fix canonicalized cannot arise here any more -- the leaf is
      // always derived. What still must hold, and is what that fix was really
      // protecting, is that a symlinked DESTINATION is canonicalized before the
      // prefix re-check and before the write.
      const result = await convertToMarkdown(id, linkDir);

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
      await expect(convertToMarkdown(id, path.join(base, "no-such-dir"))).rejects.toMatchObject({
        code: "FILE_NOT_FOUND",
      });
    });

    // #1796: this discriminating twin stays green (FILE_NOT_FOUND, above) while
    // the no-document condition below gets its own code — a message-sniffing
    // handler "fix" that leaves this throw site on FILE_NOT_FOUND would still
    // pass the spec above and only be caught here.
    it("reports no open document as NO_DOCUMENT, not FILE_NOT_FOUND (#1796)", async () => {
      await expect(convertToMarkdown("no-such-doc-id")).rejects.toMatchObject({
        code: "NO_DOCUMENT",
      });
    });

    // #1796: convert.ts's realpath catch classified only ENOENT. ENOTDIR,
    // ELOOP, ENAMETOOLONG and EACCES/EPERM from that same call all fell
    // through to the bare `throw err` and surfaced as an uncoded 500.
    // `runIf(POSIX)`: on Windows `fs.realpath` reports ENOENT, not any of
    // the ENOTDIR/ELOOP/ENAMETOOLONG shapes, so those are not constructible
    // there — the consequence for a Windows caller is recorded as a known
    // gap in `docs/gotchas.md` (MCP / Server).
    // `tests/server/convert-error-mapping.test.ts` mocks `convert.js`
    // wholesale, so it never executes this realpath classification at all --
    // these four specs are its only coverage HERE.
    //
    // EPERM is deliberately not among them, and NOT because it is a
    // speculative extra. It is `realpath`'s permission errno on WINDOWS
    // (measured unprivileged: `icacls <dir> /deny <sid>:(W)`), which is
    // precisely why it cannot be provoked from this POSIX-gated block --
    // Linux answers EACCES for the same condition. So the EACCES/EPERM arm in
    // `convert.ts` is not one errno plus a hopeful alias; it is one arm per
    // platform, and deleting the EPERM half as dead code would break
    // permission reporting on Windows alone. Its proof is
    // `tests/server/convert-output-acl-win.test.ts`, registered with the
    // `windows-acl-proof` CI job so it is a real gate rather than a
    // Windows-gated describe nothing runs (#1529).
    it.runIf(POSIX)(
      "outputPath walking through a non-directory: INVALID_PATH naming the CALLER's path",
      async () => {
        const base = await makeDir();
        const id = openDocxDoc(base);
        const notADir = path.join(base, "not-a-dir.txt");
        await fsp.writeFile(notADir, "x");
        const badOutputPath = path.join(notADir, "sub");

        // Naming the pre-realpath path the caller supplied, never anything
        // realpath expanded -- there is nothing further to expand here, but
        // this pins that convert.ts didn't switch to `realDir` by mistake.
        await expect(convertToMarkdown(id, badOutputPath)).rejects.toMatchObject({
          code: "INVALID_PATH",
          message: expect.stringContaining(badOutputPath),
        });
      },
    );

    it.runIf(POSIX)(
      "outputPath through a symlink loop: INVALID_PATH, not an uncoded 500 (ELOOP)",
      async () => {
        const base = await makeDir();
        const id = openDocxDoc(base);
        const loopDir = path.join(base, "loop");
        await fsp.symlink(loopDir, loopDir);

        await expect(convertToMarkdown(id, loopDir)).rejects.toMatchObject({
          code: "INVALID_PATH",
        });
      },
    );

    it.runIf(POSIX)(
      "outputPath component too long: INVALID_PATH, not an uncoded 500 (ENAMETOOLONG)",
      async () => {
        // Confirmed with the reviewer: Linux's realpath answers ENAMETOOLONG
        // for a single path component over NAME_MAX (255); Windows answers
        // ENOENT for the same shape, so this stays POSIX-only rather than
        // becoming a third Windows-gated case nothing runs (#1529).
        const base = await makeDir();
        const id = openDocxDoc(base);
        const tooLong = path.join(base, "x".repeat(300));

        await expect(convertToMarkdown(id, tooLong)).rejects.toMatchObject({
          code: "INVALID_PATH",
        });
      },
    );

    // Running as root defeats the chmod below (root ignores directory
    // permissions: `realpath` would answer ENOENT on the missing leaf
    // instead of EACCES, and this would go hard red rather than skip) --
    // `getuid` is POSIX-only, hence the optional call. Current `check` runs
    // unprivileged, so this is a genuine skip guard, not dead code.
    it.runIf(POSIX && process.getuid?.() !== 0)(
      "outputPath in an unsearchable directory: PERMISSION_DENIED, not an uncoded 500 (EACCES)",
      async () => {
        const base = await makeDir();
        const id = openDocxDoc(base);
        const restricted = path.join(base, "restricted");
        await fsp.mkdir(restricted);
        const target = path.join(restricted, "sub");
        // Strip the execute bit so `realpath` can't traverse into it.
        await fsp.chmod(restricted, 0o000);
        try {
          await expect(convertToMarkdown(id, target)).rejects.toMatchObject({
            code: "PERMISSION_DENIED",
          });
        } finally {
          await fsp.chmod(restricted, 0o755);
        }
      },
    );

    // #1796 round 2: the WRITE-path half of the same funnel, and the shape
    // that classifying `realpath` alone cannot reach. `0o555` is the ordinary
    // read-but-not-write directory: `realpath` resolves, `fs.stat` says
    // directory, `findAvailablePath`'s `fs.access` says ENOENT (so the path
    // reads as free), and the failure lands on `atomicWrite`. Unclassified it
    // was `INTERNAL_ERROR` over MCP and — worse — a 423 over `/api`, whose
    // body `sendApiError` overrides with "File is locked by another program."
    //
    // The Windows twin of this spec (`icacls /deny (WD,AD)`, errno EPERM) is
    // in `convert-output-acl-win.test.ts`. This one exists so the write-path
    // arm is also pinned by ubuntu `check`, which is the required status
    // check; `windows-acl-proof` is a separate job and a separate errno.
    it.runIf(POSIX && process.getuid?.() !== 0)(
      "outputPath readable but not writable: PERMISSION_DENIED from the WRITE, not FILE_LOCKED",
      async () => {
        const base = await makeDir();
        const id = openDocxDoc(base);
        const readOnlyDir = path.join(base, "read-only");
        await fsp.mkdir(readOnlyDir);
        // Traversable and readable, but nothing may be created inside it.
        await fsp.chmod(readOnlyDir, 0o555);
        try {
          // Preconditions, not decoration: they are what distinguishes this
          // from the `0o000` spec above. If any of them started failing, the
          // assertion below would be re-proving the realpath arm instead.
          await expect(fsp.realpath(readOnlyDir)).resolves.toBeTypeOf("string");
          await expect(fsp.stat(readOnlyDir).then((s) => s.isDirectory())).resolves.toBe(true);
          await expect(fsp.access(path.join(readOnlyDir, `${id}.md`))).rejects.toMatchObject({
            code: "ENOENT",
          });

          await expect(convertToMarkdown(id, readOnlyDir)).rejects.toMatchObject({
            code: "PERMISSION_DENIED",
            // Names the write, so this cannot pass on a build where only the
            // resolver is classified.
            message: expect.stringContaining("writing to output directory"),
          });
        } finally {
          await fsp.chmod(readOnlyDir, 0o755);
        }
      },
    );
  });
});
