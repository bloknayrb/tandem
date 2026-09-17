import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Pins the claim #1906 is about: `enforceLoopbackMutation` is mounted on `/api`
 * and on nothing else, so `POST /mcp` reaches the same mutations with no
 * loopback check.
 *
 * Five documents now say so in prose — `docs/security.md` (twice: the `/api`
 * invariant section and the Open findings entry), `docs/configuration.md`,
 * `docs/decisions.md` (ADR-046), `docs/mcp-tools.md`'s route index and
 * `docs/troubleshooting.md` — because each stated "LAN peers may read `/api`;
 * their writes are refused" in a way a reader took as a whole-server property.
 * Nothing checked any of it against source.
 *
 * **Why a test rather than review.** The claim is deliberately unstable: closing
 * #1906 means mounting a loopback gate on `/mcp`, which makes all five passages
 * false at once. That is the *good* outcome, and it is exactly the change most
 * likely to ship without anyone recalling that five documents describe the gap.
 * Without this, the register would keep announcing an exposure that no longer
 * exists — the rot that left #1420 reading as open for days after it closed.
 *
 * `tests/docs/loopback-gate-claims.test.ts` does NOT cover this. Its scan keys
 * on `assertLoopbackForMutation`, a different function, and on the per-handler
 * gate enumeration; it stays green through every failure below.
 *
 * So this file fails in BOTH directions. If the mount set changes, the prose is
 * stale and must be revisited. If the prose stops naming the asymmetry while the
 * mount is still `/api`-only, the correction was silently reverted.
 */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const read = (relative: string): string => readFileSync(path.join(ROOT, relative), "utf-8");

const SERVER_TS = read("src/server/mcp/server.ts");

/**
 * The `app.use(<path>, enforceLoopbackMutation)` mount sites, as path strings.
 *
 * Matched on the `app.use` CALL rather than on any occurrence of the symbol:
 * `server.ts` also names `enforceLoopbackMutation` in its import and in the
 * middleware-ordering comment above the mounts. A bare symbol grep counts
 * several and says nothing about where it is mounted, which is the only fact
 * these documents actually assert.
 *
 * The trailing `(?![\w$])` is load-bearing and was added because mutation
 * testing caught its absence: without it the symbol matches as a PREFIX, so
 * renaming the mounted middleware to `enforceLoopbackMutationRenamed` left this
 * function still reporting `["/api"]` and every assertion below still green.
 * That is the #1229 shape — a guard reporting success when it can no longer
 * evaluate — sitting inside the very check written to prevent it. A middleware
 * that merely shares the prefix is a different middleware.
 */
function mountPaths(): string[] {
  return [
    ...SERVER_TS.matchAll(
      /app\.use\(\s*(["'`])([^"'`]+)\1\s*,\s*enforceLoopbackMutation(?![\w$])/g,
    ),
  ].map((m) => m[2]);
}

describe("the /api-only mount of enforceLoopbackMutation (#1906)", () => {
  it("is mounted on exactly one path, and that path is /api", () => {
    const mounts = mountPaths();

    // Guards the guard. A regex that matched nothing would satisfy a bare
    // "never mounted on /mcp" assertion by finding no counterexample — the
    // #1229 failure mode of a gate reporting success when it could not
    // evaluate, and one this repo has shipped before.
    expect(
      mounts,
      "found no enforceLoopbackMutation mount at all — the matcher is broken",
    ).not.toEqual([]);

    expect(
      mounts,
      "enforceLoopbackMutation's mount set changed. If a /mcp gate was added, #1906 is resolved " +
        "and the prose in docs/security.md, docs/configuration.md, docs/decisions.md, " +
        "docs/mcp-tools.md and docs/troubleshooting.md now describes an exposure that no longer " +
        "exists — update all five.",
    ).toEqual(["/api"]);
  });

  it("authMiddleware IS mounted on /mcp, so the gap is the loopback gate alone", () => {
    // The finding is precise: /mcp is authenticated and Host-checked, and only
    // the loopback mutation gate is absent. Stating it loosely ("/mcp is
    // ungated") would overclaim, and the register says so explicitly.
    expect(SERVER_TS).toMatch(/app\.use\(\s*["']\/mcp["']\s*,\s*authMiddleware/);
  });

  it("the documents that scope the claim still say so", () => {
    // The other direction: the mount is still /api-only, so every passage that
    // was corrected must still carry its correction. Keyed on the asymmetry
    // being NAMED rather than on exact wording, so prose stays free to change.
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
