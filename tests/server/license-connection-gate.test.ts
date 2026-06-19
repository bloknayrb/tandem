import { describe, expect, it } from "vitest";
import {
  applyConnectionGate,
  connectionShouldBeReadOnly,
} from "../../src/server/license/connection-gate.js";
import type { LicenseState } from "../../src/server/license/license-types.js";
import { CTRL_ROOM } from "../../src/shared/constants.js";

// Use the real constant, not a hardcoded literal — a rename of CTRL_ROOM must
// not silently desync this test from the gate it guards.
const CTRL = CTRL_ROOM;

const RESTRICTED: LicenseState = {
  gateActive: true,
  status: "restricted",
  updateWindowCurrent: false,
};
const TRIAL: LicenseState = {
  gateActive: true,
  status: "trial",
  updateWindowCurrent: false,
  trial: {
    firstRunAt: "2026-01-01T00:00:00Z",
    expiresAt: "2026-01-15T00:00:00Z",
    daysRemaining: 7,
  },
};
const DARK: LicenseState = { gateActive: false };

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

// The load-bearing half of Surface A is the ASSIGNMENT, not the predicate. Test
// the outcome on a connection stub (the predicate alone is the "callback fired,
// not outcome" smell that previously hid a Surface A regression on this PR).
describe("applyConnectionGate (Surface A — outcome on the connection)", () => {
  it("restricted ⇒ sets readOnly on a document-room connection and reports it clamped", () => {
    const connection: { readOnly?: boolean } = {};
    const clamped = applyConnectionGate(connection, "doc-abc", RESTRICTED);
    expect(clamped).toBe(true);
    expect(connection.readOnly).toBe(true);
  });

  it("restricted ⇒ leaves CTRL_ROOM connection writable", () => {
    const connection: { readOnly?: boolean } = {};
    const clamped = applyConnectionGate(connection, CTRL, RESTRICTED);
    expect(clamped).toBe(false);
    expect(connection.readOnly).toBeUndefined();
  });

  it("trial ⇒ leaves a document-room connection writable", () => {
    const connection: { readOnly?: boolean } = {};
    expect(applyConnectionGate(connection, "doc-abc", TRIAL)).toBe(false);
    expect(connection.readOnly).toBeUndefined();
  });

  it("dark (gate inactive) ⇒ no-op", () => {
    const connection: { readOnly?: boolean } = {};
    expect(applyConnectionGate(connection, "doc-abc", DARK)).toBe(false);
    expect(connection.readOnly).toBeUndefined();
  });
});
