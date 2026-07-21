import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { hideFromAI, readLiveMode, readModeState } from "../../src/server/mode.js";
import { getOrCreateDocument } from "../../src/server/yjs/provider.js";
import { CTRL_ROOM, Y_MAP_MODE, Y_MAP_USER_AWARENESS } from "../../src/shared/constants.js";
import { withInternal } from "../../src/shared/origins.js";

// WS-A2 Phase 1: `src/server/mode.ts` is the server-authoritative source for
// "what mode are we in, and should the AI see this record?" — the single seam
// the four delivery surfaces read to enforce the Solo privacy hold.

/** Write a raw value into CTRL_ROOM's mode key (raw so the garbage-value test
 *  can plant a non-enum value the schema must `.catch`). */
function setModeRaw(value: unknown) {
  const ctrl = getOrCreateDocument(CTRL_ROOM);
  withInternal(ctrl, () => ctrl.getMap(Y_MAP_USER_AWARENESS).set(Y_MAP_MODE, value));
}

function clearMode() {
  const ctrl = getOrCreateDocument(CTRL_ROOM);
  withInternal(ctrl, () => ctrl.getMap(Y_MAP_USER_AWARENESS).delete(Y_MAP_MODE));
}

beforeEach(clearMode);
afterEach(clearMode);

describe("readModeState (three-state)", () => {
  it("returns 'solo' when mode is solo", () => {
    setModeRaw("solo");
    expect(readModeState()).toBe("solo");
  });

  it("returns 'tandem' when mode is tandem", () => {
    setModeRaw("tandem");
    expect(readModeState()).toBe("tandem");
  });

  it("returns 'indeterminate' when the mode key is absent (restart / lost session)", () => {
    // Genuine absence is the fail-closed signal — distinct from a garbage value.
    expect(readModeState()).toBe("indeterminate");
  });

  it("returns 'tandem' (schema default) for a present-but-garbage value", () => {
    setModeRaw("banana");
    expect(readModeState()).toBe("tandem");
  });
});

describe("readLiveMode (two-state, user-facing)", () => {
  it("collapses indeterminate to the default 'tandem'", () => {
    expect(readLiveMode()).toBe("tandem");
  });

  it("passes solo through", () => {
    setModeRaw("solo");
    expect(readLiveMode()).toBe("solo");
  });

  it("passes tandem through", () => {
    setModeRaw("tandem");
    expect(readLiveMode()).toBe("tandem");
  });
});

describe("hideFromAI truth table", () => {
  const userRec = { author: "user" };
  const claudeRec = { author: "claude" };
  const heldUserRec = { author: "user", heldInSolo: true };
  const unheldUserRec = { author: "user", heldInSolo: false };

  it("solo: hides user-authored records regardless of the marker", () => {
    expect(hideFromAI(userRec, "solo")).toBe(true);
    expect(hideFromAI(unheldUserRec, "solo")).toBe(true);
  });

  it("solo: does not hide claude/import records", () => {
    expect(hideFromAI(claudeRec, "solo")).toBe(false);
    expect(hideFromAI({ author: "import" }, "solo")).toBe(false);
  });

  it("tandem: hides nothing", () => {
    expect(hideFromAI(userRec, "tandem")).toBe(false);
    expect(hideFromAI(heldUserRec, "tandem")).toBe(false);
    expect(hideFromAI(claudeRec, "tandem")).toBe(false);
  });

  it("indeterminate: hides exactly the records carrying the persisted heldInSolo marker", () => {
    expect(hideFromAI(heldUserRec, "indeterminate")).toBe(true);
    expect(hideFromAI(unheldUserRec, "indeterminate")).toBe(false);
    expect(hideFromAI(userRec, "indeterminate")).toBe(false); // marker absent → surfaces
    expect(hideFromAI(claudeRec, "indeterminate")).toBe(false);
  });
});
