// @vitest-environment happy-dom

/**
 * Coverage for the drift-nudge suppression layers (#1282).
 *
 * These exist because of an arithmetic fact, not a preference: the launcher's
 * default working directory is `os.homedir()` and the drift check requires the
 * candidate to be INSIDE home, so a user who has never configured a working
 * directory drifts on every document in every subfolder. Without suppression
 * this feature is a permanent amber pill. So the interesting assertions are the
 * ones about going quiet, and about the two ways going quiet could be wrong:
 * suppressing a pair that is not the one dismissed, and going quiet silently.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  _resetDriftDismissForTests,
  dismissDrift,
  driftDismissed,
  driftNudgeOptedOut,
  noteDriftSeen,
  optOutOfDriftNudge,
  SESSION_DISMISS_LIMIT,
} from "../../../src/client/status/cwdDriftDismiss.svelte.js";

const CLAUDE = "~/notes";
const TARGET = "~/projects/alpha";

/** Make one localStorage method throw, the way a storage-disabled browser does.
 * Spies the INSTANCE, not `Storage.prototype` — happy-dom's storage does not
 * route through that prototype, so a prototype spy installs cleanly and then
 * intercepts nothing, quietly turning these into vacuous passes. */
function denyStorage(method: "getItem" | "setItem"): { mockRestore: () => void } {
  return vi.spyOn(globalThis.localStorage, method).mockImplementation(() => {
    throw new Error("denied");
  });
}

beforeEach(() => {
  _resetDriftDismissForTests();
});

describe("per-pair dismissal", () => {
  it("hides the dismissed pair and nothing else", () => {
    expect(driftDismissed(CLAUDE, TARGET)).toBe(false);
    dismissDrift(CLAUDE, TARGET);
    expect(driftDismissed(CLAUDE, TARGET)).toBe(true);
    expect(driftDismissed(CLAUDE, "~/projects/beta")).toBe(false);
  });

  it("keys on the PAIR, so moving Claude re-arms a dismissed target", () => {
    // Dismiss "move to ~/projects/alpha" while Claude sits in ~/notes; later
    // move Claude somewhere else and reopen a document in alpha. Keyed on the
    // target alone that is still suppressed — even though the situation is now
    // strictly worse, because Claude is in a folder whose CLAUDE.md has nothing
    // to do with this document.
    dismissDrift(CLAUDE, TARGET);
    expect(driftDismissed("~/work/other", TARGET)).toBe(false);
  });

  it("is reflected immediately, not at some later unrelated render", () => {
    // `$state(new Set())` is not deep-proxied in Svelte 5, so an implementation
    // that called `.add()` instead of reassigning would leave the dismiss
    // button looking dead and then act retroactively. Reading straight back is
    // the closest a non-component test gets to that; the reassign discipline is
    // what makes it true inside a component too.
    dismissDrift(CLAUDE, TARGET);
    expect(driftDismissed(CLAUDE, TARGET)).toBe(true);
  });

  it("does not confuse two pairs that would collide under a joined key", () => {
    // Any delimiter can legally appear in a POSIX folder name, and a joined key
    // then makes two different pairs identical: joining on "|", both of these
    // become "~/a|~/b|~/c", so dismissing one silently suppresses the other.
    // Length-prefixing reserves no character and has no such case.
    dismissDrift("~/a|~/b", "~/c");
    expect(driftDismissed("~/a", "~/b|~/c")).toBe(false);
  });
});

describe("session backstop", () => {
  it("goes quiet for every pair once the limit is reached", () => {
    // The permanent-drift user: parks Claude in one folder, edits everywhere.
    // Per-pair dismissal alone hands them a fresh pill for every folder, forever.
    for (let i = 0; i < SESSION_DISMISS_LIMIT; i++) {
      dismissDrift(CLAUDE, `~/projects/p${i}`);
    }
    expect(driftDismissed(CLAUDE, "~/never/seen/before")).toBe(true);
  });

  it("does not go quiet one dismissal early", () => {
    for (let i = 0; i < SESSION_DISMISS_LIMIT - 1; i++) {
      dismissDrift(CLAUDE, `~/projects/p${i}`);
    }
    expect(driftDismissed(CLAUDE, "~/never/seen/before")).toBe(false);
  });

  it("asks the caller to announce the backstop exactly once", () => {
    // Silently going quiet would make "Claude is in the right folder now" and
    // "Tandem stopped mentioning it" look identical — opposite facts.
    const announcements: boolean[] = [];
    for (let i = 0; i < SESSION_DISMISS_LIMIT + 2; i++) {
      announcements.push(dismissDrift(CLAUDE, `~/projects/p${i}`));
    }
    expect(announcements.filter(Boolean)).toHaveLength(1);
    expect(announcements[SESSION_DISMISS_LIMIT - 1]).toBe(true);
  });
});

describe("permanent opt-out", () => {
  it("suppresses everything and reports success when storage works", () => {
    expect(optOutOfDriftNudge()).toBe(true);
    expect(driftNudgeOptedOut()).toBe(true);
    expect(driftDismissed(CLAUDE, TARGET)).toBe(true);
  });

  it("still suppresses for the session when storage throws, and says so", () => {
    // Incognito / storage-disabled. Returning false is what lets the caller
    // promise only what it can keep — a session, not forever.
    const spy = denyStorage("setItem");
    try {
      expect(optOutOfDriftNudge()).toBe(false);
      expect(driftDismissed(CLAUDE, TARGET)).toBe(true);
    } finally {
      spy.mockRestore();
    }
  });

  it("treats an unreadable preference as not-opted-out", () => {
    // Failing the other way would silently disable the feature for anyone whose
    // browser blocks storage reads. Seed the persisted opt-out FIRST so a
    // working `getItem` really would answer "opted out" — otherwise this passes
    // on the default and proves nothing.
    localStorage.setItem("tandem:cwd-drift-opt-out", "1");
    const spy = denyStorage("getItem");
    try {
      _resetDriftDismissForTests();
      expect(driftDismissed(CLAUDE, TARGET)).toBe(false);
    } finally {
      spy.mockRestore();
    }
  });
});

describe("one-time explainer", () => {
  it("claims exactly once", () => {
    expect(noteDriftSeen()).toBe(true);
    expect(noteDriftSeen()).toBe(false);
    expect(noteDriftSeen()).toBe(false);
  });

  it("stays claimed across a fresh session when storage persists it", () => {
    expect(noteDriftSeen()).toBe(true);
    // Simulate a reload: module session state resets, localStorage does not.
    // `_resetDriftDismissForTests` clears both, so re-set the persisted half.
    localStorage.setItem("tandem:cwd-drift-seen", "1");
    expect(noteDriftSeen()).toBe(false);
  });

  it("degrades to once-per-session when storage is unavailable", () => {
    const spy = vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("denied");
    });
    try {
      expect(noteDriftSeen()).toBe(true);
      expect(noteDriftSeen()).toBe(false);
    } finally {
      spy.mockRestore();
    }
  });
});
