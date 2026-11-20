import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  FIRST_LOCAL_MODEL_TOAST_TEXT,
  USE_IT_FOR_CHAT_LABEL,
} from "../../src/client/hooks/useChatAnswerer.svelte.js";
import { RUN_FAILURE_TEXT } from "../../src/server/local-model/collaborator.js";
import { LOCAL_PERIOD_STATUS_LINE } from "../../src/server/mcp/awareness.js";
import { ANSWERER_LOCAL_NOTICE } from "../../src/server/models/chat-answerer.js";
import * as copies from "../e2e/local-model-strings.js";

/**
 * The local-model E2E specs take their expected words from
 * `tests/e2e/local-model-strings.ts` (#1123 PR 8a). Those specs run in `check`'s
 * E2E now that local models are on, but a reworded string would then fail there
 * as an E2E timeout far from its cause. This file is flag-neutral and runs in
 * vitest: each copy
 * must equal its source. Constants are imported; the two that live only inside
 * a component's markup or script are read from the `.svelte` source text.
 */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const read = (rel: string) => readFileSync(path.join(ROOT, rel), "utf-8");

describe("tests/e2e/local-model-strings.ts matches its sources", () => {
  it("copies of exported constants equal their sources", () => {
    expect(copies.FIRST_LOCAL_MODEL_TOAST_TEXT).toBe(FIRST_LOCAL_MODEL_TOAST_TEXT);
    expect(copies.USE_IT_FOR_CHAT_LABEL).toBe(USE_IT_FOR_CHAT_LABEL);
    expect(copies.ANSWERER_LOCAL_NOTICE).toBe(ANSWERER_LOCAL_NOTICE);
    expect(copies.LOCAL_PERIOD_STATUS_LINE).toBe(LOCAL_PERIOD_STATUS_LINE);
    expect(copies.RUN_FAILURE_NOT_FOUND).toBe(RUN_FAILURE_TEXT["not-found"]);
  });

  it("Save's in-flight label is the add-model window's", () => {
    const src = read("src/client/components/ModelEditModal.svelte");
    expect(src).toContain(
      `{saving ? ${JSON.stringify(copies.SAVING_LABEL)} : isEditing ? "Save changes" : "Add model"}`,
    );
  });

  it("the add-model window's unavailable view says what the specs expect", () => {
    const src = read("src/client/components/ModelEditModal.svelte");
    expect(src).toContain(
      `const UNAVAILABLE_TITLE = ${JSON.stringify(copies.MODEL_UNAVAILABLE_TITLE)};`,
    );
    expect(src).toContain(
      `const UNAVAILABLE_TEXT = ${JSON.stringify(copies.MODEL_UNAVAILABLE_TEXT)};`,
    );
  });

  it("the Models tab says what the specs expect", () => {
    const src = read("src/client/components/settings-tabs/SettingsModelsTab.svelte");
    // The old cloud row's sentence, as markup text.
    expect(src).toContain(`>\n                        ${copies.MODEL_UNAVAILABLE_TEXT}\n`);
    expect(src).toContain(`lines.push(${JSON.stringify(copies.CHAT_ANSWERER_CLAUDE_STATUS)});`);
    // DD1's line: the template the tab builds, and its "cloud" arm.
    expect(src).toContain(
      "const line = `Your Default model${name} ${why}, so your local models won't answer chat.`;",
    );
    expect(src).toContain('const why = def.enabled ? "is a cloud model" : "is switched off";');
    expect(src).toContain(
      'const name = def.displayName.trim() === "" ? "" : `, ${def.displayName},`;',
    );
    expect(copies.defaultIsCloudLine("X")).toBe(
      "Your Default model, X, is a cloud model, so your local models won't answer chat.",
    );
  });
});
