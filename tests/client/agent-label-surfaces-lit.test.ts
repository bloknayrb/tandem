// @vitest-environment happy-dom

/**
 * Every rendered surface that names an AI, while local models are on (#1123,
 * ADR-039 amendment 2026-11-17 (agent labels); the agent-labels brief's R1.1,
 * R1.5 "Surfaces", "Local names" and "Toolbar", and R2.2).
 *
 * Expected values, each with its source:
 *  - Claude-side work and every "Send to" control read "Claude" (P10(1) and V3
 *    of ADR-039's 2026-11-17 amendment on switching local models on); the
 *    status pill reads "Claude is editing" (AL-1).
 *  - A record a local model wrote names its own stamp, never the store's entry;
 *    an empty stamped name reads "Local model" (AL-7).
 *  - The comment filter's agent chip and its summary read "AI" (Label decision
 *    L3 of 2026-11-17, AL-3), and the chip still matches both kinds of comment.
 *
 * The Models store holds state (a): one enabled local entry "Qwen", no default
 * (master's family there: "Local model"). `BYO_MODELS_ENABLED` is flipped on by
 * mocking the constant (#2449); the store is seeded through `loadFromServer`.
 * Expected strings are literals, never the module's constants. The dark twin is
 * `agent-label-surfaces-dark.test.ts`; the editor aria-label is
 * `agent-label-decoration-lit.test.ts`.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  _resetModelsStoreForTests,
  getModelsSnapshot,
  loadFromServer,
} from "../../src/client/hooks/useModels.svelte.js";
import {
  batchSendTo,
  cardAuthor,
  cardSendTo,
  cardWorking,
  chatByline,
  commentFilter,
  replyByline,
  statusPill,
} from "../helpers/agent-label-surfaces";
import { stripAppComments } from "../helpers/app-source";

vi.mock(import("../../src/shared/constants.js"), async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/shared/constants.js")>()),
  BYO_MODELS_ENABLED: true as typeof import("../../src/shared/constants.js").BYO_MODELS_ENABLED,
}));

const STATE_A = {
  schemaVersion: 1,
  models: [
    {
      id: "l1",
      provider: "local-ollama",
      displayName: "Qwen",
      modelId: "qwen2.5:14b",
      enabled: true,
    },
  ],
  defaultModelId: null,
};

const MY_LLAMA = { provider: "local-llamacpp" as const, displayName: "My Llama" };
const EMPTY_NAME = { provider: "local-llamacpp" as const, displayName: "" };

beforeEach(async () => {
  localStorage.clear();
  _resetModelsStoreForTests();
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.stubGlobal(
    "fetch",
    vi.fn(
      async () => new Response(JSON.stringify({ file: STATE_A, etag: "e-1" }), { status: 200 }),
    ),
  );
  await loadFromServer();
  // Sanity: the store holds state (a), so a build that reads it when lit shows "Local model".
  expect(getModelsSnapshot().models.map((m) => m.id)).toEqual(["l1"]);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("lit, state (a): Claude-side work reads Claude on every surface (R1.1)", () => {
  it("chat byline", async () => {
    expect(await chatByline()).toBe("Claude");
  });

  it("reply byline", async () => {
    expect(await replyByline()).toBe("Claude");
  });

  it("card author", () => {
    expect(cardAuthor()).toBe("Claude");
  });

  it("card working indicator, aria-label and title", () => {
    expect(cardWorking()).toEqual({
      ariaLabel: "Claude is working on this annotation",
      title: "Claude is working on this annotation",
    });
  });

  it("status bar working pill, whole text (AL-1)", () => {
    expect(statusPill()).toBe("Claude is editing…");
  });

  it("card Send to (V3)", () => {
    expect(cardSendTo()).toBe("Send to Claude");
  });

  it("batch Send {n} to and Send to (V3)", () => {
    expect(batchSendTo()).toEqual({ request: "Send 2 to Claude", commit: "Send to Claude" });
  });
});

describe("lit, state (a), with chat on the local model: Claude-side work still reads Claude (R1.1, R1.2)", () => {
  // "whichever answers chat": the props the chat panel and the status bar
  // already receive for the local period must not relabel Claude's work.
  it("chat byline with the chat panel in the local period", async () => {
    expect(await chatByline(undefined, { localPeriod: true })).toBe("Claude");
  });

  it("status bar working pill while the status bar is told chat is local", () => {
    expect(statusPill({ aiLocalChat: "local" })).toBe("Claude is editing…");
  });
});

describe("lit: the comment filter reads AI (R2.1, R2.2, Label decision L3, AL-3)", () => {
  it("the agent chip is named 'AI', the summary says 'AI', and both kinds of agent comment stay listed", async () => {
    const { chipName, summary, listed } = await commentFilter();
    expect(chipName).toBe("AI");
    expect(summary).toContain("AI");
    expect(summary).not.toContain("Claude");
    expect(listed).toEqual(["claude-1", "local-1"]);
  });
});

describe("lit: a local model's name only on what it wrote (R1.1 'Local names')", () => {
  it("stamped 'My Llama' while the store's entry is 'Qwen': chat, reply and card read 'My Llama'", async () => {
    expect(await chatByline(MY_LLAMA)).toBe("My Llama");
    expect(await replyByline(MY_LLAMA)).toBe("My Llama");
    expect(cardAuthor(MY_LLAMA)).toBe("My Llama");
  });

  it("stamped with an empty name: chat, reply and card read 'Local model' (AL-7)", async () => {
    expect(await chatByline(EMPTY_NAME)).toBe("Local model");
    expect(await replyByline(EMPTY_NAME)).toBe("Local model");
    expect(cardAuthor(EMPTY_NAME)).toBe("Local model");
  });
});

describe("Toolbar's composer reads the same label (R1.5 'Toolbar')", () => {
  // No test mounts the Toolbar. These pins pass on master too: their only job
  // is to fail if the composer stops reading `createAgentLabel().family`, whose
  // value the direct test (`agent-label-lit.svelte.test.ts`) proves.
  const src = stripAppComments(
    readFileSync(
      join(import.meta.dirname, "../../src/client/editor/toolbar/Toolbar.svelte"),
      "utf8",
    ),
  );

  it("the label is createAgentLabel(), imported from the hook", () => {
    expect(src).toContain('import { createAgentLabel } from "../../hooks/useAgentLabel.svelte";');
    expect(src).toContain("const agentLabel = createAgentLabel();");
  });

  for (const site of [
    "title={`Keep private — never sent to ${agentLabel.family}. Alt+Enter always submits privately, whatever this is set to.`}",
    ": `Send to ${agentLabel.family} as an outbound comment`}",
    '><span class="composer-dest" aria-hidden="true"></span>{agentLabel.family}</button>',
    ": `Add — send to ${agentLabel.family} (Ctrl+Enter)`}",
  ]) {
    it(`pins: ${site.slice(0, 60)}`, () => {
      expect(src).toContain(site);
    });
  }
});

describe("anchor", () => {
  it("the file-level mock applied, so every case in this file is lit", async () => {
    const { BYO_MODELS_ENABLED } = await import("../../src/shared/constants.js");
    expect(BYO_MODELS_ENABLED).toBe(true);
  });
});
