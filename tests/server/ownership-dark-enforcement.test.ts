/**
 * What ownership enforcement must NOT do while it ships dark (#2358, ADR-054;
 * plan "Shipping", ownership design §12): `tools/list` carries no ownership
 * argument, field or string; the operation queue and every refusal are
 * bypassed; nothing is stamped.
 *
 * Each test turns the flag off for itself, so it pins dark behaviour in the
 * `ownership-flag-on` job too. The tool-list test also builds the flag-on list
 * and names every difference, so a new flag-on string cannot appear unlisted.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as Y from "yjs";
import { addDoc, removeDoc, setActiveDocId } from "../../src/server/documents/registry-testing.js";
import { registerAnnotationTools } from "../../src/server/mcp/annotations.js";
import { registerAwarenessTools } from "../../src/server/mcp/awareness.js";
import { registerDiagnosticsTools } from "../../src/server/mcp/diagnostics.js";
import { populateYDoc, registerDocumentTools } from "../../src/server/mcp/document.js";
import { getActiveDocId, getOpenDocs } from "../../src/server/mcp/document-service.js";
import { registerApplyTools } from "../../src/server/mcp/docx-apply.js";
import { registerNavigationTools } from "../../src/server/mcp/navigation.js";
import { isDocOpQueueBusy, runDocOp } from "../../src/server/sessions/doc-op-queue.js";
import {
  ownershipSnapshotForTests,
  resetOwnershipForTests,
} from "../../src/server/sessions/ownership.js";
import { getOrCreateDocument } from "../../src/server/yjs/provider.js";
import { Y_MAP_ANNOTATIONS } from "../../src/shared/constants.js";
import { withInternal } from "../../src/shared/origins.js";
import { parseResult, setupMcpServer } from "../helpers/mcp-harness.js";
import { asTestCaller } from "../helpers/ownership-caller.js";

const REGISTRARS: Array<(server: McpServer) => void> = [
  registerDocumentTools,
  registerAnnotationTools,
  registerNavigationTools,
  registerAwarenessTools,
  registerApplyTools,
  (server) =>
    registerDiagnosticsTools(server, {} as Parameters<typeof registerDiagnosticsTools>[1]),
];

let run = 0;
let prefix = "";
let callingAs = "claude:one";
const docId = (name: string) => `${prefix}-${name}`;

function setupDoc(name: string): Y.Doc {
  const id = docId(name);
  const ydoc = getOrCreateDocument(id);
  populateYDoc(ydoc, "Hello world, this is a test document.");
  addDoc(id, { id, filePath: `/tmp/${id}.md`, format: "md", readOnly: false, source: "file" });
  return ydoc;
}

async function server(flag: "" | "1") {
  // Literal calls, so the reviewed lists in ownership-module-seam.test.ts see
  // which files turn the flag on and which turn it off.
  if (flag === "1") vi.stubEnv("TANDEM_OWNERSHIP", "1");
  else vi.stubEnv("TANDEM_OWNERSHIP", "");
  return setupMcpServer(REGISTRARS, {
    dispatch: (fn) => asTestCaller(fn, { ownerId: callingAs }),
  });
}

beforeEach(() => {
  run++;
  prefix = `dark${run}`;
  for (const id of [...getOpenDocs().keys()]) removeDoc(id);
});

afterEach(() => {
  for (const id of [...getOpenDocs().keys()]) removeDoc(id);
  resetOwnershipForTests();
  vi.unstubAllEnvs();
});

const EMPTY_SNAPSHOT = {
  transportMode: undefined,
  records: [],
  ownerByDoc: [],
  handoverSeq: [],
  timers: 0,
  losses: [],
  answerers: 0,
  queuedDocuments: 0,
};

describe("tools/list while dark", () => {
  async function listed(flag: "" | "1") {
    const { client, close } = await server(flag);
    try {
      const { tools } = await client.listTools();
      return new Map(tools.map((t) => [t.name, t]));
    } finally {
      await close();
    }
  }

  it("carries no ownership string, and the flag-on list differs only where named", async () => {
    const off = await listed("");
    const on = await listed("1");

    // Nothing a dark server lists mentions ownership in any form.
    const offText = JSON.stringify([...off.values()]);
    for (const word of [
      "NOT_DOC_OWNER",
      "takes it over",
      "another session holds",
      "this session its owner",
      '"owner"',
      "this session holds",
    ]) {
      expect(offText, `a dark tools/list says ${JSON.stringify(word)}`).not.toContain(word);
    }

    expect([...on.keys()].sort()).toEqual([...off.keys()].sort());
    const changed = [...off.keys()].filter(
      (name) => JSON.stringify(off.get(name)) !== JSON.stringify(on.get(name)),
    );
    // The three descriptions that tell an older skill what changed, and
    // read-mode `tandem_status`'s `owner` field. Anything else is a leak
    // of ownership into a tool that PR 1c did not mean to change.
    expect(changed.sort()).toEqual([
      "tandem_close",
      "tandem_open",
      "tandem_status",
      "tandem_switchDocument",
    ]);
    for (const name of ["tandem_close", "tandem_open", "tandem_switchDocument"]) {
      expect(on.get(name)?.description, name).toContain(off.get(name)?.description as string);
      expect(on.get(name)?.inputSchema, name).toEqual(off.get(name)?.inputSchema);
    }
    expect(on.get("tandem_status")?.description).toBe(off.get("tandem_status")?.description);
    expect(JSON.stringify(on.get("tandem_status")?.outputSchema)).toContain('"owner"');
    expect(JSON.stringify(off.get("tandem_status")?.outputSchema)).not.toContain('"owner"');
  });
});

describe("no queue, no refusal, nothing stamped while dark", () => {
  it("two different callers both write, switch and close one document, and nothing is recorded", async () => {
    const ydoc = setupDoc("d");
    setupDoc("other");
    withInternal(ydoc, () =>
      ydoc.getMap(Y_MAP_ANNOTATIONS).set("ann", {
        id: "ann",
        author: "claude",
        type: "comment",
        audience: "outbound",
        range: { from: 0, to: 5 },
        content: "c",
        status: "pending",
        timestamp: 1,
        rev: 1,
      }),
    );
    const { client, close } = await server("");
    const call = async (owner: string, name: string, args: Record<string, unknown>) => {
      callingAs = owner;
      return parseResult(await client.callTool({ name, arguments: args })) as {
        error: boolean;
        code?: string;
        data?: Record<string, unknown>;
      };
    };
    try {
      const d = docId("d");
      expect(
        (await call("claude:one", "tandem_comment", { from: 0, to: 5, text: "a", documentId: d }))
          .error,
      ).toBe(false);
      expect(
        (await call("claude:two", "tandem_comment", { from: 0, to: 5, text: "b", documentId: d }))
          .error,
      ).toBe(false);
      expect(
        (
          await call("claude:two", "tandem_edit", {
            from: 0,
            to: 5,
            newText: "Howdy",
            documentId: d,
          })
        ).error,
      ).toBe(false);
      expect(
        (
          await call("claude:one", "tandem_annotationReply", {
            annotationId: "ann",
            text: "r",
            documentId: d,
          })
        ).error,
      ).toBe(false);
      expect(
        (
          await call("claude:two", "tandem_annotationReply", {
            annotationId: "ann",
            text: "r",
            documentId: d,
          })
        ).error,
      ).toBe(false);
      expect(
        (await call("claude:two", "tandem_switchDocument", { documentId: docId("other") })).error,
      ).toBe(false);
      expect(getActiveDocId()).toBe(docId("other"));
      const scratch = await call("claude:one", "tandem_scratchpad", { content: "x" });
      expect(scratch.error).toBe(false);
      const status = await call("claude:one", "tandem_status", {});
      expect(status.data).not.toHaveProperty("owner");
      const focus = await call("claude:two", "tandem_status", {
        text: "s",
        focusParagraph: 4,
        documentId: d,
      });
      expect(focus.data).toEqual({ status: "s" });
      expect((await call("claude:two", "tandem_close", { documentId: d })).error).toBe(false);
      expect(ownershipSnapshotForTests()).toEqual(EMPTY_SNAPSHOT);
    } finally {
      await close();
    }
  });

  it("a write does not wait for an operation in the document's queue (there is no queue)", async () => {
    setupDoc("d");
    setActiveDocId(docId("d"));
    const { client, close } = await server("");
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    // Something holding the document's chain: with ownership on, a write
    // would wait behind it (`ownership-enforcement.test.ts`).
    const holding = runDocOp(docId("d"), () => gate);
    try {
      expect(isDocOpQueueBusy(docId("d"))).toBe(true);
      const body = parseResult(
        await client.callTool({
          name: "tandem_comment",
          arguments: { from: 0, to: 5, text: "not queued", documentId: docId("d") },
        }),
      ) as { error: boolean };
      expect(body.error).toBe(false);
    } finally {
      release();
      await holding;
      await close();
    }
  });
});
