import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { Request, Response } from "express";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// `/api/convert` needs an open `.docx` to reach `convertToMarkdown`; the route
// half is what this file pins, so the core is stubbed at the module the route
// imports. Every other route below runs its real open path.
const convertToMarkdown = vi.hoisted(() =>
  vi.fn(async () => ({
    outputPath: "/tmp/converted.md",
    documentId: "converted-doc",
    fileName: "converted.md",
  })),
);
vi.mock(import("../../src/server/mcp/convert.js"), async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/server/mcp/convert.js")>()),
  convertToMarkdown,
}));

import { removeDoc, setActiveDocId } from "../../src/server/documents/registry-testing.js";
import { closeDocumentById, getOpenDocs } from "../../src/server/mcp/document-service.js";
import { handleConvert } from "../../src/server/mcp/routes/convert.js";
import { handleOpen } from "../../src/server/mcp/routes/open.js";
import { handleScratchpad } from "../../src/server/mcp/routes/scratchpad.js";
import { handleUpload } from "../../src/server/mcp/routes/upload.js";
import {
  applyUserOpenDefault,
  applyUserOpenDefaultToDocuments,
  getDocOwner,
  getOwnerRecord,
  onDocumentClosed,
  resetOwnershipForTests,
  setDocOwner,
  setTandemPresenceSource,
  TANDEM_OWNER_ID,
} from "../../src/server/sessions/ownership.js";
import { TAURI_HOSTNAME } from "../../src/shared/constants.js";

/**
 * The default rule's user-side callers and the tab-close point (#2358,
 * ADR-054; ownership design §4.2).
 *
 * Tandem's Claude is never present in 1a (presence lands in PR 3b), so with
 * the real presence source every call below leaves a document unowned — and
 * deleting any of them would change nothing observable. So these turn presence
 * ON through the seam: each user-side open must then hand its document to
 * Tandem's Claude as `default`, which only a call that is really there can do.
 */

let tmpDir: string;

function req(body: unknown): Request {
  return {
    body,
    headers: { origin: `http://${TAURI_HOSTNAME}` },
    socket: { remoteAddress: "127.0.0.1" },
  } as unknown as Request;
}

function res(): { response: Response; body: () => { data?: { documentId?: string } } } {
  let captured: unknown;
  const response = {
    json: (b: unknown) => {
      captured = b;
      return response;
    },
    status: () => response,
  } as unknown as Response;
  return { response, body: () => captured as { data?: { documentId?: string } } };
}

beforeEach(async () => {
  vi.stubEnv("TANDEM_OWNERSHIP", "1");
  setTandemPresenceSource(() => true);
  for (const id of [...getOpenDocs().keys()]) removeDoc(id);
  setActiveDocId(null);
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "tandem-ownership-default-"));
});

afterEach(async () => {
  for (const id of [...getOpenDocs().keys()]) removeDoc(id);
  resetOwnershipForTests();
  vi.unstubAllEnvs();
  await fs.rm(tmpDir, { recursive: true, force: true });
});

const expectDefault = (documentId: string | undefined) => {
  expect(documentId).toBeTypeOf("string");
  // No entry may name a record that does not exist (PR 1c's enforcement
  // reads the holder's record).
  expect(getOwnerRecord(TANDEM_OWNER_ID)?.recordKind).toBe("tandem");
  expect(getDocOwner(documentId as string)).toMatchObject({
    ownerId: TANDEM_OWNER_ID,
    kind: "default",
  });
};

describe("each user-side open applies the default rule", () => {
  it("POST /api/open", async () => {
    const file = path.join(tmpDir, "open.md");
    await fs.writeFile(file, "# open");
    const r = res();
    await handleOpen(req({ filePath: file }), r.response);
    expectDefault(r.body().data?.documentId);
  });

  it("POST /api/upload", async () => {
    const r = res();
    await handleUpload(req({ fileName: "up.md", content: "# up" }), r.response);
    expectDefault(r.body().data?.documentId);
  });

  it("POST /api/scratchpad", async () => {
    const r = res();
    await handleScratchpad(req({}), r.response);
    expectDefault(r.body().data?.documentId);
  });

  it("POST /api/convert (the route, not the shared core)", async () => {
    const r = res();
    await handleConvert(req({}), r.response);
    expect(convertToMarkdown).toHaveBeenCalled();
    expectDefault(r.body().data?.documentId);
  });

  it("the startup boot helper, over every document it is given", () => {
    applyUserOpenDefaultToDocuments(["boot-a", "boot-b"]);
    expectDefault("boot-a");
    expectDefault("boot-b");
  });
});

describe("what the default rule leaves alone", () => {
  it("a document that already has an entry is untouched, entry object and all", () => {
    setDocOwner("held", { ownerId: "claude:t", kind: "opened" }, "user-open");
    const before = getDocOwner("held");
    applyUserOpenDefault("held");
    expect(getDocOwner("held")).toBe(before);
  });

  it("re-opening an already-open file through the route does not move it", async () => {
    const file = path.join(tmpDir, "again.md");
    await fs.writeFile(file, "# again");
    const first = res();
    await handleOpen(req({ filePath: file }), first.response);
    const id = first.body().data?.documentId as string;
    setDocOwner(id, { ownerId: "claude:t", kind: "assigned" }, "user-open");
    const before = getDocOwner(id);
    await handleOpen(req({ filePath: file }), res().response);
    expect(getDocOwner(id)).toBe(before);
  });

  it("while Tandem's Claude is not present, a user open leaves the document unowned", async () => {
    setTandemPresenceSource(() => false);
    const r = res();
    await handleUpload(req({ fileName: "np.md", content: "# np" }), r.response);
    expect(getDocOwner(r.body().data?.documentId as string)).toBeUndefined();
  });

  it("flag off, with presence on, creates nothing", async () => {
    vi.stubEnv("TANDEM_OWNERSHIP", "");
    const r = res();
    await handleUpload(req({ fileName: "off.md", content: "# off" }), r.response);
    const id = r.body().data?.documentId as string;
    expect(id).toBeTypeOf("string");
    vi.stubEnv("TANDEM_OWNERSHIP", "1");
    expect(getDocOwner(id)).toBeUndefined();
  });
});

describe("the tab-close point", () => {
  it("closeDocumentById removes the document's entry", async () => {
    const file = path.join(tmpDir, "close.md");
    await fs.writeFile(file, "# close");
    const r = res();
    await handleOpen(req({ filePath: file }), r.response);
    const id = r.body().data?.documentId as string;
    expectDefault(id);
    const closed = await closeDocumentById(id);
    expect(closed.success).toBe(true);
    expect(getDocOwner(id)).toBeUndefined();
  });

  it("onDocumentClosed flag-off leaves an entry alone", () => {
    setDocOwner("kept", { ownerId: "claude:t", kind: "opened" }, "user-open");
    vi.stubEnv("TANDEM_OWNERSHIP", "");
    onDocumentClosed("kept");
    vi.stubEnv("TANDEM_OWNERSHIP", "1");
    expect(getDocOwner("kept")?.ownerId).toBe("claude:t");
  });
});
