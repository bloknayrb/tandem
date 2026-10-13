import { describe, expect, it } from "vitest";
import {
  aiIndicatorView,
  cwdDriftPill,
  displayPath,
  sessionCountLabel,
  visibleLauncherFailure,
} from "../../src/client/status/status-ai-view.js";
import { TANDEM_PURCHASE_URL } from "../../src/shared/constants.js";

type ViewInput = Parameters<typeof aiIndicatorView>[0];

/** Defaults: Tandem mode, nothing attached, launcher not running, sync up. */
function view(over: Partial<ViewInput> = {}) {
  return aiIndicatorView({
    state: "ready",
    liveIndicator: null,
    soloMode: false,
    pushDelivery: "unknown",
    launcherRunning: false,
    launcherCwd: null,
    launcherBusy: false,
    launcherAttached: false,
    launcherRestarting: false,
    docSyncConnected: true,
    sessionCount: null,
    aiNotice: null,
    ...over,
  });
}

/**
 * Spec for the consolidated status-pill AI indicator. Each `it` is one row of
 * the state table. The pill says WHO is attached: "Tandem's Claude" when the
 * launcher runs (the one session the server knows it wakes), "AI attached" for
 * any other connection, and copy that claims only what each signal proves.
 */
describe("aiIndicatorView", () => {
  describe("restarting Tandem's Claude (#2180)", () => {
    it("shows 'Restarting Claude…' with no button and no pulse", () => {
      const v = view({ state: "stopped", launcherRestarting: true });
      expect(v?.label).toBe("Restarting Claude…");
      expect(v?.dataState).toBe("restarting");
      expect(v?.tone).toBe("pending");
      expect(v?.pulse).toBe(false);
    });

    it("outranks the dead child's own still-live session", () => {
      // Its MCP entry reads live for up to a minute after it exits; rule 3
      // would call that "AI attached" for the whole retry.
      const v = view({
        state: "ready",
        liveIndicator: "connected",
        sessionCount: 1,
        launcherRestarting: true,
      });
      expect(v?.dataState).toBe("restarting");
    });

    it("guard: yields to a running launcher and to Solo", () => {
      expect(view({ launcherRunning: true, launcherRestarting: true })?.dataState).toBe(
        "tandem-claude",
      );
      expect(view({ soloMode: true, launcherRestarting: true })).toBeNull();
    });
  });

  it("booting with NO session → nothing (never flash a negative state on boot)", () => {
    expect(view({ state: "booting" })).toBeNull();
  });

  it("booting WITH a live session → still shows it (proven fact outranks booting)", () => {
    // A real MCP session is proven-connected independent of doc-sync/launcher
    // state, so a doc-sync blip (which flips `state` to "booting") must NOT blank it.
    expect(view({ state: "booting", liveIndicator: "connected" })?.dataState).toBe("connected");
    expect(
      view({ state: "booting", liveIndicator: "solo-paused", soloMode: true })?.dataState,
    ).toBe("solo-paused");
  });

  it("ready + connected, no launcher → AI attached, animatable, claims only a connection", () => {
    const v = view({ liveIndicator: "connected" });
    expect(v).toMatchObject({
      label: "AI attached",
      tone: "connected",
      dataState: "connected",
      canAnimate: true,
      pulse: null,
      ownActivity: null,
    });
    // `liveIndicator` proves a completed `initialize` — nothing about identity
    // ("Claude", "you started"), tools, or delivery. Pinned, not just non-empty.
    expect(v?.title).toBe(
      "Something is connected to Tandem. Tandem can't tell whether it's being notified, so if it's a session you're using, it may only see your messages when it next checks in.",
    );
    for (const copy of [v?.title ?? "", v?.ariaLabel ?? ""]) {
      expect(copy).not.toMatch(/you started/i);
      expect(copy).not.toMatch(/can't wake/i);
      expect(copy).not.toMatch(/receiving/i);
    }
  });

  it("ready + solo-paused (Solo, session open) → Solo · comments held, has a11y copy", () => {
    const v = view({ liveIndicator: "solo-paused", soloMode: true });
    expect(v).toMatchObject({
      label: "Solo · comments held",
      tone: "solo",
      dataState: "solo-paused",
      canAnimate: true,
      pulse: null,
    });
    // #1287: promise only what Solo delivers — comments/replies withheld from
    // forwarding — not "edits", which Claude can still read on request.
    expect(v?.ariaLabel).toMatch(/comments and replies aren't forwarded/i);
    expect(v?.ariaLabel).not.toMatch(/edits/i);
  });

  it("unconfigured (Tandem) → AI not connected, never animates", () => {
    expect(view({ state: "unconfigured" })).toMatchObject({
      label: "AI not connected",
      tone: "not-connected",
      dataState: "not-connected",
      canAnimate: false,
      pulse: null,
    });
  });

  it("stopped (Tandem) → AI not connected", () => {
    expect(view({ state: "stopped" })?.dataState).toBe("not-connected");
  });

  it("unconfigured / stopped (Solo) → nothing (suppress the connect-nag in Solo)", () => {
    expect(view({ state: "unconfigured", soloMode: true })).toBeNull();
    expect(view({ state: "stopped", soloMode: true })).toBeNull();
  });

  it("ready with nothing attached and no launcher → nothing (defensive)", () => {
    expect(view()).toBeNull();
  });
});

/**
 * Tandem's own launched Claude. The one tier whose wake claim the server can
 * back: the supervisor writes a turn to the child's stdin.
 */
describe("aiIndicatorView — Tandem's Claude", () => {
  const running = { launcherRunning: true, launcherCwd: "/home/ana/notes" } as const;

  it("running + matched to its own connection → connected tone, wake claim, folder home-shortened", () => {
    const v = view({ ...running, liveIndicator: "connected", launcherAttached: true });
    expect(v).toMatchObject({
      label: "Tandem's Claude",
      tone: "connected",
      dataState: "tandem-claude",
      pulse: false,
      ownActivity: null,
    });
    expect(v?.title).toBe(
      "Tandem's Claude is running in ~/notes. Tandem wakes it when you send a message.",
    );
    // No reply/latency promise: the attached session may not be this child.
    expect(v?.title).not.toMatch(/reply|minute/i);
  });

  // Bryan: "i do want the colors to be honest". A session that may be some
  // other client says nothing about this child, so the dot stays neutral.
  it("running + an unattributed session → pending tone, says it can't confirm which", () => {
    const v = view({ ...running, liveIndicator: "connected" });
    expect(v).toMatchObject({ label: "Tandem's Claude", tone: "pending", canAnimate: false });
    expect(v?.title).toBe(
      "Tandem's Claude is running in ~/notes. Tandem wakes it when you send a message. Tandem can't confirm that any connection is this Claude.",
    );
  });

  it("a match on the launcher read counts as seen before /health catches up", () => {
    const v = view({ ...running, launcherAttached: true });
    expect(v?.tone).toBe("connected");
    expect(v?.title).not.toContain("hasn't seen it connect");
  });

  it("running with no session → pending tone, no wake claim, 'hasn't seen it connect'", () => {
    const v = view({ ...running });
    expect(v).toMatchObject({ label: "Tandem's Claude", tone: "pending", canAnimate: false });
    expect(v?.title).toBe("Tandem's Claude is running in ~/notes; Tandem hasn't seen it connect.");
    // "seen", never "connected yet": under #1249 a working stateless child
    // never sets hasSession, so the copy must stay true there.
    expect(v?.title).not.toMatch(/wakes|yet/);
  });

  it("outranks booting, like a live session does", () => {
    expect(view({ ...running, state: "booting" })?.dataState).toBe("tandem-claude");
  });

  it("outranks the 'AI attached' tier and ignores push state", () => {
    const v = view({ ...running, liveIndicator: "connected", pushDelivery: "none" });
    expect(v?.dataState).toBe("tandem-claude");
  });

  it("busy → ownActivity 'working', pulse true, and the wait is on the wake", () => {
    const v = view({ ...running, liveIndicator: "connected", launcherBusy: true });
    expect(v).toMatchObject({ pulse: true, ownActivity: "working" });
    expect(v?.title).toContain("in the middle of a turn");
    expect(v?.title).toContain("if it hasn't picked up your message already");
  });

  it("not busy → pulse is false, not null, so presence activity can't pulse it", () => {
    expect(view({ ...running, liveIndicator: "connected" })?.pulse).toBe(false);
  });

  it("busy with no session seen → working, still no wake claim", () => {
    const v = view({ ...running, launcherBusy: true });
    expect(v?.ownActivity).toBe("working");
    expect(v?.title).toBe(
      "Tandem's Claude is running in ~/notes and working on a turn; Tandem hasn't seen it connect.",
    );
  });

  it("doc sync down → says what you send won't reach it, drops the wake claim", () => {
    const v = view({ ...running, liveIndicator: "connected", docSyncConnected: false });
    expect(v?.title).toContain("Document sync is down");
    expect(v?.title).not.toContain("wakes it");
  });

  it("drops the folder clause when the cwd is unknown", () => {
    const v = view({ launcherRunning: true, liveIndicator: "connected", launcherAttached: true });
    expect(v?.title).toBe("Tandem's Claude is running. Tandem wakes it when you send a message.");
  });
});

/**
 * Rule 0 (#1521): the licence refusal, keyed on `aiNotice` — readiness's own
 * value, non-null exactly when its chip is `"unlicensed"`, so label and action
 * agree. The kind also picks the copy.
 */
describe("aiIndicatorView — AI off by licence", () => {
  it("beats Solo, a running Tandem's Claude and a connected session", () => {
    for (const over of [
      { liveIndicator: "solo-paused" as const, soloMode: true },
      { launcherRunning: true, launcherAttached: true, liveIndicator: "connected" as const },
      { liveIndicator: "connected" as const, sessionCount: 1 },
    ]) {
      const v = view({ ...over, aiNotice: "unlicensed" });
      expect(v?.dataState).toBe("ai-off");
      expect(v?.label).toBe("AI off");
      expect(v?.canAnimate).toBe(false);
    }
  });

  it("suppresses the session count — a refused handshake leaves at most a leftover", () => {
    const v = view({ liveIndicator: "connected", sessionCount: 3, aiNotice: "unverifiable" });
    expect(v?.sessionCount).toBeNull();
    expect(v?.title).not.toMatch(/sessions? (is|are) connected/);
  });

  it("the twin: no refusal keeps the existing view", () => {
    expect(view({ liveIndicator: "connected", sessionCount: 1 })?.dataState).toBe("connected");
    expect(view({ liveIndicator: "solo-paused", soloMode: true })?.dataState).toBe("solo-paused");
  });

  it("unverifiable copy never says unlicensed, Activate a license, or the purchase URL", () => {
    const v = view({ aiNotice: "unverifiable" });
    for (const text of [v?.title ?? "", v?.ariaLabel ?? ""]) {
      expect(text).not.toMatch(/unlicensed/i);
      expect(text).not.toContain("Activate a license");
      expect(text).not.toContain(TANDEM_PURCHASE_URL);
    }
    expect(view({ aiNotice: "unlicensed" })?.title).toContain("unlicensed");
  });
});

describe("aiIndicatorView — session count", () => {
  it("adds the count to the view, title and screen-reader label", () => {
    const v = view({ liveIndicator: "connected", sessionCount: 3 });
    expect(v?.sessionCount).toBe(3);
    expect(v?.title).toContain("3 sessions are connected to Tandem");
    expect(v?.ariaLabel).toContain("3 sessions are connected to Tandem");
    // The main overcount is named where the number is.
    expect(v?.title).toContain("One that just closed can still count for about a minute");
    expect(v?.title).toContain("a frozen one until it closes");
  });

  it("uses the singular for one", () => {
    expect(view({ liveIndicator: "connected", sessionCount: 1 })?.title).toContain(
      "1 session is connected to Tandem",
    );
  });

  it("shows on Tandem's Claude and in Solo too", () => {
    expect(view({ launcherRunning: true, sessionCount: 2 })?.sessionCount).toBe(2);
    expect(
      view({ liveIndicator: "solo-paused", soloMode: true, sessionCount: 2 })?.sessionCount,
    ).toBe(2);
  });

  it("shows nothing at zero, when unknown, or on 'AI not connected'", () => {
    expect(view({ launcherRunning: true, sessionCount: 0 })?.sessionCount).toBeNull();
    expect(view({ launcherRunning: true, sessionCount: null })?.sessionCount).toBeNull();
    const down = view({ state: "stopped", sessionCount: 2 });
    expect(down?.dataState).toBe("not-connected");
    expect(down?.sessionCount).toBeNull();
    expect(down?.title).not.toContain("session");
  });
});

describe("aiIndicatorView — leftover sessions", () => {
  it("a session with none live → hollow 'AI attached', says it may have closed", () => {
    const v = view({ liveIndicator: "connected", sessionCount: 0 });
    expect(v).toMatchObject({
      label: "AI attached",
      tone: "pending",
      dataState: "connected-stale",
      canAnimate: false,
      pulse: false,
      sessionCount: null,
    });
    expect(v?.title).toContain("can't see that it's still there");
  });

  it("is stale even when push is confirmed absent", () => {
    expect(
      view({ liveIndicator: "connected", sessionCount: 0, pushDelivery: "none" })?.dataState,
    ).toBe("connected-stale");
  });

  // With nothing live the pill is the setup/restart button, whose hover and
  // screen-reader text say no AI is connected; the label must agree.
  it("says 'AI not connected' when a setup or restart remedy is up", () => {
    for (const state of ["stopped", "unconfigured"] as const) {
      const v = view({ state, liveIndicator: "connected", sessionCount: 0 });
      expect(v?.dataState).toBe("not-connected");
      expect(v?.label).toBe("AI not connected");
    }
  });

  it("an unreported count trusts hasSession and stays green", () => {
    expect(view({ liveIndicator: "connected", sessionCount: null })?.tone).toBe("connected");
  });

  it("a leftover is not a sighting of Tandem's Claude", () => {
    const v = view({ launcherRunning: true, liveIndicator: "connected", sessionCount: 0 });
    expect(v?.title).toContain("hasn't seen it connect");
  });
});

describe("sessionCountLabel", () => {
  it("pluralises", () => {
    expect(sessionCountLabel(1)).toBe("1 session");
    expect(sessionCountLabel(2)).toBe("2 sessions");
  });
});

describe("aiIndicatorView — Solo with Tandem's Claude", () => {
  it("running, no session → the Solo pill, quiet, with no chat-reaches-it claim", () => {
    const v = view({ soloMode: true, launcherRunning: true });
    expect(v).toMatchObject({
      label: "Solo · comments held",
      dataState: "solo-paused",
      canAnimate: false,
      pulse: false,
      ownActivity: null,
    });
    expect(v?.title).toContain("hasn't seen it connect");
    expect(v?.title).not.toMatch(/chat still/i);
    expect(v?.ariaLabel).not.toMatch(/is connected/i);
  });

  it("running + a session → the Solo pill, but presence activity stays suppressed", () => {
    // Toggling Tandem→Solo must not bring back activity it hid in Tandem mode.
    const v = view({ soloMode: true, liveIndicator: "solo-paused", launcherRunning: true });
    expect(v).toMatchObject({ dataState: "solo-paused", pulse: false });
  });

  it("ignores busy in Solo", () => {
    const v = view({ soloMode: true, launcherRunning: true, launcherBusy: true });
    expect(v?.ownActivity).toBeNull();
  });
});

/**
 * The connected-but-not-notified variant. Same label and tone — something
 * really is attached — so the fix is in what the hover text ADMITS.
 */
describe("aiIndicatorView — push delivery", () => {
  it("names the delivery gap when nothing is attached", () => {
    const v = view({ liveIndicator: "connected", pushDelivery: "none" });
    expect(v?.title).toContain("nothing is notifying it");
    expect(v?.ariaLabel).toContain("nothing is notifying it");
  });

  it("keeps the label and tone identical — this is not a fault state", () => {
    const plain = view({ liveIndicator: "connected", pushDelivery: "attached" });
    const noPush = view({ liveIndicator: "connected", pushDelivery: "none" });
    expect(noPush?.label).toBe(plain?.label);
    expect(noPush?.tone).toBe(plain?.tone);
    expect(noPush?.dataState).toBe(plain?.dataState);
    expect(noPush?.canAnimate).toBe(plain?.canAnimate);
  });

  it("stays quiet about delivery when a consumer IS attached or the state is unknown", () => {
    // A positive count includes an attached-but-inert consumer, and an unknown
    // one was never read — neither is evidence of a gap.
    for (const pushDelivery of ["attached", "unknown"] as const) {
      expect(view({ liveIndicator: "connected", pushDelivery })?.title).not.toContain(
        "nothing is notifying",
      );
    }
  });

  it("does not fold the delivery gap into Solo", () => {
    const v = view({ liveIndicator: "solo-paused", soloMode: true, pushDelivery: "none" });
    expect(v?.dataState).toBe("solo-paused");
    expect(v?.title).toContain("Solo mode");
  });
});

describe("displayPath", () => {
  it("collapses the three conventional home layouts to ~", () => {
    expect(displayPath("C:\\Users\\ana\\notes")).toBe("~\\notes");
    expect(displayPath("C:\\Users\\ana")).toBe("~");
    expect(displayPath("/home/ana/notes")).toBe("~/notes");
    expect(displayPath("/Users/ana")).toBe("~");
  });

  it("matches Windows homes in any case and behind an extended-length prefix", () => {
    expect(displayPath("c:\\users\\ana\\notes")).toBe("~\\notes");
    expect(displayPath("\\\\?\\C:\\Users\\ana\\notes")).toBe("~\\notes");
  });

  it("leaves other paths alone, including a lookalike prefix", () => {
    expect(displayPath("D:\\work\\notes")).toBe("D:\\work\\notes");
    expect(displayPath("/srv/notes")).toBe("/srv/notes");
    expect(displayPath("/homes/ana")).toBe("/homes/ana");
  });
});

/**
 * The working-folder drift qualifier (#1282). It describes the folder, not the
 * connection, and must yield to any stopped-launcher CTA rather than sit beside it.
 */
describe("cwdDriftPill", () => {
  const DRIFT = {
    suggestedCwd: "~/projects/alpha",
    claudeCwd: "~/notes",
    label: "alpha",
    claudeLabel: "notes",
  };

  it("renders when nothing else objects", () => {
    expect(cwdDriftPill(DRIFT, null, null, false)?.label).toBe("Claude in notes");
  });

  it("yields to a CTA rather than sitting next to one", () => {
    // `aiChip` is non-null only when the supervised launcher is NOT running —
    // and the server reports drift only when it is. Overlap is staleness, and a
    // stale folder note beside a live "Restart Claude Code" is #1268's shape.
    for (const chip of ["connect", "setup", "restart"] as const) {
      expect(cwdDriftPill(DRIFT, chip, null, false)).toBeNull();
    }
  });

  it("yields to the 'Tandem's Claude isn't running' button too", () => {
    // `useCwdDrift` does not poll, so a drift answer from before an unattended
    // trip stays live while `aiChip` is null (another session is attached).
    for (const failure of ["restart", "sign-in", "setup"] as const) {
      expect(cwdDriftPill(DRIFT, null, failure, false)).toBeNull();
    }
  });

  it("yields while Tandem restarts its Claude (#2180)", () => {
    // During a restart neither CTA shows, so nothing else would hide a drift
    // answer from before the crash.
    expect(cwdDriftPill(DRIFT, null, null, true)).toBeNull();
  });

  it("says nothing when there is no drift", () => {
    expect(cwdDriftPill(null, null, null, false)).toBeNull();
  });

  it("names the consequence rather than a connection state", () => {
    const pill = cwdDriftPill(DRIFT, null, null, false);
    expect(pill?.title).toContain("CLAUDE.md");
    expect(pill?.title).toContain("git history");
    expect(pill?.title).toContain("read and edit this document");
  });

  it("carries both full paths in the aria-label, not only the title", () => {
    // `title` is unreachable by keyboard, touch and assistive tech.
    const pill = cwdDriftPill(DRIFT, null, null, false);
    expect(pill?.ariaLabel).toContain(DRIFT.claudeCwd);
    expect(pill?.ariaLabel).toContain(DRIFT.suggestedCwd);
  });

  it("names the destination folder in the action row", () => {
    expect(cwdDriftPill(DRIFT, null, null, false)?.actionLabel).toBe("Restart Claude in alpha…");
  });
});

describe("visibleLauncherFailure", () => {
  const dismissedRestart = { failure: "restart" as const, epoch: 3 };

  it("shows an undismissed failure", () => {
    expect(visibleLauncherFailure("restart", null, 3)).toBe("restart");
  });

  it("hides the dismissed failure while Tandem's Claude has not run since", () => {
    expect(visibleLauncherFailure("restart", dismissedRestart, 3)).toBeNull();
  });

  it("re-shows the same failure once Tandem's Claude has run again in between", () => {
    // Trip → dismiss → relaunch works (epoch moves) → trips again: a second outage.
    expect(visibleLauncherFailure("restart", dismissedRestart, 4)).toBe("restart");
  });

  it("re-shows when a different failure appears", () => {
    expect(visibleLauncherFailure("sign-in", dismissedRestart, 3)).toBe("sign-in");
  });

  it("shows nothing with no failure", () => {
    expect(visibleLauncherFailure(null, dismissedRestart, 3)).toBeNull();
    expect(visibleLauncherFailure(null, null, 3)).toBeNull();
  });
});
