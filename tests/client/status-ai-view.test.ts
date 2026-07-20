import { describe, expect, it } from "vitest";
import { aiIndicatorView } from "../../src/client/status/status-ai-view.js";

/**
 * Spec for the consolidated status-pill AI indicator. Each `it` is one row of
 * the plan's D1 state table. The two false-negatives the plan review caught
 * (ready-with-no-session, Solo-with-no-session) have dedicated cases — those
 * are the whole reason this logic is extracted and tested rather than inlined.
 */
describe("aiIndicatorView", () => {
  it("booting → nothing (never flash a state on boot)", () => {
    expect(aiIndicatorView("booting", null, false)).toBeNull();
    // booting outranks everything, even a (transiently) present liveIndicator
    expect(aiIndicatorView("booting", "connected", false)).toBeNull();
  });

  it("ready + connected (Tandem, session open) → AI connected, animatable", () => {
    const v = aiIndicatorView("ready", "connected", false);
    expect(v).toEqual({
      label: "AI connected",
      tone: "connected",
      dataState: "connected",
      canAnimate: true,
    });
  });

  it("ready + solo-paused (Solo, session open) → Solo · edits held, animatable", () => {
    const v = aiIndicatorView("ready", "solo-paused", true);
    expect(v).toEqual({
      label: "Solo · edits held",
      tone: "solo",
      dataState: "solo-paused",
      canAnimate: true,
    });
  });

  it("ready + no session (launcher running, startup window) → nothing (no false alarm)", () => {
    // The false-negative the reviewers caught: the launcher is truthfully
    // running, so we must NOT render "AI not connected" here.
    expect(aiIndicatorView("ready", null, false)).toBeNull();
    expect(aiIndicatorView("ready", null, true)).toBeNull();
  });

  it("unconfigured (Tandem) → AI not connected, never animates", () => {
    const v = aiIndicatorView("unconfigured", null, false);
    expect(v).toEqual({
      label: "AI not connected",
      tone: "not-connected",
      dataState: "not-connected",
      canAnimate: false,
    });
  });

  it("stopped (Tandem) → AI not connected", () => {
    expect(aiIndicatorView("stopped", null, false)?.dataState).toBe("not-connected");
  });

  it("unconfigured (Solo) → nothing (suppress the connect-nag in Solo)", () => {
    expect(aiIndicatorView("unconfigured", null, true)).toBeNull();
  });

  it("stopped (Solo) → nothing (suppress the connect-nag in Solo)", () => {
    expect(aiIndicatorView("stopped", null, true)).toBeNull();
  });

  it("a disconnected indicator never advertises canAnimate", () => {
    // Only live-session states may pulse; "not connected" must stay steady.
    expect(aiIndicatorView("unconfigured", null, false)?.canAnimate).toBe(false);
  });
});
