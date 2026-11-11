/**
 * What each write tool leaves behind, row by row (#2358, ADR-054; ownership
 * design §5.1). Flag on for the whole file; every caller is a real owner
 * record, because only a record can claim.
 *
 * Three tables:
 *
 * 1. **A refusal decided by the arguments, or by a fact fixed at open, never
 *    claims.** One row per tool and refusal, each run by a registered record
 *    on a document nobody holds: the code is today's, and afterwards the
 *    document is still unowned and no loss was recorded. Some rows are
 *    answered before the queue and some inside the operation, where a claim
 *    was possible and is never applied (PR 2a; until then it was applied at
 *    the check and undone); the table does not care which. Marked in the
 *    source but not rowed, because no fixture here reaches them: the
 *    "not open" answers inside a body (the document closed while the call
 *    waited; `ownership-enforcement.test.ts` has that case), `markdown` that
 *    parses to no list items, and `renameDocument`'s `INVALID_PATH` (a
 *    UNC-shaped target, which a test should not create or touch).
 *    `renameDocument`'s `PATH_REJECTED` is decided by the disk
 *    (`assertPathSafe` walks it), so it is NOT marked and keeps the claim:
 *    it has its own row below, made with a symlink at the destination. The rule is by
 *    what decides the refusal, not by its code: `INVALID_RANGE` for an
 *    inverted, fractional, negative or empty range leaves no claim, while
 *    `INVALID_RANGE` for an offset past the end keeps one (the control test
 *    below). One refusal is decided by the arguments and still keeps the
 *    claim, because its code is shared with a disk lookup:
 *    `tandem_restoreBackup` with a malformed `backup` name answers
 *    `FILE_NOT_FOUND`, the same as a well-formed name that is not on disk.
 *    The table can only confirm marks that were made; it cannot find one
 *    that is missing. And a row answered before any claim is attempted
 *    (preflight, an id the document does not hold, an ambiguous id) passes
 *    with or without its mark. So the marks themselves are pinned from
 *    source, below: every `noClaim(` site and every member of
 *    `RENAME_NEVER_CLAIMS`, against a reviewed list.
 * 2. **The same refusals do not disturb a claim the caller already held.**
 * 3. **The holder's own call succeeds through every write tool**, does what
 *    the tool does, to the document that was named, and leaves the holder
 *    holding it. `ownership-enforcement.test.ts` has the other half: the same
 *    tools refuse every other record.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as Y from "yjs";
import { openFromDisk } from "../../src/server/documents/open.js";
import { addDoc, removeDoc, setActiveDocId } from "../../src/server/documents/registry-testing.js";
import { unwatchFile } from "../../src/server/file-watcher.js";
import { registerAnnotationTools } from "../../src/server/mcp/annotations.js";
import { populateYDoc, registerDocumentTools } from "../../src/server/mcp/document.js";
import { getActiveDocId, getOpenDocs } from "../../src/server/mcp/document-service.js";
import { registerApplyTools } from "../../src/server/mcp/docx-apply.js";
import { ownedOpen } from "../../src/server/mcp/owned-op.js";
import { TOOL_MODES } from "../../src/server/mcp/tool-modes.js";
import {
  getDocOwner,
  noteTransportRegistered,
  ownershipSnapshotForTests,
  resetOwnershipForTests,
  setDocOwner,
  setTransportView,
  type TransportViewEntry,
} from "../../src/server/sessions/ownership.js";
import { getOrCreateDocument } from "../../src/server/yjs/provider.js";
import { Y_MAP_ANNOTATION_REPLIES, Y_MAP_ANNOTATIONS } from "../../src/shared/constants.js";
import { withInternal } from "../../src/shared/origins.js";
import { parseResult, setupMcpServer } from "../helpers/mcp-harness.js";
import { asTestCaller } from "../helpers/ownership-caller.js";
import { timeoutMs } from "../helpers/timing.js";
import { createMinimalDocx, seedAcceptedSuggestion } from "../helpers/wire-code-fixtures.js";

const A = "claude:table-a";
const B = "claude:table-b";

/** `tandem_applyChanges` rewrites a real .docx; slow on a loaded Windows runner. */
const REAL_DOCX_TIMEOUT_MS = timeoutMs(60_000, 300_000);

let client: Client;
let close: (() => Promise<void>) | undefined;
let callingAs = A;
let run = 0;
let prefix = "";
let tmpDir = "";

const docId = (name: string) => `${prefix}-${name}`;

type Body = {
  error: boolean;
  code?: string;
  message?: string;
  details?: Record<string, unknown>;
  data?: Record<string, unknown>;
};

async function as(owner: string, tool: string, args: Record<string, unknown> = {}): Promise<Body> {
  callingAs = owner;
  return parseResult(await client.callTool({ name: tool, arguments: args })) as Body;
}

interface DocOpts {
  text?: string;
  format?: string;
  readOnly?: boolean;
  source?: "file" | "upload";
  filePath?: string;
}

/** An open document nobody holds, registered directly (no file behind it unless `filePath` says so). */
function memDoc(name: string, opts: DocOpts = {}): { id: string; ydoc: Y.Doc } {
  const id = docId(name);
  const ydoc = getOrCreateDocument(id);
  populateYDoc(ydoc, opts.text ?? "Hello world, this is a test document.");
  const format = opts.format ?? "md";
  addDoc(id, {
    id,
    filePath:
      opts.filePath ??
      (opts.source === "upload"
        ? `upload://${id}/pasted.${format}`
        : path.join(tmpDir, `${id}.${format}`)),
    format,
    readOnly: opts.readOnly ?? false,
    source: opts.source ?? "file",
  });
  return { id, ydoc };
}

/** A real file, opened by the open path's own code (so lists are lists), held by nobody. */
async function diskDoc(name: string, text: string): Promise<{ id: string; filePath: string }> {
  const filePath = path.join(tmpDir, name);
  fs.writeFileSync(filePath, text);
  const opened = await openFromDisk(filePath);
  return { id: opened.documentId, filePath };
}

function seed(ydoc: Y.Doc, id: string, extra: Record<string, unknown> = {}): void {
  withInternal(ydoc, () =>
    ydoc.getMap(Y_MAP_ANNOTATIONS).set(id, {
      id,
      author: "claude",
      type: "comment",
      audience: "outbound",
      range: { from: 0, to: 5 },
      content: "original",
      status: "pending",
      timestamp: 1000,
      rev: 1,
      ...extra,
    }),
  );
}

const text = (ydoc: Y.Doc) => ydoc.getXmlFragment("default").toString();

beforeEach(async () => {
  vi.stubEnv("TANDEM_OWNERSHIP", "1");
  run++;
  prefix = `tbl${run}`;
  callingAs = A;
  for (const id of [...getOpenDocs().keys()]) removeDoc(id);
  const view: TransportViewEntry[] = [
    { ownerId: A, openStreams: 1 },
    { ownerId: B, openStreams: 1 },
  ];
  setTransportView(() => view);
  noteTransportRegistered(A, { recordKind: "claude" });
  noteTransportRegistered(B, { recordKind: "claude" });
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "tandem-claims-"));
  ({ client, close } = await setupMcpServer(
    [registerDocumentTools, registerAnnotationTools, registerApplyTools],
    { dispatch: (fn) => asTestCaller(fn, { ownerId: callingAs }) },
  ));
});

afterEach(async () => {
  await close?.();
  close = undefined;
  // Close the watches the real opens started before removing their files.
  for (const d of getOpenDocs().values()) if (d.source === "file") unwatchFile(d.filePath);
  for (const id of [...getOpenDocs().keys()]) removeDoc(id);
  resetOwnershipForTests();
  fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  vi.unstubAllEnvs();
});

interface RefusalRow {
  tool: string;
  what: string;
  /** Build the document; return its id and the call's arguments. */
  arrange: () =>
    | Promise<{ id: string; args: Record<string, unknown> }>
    | {
        id: string;
        args: Record<string, unknown>;
      };
  code: string;
}

const NOTE = { type: "note", audience: "private", author: "user" };

const REFUSALS: RefusalRow[] = [
  // --- tandem_edit ---------------------------------------------------------
  {
    tool: "tandem_edit",
    what: "a read-only document",
    arrange: () => {
      const { id } = memDoc("d", { format: "html", readOnly: true });
      return { id, args: { from: 0, to: 5, newText: "x", documentId: id } };
    },
    code: "READ_ONLY",
  },
  {
    tool: "tandem_edit",
    what: "a newline into a plain-text document",
    arrange: () => {
      const { id } = memDoc("d", { format: "txt" });
      return { id, args: { from: 0, to: 5, newText: "a\nb", documentId: id } };
    },
    code: "INVALID_ARGUMENT",
  },
  {
    tool: "tandem_edit",
    what: "an empty range with an empty newText (nothing to do)",
    arrange: () => {
      const { id } = memDoc("d");
      return { id, args: { from: 3, to: 3, newText: "", documentId: id } };
    },
    code: "INVALID_RANGE",
  },
  {
    tool: "tandem_edit",
    what: "a point insertion that carries a textSnapshot",
    arrange: () => {
      const { id } = memDoc("d");
      return { id, args: { from: 3, to: 3, newText: "x", textSnapshot: "lo", documentId: id } };
    },
    code: "INVALID_ARGUMENT",
  },
  {
    tool: "tandem_edit",
    what: "an inverted range",
    arrange: () => {
      const { id } = memDoc("d");
      return { id, args: { from: 5, to: 2, newText: "x", documentId: id } };
    },
    code: "INVALID_RANGE",
  },
  {
    tool: "tandem_edit",
    what: "a negative offset",
    arrange: () => {
      const { id } = memDoc("d");
      return { id, args: { from: -3, to: 2, newText: "x", documentId: id } };
    },
    code: "INVALID_RANGE",
  },
  // --- tandem_comment ------------------------------------------------------
  {
    tool: "tandem_comment",
    what: "an inverted range",
    arrange: () => {
      const { id } = memDoc("d");
      return { id, args: { from: 5, to: 2, text: "c", documentId: id } };
    },
    code: "INVALID_RANGE",
  },
  {
    tool: "tandem_comment",
    what: "a negative offset",
    arrange: () => {
      const { id } = memDoc("d");
      return { id, args: { from: -3, to: 2, text: "c", documentId: id } };
    },
    code: "INVALID_RANGE",
  },
  {
    tool: "tandem_comment",
    what: "an empty range",
    arrange: () => {
      const { id } = memDoc("d");
      return { id, args: { from: 3, to: 3, text: "c", documentId: id } };
    },
    code: "INVALID_RANGE",
  },
  // --- tandem_editList -----------------------------------------------------
  {
    tool: "tandem_editList",
    what: "a fractional offset",
    arrange: async () => {
      const { id } = await diskDoc("list.md", "- one\n- two\n");
      return { id, args: { at: 1.5, op: "remove", documentId: id } };
    },
    code: "INVALID_RANGE",
  },
  {
    tool: "tandem_editList",
    what: "a negative offset",
    arrange: async () => {
      const { id } = await diskDoc("list.md", "- one\n- two\n");
      return { id, args: { at: -1, op: "remove", documentId: id } };
    },
    code: "INVALID_RANGE",
  },
  {
    tool: "tandem_editList",
    what: "a read-only document",
    arrange: () => {
      const { id } = memDoc("d", { format: "html", readOnly: true });
      return { id, args: { at: 0, op: "remove", documentId: id } };
    },
    code: "READ_ONLY",
  },
  {
    tool: "tandem_editList",
    what: "a plain-text document",
    arrange: () => {
      const { id } = memDoc("d", { format: "txt" });
      return { id, args: { at: 0, op: "remove", documentId: id } };
    },
    code: "FORMAT_ERROR",
  },
  {
    tool: "tandem_editList",
    what: "setChecked with no `checked`",
    arrange: async () => {
      const { id } = await diskDoc("list.md", "- one\n- two\n");
      return { id, args: { at: 0, op: "setChecked", documentId: id } };
    },
    code: "INVALID_ARGUMENT",
  },
  {
    tool: "tandem_editList",
    what: "setChecked on a .docx list",
    arrange: async () => {
      // A real list, registered as a .docx (a .docx list has no checkbox state).
      const { id, filePath } = await diskDoc("list.md", "- one\n- two\n");
      addDoc(id, { id, filePath, format: "docx", readOnly: false, source: "file" });
      return { id, args: { at: 0, op: "setChecked", checked: true, documentId: id } };
    },
    code: "FORMAT_ERROR",
  },
  {
    tool: "tandem_editList",
    what: "insertAfter with no `markdown`",
    arrange: async () => {
      const { id } = await diskDoc("list.md", "- one\n- two\n");
      return { id, args: { at: 0, op: "insertAfter", documentId: id } };
    },
    code: "INVALID_ARGUMENT",
  },
  {
    tool: "tandem_editList",
    what: "`markdown` over the size limit",
    arrange: async () => {
      const { id } = await diskDoc("list.md", "- one\n- two\n");
      return {
        id,
        args: { at: 0, op: "insertAfter", markdown: "x".repeat(1_000_001), documentId: id },
      };
    },
    code: "FILE_TOO_LARGE",
  },
  // --- tandem_appendContent ------------------------------------------------
  {
    tool: "tandem_appendContent",
    what: "a read-only document",
    arrange: () => {
      const { id } = memDoc("d", { format: "html", readOnly: true });
      return { id, args: { content: "x", documentId: id } };
    },
    code: "READ_ONLY",
  },
  {
    tool: "tandem_appendContent",
    what: "a plain-text document",
    arrange: () => {
      const { id } = memDoc("d", { format: "txt" });
      return { id, args: { content: "x", documentId: id } };
    },
    code: "FORMAT_ERROR",
  },
  {
    tool: "tandem_appendContent",
    what: "content over the size limit",
    arrange: () => {
      const { id } = memDoc("d");
      return { id, args: { content: "x".repeat(1_000_001), documentId: id } };
    },
    code: "FILE_TOO_LARGE",
  },
  // --- tandem_rename -------------------------------------------------------
  {
    tool: "tandem_rename",
    what: "an empty name",
    arrange: () => {
      const { id } = memDoc("d");
      return { id, args: { newName: "", documentId: id } };
    },
    code: "INVALID_NAME",
  },
  {
    tool: "tandem_rename",
    what: "a name with another extension",
    arrange: async () => {
      const { id } = await diskDoc("a.md", "Body.\n");
      return { id, args: { newName: "a.txt", documentId: id } };
    },
    code: "EXTENSION_MISMATCH",
  },
  {
    tool: "tandem_rename",
    what: "an uploaded document",
    arrange: () => {
      const { id } = memDoc("d", { source: "upload" });
      return { id, args: { newName: "n.md", documentId: id } };
    },
    code: "NOT_RENAMABLE",
  },
  {
    tool: "tandem_rename",
    what: "a read-only document",
    arrange: async () => {
      const { id } = await diskDoc("ro.html", "<p>Body.</p>\n");
      return { id, args: { newName: "n.html", documentId: id } };
    },
    code: "READ_ONLY",
  },
  // --- tandem_convertToMarkdown --------------------------------------------
  {
    tool: "tandem_convertToMarkdown",
    what: "a document that is not a .docx",
    arrange: () => {
      const { id } = memDoc("d");
      return { id, args: { documentId: id } };
    },
    code: "FORMAT_ERROR",
  },
  {
    tool: "tandem_convertToMarkdown",
    what: "a UNC output directory",
    arrange: () => {
      const { id } = memDoc("d", { format: "docx" });
      return { id, args: { outputPath: "//server/share", documentId: id } };
    },
    code: "INVALID_PATH",
  },
  // --- tandem_applyChanges -------------------------------------------------
  {
    tool: "tandem_applyChanges",
    what: "a document that is not a .docx",
    arrange: () => {
      const { id } = memDoc("d");
      return { id, args: { documentId: id } };
    },
    code: "FORMAT_ERROR",
  },
  {
    tool: "tandem_applyChanges",
    what: "a UNC backupPath",
    arrange: () => {
      const { id } = memDoc("d", { format: "docx" });
      return { id, args: { backupPath: "//server/share/b.docx", documentId: id } };
    },
    code: "INVALID_PATH",
  },
  {
    tool: "tandem_applyChanges",
    what: "an uploaded .docx",
    arrange: () => {
      const { id } = memDoc("d", { format: "docx", source: "upload" });
      return { id, args: { documentId: id } };
    },
    code: "INVALID_PATH",
  },
  {
    tool: "tandem_applyChanges",
    what: "a read-only .docx",
    arrange: () => {
      const { id } = memDoc("d", { format: "docx", readOnly: true });
      return { id, args: { documentId: id } };
    },
    code: "READ_ONLY",
  },
  // --- tandem_restoreBackup (restore mode) ---------------------------------
  {
    tool: "tandem_restoreBackup",
    what: "an uploaded document",
    arrange: () => {
      const { id } = memDoc("d", { source: "upload" });
      return { id, args: { backup: "x", documentId: id } };
    },
    code: "INVALID_PATH",
  },
  {
    tool: "tandem_restoreBackup",
    what: "a writable .html",
    arrange: () => {
      const { id } = memDoc("d", { format: "html" });
      return { id, args: { backup: "x", documentId: id } };
    },
    code: "FORMAT_ERROR",
  },
  {
    tool: "tandem_restoreBackup",
    what: "a read-only document",
    arrange: () => {
      const { id } = memDoc("d", { readOnly: true });
      return { id, args: { backup: "x", documentId: id } };
    },
    code: "READ_ONLY",
  },
  // --- tandem_resolveAnnotation --------------------------------------------
  {
    tool: "tandem_resolveAnnotation",
    what: "an id the document does not hold",
    arrange: () => {
      const { id } = memDoc("d");
      return { id, args: { id: "missing", action: "dismiss", documentId: id } };
    },
    code: "NOT_FOUND",
  },
  {
    tool: "tandem_resolveAnnotation",
    what: "a private note",
    arrange: () => {
      const { id, ydoc } = memDoc("d");
      seed(ydoc, "ann", NOTE);
      return { id, args: { id: "ann", action: "dismiss", documentId: id } };
    },
    code: "INVALID_ARGUMENT",
  },
  {
    tool: "tandem_resolveAnnotation",
    what: "an annotation that is already resolved",
    arrange: () => {
      const { id, ydoc } = memDoc("d");
      seed(ydoc, "ann", { status: "dismissed" });
      return { id, args: { id: "ann", action: "dismiss", documentId: id } };
    },
    code: "ANNOTATION_RESOLVED",
  },
  {
    tool: "tandem_resolveAnnotation",
    what: "accepting Claude's own annotation",
    arrange: () => {
      const { id, ydoc } = memDoc("d");
      seed(ydoc, "ann");
      return { id, args: { id: "ann", action: "accept", documentId: id } };
    },
    code: "ACCEPT_REFUSED",
  },
  // --- tandem_removeAnnotation ---------------------------------------------
  {
    tool: "tandem_removeAnnotation",
    what: "an id the document does not hold",
    arrange: () => {
      const { id } = memDoc("d");
      return { id, args: { id: "missing", documentId: id } };
    },
    code: "NOT_FOUND",
  },
  {
    tool: "tandem_removeAnnotation",
    what: "a private note",
    arrange: () => {
      const { id, ydoc } = memDoc("d");
      seed(ydoc, "ann", NOTE);
      return { id, args: { id: "ann", documentId: id } };
    },
    code: "INVALID_ARGUMENT",
  },
  // --- tandem_editAnnotation -----------------------------------------------
  {
    tool: "tandem_editAnnotation",
    what: "an id the document does not hold",
    arrange: () => {
      const { id } = memDoc("d");
      return { id, args: { id: "missing", content: "x", documentId: id } };
    },
    code: "NOT_FOUND",
  },
  {
    tool: "tandem_editAnnotation",
    what: "a private note",
    arrange: () => {
      const { id, ydoc } = memDoc("d");
      seed(ydoc, "ann", NOTE);
      return { id, args: { id: "ann", content: "x", documentId: id } };
    },
    code: "INVALID_ARGUMENT",
  },
  {
    tool: "tandem_editAnnotation",
    what: "the user's annotation",
    arrange: () => {
      const { id, ydoc } = memDoc("d");
      seed(ydoc, "ann", { author: "user" });
      return { id, args: { id: "ann", content: "x", documentId: id } };
    },
    code: "NOT_OWNED",
  },
  {
    tool: "tandem_editAnnotation",
    what: "a resolved annotation",
    arrange: () => {
      const { id, ydoc } = memDoc("d");
      seed(ydoc, "ann", { status: "accepted" });
      return { id, args: { id: "ann", content: "x", documentId: id } };
    },
    code: "ANNOTATION_RESOLVED",
  },
  {
    tool: "tandem_editAnnotation",
    what: "no editable field",
    arrange: () => {
      const { id, ydoc } = memDoc("d");
      seed(ydoc, "ann");
      return { id, args: { id: "ann", documentId: id } };
    },
    code: "INVALID_ARGUMENT",
  },
  {
    tool: "tandem_editAnnotation",
    what: "replacement text on an annotation that is not a comment",
    arrange: () => {
      const { id, ydoc } = memDoc("d");
      seed(ydoc, "ann", { type: "highlight" });
      return { id, args: { id: "ann", newText: "x", documentId: id } };
    },
    code: "INVALID_ARGUMENT",
  },
  {
    tool: "tandem_editAnnotation",
    what: "replacement text over heading markup",
    arrange: async () => {
      const { id } = await diskDoc("h.md", "Para one\n\n## Head\n\nTail\n");
      seed(getOrCreateDocument(id), "ann", { range: { from: 4, to: 13 }, suggestedText: "y" });
      return { id, args: { id: "ann", newText: "x", documentId: id } };
    },
    code: "INVALID_ARGUMENT",
  },
  {
    tool: "tandem_editAnnotation",
    what: "an id in two open documents",
    arrange: () => {
      const { id, ydoc } = memDoc("d");
      seed(ydoc, "dup");
      seed(memDoc("second").ydoc, "dup");
      return { id, args: { id: "dup", content: "x" } };
    },
    code: "INVALID_ARGUMENT",
  },
  // --- tandem_annotationReply ----------------------------------------------
  {
    tool: "tandem_annotationReply",
    what: "an id the document does not hold",
    arrange: () => {
      const { id } = memDoc("d");
      return { id, args: { annotationId: "missing", text: "r", documentId: id } };
    },
    code: "NOT_FOUND",
  },
  {
    tool: "tandem_annotationReply",
    what: "a private note",
    arrange: () => {
      const { id, ydoc } = memDoc("d");
      seed(ydoc, "ann", NOTE);
      return { id, args: { annotationId: "ann", text: "r", documentId: id } };
    },
    code: "INVALID_ARGUMENT",
  },
  {
    tool: "tandem_annotationReply",
    what: "a resolved annotation",
    arrange: () => {
      const { id, ydoc } = memDoc("d");
      seed(ydoc, "ann", { status: "dismissed" });
      return { id, args: { annotationId: "ann", text: "r", documentId: id } };
    },
    code: "ANNOTATION_RESOLVED",
  },
];

const nothingHeld = () => {
  const snap = ownershipSnapshotForTests();
  expect(snap.ownerByDoc, "a refused call left an ownership entry").toEqual([]);
  expect(snap.losses, "a refused call left a loss record").toEqual([]);
  expect(snap.answerers, "a refused call recorded an answerer").toBe(0);
  expect(snap.queuedDocuments, "a refused call left a queue behind").toBe(0);
  expect(snap.pendingClaims, "a refused call left a pending claim").toBe(0);
};

describe("a refusal decided by the arguments or by a fact fixed at open (ownership design §5.1)", () => {
  it("the table has a row for every write tool that can give one", () => {
    const writes = Object.entries(TOOL_MODES)
      .filter(([, entry]) => entry.mode === "write")
      .map(([name]) => name);
    // `tandem_save` and `tandem_close` have no such refusal on an open
    // document: every one of theirs is decided by the disk or the save lock
    // (and keeps the claim), or is "not open".
    const none = ["tandem_close", "tandem_save"];
    expect([...new Set(REFUSALS.map((r) => r.tool)), ...none].sort()).toEqual(writes.sort());
  });

  it.each(REFUSALS)("$tool — $what: $code, and the document stays unowned", async (row) => {
    const { id, args } = await row.arrange();
    setActiveDocId(id);
    const before = text(getOrCreateDocument(id));

    const body = await as(A, row.tool, args);

    expect(body.code, JSON.stringify(body)).toBe(row.code);
    expect(getDocOwner(id)).toBeUndefined();
    nothingHeld();
    expect(text(getOrCreateDocument(id))).toBe(before);
    // And the next record is not refused on the strength of it.
    const reader = await as(B, "tandem_comment", { from: 0, to: 2, text: "c", documentId: id });
    expect(reader.code).not.toBe("NOT_DOC_OWNER");
  });

  it("control: the same code decided by live content keeps the claim", async () => {
    const { id } = memDoc("d");
    const past = await as(A, "tandem_edit", { from: 9000, to: 9005, newText: "x", documentId: id });
    expect(past.code).toBe("INVALID_RANGE");
    expect(getDocOwner(id)).toMatchObject({ ownerId: A, kind: "claimed" });
    const { id: second } = memDoc("second");
    const comment = await as(A, "tandem_comment", {
      from: 9000,
      to: 9005,
      text: "c",
      documentId: second,
    });
    expect(comment.code).toBe("INVALID_RANGE");
    expect(getDocOwner(second)).toMatchObject({ ownerId: A, kind: "claimed" });
    const { id: listed } = await diskDoc("list.md", "- one\n- two\n");
    const beyond = await as(A, "tandem_editList", { at: 9000, op: "remove", documentId: listed });
    expect(beyond.code).toBe("INVALID_RANGE");
    expect(getDocOwner(listed)).toMatchObject({ ownerId: A, kind: "claimed" });
    // A malformed backup name shares its code with a disk lookup (see the header).
    const { id: backed } = await diskDoc("b.md", "Body.\n");
    const missing = await as(A, "tandem_restoreBackup", { backup: "x", documentId: backed });
    expect(missing.code).toBe("FILE_NOT_FOUND");
    expect(getDocOwner(backed)).toMatchObject({ ownerId: A, kind: "claimed" });
  });

  // `PATH_REJECTED` needs a symlink at the rename's destination. Making one
  // on Windows needs Developer Mode or elevation, so there the row runs only
  // where a probe link can be made; everywhere else it always runs, and a
  // failed `symlinkSync` fails it rather than skipping it. Linux CI (`check`
  // and `ownership-flag-on`) is what covers it.
  const canSymlink = ((): boolean => {
    if (process.platform !== "win32") return true;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tandem-symlink-probe-"));
    try {
      fs.symlinkSync(path.join(dir, "target"), path.join(dir, "link"));
      return true;
    } catch {
      return false;
    } finally {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  })();

  it.skipIf(!canSymlink)(
    "a rename refused by a symlink at the destination (PATH_REJECTED) is decided by the disk, so it keeps the claim",
    async () => {
      const { id, filePath } = await diskDoc("linked-from.md", "Body.\n");
      // Dangling on purpose: nothing is read or written through it.
      fs.symlinkSync(path.join(tmpDir, "nowhere.md"), path.join(tmpDir, "linked-to.md"));
      const body = await as(A, "tandem_rename", { newName: "linked-to.md", documentId: id });
      expect(body.code, JSON.stringify(body)).toBe("PATH_REJECTED");
      expect(fs.existsSync(filePath)).toBe(true);
      expect(getDocOwner(id)).toMatchObject({ ownerId: A, kind: "claimed" });
      const other = await as(B, "tandem_comment", { from: 0, to: 2, text: "c", documentId: id });
      expect(other.code).toBe("NOT_DOC_OWNER");
    },
  );

  it.each(REFUSALS)("$tool — $what: a claim the caller already held is kept", async (row) => {
    const { id, args } = await row.arrange();
    setActiveDocId(id);
    setDocOwner(id, { ownerId: A, kind: "claimed" }, "claim");
    const entry = getDocOwner(id);

    const body = await as(A, row.tool, args);

    expect(body.code, JSON.stringify(body)).toBe(row.code);
    // The very entry, not a re-made one: nothing was written over it.
    expect(getDocOwner(id)).toBe(entry);
  });
});

/**
 * Every `noClaim(` in each tool file, in source order: the code it marks,
 * `<noDocumentError>` for the shared not-open answer, `<refused>` where the
 * mark is conditional (a range refusal decided by the offsets; a
 * `renameDocument` refusal in `RENAME_NEVER_CLAIMS`), `<mcpError>` for the
 * reply seam's refusal, whose code is computed. A mark added, dropped or
 * moved changes the list; review the change against ownership design §5.1.
 *
 * What this pin cannot see:
 * - a refusal that should be marked and is not (it lists marks that exist);
 * - a changed condition on a `<refused>` site. The control test covers the
 *   three range sites. For rename, the member list below pins which codes
 *   are in the set, not the condition at the mark: a condition that excluded
 *   a member, or stopped consulting the set, passes here, and only the rename
 *   rows of the table (which run four of the six members) and the
 *   `PATH_REJECTED` row would notice;
 * - anything after the first code inside one `noClaim(...)`: a ternary's
 *   second arm is not read;
 * - a mark moved between two neighbouring refusals with the same code;
 * - a mark made some other way than a plain `noClaim(` call in `src/server`.
 * And it counts text it should not: a `noClaim(` inside a comment is listed
 * as a mark, and a member of `RENAME_NEVER_CLAIMS` that is commented out
 * inside the set's brackets is still read as a member.
 */
const DOCUMENT_MARKS = [
  "<noDocumentError>",
  "READ_ONLY",
  "INVALID_ARGUMENT",
  "<noDocumentError>",
  "READ_ONLY",
  "FORMAT_ERROR",
  "<noDocumentError>",
  "INVALID_RANGE",
  "INVALID_ARGUMENT",
  "<refused>",
  "<noDocumentError>",
  "<refused>",
  "INVALID_ARGUMENT",
  "FORMAT_ERROR",
  "INVALID_ARGUMENT",
  "FILE_TOO_LARGE",
  "INVALID_ARGUMENT",
  "<noDocumentError>",
  "READ_ONLY",
  "FORMAT_ERROR",
  "FILE_TOO_LARGE",
  "<noDocumentError>",
  "<noDocumentError>",
  "NO_DOCUMENT",
  "NO_DOCUMENT",
  "INVALID_NAME",
  "NO_DOCUMENT",
  "BAD_REQUEST",
  "INVALID_NAME",
  "<refused>",
  "NO_DOCUMENT",
  "INVALID_PATH",
  "FORMAT_ERROR",
];

const ANNOTATION_MARKS = [
  "<noDocumentError>",
  "INVALID_ARGUMENT",
  "<noDocumentError>",
  "<refused>",
  "NOT_FOUND",
  "INVALID_ARGUMENT",
  "ANNOTATION_RESOLVED",
  "ACCEPT_REFUSED",
  "NOT_FOUND",
  "INVALID_ARGUMENT",
  "NOT_FOUND",
  "INVALID_ARGUMENT",
  "NOT_OWNED",
  "ANNOTATION_RESOLVED",
  "INVALID_ARGUMENT",
  "INVALID_ARGUMENT",
  "INVALID_ARGUMENT",
  "<mcpError>",
];

const DOCX_MARKS = [
  "<noDocumentError>",
  "FORMAT_ERROR",
  "INVALID_PATH",
  "READ_ONLY",
  "<noDocumentError>",
  "<noDocumentError>",
  "INVALID_PATH",
  "FORMAT_ERROR",
  "READ_ONLY",
];

describe("the never-claims marks, pinned from source", () => {
  const read = (file: string) =>
    fs.readFileSync(path.join(process.cwd(), "src/server/mcp", file), "utf8");

  /**
   * What each `noClaim(` wraps, in source order: the error code of the
   * `mcpError(` it marks, or the helper or variable it is handed.
   */
  function marks(file: string): string[] {
    const src = read(file);
    const found: string[] = [];
    for (const m of src.matchAll(/\bnoClaim\(/g)) {
      const after = src.slice((m.index ?? 0) + m[0].length, (m.index ?? 0) + 400);
      const code = after.match(/^\s*mcpError\(\s*"([A-Z_]+)"/);
      const ternary = after.match(/^\s*\w+\s*\?\s*mcpError\(\s*"([A-Z_]+)"/);
      const ident = after.match(/^\s*([A-Za-z_]+)(\(\))?/);
      found.push(code?.[1] ?? ternary?.[1] ?? `<${ident?.[1] ?? "?"}>`);
    }
    return found;
  }

  it("mcp/document.ts", () => {
    expect(marks("document.ts")).toEqual(DOCUMENT_MARKS);
  });
  it("mcp/annotations.ts", () => {
    expect(marks("annotations.ts")).toEqual(ANNOTATION_MARKS);
  });
  it("mcp/docx-apply.ts", () => {
    expect(marks("docx-apply.ts")).toEqual(DOCX_MARKS);
  });

  it("the renameDocument refusals that never claim", () => {
    const src = read("document.ts");
    const body = src.match(/const RENAME_NEVER_CLAIMS[^=]*=\s*new Set\(\[([^\]]*)\]\)/)?.[1] ?? "";
    const members = [...body.matchAll(/"([A-Z_]+)"/g)].map((m) => m[1]);
    expect(members).toEqual([
      "NOT_FOUND",
      "NOT_RENAMABLE",
      "EXTENSION_MISMATCH",
      "INVALID_NAME",
      "INVALID_PATH",
      "READ_ONLY",
    ]);
    // Until PR 2a the list also held `PATH_REJECTED`. It is decided by
    // `assertPathSafe`, which walks the disk, and a refusal the disk decides
    // keeps the claim (ADR-054): the row "a rename refused by a symlink at
    // the destination" pins that it does.
  });

  it("no other file marks a refusal", () => {
    const dir = path.join(process.cwd(), "src/server");
    const hits: string[] = [];
    const walk = (d: string) => {
      for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
        const full = path.join(d, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (entry.name.endsWith(".ts") && /\bnoClaim\(/.test(fs.readFileSync(full, "utf8"))) {
          hits.push(path.relative(dir, full).replace(/\\/g, "/"));
        }
      }
    };
    walk(dir);
    expect(hits.sort()).toEqual(["mcp/annotations.ts", "mcp/document.ts", "mcp/docx-apply.ts"]);
  });
});

describe("the holder's own call succeeds through every write tool", () => {
  /** A's, as `opened`, with another document active so a wrong target would show. */
  function hold(id: string): void {
    setDocOwner(id, { ownerId: A, kind: "opened" }, "take");
    const { id: decoy } = memDoc("decoy", { text: "Decoy text, untouched." });
    setActiveDocId(decoy);
  }
  const stillHeld = (id: string) => {
    expect(getDocOwner(id)).toMatchObject({ ownerId: A, kind: "opened" });
    // The check and any claim were made on the named document, not the active one.
    expect(getDocOwner(docId("decoy"))).toBeUndefined();
  };
  const decoyUntouched = () =>
    expect(text(getOrCreateDocument(docId("decoy")))).toContain("Decoy text, untouched.");

  const covered: string[] = [];
  const row = (tool: string, fn: () => Promise<void>, timeout?: number) => {
    covered.push(tool);
    it(`${tool}`, fn, timeout);
  };

  row("tandem_edit", async () => {
    const { id, ydoc } = memDoc("d");
    hold(id);
    const body = await as(A, "tandem_edit", { from: 0, to: 5, newText: "Howdy", documentId: id });
    expect(body.error).toBe(false);
    expect(text(ydoc)).toContain("Howdy world");
    stillHeld(id);
    decoyUntouched();
  });

  row("tandem_appendContent", async () => {
    const { id, ydoc } = memDoc("d");
    hold(id);
    const body = await as(A, "tandem_appendContent", { content: "Appended.", documentId: id });
    expect(body.error).toBe(false);
    expect(text(ydoc)).toContain("Appended.");
    stillHeld(id);
    decoyUntouched();
  });

  row("tandem_editList", async () => {
    const { id } = await diskDoc("list.md", "- one\n- two\n");
    hold(id);
    const body = await as(A, "tandem_editList", { at: 0, op: "remove", documentId: id });
    expect(body.error, JSON.stringify(body)).toBe(false);
    const after = text(getOrCreateDocument(id));
    expect(after).not.toContain("one");
    expect(after).toContain("two");
    stillHeld(id);
  });

  row("tandem_comment", async () => {
    const { id, ydoc } = memDoc("d");
    hold(id);
    const body = await as(A, "tandem_comment", { from: 0, to: 5, text: "mine", documentId: id });
    expect(body.error).toBe(false);
    expect(ydoc.getMap(Y_MAP_ANNOTATIONS).size).toBe(1);
    expect(getOrCreateDocument(docId("decoy")).getMap(Y_MAP_ANNOTATIONS).size).toBe(0);
    stillHeld(id);
  });

  row("tandem_resolveAnnotation", async () => {
    const { id, ydoc } = memDoc("d");
    seed(ydoc, "ann");
    hold(id);
    const body = await as(A, "tandem_resolveAnnotation", {
      id: "ann",
      action: "dismiss",
      documentId: id,
    });
    expect(body.error, JSON.stringify(body)).toBe(false);
    expect((ydoc.getMap(Y_MAP_ANNOTATIONS).get("ann") as { status: string }).status).toBe(
      "dismissed",
    );
    stillHeld(id);
  });

  row("tandem_removeAnnotation", async () => {
    const { id, ydoc } = memDoc("d");
    seed(ydoc, "ann");
    hold(id);
    const body = await as(A, "tandem_removeAnnotation", { id: "ann", documentId: id });
    expect(body.error, JSON.stringify(body)).toBe(false);
    expect(ydoc.getMap(Y_MAP_ANNOTATIONS).has("ann")).toBe(false);
    stillHeld(id);
  });

  row("tandem_editAnnotation", async () => {
    const { id, ydoc } = memDoc("d");
    seed(ydoc, "ann");
    hold(id);
    const body = await as(A, "tandem_editAnnotation", {
      id: "ann",
      content: "edited",
      documentId: id,
    });
    expect(body.error, JSON.stringify(body)).toBe(false);
    expect((ydoc.getMap(Y_MAP_ANNOTATIONS).get("ann") as { content: string }).content).toBe(
      "edited",
    );
    stillHeld(id);
  });

  row("tandem_annotationReply", async () => {
    const { id, ydoc } = memDoc("d");
    seed(ydoc, "ann");
    hold(id);
    const body = await as(A, "tandem_annotationReply", {
      annotationId: "ann",
      text: "a reply",
      documentId: id,
    });
    expect(body.error, JSON.stringify(body)).toBe(false);
    expect(JSON.stringify(ydoc.getMap(Y_MAP_ANNOTATION_REPLIES).toJSON())).toContain("a reply");
    stillHeld(id);
  });

  row("tandem_save", async () => {
    const { id, filePath } = await diskDoc("save.md", "Saved body.\n");
    hold(id);
    expect(
      (await as(A, "tandem_edit", { from: 0, to: 5, newText: "Kept!", documentId: id })).error,
    ).toBe(false);
    const body = await as(A, "tandem_save", { documentId: id });
    expect(body.error, JSON.stringify(body)).toBe(false);
    expect(fs.readFileSync(filePath, "utf8")).toContain("Kept! body.");
    stillHeld(id);
  });

  row("tandem_rename", async () => {
    const { id, filePath } = await diskDoc("before.md", "Body.\n");
    hold(id);
    const body = await as(A, "tandem_rename", { newName: "after.md", documentId: id });
    expect(body.error, JSON.stringify(body)).toBe(false);
    expect(fs.existsSync(filePath)).toBe(false);
    expect(fs.existsSync(path.join(tmpDir, "after.md"))).toBe(true);
    // The document is still open, under whichever id the rename gave it, and
    // it is still A's: B is refused on it.
    const renamed = [...getOpenDocs().values()].find((d) => d.filePath.endsWith("after.md"));
    expect(renamed).toBeDefined();
    const renamedId = renamed?.id as string;
    expect(getDocOwner(renamedId)).toMatchObject({ ownerId: A, kind: "opened" });
    const refused = await as(B, "tandem_appendContent", { content: "x", documentId: renamedId });
    expect(refused.code).toBe("NOT_DOC_OWNER");
    expect(getDocOwner(docId("decoy"))).toBeUndefined();
    decoyUntouched();
  });

  row("tandem_close", async () => {
    const { id } = memDoc("d");
    hold(id);
    const body = await as(A, "tandem_close", { documentId: id });
    expect(body.error, JSON.stringify(body)).toBe(false);
    expect(getOpenDocs().has(id)).toBe(false);
    // The tab-close point drops the entry; the decoy tab is still open.
    expect(getDocOwner(id)).toBeUndefined();
    expect(getOpenDocs().has(docId("decoy"))).toBe(true);
    expect(getDocOwner(docId("decoy"))).toBeUndefined();
    decoyUntouched();
  });

  row("tandem_restoreBackup", async () => {
    const { id, filePath } = await diskDoc("restore.md", "First version.\n");
    hold(id);
    // A save over the original bytes takes the pre-overwrite snapshot.
    expect(
      (await as(A, "tandem_edit", { from: 0, to: 5, newText: "Later", documentId: id })).error,
    ).toBe(false);
    expect((await as(A, "tandem_save", { documentId: id })).error).toBe(false);
    expect(fs.readFileSync(filePath, "utf8")).toContain("Later version.");
    const listed = await as(A, "tandem_restoreBackup", { documentId: id });
    expect(listed.error, JSON.stringify(listed)).toBe(false);
    const backups = listed.data?.backups as Array<{ name: string }>;
    expect(backups.length).toBeGreaterThan(0);

    const body = await as(A, "tandem_restoreBackup", { backup: backups[0].name, documentId: id });

    expect(body.error, JSON.stringify(body)).toBe(false);
    expect(text(getOrCreateDocument(id))).toContain("First version.");
    stillHeld(id);
    // And the listing is a read: another record gets it too.
    expect((await as(B, "tandem_restoreBackup", { documentId: id })).error).toBe(false);
    stillHeld(id);
  });

  row(
    "tandem_applyChanges",
    async () => {
      const filePath = path.join(tmpDir, "apply.docx");
      fs.writeFileSync(filePath, await createMinimalDocx("Hello world"));
      const id = docId("apply");
      seedAcceptedSuggestion(getOrCreateDocument(id));
      addDoc(id, { id, filePath, format: "docx", readOnly: false, source: "file" });
      hold(id);
      const before = fs.readFileSync(filePath);

      const body = await as(A, "tandem_applyChanges", { documentId: id });

      expect(body.error, JSON.stringify(body)).toBe(false);
      expect(fs.readFileSync(filePath).equals(before)).toBe(false);
      stillHeld(id);
    },
    REAL_DOCX_TIMEOUT_MS,
  );

  row("tandem_convertToMarkdown", async () => {
    const filePath = path.join(tmpDir, "convert.docx");
    fs.writeFileSync(filePath, await createMinimalDocx("Hello world"));
    const { id } = memDoc("convert", { format: "docx", filePath, text: "Hello world" });
    hold(id);

    const body = await as(A, "tandem_convertToMarkdown", { documentId: id });

    expect(body.error, JSON.stringify(body)).toBe(false);
    const created = body.data?.documentId as string;
    expect(created).not.toBe(id);
    expect(fs.readFileSync(body.data?.outputPath as string, "utf8")).toContain("Hello world");
    // The source is still A's, and the Markdown document this call created
    // is A's too, by the take rule.
    stillHeld(id);
    expect(getDocOwner(created)).toMatchObject({ ownerId: A, kind: "opened" });
    const refused = await as(B, "tandem_appendContent", { content: "x", documentId: created });
    expect(refused.details?.reason).toBe("held");
  });

  it("a call that names no document is checked on, and written to, the active one", async () => {
    const { id, ydoc } = memDoc("d");
    hold(id);
    // B holds the decoy; A's own document is the active tab.
    setDocOwner(docId("decoy"), { ownerId: B, kind: "opened" }, "take");
    setActiveDocId(id);
    const body = await as(A, "tandem_edit", { from: 0, to: 5, newText: "Howdy" });
    expect(body.error, JSON.stringify(body)).toBe(false);
    expect(text(ydoc)).toContain("Howdy world");
    decoyUntouched();
    // And the other way round: with B's document active, the same call is
    // refused on it, and A's document is not written to instead.
    setActiveDocId(docId("decoy"));
    const refused = await as(A, "tandem_edit", { from: 0, to: 5, newText: "Nope!" });
    expect(refused.code).toBe("NOT_DOC_OWNER");
    expect(text(ydoc)).not.toContain("Nope!");
    decoyUntouched();
  });

  it("covers exactly the tools the mode table calls writes", () => {
    const writes = Object.entries(TOOL_MODES)
      .filter(([, entry]) => entry.mode === "write")
      .map(([name]) => name)
      .sort();
    expect([...covered].sort()).toEqual(writes);
  });
});

describe("tandem_open of a path the open path refuses (ownership design §5.4)", () => {
  const envelope = (text: string) => ({ content: [{ type: "text" as const, text }] });

  it("is run with a target nothing can match, so it can only refuse: nothing is opened, reloaded or taken", async () => {
    const { id } = memDoc("held");
    setDocOwner(id, { ownerId: B, kind: "claimed" }, "claim");
    const expected: Array<string | undefined> = [];

    const result = await ownedOpen({ ownerId: A }, "tandem_open", {
      predict: () => undefined,
      open: async (expectTargetId) => {
        expected.push(expectTargetId);
        return { envelope: envelope('{"refused":true}') };
      },
    });

    expect(result.content[0].text).toBe('{"refused":true}');
    expect(expected).toHaveLength(1);
    expect(expected[0]).toBeDefined();
    // No document's id is that target: ids are hashes or basenames.
    expect(getOpenDocs().has(expected[0] as string)).toBe(false);
    expect(expected[0]).toContain("\u0000");
    expect(getDocOwner(id)).toMatchObject({ ownerId: B, kind: "claimed" });
    expect(ownershipSnapshotForTests().losses).toEqual([]);
  });

  it("the real open path refuses that target before it acts, on an open document and on a fresh file", async () => {
    const { id, filePath } = await diskDoc("open.md", "On disk.\n");
    setDocOwner(id, { ownerId: B, kind: "claimed" }, "claim");
    // A force reload always opens a transaction, changed file or not.
    let transactions = 0;
    getOrCreateDocument(id).on("afterTransaction", () => {
      transactions++;
    });
    const active = getActiveDocId();
    let target = "";
    await ownedOpen({ ownerId: A }, "tandem_open", {
      predict: () => undefined,
      open: async (expectTargetId) => {
        target = expectTargetId as string;
        return { envelope: envelope("{}") };
      },
    });

    await expect(
      openFromDisk(filePath, { force: true, expectTargetId: target }),
    ).rejects.toMatchObject({ code: "OPEN_TARGET_CHANGED" });
    expect(transactions).toBe(0);
    expect(getActiveDocId()).toBe(active);
    const fresh = path.join(tmpDir, "fresh.md");
    fs.writeFileSync(fresh, "Fresh.\n");
    await expect(openFromDisk(fresh, { expectTargetId: target })).rejects.toMatchObject({
      code: "OPEN_TARGET_CHANGED",
    });
    expect([...getOpenDocs().values()].some((d) => d.filePath.endsWith("fresh.md"))).toBe(false);
  });

  it("if the path became openable, the call starts again under a real prediction and the take rule decides in the queue", async () => {
    const { id } = memDoc("d");
    setDocOwner(id, { ownerId: B, kind: "opened" }, "take");
    let predictions = 0;
    const expected: Array<string | undefined> = [];

    const result = await ownedOpen({ ownerId: A }, "tandem_open", {
      // Refused at first; a real target from then on.
      predict: () => (predictions++ === 0 ? undefined : id),
      open: async (expectTargetId) => {
        expected.push(expectTargetId);
        // What the core does with a target that does not match.
        return expectTargetId === id
          ? { envelope: envelope("{}"), openedId: id }
          : { envelope: envelope("{}"), targetChanged: true };
      },
    });

    // B holds it as `opened`: refused before the open is run on the real target.
    const body = JSON.parse(result.content[0].text) as Body;
    expect(body.code).toBe("NOT_DOC_OWNER");
    expect(body.details?.reason).toBe("held");
    expect(body.message).not.toMatch(/^The document was opened/);
    expect(expected).toHaveLength(1);
    expect(expected[0]).not.toBe(id);
    expect(getDocOwner(id)).toMatchObject({ ownerId: B, kind: "opened" });
  });

  it("an open that acted without a target is a fault, not a take", async () => {
    const { id } = memDoc("d");
    await expect(
      ownedOpen({ ownerId: A }, "tandem_open", {
        predict: () => undefined,
        open: async () => ({ envelope: envelope("{}"), openedId: id }),
      }),
    ).rejects.toThrow("an open with no target opened a document");
    expect(getDocOwner(id)).toBeUndefined();
  });
});
