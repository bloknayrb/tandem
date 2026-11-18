// @vitest-environment happy-dom

/**
 * Every rendered surface that names an AI, while local models are off, as
 * shipped (#1123, ADR-039 amendment 2026-11-17 (agent labels); the agent-labels
 * brief's R3.1 to R3.3 and AL-0).
 *
 * Dark shows what master shows. The label is resolved from localStorage settings
 * (`agentLabelSource()`'s dark branch), so each registry state is seeded before
 * its own mount: the dark source reads settings once per call. Expected values
 * are LITERAL strings — this file never imports the fallback constant, so
 * changing that constant fails here where the older dark tests stay green.
 *
 *  (1) an `openai` "My GPT" default  → "GPT"; the pill "My GPT is editing…"
 *  (2) a `local-ollama` entry "Qwen" → "Local model"; the pill "Qwen is editing…"
 *  (3) nothing                       → "Assistant"; the pill "Assistant is editing…"
 *
 * The pill uses the registry's model name (`specific`) while dark, as master
 * does; the brief names only (1)'s pill, and (2) and (3) are master's values too.
 *
 * These pass on master. The one case master fails: a record stamped with an
 * empty name reads "Local model" (AL-7) — the empty-name rule has no flag, and
 * a dark build never writes `agentIdentity`. It is planted under state (1) so a
 * build that falls back to the family label on an empty name ("GPT") fails.
 *
 * The whole file is the dark state, so it forces the flag off (#2449); no case
 * is skipped or conditioned on the literal. The lit twin is
 * `agent-label-surfaces-lit.test.ts`; the editor aria-label is
 * `agent-label-decoration-dark.test.ts`.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { _resetModelsStoreForTests } from "../../src/client/hooks/useModels.svelte.js";
import { CURRENT_SCHEMA_VERSION } from "../../src/client/hooks/useTandemSettings.js";
import { BYO_MODELS_ENABLED, TANDEM_SETTINGS_KEY } from "../../src/shared/constants.js";
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

vi.mock(import("../../src/shared/constants.js"), async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/shared/constants.js")>()),
  BYO_MODELS_ENABLED: false as typeof import("../../src/shared/constants.js").BYO_MODELS_ENABLED,
}));

function seedSettings(models: Array<Record<string, unknown>>, defaultModelId: string | null): void {
  localStorage.setItem(
    TANDEM_SETTINGS_KEY,
    JSON.stringify({ schemaVersion: CURRENT_SCHEMA_VERSION, models, defaultModelId }),
  );
}

const STATES = [
  {
    name: "(1) an openai 'My GPT' default",
    seed: () =>
      seedSettings(
        [{ id: "m1", provider: "openai", displayName: "My GPT", modelId: "gpt-4o", enabled: true }],
        "m1",
      ),
    family: "GPT",
    pill: "My GPT is editing…",
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
    pill: "Qwen is editing…",
  },
  { name: "(3) nothing", seed: () => {}, family: "Assistant", pill: "Assistant is editing…" },
] as const;

beforeEach(() => {
  localStorage.clear();
  _resetModelsStoreForTests();
});

describe("dark: the anchor", () => {
  it("the file-level mock applied, so every case below is dark", () => {
    expect(BYO_MODELS_ENABLED).toBe(false);
  });
});

for (const s of STATES) {
  describe(`dark, registry ${s.name}: master's labels (R3.1)`, () => {
    beforeEach(() => s.seed());

    it(`chat, reply and card bylines read "${s.family}"`, async () => {
      expect(await chatByline()).toBe(s.family);
      expect(await replyByline()).toBe(s.family);
      expect(cardAuthor()).toBe(s.family);
    });

    it(`card working indicator reads "${s.family} is working on this annotation"`, () => {
      expect(cardWorking()).toEqual({
        ariaLabel: `${s.family} is working on this annotation`,
        title: `${s.family} is working on this annotation`,
      });
    });

    it(`status pill reads "${s.pill}"`, () => {
      expect(statusPill()).toBe(s.pill);
    });

    it(`filter chip and summary read "${s.family}"; both agent comments stay listed`, async () => {
      const { chipName, summary, listed } = await commentFilter();
      expect(chipName).toBe(s.family);
      expect(summary).toContain(s.family);
      // R3.2: the summary must not read "AI" while dark (L3 is lit-only).
      expect(summary).not.toContain("AI");
      expect(listed).toEqual(["claude-1", "local-1"]);
    });

    it(`card and batch "Send to" read "${s.family}"`, () => {
      expect(cardSendTo()).toBe(`Send to ${s.family}`);
      expect(batchSendTo()).toEqual({
        request: `Send 2 to ${s.family}`,
        commit: `Send to ${s.family}`,
      });
    });
  });
}

describe("dark: a record stamped with an empty name (AL-7, no flag)", () => {
  it("chat, reply and card read 'Local model', not the family 'GPT' nor an empty byline", async () => {
    STATES[0].seed();
    const empty = { provider: "local-llamacpp" as const, displayName: "" };
    expect(await chatByline(empty)).toBe("Local model");
    expect(await replyByline(empty)).toBe("Local model");
    expect(cardAuthor(empty)).toBe("Local model");
  });
});
