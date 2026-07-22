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
});
