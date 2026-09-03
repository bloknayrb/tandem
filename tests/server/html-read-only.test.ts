/**
 * `.html` opens read-only, and a save that never reached disk says so (#1798).
 *
 * `.html` is a supported extension that opened editable: `resolveAndValidatePath`
 * hardcoded `readOnly = false`. But `html` is in neither `AUTO_SAVE_FORMATS` nor
 * `BINARY_SAVE_FORMATS`, so `saveDocumentToDisk` refuses it — a POLICY exclusion,
 * not a missing adapter (`getAdapter("html")` returns `plaintextAdapter`, whose
 * `save` is the one `.txt` uses). So `tandem_edit` succeeded, the user saw the
 * change, `tandem_save` answered `saved: true, sessionOnly: true`, auto-save never
 * fired, and tab close deleted the session. `saved: true` was the load-bearing lie.
 *
 * Covered here: the derivation off the save sets (including the uppercase
 * extensions that defeated a `resolved.endsWith(".html")` predicate), the three
 * `sessionOnly` shapes now reporting `saved: false` with a machine-readable
 * `reason`, the read-only tool messages branching on saveability rather than
 * dictating one cause for the read-only `CHANGELOG.md` too, and — the case the
 * whole thing rests on — a `.md` positive control, because nothing in the tree
 * pinned the SUCCESS shape, so `saved: false` unconditionally would pass every
 * other case here while reporting failure for every real save.
 *
 * Annotations deliberately keep working on the read-only document (decision 2).
 * No read-only check exists on any annotation path; none should be added.
 *
 * The restore-inheritance case lives in `session-readonly-restore.test.ts` (it
 * owns restore-carries-`readOnly`), the gate re-keying in
 * `external-conflict.test.ts`, and the `saveDocumentToDisk` skip-code branch in
 * `document-service.test.ts` — see the note on each there.
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import fs from "fs/promises";
import os from "os";
import path from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../src/server/platform", async (importOriginal) => {
  const original = await importOriginal<typeof import("../../src/server/platform")>();
  const osMod = await import("os");
  const pathMod = await import("path");
  const cryptoMod = await import("crypto");
  const appDataDir = pathMod.join(
    osMod.tmpdir(),
    `tandem-test-html-readonly-${cryptoMod.randomUUID()}`,
  );
  process.env.TANDEM_APP_DATA_DIR = appDataDir;
  return { ...original, SESSION_DIR: pathMod.join(appDataDir, "sessions") };
});

// The real watcher would leave fs handles open across the suite.
vi.mock("../../src/server/file-watcher", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/server/file-watcher")>()),
  watchFile: vi.fn(),
  suppressNextChange: vi.fn(),
}));

import { openFromDisk } from "../../src/server/documents/open.js";
import { addDoc, setActiveDocId } from "../../src/server/documents/registry-testing.js";
import { registerAnnotationTools } from "../../src/server/mcp/annotations.js";
import { populateYDoc, registerDocumentTools } from "../../src/server/mcp/document.js";
import { SESSION_DIR } from "../../src/server/platform.js";
import { getOrCreateDocument } from "../../src/server/yjs/provider.js";
import {
  mayHoldUnsavedWork,
  Y_MAP_ANNOTATIONS,
  Y_MAP_DOCUMENT_META,
  Y_MAP_READ_ONLY,
  Y_MAP_SAVED_AT_VERSION,
} from "../../src/shared/constants.js";
import { withInternal } from "../../src/shared/origins.js";
import { clearOpenDocs } from "../helpers/doc-service.js";
import { buildDocxWithComments } from "../helpers/docx-fixtures.js";

let tmpDir: string;
let client: Client;

async function setupMcpClient(): Promise<Client> {
  const server = new McpServer({ name: "tandem-test", version: "0.0.1" });
  registerDocumentTools(server);
  registerAnnotationTools(server);
  const [ct, st] = InMemoryTransport.createLinkedPair();
  const c = new Client({ name: "test-client", version: "0.0.1" });
  await server.connect(st);
  await c.connect(ct);
  return c;
}

async function call(name: string, args: Record<string, unknown> = {}) {
  const res = await client.callTool({ name, arguments: args });
  const content = res.content as Array<{ type: string; text?: string }>;
  const text = content.find((c) => c.type === "text")?.text;
  return text ? JSON.parse(text) : null;
}

async function writeFixture(name: string, body: string): Promise<string> {
  const p = path.join(tmpDir, name);
  await fs.writeFile(p, body, "utf-8");
  return p;
}

/**
 * Register a document straight into the registry, bypassing `openFromDisk`'s
 * derivation. Used only where the point is a downstream branch's own behaviour
 * on a given (format, readOnly, source) triple — never for the derivation.
 */
function registerDoc(
  id: string,
  text: string,
  state: { filePath: string; format: string; readOnly: boolean; source?: "file" | "upload" },
) {
  const ydoc = getOrCreateDocument(id);
  populateYDoc(ydoc, text);
  addDoc(id, {
    id,
    filePath: state.filePath,
    format: state.format,
    readOnly: state.readOnly,
    source: state.source ?? "file",
  });
  setActiveDocId(id);
  return ydoc;
}

beforeEach(async () => {
  clearOpenDocs();
  vi.clearAllMocks();
  await fs.mkdir(SESSION_DIR, { recursive: true });
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "tandem-html-readonly-"));
  client = await setupMcpClient();
});

afterEach(async () => {
  clearOpenDocs();
  await fs.rm(SESSION_DIR, { recursive: true, force: true }).catch(() => {});
  await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
});

describe("#1798 — readOnly is derived from the save sets", () => {
  // Case 1. The uppercase arms are not decoration: `detectFormat` lowercases the
  // extension but a filename does not, so `resolved.endsWith(".html")` passes
  // every lowercase arm and reproduces #1798 verbatim on `Report.HTML`. The
  // `.docx` arm is the other half — without it, `readOnly = format !== "md"`
  // also passes.
  it.each([
    ["page.html", true],
    ["page.htm", true],
    ["Report.HTML", true],
    ["Page.HTM", true],
    ["notes.md", false],
    ["notes.txt", false],
  ])("%s opens readOnly=%s", async (name, expected) => {
    const filePath = await writeFixture(name, "body text");
    const opened = await openFromDisk(filePath);
    expect(opened.readOnly).toBe(expected);
    const meta = getOrCreateDocument(opened.documentId).getMap(Y_MAP_DOCUMENT_META);
    expect(meta.get(Y_MAP_READ_ONLY)).toBe(expected);
  });

  it(".docx opens writable — it is in BINARY_SAVE_FORMATS (#576)", async () => {
    // This arm is what kills `readOnly` keyed on AUTO_SAVE_FORMATS instead of
    // SAVEABLE_FORMATS: `.docx` is explicit-save-only, so the two sets disagree
    // about it and only SAVEABLE_FORMATS answers `false` here.
    const filePath = path.join(tmpDir, "report.docx");
    await fs.writeFile(filePath, await buildDocxWithComments(1));
    const opened = await openFromDisk(filePath);
    expect(opened.readOnly).toBe(false);
    const meta = getOrCreateDocument(opened.documentId).getMap(Y_MAP_DOCUMENT_META);
    expect(meta.get(Y_MAP_READ_ONLY)).toBe(false);
  });

  // Case 15. The upload disjunct is unreachable from both of the predicate's
  // callers — the restore gate is always passed the literal `source: "file"`,
  // and `openFromUpload` omits `wireFileWatcher`, so the watcher gate never sees
  // an upload. A direct unit call is the honest pin; an integration path would
  // have to fabricate a registry entry and would pin nothing. This kills both
  // mutants: deleting the clause, and `doc.readOnly && doc.format !== "html"`.
  it("mayHoldUnsavedWork: an uploaded .html stays in the reload-freely tier", () => {
    expect(mayHoldUnsavedWork({ readOnly: true, format: "html", source: "upload" })).toBe(false);
    // The disk `.html` — the tier the whole fix exists for.
    expect(mayHoldUnsavedWork({ readOnly: true, format: "html", source: "file" })).toBe(true);
    // Explicitly read-only and saveable: reload freely, as before.
    expect(mayHoldUnsavedWork({ readOnly: true, format: "md", source: "file" })).toBe(false);
    expect(mayHoldUnsavedWork({ readOnly: true, format: "docx", source: "file" })).toBe(false);
    // Writable documents are always in the protected tier.
    expect(mayHoldUnsavedWork({ readOnly: false, format: "md", source: "file" })).toBe(true);
  });
});

describe("#1798 — tools refuse the read-only .html with an honest reason", () => {
  async function openHtml(body = "<p>original</p>") {
    const filePath = await writeFixture("page.html", body);
    const opened = await openFromDisk(filePath);
    setActiveDocId(opened.documentId);
    return { filePath, opened };
  }

  // Case 3.
  it("tandem_edit refuses, naming the format and not .docx", async () => {
    await openHtml();
    const r = await call("tandem_edit", { from: 0, to: 4, newText: "X" });
    expect(r.error).toBe(true);
    expect(r.message).toContain("html");
    expect(r.message).toContain("cannot be written back to disk");
    expect(r.message).not.toContain(".docx");
  });

  // Case 12's tool-surface twin. The gate is on `readOnly` ALONE, so one
  // dictated cause would tell every read-only CHANGELOG that `md` is unwritable.
  it("tandem_edit on a read-only .md states the fact and fabricates no cause", async () => {
    const filePath = await writeFixture("CHANGELOG.md", "# Changelog\n\nEntry.\n");
    const opened = await openFromDisk(filePath, { readOnly: true });
    setActiveDocId(opened.documentId);
    const r = await call("tandem_edit", { from: 0, to: 1, newText: "X" });
    expect(r.error).toBe(true);
    expect(r.message).toContain("read-only");
    expect(r.message).not.toContain("cannot be written back to disk");
    expect(r.message).not.toContain(".docx");
  });

  // Case 4 — decision 2's pin. Annotating is the whole point of opening an
  // `.html` at all, and no read-only check exists on any annotation path.
  it("annotations still work on the read-only .html", async () => {
    const { opened } = await openHtml("<p>annotate me please</p>");
    const c = await call("tandem_comment", { from: 0, to: 8, text: "a comment" });
    expect(c.error).toBe(false);
    const annotations = getOrCreateDocument(opened.documentId).getMap(Y_MAP_ANNOTATIONS);
    expect(annotations.size).toBe(1);
    const [annotationId] = [...annotations.keys()];
    const reply = await call("tandem_annotationReply", { annotationId, text: "a reply" });
    expect(reply.error).toBe(false);
  });

  // Case 8.
  it("tandem_rename refuses the read-only .html with READ_ONLY", async () => {
    await openHtml();
    const r = await call("tandem_rename", { newName: "renamed.html" });
    expect(r.error).toBe(true);
    expect(r.code).toBe("READ_ONLY");
  });
});

describe("#1798 — tandem_save reports what actually reached disk", () => {
  // Case 5. The read-only branch still calls `saveSession`, which writes in the
  // session dir — so the unchanged-bytes assertion is scoped to the DOCUMENT
  // path. Documentation of the user-visible fact; case 9 is the discriminator.
  it("an .html save answers saved:false / UNSUPPORTED_FORMAT and leaves the file alone", async () => {
    const filePath = await writeFixture("page.html", "<p>original</p>");
    const before = await fs.stat(filePath);
    const opened = await openFromDisk(filePath);
    setActiveDocId(opened.documentId);

    const r = await call("tandem_save", {});
    expect(r.error).toBe(false);
    expect(r.data.saved).toBe(false);
    expect(r.data.sessionOnly).toBe(true);
    expect(r.data.reason).toBe("UNSUPPORTED_FORMAT");
    expect(r.data.message).toContain("cannot be written back to disk");

    const after = await fs.stat(filePath);
    expect(await fs.readFile(filePath, "utf-8")).toBe("<p>original</p>");
    expect(after.mtimeMs).toBe(before.mtimeMs);
  });

  // Case 12. The read-only branch has two tiers and reports them apart.
  it("a read-only .md save answers saved:false / read-only, not UNSUPPORTED_FORMAT", async () => {
    const filePath = await writeFixture("CHANGELOG.md", "# Changelog\n");
    const opened = await openFromDisk(filePath, { readOnly: true });
    setActiveDocId(opened.documentId);

    const r = await call("tandem_save", {});
    expect(r.data.saved).toBe(false);
    expect(r.data.sessionOnly).toBe(true);
    expect(r.data.reason).toBe("read-only");
    expect(r.data.message).not.toContain("cannot be written back to disk");
  });

  // Case 7.
  it("an upload answers saved:false / upload", async () => {
    registerDoc("upl-1", "uploaded body", {
      filePath: "upload://uploaded.md",
      format: "md",
      readOnly: false,
      source: "upload",
    });
    const r = await call("tandem_save", {});
    expect(r.data.saved).toBe(false);
    expect(r.data.sessionOnly).toBe(true);
    expect(r.data.reason).toBe("upload");
  });

  // Case 6. The skip branch forwards `skipCode` VERBATIM, so it has to be driven
  // through a code that is not UNSUPPORTED_FORMAT — otherwise a hardcoded
  // literal passes both this and case 5.
  it("the skip branch forwards skipCode verbatim (FILE_MODIFIED)", async () => {
    const filePath = await writeFixture("moved.md", "# Body\n");
    const ydoc = registerDoc("skip-1", "# Body\n", {
      filePath,
      format: "md",
      readOnly: false,
    });
    // Claim the last save happened well in the past; the file's own mtime is
    // now, which trips the >1s external-modification guard.
    withInternal(ydoc, () => {
      ydoc.getMap(Y_MAP_DOCUMENT_META).set(Y_MAP_SAVED_AT_VERSION, Date.now() - 60_000);
    });

    const r = await call("tandem_save", {});
    expect(r.data.saved).toBe(false);
    expect(r.data.sessionOnly).toBe(true);
    expect(r.data.reason).toBe("FILE_MODIFIED");
  });

  // Case 9 — THE POSITIVE CONTROL. Nothing in the tree pinned the success shape,
  // so `saved: false` unconditionally passes every case above while reporting
  // failure for every real save.
  it("a writable .md save answers saved:true with no sessionOnly and no reason", async () => {
    const filePath = await writeFixture("notes.md", "# Notes\n\nBody.\n");
    const opened = await openFromDisk(filePath);
    setActiveDocId(opened.documentId);

    const r = await call("tandem_save", {});
    expect(r.error).toBe(false);
    expect(r.data.saved).toBe(true);
    expect(r.data.sessionOnly).toBeUndefined();
    expect(r.data.reason).toBeUndefined();
  });
});
