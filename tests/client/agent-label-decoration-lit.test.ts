// @vitest-environment happy-dom

/**
 * The editor's agent-comment aria-label while local models are on (#1123,
 * ADR-039 amendment 2026-11-17 (agent labels); the agent-labels brief's R1.1,
 * R1.3 and R1.5 "Direct", "Surfaces" and "Local names").
 *
 * `readAgentFamilyLabel` is module-private, so it is read through the
 * decoration plugin, with the ProseMirror mocks of `annotation-decoration.test.ts`'s
 * AR2 harness.
 *
 * The values and the text that fixes each (ADR-039's 2026-11-17 amendment on
 * switching local models on):
 *  - A Claude-side comment reads "Claude comment annotation" whatever the Models
 *    store holds. P10(1): "Claude's own replies and comments are always labelled
 *    "Claude"; a local model's name appears only on what it wrote". V3: "The
 *    "Send to" control labels and the annotation aria-labels follow P10(1)".
 *    Master read "Local model", "Assistant", "GPT", "Local model" in states
 *    (a), (b), (c), (d).
 *  - A comment the local model wrote names its stamped model: P10(1)'s second
 *    half.
 *  - An identity without a usable name reads "Local model": this PR's own
 *    ruling AL-7, unconfirmed until the review session confirms it.
 *
 * `BYO_MODELS_ENABLED` is flipped on by mocking the constant (#2449); the store
 * is seeded through `loadFromServer` with a stubbed `fetch`. The dark twin is
 * `agent-label-decoration-dark.test.ts`.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import { Y_MAP_ANNOTATIONS } from "../../src/shared/constants";
import { installHeldFetch } from "../helpers/held-fetch";

vi.mock(import("../../src/shared/constants.js"), async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/shared/constants.js")>()),
  BYO_MODELS_ENABLED: true as typeof import("../../src/shared/constants.js").BYO_MODELS_ENABLED,
}));

// --- ProseMirror mocks (as annotation-decoration.test.ts) ---

const EMPTY_SENTINEL: { _tag: string; map: () => unknown } = {
  _tag: "DecorationSet.empty",
  map: () => EMPTY_SENTINEL,
};

vi.mock("@tiptap/pm/view", () => ({
  DecorationSet: {
    empty: EMPTY_SENTINEL,
    create(_doc: unknown, decorations: unknown[]) {
      if (decorations.length === 0) return EMPTY_SENTINEL;
      return { decorations, _tag: "created" };
    },
  },
  Decoration: {
    inline(from: number, to: number, attrs: Record<string, string>) {
      return { from, to, attrs, _type: "inline" };
    },
  },
}));

vi.mock("@tiptap/pm/state", () => ({
  Plugin: class {
    constructor(public spec: any) {}
  },
  PluginKey: class {
    key: string;
    constructor(public name: string) {
      this.key = `tandemAnnotations$`;
    }
    getState() {
      return null;
    }
  },
}));

vi.mock("@tiptap/core", () => ({
  Extension: {
    create<T>(config: T) {
      return config;
    },
  },
}));

// `PmPos` is a branded number, so a plain literal needs the cast.
vi.mock(import("../../src/client/positions"), () => ({
  annotationToPmRange(_ann: unknown, _doc: unknown, _ydoc: unknown) {
    return { from: 1, to: 5, method: "flat" } as unknown as NonNullable<
      ReturnType<typeof import("../../src/client/positions").annotationToPmRange>
    >;
  },
}));

const { AnnotationExtension } = await import("../../src/client/editor/extensions/annotation");
const { _resetModelsStoreForTests, getModelsSnapshot, loadFromServer } = await import(
  "../../src/client/hooks/useModels.svelte.js"
);
const answerer = await import("../../src/client/hooks/useChatAnswerer.svelte.js");

const fakeState = { doc: { content: { size: 100 } } };

function ariaLabelFor(agentIdentity?: { provider: string; displayName?: unknown }): string {
  const ydoc = new Y.Doc();
  ydoc.getMap(Y_MAP_ANNOTATIONS).set("ann-1", {
    id: "ann-1",
    type: "comment",
    status: "pending",
    content: "test",
    author: "claude",
    audience: "outbound",
    timestamp: 0,
    range: { from: 1, to: 5 },
    ...(agentIdentity ? { agentIdentity } : {}),
  });
  const ext = AnnotationExtension as any;
  const plugin = ext.addProseMirrorPlugins.call({ options: { ydoc } })[0];
  const result = plugin.spec.state.init(undefined, fakeState) as any;
  expect(result).not.toBe(EMPTY_SENTINEL);
  return result.decorations[0].attrs["aria-label"];
}

type ServerFile = {
  schemaVersion: 1;
  models: Array<Record<string, unknown>>;
  defaultModelId: string | null;
};

const QWEN = {
  id: "l1",
  provider: "local-ollama",
  displayName: "Qwen",
  modelId: "qwen2.5:14b",
  enabled: true,
};

// (d), an enabled local model as the default, added in review round 1: the
// normal lit state once the first saved model becomes the default.
const STATES: Record<"a" | "b" | "c" | "d", { file: ServerFile; master: string }> = {
  a: { file: { schemaVersion: 1, models: [QWEN], defaultModelId: null }, master: "Local model" },
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
  d: { file: { schemaVersion: 1, models: [QWEN], defaultModelId: "l1" }, master: "Local model" },
};

async function seedStore(file: ServerFile): Promise<void> {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(JSON.stringify({ file, etag: "e-1" }), { status: 200 })),
  );
  await loadFromServer();
  vi.unstubAllGlobals();
  expect(getModelsSnapshot().models.map((m) => m.id)).toEqual(file.models.map((m) => m.id));
  expect(getModelsSnapshot().defaultModelId).toBe(file.defaultModelId);
}

beforeEach(() => {
  _resetModelsStoreForTests();
  answerer._resetChatAnswererForTests();
  localStorage.clear();
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("editor aria-label, lit: Claude-side comments read Claude (R1.1)", () => {
  for (const [name, { file, master }] of Object.entries(STATES)) {
    it(`state (${name}): "Claude comment annotation" (master: "${master} comment annotation")`, async () => {
      await seedStore(file);
      expect(ariaLabelFor()).toBe("Claude comment annotation");
    });
  }
});

describe("editor aria-label, lit: both chat states (R1.2)", () => {
  // The comment goes to Claude at once or after the switch back, so the label
  // does not follow who answers chat. A build keyed on the known answer fails
  // the first case; one keyed on the held flag fails the second.
  for (const state of ["a", "d"] as const) {
    it(`state (${state}), chat known to be local (a read answered 'local'): 'Claude comment annotation'`, async () => {
      await seedStore(STATES[state].file);
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
      expect(answerer.createChatAnswerer().answerer).toBe("local");
      expect(answerer.inLocalPeriod(false)).toBe(true);
      expect(ariaLabelFor()).toBe("Claude comment annotation");
    });

    it(`state (${state}), chat held local with no known read (noteHeld(true) alone): 'Claude comment annotation'`, async () => {
      await seedStore(STATES[state].file);
      answerer.noteHeld(true);
      expect(answerer.createChatAnswerer().status).not.toBe("known");
      expect(answerer.inLocalPeriod(true)).toBe(true);
      expect(ariaLabelFor()).toBe("Claude comment annotation");
    });
  }
});

describe("editor aria-label, lit: a local-model comment names its own stamp", () => {
  it("stamped 'My Llama' while the store's entry is 'Qwen': 'My Llama comment annotation'", async () => {
    await seedStore(STATES.a.file);
    expect(ariaLabelFor({ provider: "local-ollama", displayName: "My Llama" })).toBe(
      "My Llama comment annotation",
    );
  });

  it("stamped with an empty name: 'Local model comment annotation' (AL-7)", async () => {
    await seedStore(STATES.a.file);
    expect(ariaLabelFor({ provider: "local-ollama", displayName: "" })).toBe(
      "Local model comment annotation",
    );
  });

  it("an identity with no displayName at all (no shipped writer makes one): 'Local model comment annotation' (AL-7)", async () => {
    await seedStore(STATES.a.file);
    expect(ariaLabelFor({ provider: "local-ollama" })).toBe("Local model comment annotation");
  });
});

describe("anchor", () => {
  it("the file-level mock applied, so every case in this file is lit", async () => {
    const { BYO_MODELS_ENABLED } = await import("../../src/shared/constants.js");
    expect(BYO_MODELS_ENABLED).toBe(true);
  });
});
