import { describe, expect, it } from "vitest";
import {
  kindOfOpenResult,
  type OpenFileResult,
  type OpenResultKind,
  type OpenSuccess,
  type OpenSuccessPayload,
  toWireResult,
} from "../../src/server/documents/open.js";
import { openResultMessage } from "../../src/server/mcp/document.js";

/**
 * Characterization for ADR-034 Unit 7b.
 *
 * Written first against the pre-union code, where two independent copies of
 * one precedence existed - `kindOfOpenResult` and the message chain
 * `tandem_open` returns - agreeing by inspection only. 7b promoted that
 * ordering to a discriminator, and promoting an ordering nobody pinned is how
 * a "refactor" silently changes which case wins.
 *
 * The specs survive that change with their subject rewritten, not weakened:
 *
 *   - `kindOfOpenResult` still faces the FULL 2^3 boolean cross product,
 *     including the four combinations no path can produce. It reads the WIRE
 *     type, where the booleans still live, so those rows still mean something:
 *     they say how a transported result is interpreted when its flags are not
 *     disjoint.
 *   - The "two copies agree" spec becomes a ROUND TRIP -
 *     `kindOfOpenResult(toWireResult(x)) === x.kind` - which is a stronger
 *     claim than the old one, because the pair is now an encode/decode rather
 *     than two orderings that happened to match.
 *   - The `readOnly` rows are unchanged. `readOnly` is a distinction the four
 *     kinds do not name, and it still applies to `fresh` alone.
 */

const PAYLOAD: OpenSuccessPayload = {
  documentId: "doc-1",
  filePath: "/tmp/doc-1.md",
  fileName: "doc-1.md",
  format: "md",
  readOnly: false,
  source: "file",
  tokenEstimate: 0,
  pageEstimate: 0,
};

const ALL_KINDS: OpenResultKind[] = ["fresh", "restored", "already-open", "force-reloaded"];

function success(kind: OpenResultKind, over: Partial<OpenSuccessPayload> = {}): OpenSuccess {
  return { ...PAYLOAD, ...over, kind } as OpenSuccess;
}

/** The three legacy booleans alone - the table rows carry bookkeeping fields too. */
function flags(c: Combination): Partial<OpenFileResult> {
  return {
    forceReloaded: c.forceReloaded,
    alreadyOpen: c.alreadyOpen,
    restoredFromSession: c.restoredFromSession,
  };
}

/** A wire result: the flat shape, for feeding `kindOfOpenResult` directly. */
function wire(overrides: Partial<OpenFileResult>): OpenFileResult {
  return {
    ...PAYLOAD,
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

/** All 8 combinations of the three wire booleans, with the kind each resolves to. */
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
      expect(kindOfOpenResult(wire(flags(c)))).toBe(c.kind);
    });
  }
});

describe("openResultMessage - kind x readOnly, which is 8 outcomes and only 5 sentences", () => {
  // `readOnly` is a fifth distinction the four kinds do not name, and it is
  // consulted under `fresh` alone. So a read-only document that is also
  // restored/already-open/force-reloaded says nothing about being read only.
  const MESSAGES: Array<[OpenSuccess, string]> = [
    [success("fresh"), "Document opened: doc-1.md"],
    [success("fresh", { readOnly: true }), "Document opened (review only): doc-1.md"],
    [success("restored"), "Session restored: doc-1.md (annotations preserved)"],
    [success("already-open"), "Switched to already-open document: doc-1.md"],
    [success("force-reloaded"), "Force-reloaded from disk: doc-1.md"],
  ];

  for (const [result, expected] of MESSAGES) {
    it(`says "${expected}" for kind '${result.kind}' readOnly=${result.readOnly}`, () => {
      expect(openResultMessage(result)).toBe(expected);
    });
  }

  it("has a distinct sentence for every kind", () => {
    // Guards against a future kind quietly reusing another's wording, which
    // would leave the per-kind rows above unable to tell the two apart.
    const sentences = ALL_KINDS.map((kind) => openResultMessage(success(kind)));
    expect(new Set(sentences).size).toBe(ALL_KINDS.length);
  });

  // #1591's shape. These three are the recorded gap: setting readOnly changes
  // NOTHING for a non-fresh kind. If a later PR fixes the wording, these rows
  // are what it has to change deliberately - which is the point of
  // characterizing rather than quietly preserving.
  for (const kind of ALL_KINDS.filter((k) => k !== "fresh")) {
    it(`gives a ${kind} document the SAME sentence whether or not it is read-only`, () => {
      const writable = openResultMessage(success(kind));
      const readOnly = openResultMessage(success(kind, { readOnly: true }));
      expect(readOnly).toBe(writable);
      expect(readOnly).not.toContain("review only");
    });
  }
});

describe("toWireResult and kindOfOpenResult are a round trip", () => {
  for (const kind of ALL_KINDS) {
    it(`encodes and decodes '${kind}'`, () => {
      expect(kindOfOpenResult(toWireResult(success(kind)))).toBe(kind);
    });
  }

  it("sets exactly one boolean for every kind except fresh, and none for fresh", () => {
    for (const kind of ALL_KINDS) {
      const w = toWireResult(success(kind));
      const set = [w.restoredFromSession, w.alreadyOpen, w.forceReloaded].filter(Boolean).length;
      expect(set, `kind '${kind}' set ${set} booleans`).toBe(kind === "fresh" ? 0 : 1);
    }
  });

  it("only ever emits combinations the decoder reads back unambiguously", () => {
    // The encoder can only produce disjoint flags, so every encoded result
    // lands on a REACHABLE row of COMBINATIONS. This is what ties the two
    // tables together: a new kind that forgot to set its boolean would collide
    // with `fresh` here rather than passing quietly.
    const reachable = new Set(
      COMBINATIONS.filter((c) => c.reachable).map(
        (c) => `${c.forceReloaded}${c.alreadyOpen}${c.restoredFromSession}`,
      ),
    );
    for (const kind of ALL_KINDS) {
      const w = toWireResult(success(kind));
      expect([...reachable]).toContain(
        `${w.forceReloaded}${w.alreadyOpen}${w.restoredFromSession}`,
      );
    }
  });
});
