/**
 * One wire code per condition, driven through the REAL tools (#1823).
 *
 * Each row asserts `code` exactly, because a wire code is client-visible:
 * `skills/tandem/SKILL.md` and `docs/mcp-tools.md` both tell Claude what to
 * match on. The rows that need a mocked seam (errno mapping) live in
 * `mcp-wire-codes-mocked.test.ts`.
 */
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import JSZip from "jszip";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as Y from "yjs";

// vi.mock factories are hoisted above module-level code. The app-data dir name
// carries the literal `tandem` (platform.test.ts keys on it), and it keeps the
// pre-overwrite snapshot and annotation envelope of a real open out of the
// user's real app data.
vi.mock("../../src/server/platform", async (importOriginal) => {
  const original = await importOriginal<typeof import("../../src/server/platform")>();
  const osMod = await import("os");
  const pathMod = await import("path");
  const cryptoMod = await import("crypto");
  const appDataDir = pathMod.join(
    osMod.tmpdir(),
    `tandem-test-wire-codes-${cryptoMod.randomUUID()}`,
  );
  process.env.TANDEM_APP_DATA_DIR = appDataDir;
  return { ...original, SESSION_DIR: pathMod.join(appDataDir, "sessions") };
});
vi.mock("../../src/server/file-watcher", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/server/file-watcher")>()),
  watchFile: vi.fn(),
}));
vi.mock("../../src/server/integrations/acl-win.js", () => ({
  setRestrictiveAcl: vi.fn().mockResolvedValue(undefined),
}));

const { addDoc, removeDoc, setActiveDocId } = await import(
  "../../src/server/documents/registry-testing.js"
);
const { populateYDoc, registerDocumentTools } = await import("../../src/server/mcp/document.js");
const { getOpenDocs } = await import("../../src/server/mcp/document-service.js");
const { registerApplyTools } = await import("../../src/server/mcp/docx-apply.js");
const { getOrCreateDocument } = await import("../../src/server/yjs/provider.js");
const { Y_MAP_ANNOTATIONS } = await import("../../src/shared/constants.js");
const { timeoutMs } = await import("../helpers/timing.js");

const REAL_APPLY_TIMEOUT_MS = timeoutMs(60_000, 300_000);

function parseResult(result: Awaited<ReturnType<Client["callTool"]>>) {
  const content = result.content as Array<{ type: string; text?: string }>;
  const text = content.find((c) => c.type === "text")?.text;
  return text ? JSON.parse(text) : null;
}

async function setupClient(): Promise<Client> {
  const server = new McpServer({ name: "tandem-test", version: "0.0.1" });
  registerDocumentTools(server);
  registerApplyTools(server);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test-client", version: "0.0.1" });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return client;
}

type DocOpts = {
  format?: "md" | "txt" | "html" | "docx";
  readOnly?: boolean;
  source?: "file" | "upload";
  filePath?: string;
};

function registerDoc(id: string, text: string, opts: DocOpts = {}) {
  const ydoc = getOrCreateDocument(id);
  populateYDoc(ydoc, text);
  addDoc(id, {
    id,
    filePath: opts.filePath ?? `/tmp/${id}.${opts.format ?? "md"}`,
    format: opts.format ?? "md",
    readOnly: opts.readOnly ?? false,
    source: opts.source ?? "file",
  });
  setActiveDocId(id);
  return ydoc;
}

/** A minimal, structurally valid .docx with one body paragraph (docx-apply.test.ts). */
async function createTestDocx(text: string): Promise<Buffer> {
  const zip = new JSZip();
  zip.file(
    "word/document.xml",
    `<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:w14="http://schemas.microsoft.com/office/word/2010/wordml"><w:body><w:p><w:r><w:t>${text}</w:t></w:r></w:p></w:body></w:document>`,
  );
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

let client: Client;
let tmpDir: string;

beforeEach(async () => {
  for (const id of [...getOpenDocs().keys()]) removeDoc(id);
  setActiveDocId(null);
  tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "tandem-wire-codes-"));
  client = await setupClient();
});

afterEach(async () => {
  for (const id of [...getOpenDocs().keys()]) removeDoc(id);
  await fsp.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
});

afterAll(async () => {
  const appData = process.env.TANDEM_APP_DATA_DIR;
  if (appData?.includes("tandem-test-wire-codes-")) {
    await fsp.rm(appData, { recursive: true, force: true }).catch(() => {});
  }
});

async function call(name: string, args: Record<string, unknown>) {
  return parseResult(await client.callTool({ name, arguments: args }));
}

describe("read-only → READ_ONLY (#1823 §B)", () => {
  it("tandem_edit on a read-only document", async () => {
    registerDoc("ro-edit", "Hello world", { readOnly: true });
    const parsed = await call("tandem_edit", { from: 0, to: 5, newText: "Howdy" });
    expect(parsed.error).toBe(true);
    expect(parsed.code).toBe("READ_ONLY");
  });

  it("tandem_editList on a read-only document", async () => {
    registerDoc("ro-list", "- one\n- two", { readOnly: true });
    const parsed = await call("tandem_editList", { at: 2, op: "remove" });
    expect(parsed.error).toBe(true);
    expect(parsed.code).toBe("READ_ONLY");
  });
});

describe("rejected or unusable path → INVALID_PATH (#1823 §D)", () => {
  it("tandem_open on a UNC path", async () => {
    // Absolute on both POSIX and win32, so it gets past the relative-path
    // refusal; `assertSafePathPrefix` refuses the RAW input before any fs call,
    // so it reaches the handler's INVALID_PATH arm on every platform.
    const unc = "//server/share/x.md";
    expect(path.isAbsolute(unc)).toBe(true);
    const parsed = await call("tandem_open", { filePath: unc });
    expect(parsed.error).toBe(true);
    expect(parsed.code).toBe("INVALID_PATH");
    expect(parsed.message).toContain("UNC");
    expect(parsed.message).not.toContain("absolute");
  });

  it("tandem_applyChanges with a UNC backupPath", async () => {
    const parsed = await call("tandem_applyChanges", { backupPath: "//server/share/b.docx" });
    expect(parsed.error).toBe(true);
    expect(parsed.code).toBe("INVALID_PATH");
  });

  it("tandem_applyChanges on an upload", async () => {
    registerDoc("apply-upload", "Hello", {
      format: "docx",
      source: "upload",
      filePath: "upload://abc/pasted.docx",
    });
    const parsed = await call("tandem_applyChanges", {});
    expect(parsed.error).toBe(true);
    expect(parsed.code).toBe("INVALID_PATH");
  });

  it("tandem_restoreBackup restore mode on an upload", async () => {
    registerDoc("restore-upload", "Hello", { source: "upload", filePath: "upload://abc/p.md" });
    const parsed = await call("tandem_restoreBackup", { backup: "x" });
    expect(parsed.error).toBe(true);
    expect(parsed.code).toBe("INVALID_PATH");
  });

  it("twin: tandem_restoreBackup restore mode on a writable .html stays FORMAT_ERROR", async () => {
    // Kills folding UNSUPPORTED_FORMAT into the INVALID_PATH arm.
    registerDoc("restore-html", "Hello", { format: "html", filePath: path.join(tmpDir, "p.html") });
    const parsed = await call("tandem_restoreBackup", { backup: "x" });
    expect(parsed.error).toBe(true);
    expect(parsed.code).toBe("FORMAT_ERROR");
  });
});

describe("tandem_applyChanges missing backup directory → FILE_NOT_FOUND (#1823 §E)", () => {
  it(
    "answers FILE_NOT_FOUND, not INTERNAL_ERROR, and leaves the file alone",
    async () => {
      const docPath = path.join(tmpDir, "doc.docx");
      await fsp.writeFile(docPath, await createTestDocx("Hello world"));
      const doc = getOrCreateDocument("apply-missing-dir");
      const paragraph = new Y.XmlElement("paragraph");
      const text = new Y.XmlText();
      paragraph.insert(0, [text]);
      doc.getXmlFragment("default").insert(0, [paragraph]);
      text.insert(0, "Hello world");
      // One accepted suggestion, so the backup directory is the only thing that
      // can stop the write (not NO_SUGGESTIONS).
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
      addDoc("apply-missing-dir", {
        id: "apply-missing-dir",
        filePath: docPath,
        format: "docx",
        readOnly: false,
        source: "file",
      });
      setActiveDocId("apply-missing-dir");
      const before = await fsp.readFile(docPath);

      const parsed = await call("tandem_applyChanges", {
        backupPath: path.join(tmpDir, "no-such-dir", "b.docx"),
      });
      expect(parsed.error).toBe(true);
      expect(parsed.code).toBe("FILE_NOT_FOUND");
      expect(await fsp.readFile(docPath)).toEqual(before);
    },
    REAL_APPLY_TIMEOUT_MS,
  );
});

describe("tandem_open refuses a relative path (#1823 §F)", () => {
  it("a relative path to a real file → INVALID_PATH, and nothing opens", async () => {
    const file = path.join(tmpDir, "rel.md");
    await fsp.writeFile(file, "# Rel\n\nbody\n");
    const rel = path.relative(process.cwd(), file);
    // Precondition: on a machine where tmp and cwd sit on different drives,
    // `path.relative` returns an absolute path and this row would test nothing.
    expect(path.isAbsolute(rel)).toBe(false);
    const sizeBefore = getOpenDocs().size;

    const parsed = await call("tandem_open", { filePath: rel });
    expect(parsed.error).toBe(true);
    expect(parsed.code).toBe("INVALID_PATH");
    expect(getOpenDocs().size).toBe(sizeBefore);
  });

  it("twin: a missing absolute path is still FILE_NOT_FOUND", async () => {
    const parsed = await call("tandem_open", { filePath: path.join(tmpDir, "missing.md") });
    expect(parsed.error).toBe(true);
    expect(parsed.code).toBe("FILE_NOT_FOUND");
  });
});

describe("tandem_status with a documentId that is not open (#1823 §G)", () => {
  it("names the id instead of saying no document is open", async () => {
    registerDoc("status-open", "Hello");
    const parsed = await call("tandem_status", { text: "working", documentId: "nope" });
    expect(parsed.error).toBe(false);
    expect(parsed.data.warning).toContain("nope");
    expect(parsed.data.warning).not.toContain("No document open");
  });
});
