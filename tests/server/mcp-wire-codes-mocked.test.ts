/**
 * Wire-code rows that need a mocked seam to reach (#1851, #1823).
 *
 * `document-service.js` and `file-io/index.js` are mocked with an
 * `importOriginal` spread so only the named functions are replaced; the tool
 * modules import them as plain named ESM imports, so the override is what the
 * handler calls. The real-tool rows live in `mcp-wire-codes.test.ts`.
 */
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createMinimalDocx,
  parseResult,
  seedAcceptedSuggestion,
} from "../helpers/wire-code-fixtures.js";

const mocks = vi.hoisted(() => ({
  renameDocument: vi.fn(),
  saveDocumentToDisk: vi.fn(),
  /** When set, `atomicWriteBuffer` rejects with this errno for exactly this path. */
  failWrite: null as { path: string; code: string } | null,
}));

vi.mock("../../src/server/platform", async (importOriginal) => {
  const original = await importOriginal<typeof import("../../src/server/platform")>();
  const osMod = await import("os");
  const pathMod = await import("path");
  const cryptoMod = await import("crypto");
  // The literal `tandem` in the name is load-bearing for platform.test.ts, and
  // the dir keeps applyChanges' pre-overwrite snapshot out of real app data.
  const appDataDir = pathMod.join(
    osMod.tmpdir(),
    `tandem-test-wire-mocked-${cryptoMod.randomUUID()}`,
  );
  process.env.TANDEM_APP_DATA_DIR = appDataDir;
  return { ...original, SESSION_DIR: pathMod.join(appDataDir, "sessions") };
});
vi.mock("../../src/server/integrations/acl-win.js", () => ({
  setRestrictiveAcl: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../../src/server/mcp/document-service.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/server/mcp/document-service.js")>()),
  renameDocument: mocks.renameDocument,
  saveDocumentToDisk: mocks.saveDocumentToDisk,
}));
vi.mock("../../src/server/file-io/index.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../../src/server/file-io/index.js")>();
  return {
    ...original,
    atomicWriteBuffer: async (...args: Parameters<typeof original.atomicWriteBuffer>) => {
      const fail = mocks.failWrite;
      if (fail && path.resolve(String(args[0])) === path.resolve(fail.path)) {
        throw Object.assign(new Error(`${fail.code}: refused`), { code: fail.code });
      }
      return original.atomicWriteBuffer(...args);
    },
  };
});

const { addDoc, removeDoc, setActiveDocId } = await import(
  "../../src/server/documents/registry-testing.js"
);
const { populateYDoc, registerDocumentTools } = await import("../../src/server/mcp/document.js");
const { getOpenDocs } = await import("../../src/server/mcp/document-service.js");
const { registerApplyTools } = await import("../../src/server/mcp/docx-apply.js");
const { getOrCreateDocument } = await import("../../src/server/yjs/provider.js");
const { timeoutMs } = await import("../helpers/timing.js");

const REAL_APPLY_TIMEOUT_MS = timeoutMs(60_000, 300_000);

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

let client: Client;
let tmpDir: string;

beforeEach(async () => {
  vi.clearAllMocks();
  mocks.failWrite = null;
  for (const id of [...getOpenDocs().keys()]) removeDoc(id);
  setActiveDocId(null);
  tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "tandem-wire-mocked-"));
  client = await setupClient();
});

afterEach(async () => {
  for (const id of [...getOpenDocs().keys()]) removeDoc(id);
  await fsp.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
});

afterAll(async () => {
  const appData = process.env.TANDEM_APP_DATA_DIR;
  if (appData?.includes("tandem-test-wire-mocked-")) {
    await fsp.rm(appData, { recursive: true, force: true }).catch(() => {});
  }
});

describe("tandem_rename narrows renameDocument's open errorCode (#1851)", () => {
  async function rename() {
    return parseResult(
      await client.callTool({
        name: "tandem_rename",
        arguments: { newName: "b.md", documentId: "doc-1" },
      }),
    );
  }

  it("a raw errno arrives as RENAME_FAILED, with the errno in details.errorCode", async () => {
    mocks.renameDocument.mockResolvedValueOnce({
      status: "error",
      reason: "The document could not be renamed.",
      errorCode: "EXDEV",
    });
    const parsed = await rename();
    expect(parsed.error).toBe(true);
    expect(parsed.code).toBe("RENAME_FAILED");
    expect(parsed.details).toEqual({ errorCode: "EXDEV" });
    expect(parsed.message).toBe("The document could not be renamed.");
  });

  it("a listed semantic code passes through as the wire code", async () => {
    mocks.renameDocument.mockResolvedValueOnce({
      status: "error",
      reason: "A file with that name already exists.",
      errorCode: "ALREADY_EXISTS",
    });
    const parsed = await rename();
    expect(parsed.code).toBe("ALREADY_EXISTS");
    expect(parsed.details).toBeUndefined();
  });
});

describe("tandem_save errno → one code per condition (#1823 §C)", () => {
  it.each([
    ["EACCES", "PERMISSION_DENIED"],
    ["EBUSY", "FILE_LOCKED"],
    ["ENOSPC", "FORMAT_ERROR"],
  ])("save failing with %s answers %s, keeping details.errorCode", async (errno, expected) => {
    const ydoc = getOrCreateDocument(`save-${errno}`);
    populateYDoc(ydoc, "Hello");
    addDoc(`save-${errno}`, {
      id: `save-${errno}`,
      filePath: path.join(tmpDir, `save-${errno}.md`),
      format: "md",
      readOnly: false,
      source: "file",
    });
    setActiveDocId(`save-${errno}`);
    mocks.saveDocumentToDisk.mockResolvedValueOnce({
      status: "error",
      reason: "The document could not be saved.",
      errorCode: errno,
    });

    const parsed = parseResult(await client.callTool({ name: "tandem_save", arguments: {} }));
    expect(parsed.error).toBe(true);
    expect(parsed.code).toBe(expected);
    expect(parsed.details).toEqual({ errorCode: errno });
  });
});

describe("tandem_applyChanges EACCES on the write-back (#1823 §C)", () => {
  it(
    "answers PERMISSION_DENIED, not FILE_LOCKED",
    async () => {
      const docPath = path.join(tmpDir, "doc.docx");
      await fsp.writeFile(docPath, await createMinimalDocx("Hello world"));
      seedAcceptedSuggestion(getOrCreateDocument("apply-eacces"));
      addDoc("apply-eacces", {
        id: "apply-eacces",
        filePath: docPath,
        format: "docx",
        readOnly: false,
        source: "file",
      });
      setActiveDocId("apply-eacces");
      // The backup directory (the document's own) exists, so the write-back is
      // the first thing that can fail.
      mocks.failWrite = { path: docPath, code: "EACCES" };

      const parsed = parseResult(
        await client.callTool({ name: "tandem_applyChanges", arguments: {} }),
      );
      expect(parsed.error).toBe(true);
      expect(parsed.code).toBe("PERMISSION_DENIED");
    },
    REAL_APPLY_TIMEOUT_MS,
  );
});
