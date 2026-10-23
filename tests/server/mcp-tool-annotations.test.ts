/**
 * Every tool's MCP `annotations`, pinned one row per tool against the
 * production `tools/list`.
 *
 * A hint is behaviour, not documentation. Claude Code (2.1.307+) re-sends a
 * call whose HTTP connection closed mid-call only when the tool is read-only
 * or idempotent, and non-interactive Codex auto-approves only `readOnlyHint`
 * tools. So the dangerous error is a hint on a tool that is neither: a lost
 * response executes twice, or a write is auto-approved. The table below fails
 * on any hint change in either direction, and on a tool with no row — whoever
 * adds a tool decides here, with a reason, whether a repeat is safe.
 *
 * Driven over HTTP through `startMcpServerHttp` rather than a hand-assembled
 * `McpServer`, so it sees every registrar the factory uses (the `.docx` apply
 * tools included — vitest's root `test.env` sets `TANDEM_DOCX`) and proves the
 * annotations survive the `schema-dialect.ts` wrapper on the wire.
 */

import type { Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeMcpSession, startMcpServerHttp } from "../../src/server/mcp/server.js";
import {
  IDEMPOTENT_OVERWRITE_TOOL,
  IDEMPOTENT_WRITE_TOOL,
  READ_ONLY_TOOL,
} from "../../src/server/mcp/tool-annotations.js";
import { allocPort } from "../helpers/alloc-port.js";
import { type ListedTool, listToolsOverHttp } from "../helpers/mcp-http-tools-list.js";
import { allMcpSource, registeredToolNames } from "../helpers/mcp-source.js";

/** `annotations` omitted = the tool must advertise none. */
type Row = { annotations?: object; why: string };

const TABLE: Record<string, Row> = {
  // ── Pure reads ────────────────────────────────────────────────────────────
  tandem_getTextContent: { annotations: READ_ONLY_TOOL, why: "pure read of flat text" },
  tandem_getOutline: { annotations: READ_ONLY_TOOL, why: "pure read of document structure" },
  tandem_listDocuments: { annotations: READ_ONLY_TOOL, why: "reads the open-document registry" },
  tandem_search: {
    annotations: READ_ONLY_TOOL,
    why: "pure read; the regex worker's queue state is transient",
  },
  tandem_resolveRange: { annotations: READ_ONLY_TOOL, why: "pure text function" },
  tandem_getContext: { annotations: READ_ONLY_TOOL, why: "pure text function" },
  tandem_getActivity: { annotations: READ_ONLY_TOOL, why: "reads user awareness only" },
  tandem_diagnostics: {
    annotations: READ_ONLY_TOOL,
    why: "writes nothing; its loopback probes include a momentary /api/events subscriber",
  },

  // ── Writes that are safe to repeat ────────────────────────────────────────
  tandem_getAnnotations: {
    annotations: IDEMPOTENT_WRITE_TOOL,
    why: "refreshAllRanges persists range repairs, which converge after one pass",
  },
  tandem_status: {
    annotations: IDEMPOTENT_WRITE_TOOL,
    why: "with `text` it overwrites Claude's status; a repeat refreshes only the timestamp",
  },
  tandem_exportAnnotations: {
    annotations: IDEMPOTENT_OVERWRITE_TOOL,
    why: "writeToDisk overwrites an existing sidecar, with identical bytes on a repeat",
  },

  // ── Not safe to repeat ────────────────────────────────────────────────────
  tandem_checkInbox: {
    why: "commits its dedup ledgers and marks chat read before replying; a retry after a lost response loses the items (#2294)",
  },
  tandem_switchDocument: {
    why: "advances the activation epoch; a retry can pull the user's focus back",
  },
  tandem_open: {
    why: "opens/activates a document; force clears content",
  },
  tandem_scratchpad: { why: "creates a document" },
  tandem_edit: { why: "a repeated insert inserts twice" },
  tandem_editList: { why: "mutates list structure" },
  tandem_appendContent: { why: "a repeat appends twice" },
  tandem_save: { why: "writes the user's file" },
  tandem_close: { why: "closes a document" },
  tandem_rename: { why: "moves a file on disk" },
  tandem_comment: { why: "a repeat creates a second annotation" },
  tandem_resolveAnnotation: { why: "lifecycle transition" },
  tandem_removeAnnotation: { why: "deletes an annotation" },
  tandem_editAnnotation: { why: "rewrites a pending annotation" },
  tandem_annotationReply: { why: "a repeat posts a second reply" },
  tandem_reply: { why: "a repeat posts a second chat message" },
  tandem_applyChanges: { why: "rewrites a .docx (ships dark)" },
  tandem_restoreBackup: {
    why: "lists snapshots without `backup`, but restores with it — hints are per tool",
  },
  tandem_convertToMarkdown: { why: "writes a file (ships dark)" },
};

let httpServer: Server;
let tools: ListedTool[];

beforeAll(async () => {
  const port = await allocPort();
  httpServer = await startMcpServerHttp(port, "127.0.0.1");
  tools = await listToolsOverHttp(`http://127.0.0.1:${port}`);
});

afterAll(async () => {
  await closeMcpSession();
  await new Promise<void>((resolve) => httpServer.close(() => resolve()));
});

describe("MCP tool annotations", () => {
  it("has exactly one row per tool the server lists and the source registers", () => {
    const listed = tools.map((t) => t.name).sort();
    expect(listed).toEqual(Object.keys(TABLE).sort());
    // Catches a tool the HTTP server failed to list (e.g. a registrar dropped
    // from createMcpServer) that the table would otherwise silently lose.
    expect(listed).toEqual([...registeredToolNames(allMcpSource())].sort());
  });

  it.each(Object.entries(TABLE))("%s advertises its pinned annotations", (name, row) => {
    const tool = tools.find((t) => t.name === name);
    expect(tool, `${name} not listed`).toBeDefined();
    expect(tool?.annotations, row.why).toEqual(row.annotations);
  });
});
