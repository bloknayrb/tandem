// @vitest-environment happy-dom

/**
 * The agent label for Claude-side work while local models are on (#1123, ADR-039
 * amendment 2026-11-17 (agent labels), R1.1-R1.3 and R1.5 "Direct" and "Both chat
 * states" of the agent-labels brief).
 *
 * P10(1) and V3 (ADR-039's 2026-11-17 amendment on switching local models on):
 * Claude's replies and comments, and every "Send to" control, say "Claude"
 * whatever models are saved. AL-1: the status pill's `specific` reads "Claude"
 * too. So `createAgentLabel()` answers "Claude" in every registry state below,
 * where master answered the registry's family: (a) "Local model", (b)
 * "Assistant", (c) "GPT".
 *
 * `BYO_MODELS_ENABLED` is flipped on by mocking the constant (#2449). The store
 * is seeded through `loadFromServer` with a stubbed `fetch`, as
 * `use-models-loading.test.ts` does — never by mocking `agentLabelSource`, so a
 * build that reads the store when lit is caught. The dark rendering of the same
 * states is `agent-label-surfaces-dark.test.ts`.
 */

import { render } from "@testing-library/svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installHeldFetch } from "../helpers/held-fetch";

vi.mock(import("../../src/shared/constants.js"), async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/shared/constants.js")>()),
  BYO_MODELS_ENABLED: true as typeof import("../../src/shared/constants.js").BYO_MODELS_ENABLED,
}));

const { _resetModelsStoreForTests, getModelsSnapshot, loadFromServer } = await import(
  "../../src/client/hooks/useModels.svelte.js"
);
const { createAgentLabel } = await import("../../src/client/hooks/useAgentLabel.svelte.js");
const answerer = await import("../../src/client/hooks/useChatAnswerer.svelte.js");
const { default: AnnotationCardActions } = await import(
  "../../src/client/panels/AnnotationCardActions.svelte"
);

type ServerFile = {
  schemaVersion: 1;
  models: Array<Record<string, unknown>>;
  defaultModelId: string | null;
};

/** The registry states the brief names (R1.5): (a), (b), (c). */
const STATES: Record<"a" | "b" | "c", { file: ServerFile; master: string }> = {
  a: {
    file: {
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
    },
    master: "Local model",
  },
  b: { file: { schemaVersion: 1, models: [], defaultModelId: null }, master: "Assistant" },
  c: {
    file: {
      schemaVersion: 1,
      models: [
        { id: "o1", provider: "openai", displayName: "My GPT", modelId: "gpt-4o", enabled: true },
      ],
      defaultModelId: "o1",
    },
    master: "GPT",
  },
};

async function seedStore(file: ServerFile): Promise<void> {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(JSON.stringify({ file, etag: "e-1" }), { status: 200 })),
  );
  await loadFromServer();
  vi.unstubAllGlobals();
  // Sanity: the seed reached the store, so a build reading the store is exposed.
  expect(getModelsSnapshot().models.map((m) => m.id)).toEqual(file.models.map((m) => m.id));
  expect(getModelsSnapshot().defaultModelId).toBe(file.defaultModelId);
}

function cardSendLabel(): string {
  const r = render(AnnotationCardActions, {
    props: {
      annotationId: "n1",
      annotationType: "note",
      isPending: true,
      isEditing: false,
      onSendToClaude: vi.fn(),
      aiDisabled: false,
    },
  });
  const text =
    r.container
      .querySelector("[data-testid='send-to-claude-btn-n1']")
      ?.textContent?.replace(/\s+/g, " ")
      .trim() ?? "";
  r.unmount();
  return text;
}

beforeEach(() => {
  _resetModelsStoreForTests();
  answerer._resetChatAnswererForTests();
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("createAgentLabel, lit: Claude-side work reads Claude whatever the store holds (R1.1, R1.3)", () => {
  for (const [name, { file, master }] of Object.entries(STATES)) {
    it(`state (${name}): family and specific are "Claude" (master: "${master}")`, async () => {
      await seedStore(file);
      const label = createAgentLabel();
      expect(label.family).toBe("Claude");
      expect(label.specific).toBe("Claude");
    });
  }
});

describe("both chat states: the label does not follow who answers chat (R1.2)", () => {
  it("chat known to be local (a read answered 'local'): still Claude, card Send to Claude", async () => {
    await seedStore(STATES.a.file);
    const held = installHeldFetch();
    const read = answerer.requestRead();
    const call = await held.request(1);
    await call.answer(200, {
      answerer: "local",
      localModelResolves: true,
      localModelState: "usable",
      runGeneration: "gen-1",
    });
    await read;
    // Sanity: chat really is local by the known read.
    const chat = answerer.createChatAnswerer();
    expect(chat.status).toBe("known");
    expect(chat.answerer).toBe("local");
    expect(answerer.inLocalPeriod(false)).toBe(true);

    const label = createAgentLabel();
    expect(label.family).toBe("Claude");
    expect(label.specific).toBe("Claude");
    expect(cardSendLabel()).toBe("Send to Claude");
  });

  it("chat held local with no known read (noteHeld(true) alone): still Claude, card Send to Claude", async () => {
    await seedStore(STATES.a.file);
    answerer.noteHeld(true);
    // Sanity: no known read, and the held flag alone puts chat in the local period.
    expect(answerer.createChatAnswerer().status).not.toBe("known");
    expect(answerer.inLocalPeriod(true)).toBe(true);

    const label = createAgentLabel();
    expect(label.family).toBe("Claude");
    expect(label.specific).toBe("Claude");
    expect(cardSendLabel()).toBe("Send to Claude");
  });
});

describe("anchor", () => {
  it("the file-level mock applied, so every case in this file is lit", async () => {
    const { BYO_MODELS_ENABLED } = await import("../../src/shared/constants.js");
    expect(BYO_MODELS_ENABLED).toBe(true);
  });
});
