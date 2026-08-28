import { describe, expect, it } from "vitest";
import {
  kindOfOpenResult,
  type OpenFileResult,
  type OpenResultKind,
} from "../../src/server/documents/open.js";
import { openResultMessage } from "../../src/server/mcp/document.js";

/**
 * Characterization for ADR-034 Unit 7b, written BEFORE the result type changes.
 *
 * Two independent copies of one precedence exist today: `kindOfOpenResult`
 * (`documents/open.ts`) and the message chain `tandem_open` returns
 * (`mcp/document.ts`, extracted here as `openResultMessage`). They agree only
 * by inspection — nothing tied them together. 7b promotes that precedence to a
 * type discriminator, and promoting an ordering nobody pinned is how a
 * "refactor" silently changes which case wins.
 *
 * So: pin both, over the FULL cross product, including combinations the
 * pipeline cannot currently produce. The impossible ones are the point. Today
 * the booleans are disjoint by accident — the force branch hardcodes
 * `restoredFromSession: false` and `buildResult` hardcodes `alreadyOpen: false,
 * forceReloaded: false` — so only the precedence makes the mapping total. A
 * future restored-and-already-open path would resolve silently, and these rows
 * are what say which way.
 */

/** The three legacy booleans alone — the table rows carry bookkeeping fields too. */
function flags(c: Combination): Partial<OpenFileResult> {
  return {
    forceReloaded: c.forceReloaded,
    alreadyOpen: c.alreadyOpen,
    restoredFromSession: c.restoredFromSession,
  };
}

function result(overrides: Partial<OpenFileResult>): OpenFileResult {
  return {
    documentId: "doc-1",
    filePath: "/tmp/doc-1.md",
    fileName: "doc-1.md",
    format: "md",
    readOnly: false,
    source: "file",
    tokenEstimate: 0,
    pageEstimate: 0,
    restoredFromSession: false,
    alreadyOpen: false,
    forceReloaded: false,
    ...overrides,
  };
}

interface Combination {
  forceReloaded: boolean;
  alreadyOpen: boolean;
  restoredFromSession: boolean;
  kind: OpenResultKind;
  /** False for combinations no current code path can produce. */
  reachable: boolean;
}

/** All 8 combinations of the three legacy booleans, with the kind each resolves to. */
const COMBINATIONS: Combination[] = [
  {
    forceReloaded: false,
    alreadyOpen: false,
    restoredFromSession: false,
    kind: "fresh",
    reachable: true,
  },
  {
    forceReloaded: false,
    alreadyOpen: false,
    restoredFromSession: true,
    kind: "restored",
    reachable: true,
  },
  {
    forceReloaded: false,
    alreadyOpen: true,
    restoredFromSession: false,
    kind: "already-open",
    reachable: true,
  },
  {
    forceReloaded: true,
    alreadyOpen: false,
    restoredFromSession: false,
    kind: "force-reloaded",
    reachable: true,
  },
  {
    forceReloaded: false,
    alreadyOpen: true,
    restoredFromSession: true,
    kind: "already-open",
    reachable: false,
  },
  {
    forceReloaded: true,
    alreadyOpen: false,
    restoredFromSession: true,
    kind: "force-reloaded",
    reachable: false,
  },
  {
    forceReloaded: true,
    alreadyOpen: true,
    restoredFromSession: false,
    kind: "force-reloaded",
    reachable: false,
  },
  {
    forceReloaded: true,
    alreadyOpen: true,
    restoredFromSession: true,
    kind: "force-reloaded",
    reachable: false,
  },
];

describe("kindOfOpenResult — the full cross product, not just the reachable four", () => {
  it("covers every combination of the three booleans", () => {
    // Guards the table itself: 2^3 rows, no duplicates. A table that lost a row
    // would make the loop below silently weaker while still passing.
    expect(COMBINATIONS).toHaveLength(8);
    const seen = new Set(
      COMBINATIONS.map((c) => `${c.forceReloaded}${c.alreadyOpen}${c.restoredFromSession}`),
    );
    expect(seen.size).toBe(8);
  });

  for (const c of COMBINATIONS) {
    const label = `force=${c.forceReloaded} already=${c.alreadyOpen} restored=${c.restoredFromSession}`;
    it(`resolves ${label} to '${c.kind}'${c.reachable ? "" : " (unreachable today)"}`, () => {
      expect(kindOfOpenResult(result(flags(c)))).toBe(c.kind);
    });
  }
});

describe("openResultMessage — arms x readOnly, which is 8 outcomes and only 5 sentences", () => {
  // The whole reason this describe exists. `readOnly` is a fifth discriminator
  // the four-kind vocabulary does not name, and because the chain is else-if it
  // is reached ONLY when the other three are false. So a read-only document
  // that is also restored/already-open/force-reloaded says nothing about being
  // read only.
  const MESSAGES: Array<{ over: Partial<OpenFileResult>; expected: string }> = [
    { over: {}, expected: "Document opened: doc-1.md" },
    { over: { readOnly: true }, expected: "Document opened (review only): doc-1.md" },
    {
      over: { restoredFromSession: true },
      expected: "Session restored: doc-1.md (annotations preserved)",
    },
    { over: { alreadyOpen: true }, expected: "Switched to already-open document: doc-1.md" },
    { over: { forceReloaded: true }, expected: "Force-reloaded from disk: doc-1.md" },
  ];

  for (const { over, expected } of MESSAGES) {
    it(`says "${expected}" for ${JSON.stringify(over)}`, () => {
      expect(openResultMessage(result(over))).toBe(expected);
    });
  }

  // #1591's shape. These three are the recorded gap: setting readOnly changes
  // NOTHING once another flag is set. If a later PR fixes the wording, these
  // rows are what it has to change deliberately — which is the point of
  // characterizing rather than quietly preserving.
  const READ_ONLY_IS_SWALLOWED: Array<[string, Partial<OpenFileResult>]> = [
    ["restored", { restoredFromSession: true }],
    ["already-open", { alreadyOpen: true }],
    ["force-reloaded", { forceReloaded: true }],
  ];

  for (const [kind, over] of READ_ONLY_IS_SWALLOWED) {
    it(`gives a ${kind} document the SAME sentence whether or not it is read-only`, () => {
      const writable = openResultMessage(result(over));
      const readOnly = openResultMessage(result({ ...over, readOnly: true }));
      expect(readOnly).toBe(writable);
      expect(readOnly).not.toContain("review only");
    });
  }
});

describe("the two precedence copies agree", () => {
  // The tie that did not exist. Reordering either chain alone now goes red.
  const SENTENCE_FOR_KIND: Record<OpenResultKind, string> = {
    fresh: "Document opened: doc-1.md",
    restored: "Session restored: doc-1.md (annotations preserved)",
    "already-open": "Switched to already-open document: doc-1.md",
    "force-reloaded": "Force-reloaded from disk: doc-1.md",
  };

  for (const c of COMBINATIONS) {
    const label = `force=${c.forceReloaded} already=${c.alreadyOpen} restored=${c.restoredFromSession}`;
    it(`message for ${label} matches its kind '${c.kind}'`, () => {
      // Writable only: readOnly's fifth branch is outside the kind vocabulary,
      // which is exactly what the describe above records.
      expect(openResultMessage(result(flags(c)))).toBe(
        SENTENCE_FOR_KIND[kindOfOpenResult(result(flags(c)))],
      );
    });
  }
});
