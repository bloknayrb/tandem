import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { MIN_NODE_VERSION } from "../../src/cli/doctor.js";

/**
 * #1442 fixed `tandem doctor` to check against `MIN_NODE_VERSION` (which a
 * separate test pins to `package.json`'s `engines.node`) instead of a stale
 * major-only `>= 22`. That closed the CODE half of "the floor is stated four
 * ways" — but four prose copies are still hand-maintained: `CONTRIBUTING.md`,
 * `docs/troubleshooting.md`, `README.md`, and `docs/mcp-tools.md`'s example
 * `tandem doctor` output. README alone had already drifted to a bare `22.12`
 * (missing the patch component) by the time this test was written, which is
 * exactly the kind of fifth spelling the issue's own "Fix:" asked to prevent
 * by stating the floor once, somewhere the others can cite.
 *
 * `MIN_NODE_VERSION` is that one place — every prose copy below must contain
 * it verbatim, so a future bump to the constant either updates all four docs
 * in the same PR or fails this test instead of silently drifting again.
 */

const REPO_ROOT = join(import.meta.dirname, "..", "..");

const CLAIMING_FILES = [
  "CONTRIBUTING.md",
  "docs/troubleshooting.md",
  "README.md",
  "docs/mcp-tools.md",
];

describe("Node version floor prose claims (#1442)", () => {
  it.each(CLAIMING_FILES)("%s states the current MIN_NODE_VERSION verbatim", (rel) => {
    const doc = readFileSync(join(REPO_ROOT, rel), "utf-8");
    expect(doc, `${rel} does not contain "${MIN_NODE_VERSION}"`).toContain(MIN_NODE_VERSION);
  });
});
