import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { bumpContentGeneration } from "../../../src/server/documents/content-generation.js";
import { getOpenDocs } from "../../../src/server/documents/registry.js";
import {
  addDoc,
  removeDoc,
  setActiveDocId,
} from "../../../src/server/documents/registry-testing.js";
import {
  attachCtrlObservers,
  resetForTesting as resetQueue,
} from "../../../src/server/events/queue.js";
import {
  CHAT_NOTICE_TEXT,
  CHAT_NOTICE_UNUSABLE_TEXT,
  type CollaboratorDeps,
  createLocalModelCollaborator,
  DEFAULT_COLLABORATOR_DEPS,
  UNUSABLE_NOTICE,
} from "../../../src/server/local-model/collaborator.js";
import type { LocalModelConfig } from "../../../src/server/local-model/config.js";
import type { LocalModelUnusable } from "../../../src/server/local-model/config-source.js";
import type { LoopResult, RunTurnOpts } from "../../../src/server/local-model/index.js";
import { populateYDoc } from "../../../src/server/mcp/document.js";
import {
  __resetChatAnswererForTests,
  CHAT_ANSWERER_FILE_NAME,
} from "../../../src/server/models/chat-answerer.js";
import { LOCAL_RUN_GENERATION } from "../../../src/server/models/local-run-generation.js";
import {
  getBuffer,
  resetForTesting as resetNotifications,
} from "../../../src/server/notifications.js";
import { clearStartupNotices } from "../../../src/server/startup-notices.js";
import { getOrCreateDocument, removeDocument } from "../../../src/server/yjs/provider.js";
import {
  CTRL_ROOM,
  Y_MAP_CHAT,
  Y_MAP_CHAT_STREAM,
  Y_MAP_MODE,
  Y_MAP_USER_AWARENESS,
} from "../../../src/shared/constants.js";
import type { TandemEvent } from "../../../src/shared/events/types.js";
import { effectiveLocalRun } from "../../../src/shared/local-run.js";
import type { ChatAnswerer } from "../../../src/shared/models/contract.js";
import { withBrowser, withInternal } from "../../../src/shared/origins.js";
import type { ChatMessage } from "../../../src/shared/types.js";

/**
 * Who answers chat, the local model's side (#1123 A1): the switch read
 * through `chatAnswerer`, the switch-change listener, Solo in the chat tier,
 * the chat notices, and the run state on the user's row.
 *
 * Every "runs nothing / posts nothing" case with Claude chosen has its
 * positive control beside it with the local model chosen.
 */

const CONFIG: LocalModelConfig = {
  endpoint: "http://127.0.0.1:11434",
  modelId: "m",
  transport: "v1",
  agentIdentity: { provider: "local-ollama", displayName: "Test Model" },
};

type Exit = LoopResult["metrics"]["exit"];

function result(exit: Exit = "clean"): LoopResult {
  return {
    metrics: {
      turns: 1,
      toolCalls: 0,
      jsonParseFailures: 0,
      anchorResolutionFailures: 0,
      flatOnlyAnchors: 0,
      replyFailures: 0,
      wallMs: 1,
      exit,
    },
    steps: [],
    finalContent: "",
    messages: [],
  };
}

/** A switch the test moves, with a real listener set. */
function makeSwitch(initial: ChatAnswerer) {
  let now = initial;
  const listeners = new Set<(a: ChatAnswerer) => void>();
  return {
    read: () => now,
    on: (cb: (a: ChatAnswerer) => void) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    set(next: ChatAnswerer) {
      now = next;
      for (const cb of listeners) cb(next);
    },
    listeners,
  };
}

function deps(over: Partial<CollaboratorDeps> = {}): CollaboratorDeps {
  return {
    runTurn: async (opts) => {
      opts.onContentDelta?.("hello");
      return result();
    },
    resolveConfig: () => CONFIG,
    subscribe: () => {},
    unsubscribe: () => {},
    aiRefusal: () => null,
    chatAnswerer: () => "local",
    ...over,
  };
}

function setupDoc(id: string, text = "Body") {
  const ydoc = getOrCreateDocument(id);
  populateYDoc(ydoc, text);
  addDoc(id, { id, filePath: `/tmp/${id}.md`, format: "md", readOnly: false, source: "file" });
  setActiveDocId(id);
  return ydoc;
}

function setMode(mode: "solo" | "tandem") {
  const ctrl = getOrCreateDocument(CTRL_ROOM);
  withInternal(ctrl, () => ctrl.getMap(Y_MAP_USER_AWARENESS).set(Y_MAP_MODE, mode));
}

const chatMap = () => getOrCreateDocument(CTRL_ROOM).getMap(Y_MAP_CHAT);
const rows = () => [...chatMap().values()] as ChatMessage[];
const claudeRows = () => rows().filter((m) => m.author === "claude");
const row = (id: string) => chatMap().get(id) as ChatMessage | undefined;

/** The user's message, as the editor writes it, and the event it raises. */
function userChat(id: string, documentId?: string, text = "hi"): TandemEvent {
  const ctrl = getOrCreateDocument(CTRL_ROOM);
  const msg: ChatMessage = {
    id,
    author: "user",
    text,
    timestamp: Date.now(),
    read: false,
    ...(documentId ? { documentId } : {}),
  };
  withBrowser(ctrl, () => chatMap().set(id, msg));
  return {
    id: `evt_${id}`,
    type: "chat:message",
    timestamp: Date.now(),
    documentId,
    payload: { messageId: id, text, replyTo: null, anchor: null },
  };
}

async function drain(collab: ReturnType<typeof createLocalModelCollaborator>) {
  await Promise.resolve();
  await Promise.resolve();
  await collab.__awaitCurrent();
  await Promise.resolve();
}

/** A run parked inside `runTurn` until released. */
function parked() {
  let release: (r?: LoopResult) => void = () => {};
  let started: (o: RunTurnOpts) => void = () => {};
  const entered = new Promise<RunTurnOpts>((r) => {
    started = r;
  });
  const runTurn = vi.fn(async (opts: RunTurnOpts) => {
    started(opts);
    return new Promise<LoopResult>((resolve) => {
      release = (r) => resolve(r ?? result());
      opts.signal?.addEventListener("abort", () => resolve(result("aborted")));
    });
  });
  return { runTurn, entered, release: (r?: LoopResult) => release(r) };
}

beforeEach(() => {
  resetQueue();
  resetNotifications();
  clearStartupNotices();
  for (const id of [...getOpenDocs().keys()]) removeDoc(id);
  setActiveDocId(null);
  const ctrl = getOrCreateDocument(CTRL_ROOM);
  withInternal(ctrl, () => {
    ctrl.getMap(Y_MAP_CHAT).clear();
    ctrl.getMap(Y_MAP_CHAT_STREAM).clear();
  });
  setMode("tandem");
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("Claude chosen: the local model runs nothing and posts nothing (R2.1)", () => {
  for (const [label, over] of [
    ["the switch at Claude", { chatAnswerer: () => "claude" as const }],
    ["no switch dependency at all", { chatAnswerer: undefined }],
  ] as const) {
    it(`${label}: no run, no reply, no notice, no toast — whatever resolves`, async () => {
      setupDoc("doc-c");
      const runTurn = vi.fn(async () => result());
      for (const resolveConfig of [() => CONFIG, () => null]) {
        const collab = createLocalModelCollaborator(
          deps({
            ...over,
            runTurn,
            resolveConfig,
            diagnose: (): LocalModelUnusable => ({
              reason: "no-endpoint",
              stateKey: "k",
              detail: "d",
            }),
          }),
        );
        collab.onEvent(userChat(`c-${rows().length}`, "doc-c"));
        collab.onEvent(userChat(`nodoc-${rows().length}`, "doc-gone"));
        await drain(collab);
      }
      expect(runTurn).not.toHaveBeenCalled();
      expect(claudeRows()).toEqual([]);
      expect(getBuffer()).toEqual([]);
      expect(rows().every((m) => m.localRun === undefined)).toBe(true);
    });
  }

  it("positive control: the same chats with the local model chosen run and post", async () => {
    setupDoc("doc-c");
    const runTurn = vi.fn(async (opts: RunTurnOpts) => {
      opts.onContentDelta?.("hello");
      return result();
    });
    const collab = createLocalModelCollaborator(deps({ runTurn }));
    collab.onEvent(userChat("c1", "doc-c"));
    await drain(collab);
    collab.onEvent(userChat("c2", "doc-gone"));
    await drain(collab);
    expect(runTurn).toHaveBeenCalledTimes(1);
    expect(claudeRows().map((m) => m.chatNotice ?? "reply")).toEqual(["reply", "no-document"]);
  });

  it("a run in flight at the switch to Claude is aborted: silent, no 'content was replaced' notice", async () => {
    setupDoc("doc-sw");
    const sw = makeSwitch("local");
    const p = parked();
    const collab = createLocalModelCollaborator(
      deps({ runTurn: p.runTurn, chatAnswerer: sw.read, onChatAnswererChanged: sw.on }),
    );
    collab.__startForTests();
    collab.onEvent(userChat("u1", "doc-sw"));
    const opts = await p.entered;
    sw.set("claude");
    expect(opts.signal?.aborted).toBe(true);
    await drain(collab);
    expect(getBuffer()).toEqual([]);
    expect(row("u1")?.localRun).toEqual({
      status: "stopped",
      reason: "aborted",
      generation: LOCAL_RUN_GENERATION,
    });
    await collab.stop();
    expect(sw.listeners.size).toBe(0);
  });

  it("a switch to Claude between the chat and the run's start: the run never starts", async () => {
    setupDoc("doc-sw2");
    const sw = makeSwitch("local");
    const runTurn = vi.fn(async () => result());
    const collab = createLocalModelCollaborator(deps({ runTurn, chatAnswerer: sw.read }));
    collab.onEvent(userChat("u1", "doc-sw2"));
    sw.set("claude"); // before the run's microtask
    await drain(collab);
    expect(runTurn).not.toHaveBeenCalled();
    expect(claudeRows()).toEqual([]);
  });

  it("the dark guard end to end: a stored 'local' with the switch never primed, under the production seams, runs nothing", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tandem-answerer-dark-"));
    try {
      __resetChatAnswererForTests(dir);
      fs.writeFileSync(
        path.join(dir, CHAT_ANSWERER_FILE_NAME),
        JSON.stringify({ version: 1, answerer: "local" }),
      );
      setupDoc("doc-dark");
      const runTurn = vi.fn(async () => result());
      const collab = createLocalModelCollaborator({
        ...deps({ runTurn }),
        chatAnswerer: DEFAULT_COLLABORATOR_DEPS.chatAnswerer,
      });
      collab.onEvent(userChat("u-dark", "doc-dark"));
      collab.onEvent(userChat("u-dark2"));
      await drain(collab);
      expect(runTurn).not.toHaveBeenCalled();
      expect(claudeRows()).toEqual([]);
    } finally {
      __resetChatAnswererForTests();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("the local model chosen: Tandem and Solo (R3.1)", () => {
  it("Tandem mode with editing on: the run may edit", async () => {
    setupDoc("doc-t");
    const p = parked();
    const collab = createLocalModelCollaborator(
      deps({ runTurn: p.runTurn, editingState: () => ({ enabled: true, offEpoch: 0 }) }),
    );
    collab.onEvent(userChat("u1", "doc-t"));
    const opts = await p.entered;
    expect(opts.editingAllowed()).toBe(true);
    p.release();
    await drain(collab);
  });

  it("Solo with editing on: chat tier from the start, and it stays so when Tandem returns", async () => {
    setupDoc("doc-s");
    setMode("solo");
    const p = parked();
    const collab = createLocalModelCollaborator(
      deps({ runTurn: p.runTurn, editingState: () => ({ enabled: true, offEpoch: 0 }) }),
    );
    collab.onEvent(userChat("u1", "doc-s"));
    const opts = await p.entered;
    expect(opts.editingAllowed()).toBe(false);
    setMode("tandem");
    expect(opts.editingAllowed()).toBe(false);
    p.release();
    await drain(collab);
  });

  it("an absent mode key is not Tandem: chat tier (fails closed)", async () => {
    setupDoc("doc-indet");
    const ctrl = getOrCreateDocument(CTRL_ROOM);
    withInternal(ctrl, () => ctrl.getMap(Y_MAP_USER_AWARENESS).delete(Y_MAP_MODE));
    const p = parked();
    const collab = createLocalModelCollaborator(
      deps({ runTurn: p.runTurn, editingState: () => ({ enabled: true, offEpoch: 0 }) }),
    );
    collab.onEvent(userChat("u1", "doc-indet"));
    const opts = await p.entered;
    expect(opts.editingAllowed()).toBe(false);
    p.release();
    await drain(collab);
  });

  it("started in Tandem, then Solo: it can no longer edit — and Tandem → Solo → Tandem between two calls still counts", async () => {
    setupDoc("doc-ts");
    // Installs the mode observer that counts the mode leaving Tandem.
    attachCtrlObservers();
    {
      for (const roundTrip of [false, true]) {
        const p = parked();
        const collab = createLocalModelCollaborator(
          deps({ runTurn: p.runTurn, editingState: () => ({ enabled: true, offEpoch: 0 }) }),
        );
        collab.onEvent(userChat(`u-${roundTrip}`, "doc-ts"));
        const opts = await p.entered;
        expect(opts.editingAllowed()).toBe(true);
        setMode("solo");
        if (roundTrip) setMode("tandem");
        expect(opts.editingAllowed()).toBe(false);
        setMode("tandem");
        expect(opts.editingAllowed()).toBe(false);
        p.release();
        await drain(collab);
      }
    }
  });

  it("Solo end to end through the real engine, editing on: offered only reading tools, a forged comment is refused, no annotation, a reply", async () => {
    const { runLocalModelTurn, READ_TOOL_NAMES } = await import(
      "../../../src/server/local-model/index.js"
    );
    const { Y_MAP_ANNOTATIONS } = await import("../../../src/shared/constants.js");
    const ydoc = setupDoc("doc-solo-real", "The quick brown fox.");
    setMode("solo");
    const sse = (delta: unknown): Response =>
      new Response(`data: ${JSON.stringify({ choices: [{ delta }] })}\ndata: [DONE]\n`);
    const offered: string[][] = [];
    vi.stubGlobal("fetch", async (_input: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { tools?: { function: { name: string } }[] };
      offered.push((body.tools ?? []).map((t) => t.function.name));
      if (offered.length === 1) {
        return sse({
          tool_calls: [
            {
              index: 0,
              id: "c1",
              function: {
                name: "comment_on_quote",
                arguments: JSON.stringify({ quoted_text: "quick", comment: "forged" }),
              },
            },
          ],
        });
      }
      return sse({ content: "Just an answer." });
    });
    try {
      const collab = createLocalModelCollaborator(
        deps({
          runTurn: runLocalModelTurn,
          editingState: () => ({ enabled: true, offEpoch: 0 }),
        }),
      );
      collab.onEvent(userChat("u-real", "doc-solo-real"));
      await drain(collab);
      expect(offered.length).toBeGreaterThanOrEqual(2);
      for (const tools of offered) {
        for (const t of tools) expect([...READ_TOOL_NAMES]).toContain(t);
      }
      expect(ydoc.getMap(Y_MAP_ANNOTATIONS).size).toBe(0);
      expect(claudeRows().find((m) => m.replyTo === "u-real")?.text).toBe("Just an answer.");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("positive control: the same script in Tandem with editing on writes the comment", async () => {
    const { runLocalModelTurn } = await import("../../../src/server/local-model/index.js");
    const { Y_MAP_ANNOTATIONS } = await import("../../../src/shared/constants.js");
    const ydoc = setupDoc("doc-tandem-real", "The quick brown fox.");
    const sse = (delta: unknown): Response =>
      new Response(`data: ${JSON.stringify({ choices: [{ delta }] })}\ndata: [DONE]\n`);
    let n = 0;
    vi.stubGlobal("fetch", async () => {
      n += 1;
      if (n === 1) {
        return sse({
          tool_calls: [
            {
              index: 0,
              id: "c1",
              function: {
                name: "comment_on_quote",
                arguments: JSON.stringify({ quoted_text: "quick", comment: "fine" }),
              },
            },
          ],
        });
      }
      return sse({ content: "Commented." });
    });
    try {
      const collab = createLocalModelCollaborator(
        deps({
          runTurn: runLocalModelTurn,
          editingState: () => ({ enabled: true, offEpoch: 0 }),
        }),
      );
      collab.onEvent(userChat("u-real2", "doc-tandem-real"));
      await drain(collab);
      expect(ydoc.getMap(Y_MAP_ANNOTATIONS).size).toBe(1);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe("chat notices (R3.2, R3.3)", () => {
  const noticeRows = () => claudeRows().filter((m) => m.chatNotice !== undefined);

  it("no document open: the no-document notice, once per chat, with no documentId", async () => {
    const runTurn = vi.fn(async () => result());
    const collab = createLocalModelCollaborator(deps({ runTurn }));
    collab.onEvent(userChat("u1"));
    collab.onEvent(userChat("u2"));
    await drain(collab);
    expect(runTurn).not.toHaveBeenCalled();
    expect(noticeRows().map((m) => [m.replyTo, m.chatNotice, m.text, m.documentId])).toEqual([
      ["u1", "no-document", CHAT_NOTICE_TEXT["no-document"], undefined],
      ["u2", "no-document", CHAT_NOTICE_TEXT["no-document"], undefined],
    ]);
    for (const m of noticeRows()) expect(m.agentIdentity).toBeUndefined();
  });

  it("a closed documentId: the no-document notice, with no documentId", async () => {
    setupDoc("doc-open");
    const collab = createLocalModelCollaborator(deps());
    collab.onEvent(userChat("u1", "doc-closed"));
    await drain(collab);
    expect(noticeRows().map((m) => [m.chatNotice, m.documentId])).toEqual([
      ["no-document", undefined],
    ]);
  });

  it("no document AND nothing resolving: the no-document notice wins", async () => {
    const collab = createLocalModelCollaborator(deps({ resolveConfig: () => null }));
    collab.onEvent(userChat("u1"));
    await drain(collab);
    expect(noticeRows().map((m) => m.chatNotice)).toEqual(["no-document"]);
  });

  it("nothing resolving (none saved, a disabled, deleted or cloud default — all diagnose to nothing): the no-local-model notice every chat, no toast", async () => {
    setupDoc("doc-n");
    const collab = createLocalModelCollaborator(
      deps({ resolveConfig: () => null, diagnose: () => null }),
    );
    for (const id of ["u1", "u2", "u3"]) collab.onEvent(userChat(id, "doc-n"));
    await drain(collab);
    expect(noticeRows().map((m) => [m.replyTo, m.chatNotice, m.text, m.documentId])).toEqual([
      ["u1", "no-local-model", CHAT_NOTICE_TEXT["no-local-model"], "doc-n"],
      ["u2", "no-local-model", CHAT_NOTICE_TEXT["no-local-model"], "doc-n"],
      ["u3", "no-local-model", CHAT_NOTICE_TEXT["no-local-model"], "doc-n"],
    ]);
    expect(getBuffer()).toEqual([]);
  });

  it("an unusable state: each chat's notice carries the same remedy as the toast", async () => {
    setupDoc("doc-rem");
    for (const reason of ["no-default-chosen", "no-endpoint", "endpoint-rejected"] as const) {
      resetNotifications();
      const collab = createLocalModelCollaborator(
        deps({
          resolveConfig: () => null,
          diagnose: () => ({ reason, stateKey: reason, detail: "d" }),
        }),
      );
      collab.onEvent(userChat(`rem-${reason}`, "doc-rem"));
      await drain(collab);
      const notice = noticeRows().find((m) => m.replyTo === `rem-${reason}`);
      expect(notice?.text).toBe(CHAT_NOTICE_UNUSABLE_TEXT[reason]);
      expect(getBuffer().map((n) => n.message)).toEqual([UNUSABLE_NOTICE[reason]]);
    }
  });

  it("an unusable state: the chat notice every chat, and the toast once", async () => {
    setupDoc("doc-u");
    const collab = createLocalModelCollaborator(
      deps({
        resolveConfig: () => null,
        diagnose: () => ({ reason: "no-default-chosen", stateKey: "k1", detail: "d" }),
      }),
    );
    for (const id of ["u1", "u2"]) collab.onEvent(userChat(id, "doc-u"));
    await drain(collab);
    expect(noticeRows()).toHaveLength(2);
    expect(getBuffer().map((n) => n.message)).toEqual([UNUSABLE_NOTICE["no-default-chosen"]]);
  });

  it("the licence refusing: no run, no notice, no toast — whatever the cause would be", async () => {
    setupDoc("doc-l");
    const refusal = {
      error: "LICENSE_REQUIRED" as const,
      kind: "unlicensed" as const,
      message: "x",
    };
    for (const over of [
      {},
      { resolveConfig: () => null },
      {
        resolveConfig: () => null,
        diagnose: (): LocalModelUnusable => ({ reason: "no-endpoint", stateKey: "k", detail: "d" }),
      },
    ]) {
      const runTurn = vi.fn(async () => result());
      const collab = createLocalModelCollaborator(
        deps({ ...over, runTurn, aiRefusal: () => refusal }),
      );
      collab.onEvent(userChat(`a-${rows().length}`, "doc-l"));
      collab.onEvent(userChat(`b-${rows().length}`));
      await drain(collab);
      expect(runTurn).not.toHaveBeenCalled();
    }
    expect(claudeRows()).toEqual([]);
    expect(getBuffer()).toEqual([]);
  });

  it("a notice supersedes a run in flight, as any new chat does", async () => {
    setupDoc("doc-sup");
    const p = parked();
    const collab = createLocalModelCollaborator(deps({ runTurn: p.runTurn }));
    collab.onEvent(userChat("u1", "doc-sup"));
    const opts = await p.entered;
    collab.onEvent(userChat("u2", "doc-gone"));
    await drain(collab);
    expect(opts.signal?.aborted).toBe(true);
    expect(noticeRows().map((m) => m.replyTo)).toEqual(["u2"]);
    expect(row("u1")?.localRun?.status).toBe("stopped");
    expect(row("u1")?.localRun?.reason).toBe("aborted");
  });

  it("a document closed while the run waited for its predecessor: the no-document notice", async () => {
    setupDoc("doc-a");
    setupDoc("doc-b");
    const p = parked();
    const second = vi.fn(async (_o: RunTurnOpts) => result());
    let n = 0;
    const collab = createLocalModelCollaborator(
      deps({ runTurn: (o) => (n++ === 0 ? p.runTurn(o) : second(o)) }),
    );
    collab.onEvent(userChat("u1", "doc-a"));
    await p.entered;
    collab.onEvent(userChat("u2", "doc-b"));
    await Promise.resolve();
    removeDoc("doc-b");
    p.release();
    await drain(collab);
    await drain(collab);
    expect(second).not.toHaveBeenCalled();
    expect(noticeRows().map((m) => [m.replyTo, m.chatNotice])).toEqual([["u2", "no-document"]]);
    expect(row("u2")?.localRun).toBeUndefined();
  });

  it("a switch to Claude after the chat but before its notice is posted: nothing is posted", async () => {
    const sw = makeSwitch("local");
    const collab = createLocalModelCollaborator(deps({ chatAnswerer: sw.read }));
    collab.onEvent(userChat("u1"));
    sw.set("claude");
    await drain(collab);
    expect(claudeRows()).toEqual([]);
  });
});

describe("run state on the user's row (R3.4)", () => {
  const G = LOCAL_RUN_GENERATION;

  it("running while the run is in flight, then replied with the reply's id", async () => {
    setupDoc("doc-r");
    const p = parked();
    const collab = createLocalModelCollaborator(
      deps({
        runTurn: async (o) => {
          o.onContentDelta?.("answer");
          return p.runTurn(o);
        },
      }),
    );
    collab.onEvent(userChat("u1", "doc-r"));
    await p.entered;
    expect(row("u1")?.localRun).toEqual({ status: "running", generation: G });
    p.release();
    await drain(collab);
    const reply = claudeRows().find((m) => m.replyTo === "u1");
    expect(reply).toBeDefined();
    expect(row("u1")?.localRun).toEqual({ status: "replied", replyId: reply?.id, generation: G });
  });

  const exits: Array<[Exit, string, boolean]> = [
    ["clean", "no-reply", false],
    ["max_turns", "step-limit", true],
    ["max_tool_calls", "step-limit", false],
    ["editing_off", "editing-off", false],
    ["timeout", "timeout", true],
    ["error", "error", true],
  ];
  for (const [exit, reason, partial] of exits) {
    it(`exit ${exit}${partial ? " with a partial reply" : ""}: stopped, ${reason}`, async () => {
      setupDoc("doc-x");
      const collab = createLocalModelCollaborator(
        deps({
          runTurn: async (o) => {
            if (partial) o.onContentDelta?.("partial");
            return result(exit);
          },
        }),
      );
      collab.onEvent(userChat("u1", "doc-x"));
      await drain(collab);
      const reply = claudeRows().find((m) => m.replyTo === "u1");
      expect(row("u1")?.localRun).toEqual({
        status: "stopped",
        reason,
        generation: G,
        ...(partial ? { replyId: reply?.id } : {}),
      });
      expect(Boolean(reply)).toBe(partial);
    });
  }

  it("a throw before the run started (building its prompt): stopped, error", async () => {
    setupDoc("doc-throw-early");
    const collab = createLocalModelCollaborator(
      deps({
        editingState: () => {
          throw new Error("boom");
        },
      }),
    );
    collab.onEvent(userChat("u1", "doc-throw-early"));
    await drain(collab);
    expect(row("u1")?.localRun).toEqual({ status: "stopped", reason: "error", generation: G });
  });

  it("editing_off whose cause was Solo (the setting allowed it): stopped, solo, and the toast names Solo", async () => {
    setupDoc("doc-solo-stop");
    attachCtrlObservers();
    const collab = createLocalModelCollaborator(
      deps({
        editingState: () => ({ enabled: true, offEpoch: 0 }),
        runTurn: async (o) => {
          expect(o.editingAllowed()).toBe(true);
          setMode("solo");
          expect(o.editingAllowed()).toBe(false);
          return result("editing_off");
        },
      }),
    );
    collab.onEvent(userChat("u1", "doc-solo-stop"));
    await drain(collab);
    expect(row("u1")?.localRun).toEqual({ status: "stopped", reason: "solo", generation: G });
    expect(getBuffer().map((n) => n.message)).toEqual([
      "The local model stopped without replying: it tried to comment on or change the document, which local models do not do in Solo mode. Ask again for an answer in chat.",
    ]);
  });

  it("editing_off with the mode key absent: refused (privacy) but not blamed on Solo — stopped, mode-unknown", async () => {
    setupDoc("doc-indet-stop");
    const ctrl = getOrCreateDocument(CTRL_ROOM);
    withInternal(ctrl, () => ctrl.getMap(Y_MAP_USER_AWARENESS).delete(Y_MAP_MODE));
    const collab = createLocalModelCollaborator(
      deps({
        editingState: () => ({ enabled: true, offEpoch: 0 }),
        runTurn: async (o) => {
          expect(o.editingAllowed()).toBe(false);
          return result("editing_off");
        },
      }),
    );
    collab.onEvent(userChat("u1", "doc-indet-stop"));
    await drain(collab);
    expect(row("u1")?.localRun).toEqual({
      status: "stopped",
      reason: "mode-unknown",
      generation: G,
    });
    const toast = getBuffer()[0]?.message ?? "";
    expect(toast).not.toMatch(/Solo mode\./);
    expect(toast).toContain("cannot tell whether it is in Solo or Tandem mode");
  });

  describe("the stop reason is judged from the start state AND the mode at refusal (round 3 L4)", () => {
    const deleteMode = () => {
      const ctrl = getOrCreateDocument(CTRL_ROOM);
      withInternal(ctrl, () => ctrl.getMap(Y_MAP_USER_AWARENESS).delete(Y_MAP_MODE));
    };
    async function stopReason(setup: () => void, during: () => void, id: string) {
      setupDoc(`doc-${id}`);
      attachCtrlObservers();
      setup();
      const collab = createLocalModelCollaborator(
        deps({
          editingState: () => ({ enabled: true, offEpoch: 0 }),
          runTurn: async (o) => {
            during();
            expect(o.editingAllowed()).toBe(false);
            return result("editing_off");
          },
        }),
      );
      collab.onEvent(userChat(id, `doc-${id}`));
      await drain(collab);
      return row(id)?.localRun?.reason;
    }

    it("started with the mode key absent, refused once the mode reads Tandem: mode-unknown, not Solo", async () => {
      expect(await stopReason(deleteMode, () => setMode("tandem"), "x1")).toBe("mode-unknown");
    });

    it("started in Solo, refused once the mode key is absent: solo", async () => {
      expect(await stopReason(() => setMode("solo"), deleteMode, "x2")).toBe("solo");
    });

    it("started in Tandem, the mode key went away and came back as Tandem: mode-unknown", async () => {
      expect(
        await stopReason(
          () => setMode("tandem"),
          () => {
            deleteMode();
            setMode("tandem");
          },
          "x3",
        ),
      ).toBe("mode-unknown");
    });

    it("started in Tandem, went to Solo and back to Tandem: solo", async () => {
      expect(
        await stopReason(
          () => setMode("tandem"),
          () => {
            setMode("solo");
            setMode("tandem");
          },
          "x4",
        ),
      ).toBe("solo");
    });
  });

  it("editing_off whose cause was the setting: stopped, editing-off, and the toast does not name Solo", async () => {
    setupDoc("doc-off-stop");
    const editing = { enabled: true, offEpoch: 0 };
    const collab = createLocalModelCollaborator(
      deps({
        editingState: () => ({ ...editing }),
        runTurn: async (o) => {
          editing.enabled = false;
          expect(o.editingAllowed()).toBe(false);
          return result("editing_off");
        },
      }),
    );
    collab.onEvent(userChat("u1", "doc-off-stop"));
    await drain(collab);
    expect(row("u1")?.localRun?.reason).toBe("editing-off");
    expect(getBuffer()[0]?.message).not.toMatch(/Solo/);
  });

  it("a throwing runTurn: stopped, error", async () => {
    setupDoc("doc-throw");
    const collab = createLocalModelCollaborator(
      deps({
        runTurn: async () => {
          throw new Error("boom");
        },
      }),
    );
    collab.onEvent(userChat("u1", "doc-throw"));
    await drain(collab);
    expect(row("u1")?.localRun).toEqual({ status: "stopped", reason: "error", generation: G });
  });

  it("the document closed mid-run: stopped, aborted", async () => {
    setupDoc("doc-close");
    const p = parked();
    const collab = createLocalModelCollaborator(deps({ runTurn: p.runTurn }));
    collab.onEvent(userChat("u1", "doc-close"));
    await p.entered;
    collab.onEvent({
      id: "e",
      type: "document:closed",
      timestamp: Date.now(),
      documentId: "doc-close",
      payload: {},
    } as unknown as TandemEvent);
    await drain(collab);
    expect(row("u1")?.localRun?.reason).toBe("aborted");
  });

  it("content replaced mid-run (doc-swapped, same instance): stopped, content-replaced", async () => {
    const ydoc = setupDoc("doc-repl");
    const collab = createLocalModelCollaborator(
      deps({
        runTurn: async () => {
          bumpContentGeneration(ydoc);
          return result("doc-swapped");
        },
      }),
    );
    collab.onEvent(userChat("u1", "doc-repl"));
    await drain(collab);
    expect(row("u1")?.localRun?.reason).toBe("content-replaced");
  });

  it("the document reconnected mid-run (a new instance): stopped, reconnected", async () => {
    setupDoc("doc-rec");
    const collab = createLocalModelCollaborator(
      deps({
        runTurn: async () => {
          const old = getOrCreateDocument("doc-rec");
          removeDocument("doc-rec");
          populateYDoc(getOrCreateDocument("doc-rec"), "Body");
          old.destroy();
          return result("doc-swapped");
        },
      }),
    );
    collab.onEvent(userChat("u1", "doc-rec"));
    await drain(collab);
    expect(row("u1")?.localRun?.reason).toBe("reconnected");
  });

  it("superseded before it started: stopped, aborted, and the successor's state is its own", async () => {
    setupDoc("doc-q");
    const p = parked();
    let n = 0;
    const collab = createLocalModelCollaborator(
      deps({ runTurn: (o) => (n++ === 0 ? p.runTurn(o) : Promise.resolve(result())) }),
    );
    collab.onEvent(userChat("u1", "doc-q"));
    await p.entered;
    collab.onEvent(userChat("u2", "doc-q"));
    collab.onEvent(userChat("u3", "doc-q"));
    await drain(collab);
    await drain(collab);
    expect(row("u1")?.localRun?.reason).toBe("aborted");
    expect(row("u2")?.localRun).toEqual({ status: "stopped", reason: "aborted", generation: G });
    expect(row("u3")?.localRun).toEqual({ status: "stopped", reason: "no-reply", generation: G });
  });

  it("a chat row cleared mid-run gets nothing written back", async () => {
    setupDoc("doc-clr");
    const p = parked();
    const collab = createLocalModelCollaborator(deps({ runTurn: p.runTurn }));
    collab.onEvent(userChat("u1", "doc-clr"));
    await p.entered;
    const ctrl = getOrCreateDocument(CTRL_ROOM);
    withInternal(ctrl, () => chatMap().clear());
    p.release();
    await drain(collab);
    expect(row("u1")).toBeUndefined();
  });

  it("a 'running' state from another server process (one that stopped mid-run) reads as stopped, interrupted", () => {
    const stale = { status: "running" as const, generation: "an-earlier-process" };
    expect(effectiveLocalRun(stale, G)).toEqual({
      status: "stopped",
      reason: "interrupted",
      generation: "an-earlier-process",
    });
    expect(effectiveLocalRun({ status: "running", generation: G }, G)).toEqual({
      status: "running",
      generation: G,
    });
    expect(effectiveLocalRun(stale, null)).toEqual(stale);
    expect(effectiveLocalRun(undefined, G)).toBeUndefined();
    const ended = { status: "stopped" as const, reason: "timeout" as const, generation: "old" };
    expect(effectiveLocalRun(ended, G)).toEqual(ended);
  });

  it("the run id is not the Hocuspocus generation token", async () => {
    const { getGenerationId, writeGenerationId } = await import(
      "../../../src/server/mcp/document-service.js"
    );
    writeGenerationId();
    expect(LOCAL_RUN_GENERATION).not.toBe(getGenerationId());
  });
});
