/**
 * The status pill while chat is set to the local model (#1123 part B, R7):
 * one case per row of the brief's R7.4 table, each with every label the row
 * allows, and the same row out of the local period asserting today's view.
 */
import { describe, expect, it } from "vitest";
import { aiIndicatorView } from "../../src/client/status/status-ai-view.js";

type ViewInput = Parameters<typeof aiIndicatorView>[0];

function input(over: Partial<ViewInput> = {}): ViewInput {
  return {
    state: "ready",
    liveIndicator: null,
    soloMode: false,
    pushDelivery: "unknown",
    launcherRunning: false,
    launcherCwd: null,
    launcherBusy: false,
    launcherAttached: false,
    launcherRestarting: false,
    launcherStarting: false,
    launcherStandby: null,
    launcherStandbyRecent: false,
    docSyncConnected: true,
    sessionCount: null,
    aiNotice: null,
    ...over,
  };
}

/**
 * Literal strings, never the product's constants (review round 1, item 4):
 * a test that built its expectations from `LOCAL_CHAT_SENTENCE` would pass
 * whatever the product said.
 */
const S = {
  local:
    "Chat is set to your local model. Tandem does not send Claude the chat messages you send while it is, then or later.",
  unusable:
    "Chat is set to your local model, but no local model can be used now (see Settings → Models). Tandem does not send Claude the chat messages you send while it is, then or later.",
} as const;
const LABEL = {
  local: "Chat: your local model",
  unusable: "Your local model can't answer",
} as const;
const SOLO_LABEL = {
  local: "Solo · chat: your local model",
  unusable: "Solo · your local model can't answer",
} as const;
const SESSION_SENTENCE = (n: number) =>
  `${n === 1 ? "1 session is" : `${n} sessions are`} connected to Tandem. One that just closed can still count for about a minute, a frozen one until it closes, and one Claude connected two ways counts twice.`;

interface Row {
  name: string;
  today: Partial<ViewInput>;
  todayLabel: string;
  todayState: string;
  title: (local: "local" | "unusable") => string;
  solo?: boolean;
  /** Does today's view for this row carry the session count? */
  counts: boolean;
}

const ROWS: Row[] = [
  {
    name: "Rule 1, Solo, a live session, no launcher (SOLO_PAUSED)",
    today: { soloMode: true, liveIndicator: "solo-paused", sessionCount: 1 },
    todayLabel: "Solo · comments held",
    todayState: "solo-paused",
    solo: true,
    counts: true,
    title: (l) =>
      `Solo mode. ${S[l]}${l === "local" ? " In Solo your local model replies in chat only." : ""}`,
  },
  {
    name: "Rule 1, Solo, a live session, Tandem's Claude running (SOLO_PAUSED_QUIET)",
    today: { soloMode: true, liveIndicator: "solo-paused", launcherRunning: true, sessionCount: 2 },
    todayLabel: "Solo · comments held",
    todayState: "solo-paused",
    solo: true,
    counts: true,
    title: (l) =>
      `Solo mode. ${S[l]}${l === "local" ? " In Solo your local model replies in chat only." : ""}`,
  },
  {
    name: "Rule 1, Solo, Tandem's Claude running, no session seen (SOLO_PAUSED_LAUNCHER)",
    today: { soloMode: true, launcherRunning: true },
    todayLabel: "Solo · comments held",
    todayState: "solo-paused",
    solo: true,
    counts: false,
    title: (l) =>
      `Solo mode. ${S[l]}${l === "local" ? " In Solo your local model replies in chat only." : ""}`,
  },
  {
    name: "Rule 2, Tandem's Claude running, attached",
    today: {
      launcherRunning: true,
      launcherCwd: "/home/alice/proj",
      launcherAttached: true,
      liveIndicator: "connected",
      sessionCount: 1,
    },
    todayLabel: "Tandem's Claude",
    todayState: "tandem-claude",
    counts: true,
    title: (l) => `Tandem's Claude is running in ~/proj. ${S[l]}`,
  },
  {
    name: "Rule 2, Tandem's Claude running, sync down",
    today: {
      launcherRunning: true,
      liveIndicator: "connected",
      sessionCount: 1,
      docSyncConnected: false,
    },
    todayLabel: "Tandem's Claude",
    todayState: "tandem-claude",
    counts: true,
    title: (l) =>
      `Tandem's Claude is running. ${S[l]} Document sync is down, so what you send now won't reach Tandem until sync reconnects.`,
  },
  {
    name: "Rule 2, Tandem's Claude running, busy, no session seen",
    today: { launcherRunning: true, launcherBusy: true },
    todayLabel: "Tandem's Claude",
    todayState: "tandem-claude",
    counts: false,
    title: (l) => `Tandem's Claude is running. ${S[l]}`,
  },
  {
    name: "Rule 2, restarting",
    today: { state: "stopped", launcherRestarting: true },
    todayLabel: "Restarting Claude…",
    todayState: "restarting",
    counts: false,
    title: (l) => `Tandem is starting its Claude. ${S[l]}`,
  },
  {
    name: "Rule 2, starting",
    today: { state: "stopped", launcherRestarting: true, launcherStarting: true },
    todayLabel: "Starting Claude…",
    todayState: "restarting",
    counts: false,
    title: (l) => `Tandem is starting its Claude. ${S[l]}`,
  },
  {
    name: "Rule 2, standby off",
    today: { state: "stopped", launcherStandby: "off" },
    todayLabel: "Tandem's Claude is off",
    todayState: "standby",
    counts: false,
    title: (l) => `Tandem's Claude is turned off. ${S[l]}`,
  },
  {
    name: "Rule 2, standby awaiting-start (held or not)",
    today: { state: "stopped", launcherStandby: "awaiting-start" },
    todayLabel: "Tandem's Claude hasn't started",
    todayState: "standby",
    counts: false,
    title: (l) => `Tandem's Claude has not been started. ${S[l]}`,
  },
  {
    name: "Rule 2, standby idle",
    today: { state: "stopped", launcherStandby: "idle" },
    todayLabel: "Tandem's Claude stopped (idle)",
    todayState: "standby",
    counts: false,
    title: (l) => `Tandem's Claude stopped after being idle. ${S[l]}`,
  },
  {
    name: "Rule 3, a live session (CONNECTED)",
    today: { liveIndicator: "connected", sessionCount: 2, pushDelivery: "attached" },
    todayLabel: "AI attached",
    todayState: "connected",
    counts: true,
    title: (l) => `Something is connected to Tandem. ${S[l]}`,
  },
  {
    name: "Rule 3, attached, not notified (CONNECTED_NO_PUSH)",
    today: { liveIndicator: "connected", sessionCount: 1, pushDelivery: "none" },
    todayLabel: "AI attached",
    todayState: "connected",
    counts: true,
    title: (l) => `Something is connected to Tandem. ${S[l]}`,
  },
  {
    name: "Rule 3, a leftover session (CONNECTED_STALE)",
    today: { liveIndicator: "connected", sessionCount: 0 },
    todayLabel: "AI attached",
    todayState: "connected-stale",
    counts: false,
    title: (l) =>
      `Something connected to Tandem earlier, but Tandem can't see that it's still there. ${S[l]}`,
  },
  {
    name: "Rule 4, unconfigured or stopped (NOT_CONNECTED), with a session count",
    today: { state: "stopped", sessionCount: 3 },
    todayLabel: "AI not connected",
    todayState: "not-connected",
    counts: false,
    title: (l) => `No Claude session is connected to Tandem. ${S[l]}`,
  },
];

describe("every row of R7.4, in the local period and out of it", () => {
  for (const row of ROWS) {
    describe(row.name, () => {
      const today = aiIndicatorView(input(row.today));

      it("out of the local period: today's view, unchanged by the new input", () => {
        expect(today?.label).toBe(row.todayLabel);
        expect(today?.dataState).toBe(row.todayState);
        expect(today?.localChat).toBeNull();
        expect(today?.localSentence).toBeNull();
        expect(aiIndicatorView(input({ ...row.today, localChat: null }))).toEqual(today);
      });

      for (const local of ["local", "unusable"] as const) {
        it(`in the local period, '${LABEL[local]}'`, () => {
          const v = aiIndicatorView(input({ ...row.today, localChat: local }));
          const label = row.solo ? SOLO_LABEL[local] : LABEL[local];
          expect(v?.label).toBe(label);
          const count = row.counts ? (today?.sessionCount ?? null) : null;
          const sentence = count !== null ? ` ${SESSION_SENTENCE(count)}` : "";
          expect(v?.title).toBe(row.title(local) + sentence);
          expect(v?.ariaLabel).toBe(`${label}. ${row.title(local)}${sentence}`);
          expect(v?.tone).toBe(
            row.solo ? "solo" : local === "local" ? "local-chat" : "not-connected",
          );
          expect(v?.dataState).toBe(`local-${row.todayState}`);
          // The session count shows exactly where today's view shows it.
          expect(v?.sessionCount).toBe(today?.sessionCount);
          // Today's activity: Claude's real activity.
          expect(v?.canAnimate).toBe(today?.canAnimate);
          expect(v?.pulse).toBe(today?.pulse);
          expect(v?.ownActivity).toBe(today?.ownActivity);
          expect(v?.localChat).toBe(local);
          expect(v?.localSentence).toBe(S[local]);
          // Never a promise of delivery to Claude, never a wake claim.
          expect(v?.title).not.toMatch(/wakes it|when you click Start|answers/);
        });
      }
    });
  }

  it("Solo labels, byte for byte", () => {
    const solo = input({ soloMode: true, liveIndicator: "solo-paused" });
    expect(aiIndicatorView({ ...solo, localChat: "local" })?.label).toBe(
      "Solo · chat: your local model",
    );
    expect(aiIndicatorView({ ...solo, localChat: "unusable" })?.label).toBe(
      "Solo · your local model can't answer",
    );
  });
});

describe("states that render nothing still render nothing (Ruling B-22)", () => {
  for (const [name, over] of [
    ["booting", { state: "booting" }],
    ["ready, nothing attached, no launcher", { state: "ready" }],
    ["Solo with nothing running", { soloMode: true }],
  ] as const) {
    it(name, () => {
      expect(aiIndicatorView(input({ ...over, localChat: "local" }))).toBeNull();
      expect(aiIndicatorView(input({ ...over, localChat: "unusable" }))).toBeNull();
    });
  }
});

describe("the licence refusal (R7.1)", () => {
  it("'AI off' as today, in the local period too", () => {
    const off = input({ aiNotice: "unlicensed", launcherRunning: true });
    expect(aiIndicatorView({ ...off, localChat: "local" })).toEqual(aiIndicatorView(off));
    expect(aiIndicatorView(off)?.label).toBe("AI off");
  });
});
