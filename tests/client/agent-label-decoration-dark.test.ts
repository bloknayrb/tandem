// @vitest-environment happy-dom

/**
 * The editor's agent-comment aria-label while local models are off, as shipped
 * (#1123, ADR-039 amendment 2026-11-17 (agent labels); the agent-labels brief's
 * R3.1 and AL-0).
 *
 * Dark shows what master shows: the registry's family read from localStorage
 * settings (`agentLabelSource()`'s dark branch). Expected values are literal
 * strings, never the imported fallback constant, so a change to that constant
 * fails here. Each registry state seeds localStorage before the decoration pass,
 * because the dark source reads settings once per call. The one case master
 * fails: a record stamped with an empty name reads "Local model" (AL-7; the
 * empty-name rule has no flag, and a dark build never writes `agentIdentity`).
 *
 * The whole file is the dark state, so it forces the flag off (#2449). The lit
 * twin is `agent-label-decoration-lit.test.ts`.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import { CURRENT_SCHEMA_VERSION } from "../../src/client/hooks/useTandemSettings.js";
import {
  BYO_MODELS_ENABLED,
  TANDEM_SETTINGS_KEY,
  Y_MAP_ANNOTATIONS,
} from "../../src/shared/constants";

vi.mock(import("../../src/shared/constants.js"), async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/shared/constants.js")>()),
  BYO_MODELS_ENABLED: false as typeof import("../../src/shared/constants.js").BYO_MODELS_ENABLED,
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
const { _resetModelsStoreForTests } = await import("../../src/client/hooks/useModels.svelte.js");

const fakeState = { doc: { content: { size: 100 } } };

function ariaLabelFor(agentIdentity?: { provider: string; displayName: string }): string {
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

function seedSettings(models: Array<Record<string, unknown>>, defaultModelId: string | null): void {
  localStorage.setItem(
    TANDEM_SETTINGS_KEY,
    JSON.stringify({ schemaVersion: CURRENT_SCHEMA_VERSION, models, defaultModelId }),
  );
}

/** The registry states of R3.1: (1), (2), (3). */
const STATES = [
  {
    name: "(1) an openai 'My GPT' default",
    seed: () =>
      seedSettings(
        [{ id: "m1", provider: "openai", displayName: "My GPT", modelId: "gpt-4o", enabled: true }],
        "m1",
      ),
    family: "GPT",
  },
  {
    name: "(2) a local-ollama entry",
    seed: () =>
      seedSettings(
        [
          {
            id: "l1",
            provider: "local-ollama",
            displayName: "Qwen",
            modelId: "qwen2.5:14b",
            enabled: true,
          },
        ],
        null,
      ),
    family: "Local model",
  },
  { name: "(3) nothing", seed: () => {}, family: "Assistant" },
] as const;

beforeEach(() => {
  localStorage.clear();
  _resetModelsStoreForTests();
});

describe("editor aria-label, dark: master's labels (R3.1)", () => {
  it("anchor: the file-level mock applied, so every case below is dark", () => {
    expect(BYO_MODELS_ENABLED).toBe(false);
  });

  for (const s of STATES) {
    it(`${s.name}: "${s.family} comment annotation"`, () => {
      s.seed();
      expect(ariaLabelFor()).toBe(`${s.family} comment annotation`);
    });
  }

  it("a record stamped with an empty name reads 'Local model comment annotation' (AL-7)", () => {
    STATES[0].seed();
    expect(ariaLabelFor({ provider: "local-ollama", displayName: "" })).toBe(
      "Local model comment annotation",
    );
  });
});
