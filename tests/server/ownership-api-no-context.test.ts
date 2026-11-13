/**
 * The user's own surface never meets an ownership check (#2358, ADR-054;
 * ownership design §3.1): "a flag-on test drives every mutating `/api` route
 * and an autosave tick with no MCP context and expects today's results."
 *
 * Three parts:
 *  1. Every mutating `/api` route is either driven here or excluded by name
 *     with a reason, so a new route fails until someone places it.
 *  2. The driven routes and an autosave tick are run twice against the real
 *     HTTP server — ownership off, then on with the document held by an MCP
 *     record AND a never-settling operation parked in its queue — and must
 *     answer identically. A route that entered the queue would hang; one that
 *     asked an ownership question would be refused.
 *  3. A source pin: which files may import the enforcement helpers, the queue
 *     and the decision functions. No route, core, lifecycle or local-model
 *     file is among them.
 */

import fs from "node:fs";
import type { Server } from "node:http";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { isDirty, markDirty } from "../../src/server/documents/dirty.js";
import { removeDoc } from "../../src/server/documents/registry-testing.js";
import { recordSelfWrite, unwatchFile } from "../../src/server/file-watcher.js";
import { autoSaveAllToDisk, getOpenDocs } from "../../src/server/mcp/document-service.js";
import { closeMcpSession, startMcpServerHttp } from "../../src/server/mcp/server.js";
import { runDocOp } from "../../src/server/sessions/doc-op-queue.js";
import {
  getDocOwner,
  noteTransportRegistered,
  resetOwnershipForTests,
  setDocOwner,
  setTransportView,
} from "../../src/server/sessions/ownership.js";
import { getOrCreateDocument } from "../../src/server/yjs/provider.js";
import * as apiPaths from "../../src/shared/api-paths.js";
import { Y_MAP_ANNOTATIONS } from "../../src/shared/constants.js";
import { withInternal } from "../../src/shared/origins.js";
import { allocPort } from "../helpers/alloc-port.js";
import { mutatingRegistrations } from "../helpers/api-route-source.js";
import { IMPORTS } from "../helpers/import-graph.js";
import { SRC_FILES, stripComments } from "../helpers/src-tree.js";

const HOLDER = "bridge:mcp-holder";

/** Routes driven below, in the order they run (the close is last). */
const DRIVEN: Array<{
  constant: string;
  method: "post" | "delete";
  body: (id: string) => unknown;
}> = [
  { constant: "API_MODE_RELEASE", method: "post", body: () => ({}) },
  { constant: "API_SAVE", method: "post", body: (id) => ({ documentId: id }) },
  {
    constant: "API_ANNOTATION_REPLY",
    method: "post",
    body: (id) => ({ documentId: id, annotationId: "ann", text: "a user reply" }),
  },
  {
    constant: "API_REMOVE_ANNOTATION",
    method: "post",
    body: (id) => ({ documentId: id, annotationId: "ann" }),
  },
  { constant: "API_APPLY_CHANGES", method: "post", body: (id) => ({ documentId: id }) },
  { constant: "API_CONVERT", method: "post", body: (id) => ({ documentId: id }) },
  {
    constant: "API_DOCUMENT_RELOAD",
    method: "post",
    body: (id) => ({ documentId: id, markdown: "# Reloaded\n\nNew body.\n" }),
  },
  {
    constant: "API_BACKUPS_RESTORE",
    method: "post",
    body: (id) => ({ documentId: id, backup: "none.md" }),
  },
  {
    constant: "API_EXTERNAL_CONFLICT_RESOLVE",
    method: "post",
    body: (id) => ({ documentId: id, choice: "keep" }),
  },
  {
    constant: "API_READ_ONLY_FILE_RESOLVE",
    method: "post",
    body: (id) => ({ documentId: id, choice: "dismiss" }),
  },
  {
    constant: "API_CHANNEL_AWARENESS",
    method: "post",
    body: (id) => ({ documentId: id, status: "x", active: true }),
  },
  {
    constant: "API_CHANNEL_ERROR",
    method: "post",
    body: () => ({ error: "CHANNEL_CONNECT_FAILED", message: "x" }),
  },
  { constant: "API_CHAT", method: "delete", body: () => ({}) },
  {
    constant: "API_RENAME",
    method: "post",
    body: (id) => ({ documentId: id, newName: "renamed.md" }),
  },
  { constant: "API_CLOSE", method: "post", body: (id) => ({ documentId: id }) },
];

/** Routes not driven, each with the reason. */
const EXCLUDED: Record<string, string> = {
  "post API_OPEN": "driven as the setup step: it opens the document every other route acts on",
  "post API_UPLOAD":
    "opens a second document from a multipart body; the open path is covered by API_OPEN",
  "post API_SCRATCHPAD": "opens a new document; the open path is covered by API_OPEN",
  "post API_CHANNEL_REPLY":
    "an AI reply path: ownership-checked on purpose, in PR 4 (ownership design §9.2)",
  "post API_LICENSE_ACTIVATE": "licence store; takes no document",
  "post API_LICENSE_DEACTIVATE": "licence store; takes no document",
  "post API_STORE_RECLAIM_LOCK": "annotation-store lock; takes no document",
  "post API_SESSIONS_DELETE": "session files; takes no open document",
  "post API_SESSIONS_CLEAR": "session files; takes no open document",
  "post API_ROTATE_TOKEN": "rewrites the auth token and client configs",
  "post API_SHUTDOWN": "exits the process",
  "post API_INTEGRATIONS": "integration settings; takes no document",
  "post API_INTEGRATIONS_APPLY": "writes client configs",
  "post API_INTEGRATIONS_WALKTHROUGH_CONFIRM": "integration settings; takes no document",
  "post API_INTEGRATIONS_SECRET": "keychain; takes no document",
  "delete API_INTEGRATIONS_SECRET": "keychain; takes no document",
  "post API_INTEGRATIONS_INSTALL_CLAUDE_CODE": "runs an installer",
  "post API_LAUNCHER_RELAUNCH": "launcher; takes no document",
  "post API_LAUNCHER_START_FRESH": "launcher; takes no document",
  "post API_LAUNCHER_START": "launcher; takes no document",
  "post API_LAUNCHER_WORKING_DIRECTORY": "launcher; takes no document",
  "post API_LAUNCHER_CWD_PREVIEW": "launcher; takes no document",
  "post API_LAUNCHER_SETTINGS": "launcher; takes no document",
  "post API_MODELS": "local-model settings; takes no document",
  "post API_MODELS_LOCAL_SETTINGS": "the local-model commenting opt-in; takes no document",
  "post API_MODELS_CHAT_ANSWERER": "who answers chat, Claude or the local model; takes no document",
  "post API_MODELS_SECRET": "keychain; takes no document",
  "delete API_MODELS_SECRET": "keychain; takes no document",
};

let httpServer: Server | undefined;
let tmpDir = "";

/**
 * Remove the temp dir after closing whatever still watches a file in it: an
 * open watch handle keeps the directory busy on Windows, and a bare `rmSync`
 * then throws. Retries cover a handle that is still closing.
 */
function removeTmpDir(): void {
  for (const d of [...getOpenDocs().values()]) {
    if (d.source === "file") unwatchFile(d.filePath);
    removeDoc(d.id);
  }
  if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}

afterEach(async () => {
  await closeMcpSession();
  if (httpServer) await new Promise<void>((resolve) => httpServer?.close(() => resolve()));
  httpServer = undefined;
  resetOwnershipForTests();
  removeTmpDir();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

/** Boot, open one document as the user, and drive every route in `DRIVEN`. */
async function drive(flag: "" | "1"): Promise<string[]> {
  // Literal calls, so the reviewed lists in ownership-module-seam.test.ts see
  // which files turn the flag on and which turn it off.
  if (flag === "1") vi.stubEnv("TANDEM_OWNERSHIP", "1");
  else vi.stubEnv("TANDEM_OWNERSHIP", "");
  vi.spyOn(console, "error").mockImplementation(() => {});
  const port = await allocPort();
  httpServer = await startMcpServerHttp(port, "127.0.0.1");
  const base = `http://127.0.0.1:${port}`;
  const post = async (method: string, url: string, body: unknown) => {
    const res = await fetch(`${base}${url}`, {
      method: method.toUpperCase(),
      headers: { "Content-Type": "application/json", Origin: `http://127.0.0.1:${port}` },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15_000),
    });
    const text = await res.text();
    let code: unknown;
    try {
      const json = JSON.parse(text) as { error?: unknown; code?: unknown };
      code = json.code ?? json.error;
    } catch {
      code = undefined;
    }
    return { status: res.status, code, text };
  };

  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "tandem-own-api-"));
  const filePath = path.join(tmpDir, "doc.md");
  fs.writeFileSync(filePath, "# Title\n\nBody text.\n");
  const opened = await post("post", apiPaths.API_OPEN, { filePath });
  expect(opened.status, opened.text).toBe(200);
  const id = (JSON.parse(opened.text) as { data: { documentId: string } }).data.documentId;
  expect(id).toEqual(expect.any(String));

  const ydoc = getOrCreateDocument(id);
  withInternal(ydoc, () =>
    ydoc.getMap(Y_MAP_ANNOTATIONS).set("ann", {
      id: "ann",
      author: "user",
      type: "comment",
      audience: "outbound",
      range: { from: 0, to: 5 },
      content: "c",
      status: "pending",
      timestamp: 1,
      rev: 1,
    }),
  );

  if (flag === "1") {
    // An MCP record holds the document, and an operation that never settles
    // sits in its queue: an MCP write by anyone else would be refused, and
    // any MCP write at all would wait forever.
    setTransportView(() => [{ ownerId: HOLDER, openStreams: 0 }]);
    noteTransportRegistered(HOLDER, { recordKind: "bridge" });
    setDocOwner(id, { ownerId: HOLDER, kind: "opened" }, "take");
    expect(getDocOwner(id)?.ownerId).toBe(HOLDER);
    void runDocOp(id, () => new Promise<void>(() => {}));
  }

  const results: string[] = [];
  // A dirty document, so the tick really writes: autosave skips clean ones.
  markDirty(id);
  fs.writeFileSync(filePath, "stale on disk\n");
  recordSelfWrite(filePath, "stale on disk\n");
  await autoSaveAllToDisk();
  results.push(
    `autosave: dirty=${isDirty(id)} wrote=${fs.readFileSync(filePath, "utf-8") !== "stale on disk\n"}`,
  );
  for (const route of DRIVEN) {
    const url = (apiPaths as Record<string, unknown>)[route.constant] as string;
    const res = await post(route.method, url, route.body(id));
    results.push(`${route.method} ${route.constant}: ${res.status} ${String(res.code)}`);
  }
  return results;
}

describe("/api and autosave with no MCP context", () => {
  it("every mutating /api route is driven or excluded by name", () => {
    const all = mutatingRegistrations()
      .map((r) => `${r.method} ${r.constant}`)
      .sort();
    const placed = [
      ...DRIVEN.map((r) => `${r.method} ${r.constant}`),
      ...Object.keys(EXCLUDED),
    ].sort();
    expect(placed).toEqual(all);
  });

  it("answer the same with ownership on — held by an MCP record, its queue blocked — as with it off", async () => {
    const off = await drive("");
    await closeMcpSession();
    await new Promise<void>((resolve) => httpServer?.close(() => resolve()));
    httpServer = undefined;
    removeTmpDir();
    resetOwnershipForTests();
    vi.unstubAllEnvs();

    const on = await drive("1");
    expect(on, JSON.stringify(off)).toEqual(off);
    // Anti-vacuity: the routes did real work on the held document.
    for (const done of [
      "autosave: dirty=false wrote=true",
      "post API_SAVE: 200 undefined",
      "post API_ANNOTATION_REPLY: 200 undefined",
      "post API_REMOVE_ANNOTATION: 200 undefined",
      "post API_DOCUMENT_RELOAD: 200 undefined",
      "post API_RENAME: 200 undefined",
      "post API_CLOSE: 200 undefined",
    ]) {
      expect(off, JSON.stringify(off)).toContain(done);
    }
    expect(JSON.stringify(off)).not.toContain("NOT_DOC_OWNER");
  }, 120_000);
});

describe("who may import the enforcement code", () => {
  const importersOf = (target: string) =>
    [...IMPORTS]
      .filter(([file, targets]) => file !== target && targets.includes(target))
      .map(([file]) => file)
      .sort();

  it("the tool-wrapper helper is imported by tool files only", () => {
    expect(importersOf("src/server/mcp/owned-op.ts")).toEqual([
      "src/server/mcp/annotations.ts",
      "src/server/mcp/document.ts",
      "src/server/mcp/docx-apply.ts",
    ]);
  });

  it("the operation queue is imported by the helper and the ownership module only", () => {
    expect(importersOf("src/server/sessions/doc-op-queue.ts")).toEqual([
      "src/server/mcp/owned-op.ts",
      "src/server/sessions/ownership.ts",
    ]);
  });

  it("the decision functions are named in the helper and the ownership module only", () => {
    const names =
      /\b(checkWrite|beginWriteClaim|settleWriteClaim|dropWriteClaim|inboxScopeOf|decideTake|takeDocument|otherHolderOf|otherAnswererOf|recordAnswerer)\b/;
    const files = [...SRC_FILES]
      .filter(([, src]) => names.test(stripComments(src)))
      .map(([file]) => file)
      .sort();
    expect(files).toEqual(["src/server/mcp/owned-op.ts", "src/server/sessions/ownership.ts"]);
  });
});
