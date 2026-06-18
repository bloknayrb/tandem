import { describe, expect, it } from "vitest";
import { connectionShouldBeReadOnly } from "../../src/server/license/connection-gate.js";
import { CTRL_ROOM } from "../../src/shared/constants.js";

// Use the real constant, not a hardcoded literal — a rename of CTRL_ROOM must
// not silently desync this test from the gate it guards.
const CTRL = CTRL_ROOM;

describe("connectionShouldBeReadOnly (Surface A)", () => {
  it("read-only for a document room when restricted", () => {
    expect(connectionShouldBeReadOnly("doc-abc", CTRL, "restricted")).toBe(true);
  });

  it("NOT read-only for CTRL_ROOM even when restricted (chat/mode/awareness stay live)", () => {
    expect(connectionShouldBeReadOnly(CTRL, CTRL, "restricted")).toBe(false);
  });

  it("NOT read-only when trial", () => {
    expect(connectionShouldBeReadOnly("doc-abc", CTRL, "trial")).toBe(false);
  });

  it("NOT read-only when licensed", () => {
    expect(connectionShouldBeReadOnly("doc-abc", CTRL, "licensed")).toBe(false);
  });
});
