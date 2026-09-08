import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Pins the claim that #1906 is about: `enforceLoopbackMutation` is mounted on
 * `/api` and on nothing else, so `POST /mcp` reaches the same internals with no
 * loopback check.
 *
 * Four documents now assert that in prose — `docs/security.md` (twice: the `/api`
 * invariant section and the Open findings entry), `docs/configuration.md`,
 * `docs/decisions.md` (ADR-046) and `docs/mcp-tools.md`'s route index — because a
 * reader was taking "LAN peers may read `/api`; their writes are refused" as a
 * whole-server property. Nothing checked any of it against source.
 *
 * **Why this test rather than review.** The claim is not a stable fact: closing
 * #1906 means mounting a loopback gate on `/mcp`, which makes all four passages
 * false at once. That is the good outcome, and it is exactly the change most
 * likely to ship without anyone recalling that four documents describe the gap.
 * Without this test the register would keep announcing an exposure that no longer
 * exists — the same rot that left #1420 reading as open for nine days after its
 * issue closed.
 *
 * `tests/docs/loopback-gate-claims.test.ts` does NOT cover this: its corpus scan
 * keys on `assertLoopbackForMutation`, a different function, and on the per-handler
 * gate enumeration. It would stay green through every failure below.
 *
 * So this file fails in BOTH directions. If the mount count changes, the prose is
 * stale and must be revisited; if the prose stops naming the asymmetry while the
 * mount is still `/api`-only, the correction has been silently reverted.
 */

const REPO_ROOT = join(import.meta.dirname, "..", "..");
const read = (relative: string): string => readFileSync(join(REPO_ROOT, relative), "utf-8");

const SERVER_TS = read("src/server/mcp/server.ts");

/**
 * `app.use(<path>, enforceLoopbackMutation)` mount sites, as [path] pairs.
 *
 * Deliberately matched on the `app.use` CALL rather than on any occurrence of the
 * symbol: `server.ts` names `enforceLoopbackMutation` in its import, and twice more
 * in the comment block at :674-701 that explains the middleware ordering. A bare
 * symbol grep counts four and tells you nothing about where it is mounted, which is
 * the only fact the docs actually assert.
 */
function mountPaths(): string[] {
  return [
    ...SERVER_TS.matchAll(/app\.use\(\s*(["'`])([^"'`]+)\1\s*,\s*enforceLoopbackMutation/g),
  ].map((m) => m[2]);
}

describe("the /api-only mount of enforceLoopbackMutation (#1906)", () => {
  it("is mounted on exactly one path, and that path is /api", () => {
    const mounts = mountPaths();

    // Positive control. A regex that matched nothing would satisfy a bare
    // "never mounted on /mcp" assertion by finding no counterexample, which is
    // the failure this repo has shipped before: an empty filter result reads
    // identically to a clean one.
    expect(
      mounts,
      "found no enforceLoopbackMutation mount at all — the matcher is broken",
    ).not.toEqual([]);

    expect(
      mounts,
      "enforceLoopbackMutation's mount set changed. If a /mcp gate was added, #1906 is resolved " +
        "and the prose in docs/security.md, docs/configuration.md, docs/decisions.md and " +
        "docs/mcp-tools.md now describes an exposure that no longer exists — update all four.",
    ).toEqual(["/api"]);
  });

  it("the docs that scope the claim still say so", () => {
    // The other direction: the mount is still /api-only, so every passage that
    // was corrected must still carry the correction. Keyed on the asymmetry
    // being NAMED, not on exact wording, so prose can be rewritten freely.
    const carriers: Array<[string, RegExp]> = [
      ["docs/security.md", /scoped to `\/api` and does not reach `\/mcp`/],
      ["docs/configuration.md", /property of `\/api`, not of the server/],
      ["docs/decisions.md", /scoped to `\/api` on purpose/],
      ["docs/mcp-tools.md", /`enforceLoopbackMutation` is \*\*not\*\*/],
    ];

    const missing = carriers
      .filter(([rel, pattern]) => !pattern.test(read(rel)))
      .map(([rel]) => rel);
    expect(
      missing,
      "these files no longer scope the /api write-refusal claim, but enforceLoopbackMutation is " +
        "still mounted only on /api — the #1906 correction was reverted or paraphrased away",
    ).toEqual([]);
  });

  it("#1906 is reachable from every file that carries the claim", () => {
    // A scoped claim with no tracker reference is a dead end for the reader who
    // wants to know whether it is still true.
    for (const rel of [
      "docs/security.md",
      "docs/configuration.md",
      "docs/decisions.md",
      "docs/mcp-tools.md",
      "docs/troubleshooting.md",
    ]) {
      expect(read(rel), `${rel} scopes the claim without pointing at #1906`).toMatch(
        /#1906|issues\/1906/,
      );
    }
  });
});
