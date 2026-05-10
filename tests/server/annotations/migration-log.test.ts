import { afterEach, describe, expect, it, vi } from "vitest";
import {
  logLegacyMigration,
  relaySanitizationEvent,
  resetMigrationLog,
} from "../../../src/server/annotations/migration-log.js";
import type { SanitizationEvent } from "../../../src/shared/sanitize.js";

afterEach(() => {
  resetMigrationLog();
  vi.restoreAllMocks();
});

describe("relaySanitizationEvent — routing", () => {
  it("routes flag-to-note to logLegacyMigration", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    relaySanitizationEvent("hash1", { kind: "flag-to-note", id: "a" });
    expect(spy).toHaveBeenCalledWith(expect.stringContaining("flag-to-note"));
  });

  it("routes audience-derived to logLegacyMigration", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    relaySanitizationEvent("hash1", { kind: "audience-derived", id: "a" });
    expect(spy).toHaveBeenCalledWith(expect.stringContaining("audience-derived"));
  });

  it("routes question-to-comment to logLegacyMigration", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    relaySanitizationEvent("hash1", { kind: "question-to-comment", id: "a" });
    expect(spy).toHaveBeenCalledWith(expect.stringContaining("question-to-comment"));
  });

  it("routes import-note-to-comment to logLegacyMigration", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    relaySanitizationEvent("hash1", { kind: "import-note-to-comment", id: "a" });
    expect(spy).toHaveBeenCalledWith(expect.stringContaining("import-note-to-comment"));
  });
});

describe("relaySanitizationEvent — dedup for audience-derived", () => {
  it("logs audience-derived only once per docHash", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const event: SanitizationEvent = { kind: "audience-derived", id: "a" };
    relaySanitizationEvent("hash1", event);
    relaySanitizationEvent("hash1", { kind: "audience-derived", id: "b" });
    relaySanitizationEvent("hash1", { kind: "audience-derived", id: "c" });
    const audienceLogs = spy.mock.calls.filter((c) => String(c[0]).includes("audience-derived"));
    expect(audienceLogs).toHaveLength(1);
  });

  it("logs audience-derived once per distinct docHash", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const event: SanitizationEvent = { kind: "audience-derived", id: "a" };
    relaySanitizationEvent("hash1", event);
    relaySanitizationEvent("hash2", event);
    const audienceLogs = spy.mock.calls.filter((c) => String(c[0]).includes("audience-derived"));
    expect(audienceLogs).toHaveLength(2);
  });
});

describe("logLegacyMigration — direct dedup", () => {
  it("logs each kind once per docHash", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    logLegacyMigration("hash1", "flag-to-note");
    logLegacyMigration("hash1", "flag-to-note");
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("skips dedup when docHash is undefined", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    logLegacyMigration(undefined, "flag-to-note");
    logLegacyMigration(undefined, "flag-to-note");
    expect(spy).toHaveBeenCalledTimes(2);
  });
});
