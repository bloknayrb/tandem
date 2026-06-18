import { describe, expect, it } from "vitest";
import { connectionShouldBeReadOnly } from "../../src/server/license/connection-gate.js";

const CTRL = "__tandem_ctrl__";

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
