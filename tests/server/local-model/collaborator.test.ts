import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  bumpContentGeneration,
  contentGeneration,
} from "../../../src/server/documents/content-generation.js";
import { getOpenDocs } from "../../../src/server/documents/registry.js";
import {
  addDoc,
  removeDoc,
  setActiveDocId,
} from "../../../src/server/documents/registry-testing.js";
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
  UNUSABLE_NOTICE,
} from "../../../src/server/local-model/collaborator.js";
import type { LocalModelConfig } from "../../../src/server/local-model/config.js";
import type {
  LocalModelUnusable,
  LocalModelUnusableReason,
} from "../../../src/server/local-model/config-source.js";
import type { LoopResult, RunTurnOpts } from "../../../src/server/local-model/index.js";
import {
  appendClaudeChatMessage,
  finalizeClaudeChatMessage,
  updateClaudeChatMessage,
} from "../../../src/server/mcp/awareness.js";
import { populateYDoc } from "../../../src/server/mcp/document.js";
import {
  getBuffer,
  resetForTesting as resetNotifications,
} from "../../../src/server/notifications.js";
import { getOrCreateDocument, removeDocument } from "../../../src/server/yjs/provider.js";
import {
  CTRL_ROOM,
  Y_MAP_CHAT,
  Y_MAP_CHAT_STREAM,
  Y_MAP_MODE,
  Y_MAP_USER_AWARENESS,
} from "../../../src/shared/constants.js";
import type { TandemEvent } from "../../../src/shared/events/types.js";
import { withBrowser, withInternal } from "../../../src/shared/origins.js";
import type { ChatMessage } from "../../../src/shared/types.js";
import { appendedId } from "../../helpers/chat-append.js";

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

function swappedResult(): LoopResult {
  return {
    metrics: { ...cleanResult("").metrics, exit: "doc-swapped" },
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

/**
 * Replace a room's Y.Doc the way Hocuspocus's `onLoadDocument` does (#1657):
 * a NEW instance under the SAME room name, with the old one destroyed.
 *
 * It must SWAP, not close. The registry entry `setupDoc` added is left in
 * place, so `requireDocument()` keeps returning non-null throughout — that is
 * the discriminating condition. A close is already caught by the presence test
 * that predates the fix and would stay green against the old code.
 */
function swapDoc(id: string, text: string) {
  const old = getOrCreateDocument(id);
  removeDocument(id); // provider map entry only — the registry row survives
  const fresh = getOrCreateDocument(id); // new instance, same room name
  populateYDoc(fresh, text);
  old.destroy();
  return fresh;
}

function chatMap() {
  return getOrCreateDocument(CTRL_ROOM).getMap(Y_MAP_CHAT);
}

function streamMap() {
  return getOrCreateDocument(CTRL_ROOM).getMap(Y_MAP_CHAT_STREAM);
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
    ctrl.getMap(Y_MAP_CHAT_STREAM).clear();
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
    collab.onEvent(chatEvent("hi", { documentId: "doc-solo" }));
    await drain(collab);
    expect(runTurn).not.toHaveBeenCalled();
    expect(chatMessages()).toHaveLength(0);
  });

  it("is inert while no config resolves, asking again on every chat event (no loop, no throw)", async () => {
    setupDoc("doc-noconf", "Body");
    const runTurn = vi.fn(async () => cleanResult("x"));
    const resolveConfig = vi.fn((): LocalModelConfig | null => null);
    const collab = createLocalModelCollaborator(makeDeps({ runTurn, resolveConfig }));
    // Nothing is resolved at creation or at wire time: the config is read per
    // chat event, so there is no stored answer to go stale.
    collab.__startForTests();
    expect(resolveConfig).not.toHaveBeenCalled();

    collab.onEvent(chatEvent("hi", { documentId: "doc-noconf", messageId: "a" }));
    await drain(collab);
    expect(resolveConfig).toHaveBeenCalledTimes(1);
    collab.onEvent(chatEvent("hi again", { documentId: "doc-noconf", messageId: "b" }));
    await drain(collab);
    expect(resolveConfig).toHaveBeenCalledTimes(2);

    expect(runTurn).not.toHaveBeenCalled();
    expect(chatMessages()).toHaveLength(0);
    expect(getBuffer()).toEqual([]);
    await collab.stop();
  });

  it("never fabricates a phantom room for an unknown documentId", async () => {
    const runTurn = vi.fn(async () => cleanResult("x"));
    const collab = createLocalModelCollaborator(makeDeps({ runTurn }));
    collab.onEvent(chatEvent("hi", { documentId: "never-opened" }));
    await drain(collab);
    expect(runTurn).not.toHaveBeenCalled();
    expect(getOpenDocs().has("never-opened")).toBe(false);
  });

  it("ignores empty / whitespace chat text", async () => {
    setupDoc("doc-empty", "Body");
    const runTurn = vi.fn(async () => cleanResult("x"));
    const collab = createLocalModelCollaborator(makeDeps({ runTurn }));
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

describe("collaborator — mid-turn doc swap (#1657)", () => {
  // `executeRun` captures `open.doc` once and holds it across the whole model
  // turn. Hocuspocus can replace that instance mid-turn, and the ownership gate
  // used to test only that the room was still PRESENT — which a swap leaves
  // true. Both arms below swap the doc while the turn is parked and assert the
  // run's terminal effects are suppressed.
  //
  // TIMING RULE for both arms: the swap must happen with only MICROTASKS
  // awaited since the delta was pushed. A sub-STREAM_FLUSH_CHARS delta arms
  // `setTimeout(write, STREAM_FLUSH_MS)`; if a macrotask ran first the flush
  // would mint the bubble on its own and the assertion would fail against
  // correct code. The gate promise is released from the same microtask chain —
  // never `await` a timer here.

  /**
   * Park a turn just after its delta is pushed, swap the room's Y.Doc, then let
   * the turn finish. Encodes the TIMING RULE above: the only thing awaited
   * between the push and the swap is a microtask.
   */
  async function swapMidTurn(id: string, result: LoopResult) {
    setupDoc(id, "Body");
    let release!: () => void;
    const gate = new Promise<void>((res) => {
      release = res;
    });

    const collab = createLocalModelCollaborator(
      makeDeps({
        runTurn: async (opts) => {
          opts.onContentDelta?.("partial answer");
          opts.onTurnEnd?.({ hadToolCalls: false });
          await gate;
          return result;
        },
      }),
    );

    collab.onEvent(chatEvent("go", { documentId: id }));
    await Promise.resolve(); // run() → executeRun → runTurn → push → parked on `gate`

    swapDoc(id, "Body");
    release();
    await drain(collab);
  }

  it("drops the terminal reply when the Y.Doc is swapped mid-turn", async () => {
    await swapMidTurn("doc-swap-terminal", cleanResult("the full reply"));

    // This arm discriminates BECAUSE the sink's `isOwner()` is deliberately left
    // on presence: if `stillOwner()` let the terminal path through, the sink
    // would happily mint the bubble.
    expect(chatMessages()).toHaveLength(0);
  });

  it("suppresses the budget-exhausted notification when the Y.Doc is swapped mid-turn", async () => {
    await swapMidTurn("doc-swap-notify", limitResult("max_turns"));

    // A sink-independent second pin: `pushNotification` bypasses the sink
    // entirely, so this stays red under the mutation even if the sink changes.
    expect(getBuffer().filter((n) => n.documentId === "doc-swap-notify")).toEqual([]);
  });

  // #2039: the swap is now ABORTED and made visible. The notification must come
  // from a branch OUTSIDE `if (stillOwner())` — that gate is false after a swap
  // by construction, so an arm inside it is dead code and ships silent.
  it("notifies on a 'doc-swapped' exit although stillOwner() is false", async () => {
    await swapMidTurn("doc-swap-abort", swappedResult());

    const notes = getBuffer().filter((n) => n.documentId === "doc-swap-abort");
    expect(notes).toHaveLength(1);
    expect(notes[0].severity).toBe("warning");
    // The message matters: a regression pushing the budget copy ("reached its
    // step limit") is exactly the misleading outcome this issue is about.
    expect(notes[0].message).toMatch(/reconnected/);
  });

  it("notifies NOTHING when the document was CLOSED rather than swapped", async () => {
    // `requireDocument` returns null once the registry row is dropped, so
    // `docUnchanged()` is false for a close too. Since #2069 a real close also
    // arrives as an abort (`document:closed`); this drops the row through the
    // test seam, which broadcasts nothing, to pin the fallback arm on its own.
    // Telling that user the document "reconnected" names a remedy no retry can
    // satisfy, so only the message is suppressed — not the abort.
    setupDoc("doc-swap-closed", "Body");
    let release!: () => void;
    const gate = new Promise<void>((res) => {
      release = res;
    });
    const collab = createLocalModelCollaborator(
      makeDeps({
        runTurn: async (opts) => {
          opts.onContentDelta?.("partial answer");
          opts.onTurnEnd?.({ hadToolCalls: false });
          await gate;
          return swappedResult();
        },
      }),
    );
    collab.onEvent(chatEvent("go", { documentId: "doc-swap-closed" }));
    await Promise.resolve();

    removeDoc("doc-swap-closed");
    release();
    await drain(collab);

    expect(getBuffer().filter((n) => n.documentId === "doc-swap-closed")).toEqual([]);
  });

  it("still mints no terminal reply on a 'doc-swapped' exit", async () => {
    await swapMidTurn("doc-swap-noreply", swappedResult());

    // Making the abort visible must not undo #1657: no flushFinal on this arm.
    expect(chatMessages()).toHaveLength(0);
  });

  it("threads isDocCurrent into the turn, and it flips on the swap", async () => {
    setupDoc("doc-swap-thread", "Body");
    let captured: { isDocCurrent?: () => boolean } | undefined;
    let release!: () => void;
    const gate = new Promise<void>((res) => {
      release = res;
    });
    const collab = createLocalModelCollaborator(
      makeDeps({
        runTurn: async (opts) => {
          captured = opts;
          await gate;
          return cleanResult("");
        },
      }),
    );
    collab.onEvent(chatEvent("go", { documentId: "doc-swap-thread" }));
    await Promise.resolve();

    // `typeof` first: `opts.isDocCurrent?.()` is `undefined` when the field was
    // never threaded, which a bare falsy assertion would happily accept.
    expect(typeof captured?.isDocCurrent).toBe("function");
    expect(captured?.isDocCurrent?.()).toBe(true);
    swapDoc("doc-swap-thread", "Body");
    expect(captured?.isDocCurrent?.()).toBe(false);

    release();
    await drain(collab);
  });
});

/**
 * #2070: a content-replacing reload keeps the SAME Y.Doc instance, so the
 * identity conjunct above cannot see it. The content generation can.
 */
describe("collaborator — content replaced under a parked turn (#2070)", () => {
  async function parkThen(
    id: string,
    whileParked: (ydoc: ReturnType<typeof setupDoc>) => void,
    result: () => LoopResult,
  ) {
    const ydoc = setupDoc(id, "Body");
    let captured: { isDocCurrent?: () => boolean } | undefined;
    let release!: () => void;
    const gate = new Promise<void>((res) => {
      release = res;
    });
    const collab = createLocalModelCollaborator(
      makeDeps({
        runTurn: async (opts) => {
          captured = opts;
          opts.onContentDelta?.("partial answer");
          opts.onTurnEnd?.({ hadToolCalls: false });
          await gate;
          return result();
        },
      }),
    );
    collab.onEvent(chatEvent("go", { documentId: id }));
    await Promise.resolve();
    whileParked(ydoc);
    const afterReload = captured?.isDocCurrent?.();
    release();
    await drain(collab);
    return { afterReload, ydoc };
  }

  it("isDocCurrent flips on a content replacement of the same instance", async () => {
    const { afterReload, ydoc } = await parkThen(
      "doc-reload-flip",
      (d) => bumpContentGeneration(d),
      () => swappedResult(),
    );
    expect(afterReload).toBe(false);
    // The same instance throughout: identity alone would have said `true`.
    expect(getOrCreateDocument("doc-reload-flip")).toBe(ydoc);
  });

  it("flips on the REAL reload path — clearAndReload bumps inside its transaction", async () => {
    // The production bump sites, not the helper: a reload that forgot to bump
    // would leave this run believing its prompt still described the document.
    const seen: number[] = [];
    const doc = setupDoc("doc-reload-real", "Body");
    doc.on("afterTransaction", () => seen.push(contentGeneration(doc)));
    const before = contentGeneration(doc);
    const { clearAndReload } = await import("../../../src/server/documents/populate.js");
    const existing = getOpenDocs().get("doc-reload-real");
    if (!existing) throw new Error("not registered");
    await clearAndReload("doc-reload-real", doc, existing.filePath, "md", existing, "New body\n");
    expect(contentGeneration(doc)).toBe(before + 1);
    // Bumped exactly once, and visible to an observer of the content swap
    // itself — not after it.
    expect(seen.filter((g) => g === before + 1).length).toBeGreaterThan(0);
    expect(seen.every((g) => g === before || g === before + 1)).toBe(true);
  });

  it("notifies with the reload copy, and mints no terminal reply", async () => {
    await parkThen(
      "doc-reload-notify",
      (d) => bumpContentGeneration(d),
      () => swappedResult(),
    );
    const notes = getBuffer().filter((n) => n.documentId === "doc-reload-notify");
    expect(notes).toHaveLength(1);
    expect(notes[0].message).toMatch(/content was replaced/);
    expect(notes[0].message).not.toMatch(/reconnected/);
    expect(chatMessages()).toHaveLength(0);
  });

  it("keeps the reconnect copy for an instance swap", async () => {
    await parkThen(
      "doc-reload-vs-swap",
      () => swapDoc("doc-reload-vs-swap", "Body"),
      () => swappedResult(),
    );
    const notes = getBuffer().filter((n) => n.documentId === "doc-reload-vs-swap");
    expect(notes).toHaveLength(1);
    expect(notes[0].message).toMatch(/reconnected/);
  });

  it("drops a CLEAN reply from a turn whose content was replaced (stillOwner reads the generation)", async () => {
    // The loop's turn-boundary check is mocked away here, so the run comes back
    // `clean`; the terminal gate must still refuse to flush it.
    await parkThen(
      "doc-reload-clean",
      (d) => bumpContentGeneration(d),
      () => cleanResult("a reply about the old text"),
    );
    expect(chatMessages()).toHaveLength(0);
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
    collab.onEvent(chatEvent("go", { documentId: "doc-err" }));
    await drain(collab);
    // Nothing was streamed, so the error branch's flush has nothing to commit
    // and mints no empty bubble; the raw error stays on stderr only.
    expect(chatMessages()).toHaveLength(0);
    expect(errorSpy).toHaveBeenCalled();
    errorSpy.mockRestore();
  });

  it("commits the streamed partial when the run exits 'error' (#1292)", async () => {
    // The runaway case this PR exists for — a quantized model in a repetition
    // loop — trips the WIRE cap inside readStream, which throws, so the run
    // lands on the `error` branch and NOT on the sink's own truncation path.
    // That branch used to notify without flushing, so everything received since
    // the last 80-char flush boundary was dropped and the bubble stayed frozen
    // mid-sentence.
    setupDoc("doc-err-partial", "Body");
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const collab = createLocalModelCollaborator(
      makeDeps({
        runTurn: async (opts) => {
          // Under STREAM_FLUSH_CHARS (80), so nothing has been committed yet:
          // this content exists ONLY in the sink buffer when the fault lands.
          opts.onContentDelta?.("The answer is ");
          return errorResult("local model response exceeded 4194304-byte cap");
        },
      }),
    );
    collab.onEvent(chatEvent("go", { documentId: "doc-err-partial" }));
    await drain(collab);

    const msgs = chatMessages();
    expect(msgs).toHaveLength(1);
    expect(msgs[0].text).toBe("The answer is ");
    // The notification is still required — the partial alone doesn't say why.
    const notes = getBuffer().filter((n) => n.documentId === "doc-err-partial");
    expect(notes).toHaveLength(1);
    expect(notes[0].message).toMatch(/too large/);
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
  it("append + update + finalize produce ZERO chat:message events; a user write produces one", async () => {
    attachCtrlObservers();
    const events: TandemEvent[] = [];
    const sub = (e: TandemEvent) => events.push(e);
    subscribe(sub, "external");
    try {
      // Claude/local writes — all three must be invisible to the channel.
      // Updates land in the chatStream sidecar (no observer, mcp origin
      // anyway); the finalize fold is an `update`-action re-set on the chat
      // map, dropped at BOTH the shouldSkipChannel(mcp) gate and the
      // `action !== "add"` gate (#1340 — pins the origin arithmetic).
      const id = appendedId(appendClaudeChatMessage("streamed reply", { documentId: "d1" }));
      updateClaudeChatMessage(id, "streamed reply (more)");
      finalizeClaudeChatMessage(id);

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

describe("update + finalize — shape preservation across the streamed lifecycle", () => {
  it("finalize folds the text; id/author/timestamp/read/documentId/replyTo ride through verbatim", () => {
    const id = appendedId(appendClaudeChatMessage("first", { documentId: "d2", replyTo: "u9" }));
    const before = chatMap().get(id) as ChatMessage;
    updateClaudeChatMessage(id, "second");
    // #1340 NEW INVARIANT, asserted deliberately: mid-stream the chat row is
    // STALE (untouched since append) and the chatStream sidecar is the
    // authority — readers compose. A `chatMap.set` per update would be the
    // O(n²) revert this test's sibling byte-guard also catches.
    expect((chatMap().get(id) as ChatMessage).text).toBe("first");
    expect(streamMap().has(id)).toBe(true);

    finalizeClaudeChatMessage(id);
    const after = chatMap().get(id) as ChatMessage;
    expect(after.text).toBe("second");
    expect(after.id).toBe(before.id);
    expect(after.author).toBe("claude");
    expect(after.timestamp).toBe(before.timestamp); // NOT re-stamped (sort stability)
    expect(after.read).toBe(before.read);
    expect(after.documentId).toBe("d2");
    expect(after.replyTo).toBe("u9");
    expect(streamMap().has(id)).toBe(false);
  });

  it("is a no-op when the message id is absent (no chat row, no sidecar entry)", () => {
    expect(() => updateClaudeChatMessage("does-not-exist", "x")).not.toThrow();
    expect(chatMap().has("does-not-exist")).toBe(false);
    expect(streamMap().has("does-not-exist")).toBe(false);
  });

  it("#1123 M3: stamps agentIdentity on append and carries it through stream + fold", () => {
    const identity = { provider: "local-ollama" as const, displayName: "Qwen 2.5" };
    const id = appendedId(
      appendClaudeChatMessage("partial", { documentId: "d3", agentIdentity: identity }),
    );
    expect((chatMap().get(id) as ChatMessage).agentIdentity).toEqual(identity);
    // Streaming leaves the row untouched, so the byline survives every delta
    // by construction; the fold's `{...existing}` must then carry it into the
    // final re-set.
    updateClaudeChatMessage(id, "partial + more");
    expect((chatMap().get(id) as ChatMessage).agentIdentity).toEqual(identity);
    finalizeClaudeChatMessage(id);
    const after = chatMap().get(id) as ChatMessage;
    expect(after.text).toBe("partial + more");
    expect(after.agentIdentity).toEqual(identity);
  });

  it("#1123 M3: omits agentIdentity when none is passed (tandem_reply / dark byte-identical)", () => {
    const id = appendedId(appendClaudeChatMessage("plain", { documentId: "d4" }));
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

describe("collaborator — streamed reply is bounded (#1292)", () => {
  // Mirrors MAX_STREAMED_CHARS in collaborator.ts. Kept as a literal rather than
  // exported: these tests assert the OBSERVABLE contract (a bounded, marked
  // message in the Y.Map), so importing the constant would let a bad cap change
  // move the test with it.
  const CAP = 64 * 1024;

  /** Push `total` chars in realistic ~16 KiB chunks, like undici delivers them. */
  function pushChunks(opts: { onContentDelta?: (d: string) => void }, total: number) {
    const CHUNK = 16 * 1024;
    for (let sent = 0; sent < total; sent += CHUNK) {
      opts.onContentDelta?.("x".repeat(Math.min(CHUNK, total - sent)));
    }
  }

  it("caps a runaway stream and persists the truncation marker to the Y.Map", async () => {
    setupDoc("doc-runaway", "Body");
    const collab = createLocalModelCollaborator(
      makeDeps({
        runTurn: async (opts) => {
          // A repetition-looping model: 4x the cap, no tool calls, never stops.
          pushChunks(opts, CAP * 4);
          // Yield so the cap's deferred commit+abort actually runs mid-stream.
          // This is what makes the test discriminating: once aborted, the
          // terminal `flushFinal()` in executeRun is skipped (its `stillOwner()`
          // carries the abort clause), so the ONLY thing that can have written
          // the marker is the cap's own commit. Without this yield the clean
          // exit's flushFinal commits the buffer for us and the assertion below
          // passes even when the abort happens first — verified by inverting the
          // ordering, where this test stayed green and only the abort test caught it.
          await new Promise((r) => setTimeout(r, 0));
          opts.onTurnEnd?.({ hadToolCalls: false });
          return cleanResult("unused");
        },
      }),
    );
    collab.onEvent(chatEvent("go", { documentId: "doc-runaway" }));
    await drain(collab);

    const msgs = chatMessages();
    expect(msgs).toHaveLength(1);

    // THE load-bearing assertion, and the reason this reads the Y.Map rather
    // than the sink. `write()` bails on `!isOwner()`, which includes
    // `!abort.signal.aborted` — so an implementation that aborts BEFORE
    // committing the marker leaves the bubble frozen at the last 80-char flush
    // boundary and the user never learns the reply was cut. A sink-level
    // assertion, or one that only checks `abort` was called, passes against
    // exactly that bug.
    expect(msgs[0].text).toContain("Reply truncated");

    // Bounded: the cap plus one marker, not 4x the cap.
    expect(msgs[0].text.length).toBeLessThan(CAP + 500);
    expect(msgs[0].text.length).toBeGreaterThan(CAP - 500);
  });

  it("appends the truncation marker exactly once across many post-cap deltas", async () => {
    setupDoc("doc-marker-once", "Body");
    const collab = createLocalModelCollaborator(
      makeDeps({
        runTurn: async (opts) => {
          pushChunks(opts, CAP * 8); // many chunks land after the latch trips
          await new Promise((r) => setTimeout(r, 0)); // let the cap commit+abort run
          opts.onTurnEnd?.({ hadToolCalls: false });
          return cleanResult("unused");
        },
      }),
    );
    collab.onEvent(chatEvent("go", { documentId: "doc-marker-once" }));
    await drain(collab);

    const text = chatMessages()[0].text;
    expect(text.split("Reply truncated")).toHaveLength(2); // one occurrence
  });

  it("aborts the run once capped, so the endpoint stops being read", async () => {
    setupDoc("doc-abort", "Body");
    let signalAfterCap: boolean | undefined;
    const collab = createLocalModelCollaborator(
      makeDeps({
        runTurn: async (opts) => {
          pushChunks(opts, CAP * 2);
          // The cap commits + aborts on a deferred task; yield so it runs.
          await new Promise((r) => setTimeout(r, 0));
          signalAfterCap = opts.signal?.aborted;
          opts.onTurnEnd?.({ hadToolCalls: false });
          return cleanResult("unused");
        },
      }),
    );
    collab.onEvent(chatEvent("go", { documentId: "doc-abort" }));
    await drain(collab);

    expect(signalAfterCap).toBe(true);
    // Positive control on the same sample: the abort must not have cost us the
    // marker. Asserting the abort alone is satisfied by the broken ordering.
    expect(chatMessages()[0].text).toContain("Reply truncated");
  });

  it("keeps the marker when a tool-call turn ends after the cap trips", async () => {
    setupDoc("doc-marker-toolcall", "Body");
    const collab = createLocalModelCollaborator(
      makeDeps({
        runTurn: async (opts) => {
          pushChunks(opts, CAP * 2);
          // `onTurnEnd({hadToolCalls:true})` normally cancels the pending flush
          // and clears the buffer to drop preamble — which would wipe the
          // not-yet-committed marker. The truncation latch must win.
          opts.onTurnEnd?.({ hadToolCalls: true });
          return cleanResult("unused");
        },
      }),
    );
    collab.onEvent(chatEvent("go", { documentId: "doc-marker-toolcall" }));
    await drain(collab);

    const msgs = chatMessages();
    expect(msgs).toHaveLength(1);
    expect(msgs[0].text).toContain("Reply truncated");
  });

  it("passes an explicit chat-sized response-byte ceiling, not the 16 MB client default", async () => {
    setupDoc("doc-bytecap", "Body");
    let seen: number | undefined;
    const collab = createLocalModelCollaborator(
      makeDeps({
        runTurn: async (opts) => {
          seen = opts.maxResponseBytes;
          opts.onContentDelta?.("hi");
          opts.onTurnEnd?.({ hadToolCalls: false });
          return cleanResult("hi");
        },
      }),
    );
    collab.onEvent(chatEvent("go", { documentId: "doc-bytecap" }));
    await drain(collab);

    // Assert on the VALUE reaching runTurn. Asserting only "no error" would pass
    // while the option silently defaulted to DEFAULT_MAX_RESPONSE_BYTES (16 MB),
    // which is the bug — the field being threaded but never set.
    expect(seen).toBeDefined();
    expect(seen).toBeLessThan(16 * 1024 * 1024);
    expect(seen).toBeGreaterThanOrEqual(CAP);
  });
});

describe("collaborator — streamed lifecycle ends with an empty sidecar (#1340)", () => {
  // dispose() runs in executeRun's finally on EVERY exit, and its finalize
  // fold is deliberately not ownership-gated — a leaked chatStream entry would
  // stay authoritative over the row forever (and leak a Y.Text). Each terminal
  // path must leave the sidecar map empty and the row holding the final text.

  it("clean multi-flush run: sidecar empty, row holds the full reply", async () => {
    setupDoc("doc-fin-clean", "Body");
    const reply = "w".repeat(300); // > STREAM_FLUSH_CHARS → real mid-stream flushes
    const collab = createLocalModelCollaborator(
      makeDeps({
        runTurn: async (opts) => {
          opts.onContentDelta?.(reply.slice(0, 150));
          await new Promise((r) => setTimeout(r, 0)); // let the deferred flush land
          opts.onContentDelta?.(reply.slice(150));
          opts.onTurnEnd?.({ hadToolCalls: false });
          return cleanResult(reply);
        },
      }),
    );
    collab.onEvent(chatEvent("go", { documentId: "doc-fin-clean" }));
    await drain(collab);

    expect(streamMap().size).toBe(0);
    const msgs = chatMessages();
    expect(msgs).toHaveLength(1);
    expect(msgs[0].text).toBe(reply);
  });

  it("error-with-partial run: partial folded into the row, sidecar empty", async () => {
    setupDoc("doc-fin-err", "Body");
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const partial = "p".repeat(120);
    const collab = createLocalModelCollaborator(
      makeDeps({
        runTurn: async (opts) => {
          opts.onContentDelta?.(partial); // > 80 → flush lands mid-stream
          await new Promise((r) => setTimeout(r, 0));
          return errorResult("local model response exceeded 4194304-byte cap");
        },
      }),
    );
    collab.onEvent(chatEvent("go", { documentId: "doc-fin-err" }));
    await drain(collab);

    expect(streamMap().size).toBe(0);
    expect(chatMessages()[0].text).toBe(partial);
    errorSpy.mockRestore();
  });

  it("truncation-cap run (#1292): marker folded into the row, sidecar empty", async () => {
    setupDoc("doc-fin-cap", "Body");
    const CAP = 64 * 1024;
    const collab = createLocalModelCollaborator(
      makeDeps({
        runTurn: async (opts) => {
          for (let sent = 0; sent < CAP * 2; sent += 16 * 1024) {
            opts.onContentDelta?.("x".repeat(16 * 1024));
          }
          await new Promise((r) => setTimeout(r, 0)); // let the cap commit+abort run
          opts.onTurnEnd?.({ hadToolCalls: false });
          return cleanResult("unused");
        },
      }),
    );
    collab.onEvent(chatEvent("go", { documentId: "doc-fin-cap" }));
    await drain(collab);

    expect(streamMap().size).toBe(0);
    expect(chatMessages()[0].text).toContain("Reply truncated");
  });

  it("superseded run: its last flushed partial is folded, sidecar empty, B's reply intact", async () => {
    setupDoc("doc-fin-super", "Body");
    const partialA = "a".repeat(120);
    const collab = createLocalModelCollaborator(
      makeDeps({
        runTurn: async (opts) => {
          if (opts.task === "A") {
            opts.onContentDelta?.(partialA);
            await new Promise((r) => setTimeout(r, 0)); // flush lands → bubble minted
            await new Promise<void>((res) =>
              opts.signal?.addEventListener("abort", () => res(), { once: true }),
            );
            return cleanResult("unused");
          }
          opts.onContentDelta?.("reply B is long enough to flush".repeat(4));
          await new Promise((r) => setTimeout(r, 0));
          opts.onTurnEnd?.({ hadToolCalls: false });
          return cleanResult("reply B");
        },
      }),
    );
    collab.onEvent(chatEvent("A", { documentId: "doc-fin-super", messageId: "a" }));
    await Promise.resolve();
    await new Promise((r) => setTimeout(r, 0)); // A's flush mints its bubble
    collab.onEvent(chatEvent("B", { documentId: "doc-fin-super", messageId: "b" }));
    await drain(collab);

    // A kept its last flushed partial (today's observable abort behaviour),
    // folded into the durable row; nothing left in the sidecar for either run.
    expect(streamMap().size).toBe(0);
    const texts = chatMessages().map((m) => m.text);
    expect(texts).toContain(partialA);
    expect(texts).toContain("reply B is long enough to flush".repeat(4));
  });
});

describe("collaborator — streamed write volume at the caller level (#1340)", () => {
  it("a whole streamed run costs O(L) ctrl update bytes", async () => {
    // Byte-shaped, never wall-clock (this box runs under heavy load). Guards a
    // revert of the sidecar primitive as seen THROUGH the collaborator's real
    // flush machinery: master's whole-value re-set measures ~104×L here; the
    // sidecar fix ~2.3×L. It does NOT constrain STREAM_FLUSH_CHARS — with the
    // linear primitive, flush fineness only adds per-transaction overhead.
    setupDoc("doc-bytes", "Body");
    const L = 16_384;
    const STEP = 80;
    const collab = createLocalModelCollaborator(
      makeDeps({
        runTurn: async (opts) => {
          for (let sent = 0; sent < L; sent += STEP) {
            opts.onContentDelta?.("x".repeat(Math.min(STEP, L - sent)));
            // Yield a macrotask so each ≥80-char flush actually lands — the
            // sink only ever writes from deferred timers.
            await new Promise((r) => setTimeout(r, 0));
          }
          opts.onTurnEnd?.({ hadToolCalls: false });
          return cleanResult("x".repeat(L));
        },
      }),
    );

    const ctrl = getOrCreateDocument(CTRL_ROOM);
    let bytes = 0;
    const onUpdate = (u: Uint8Array) => {
      bytes += u.byteLength;
    };
    ctrl.on("update", onUpdate);
    try {
      collab.onEvent(chatEvent("go", { documentId: "doc-bytes" }));
      await drain(collab);
    } finally {
      ctrl.off("update", onUpdate);
    }

    expect(chatMessages()[0].text).toBe("x".repeat(L)); // the run really streamed L chars
    expect(bytes).toBeGreaterThan(L); // sanity: content was transmitted
    expect(bytes).toBeLessThanOrEqual(12 * L); // RED on master (~104×L)
  });

  it("a tool-call-looping run costs O(total content), not O(per-turn²) × turns (#1292)", async () => {
    // The path #1292's decision comment named as unanalysed, and the one the
    // test above cannot reach: it ends its single turn with `hadToolCalls:
    // false`, so it never crosses a turn boundary. `onTurnEnd({ hadToolCalls:
    // true })` resets the sink's buffer and its cap counter, so the ramp
    // restarts on every turn and `loop.ts` defaults `maxTurns` to 12 — which
    // under the pre-#1340 whole-value re-`set` made the run-scoped cost
    // `turns × O(perTurn²)` rather than `O(turns × perTurn)`.
    //
    // Measured here: 236,110 bytes for 196,608 chars of content — 1.2×, and
    // stable to ~70 bytes across runs. The same shape on the whole-value
    // primitive is ~32× (each turn re-sends every prefix: 512 + 1024 + … +
    // 32768 per turn). The 4× ceiling sits between the two with room on both
    // sides, and is byte-shaped rather than wall-clock because this box runs
    // under load.
    setupDoc("doc-loop-bytes", "Body");
    const TURNS = 6;
    const PER_TURN = 32_768;
    const STEP = 512;
    const collab = createLocalModelCollaborator(
      makeDeps({
        runTurn: async (opts) => {
          for (let turn = 0; turn < TURNS; turn++) {
            for (let sent = 0; sent < PER_TURN; sent += STEP) {
              opts.onContentDelta?.("x".repeat(STEP));
              await new Promise((r) => setTimeout(r, 0));
            }
            // Every turn but the last ends WITH tool calls — the reset path.
            opts.onTurnEnd?.({ hadToolCalls: turn < TURNS - 1 });
          }
          return cleanResult("");
        },
      }),
    );

    const ctrl = getOrCreateDocument(CTRL_ROOM);
    let bytes = 0;
    const onUpdate = (u: Uint8Array) => {
      bytes += u.byteLength;
    };
    ctrl.on("update", onUpdate);
    try {
      collab.onEvent(chatEvent("go", { documentId: "doc-loop-bytes" }));
      await drain(collab);
    } finally {
      ctrl.off("update", onUpdate);
    }

    const content = TURNS * PER_TURN;
    expect(bytes).toBeGreaterThan(PER_TURN); // sanity: content was transmitted
    expect(bytes).toBeLessThanOrEqual(4 * content);
  });

  it("a tool-call turn discards its buffer, so no run-scoped budget is needed (#1292)", async () => {
    // Why the per-turn cap reset is bounded rather than a hole, and why a
    // run-scoped CHARACTER budget would be the wrong instrument: the content of
    // a turn that ends in tool calls is preamble, and `onTurnEnd` throws it
    // away so the next turn REPLACES it. The visible reply is one turn's worth
    // whatever the turn count, and a run-scoped budget would be counting
    // characters that were deliberately discarded — truncating a legitimate
    // agentic run to pay for a cost the sidecar primitive already removed.
    //
    // Pinned because it is the load-bearing half of the argument: if a future
    // change ever made tool-call turns ACCUMULATE, the run-scoped byte
    // assertion above would still pass while the reply grew without a ceiling.
    setupDoc("doc-loop-cap", "Body");
    const PER_TURN = 40_000; // under the 64 KiB cap on its own; 3× is over it
    const collab = createLocalModelCollaborator(
      makeDeps({
        runTurn: async (opts) => {
          for (let turn = 0; turn < 3; turn++) {
            opts.onContentDelta?.("x".repeat(PER_TURN));
            await new Promise((r) => setTimeout(r, 0));
            opts.onTurnEnd?.({ hadToolCalls: turn < 2 });
          }
          return cleanResult("");
        },
      }),
    );
    collab.onEvent(chatEvent("go", { documentId: "doc-loop-cap" }));
    await drain(collab);

    const text = chatMessages()[0].text;
    // Exactly the LAST turn — not 3×, and not truncated: the cap never tripped
    // because no single turn reached it.
    expect(text).toBe("x".repeat(PER_TURN));
    expect(text).not.toContain("Reply truncated");
  });
});

describe("collaborator — licence (#1521)", () => {
  const REFUSAL = {
    error: "LICENSE_REQUIRED" as const,
    kind: "unlicensed" as const,
    message: "Tandem is unlicensed, so its AI features are turned off.",
  };

  it("runs no turn and writes no chat while unlicensed, logging once per refused state", async () => {
    setupDoc("doc-lic", "# Title\n\nBody.");
    const runTurn = vi.fn(async () => cleanResult("should not run"));
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const collab = createLocalModelCollaborator(makeDeps({ runTurn, aiRefusal: () => REFUSAL }));

    collab.onEvent(chatEvent("first", { documentId: "doc-lic", messageId: "a" }));
    collab.onEvent(chatEvent("second", { documentId: "doc-lic", messageId: "b" }));
    await drain(collab);

    expect(runTurn).not.toHaveBeenCalled();
    expect(chatMessages()).toHaveLength(0);
    const lines = errSpy.mock.calls.map((c) => String(c[0])).filter((l) => /unlicensed/.test(l));
    errSpy.mockRestore();
    expect(lines).toHaveLength(1);
  });

  it("is checked per run, so activation needs no restart (positive twin)", async () => {
    setupDoc("doc-lic2", "# Title\n\nBody.");
    let refused = true;
    const runTurn = vi.fn(async (opts: Parameters<CollaboratorDeps["runTurn"]>[0]) => {
      opts.onContentDelta?.("ok");
      opts.onTurnEnd?.({ hadToolCalls: false });
      return cleanResult("ok");
    });
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const collab = createLocalModelCollaborator(
      makeDeps({ runTurn, aiRefusal: () => (refused ? REFUSAL : null) }),
    );

    collab.onEvent(chatEvent("while refused", { documentId: "doc-lic2", messageId: "c" }));
    await drain(collab);
    expect(runTurn).not.toHaveBeenCalled();

    refused = false;
    collab.onEvent(chatEvent("after activation", { documentId: "doc-lic2", messageId: "d" }));
    await drain(collab);
    errSpy.mockRestore();
    expect(runTurn).toHaveBeenCalledTimes(1);
    expect(chatMessages()).toHaveLength(1);
  });
});

describe("collaborator — config resolved per chat event (#1123 R1)", () => {
  const OTHER: LocalModelConfig = {
    endpoint: "http://localhost:8080",
    modelId: "other-model",
    transport: "v1",
    agentIdentity: { provider: "local-llamacpp", displayName: "Other Model" },
  };

  it("a resolver answering null, then a config: the second chat runs with no restart", async () => {
    setupDoc("doc-late-config", "Body");
    let answer: LocalModelConfig | null = null;
    const seen: LocalModelConfig[] = [];
    const collab = createLocalModelCollaborator(
      makeDeps({
        resolveConfig: () => answer,
        runTurn: async (opts) => {
          seen.push(opts.config);
          return cleanResult("");
        },
      }),
    );

    collab.onEvent(chatEvent("one", { documentId: "doc-late-config", messageId: "a" }));
    await drain(collab);
    expect(seen).toEqual([]);

    answer = CONFIG; // "saved a moment ago" — the same collaborator instance
    collab.onEvent(chatEvent("two", { documentId: "doc-late-config", messageId: "b" }));
    await drain(collab);
    expect(seen).toEqual([CONFIG]);
  });

  it("a config that changes between two chats: each run gets the one current at its event", async () => {
    setupDoc("doc-config-change", "Body");
    let answer: LocalModelConfig | null = CONFIG;
    const seen: LocalModelConfig[] = [];
    const collab = createLocalModelCollaborator(
      makeDeps({
        resolveConfig: () => answer,
        runTurn: async (opts) => {
          seen.push(opts.config);
          opts.onContentDelta?.(`reply from ${opts.config.modelId}`);
          opts.onTurnEnd?.({ hadToolCalls: false });
          return cleanResult("");
        },
      }),
    );

    collab.onEvent(chatEvent("one", { documentId: "doc-config-change", messageId: "a" }));
    await drain(collab);
    answer = OTHER;
    collab.onEvent(chatEvent("two", { documentId: "doc-config-change", messageId: "b" }));
    await drain(collab);

    expect(seen.map((c) => [c.endpoint, c.modelId])).toEqual([
      [CONFIG.endpoint, CONFIG.modelId],
      [OTHER.endpoint, OTHER.modelId],
    ]);
    // The byline follows the config of the run that wrote the reply.
    const byText = new Map(chatMessages().map((m) => [m.text, m.agentIdentity]));
    expect(byText.get(`reply from ${CONFIG.modelId}`)).toEqual(CONFIG.agentIdentity);
    expect(byText.get(`reply from ${OTHER.modelId}`)).toEqual(OTHER.agentIdentity);
  });

  it("a run in flight keeps the config it started with when the resolver's answer changes mid-run", async () => {
    setupDoc("doc-config-midrun", "Body");
    let answer: LocalModelConfig | null = CONFIG;
    let release!: () => void;
    const gate = new Promise<void>((res) => {
      release = res;
    });
    let atStart: LocalModelConfig | undefined;
    let afterChange: LocalModelConfig | undefined;
    const collab = createLocalModelCollaborator(
      makeDeps({
        resolveConfig: () => answer,
        runTurn: async (opts) => {
          atStart = opts.config;
          await gate;
          afterChange = opts.config;
          opts.onContentDelta?.("late reply");
          opts.onTurnEnd?.({ hadToolCalls: false });
          return cleanResult("late reply");
        },
      }),
    );

    collab.onEvent(chatEvent("go", { documentId: "doc-config-midrun" }));
    await Promise.resolve(); // parked on `gate`
    expect(atStart).toBe(CONFIG);

    answer = OTHER; // the saved model changes while the run is parked
    release();
    await drain(collab);

    expect(afterChange).toBe(CONFIG);
    expect(afterChange).toEqual({
      endpoint: "http://127.0.0.1:11434",
      modelId: "m",
      transport: "v1",
      agentIdentity: { provider: "local-ollama", displayName: "Test Model" },
    });
    // The reply written after the change still carries the starting identity.
    const msgs = chatMessages();
    expect(msgs).toHaveLength(1);
    expect(msgs[0].agentIdentity).toEqual(CONFIG.agentIdentity);

    // …and the change is not lost: the NEXT run sees it.
    const next: LocalModelConfig[] = [];
    const collab2 = createLocalModelCollaborator(
      makeDeps({
        resolveConfig: () => answer,
        runTurn: async (opts) => {
          next.push(opts.config);
          return cleanResult("");
        },
      }),
    );
    collab2.onEvent(chatEvent("again", { documentId: "doc-config-midrun", messageId: "n" }));
    await drain(collab2);
    expect(next).toEqual([OTHER]);
  });

  it("a mid-run change does not need a second collaborator: the same one's next run sees it", async () => {
    setupDoc("doc-config-same", "Body");
    let answer: LocalModelConfig | null = CONFIG;
    const seen: LocalModelConfig[] = [];
    const collab = createLocalModelCollaborator(
      makeDeps({
        resolveConfig: () => answer,
        runTurn: async (opts) => {
          seen.push(opts.config);
          if (seen.length === 1) answer = OTHER; // changed while run 1 is in flight
          await Promise.resolve();
          seen.push(opts.config);
          return cleanResult("");
        },
      }),
    );
    collab.onEvent(chatEvent("one", { documentId: "doc-config-same", messageId: "a" }));
    await drain(collab);
    collab.onEvent(chatEvent("two", { documentId: "doc-config-same", messageId: "b" }));
    await drain(collab);
    expect(seen).toEqual([CONFIG, CONFIG, OTHER, OTHER]);
  });
});

describe("collaborator — unusable-model notice, once per state (#1123 R1.3–R1.5)", () => {
  const REASONS = Object.keys(UNUSABLE_NOTICE) as LocalModelUnusableReason[];
  const REFUSAL = {
    error: "LICENSE_REQUIRED" as const,
    kind: "unlicensed" as const,
    message: "Tandem is unlicensed, so its AI features are turned off.",
  };

  /** A broken state as the resolver would describe it. `key` distinguishes two
   *  states with the same reason (e.g. two different rejected endpoints). */
  function unusable(reason: LocalModelUnusableReason, key = "1"): LocalModelUnusable {
    return {
      reason,
      stateKey: `state:${reason}:${key}`,
      detail: `default entry "entry-${key}" (${reason})`,
    };
  }

  /**
   * A collaborator over a mutable saved state: `state.config` is what the
   * resolver answers, `state.broken` what the diagnosis answers when the config
   * is null. `fireModelsChanged` is the registry's change listener, captured
   * from the injected `onModelsChanged` at wire time.
   */
  function harness(over: Partial<CollaboratorDeps> = {}) {
    const state: { config: LocalModelConfig | null; broken: LocalModelUnusable | null } = {
      config: null,
      broken: null,
    };
    const runTurn = vi.fn(async (_opts: RunTurnOpts) => cleanResult(""));
    const diagnose = vi.fn(() => state.broken);
    let listener: (() => void) | null = null;
    const stopWatching = vi.fn(() => {
      listener = null;
    });
    const collab = createLocalModelCollaborator(
      makeDeps({
        runTurn,
        resolveConfig: () => state.config,
        diagnose,
        onModelsChanged: (cb) => {
          listener = cb;
          return stopWatching;
        },
        ...over,
      }),
    );
    collab.__startForTests();
    let n = 0;
    return {
      state,
      collab,
      runTurn,
      diagnose,
      stopWatching,
      hasListener: () => listener !== null,
      fireModelsChanged: () => {
        if (!listener) throw new Error("onModelsChanged listener was never registered");
        listener();
      },
      /** Send `count` chats, draining after each. */
      chat: async (docId: string, count = 1) => {
        for (let i = 0; i < count; i++) {
          collab.onEvent(chatEvent(`hello ${n}`, { documentId: docId, messageId: `n${n++}` }));
          await drain(collab);
        }
      },
    };
  }

  beforeEach(() => {
    // `noticeUnusable` prints one breadcrumb per state on stderr.
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  for (const reason of REASONS) {
    it(`${reason}: several chats in the same state produce exactly ONE notice, with the fixed text`, async () => {
      setupDoc("doc-notice", "Body");
      const h = harness();
      h.state.broken = unusable(reason);

      await h.chat("doc-notice", 4);

      expect(h.runTurn).not.toHaveBeenCalled();
      const notes = getBuffer();
      expect(notes).toHaveLength(1);
      expect(notes[0].message).toBe(UNUSABLE_NOTICE[reason]);
      expect(notes[0].severity).toBe("warning");
      expect(notes[0].type).toBe("general-error");
      // A fresh id and NO dedupKey: the client re-pops a toast on a repeated
      // dedupKey and drops an id it has already seen, so neither can carry "once".
      expect(typeof notes[0].id).toBe("string");
      expect(notes[0].id.length).toBeGreaterThan(0);
      expect("dedupKey" in notes[0]).toBe(false);
      // Nothing of the state's identity or log detail reaches the user.
      expect(notes[0].message).not.toContain(h.state.broken.stateKey);
      expect(notes[0].message).not.toContain(h.state.broken.detail);
      expect(notes[0].message).not.toContain("entry-1");
      await h.collab.stop();
    });
  }

  it("the three texts differ, and none carries a saved endpoint or model id", () => {
    expect(REASONS.slice().sort()).toEqual([
      "endpoint-rejected",
      "no-default-chosen",
      "no-endpoint",
    ]);
    const texts = REASONS.map((r) => UNUSABLE_NOTICE[r]);
    expect(new Set(texts).size).toBe(3);
    for (const text of texts) {
      expect(text.length).toBeGreaterThan(0);
      // The only address any text may hold is the documented example of an
      // accepted one. Strip it, and nothing URL-, host- or credential-shaped
      // may remain.
      const rest = text.split("http://127.0.0.1:11434").join("");
      expect(rest).not.toMatch(/https?:/i);
      expect(rest).not.toMatch(/\d+\.\d+\.\d+\.\d+/);
      expect(rest).not.toMatch(/localhost|:\d{2,5}\b|@/i);
      // Fixed copy: no interpolation slot survived into the string.
      expect(rest).not.toMatch(/\$\{|%s|undefined|null/);
    }
  });

  it("a different reason is a different state: each gets its own notice, with distinct fresh ids", async () => {
    setupDoc("doc-notice-reasons", "Body");
    const h = harness();
    for (const reason of REASONS) {
      h.state.broken = unusable(reason);
      await h.chat("doc-notice-reasons", 3);
    }
    const notes = getBuffer();
    expect(notes.map((n) => n.message)).toEqual(REASONS.map((r) => UNUSABLE_NOTICE[r]));
    expect(new Set(notes.map((n) => n.id)).size).toBe(REASONS.length);
    expect(notes.every((n) => !("dedupKey" in n))).toBe(true);
    await h.collab.stop();
  });

  it("the same reason under a different stateKey is a new notice (another rejected endpoint)", async () => {
    setupDoc("doc-notice-key", "Body");
    const h = harness();
    h.state.broken = unusable("endpoint-rejected", "1");
    await h.chat("doc-notice-key", 2);
    h.state.broken = unusable("endpoint-rejected", "2");
    await h.chat("doc-notice-key", 2);

    const notes = getBuffer();
    expect(notes).toHaveLength(2);
    expect(notes[0].message).toBe(UNUSABLE_NOTICE["endpoint-rejected"]);
    expect(notes[1].message).toBe(UNUSABLE_NOTICE["endpoint-rejected"]);
    expect(notes[1].id).not.toBe(notes[0].id);
    await h.collab.stop();
  });

  it("fixed (a chat runs), then broken again: a second notice", async () => {
    setupDoc("doc-notice-rebreak", "Body");
    const h = harness();
    const broken = unusable("endpoint-rejected");
    h.state.broken = broken;
    await h.chat("doc-notice-rebreak", 2);
    expect(getBuffer()).toHaveLength(1);

    h.state.config = CONFIG; // fixed
    await h.chat("doc-notice-rebreak");
    expect(h.runTurn).toHaveBeenCalledTimes(1);
    expect(getBuffer()).toHaveLength(1);

    h.state.config = null; // broken again, in the very same state as before
    h.state.broken = broken;
    await h.chat("doc-notice-rebreak", 3);

    const notes = getBuffer();
    expect(notes).toHaveLength(2);
    expect(notes[1].message).toBe(UNUSABLE_NOTICE["endpoint-rejected"]);
    expect(notes[1].id).not.toBe(notes[0].id);
    expect(h.runTurn).toHaveBeenCalledTimes(1);
    await h.collab.stop();
  });

  it("fixed and re-broken with NO chat in between: a second notice, via the registry-change listener", async () => {
    setupDoc("doc-notice-listener", "Body");
    const h = harness();
    const broken = unusable("no-default-chosen");
    h.state.broken = broken;
    await h.chat("doc-notice-listener", 2);
    expect(getBuffer()).toHaveLength(1);

    h.state.config = CONFIG; // a save fixes it…
    h.fireModelsChanged();
    h.state.config = null; // …and another save breaks it the same way
    h.state.broken = broken;
    h.fireModelsChanged();
    // The listener itself tells the user nothing; only a chat does.
    expect(getBuffer()).toHaveLength(1);

    await h.chat("doc-notice-listener", 3);
    const notes = getBuffer();
    expect(notes).toHaveLength(2);
    expect(notes[1].message).toBe(UNUSABLE_NOTICE["no-default-chosen"]);
    expect(notes[1].id).not.toBe(notes[0].id);
    expect(h.runTurn).not.toHaveBeenCalled();
    await h.collab.stop();
  });

  it("a registry change that leaves the state unchanged does NOT cause a repeat", async () => {
    setupDoc("doc-notice-unchanged", "Body");
    const h = harness();
    h.state.broken = unusable("no-endpoint");
    await h.chat("doc-notice-unchanged", 2);
    expect(getBuffer()).toHaveLength(1);

    // e.g. an unrelated entry was renamed: the file changed, the state did not.
    h.fireModelsChanged();
    h.fireModelsChanged();
    await h.chat("doc-notice-unchanged", 3);
    h.fireModelsChanged();
    await h.chat("doc-notice-unchanged");

    expect(getBuffer()).toHaveLength(1);
    await h.collab.stop();
  });

  it("registers the registry-change listener when wired and releases it on stop()", async () => {
    const h = harness();
    expect(h.hasListener()).toBe(true);
    expect(h.stopWatching).not.toHaveBeenCalled();
    await h.collab.stop();
    expect(h.stopWatching).toHaveBeenCalledTimes(1);
    expect(h.hasListener()).toBe(false);
  });

  it("a null diagnosis is silent and runs nothing", async () => {
    setupDoc("doc-notice-none", "Body");
    const h = harness();
    h.state.broken = null; // no models, a disabled default, a cloud default…

    await h.chat("doc-notice-none", 3);

    expect(h.diagnose).toHaveBeenCalledTimes(3); // it was asked, and said "nothing to tell"
    expect(h.runTurn).not.toHaveBeenCalled();
    expect(getBuffer()).toEqual([]);
    expect(chatMessages()).toHaveLength(0);
    await h.collab.stop();
  });

  it("no diagnose dep at all is silent too", async () => {
    setupDoc("doc-notice-nodiag", "Body");
    const runTurn = vi.fn(async () => cleanResult(""));
    const collab = createLocalModelCollaborator(makeDeps({ runTurn, resolveConfig: () => null }));
    collab.onEvent(chatEvent("hi", { documentId: "doc-notice-nodiag" }));
    await drain(collab);
    expect(runTurn).not.toHaveBeenCalled();
    expect(getBuffer()).toEqual([]);
  });

  it("the diagnosis is not consulted while a config resolves", async () => {
    setupDoc("doc-notice-ok", "Body");
    const h = harness();
    h.state.config = CONFIG;
    h.state.broken = unusable("endpoint-rejected"); // would be reported if it were asked
    await h.chat("doc-notice-ok", 2);
    expect(h.runTurn).toHaveBeenCalledTimes(2);
    expect(h.diagnose).not.toHaveBeenCalled();
    expect(getBuffer()).toEqual([]);
    await h.collab.stop();
  });

  it("Solo mode: no notice and no run, and a Solo chat does not use up the once", async () => {
    setupDoc("doc-notice-solo", "Body");
    const h = harness();
    h.state.broken = unusable("endpoint-rejected");
    setMode("solo");

    await h.chat("doc-notice-solo", 3);
    expect(getBuffer()).toEqual([]);
    expect(h.runTurn).not.toHaveBeenCalled();

    setMode("tandem");
    await h.chat("doc-notice-solo", 2);
    expect(getBuffer()).toHaveLength(1);
    expect(getBuffer()[0].message).toBe(UNUSABLE_NOTICE["endpoint-rejected"]);
    expect(h.runTurn).not.toHaveBeenCalled();
    await h.collab.stop();
  });

  it("Solo mode with a usable config: no run and no notice", async () => {
    setupDoc("doc-notice-solo-ok", "Body");
    const h = harness();
    h.state.config = CONFIG;
    setMode("solo");
    await h.chat("doc-notice-solo-ok", 2);
    expect(h.runTurn).not.toHaveBeenCalled();
    expect(getBuffer()).toEqual([]);
    await h.collab.stop();
  });

  it("a licence refusal: no notice, and the refused chat does not use up the once", async () => {
    setupDoc("doc-notice-lic", "Body");
    let refused = true;
    const h = harness({ aiRefusal: () => (refused ? REFUSAL : null) });
    h.state.broken = unusable("no-default-chosen");

    await h.chat("doc-notice-lic", 3);
    expect(getBuffer()).toEqual([]);
    expect(h.runTurn).not.toHaveBeenCalled();
    expect(chatMessages()).toHaveLength(0);

    refused = false; // activated; the model is still broken in the same way
    await h.chat("doc-notice-lic", 3);
    const notes = getBuffer();
    expect(notes).toHaveLength(1);
    expect(notes[0].message).toBe(UNUSABLE_NOTICE["no-default-chosen"]);

    refused = true; // and a later refusal is silent again
    await h.chat("doc-notice-lic", 2);
    expect(getBuffer()).toHaveLength(1);
    await h.collab.stop();
  });

  it("the notice is not a chat message and not an event-queue event", async () => {
    setupDoc("doc-notice-surface", "Body");
    attachCtrlObservers();
    const events: TandemEvent[] = [];
    const internal = (e: TandemEvent) => events.push(e);
    const external = (e: TandemEvent) => events.push(e);
    subscribe(internal, "internal");
    subscribe(external, "external");
    const ctrl = getOrCreateDocument(CTRL_ROOM);
    let ctrlUpdates = 0;
    const onUpdate = () => {
      ctrlUpdates++;
    };
    ctrl.on("update", onUpdate);
    try {
      const h = harness();
      for (const reason of REASONS) {
        h.state.broken = unusable(reason);
        await h.chat("doc-notice-surface", 2);
      }
      await h.collab.stop();
    } finally {
      ctrl.off("update", onUpdate);
      unsubscribe(internal);
      unsubscribe(external);
    }

    expect(getBuffer()).toHaveLength(REASONS.length); // the notices did go out…
    // …through the browser's notify stream only: the chat map and its streaming
    // sidecar are untouched, CTRL_ROOM saw no write at all, and no subscriber of
    // the event queue (the AI-facing surface) was handed anything.
    expect(chatMap().size).toBe(0);
    expect(streamMap().size).toBe(0);
    expect(ctrlUpdates).toBe(0);
    expect(events).toEqual([]);
  });
});

describe("collaborator — editing permission handed to the run (#1123 R2)", () => {
  /** Park one run and hand back the `editingAllowed` it was given. */
  function parkedRun(over: Partial<CollaboratorDeps>) {
    const captured: RunTurnOpts[] = [];
    const releases: Array<() => void> = [];
    const collab = createLocalModelCollaborator(
      makeDeps({
        runTurn: async (opts) => {
          captured.push(opts);
          await new Promise<void>((res) => {
            releases.push(res);
          });
          return cleanResult("");
        },
        ...over,
      }),
    );
    return {
      collab,
      captured,
      /** Start a run and wait until it is parked inside `runTurn`. */
      start: async (docId: string, messageId: string) => {
        collab.onEvent(chatEvent("go", { documentId: docId, messageId }));
        await Promise.resolve();
        const opts = captured[captured.length - 1];
        if (!opts) throw new Error("runTurn was not reached");
        return opts;
      },
      finish: async () => {
        for (const r of releases.splice(0)) r();
        await drain(collab);
      },
    };
  }

  it("runTurn receives an editingAllowed function; with no editingState dep it answers false", async () => {
    setupDoc("doc-edit-absent", "Body");
    const p = parkedRun({});
    const opts = await p.start("doc-edit-absent", "a");
    // `typeof` first: a missing field would make a bare falsy assertion pass.
    expect(typeof opts.editingAllowed).toBe("function");
    expect(opts.editingAllowed()).toBe(false);
    expect(opts.editingAllowed()).toBe(false);
    await p.finish();
  });

  it("answers true while the setting is on and no Off has been requested since the run began", async () => {
    setupDoc("doc-edit-on", "Body");
    const p = parkedRun({ editingState: () => ({ enabled: true, offEpoch: 7 }) });
    const opts = await p.start("doc-edit-on", "a");
    expect(opts.editingAllowed()).toBe(true);
    expect(opts.editingAllowed()).toBe(true); // re-read on every call, still true
    await p.finish();
  });

  it("answers false while the setting is off", async () => {
    setupDoc("doc-edit-off", "Body");
    const p = parkedRun({ editingState: () => ({ enabled: false, offEpoch: 7 }) });
    const opts = await p.start("doc-edit-off", "a");
    expect(opts.editingAllowed()).toBe(false);
    await p.finish();
  });

  it("reads the setting live: switching it off mid-run revokes without any Off counter change", async () => {
    setupDoc("doc-edit-live", "Body");
    const editing = { enabled: true, offEpoch: 0 };
    const p = parkedRun({ editingState: () => ({ ...editing }) });
    const opts = await p.start("doc-edit-live", "a");
    expect(opts.editingAllowed()).toBe(true);
    editing.enabled = false;
    expect(opts.editingAllowed()).toBe(false);
    await p.finish();
  });

  it("Off-then-On inside one run stays off for that run; the next run sees on again", async () => {
    setupDoc("doc-edit-epoch", "Body");
    const editing = { enabled: true, offEpoch: 3 };
    const p = parkedRun({ editingState: () => ({ ...editing }) });

    const first = await p.start("doc-edit-epoch", "a");
    expect(first.editingAllowed()).toBe(true);

    // The user switches editing Off…
    editing.enabled = false;
    editing.offEpoch = 4;
    expect(first.editingAllowed()).toBe(false);
    // …and back On before this run's next tool call.
    editing.enabled = true;
    expect(first.editingAllowed()).toBe(false);
    expect(first.editingAllowed()).toBe(false); // and it stays false
    await p.finish();
    // Still false once the run is over: the closure never re-arms.
    expect(first.editingAllowed()).toBe(false);

    // A run that starts after the Off-then-On has the permission again.
    const second = await p.start("doc-edit-epoch", "b");
    expect(second).not.toBe(first);
    expect(second.editingAllowed()).toBe(true);
    expect(first.editingAllowed()).toBe(false);
    await p.finish();
  });

  it("an Off counter that moved while the setting reads on is still a revoke", async () => {
    // The Off-then-On may complete between two reads, so the run never observes
    // `enabled: false` at all — only the counter can tell it.
    setupDoc("doc-edit-blink", "Body");
    const editing = { enabled: true, offEpoch: 0 };
    const p = parkedRun({ editingState: () => ({ ...editing }) });
    const opts = await p.start("doc-edit-blink", "a");
    expect(opts.editingAllowed()).toBe(true);
    editing.offEpoch = 1; // enabled never read as false
    expect(opts.editingAllowed()).toBe(false);
    await p.finish();
  });
});
