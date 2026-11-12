import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  type ModelFirstRunInput,
  resolveModelFirstRunNeeded,
} from "../../src/client/utils/model-first-run";

// A configured, past-first-run baseline: nothing should show.
function base(overrides: Partial<ModelFirstRunInput> = {}): ModelFirstRunInput {
  return {
    wizardShowing: false,
    hasConfiguredDefault: false,
    dismissed: false,
    loading: false,
    pageCannotChangeModels: false,
    ...overrides,
  };
}

describe("resolveModelFirstRunNeeded (#1123 M4 first-run decouple)", () => {
  it("shows on a fresh BYO-on launch with no default configured", () => {
    expect(resolveModelFirstRunNeeded(base())).toBe(true);
  });

  // Edge (a): a user with no/completed tutorial still sees the picker. The
  // predicate's input type has NO tutorial field (the structural decoupling),
  // so there is no tutorial state that could gate it off — the fresh-launch
  // case shows `true` with no tutorial involved at all.
  it("edge (a): shows without any tutorial input in the signal", () => {
    expect(resolveModelFirstRunNeeded(base())).toBe(true);
  });

  // Edge (b): a persisted dismissal suppresses the picker on a later launch,
  // so a tutorial replay (which no longer feeds this signal) can't re-summon it.
  it("edge (b): a persisted dismissal keeps it hidden", () => {
    expect(resolveModelFirstRunNeeded(base({ dismissed: true }))).toBe(false);
  });

  it("hides once a default is configured", () => {
    expect(resolveModelFirstRunNeeded(base({ hasConfiguredDefault: true }))).toBe(false);
  });

  it("hides while the integration wizard is showing (precedence)", () => {
    expect(resolveModelFirstRunNeeded(base({ wizardShowing: true }))).toBe(false);
  });

  it("hides while the registry is still loading (no flash before settle)", () => {
    expect(resolveModelFirstRunNeeded(base({ loading: true }))).toBe(false);
  });

  // The dark gate lives at the call site (`BYO_MODELS_ENABLED && …`), not in this
  // predicate — matching `resolveDefaultModelChip`. So there is no `byoEnabled`
  // input to test here; the App.svelte conjunct is what keeps the picker dark.

  // #2404: a page that is not Tandem's own window cannot save a model, so the
  // picker never opens there; the Models tab says where to go instead.
  it("never opens on a page that cannot change the models", () => {
    expect(resolveModelFirstRunNeeded(base({ pageCannotChangeModels: true }))).toBe(false);
  });
});

// Nothing mounts App.svelte in tests, so the wiring of that input is pinned
// from source: the picker's decision is fed the page's OWN origin verdict, which
// is fixed for a page load. It must not be fed the refusal latch — that would
// unmount an open picker in the same flush as the refusal it should explain.
describe("App.svelte feeds the picker the page's own-window verdict (#2404)", () => {
  const app = readFileSync(
    join(import.meta.dirname, "..", "..", "src", "client", "App.svelte"),
    "utf8",
  );

  it("pageCannotChangeModels is the page-origin classification, not the latch", () => {
    expect(app).toMatch(/pageCannotChangeModels:\s*modelsPageAccess\(\)\s*===\s*"foreign"/);
    expect(app).not.toMatch(/pageCannotChangeModels:[^\n]*blocked/);
  });
});
