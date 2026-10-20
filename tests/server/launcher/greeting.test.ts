/**
 * `first-run-greeting.json` (#2197): the one-time hello is owed on a first
 * install and once for everyone on the first run of v1.0, and every failure
 * reads as "not owed" — a missed hello costs less than Claude acting unasked
 * twice.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  armFirstRunGreeting,
  greetingPath,
  isGreetingOwed,
  markGreeted,
} from "../../../src/server/launcher/greeting.js";
import { isV1Release } from "../../../src/server/version-check.js";

let base: string;

beforeEach(() => {
  base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "greeting-")));
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(base, { recursive: true, force: true });
});

const write = (record: unknown) => fs.writeFileSync(greetingPath(base), JSON.stringify(record));

describe("isV1Release", () => {
  it.each([
    ["1.0.0", true],
    ["1.4.2", true],
    ["2.0.0", true],
    ["0.29.0", false],
    ["1.0.0-rc.1", false],
    ["0.0.0-dev", false],
    ["", false],
    [undefined, false],
  ])("%s → %s", (v, want) => {
    expect(isV1Release(v)).toBe(want);
  });
});

describe("armFirstRunGreeting", () => {
  it("a first install owes the greeting", async () => {
    expect(await armFirstRunGreeting(base, { firstInstall: true, appVersion: "0.29.0" })).toBe(
      "armed",
    );
    expect(isGreetingOwed(base)).toBe(true);
  });

  it("an existing user upgrading within 0.x is not on a first run", async () => {
    expect(await armFirstRunGreeting(base, { firstInstall: false, appVersion: "0.29.0" })).toBe(
      "unchanged",
    );
    expect(isGreetingOwed(base)).toBe(false);
    expect(fs.existsSync(greetingPath(base))).toBe(false);
  });

  it("the first run of v1.0 owes it to everyone — no record, or one greeted before v1.0", async () => {
    expect(await armFirstRunGreeting(base, { firstInstall: false, appVersion: "1.0.0" })).toBe(
      "armed",
    );
    expect(isGreetingOwed(base)).toBe(true);
    write({ version: 1, state: "done", greetedOn: "0.29.0" });
    expect(await armFirstRunGreeting(base, { firstInstall: false, appVersion: "1.0.0" })).toBe(
      "armed",
    );
    expect(isGreetingOwed(base)).toBe(true);
  });

  it("greeted on v1.0 already: never again", async () => {
    write({ version: 1, state: "done", greetedOn: "1.0.0" });
    expect(await armFirstRunGreeting(base, { firstInstall: false, appVersion: "1.2.0" })).toBe(
      "unchanged",
    );
    expect(isGreetingOwed(base)).toBe(false);
  });

  it("a release candidate does not spend the v1.0 greeting", async () => {
    write({ version: 1, state: "done", greetedOn: "0.29.0" });
    expect(await armFirstRunGreeting(base, { firstInstall: false, appVersion: "1.0.0-rc.1" })).toBe(
      "unchanged",
    );
    expect(isGreetingOwed(base)).toBe(false);
  });

  it("an owed greeting stays owed across boots until it is delivered", async () => {
    await armFirstRunGreeting(base, { firstInstall: true, appVersion: "0.29.0" });
    expect(await armFirstRunGreeting(base, { firstInstall: false, appVersion: "0.29.0" })).toBe(
      "unchanged",
    );
    expect(isGreetingOwed(base)).toBe(true);
  });

  it("an unreadable record arms nothing and is left alone", async () => {
    fs.writeFileSync(greetingPath(base), "{ truncated");
    expect(await armFirstRunGreeting(base, { firstInstall: true, appVersion: "1.0.0" })).toBe(
      "unchanged",
    );
    expect(fs.readFileSync(greetingPath(base), "utf8")).toBe("{ truncated");
  });
});

describe("isGreetingOwed / markGreeted", () => {
  it("done stops it", async () => {
    write({ version: 1, state: "owed" });
    expect(isGreetingOwed(base)).toBe(true);
    await markGreeted(base, "0.29.0");
    expect(isGreetingOwed(base)).toBe(false);
    expect(JSON.parse(fs.readFileSync(greetingPath(base), "utf8"))).toEqual({
      version: 1,
      state: "done",
      greetedOn: "0.29.0",
    });
  });

  it.each([
    ["no file", null],
    ["bad JSON", "{"],
    ["an unknown state", JSON.stringify({ version: 1, state: "maybe" })],
    ["no version", JSON.stringify({ state: "owed" })],
  ])("%s reads as not owed", (_l, raw) => {
    if (raw !== null) fs.writeFileSync(greetingPath(base), raw);
    expect(isGreetingOwed(base)).toBe(false);
  });

  it("a directory in its place reads as not owed", () => {
    fs.mkdirSync(greetingPath(base));
    expect(isGreetingOwed(base)).toBe(false);
  });
});
