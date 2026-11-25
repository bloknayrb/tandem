/**
 * The editor's read of the published ownership state (#2358 PR 5b, ADR-054's
 * 5b amendment; ownership design §10.2). The pure rules every surface follows:
 * what an entry carries, when the badge shows, what it says, where Release
 * goes, when the menu's leaves appear, and the composer's "who answers" line.
 */
import { describe, expect, it } from "vitest";
import {
  badgeOffersStart,
  badgeView,
  canRelease,
  chatStaleWaitMs,
  composerLine,
  describeOwner,
  holderName,
  mayAssign,
  messageControlView,
  messageOwnershipErrorText,
  NO_AI_BIND_FAILED_TEXT,
  ownerFieldsFromList,
  ownershipErrorText,
  readChatOwners,
  readOwnerFields,
  readOwnershipSummary,
  releaseGoesToTandem,
  sameOwnerFields,
  sameSummary,
  takeBackNames,
  takeBackText,
  waitingMinutes,
  waitingText,
} from "../../src/client/ownership/owner-view";
import type {
  OwnershipSummary,
  PublishedChatMessageOwner,
  PublishedOwner,
  PublishedOwnerFields,
} from "../../src/shared/ownership-published";

const T0 = 1_800_000_000_000;
const MIN = 60_000;

/** A dark server's entry: exactly `toDocListEntry`'s six keys. */
const DARK_ENTRY = {
  id: "d1",
  filePath: "/x/a.md",
  fileName: "a.md",
  format: "md",
  readOnly: false,
  source: "file",
};

const TERMINAL: PublishedOwner = { label: "owner-k7qx", displayKind: "terminal", kind: "claimed" };
const TANDEM: PublishedOwner = {
  label: "owner-t000",
  displayKind: "Tandem's Claude",
  kind: "default",
};

function fields(over: Partial<PublishedOwnerFields> = {}): PublishedOwnerFields {
  return { owner: TERMINAL, stale: null, hint: null, waitingSince: null, ...over };
}

function summary(over: Partial<OwnershipSummary> = {}): OwnershipSummary {
  return {
    tandemPresent: true,
    tandemRunning: true,
    tandemStartable: true,
    notPresentReason: null,
    otherAiAttached: false,
    chatWaiting: false,
    chatStale: false,
    ...over,
  };
}

describe("readOwnerFields", () => {
  it("answers undefined for a dark server's entry (no owner key): ownership is off", () => {
    expect(readOwnerFields(DARK_ENTRY)).toBeUndefined();
  });

  it("reads a present owner: null as unowned", () => {
    expect(readOwnerFields({ ...DARK_ENTRY, owner: null, stale: null, hint: null })).toEqual({
      owner: null,
      stale: null,
      hint: null,
      waitingSince: null,
    });
  });

  it("reads every field of a flag-on entry", () => {
    expect(
      readOwnerFields({
        ...DARK_ENTRY,
        owner: { ...TERMINAL, ownerId: "never-read" },
        stale: "not-checking-in",
        hint: "start-to-answer",
        waitingSince: T0,
      }),
    ).toEqual({
      owner: TERMINAL,
      stale: "not-checking-in",
      hint: "start-to-answer",
      waitingSince: T0,
    });
  });

  it("treats an owner of an unknown shape as no fields rather than guess", () => {
    expect(
      readOwnerFields({
        ...DARK_ENTRY,
        owner: { label: "x", displayKind: "Bob", kind: "claimed" },
      }),
    ).toBeUndefined();
    expect(
      readOwnerFields({
        ...DARK_ENTRY,
        owner: { label: "", displayKind: "terminal", kind: "claimed" },
      }),
    ).toBeUndefined();
    expect(readOwnerFields({ ...DARK_ENTRY, owner: "terminal" })).toBeUndefined();
    expect(readOwnerFields(null)).toBeUndefined();
  });

  it("drops an unknown stale, hint or waiting time to null", () => {
    expect(
      readOwnerFields({
        ...DARK_ENTRY,
        owner: null,
        stale: "asleep",
        hint: "x",
        waitingSince: "1",
      }),
    ).toEqual({ owner: null, stale: null, hint: null, waitingSince: null });
  });
});

describe("ownerFieldsFromList (what yjsSync keeps)", () => {
  it("is empty for a dark server's list", () => {
    const prev = new Map<string, PublishedOwnerFields>();
    const out = ownerFieldsFromList([DARK_ENTRY, { ...DARK_ENTRY, id: "d2" }], prev);
    expect(out.size).toBe(0);
    expect(out).toBe(prev);
  });

  it("keeps only the entries that carry owner fields", () => {
    const out = ownerFieldsFromList(
      <Array<{ id: string }>>[
        DARK_ENTRY,
        { ...DARK_ENTRY, id: "d2", owner: TERMINAL, stale: null, hint: null, waitingSince: null },
      ],
      new Map(),
    );
    expect([...out.keys()]).toEqual(["d2"]);
    expect(out.get("d2")?.owner).toEqual(TERMINAL);
  });

  it("returns the previous map when nothing changed, and a new one when anything did", () => {
    const entry = { ...DARK_ENTRY, owner: TERMINAL, stale: null, hint: null, waitingSince: null };
    const list: Array<{ id: string }> = [entry];
    const first = ownerFieldsFromList(list, new Map());
    expect(ownerFieldsFromList(list, first)).toBe(first);
    const staleEntry = { ...entry, stale: "disconnected" };
    const moved = ownerFieldsFromList([staleEntry], first);
    expect(moved).not.toBe(first);
    expect(moved.get("d1")?.stale).toBe("disconnected");
    expect(ownerFieldsFromList([DARK_ENTRY], first).size).toBe(0);
  });
});

describe("readOwnershipSummary", () => {
  it("is null when absent (flag off, stdio, no launcher) or malformed", () => {
    expect(readOwnershipSummary(undefined)).toBeNull();
    expect(readOwnershipSummary({ tandemPresent: true })).toBeNull();
    expect(readOwnershipSummary({ ...summary(), notPresentReason: "asleep" })).toBeNull();
  });

  it("requires #2358 PR 5d's chat waiting and chat stale as booleans", () => {
    const { chatWaiting: _w, ...noWaiting } = summary();
    const { chatStale: _s, ...noStale } = summary();
    expect(readOwnershipSummary(noWaiting)).toBeNull();
    expect(readOwnershipSummary(noStale)).toBeNull();
    expect(readOwnershipSummary({ ...summary(), chatStale: "yes" })).toBeNull();
    const s = summary({ chatWaiting: true, chatStale: true });
    expect(readOwnershipSummary(s)).toEqual(s);
  });

  it("reads a well-formed summary", () => {
    const s = summary({ tandemPresent: false, notPresentReason: "bind-failed" });
    expect(readOwnershipSummary(s)).toEqual(s);
  });
});

describe("sameOwnerFields / sameSummary", () => {
  it("compares field by field", () => {
    expect(sameOwnerFields(fields(), fields())).toBe(true);
    expect(sameOwnerFields(fields(), fields({ stale: "disconnected" }))).toBe(false);
    expect(sameOwnerFields(fields(), fields({ owner: { ...TERMINAL, kind: "assigned" } }))).toBe(
      false,
    );
    expect(sameOwnerFields(fields({ owner: null }), fields())).toBe(false);
    expect(sameOwnerFields(undefined, fields())).toBe(false);
    expect(sameSummary(summary(), summary())).toBe(true);
    expect(sameSummary(summary(), summary({ otherAiAttached: true }))).toBe(false);
    expect(sameSummary(summary(), summary({ chatWaiting: true }))).toBe(false);
    expect(sameSummary(summary(), summary({ chatStale: true }))).toBe(false);
    expect(sameSummary(null, null)).toBe(true);
  });
});

describe("holderName", () => {
  it("names Tandem's Claude alone and any other record by display kind and label", () => {
    expect(holderName(TANDEM)).toBe("Tandem's Claude");
    expect(holderName(TERMINAL)).toBe("terminal owner-k7qx");
    expect(holderName({ label: "owner-p2zt", displayKind: "Claude Desktop" })).toBe(
      "Claude Desktop owner-p2zt",
    );
  });
});

describe("badgeView: shown only when it says something (design §10.2)", () => {
  it("is null with no fields, whatever the summary says (ownership off)", () => {
    expect(badgeView(undefined, null, T0)).toBeNull();
    expect(badgeView(undefined, summary({ otherAiAttached: true }), T0)).toBeNull();
  });

  it("is null for a lone Tandem's Claude, or no AI at all, without a hint", () => {
    expect(badgeView(fields({ owner: TANDEM }), summary(), T0)).toBeNull();
    expect(badgeView(fields({ owner: null }), summary({ tandemPresent: false }), T0)).toBeNull();
    expect(badgeView(fields({ owner: TANDEM }), null, T0)).toBeNull();
  });

  it("shows when another record holds the document", () => {
    expect(badgeView(fields(), summary(), T0)?.text).toBe("terminal owner-k7qx");
    expect(badgeView(fields(), summary(), T0)?.detail).toBe("terminal owner-k7qx · claimed");
  });

  it("shows on every document when another record is attached", () => {
    expect(badgeView(fields({ owner: TANDEM }), summary({ otherAiAttached: true }), T0)?.text).toBe(
      "Tandem's Claude",
    );
    expect(badgeView(fields({ owner: null }), summary({ otherAiAttached: true }), T0)?.text).toBe(
      "Unassigned",
    );
  });

  it("shows whenever a hint is active", () => {
    const v = badgeView(fields({ owner: TANDEM, hint: "start-to-answer" }), summary(), T0);
    expect(v?.text).toBe("Waiting — Start to answer");
    expect(v?.hint).toBe("start-to-answer");
    expect(v?.detail).toBe("Waiting — Start to answer — Tandem's Claude · default");
  });

  it("adds the stale state to the holder's name", () => {
    expect(badgeView(fields({ stale: "disconnected" }), null, T0)?.text).toBe(
      "terminal owner-k7qx (disconnected)",
    );
    expect(badgeView(fields({ stale: "not-checking-in" }), null, T0)?.text).toBe(
      "terminal owner-k7qx (not checking in)",
    );
  });
});

describe("waiting N min, counted client-side", () => {
  it("counts whole minutes from waitingSince and never goes negative", () => {
    expect(waitingMinutes(T0, T0 + 6 * MIN + 59_000)).toBe(6);
    expect(waitingMinutes(T0, T0 - MIN)).toBe(0);
  });

  it("says it only for an unowned waiting document with a time", () => {
    const f = fields({ owner: null, hint: "unowned-waiting", waitingSince: T0 });
    expect(waitingText(f, T0 + 7 * MIN)).toBe("waiting 7 min; nobody has checked in");
    expect(waitingText(fields({ owner: null, hint: "unowned-waiting" }), T0)).toBeNull();
    expect(waitingText(fields({ hint: "start-to-answer", waitingSince: T0 }), T0)).toBeNull();
    expect(describeOwner(f, T0 + 7 * MIN).detail).toBe(
      "Unowned and waiting — waiting 7 min; nobody has checked in",
    );
  });
});

describe("Release and Assign gates", () => {
  it("hides Release on an unowned document and on a default one while Tandem's Claude is present", () => {
    expect(canRelease(undefined, summary())).toBe(false);
    expect(canRelease(fields({ owner: null }), summary())).toBe(false);
    expect(canRelease(fields({ owner: TANDEM }), summary())).toBe(false);
    expect(canRelease(fields({ owner: TANDEM }), summary({ tandemPresent: false }))).toBe(true);
    expect(canRelease(fields({ owner: { ...TANDEM, kind: "assigned" } }), summary())).toBe(true);
    expect(canRelease(fields(), summary())).toBe(true);
    expect(canRelease(fields(), null)).toBe(true);
  });

  it("sends a Release back to Tandem's Claude only while it is present", () => {
    expect(releaseGoesToTandem(summary())).toBe(true);
    expect(releaseGoesToTandem(summary({ tandemPresent: false }))).toBe(false);
    expect(releaseGoesToTandem(null)).toBe(false);
  });

  it("offers the menu's Assign leaf only when some record can take a document", () => {
    expect(mayAssign(undefined, summary())).toBe(false);
    expect(mayAssign(fields(), summary())).toBe(true);
    expect(mayAssign(fields(), summary({ tandemPresent: false, otherAiAttached: true }))).toBe(
      true,
    );
    expect(mayAssign(fields(), summary({ tandemPresent: false }))).toBe(false);
    expect(mayAssign(fields(), null)).toBe(true);
  });

  it("offers Start on a badge only with a hint and where Start can help", () => {
    expect(badgeOffersStart(fields({ hint: "start-to-answer" }), summary())).toBe(true);
    expect(
      badgeOffersStart(fields({ hint: "start-to-answer" }), summary({ tandemStartable: false })),
    ).toBe(false);
    expect(badgeOffersStart(fields(), summary())).toBe(false);
    expect(badgeOffersStart(fields({ hint: "unowned-waiting" }), null)).toBe(false);
  });
});

describe("take-back names (design §8.2, §10.2)", () => {
  it("lists the documents another session holds as claimed, and says so", () => {
    const names = takeBackNames([
      { fileName: "a.md", fields: fields() },
      { fileName: "b.md", fields: fields({ owner: { ...TERMINAL, kind: "opened" } }) },
      { fileName: "c.md", fields: fields({ owner: TANDEM }) },
      { fileName: "d.md", fields: undefined },
      { fileName: "e.md", fields: fields({ owner: null }) },
    ]);
    expect(names).toEqual(["a.md"]);
    expect(takeBackText(names)).toBe("Starting takes back “a.md”");
    expect(takeBackText([])).toBeNull();
  });
});

describe("composerLine (design §10.2)", () => {
  it("is null when nothing is published (ownership off: the composer is unchanged)", () => {
    expect(composerLine(undefined, null)).toBeNull();
  });

  it("names Tandem's Claude, and says it will start when it is present and not running", () => {
    expect(composerLine(fields({ owner: TANDEM }), summary())?.text).toBe("→ Tandem's Claude");
    expect(composerLine(fields({ owner: TANDEM }), summary({ tandemRunning: false }))?.text).toBe(
      "→ Tandem's Claude (will start)",
    );
  });

  it("names another holder, with its stale state", () => {
    expect(composerLine(fields(), summary())?.text).toBe("→ terminal owner-k7qx");
    expect(composerLine(fields({ stale: "disconnected" }), summary())?.text).toBe(
      "→ terminal owner-k7qx (disconnected)",
    );
    expect(composerLine(fields({ stale: "not-checking-in" }), null)?.text).toBe(
      "→ terminal owner-k7qx (not checking in)",
    );
  });

  it("sends an unowned document to the first session to check in when one could claim it", () => {
    const unowned = fields({ owner: null });
    expect(composerLine(unowned, summary({ otherAiAttached: true }))?.text).toBe(
      "→ the first session to check in",
    );
    expect(composerLine(unowned, summary())?.text).toBe("→ the first session to check in");
    expect(
      composerLine(
        unowned,
        summary({
          tandemPresent: false,
          tandemRunning: false,
          notPresentReason: "off",
          otherAiAttached: true,
        }),
      )?.text,
    ).toBe("→ the first session to check in");
    expect(composerLine(unowned, null)?.text).toBe("→ the first session to check in");
  });

  it("says Tandem's Claude will start for an unowned document with no other AI attached", () => {
    expect(
      composerLine(
        fields({ owner: null }),
        summary({ tandemPresent: false, tandemRunning: false, notPresentReason: "off" }),
      )?.text,
    ).toBe("→ Tandem's Claude (will start)");
  });

  it("says no AI will answer otherwise, pointing to Start or Settings, whichever can help", () => {
    const down = summary({
      tandemPresent: false,
      tandemRunning: false,
      tandemStartable: false,
      notPresentReason: "not-set-up",
    });
    expect(composerLine(fields({ owner: null }), down)).toEqual({
      kind: "none",
      text: "No AI will answer",
      remedy: "settings",
    });
    expect(
      composerLine(fields({ owner: TANDEM }), {
        ...down,
        tandemStartable: true,
        notPresentReason: "staying-down",
      }),
    ).toEqual({
      kind: "none",
      text: "No AI will answer",
      remedy: "start",
    });
    expect(composerLine(undefined, { ...down, notPresentReason: "bind-failed" })).toEqual({
      kind: "none",
      text: NO_AI_BIND_FAILED_TEXT,
      remedy: "settings",
    });
    expect(NO_AI_BIND_FAILED_TEXT).toBe(
      "No AI will answer — Tandem's Claude couldn't connect its Tandem tools (see Settings)",
    );
  });

  it("with no tab, follows presence, then any other session, then a start", () => {
    expect(composerLine(undefined, summary())?.text).toBe("→ Tandem's Claude");
    expect(composerLine(undefined, summary({ tandemRunning: false }))?.text).toBe(
      "→ Tandem's Claude (will start)",
    );
    expect(
      composerLine(undefined, summary({ tandemPresent: false, otherAiAttached: true }))?.text,
    ).toBe("→ the first session to check in");
    expect(
      composerLine(
        undefined,
        summary({ tandemPresent: false, tandemRunning: false, notPresentReason: "off" }),
      )?.text,
    ).toBe("→ Tandem's Claude (will start)");
  });
});

describe("ownershipErrorText", () => {
  it("words each refusal", () => {
    expect(ownershipErrorText("busy")).toBe("An operation is in progress — try again");
    expect(ownershipErrorText("owner-detached")).toBe(
      "That session just disconnected — pick another or Release",
    );
    expect(ownershipErrorText("unknown-owner")).toBe(ownershipErrorText("owner-detached"));
    expect(ownershipErrorText("unknown-document")).toBe("This document is no longer open");
    expect(ownershipErrorText(null)).toMatch(/try again/);
  });
});

// ---------------------------------------------------------------------------
// #2358 PR 5e: the per-message facts PR 5d publishes under `Y_MAP_OWNERSHIP_CHAT`.

function chatFacts(over: Partial<PublishedChatMessageOwner> = {}): PublishedChatMessageOwner {
  return {
    owner: { label: "owner-k7qx", displayKind: "terminal" },
    heldBy: "message",
    release: true,
    releaseTo: "unassigned",
    assign: true,
    since: T0,
    stale: false,
    ...over,
  };
}

describe("readChatOwners (what yjsSync keeps)", () => {
  const EMPTY = new Map<string, PublishedChatMessageOwner>();

  it("absent (a dark server) or not an object reads as no facts", () => {
    for (const v of [undefined, null, "x", 3, [chatFacts()]]) {
      expect(readChatOwners(v, EMPTY).size).toBe(0);
    }
  });

  it("keeps each well-formed entry by chat key, an unowned one included", () => {
    const got = readChatOwners(
      {
        m1: chatFacts(),
        m2: chatFacts({ owner: null, heldBy: "none", release: false, releaseTo: null }),
      },
      EMPTY,
    );
    expect([...got.keys()]).toEqual(["m1", "m2"]);
    expect(got.get("m1")).toEqual(chatFacts());
    expect(got.get("m2")?.owner).toBeNull();
  });

  it.each([
    ["an unknown display kind", { owner: { label: "x", displayKind: "Bryan's laptop" } }],
    ["an empty label", { owner: { label: "", displayKind: "terminal" } }],
    ["an unknown heldBy", { heldBy: "nobody" }],
    ["a non-boolean release", { release: "yes" }],
    ["an unknown releaseTo", { releaseTo: "elsewhere" }],
    ["no releaseTo where Release applies", { releaseTo: null }],
    ["a releaseTo where Release does not apply", { release: false, releaseTo: "unassigned" }],
    ["a non-boolean assign", { assign: 1 }],
    ["a non-finite since", { since: Number.NaN }],
    ["a string since", { since: "1800000000000" }],
    ["a non-boolean stale", { stale: null }],
  ])("drops an entry with %s, keeping the rest", (_name, bad) => {
    const got = readChatOwners({ good: chatFacts(), bad: { ...chatFacts(), ...bad } }, EMPTY);
    expect([...got.keys()]).toEqual(["good"]);
  });

  it("returns the previous map itself when nothing changed, and a new one on any field change", () => {
    const first = readChatOwners({ m1: chatFacts() }, EMPTY);
    expect(readChatOwners({ m1: chatFacts() }, first)).toBe(first);
    for (const over of [
      { since: T0 + 1 },
      { stale: true },
      { release: false, releaseTo: null },
      { releaseTo: "tandem-claude" as const },
      { assign: false },
      { heldBy: "presence" as const },
      { owner: null },
      { owner: { label: "owner-zz", displayKind: "terminal" as const } },
      { owner: { label: "owner-k7qx", displayKind: "other app" as const } },
    ]) {
      expect(readChatOwners({ m1: chatFacts(over) }, first)).not.toBe(first);
    }
    expect(readChatOwners({ m2: chatFacts() }, first)).not.toBe(first);
    expect(readChatOwners({}, first).size).toBe(0);
  });
});

describe("chatStaleWaitMs (the stall banner's chat signal)", () => {
  it("null with no stale message", () => {
    expect(chatStaleWaitMs(new Map(), T0)).toBeNull();
    expect(chatStaleWaitMs(new Map([["m", chatFacts()]]), T0 + 60 * MIN)).toBeNull();
  });

  it("the oldest stale message's wait since its last change of owner", () => {
    const owners = new Map([
      ["a", chatFacts({ stale: true, since: T0 + 2 * MIN })],
      ["b", chatFacts({ stale: true, since: T0 })],
      ["c", chatFacts({ stale: false, since: T0 - 30 * MIN })],
    ]);
    expect(chatStaleWaitMs(owners, T0 + 7 * MIN)).toBe(7 * MIN);
  });

  it("leaves out a message that follows its open document (its badge speaks), as the summary's chatStale does", () => {
    const owners = new Map([
      ["doc", chatFacts({ stale: true, heldBy: "document", assign: false, since: T0 - 30 * MIN })],
      ["own", chatFacts({ stale: true, heldBy: "presence", since: T0 })],
    ]);
    expect(chatStaleWaitMs(owners, T0 + 6 * MIN)).toBe(6 * MIN);
    owners.delete("own");
    expect(chatStaleWaitMs(owners, T0 + 6 * MIN)).toBeNull();
  });

  it("never negative under clock skew", () => {
    expect(chatStaleWaitMs(new Map([["m", chatFacts({ stale: true, since: T0 + MIN })]]), T0)).toBe(
      0,
    );
  });
});

// ---------------------------------------------------------------------------
// #2358 PR 5e: a chat message's controls (Bryan, 2026-11-24, "A line per
// message (Recommended)", "Yes, say where (Recommended)", "Accept
// (Recommended)" and "Yes (Recommended)").

describe("messageControlView (the line under one unanswered message)", () => {
  const byTandem = { label: "owner-t", displayKind: "Tandem's Claude" as const };

  it("no facts (ownership off, or an answered message) is no line", () => {
    expect(messageControlView(undefined, summary())).toBeNull();
    expect(messageControlView(undefined, null)).toBeNull();
  });

  it("a message that follows its open document has no line: its document's badge has the controls", () => {
    const onDoc = chatFacts({ heldBy: "document", release: false, releaseTo: null, assign: false });
    expect(messageControlView(onDoc, null)).toBeNull();
    expect(messageControlView(onDoc, summary({ otherAiAttached: true }))).toBeNull();
  });

  it("names the holder in 5b's words, Release saying where it goes, and Assign", () => {
    expect(messageControlView(chatFacts(), summary())).toEqual({
      holder: "terminal owner-k7qx",
      release: "Release — Unassigned",
      assign: true,
    });
    expect(messageControlView(chatFacts({ releaseTo: "tandem-claude" }), summary())?.release).toBe(
      "Release — Back to Tandem's Claude",
    );
    expect(messageControlView(chatFacts({ releaseTo: "document" }), summary())?.release).toBe(
      "Release — Back to its document",
    );
    expect(
      messageControlView(
        chatFacts({ owner: null, heldBy: "none", release: false, releaseTo: null }),
        summary(),
      ),
    ).toEqual({ holder: "Unassigned", release: null, assign: true });
  });

  it("shows only when it says something: a per-message owner, no holder, or another session attached; always with no summary", () => {
    const presence = chatFacts({
      owner: byTandem,
      heldBy: "presence",
      release: false,
      releaseTo: null,
    });
    expect(messageControlView(presence, summary())).toBeNull();
    expect(messageControlView(presence, summary({ otherAiAttached: true }))?.holder).toBe(
      "Tandem's Claude",
    );
    expect(messageControlView(presence, null)?.holder).toBe("Tandem's Claude");
    // A per-message owner, even Tandem's Claude, says something.
    expect(messageControlView(chatFacts({ owner: byTandem }), summary())?.holder).toBe(
      "Tandem's Claude",
    );
    // Nobody holds it.
    expect(
      messageControlView(
        chatFacts({ owner: null, heldBy: "none", release: false, releaseTo: null }),
        summary(),
      ),
    ).not.toBeNull();
  });
});

describe("messageOwnershipErrorText", () => {
  it("words each message refusal in Bryan's copy", () => {
    expect(messageOwnershipErrorText("unknown-message")).toBe("This message was removed");
    expect(messageOwnershipErrorText("follows-document")).toBe(
      "This message follows its document — use the document's tab",
    );
    expect(messageOwnershipErrorText("answered")).toBe("This message was already answered");
    expect(messageOwnershipErrorText("not-controllable")).toBe(
      "A local model is handling this message",
    );
    expect(messageOwnershipErrorText("owner-detached")).toBe(ownershipErrorText("owner-detached"));
    expect(messageOwnershipErrorText("unknown-owner")).toBe(ownershipErrorText("unknown-owner"));
    expect(messageOwnershipErrorText(null)).toBe(
      "Couldn't change who answers this message — try again",
    );
  });
});

describe("composerLine: Start for stale chat (ownership design §10.2)", () => {
  const terminal: PublishedOwnerFields = {
    owner: { label: "owner-k7qx", displayKind: "terminal", kind: "claimed" },
    stale: null,
    hint: null,
    waitingSince: null,
  };

  it("offers Start beside whoever answers when chat is stale and Start can help", () => {
    const stale = summary({ chatStale: true, tandemStartable: true, tandemRunning: false });
    expect(composerLine(terminal, stale)).toEqual({
      kind: "to",
      text: "→ terminal owner-k7qx",
      remedy: "start",
    });
  });

  it("offers nothing new without stale chat, where Start cannot help, or with no summary", () => {
    expect(composerLine(terminal, summary({ chatStale: false }))).toEqual({
      kind: "to",
      text: "→ terminal owner-k7qx",
    });
    expect(composerLine(terminal, summary({ chatStale: true, tandemStartable: false }))).toEqual({
      kind: "to",
      text: "→ terminal owner-k7qx",
    });
    expect(composerLine(terminal, null)).toEqual({ kind: "to", text: "→ terminal owner-k7qx" });
    // Tandem's Claude already running: Start cannot help.
    expect(
      composerLine(
        terminal,
        summary({ chatStale: true, tandemStartable: true, tandemRunning: true }),
      ),
    ).toEqual({ kind: "to", text: "→ terminal owner-k7qx" });
  });

  it("with the per-message facts, offers Start only where a started Tandem's Claude could answer a stale message", () => {
    const stale = summary({ chatStale: true, tandemStartable: true, tandemRunning: false });
    const offered = { kind: "to", text: "→ terminal owner-k7qx", remedy: "start" };
    const plain = { kind: "to", text: "→ terminal owner-k7qx" };
    // Held per message by another session: a per-message owner wins over
    // presence, so Start cannot answer it.
    const byTerminal = chatFacts({ stale: true, heldBy: "message" });
    expect(composerLine(terminal, stale, new Map([["m", byTerminal]]))).toEqual(plain);
    // A stale message that follows its document is its badge's, not this line's.
    const followsDoc = chatFacts({
      stale: true,
      heldBy: "document",
      release: false,
      releaseTo: null,
    });
    expect(composerLine(terminal, stale, new Map([["m", followsDoc]]))).toEqual(plain);
    // Nobody holds it, Tandem's Claude holds it per message, or by presence: Start can help.
    const nobody = chatFacts({
      stale: true,
      owner: null,
      heldBy: "none",
      release: false,
      releaseTo: null,
    });
    const byTandem = chatFacts({
      stale: true,
      heldBy: "message",
      owner: { label: "owner-t", displayKind: "Tandem's Claude" },
    });
    const byPresence = chatFacts({
      stale: true,
      heldBy: "presence",
      owner: { label: "owner-t", displayKind: "Tandem's Claude" },
      release: false,
      releaseTo: null,
    });
    for (const f of [nobody, byTandem, byPresence]) {
      expect(
        composerLine(
          terminal,
          stale,
          new Map([
            ["m", byTerminal],
            ["n", f],
          ]),
        ),
      ).toEqual(offered);
    }
  });

  it("leaves a no-AI line's own remedy alone", () => {
    const none = summary({
      tandemPresent: false,
      tandemRunning: false,
      tandemStartable: false,
      notPresentReason: "off",
      chatStale: true,
    });
    expect(composerLine(undefined, none)).toEqual({
      kind: "none",
      text: "No AI will answer",
      remedy: "settings",
    });
    // Start could help, yet the bind-failed line keeps its Settings pointer.
    const tandemHeld: PublishedOwnerFields = {
      ...terminal,
      owner: { label: "owner-t", displayKind: "Tandem's Claude", kind: "default" },
    };
    const bindFailed = summary({
      tandemPresent: false,
      tandemRunning: false,
      tandemStartable: true,
      notPresentReason: "bind-failed",
      chatStale: true,
    });
    expect(composerLine(tandemHeld, bindFailed)).toEqual({
      kind: "none",
      text: NO_AI_BIND_FAILED_TEXT,
      remedy: "settings",
    });
  });
});

describe("messageControlView: Assign only where the facts offer it", () => {
  it("hides Assign on facts that offer only Release", () => {
    expect(messageControlView(chatFacts({ assign: false }), null)?.assign).toBe(false);
  });
});
