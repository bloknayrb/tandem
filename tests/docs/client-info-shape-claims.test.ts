import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ImplementationSchema } from "@modelcontextprotocol/sdk/types.js";
import { describe, expect, it } from "vitest";

/**
 * Pins ADR-045 Decision 6's corrected `io.modelcontextprotocol/clientInfo`
 * shape against the SDK itself (#1332).
 *
 * WHY IT IS DERIVED FROM THE SDK, NOT FROM PROSE. The ADR previously said the
 * `Implementation` type "carries only `{name, version}`". That was wrong when
 * written — SDK 1.30.0 already declared six fields — and nothing in the repo
 * noticed for weeks, because the claim's only carriers were sentences and
 * `tests/docs/stateless-transport-claims.test.ts`'s `TOPIC` regex has no
 * clientInfo branch. Verified by restoring the wrong sentence in both carriers
 * (plus a fabricated `connectionId` field) and running `tests/docs/`: 60/60
 * green. A prose guard also structurally cannot catch the OTHER failure mode
 * here — an SDK release that adds or removes a field, leaving every word in the
 * repo unchanged and newly wrong. Reading the shape out of the installed
 * package catches both.
 *
 * WHAT IT DOES NOT PIN. `src/` contains no reference to `clientInfo` at all
 * (`grep -rn "getClientVersion\|clientInfo\|CLIENT_INFO" src/` is empty), so
 * this is forward-looking design prose with no code counterpart — there is no
 * behaviour to pin, only the fact the prose rests on.
 *
 * THE SPIKE'S LIST IS ASSERTED AGAINST THE SAME SOURCE, deliberately. Its
 * bullet describes `@modelcontextprotocol/core@2.0.0` and says that shape
 * matches the SDK's. Pinning it here means a divergence between the two — the
 * exact thing that would make the spike's "corroborates it" false — fails the
 * build rather than sitting unread.
 *
 * The CONCLUSION drawn from the shape is not pinnable and is not pinned: that
 * none of the fields is per-connection, so two concurrent Claude Code instances
 * send byte-identical values. A new field could be per-connection and this test
 * would still pass — but it would go red first, which is the point.
 */

const REPO_ROOT = join(import.meta.dirname, "..", "..");

/** The fact. Sorted so set comparisons read as sorted arrays in failure output. */
const SDK_FIELDS = Object.keys(ImplementationSchema.shape).sort();

const COUNT_WORDS = [
  "zero",
  "one",
  "two",
  "three",
  "four",
  "five",
  "six",
  "seven",
  "eight",
  "nine",
  "ten",
];

function read(...parts: string[]): string {
  return readFileSync(join(REPO_ROOT, ...parts), "utf-8");
}

/**
 * The backticked identifiers inside `text`, minus zod schema names
 * (`FooSchema`) — the spike's bullet names the schemas it composes as well as
 * the fields they contribute, and only the fields are the claim.
 */
function backtickedFields(text: string): string[] {
  return [...new Set([...text.matchAll(/`([A-Za-z][A-Za-z0-9]*)`/g)].map(([, id]) => id))]
    .filter((id) => !id.endsWith("Schema"))
    .sort();
}

/**
 * The span of `text` between two anchors, exclusive. Throws rather than
 * returning empty: a missing anchor means the passage was rewritten or deleted,
 * and a test that silently compares nothing to nothing is worse than a failure
 * naming the anchor that moved.
 */
function span(text: string, start: string, end: string, where: string): string {
  const from = text.indexOf(start);
  expect(from, `${where}: anchor not found — "${start}"`).toBeGreaterThanOrEqual(0);
  const to = text.indexOf(end, from + start.length);
  expect(to, `${where}: closing anchor not found — "${end}"`).toBeGreaterThan(from);
  return text.slice(from + start.length, to);
}

describe("clientInfo / Implementation shape claims (#1332)", () => {
  it("the SDK's Implementation type has more than the refuted {name, version}", () => {
    // Non-vacuity control on the fact itself. If a future SDK really did narrow
    // the type to two fields, the ADR's correction would need rewriting rather
    // than the tests below quietly re-passing against a two-element set.
    expect(SDK_FIELDS).toContain("name");
    expect(SDK_FIELDS).toContain("version");
    expect(SDK_FIELDS.length).toBeGreaterThan(2);
  });

  it("ADR-045 Decision 6 enumerates exactly the SDK's Implementation fields", () => {
    const decisions = read("docs", "decisions.md");
    const claim = span(
      decisions,
      "its type carries",
      "none of them per-connection",
      "docs/decisions.md",
    );
    expect(backtickedFields(claim)).toEqual(SDK_FIELDS);
  });

  it("the spike addendum's field list matches the same source, and its count is right", () => {
    const spike = read("docs", "spikes", "stateless-transport-probe.md");
    const claim = span(spike, "extends `BaseMetadataSchema`", "fields, matching what", "spike");
    expect(backtickedFields(claim)).toEqual(SDK_FIELDS);

    const countWord = COUNT_WORDS[SDK_FIELDS.length];
    expect(countWord, `no spelled-out word for ${SDK_FIELDS.length}`).toBeDefined();
    expect(claim).toContain(`— ${countWord} `);
  });
});
