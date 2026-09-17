/**
 * Pure tests for `isLockFromPriorBoot` / `systemBootMs` (#2038). No
 * filesystem, no process spawning — just the boot-time-evidence predicate.
 */

import os from "node:os";
import { describe, expect, it } from "vitest";
import { isLockFromPriorBoot, systemBootMs } from "../../../src/server/annotations/lockfile.js";

describe("isLockFromPriorBoot", () => {
  // Fixed, not derived at call time — a predicate that ignores `nowBootMs`
  // (e.g. `startedAtMs < Date.now() - MARGIN`) must be caught here, not
  // coincidentally passed because `boot` happens to equal `Date.now()`.
  const boot = Date.now() - 86_400_000;

  it("is true when startedAtMs predates the boot beyond the margin", () => {
    expect(isLockFromPriorBoot({ pid: 1, startedAtMs: boot - 10_000 }, boot)).toBe(true);
  });

  it("is false at the boot instant itself", () => {
    expect(isLockFromPriorBoot({ pid: 1, startedAtMs: boot }, boot)).toBe(false);
  });

  it("is false after the boot instant", () => {
    expect(isLockFromPriorBoot({ pid: 1, startedAtMs: boot + 10_000 }, boot)).toBe(false);
  });

  it("is false within the safety margin before the boot instant (margin direction is toward refuse)", () => {
    expect(isLockFromPriorBoot({ pid: 1, startedAtMs: boot - 1_000 }, boot)).toBe(false);
  });

  it("is false when startedAtMs is missing — no evidence, no reclaim", () => {
    expect(isLockFromPriorBoot({ pid: 1 }, boot)).toBe(false);
  });

  it("is false for a recent startedAtMs checked against a stale 24h-old boot estimate", () => {
    // The case a nowBootMs-ignoring shape gets wrong: a bare
    // `startedAtMs < Date.now() - MARGIN` would say true here, because
    // `Date.now() - 60_000` genuinely predates `Date.now()`. The real
    // predicate compares against the passed-in boot estimate instead.
    expect(isLockFromPriorBoot({ pid: 1, startedAtMs: Date.now() - 60_000 }, boot)).toBe(false);
  });

  it("systemBootMs() actually derives from os.uptime(), not a stub", () => {
    expect(Math.abs(systemBootMs() - (Date.now() - os.uptime() * 1000))).toBeLessThan(2_000);
    expect(Date.now() - systemBootMs()).toBeGreaterThan(1_000);
  });
});
