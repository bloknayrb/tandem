import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  addDoc,
  getOpenDocs,
  removeDoc,
  setActiveDocId,
} from "../../../src/server/documents/registry.js";
import {
  attachCtrlObservers,
  resetForTesting as resetQueue,
  subscribe,
  unsubscribe,
} from "../../../src/server/events/queue.js";
import {
  type CollaboratorDeps,
  createLocalModelCollaborator,
} from "../../../src/server/local-model/collaborator.js";
import type { LocalModelConfig } from "../../../src/server/local-model/config.js";
import type { LoopResult } from "../../../src/server/local-model/index.js";
import {
  appendClaudeChatMessage,
  updateClaudeChatMessage,
} from "../../../src/server/mcp/awareness.js";
import { populateYDoc } from "../../../src/server/mcp/document.js";
import { getOrCreateDocument } from "../../../src/server/yjs/provider.js";
import {
  CTRL_ROOM,
  Y_MAP_CHAT,
  Y_MAP_MODE,
  Y_MAP_USER_AWARENESS,
} from "../../../src/shared/constants.js";
import type { TandemEvent } from "../../../src/shared/events/types.js";
import { withBrowser, withInternal } from "../../../src/shared/origins.js";
import type { ChatMessage } from "../../../src/shared/types.js";

const CONFIG: LocalModelConfig = {
  endpoint: "http://127.0.0.1:11434",
  modelId: "m",
  transport: "v1",
};

function cleanResult(finalContent: string): LoopResult {
  return {
    metrics: {
      turns: 1,
      toolCalls: 0,
      jsonParseFailures: 0,
      anchorResolutionFailures: 0,
      flatOnlyAnchors: 0,
      replyFailures: 0,
      blockedByLicense: 0,
      wallMs: 1,
      exit: "clean",
    },
    steps: [],
    finalContent,
    messages: [],
  };
}

function errorResult(errorMessage: string): LoopResult {
  return {
    metrics: {
      turns: 1,
      toolCalls: 0,
      jsonParseFailures: 0,
      anchorResolutionFailures: 0,
      flatOnlyAnchors: 0,
      replyFailures: 0,
      blockedByLicense: 0,
      wallMs: 1,
      exit: "error",
      errorMessage,
    },
    steps: [],
    finalContent: "",
    messages: [],
  };
}

function makeDeps(over: Partial<CollaboratorDeps> = {}): CollaboratorDeps {
  return {
    runTurn: async () => cleanResult(""),
    resolveConfig: () => CONFIG,
    subscribe: () => {},
    unsubscribe: () => {},
    ...over,
  };
}

function chatEvent(
  text: string,
  opts: {
    documentId?: string;
    messageId?: string;
    selection?: { from: number; to: number; selectedText: string } | { selectedText: string };
  } = {},
): TandemEvent {
  const messageId = opts.messageId ?? "m1";
  return {
    id: `evt_${messageId}`,
    type: "chat:message",
    timestamp: Date.now(),
    documentId: opts.documentId,
    payload: {
      messageId,
      text,
      replyTo: null,
      anchor: null,
      ...(opts.selection ? { selection: opts.selection } : {}),
    },
  };
}

function setupDoc(id: string, text: string) {
  const ydoc = getOrCreateDocument(id);
  populateYDoc(ydoc, text);
  addDoc(id, { id, filePath: `/tmp/${id}.md`, format: "md", readOnly: false, source: "file" });
  setActiveDocId(id);
  return ydoc;
}

function chatMap() {
  return getOrCreateDocument(CTRL_ROOM).getMap(Y_MAP_CHAT);
}

function chatMessages(): ChatMessage[] {
  return [...chatMap().values()] as ChatMessage[];
}

function setMode(mode: "solo" | "tandem") {
  const ctrl = getOrCreateDocument(CTRL_ROOM);
  withInternal(ctrl, () => ctrl.getMap(Y_MAP_USER_AWARENESS).set(Y_MAP_MODE, mode));
}

/** Let the queued microtask (run) execute, then await the in-flight run. */
async function drain(collab: ReturnType<typeof createLocalModelCollaborator>) {
  await Promise.resolve();
  await collab.__awaitCurrent();
}

beforeEach(() => {
  resetQueue();
  for (const id of [...getOpenDocs().keys()]) removeDoc(id);
  setActiveDocId(null);
  // Clear CTRL_ROOM chat + mode so tests don't bleed.
  const ctrl = getOrCreateDocument(CTRL_ROOM);
  withInternal(ctrl, () => {
    ctrl.getMap(Y_MAP_CHAT).clear();
    ctrl.getMap(Y_MAP_USER_AWARENESS).delete(Y_MAP_MODE);
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("collaborator — dark gating", () => {
  it("start() does not subscribe or read config while BYO_MODELS_ENABLED is false", () => {
    const subscribeSpy = vi.fn();
    const resolveSpy = vi.fn(() => CONFIG);
    const collab = createLocalModelCollaborator(
      makeDeps({ subscribe: subscribeSpy, resolveConfig: resolveSpy }),
    );
    collab.start();
    // The flag is a compile-time const false in tests → the subscriber is never
    // registered and config is never resolved. This is the load-bearing dark gate.
    expect(subscribeSpy).not.toHaveBeenCalled();
    expect(resolveSpy).not.toHaveBeenCalled();
  });
});

describe("collaborator — dispatch", () => {
  it("runs the loop for a chat:message in tandem mode and streams the reply into one message", async () => {
    setupDoc("doc-dispatch", "# Title\n\nBody.");
    let seenTask = "";
    const collab = createLocalModelCollaborator(
      makeDeps({
        runTurn: async (opts) => {
          seenTask = opts.task;
          opts.onContentDelta?.("Sure, ");
          opts.onContentDelta?.("done.");
          opts.onTurnEnd?.({ hadToolCalls: false });
          return cleanResult("Sure, done.");
        },
      }),
    );
    collab.__setConfigForTests(CONFIG);

    collab.onEvent(chatEvent("Improve this", { documentId: "doc-dispatch" }));
    await drain(collab);

    expect(seenTask).toBe("Improve this");
    const msgs = chatMessages();
    expect(msgs).toHaveLength(1);
    expect(msgs[0].author).toBe("claude");
    expect(msgs[0].text).toBe("Sure, done.");
    expect(msgs[0].documentId).toBe("doc-dispatch");
  });

  it("appends the selection context to the task", async () => {
    setupDoc("doc-sel", "Hello world");
    let seenTask = "";
    const collab = createLocalModelCollaborator(
      makeDeps({
        runTurn: async (opts) => {
          seenTask = opts.task;
          return cleanResult("");
        },
      }),
    );
    collab.__setConfigForTests(CONFIG);
    collab.onEvent(
      chatEvent("Tighten", {
        documentId: "doc-sel",
        selection: { from: 0, to: 5, selectedText: "Hello" },
      }),
    );
    await drain(collab);
    expect(seenTask).toContain("Tighten");
    expect(seenTask).toContain('The user has selected: "Hello"');
  });

  it("holds in Solo mode (no loop)", async () => {
    setupDoc("doc-solo", "Body");
    setMode("solo");
    const runTurn = vi.fn(async () => cleanResult("x"));
    const collab = createLocalModelCollaborator(makeDeps({ runTurn }));
    collab.__setConfigForTests(CONFIG);
    collab.onEvent(chatEvent("hi", { documentId: "doc-solo" }));
    await drain(collab);
    expect(runTurn).not.toHaveBeenCalled();
    expect(chatMessages()).toHaveLength(0);
  });

  it("is inert when no config is resolved (no loop, no throw)", async () => {
    setupDoc("doc-noconf", "Body");
    const runTurn = vi.fn(async () => cleanResult("x"));
    const collab = createLocalModelCollaborator(makeDeps({ runTurn }));
    collab.__setConfigForTests(null);
    collab.onEvent(chatEvent("hi", { documentId: "doc-noconf" }));
    await drain(collab);
    expect(runTurn).not.toHaveBeenCalled();
  });

  it("never fabricates a phantom room for an unknown documentId", async () => {
    const runTurn = vi.fn(async () => cleanResult("x"));
    const collab = createLocalModelCollaborator(makeDeps({ runTurn }));
    collab.__setConfigForTests(CONFIG);
    collab.onEvent(chatEvent("hi", { documentId: "never-opened" }));
    await drain(collab);
    expect(runTurn).not.toHaveBeenCalled();
    expect(getOpenDocs().has("never-opened")).toBe(false);
  });

  it("ignores empty / whitespace chat text", async () => {
    setupDoc("doc-empty", "Body");
    const runTurn = vi.fn(async () => cleanResult("x"));
    const collab = createLocalModelCollaborator(makeDeps({ runTurn }));
    collab.__setConfigForTests(CONFIG);
    collab.onEvent(chatEvent("   ", { documentId: "doc-empty" }));
    await drain(collab);
    expect(runTurn).not.toHaveBeenCalled();
  });
});

describe("collaborator — streaming sink", () => {
  it("does NOT write synchronously on a content delta (deferred flush)", async () => {
    setupDoc("doc-sync", "Body");
    let sizeAtDelta = -1;
    const collab = createLocalModelCollaborator(
      makeDeps({
        runTurn: async (opts) => {
          opts.onContentDelta?.("hi");
          sizeAtDelta = chatMap().size; // must be 0 — push() schedules, never writes
          opts.onTurnEnd?.({ hadToolCalls: false });
          return cleanResult("hi");
        },
      }),
    );
    collab.__setConfigForTests(CONFIG);
    collab.onEvent(chatEvent("go", { documentId: "doc-sync" }));
    await drain(collab);
    expect(sizeAtDelta).toBe(0);
    expect(chatMap().size).toBe(1); // flushFinal committed after the run
  });

  it("coalesces many deltas into a single message holding the full text", async () => {
    setupDoc("doc-coalesce", "Body");
    const collab = createLocalModelCollaborator(
      makeDeps({
        runTurn: async (opts) => {
          for (let i = 0; i < 20; i++) opts.onContentDelta?.("word ");
          opts.onTurnEnd?.({ hadToolCalls: false });
          return cleanResult("word ".repeat(20));
        },
      }),
    );
    collab.__setConfigForTests(CONFIG);
    collab.onEvent(chatEvent("go", { documentId: "doc-coalesce" }));
    await drain(collab);
    const msgs = chatMessages();
    expect(msgs).toHaveLength(1);
    expect(msgs[0].text).toBe("word ".repeat(20));
  });

  it("does not bleed a tool-call turn's preamble into the final answer", async () => {
    setupDoc("doc-preamble", "Body");
    const collab = createLocalModelCollaborator(
      makeDeps({
        runTurn: async (opts) => {
          opts.onContentDelta?.("Let me look. ");
          opts.onTurnEnd?.({ hadToolCalls: true }); // preamble — reset
          opts.onContentDelta?.("The answer.");
          opts.onTurnEnd?.({ hadToolCalls: false });
          return cleanResult("The answer.");
        },
      }),
    );
    collab.__setConfigForTests(CONFIG);
    collab.onEvent(chatEvent("go", { documentId: "doc-preamble" }));
    await drain(collab);
    const msgs = chatMessages();
    expect(msgs).toHaveLength(1);
    expect(msgs[0].text).toBe("The answer.");
    expect(msgs[0].text).not.toContain("Let me look");
  });
});

describe("collaborator — single-flight supersede (D-B)", () => {
  it("serializes: run B does not start until run A settles", async () => {
    setupDoc("doc-serial", "Body");
    const order: string[] = [];
    let releaseA: (() => void) | null = null;
    const collab = createLocalModelCollaborator(
      makeDeps({
        runTurn: async (opts) => {
          if (opts.task === "A") {
            order.push("A:start");
            await new Promise<void>((res) => {
              releaseA = res;
              opts.signal?.addEventListener("abort", () => res(), { once: true });
            });
            order.push("A:end");
            return cleanResult("reply A");
          }
          order.push("B:start");
          order.push("B:end");
          return cleanResult("reply B");
        },
      }),
    );
    collab.__setConfigForTests(CONFIG);

    collab.onEvent(chatEvent("A", { documentId: "doc-serial", messageId: "a" }));
    await Promise.resolve();
    expect(order).toEqual(["A:start"]); // A running, B not yet seen

    collab.onEvent(chatEvent("B", { documentId: "doc-serial", messageId: "b" }));
    await Promise.resolve();
    // B aborts A; A resolves; B then runs. Await the chain.
    if (releaseA) (releaseA as () => void)();
    await collab.__awaitCurrent();

    expect(order).toEqual(["A:start", "A:end", "B:start", "B:end"]);
  });

  it("drops a superseded run's stale reply (ownership-gated write-back)", async () => {
    setupDoc("doc-stale", "Body");
    const collab = createLocalModelCollaborator(
      makeDeps({
        runTurn: async (opts) => {
          if (opts.task === "A") {
            // Stream, then resolve LATE and IGNORE the abort — the classic
            // stale-reply race. Its streamed write must be dropped (not owner).
            opts.onContentDelta?.("reply A");
            opts.onTurnEnd?.({ hadToolCalls: false });
            await new Promise((res) => setTimeout(res, 15));
            return cleanResult("reply A");
          }
          opts.onContentDelta?.("reply B");
          opts.onTurnEnd?.({ hadToolCalls: false });
          return cleanResult("reply B");
        },
      }),
    );
    collab.__setConfigForTests(CONFIG);

    collab.onEvent(chatEvent("A", { documentId: "doc-stale", messageId: "a" }));
    await Promise.resolve();
    collab.onEvent(chatEvent("B", { documentId: "doc-stale", messageId: "b" }));
    await drain(collab);

    const texts = chatMessages().map((m) => m.text);
    expect(texts).toContain("reply B");
    expect(texts).not.toContain("reply A"); // A was superseded → its reply dropped
  });
});

describe("collaborator — lifecycle aborts", () => {
  it("aborts an in-flight run when its document is closed (H1)", async () => {
    setupDoc("doc-close", "Body");
    let aborted = false;
    const collab = createLocalModelCollaborator(
      makeDeps({
        runTurn: (opts) =>
          new Promise((res) => {
            opts.signal?.addEventListener(
              "abort",
              () => {
                aborted = true;
                res(cleanResult(""));
              },
              { once: true },
            );
          }),
      }),
    );
    collab.__setConfigForTests(CONFIG);
    collab.onEvent(chatEvent("go", { documentId: "doc-close" }));
    await Promise.resolve();
    collab.onEvent({
      id: "evt_close",
      type: "document:closed",
      timestamp: Date.now(),
      documentId: "doc-close",
      payload: { fileName: "doc-close" },
    });
    await collab.__awaitCurrent();
    expect(aborted).toBe(true);
  });

  it("aborts an in-flight run when the user switches to a different document (H2)", async () => {
    setupDoc("doc-a", "Body");
    setupDoc("doc-b", "Body");
    setActiveDocId("doc-a");
    let aborted = false;
    const collab = createLocalModelCollaborator(
      makeDeps({
        runTurn: (opts) =>
          new Promise((res) => {
            opts.signal?.addEventListener(
              "abort",
              () => {
                aborted = true;
                res(cleanResult(""));
              },
              { once: true },
            );
          }),
      }),
    );
    collab.__setConfigForTests(CONFIG);
    collab.onEvent(chatEvent("go", { documentId: "doc-a" }));
    await Promise.resolve();
    collab.onEvent({
      id: "evt_switch",
      type: "document:switched",
      timestamp: Date.now(),
      documentId: "doc-b", // switched AWAY from doc-a
      payload: { fileName: "doc-b" },
    });
    await collab.__awaitCurrent();
    expect(aborted).toBe(true);
  });
});

describe("collaborator — failure + robustness", () => {
  it("surfaces an error exit as a structured notification, never the raw error text", async () => {
    setupDoc("doc-err", "Body");
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const collab = createLocalModelCollaborator(
      makeDeps({
        runTurn: async () => errorResult("ECONNREFUSED 127.0.0.1:11434 secret-detail"),
      }),
    );
    collab.__setConfigForTests(CONFIG);
    collab.onEvent(chatEvent("go", { documentId: "doc-err" }));
    await drain(collab);
    // No chat reply on error; the raw error stays on stderr only.
    expect(chatMessages()).toHaveLength(0);
    expect(errorSpy).toHaveBeenCalled();
    errorSpy.mockRestore();
  });

  it("a throwing runTurn does not escape as an unhandled rejection (H4)", async () => {
    setupDoc("doc-throw", "Body");
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const collab = createLocalModelCollaborator(
      makeDeps({
        runTurn: async () => {
          throw new Error("boom");
        },
      }),
    );
    collab.__setConfigForTests(CONFIG);
    collab.onEvent(chatEvent("go", { documentId: "doc-throw" }));
    // __awaitCurrent must RESOLVE (the run's catch swallows) — never reject.
    await expect(drain(collab)).resolves.toBeUndefined();
    expect(errorSpy).toHaveBeenCalled();
    errorSpy.mockRestore();
  });

  it("stop() unsubscribes and aborts an in-flight run", async () => {
    setupDoc("doc-stop", "Body");
    const unsub = vi.fn();
    let aborted = false;
    const collab = createLocalModelCollaborator(
      makeDeps({
        unsubscribe: unsub,
        runTurn: (opts) =>
          new Promise((res) => {
            opts.signal?.addEventListener(
              "abort",
              () => {
                aborted = true;
                res(cleanResult(""));
              },
              { once: true },
            );
          }),
      }),
    );
    collab.__startForTests(); // real subscribe/unsubscribe pairing (no flag gate)
    collab.onEvent(chatEvent("go", { documentId: "doc-stop" }));
    await Promise.resolve();
    await collab.stop();
    expect(unsub).toHaveBeenCalled();
    expect(aborted).toBe(true);
  });
});

describe("chat write helpers — self-wake safety (load-bearing)", () => {
  it("append + update produce ZERO chat:message events; a user write produces one", async () => {
    attachCtrlObservers();
    const events: TandemEvent[] = [];
    const sub = (e: TandemEvent) => events.push(e);
    subscribe(sub);
    try {
      // Claude/local writes — both must be invisible to the channel.
      const id = appendClaudeChatMessage("streamed reply", { documentId: "d1" });
      updateClaudeChatMessage(id, "streamed reply (more)");

      // Control: a user (browser-origin) write DOES fire one chat:message.
      const ctrl = getOrCreateDocument(CTRL_ROOM);
      const uid = "user-msg-1";
      withBrowser(ctrl, () =>
        ctrl.getMap(Y_MAP_CHAT).set(uid, {
          id: uid,
          author: "user",
          text: "a question",
          timestamp: Date.now(),
          read: false,
        } satisfies ChatMessage),
      );

      const chatEvents = events.filter((e) => e.type === "chat:message");
      expect(chatEvents).toHaveLength(1);
      expect((chatEvents[0].payload as { text: string }).text).toBe("a question");
    } finally {
      unsubscribe(sub);
    }
  });
});

describe("updateClaudeChatMessage — shape preservation", () => {
  it("changes only text, freezing id/author/timestamp/read/documentId/replyTo", () => {
    const id = appendClaudeChatMessage("first", { documentId: "d2", replyTo: "u9" });
    const before = chatMap().get(id) as ChatMessage;
    updateClaudeChatMessage(id, "second");
    const after = chatMap().get(id) as ChatMessage;
    expect(after.text).toBe("second");
    expect(after.id).toBe(before.id);
    expect(after.author).toBe("claude");
    expect(after.timestamp).toBe(before.timestamp); // NOT re-stamped (sort stability)
    expect(after.read).toBe(before.read);
    expect(after.documentId).toBe("d2");
    expect(after.replyTo).toBe("u9");
  });

  it("is a no-op when the message id is absent", () => {
    expect(() => updateClaudeChatMessage("does-not-exist", "x")).not.toThrow();
    expect(chatMap().has("does-not-exist")).toBe(false);
  });
});

describe("dark audit — engine reachability", () => {
  // The load-bearing dark guarantee (M1.2): collaborator.ts is the ONLY bridge
  // from the running server into the local-model engine. A second importer could
  // run the loop (→ createAnnotation → review-pending toast) outside the flag gate.
  it("no server file outside local-model/ imports the engine except via collaborator", () => {
    const serverDir = join(process.cwd(), "src", "server");
    const walk = (dir: string): string[] => {
      const out: string[] = [];
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        const p = join(dir, e.name);
        if (e.isDirectory()) out.push(...walk(p));
        else if (e.name.endsWith(".ts")) out.push(p);
      }
      return out;
    };
    const offenders: string[] = [];
    for (const file of walk(serverDir)) {
      const norm = file.replace(/\\/g, "/");
      if (norm.includes("/local-model/")) continue; // engine internals may import each other
      const src = readFileSync(file, "utf8");
      // An import of any local-model module OTHER than the collaborator wiring is a leak.
      if (/from\s+["'][^"']*local-model\/(?!collaborator)/.test(src)) offenders.push(norm);
    }
    expect(offenders).toEqual([]);
  });
});
