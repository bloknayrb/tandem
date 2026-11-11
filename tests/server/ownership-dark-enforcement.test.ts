/**
 * What ownership enforcement must NOT do while it ships dark (#2358, ADR-054;
 * plan "Shipping", ownership design §12): `tools/list` carries no ownership
 * argument, field or string; the operation queue and every refusal are
 * bypassed; nothing is stamped.
 *
 * Each test turns the flag off for itself, so it pins dark behaviour in the
 * `ownership-flag-on` job too. The enforcement test first builds, with the
 * flag on, the state a flag-on server refuses on (real records, every document
 * held by another one), and checks that it does refuse; then it turns the
 * flag off and drives every kind of tool against that state, and calls each
 * helper in `mcp/owned-op.ts` directly. Removing the flag guard from any one
 * of them fails this file (PR 2a's additions have their own test below). The tool-list test also builds the flag-on list
 * and names every difference, so a new flag-on string cannot appear unlisted.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as Y from "yjs";
import { openFromDisk } from "../../src/server/documents/open.js";
import { addDoc, removeDoc, setActiveDocId } from "../../src/server/documents/registry-testing.js";
import { unwatchFile } from "../../src/server/file-watcher.js";
import { registerAnnotationTools } from "../../src/server/mcp/annotations.js";
import { registerAwarenessTools } from "../../src/server/mcp/awareness.js";
import { registerDiagnosticsTools } from "../../src/server/mcp/diagnostics.js";
import { populateYDoc, registerDocumentTools } from "../../src/server/mcp/document.js";
import { getActiveDocId, getOpenDocs } from "../../src/server/mcp/document-service.js";
import { registerApplyTools } from "../../src/server/mcp/docx-apply.js";
import { registerNavigationTools } from "../../src/server/mcp/navigation.js";
import {
  callerOwnerInfo,
  focusHeldByAnother,
  heldAmong,
  inboxScope,
  ownedOpen,
  ownedWrite,
  ownershipOn,
  switchRefusal,
  takeFreshDocument,
} from "../../src/server/mcp/owned-op.js";
import { runWithMcpContext } from "../../src/server/sessions/context.js";
import { isDocOpQueueBusy, runDocOp } from "../../src/server/sessions/doc-op-queue.js";
import {
  beginWriteClaim,
  dropWriteClaim,
  inboxScopeOf,
  noteTransportRegistered,
  ownershipSnapshotForTests,
  resetOwnershipForTests,
  setDocOwner,
  setHandoverSeqForTests,
  setTransportView,
  settleWriteClaim,
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
    dispatch: (fn) => asTestCaller(fn, { ownerId: "claude:one" }),
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
  pendingClaims: 0,
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
  const A = "claude:dark-a";
  const B = "claude:dark-b";

  /**
   * The state a flag-ON server would refuse B on: two real records, and A
   * holding every document as `opened`. Seeded with the flag on, because a
   * dark server creates none of it; the test then turns the flag off.
   */
  function seedHeldByA(documentIds: string[]): void {
    vi.stubEnv("TANDEM_OWNERSHIP", "1");
    setTransportView(() => [
      { ownerId: A, openStreams: 1 },
      { ownerId: B, openStreams: 1 },
    ]);
    noteTransportRegistered(A, { recordKind: "claude" });
    noteTransportRegistered(B, { recordKind: "claude" });
    for (const id of documentIds) setDocOwner(id, { ownerId: A, kind: "opened" }, "take");
  }

  function seedAnnotation(ydoc: Y.Doc, id: string): void {
    withInternal(ydoc, () =>
      ydoc.getMap(Y_MAP_ANNOTATIONS).set(id, {
        id,
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
  }

  type Body = {
    error: boolean;
    code?: string;
    details?: Record<string, unknown>;
    data?: Record<string, unknown>;
  };

  // The three shapes a tool call can arrive in. A dark server produces the
  // first two (a context never carries an `ownerId` while dark); the third is
  // the shape every flag guard in `owned-op.ts` would act on if it were gone.
  const SHAPES: Array<{ name: string; dispatch: <T>(fn: () => T) => T }> = [
    { name: "no request context", dispatch: (fn) => fn() },
    {
      name: "a context with no ownerId",
      dispatch: (fn) => runWithMcpContext({ claudeSessionId: "dark-session" }, fn),
    },
    {
      name: "a context naming a record that does not hold the document",
      dispatch: (fn) => runWithMcpContext({ ownerId: B }, fn),
    },
  ];

  it("the seeded state really is one a flag-on server refuses (so the dark test below can fail)", async () => {
    setupDoc("d");
    seedHeldByA([docId("d")]);
    const { client, close } = await setupMcpServer(REGISTRARS, {
      dispatch: (fn) => runWithMcpContext({ ownerId: B }, fn),
    });
    try {
      const refused = parseResult(
        await client.callTool({
          name: "tandem_comment",
          arguments: { from: 0, to: 5, text: "x", documentId: docId("d") },
        }),
      ) as Body;
      expect(refused.code).toBe("NOT_DOC_OWNER");
      const switched = parseResult(
        await client.callTool({
          name: "tandem_switchDocument",
          arguments: { documentId: docId("d") },
        }),
      ) as Body;
      expect(switched.code).toBe("NOT_DOC_OWNER");
    } finally {
      await close();
    }
  });

  it.each(SHAPES)(
    "every tool acts on documents another record holds, and the ownership state does not move — $name",
    async ({ dispatch }) => {
      const ydoc = setupDoc("d");
      const other = setupDoc("other");
      seedAnnotation(ydoc, "ann");
      seedAnnotation(ydoc, "dup");
      seedAnnotation(other, "dup");
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "tandem-dark-"));
      const filePath = path.join(tmpDir, "held.md");
      fs.writeFileSync(filePath, "On disk.\n");
      const opened = await openFromDisk(filePath);
      seedHeldByA([docId("d"), docId("other"), opened.documentId]);
      const seeded = ownershipSnapshotForTests();
      expect(seeded.ownerByDoc).toHaveLength(3);
      expect(seeded.records).toHaveLength(2);

      vi.stubEnv("TANDEM_OWNERSHIP", "");
      const { client, close } = await setupMcpServer(REGISTRARS, { dispatch });
      const call = async (name: string, args: Record<string, unknown>) =>
        parseResult(await client.callTool({ name, arguments: args })) as Body;
      const ok = async (name: string, args: Record<string, unknown>) => {
        const body = await call(name, args);
        expect(body.error, `${name}: ${JSON.stringify(body)}`).toBe(false);
        return body;
      };
      try {
        const d = docId("d");
        // Writes, each through a different wrapper.
        await ok("tandem_comment", { from: 0, to: 5, text: "a", documentId: d });
        await ok("tandem_edit", { from: 0, to: 5, newText: "Howdy", documentId: d });
        await ok("tandem_appendContent", { content: "More.", documentId: d });
        await ok("tandem_annotationReply", { annotationId: "ann", text: "r", documentId: d });
        await ok("tandem_annotationReply", { annotationId: "ann", text: "again", documentId: d });
        await ok("tandem_editAnnotation", { id: "ann", content: "edited", documentId: d });
        await ok("tandem_resolveAnnotation", { id: "ann", action: "dismiss", documentId: d });
        expect(ydoc.getXmlFragment("default").toString()).toContain("Howdy");

        // A reply to an id the document does not hold still sets and clears
        // the typing marker, as it always has (flag-on, it is skipped).
        let marker = 0;
        const onTx = () => {
          marker++;
        };
        ydoc.on("afterTransaction", onTx);
        const missing = await call("tandem_annotationReply", {
          annotationId: "no-such-annotation",
          text: "r",
          documentId: d,
        });
        ydoc.off("afterTransaction", onTx);
        expect(missing.code).toBe("NOT_FOUND");
        expect(marker).toBe(2);

        // An id in two documents: today's refusal, with no ownership detail.
        const ambiguous = await call("tandem_editAnnotation", { id: "dup", content: "x" });
        expect(ambiguous.code).toBe("INVALID_ARGUMENT");
        expect(ambiguous.details).toEqual({
          reason: "ambiguous-document",
          documentIds: [d, docId("other")],
        });

        // Switch, open (a reload of a document A holds) and scratchpad.
        await ok("tandem_switchDocument", { documentId: docId("other") });
        expect(getActiveDocId()).toBe(docId("other"));
        fs.writeFileSync(filePath, "Changed on disk.\n");
        const reopened = await ok("tandem_open", { filePath, force: true });
        expect(reopened.data?.documentId).toBe(opened.documentId);
        expect(
          getOrCreateDocument(opened.documentId).getXmlFragment("default").toString(),
        ).toContain("Changed on disk.");
        const scratch = await ok("tandem_scratchpad", { content: "x" });
        expect(getOpenDocs().has(scratch.data?.documentId as string)).toBe(true);

        // Status: no `owner` field, and a focus on A's document is applied
        // with no warning.
        const status = await ok("tandem_status", {});
        expect(status.data).not.toHaveProperty("owner");
        const focus = await ok("tandem_status", { text: "s", focusParagraph: 4, documentId: d });
        expect(focus.data).toEqual({ status: "s" });

        await ok("tandem_save", { documentId: opened.documentId });
        await ok("tandem_close", { documentId: d });
        expect(getOpenDocs().has(d)).toBe(false);

        // Nothing was claimed, taken, lost, answered or queued: the state is
        // exactly what was seeded (a dark close does not even drop the entry).
        expect(ownershipSnapshotForTests()).toEqual(seeded);
      } finally {
        await close();
        // Close the watch the real open started before removing its file.
        unwatchFile(filePath);
        fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
      }
    },
  );

  it("each wrapper helper is a passthrough while dark, even handed a caller that names a record", async () => {
    // While dark `toolCaller` never yields an `ownerId`, so three of the
    // helpers' flag guards (the take of a fresh document, the `owner` field,
    // the held candidates) sit behind that one and no tool call can show them
    // missing. Called directly, with the caller a flag-on server would build,
    // each guard is the only thing between the call and the seeded state.
    setupDoc("d");
    setupDoc("fresh");
    seedHeldByA([docId("d")]);
    const seeded = ownershipSnapshotForTests();
    vi.stubEnv("TANDEM_OWNERSHIP", "");
    const envelope = { content: [{ type: "text" as const, text: "{}" }] };
    const a = { ownerId: A };
    const b = { ownerId: B };

    let given: string | undefined = "unset";
    const written = await ownedWrite(
      b,
      "tandem_comment",
      {
        given: undefined,
        resolve: () => {
          throw new Error("resolved a target while dark");
        },
      },
      async (id) => {
        given = id;
        return envelope;
      },
    );
    expect(written).toBe(envelope);
    expect(given).toBeUndefined();

    let expected: string | undefined = "unset";
    const opened = await ownedOpen(b, "tandem_open", {
      predict: () => {
        throw new Error("predicted a target while dark");
      },
      open: async (expectTargetId) => {
        expected = expectTargetId;
        return { envelope, openedId: docId("d") };
      },
    });
    expect(opened).toBe(envelope);
    expect(expected).toBeUndefined();

    // With its guard gone this would try to write an entry and throw.
    await takeFreshDocument(b, docId("fresh"));
    expect(switchRefusal(b, "tandem_switchDocument", docId("d"))).toBeNull();
    expect(focusHeldByAnother(b, docId("d"))).toBe(false);
    expect(callerOwnerInfo(a)).toBeUndefined();
    expect(heldAmong(a, [docId("d")])).toBeUndefined();
    expect(ownershipOn()).toBe(false);
    expect(ownershipSnapshotForTests()).toEqual(seeded);
  });

  it("what PR 2a adds is unreachable while dark: no pending claim, no claim at an outcome, no scope answer", async () => {
    setupDoc("held");
    setupDoc("free");
    setupDoc("probe");
    seedHeldByA([docId("held")]);
    setHandoverSeqForTests(docId("held"), 4);
    const a = { ownerId: A };
    const b = { ownerId: B };
    const envelope = { content: [{ type: "text" as const, text: "{}" }] };

    // Flag on, each new piece acts on this state, so the dark half can fail.
    expect(inboxScopeOf(docId("held"), A)).toBe("holds");
    expect(inboxScopeOf(docId("free"), B)).toBe("may-claim");
    expect(inboxScope(a, docId("held"))).toBe("holds");
    expect(inboxScope(b, docId("free"))).toBe("may-claim");
    const live = beginWriteClaim(docId("probe"), B);
    expect(ownershipSnapshotForTests().pendingClaims).toBe(1);
    expect(settleWriteClaim(live, true)).toBe(true);
    expect(ownershipSnapshotForTests().ownerByDoc.map(([id]) => id)).toContain(docId("probe"));

    const seeded = ownershipSnapshotForTests();
    vi.stubEnv("TANDEM_OWNERSHIP", "");
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      expect(inboxScopeOf(docId("held"), A)).toBe("neither");
      expect(inboxScopeOf(docId("free"), B)).toBe("neither");
      expect(inboxScope(a, docId("held"))).toBe("neither");
      expect(inboxScope(b, docId("free"))).toBe("neither");
      const token = beginWriteClaim(docId("free"), B);
      expect(ownershipSnapshotForTests().pendingClaims).toBe(0);
      expect(settleWriteClaim(token, true)).toBe(false);
      dropWriteClaim(token);
      expect(ownershipSnapshotForTests()).toEqual(seeded);

      // A write on an unowned document, in each shape a call can arrive in:
      // the body runs directly, nothing is pending while it runs, and nothing
      // is claimed when it returns.
      for (const shape of SHAPES) {
        let release!: () => void;
        const gate = new Promise<void>((resolve) => {
          release = resolve;
        });
        let entered = false;
        const answer = shape.dispatch(() =>
          ownedWrite(
            shape.name.startsWith("a context naming") ? b : {},
            "tandem_comment",
            {
              given: docId("free"),
              resolve: () => {
                throw new Error("resolved a target while dark");
              },
            },
            async () => {
              entered = true;
              await gate;
              return envelope;
            },
          ),
        );
        // No queue: the body's head ran in the caller's own tick.
        expect(entered, shape.name).toBe(true);
        expect(ownershipSnapshotForTests(), shape.name).toEqual(seeded);
        expect(isDocOpQueueBusy(docId("free")), shape.name).toBe(false);
        release();
        expect(await answer, shape.name).toBe(envelope);
        expect(ownershipSnapshotForTests(), shape.name).toEqual(seeded);
      }
      expect(logged).not.toHaveBeenCalled();
    } finally {
      logged.mockRestore();
    }
  });

  it("a dark server that was never on records nothing at all", async () => {
    setupDoc("d");
    const { client, close } = await server("");
    try {
      const body = parseResult(
        await client.callTool({
          name: "tandem_comment",
          arguments: { from: 0, to: 5, text: "a", documentId: docId("d") },
        }),
      ) as Body;
      expect(body.error).toBe(false);
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
