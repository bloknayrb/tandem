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
  classifyFailure,
  createLocalModelCollaborator,
} from "../../../src/server/local-model/collaborator.js";
import type { LocalModelConfig } from "../../../src/server/local-model/config.js";
import type { LoopResult } from "../../../src/server/local-model/index.js";
import {
  appendClaudeChatMessage,
  updateClaudeChatMessage,
} from "../../../src/server/mcp/awareness.js";
import { populateYDoc } from "../../../src/server/mcp/document.js";
import {
  getBuffer,
  resetForTesting as resetNotifications,
} from "../../../src/server/notifications.js";
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
  agentIdentity: { provider: "local-ollama", displayName: "Test Model" },
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

function limitResult(exit: "max_turns" | "max_tool_calls"): LoopResult {
  return {
    metrics: { ...cleanResult("").metrics, exit },
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
  resetNotifications();
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
    // #1123 M3: the streamed reply is bylined with the config's identity — proves
    // collaborator.ts threads config.agentIdentity into the sink (not just that
    // appendClaudeChatMessage can carry one, which the unit test covers).
    expect(msgs[0].agentIdentity).toEqual(CONFIG.agentIdentity);
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

  it("truncates selection text to SELECTION_TEXT_CAP before embedding in the prompt", async () => {
    setupDoc("doc-selcap", "Hello world");
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
    const longSel = "x".repeat(600);
    collab.onEvent(
      chatEvent("Summarize", {
        documentId: "doc-selcap",
        selection: { selectedText: longSel },
      }),
    );
    await drain(collab);
    expect(seenTask).toContain("Summarize");
    expect(seenTask).toContain("...");
    // The embedded selection must not exceed the cap + the "..." suffix
    const match = seenTask.match(/The user has selected: "([^"]*)"/);
    expect(match).not.toBeNull();
    expect(match![1].length).toBeLessThanOrEqual(503); // 500 chars + "..."
    expect(seenTask).not.toContain("x".repeat(600)); // raw oversized text never reaches the prompt
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

  it("replaces (never blanks) an over-80-char preamble that already minted a bubble", async () => {
    setupDoc("doc-preamble-mint", "Body");
    const longPreamble = "x".repeat(100); // > STREAM_FLUSH_CHARS → mints a liveId mid-turn
    const collab = createLocalModelCollaborator(
      makeDeps({
        runTurn: async (opts) => {
          opts.onContentDelta?.(longPreamble); // exceeds the char threshold → schedules an immediate flush
          await new Promise((r) => setTimeout(r, 0)); // let that flush mint the bubble
          opts.onTurnEnd?.({ hadToolCalls: true }); // preamble turn → reset buffer
          opts.onContentDelta?.("Final answer.");
          opts.onTurnEnd?.({ hadToolCalls: false });
          return cleanResult("Final answer.");
        },
      }),
    );
    collab.__setConfigForTests(CONFIG);
    collab.onEvent(chatEvent("go", { documentId: "doc-preamble-mint" }));
    await drain(collab);

    const msgs = chatMessages();
    expect(msgs).toHaveLength(1); // the minted bubble was UPDATED, not left + a new one added
    expect(msgs[0].text).toBe("Final answer."); // replaced, never blanked to ""
    expect(msgs[0].text).not.toContain("x");
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

  it("a superseded run finishing late does not clobber the active run's slot", async () => {
    setupDoc("doc-slot", "Body");
    let releaseB: (() => void) | null = null;
    let bStarted: (() => void) | null = null;
    const bStartedP = new Promise<void>((r) => {
      bStarted = r;
    });
    const collab = createLocalModelCollaborator(
      makeDeps({
        runTurn: async (opts) => {
          if (opts.task === "A") {
            // A resolves promptly when superseded; its finally runs BEFORE B's
            // turn begins (B awaits A's promise). If the cleanup nulled the slot
            // unconditionally it would null B's slot, not its own.
            await new Promise<void>((res) =>
              opts.signal?.addEventListener("abort", () => res(), { once: true }),
            );
            return cleanResult("");
          }
          bStarted?.();
          await new Promise<void>((res) => {
            releaseB = res;
          });
          return cleanResult("reply B");
        },
      }),
    );
    collab.__setConfigForTests(CONFIG);

    collab.onEvent(chatEvent("A", { documentId: "doc-slot", messageId: "a" }));
    await Promise.resolve();
    collab.onEvent(chatEvent("B", { documentId: "doc-slot", messageId: "b" }));
    await bStartedP; // A superseded + settled; B now in-flight

    // A's finally already ran; the slot must still belong to B, not be nulled.
    expect(collab.__currentDoc()).toBe("doc-slot");
    (releaseB as unknown as () => void)?.();
    await collab.__awaitCurrent();
    expect(collab.__currentDoc()).toBeNull(); // cleared only after B truly completes
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

  it("does NOT abort an in-flight run when a DIFFERENT document is closed", async () => {
    setupDoc("doc-fg", "Body");
    setupDoc("doc-bg", "Body");
    setActiveDocId("doc-fg");
    let aborted = false;
    const collab = createLocalModelCollaborator(
      makeDeps({
        runTurn: (opts) =>
          new Promise((res) => {
            opts.signal?.addEventListener("abort", () => {
              aborted = true;
            });
            setTimeout(() => res(cleanResult("ok")), 5);
          }),
      }),
    );
    collab.__setConfigForTests(CONFIG);
    collab.onEvent(chatEvent("go", { documentId: "doc-fg" }));
    await Promise.resolve();
    collab.onEvent({
      id: "evt_close_bg",
      type: "document:closed",
      timestamp: Date.now(),
      documentId: "doc-bg", // a background tab, not the run's doc
      payload: { fileName: "doc-bg" },
    });
    await collab.__awaitCurrent();
    expect(aborted).toBe(false);
  });

  it("does NOT abort when a document:switched names the SAME running doc (re-focus)", async () => {
    setupDoc("doc-same", "Body");
    let aborted = false;
    const collab = createLocalModelCollaborator(
      makeDeps({
        runTurn: (opts) =>
          new Promise((res) => {
            opts.signal?.addEventListener("abort", () => {
              aborted = true;
            });
            setTimeout(() => res(cleanResult("ok")), 5);
          }),
      }),
    );
    collab.__setConfigForTests(CONFIG);
    collab.onEvent(chatEvent("go", { documentId: "doc-same" }));
    await Promise.resolve();
    collab.onEvent({
      id: "evt_switch_same",
      type: "document:switched",
      timestamp: Date.now(),
      documentId: "doc-same", // switched TO the doc the run targets
      payload: { fileName: "doc-same" },
    });
    await collab.__awaitCurrent();
    expect(aborted).toBe(false);
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

  for (const exit of ["max_turns", "max_tool_calls"] as const) {
    it(`notifies (does not silently strand) on a ${exit} exit`, async () => {
      setupDoc("doc-limit", "Body");
      const collab = createLocalModelCollaborator(
        makeDeps({
          runTurn: async (opts) => {
            // A tool-call turn streamed preamble; budget then ran out. onTurnEnd
            // reset the buffer, so there's no clean answer to flush — without a
            // notification the user is left with a stale/empty bubble.
            opts.onContentDelta?.("Working on it. ");
            opts.onTurnEnd?.({ hadToolCalls: true });
            return limitResult(exit);
          },
        }),
      );
      collab.__setConfigForTests(CONFIG);
      collab.onEvent(chatEvent("go", { documentId: "doc-limit" }));
      await drain(collab);

      expect(chatMessages()).toHaveLength(0); // preamble was reset → no stale bubble
      const notes = getBuffer().filter((n) => n.documentId === "doc-limit");
      expect(notes).toHaveLength(1);
      expect(notes[0].severity).toBe("warning");
      expect(notes[0].message).toMatch(/step limit/);
    });
  }

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

describe("classifyFailure — bucketing + redaction", () => {
  const cases: Array<[string, RegExp]> = [
    ["local model returned a non-JSON response", /unreadable/],
    ["invalid local-model endpoint: http://evil", /misconfigured/],
    ["local model response exceeded 16777216-byte cap", /too large/],
    ["local model endpoint returned HTTP 500", /server returned an error/],
    ["The operation was aborted", /interrupted/],
    ["ECONNREFUSED 127.0.0.1:11434 secret-detail", /could not reach the server/],
  ];
  for (const [errorMessage, expected] of cases) {
    it(`maps "${errorMessage.slice(0, 28)}…" to a fixed string with no raw detail`, () => {
      const out = classifyFailure(errorResult(errorMessage).metrics);
      expect(out).toMatch(expected);
      // Never embeds third-party detail (a V8 parse snippet / secret) into the UI string.
      expect(out).not.toContain("secret-detail");
      expect(out).not.toContain("127.0.0.1");
      expect(out).not.toContain("evil");
    });
  }
  it("falls back to the generic message when there is no errorMessage", () => {
    expect(classifyFailure(cleanResult("").metrics)).toMatch(/could not reach the server/);
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

  it("#1123 M3: stamps agentIdentity on append and preserves it across a streamed update", () => {
    const identity = { provider: "local-ollama" as const, displayName: "Qwen 2.5" };
    const id = appendClaudeChatMessage("partial", { documentId: "d3", agentIdentity: identity });
    expect((chatMap().get(id) as ChatMessage).agentIdentity).toEqual(identity);
    // The `{...existing, text}` re-set must carry the byline through every delta.
    updateClaudeChatMessage(id, "partial + more");
    const after = chatMap().get(id) as ChatMessage;
    expect(after.text).toBe("partial + more");
    expect(after.agentIdentity).toEqual(identity);
  });

  it("#1123 M3: omits agentIdentity when none is passed (tandem_reply / dark byte-identical)", () => {
    const id = appendClaudeChatMessage("plain", { documentId: "d4" });
    expect((chatMap().get(id) as ChatMessage).agentIdentity).toBeUndefined();
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
