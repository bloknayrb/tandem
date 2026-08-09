import { describe, expect, it } from "vitest";
import { aiIndicatorView, cwdDriftPill } from "../../src/client/status/status-ai-view.js";

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

  it("ready + solo-paused (Solo, session open) → Solo · comments held, animatable, has a11y copy", () => {
    const v = aiIndicatorView("ready", "solo-paused", true);
    expect(v).toMatchObject({
      label: "Solo · comments held",
      tone: "solo",
      dataState: "solo-paused",
      canAnimate: true,
    });
    // The visible label is terse — the aria-label must explain what "held" means.
    // #1287: it must promise only what Solo delivers — comments/replies withheld
    // from forwarding — not "edits", which Claude can still read on request.
    expect(v?.ariaLabel).toMatch(/comments and replies aren't forwarded/i);
    expect(v?.ariaLabel).not.toMatch(/edits/i);
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

/**
 * The connected-but-not-notified variant.
 *
 * The pill saying a bare "AI connected" is what makes a delayed comment read as
 * a bug: the user is told the AI is right there, then watches nothing happen.
 * The pill is not wrong — Claude really is attached and really can read the
 * document — so the fix is in what the hover text ADMITS, not in the label or
 * the colour.
 */
describe("aiIndicatorView — push delivery", () => {
  it("names the delivery gap when nothing is attached", () => {
    const view = aiIndicatorView("ready", "connected", false, "none");
    expect(view?.title).toContain("nothing is notifying it in real time");
    expect(view?.ariaLabel).toContain("not notified in real time");
  });

  it("keeps the label and tone identical — this is not a fault state", () => {
    const plain = aiIndicatorView("ready", "connected", false, "attached");
    const noPush = aiIndicatorView("ready", "connected", false, "none");
    expect(noPush?.label).toBe(plain?.label);
    expect(noPush?.tone).toBe(plain?.tone);
    expect(noPush?.dataState).toBe(plain?.dataState);
    expect(noPush?.canAnimate).toBe(plain?.canAnimate);
  });

  it("stays quiet about delivery when a consumer IS attached", () => {
    // A positive count includes an attached-but-inert consumer, so it cannot
    // prove delivery — but it is also not evidence of a gap, so say nothing.
    const view = aiIndicatorView("ready", "connected", false, "attached");
    expect(view?.title).not.toContain("nothing is notifying");
  });

  it("stays quiet when the push state is unknown", () => {
    // Redacted or not yet polled. Claiming a gap here would alarm a working
    // user on the strength of a field we never read.
    const view = aiIndicatorView("ready", "connected", false, "unknown");
    expect(view?.title).not.toContain("nothing is notifying");
  });

  it("defaults to quiet when no push state is passed at all", () => {
    const view = aiIndicatorView("ready", "connected", false);
    expect(view?.title).not.toContain("nothing is notifying");
  });

  it("does not fold the delivery gap into Solo", () => {
    // Solo already says the AI won't see edits, which is stronger and more
    // relevant than "nothing is delivering them".
    const view = aiIndicatorView("ready", "solo-paused", true, "none");
    expect(view?.dataState).toBe("solo-paused");
    expect(view?.title).toContain("Solo mode");
  });
});

/**
 * The working-folder drift qualifier (#1282).
 *
 * The two cases worth pinning are structural, not cosmetic: the pill must
 * survive the state where `aiIndicatorView` renders nothing (or it is dead code
 * in exactly the situation it exists for), and it must yield to a CTA rather
 * than sit beside one.
 */
describe("cwdDriftPill", () => {
  const DRIFT = {
    suggestedCwd: "~/projects/alpha",
    claudeCwd: "~/notes",
    label: "alpha",
    claudeLabel: "notes",
  };

  it("renders in the state where the AI indicator renders nothing", () => {
    // `state === "ready"` with no live session is the auto-launched desktop
    // startup window: the launcher IS running (so it has a folder to be wrong
    // about) but no agent has connected. `aiIndicatorView` returns null there,
    // so anything nested inside `{#if aiView}` would never appear — which is why
    // this is a sibling.
    expect(aiIndicatorView("ready", null, false)).toBeNull();
    expect(cwdDriftPill(DRIFT, null)).not.toBeNull();
  });

  it("renders alongside a connected session", () => {
    expect(cwdDriftPill(DRIFT, null)?.label).toBe("Claude in notes");
  });

  it("yields to a CTA rather than sitting next to one", () => {
    // `aiChip` is non-null only for `unconfigured`/`stopped`, which mean the
    // supervised launcher is NOT running — and the server reports drift only
    // when it is. They can overlap only transiently, when Claude dies between a
    // drift probe and the next readiness poll, and a stale folder note beside a
    // live "Restart Claude Code" is the two-conflicting-CTAs shape of #1268.
    for (const chip of ["connect", "setup", "restart"] as const) {
      expect(cwdDriftPill(DRIFT, chip)).toBeNull();
    }
  });

  it("says nothing when there is no drift", () => {
    expect(cwdDriftPill(null, null)).toBeNull();
  });

  it("names the consequence rather than a connection state", () => {
    // "AI · other folder" reads as connectivity and leaves the user with no idea
    // what is degraded. The document syncs fine and Claude can still edit it;
    // what it cannot see is everything around the document.
    const pill = cwdDriftPill(DRIFT, null);
    expect(pill?.title).toContain("CLAUDE.md");
    expect(pill?.title).toContain("git history");
    expect(pill?.title).toContain("read and edit this document");
  });

  it("carries both full paths in the aria-label, not only the title", () => {
    // `title` is unreachable by keyboard, touch and assistive tech, so the label
    // is the only place a screen-reader user learns which folders are meant.
    const pill = cwdDriftPill(DRIFT, null);
    expect(pill?.ariaLabel).toContain(DRIFT.claudeCwd);
    expect(pill?.ariaLabel).toContain(DRIFT.suggestedCwd);
  });

  it("names the destination folder in the action row", () => {
    expect(cwdDriftPill(DRIFT, null)?.actionLabel).toBe("Restart Claude in alpha…");
  });
});
