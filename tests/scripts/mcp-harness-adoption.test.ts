import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const TESTS = path.join(ROOT, "tests");

/**
 * Every test that links an `InMemoryTransport` pair to drive MCP tools goes
 * through `tests/helpers/mcp-harness.ts` — after #1689 migrated six files and
 * #2040 the remaining ten. Nothing enforced that (#2049): the "1 remaining"
 * figure lived only in a PR body, `biome.json` has `"linter": {"enabled":
 * false}`, and no sweep or drift guard shipped. File #12 could land the
 * hand-rolled shape exactly the way files #1–#11 did, and the only thing that
 * would notice was a human re-running a probe by hand.
 *
 * Three things here are load-bearing, and each is a way this guard could be
 * written so that it passes while seeing nothing:
 *
 * 1. **The harness file itself is excluded.** It defines `createLinkedPair` and
 *    has no reason to import itself. The probe was published once in a form
 *    that matched it, reporting 12 where the answer was 11 — a wrong
 *    reproducible command inside a filed follow-up ages into a wrong
 *    conclusion. That exclusion is the corrected form.
 *
 * 2. **Set equality, not a count.** A count passes when one file is migrated
 *    and another hand-rolled in the same PR. The allowlist names the file, so a
 *    newly-legitimate exception is a one-line reviewed addition and a new
 *    hand-rolled copy fails closed.
 *
 * 3. **The exemption pins its REASON, not just its path.**
 *    `mcp-stdio-ports.test.ts` hands `serverTransport` to
 *    `startMcpServerStdio` and so has no registrar list to pass — the harness
 *    cannot express it. If that stops being true, the carve-out should be
 *    re-examined rather than inherited.
 *
 * Scope (ADR-051's one-owner-per-fact rule): this file owns "who links a
 * transport pair". No other test in `tests/` asserts it.
 */

/** Files that may link a transport pair without going through the harness. */
const ALLOWLIST = ["tests/server/mcp-stdio-ports.test.ts"];

/** Defines the pair; excluded because it cannot import itself. */
const HARNESS = "tests/helpers/mcp-harness.ts";

const LINKS_A_PAIR = "InMemoryTransport.createLinkedPair";
const USES_HARNESS = "helpers/mcp-harness";

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules") continue;
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (entry.endsWith(".ts") || entry.endsWith(".mts")) out.push(full);
  }
  return out;
}

/** Repo-relative, forward-slashed — `path.basename` and friends split on the
 *  platform separator, and this must read the same on Windows and Linux. */
function rel(file: string): string {
  return path.relative(ROOT, file).split(path.sep).join("/");
}

function filesLinkingAPair(): string[] {
  return walk(TESTS)
    .filter((f) => readFileSync(f, "utf8").includes(LINKS_A_PAIR))
    .map(rel)
    .sort();
}

describe("in-memory MCP harness adoption", () => {
  it("finds the harness itself, so the scan is known to work", () => {
    // Guards the guard: a walk that silently returned nothing would make every
    // assertion below pass vacuously, which is the #1229 failure mode — a gate
    // reporting success when it could not evaluate.
    const linking = filesLinkingAPair();
    expect(linking).toContain(HARNESS);
    expect(linking.length).toBeGreaterThanOrEqual(2);
  });

  it("routes every transport-pair test through the harness, bar the allowlist", () => {
    const offenders = filesLinkingAPair()
      .filter((f) => f !== HARNESS)
      .filter((f) => !readFileSync(path.join(ROOT, f), "utf8").includes(USES_HARNESS));

    expect(
      offenders,
      [
        "These test files link an InMemoryTransport pair by hand instead of calling",
        "setupMcpServer from tests/helpers/mcp-harness.ts.",
        "Use the harness, or — if the harness genuinely cannot express this case —",
        "add the file to ALLOWLIST here with the reason, so the exception is reviewed.",
      ].join(" "),
    ).toEqual(ALLOWLIST);
  });

  it("keeps the allowlisted file exempt for the reason it was exempted", () => {
    // The carve-out is not "this path is special" but "the harness takes a
    // registrar list and this file has none to give". Pinning the reason means
    // a rewrite that removes it surfaces here instead of inheriting the pass.
    for (const allowed of ALLOWLIST) {
      const source = readFileSync(path.join(ROOT, allowed), "utf8");
      expect(source, `${allowed} no longer drives the stdio server`).toContain(
        "startMcpServerStdio",
      );
      expect(source, `${allowed} should still be the hand-rolled case`).toContain(LINKS_A_PAIR);
    }
  });
});
