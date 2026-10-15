/**
 * `v1-walkthrough.json` (#2198): every user walks through the setup wizard on
 * the first v1.0 launch. No record is pending; Keep or a successful Apply
 * writes it; an unreadable record reads as not pending, so a wedged file never
 * traps the user behind the wizard every launch.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  isWalkthroughPending,
  markWalkthroughConfirmed,
  TANDEM_FORCE_V1_WALKTHROUGH_ENV,
  walkthroughPath,
} from "../../../src/server/integrations/walkthrough.js";
import { TANDEM_DISABLE_FIRST_RUN_WIZARD_ENV } from "../../../src/shared/constants.js";

let base: string;
/** No ambient flags: the suite's own env must not decide these cases. */
const NO_ENV: NodeJS.ProcessEnv = {};

beforeEach(() => {
  base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "walkthrough-")));
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(base, { recursive: true, force: true });
});

describe("isWalkthroughPending", () => {
  it("owed on a v1.0 release with no record — upgraders included, nothing written at boot", () => {
    expect(isWalkthroughPending(base, "1.0.0", NO_ENV)).toBe(true);
    expect(fs.existsSync(walkthroughPath(base))).toBe(false);
  });

  it.each(["0.28.0", "1.0.0-rc.1", "0.0.0-dev"])("not owed on %s", (v) => {
    expect(isWalkthroughPending(base, v, NO_ENV)).toBe(false);
  });

  it("Keep on 1.0.0 ends it, for every later v1 release too", async () => {
    await markWalkthroughConfirmed(base, "1.0.0", "keep");
    expect(isWalkthroughPending(base, "1.0.0", NO_ENV)).toBe(false);
    expect(isWalkthroughPending(base, "1.3.1", NO_ENV)).toBe(false);
    expect(JSON.parse(fs.readFileSync(walkthroughPath(base), "utf8"))).toEqual({
      version: 1,
      confirmedOn: "1.0.0",
      via: "keep",
    });
  });

  it("the force switch smoke-tests a release candidate, and confirming there still owes 1.0.0", async () => {
    const force = { [TANDEM_FORCE_V1_WALKTHROUGH_ENV]: "1" };
    expect(isWalkthroughPending(base, "1.0.0-rc.1", force)).toBe(true);
    await markWalkthroughConfirmed(base, "1.0.0-rc.1", "apply");
    expect(isWalkthroughPending(base, "1.0.0-rc.1", force)).toBe(false);
    expect(isWalkthroughPending(base, "1.0.0", NO_ENV)).toBe(true);
  });

  it("the E2E off switch wins over everything, the force switch included", () => {
    const env = {
      [TANDEM_DISABLE_FIRST_RUN_WIZARD_ENV]: "1",
      [TANDEM_FORCE_V1_WALKTHROUGH_ENV]: "1",
    };
    expect(isWalkthroughPending(base, "1.0.0", env)).toBe(false);
  });

  it.each([
    ["bad JSON", "{"],
    ["an unknown via", JSON.stringify({ version: 1, confirmedOn: "1.0.0", via: "maybe" })],
    ["no confirmedOn", JSON.stringify({ version: 1, via: "keep" })],
    ["an oversized file", JSON.stringify({ pad: "x".repeat(2048) })],
  ])("%s reads as not owed — never a modal every launch", (_l, raw) => {
    fs.writeFileSync(walkthroughPath(base), raw);
    expect(isWalkthroughPending(base, "1.0.0", NO_ENV)).toBe(false);
  });

  it("a directory in its place reads as not owed", () => {
    fs.mkdirSync(walkthroughPath(base));
    expect(isWalkthroughPending(base, "1.0.0", NO_ENV)).toBe(false);
  });
});
