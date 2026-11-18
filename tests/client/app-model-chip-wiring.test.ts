import { describe, expect, it } from "vitest";
import { readAppSource } from "../helpers/app-source";

/**
 * App's derivation of the title bar's chip (#1123, ADR-039 Label decision L2),
 * pinned from source because nothing mounts App in tests. The decision itself
 * is `resolveDefaultModelChip` (model-chip.test.ts); these pins hold that App
 * feeds it the chat setting the status pill reads, the licence's AI-off state
 * from `aiReadiness`, and that both the prop and the chat setting stay null
 * while `BYO_MODELS_ENABLED` is off. The first-run window's mount is pinned in
 * model-first-run.test.ts, not here.
 */

const app = readAppSource();
const count = (re: RegExp) => app.match(new RegExp(re.source, "g"))?.length ?? 0;

describe("App's title-bar chip wiring (#1123 L2)", () => {
  it("derives the label once, from the chat setting and the loaded list", () => {
    expect(count(/resolveDefaultModelChip\(/)).toBe(1);
    expect(
      count(
        /const defaultModelLabel = \$derived\(\s*resolveDefaultModelChip\(\{\s*defaultModelId: modelsStore\.defaultModelId,\s*models: modelsStore\.models,\s*loaded: modelsStore\.loaded,\s*chatSetting: localChatSetting,\s*aiOff: aiReadiness\.aiNotice !== null,?\s*\}\),?\s*\);/,
      ),
    ).toBe(1);
  });

  it("passes the title bar no label while dark", () => {
    expect(count(/defaultModelLabel=\{BYO_MODELS_ENABLED \? defaultModelLabel : null\}/)).toBe(1);
  });

  it("the chat setting is the pill's, and null while dark", () => {
    expect(
      count(
        /const localChatSetting = \$derived\(\s*BYO_MODELS_ENABLED\s*\?\s*localChatSettingFor\(chatAnswerer, aiReadiness\.launcherHeldForLocalModel\)\s*:\s*null,?\s*\);/,
      ),
    ).toBe(1);
  });
});
