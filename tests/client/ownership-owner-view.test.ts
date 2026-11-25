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
  composerLine,
  describeOwner,
  holderName,
  mayAssign,
  NO_AI_BIND_FAILED_TEXT,
  ownerFieldsFromList,
  ownershipErrorText,
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
