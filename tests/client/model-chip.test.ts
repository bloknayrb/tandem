import { describe, expect, it } from "vitest";
import {
  type ChipModelEntry,
  type DefaultModelChipInput,
  resolveDefaultModelChip,
} from "../../src/client/utils/model-chip";
import type { ModelProvider } from "../../src/shared/models/contract";

/**
 * The title bar's chip decision (#1123, ADR-039 Label decision L2: shown only
 * while chat is set to the local model). Flag-free: the function reads no flag.
 * Every fixture holds at least one enabled local entry, so a build that shows
 * "any enabled local model" fails each hidden row.
 */

const local = (id: string, displayName: string, provider: ModelProvider = "local-ollama") =>
  ({ id, displayName, provider, enabled: true }) satisfies ChipModelEntry;
const LOCAL = local("l1", "Qwen 2.5");
const CLOUD: ChipModelEntry = {
  id: "c1",
  displayName: "Opus",
  provider: "anthropic",
  enabled: true,
};
const OFF: ChipModelEntry = { ...local("off", "Llama off"), enabled: false };

/** Row 9's inputs: chat set to the local model, a loaded list, an enabled local Default. */
const SHOWN: DefaultModelChipInput = {
  defaultModelId: LOCAL.id,
  models: [LOCAL],
  loaded: true,
  chatSetting: "local",
  aiOff: false,
};

describe("resolveDefaultModelChip — hidden rows, each with a valid enabled local Default", () => {
  it("the row-9 baseline shows (so every hidden row below differs by one input)", () => {
    expect(resolveDefaultModelChip(SHOWN)).toBe("Qwen 2.5");
  });

  it("row 2: hidden while the licence refuses AI (CT-1)", () => {
    expect(resolveDefaultModelChip({ ...SHOWN, aiOff: true })).toBeNull();
  });

  it("row 3: hidden while chat is not set to the local model (L2)", () => {
    expect(resolveDefaultModelChip({ ...SHOWN, chatSetting: null })).toBeNull();
  });

  it('row 4: hidden while chat is set to the local model but none can be used ("unusable")', () => {
    expect(resolveDefaultModelChip({ ...SHOWN, chatSetting: "unusable" })).toBeNull();
  });

  it("row 5: hidden until the list has loaded", () => {
    expect(resolveDefaultModelChip({ ...SHOWN, loaded: false })).toBeNull();
  });
});

describe("resolveDefaultModelChip — the Default", () => {
  it("row 6: no Default, with one enabled local model: hidden", () => {
    expect(resolveDefaultModelChip({ ...SHOWN, defaultModelId: null })).toBeNull();
  });

  it("row 6: a Default naming no entry, with one enabled local model: hidden", () => {
    expect(resolveDefaultModelChip({ ...SHOWN, defaultModelId: "ghost" })).toBeNull();
  });

  it("row 7: a cloud Default beside an enabled local model: hidden (DD1)", () => {
    expect(
      resolveDefaultModelChip({ ...SHOWN, models: [CLOUD, LOCAL], defaultModelId: CLOUD.id }),
    ).toBeNull();
  });

  it("row 8: a switched-off Default beside an enabled local model: hidden (DD1)", () => {
    expect(
      resolveDefaultModelChip({ ...SHOWN, models: [LOCAL, OFF], defaultModelId: OFF.id }),
    ).toBeNull();
  });

  it("row 9: two enabled local models, the Default the second: names the second", () => {
    const second = local("l2", "Llama 3.1");
    expect(
      resolveDefaultModelChip({ ...SHOWN, models: [LOCAL, second], defaultModelId: second.id }),
    ).toBe("Llama 3.1");
  });

  for (const provider of [
    "local-ollama",
    "local-llamacpp",
    "local-lmstudio",
    "local-other",
  ] as const) {
    it(`row 9: shows for a ${provider} Default`, () => {
      const e = local("p", `Model ${provider}`, provider);
      expect(resolveDefaultModelChip({ ...SHOWN, models: [e], defaultModelId: e.id })).toBe(
        `Model ${provider}`,
      );
    });
  }
});

describe("resolveDefaultModelChip — the name (CT-2)", () => {
  const named = (displayName: string) =>
    resolveDefaultModelChip({ ...SHOWN, models: [{ ...LOCAL, displayName }] });

  it("trims the name", () => {
    expect(named("  Qwen  ")).toBe("Qwen");
  });

  it('a whitespace-only name reads "Local model"', () => {
    expect(named("   ")).toBe("Local model");
  });

  it('an empty name reads "Local model"', () => {
    expect(named("")).toBe("Local model");
  });
});
