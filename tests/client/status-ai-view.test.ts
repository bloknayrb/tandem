import { describe, expect, it } from "vitest";
import {
  aiIndicatorView,
  cwdDriftPill,
  displayPath,
  visibleLauncherFailure,
} from "../../src/client/status/status-ai-view.js";

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
    launcherFailure: null,
    docSyncConnected: true,
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

  it("names a possible leftover connection while Tandem's Claude has tripped", () => {
    const v = view({ liveIndicator: "connected", launcherFailure: "restart" });
    expect(v?.title).toContain("leftover connection");
    expect(v?.ariaLabel).toContain("leftover connection");
    expect(view({ liveIndicator: "connected" })?.title).not.toContain("leftover");
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

  it("running + a session → connected tone, wake claim, folder shown home-shortened", () => {
    const v = view({ ...running, liveIndicator: "connected" });
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
    const v = view({ launcherRunning: true, liveIndicator: "connected" });
    expect(v?.title).toBe("Tandem's Claude is running. Tandem wakes it when you send a message.");
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
    expect(cwdDriftPill(DRIFT, null, null)?.label).toBe("Claude in notes");
  });

  it("yields to a CTA rather than sitting next to one", () => {
    // `aiChip` is non-null only when the supervised launcher is NOT running —
    // and the server reports drift only when it is. Overlap is staleness, and a
    // stale folder note beside a live "Restart Claude Code" is #1268's shape.
    for (const chip of ["connect", "setup", "restart"] as const) {
      expect(cwdDriftPill(DRIFT, chip, null)).toBeNull();
    }
  });

  it("yields to the 'Tandem's Claude isn't running' button too", () => {
    // `useCwdDrift` does not poll, so a drift answer from before an unattended
    // trip stays live while `aiChip` is null (another session is attached).
    for (const failure of ["restart", "sign-in", "setup"] as const) {
      expect(cwdDriftPill(DRIFT, null, failure)).toBeNull();
    }
  });

  it("says nothing when there is no drift", () => {
    expect(cwdDriftPill(null, null, null)).toBeNull();
  });

  it("names the consequence rather than a connection state", () => {
    const pill = cwdDriftPill(DRIFT, null, null);
    expect(pill?.title).toContain("CLAUDE.md");
    expect(pill?.title).toContain("git history");
    expect(pill?.title).toContain("read and edit this document");
  });

  it("carries both full paths in the aria-label, not only the title", () => {
    // `title` is unreachable by keyboard, touch and assistive tech.
    const pill = cwdDriftPill(DRIFT, null, null);
    expect(pill?.ariaLabel).toContain(DRIFT.claudeCwd);
    expect(pill?.ariaLabel).toContain(DRIFT.suggestedCwd);
  });

  it("names the destination folder in the action row", () => {
    expect(cwdDriftPill(DRIFT, null, null)?.actionLabel).toBe("Restart Claude in alpha…");
  });
});

describe("visibleLauncherFailure", () => {
  it("shows an undismissed failure", () => {
    expect(visibleLauncherFailure("restart", null)).toBe("restart");
  });

  it("hides the dismissed failure, including when the same code comes back", () => {
    // Same value after a trip → relaunch → trip: still the same problem.
    expect(visibleLauncherFailure("restart", "restart")).toBeNull();
  });

  it("re-shows when a different failure appears", () => {
    expect(visibleLauncherFailure("sign-in", "restart")).toBe("sign-in");
  });

  it("shows nothing with no failure", () => {
    expect(visibleLauncherFailure(null, "restart")).toBeNull();
    expect(visibleLauncherFailure(null, null)).toBeNull();
  });
});
