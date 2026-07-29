import { describe, expect, it } from "vitest";
import { aiIndicatorView } from "../../src/client/status/status-ai-view.js";

/**
 * Spec for the consolidated status-pill AI indicator. Each `it` is one row of
 * the plan's D1 state table. The two false-negatives the plan review caught
 * (ready-with-no-session, Solo-with-no-session) have dedicated cases — those
 * are the whole reason this logic is extracted and tested rather than inlined.
 */
describe("aiIndicatorView", () => {
  it("booting with NO session → nothing (never flash a negative state on boot)", () => {
    expect(aiIndicatorView("booting", null, false)).toBeNull();
  });

  it("booting WITH a live session → still shows connected (proven fact outranks booting)", () => {
    // Regression guard: a real MCP session is proven-connected independent of
    // doc-sync/launcher state, so a doc-sync blip (which flips `state` to
    // "booting") must NOT blank a genuinely-connected AI. The old titlebar pill
    // rendered purely off liveIndicator; this preserves that.
    expect(aiIndicatorView("booting", "connected", false)?.dataState).toBe("connected");
    expect(aiIndicatorView("booting", "solo-paused", true)?.dataState).toBe("solo-paused");
  });

  it("ready + connected (Tandem, session open) → AI connected, animatable, has a11y copy", () => {
    const v = aiIndicatorView("ready", "connected", false);
    expect(v).toMatchObject({
      label: "AI connected",
      tone: "connected",
      dataState: "connected",
      canAnimate: true,
    });
    // Pinned, not just non-empty. `toBeTruthy()` meant this copy had never been
    // specified by any test — which is how it kept claiming the push path.
    //
    // The indicator is driven by `liveIndicator`, i.e. "an MCP session exists".
    // That proves Claude can READ the document; it proves nothing about whether
    // Claude is NOTIFIED when the user comments, which travels a structurally
    // separate connection the pill has no signal for. Copy here must not assert
    // the second thing.
    expect(v?.title).toBe("Claude is connected and can read your document");
    expect(v?.ariaLabel).toBe("Claude is connected and can read your document");
    for (const copy of [v?.title ?? "", v?.ariaLabel ?? ""]) {
      expect(copy).not.toMatch(/receiving/i);
      expect(copy).not.toMatch(/comments/i);
    }
  });

  it("ready + solo-paused (Solo, session open) → Solo · edits held, animatable, has a11y copy", () => {
    const v = aiIndicatorView("ready", "solo-paused", true);
    expect(v).toMatchObject({
      label: "Solo · edits held",
      tone: "solo",
      dataState: "solo-paused",
      canAnimate: true,
    });
    // The visible label is terse — the aria-label must explain what "held" means.
    expect(v?.ariaLabel).toMatch(/won't see your edits/i);
  });

  it("ready + no session (launcher running, startup window) → nothing (no false alarm)", () => {
    // The false-negative the reviewers caught: the launcher is truthfully
    // running, so we must NOT render "AI not connected" here.
    expect(aiIndicatorView("ready", null, false)).toBeNull();
    expect(aiIndicatorView("ready", null, true)).toBeNull();
  });

  it("unconfigured (Tandem) → AI not connected, never animates", () => {
    const v = aiIndicatorView("unconfigured", null, false);
    expect(v).toMatchObject({
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
