import { describe, expect, it } from "vitest";
import { filesMentioning, SRC_FILES, stripComments } from "../helpers/src-tree.js";

/**
 * #1621: who is allowed to write `Y_MAP_MODE`, pinned — and how many times.
 *
 * ## Why a writer-set pin and not a runtime guard
 *
 * The mode lives in a SINGLETON key of a shared `Y.Map`. That shape is safe only
 * when it has exactly one writer, or is rewritten often enough that a lost tie
 * self-heals before anyone acts on it. `Y_MAP_MODE` has neither property: it is
 * multi-writer AND written once per session, then read for minutes. When two
 * writes are concurrent, Yjs breaks the tie by highest clientID — not recency —
 * and the loser gets no signal at all. That is #1621, and it survived a shipped
 * release precisely because nothing anywhere said "this key has two writers."
 *
 * The client-side detector in `useTandemModeBroadcast.svelte.ts` reports a
 * disagreement AFTER it happens, into the diagnostics buffer. This is the other
 * half, and the cheaper one: it fires when a THIRD writer is added, which is the
 * last point at which anyone can still reason about the tie for free. It needs
 * no human to remember a step, which is this project's bar for a safeguard being
 * structural.
 *
 * Adding a writer is not forbidden. It requires deciding, in review, how its
 * write orders against the others — and then editing these lists.
 *
 * ## Occurrences, not just files
 *
 * The counts are the point, and a file-set assertion was the first version's
 * hole. A SECOND `.set(Y_MAP_MODE, …)` added inside a file already on the list
 * leaves a file-set check green — so the guard could not see #1621 being
 * reintroduced inside the very file it names as the fixed writer. Counting
 * occurrences per file is what closes that.
 *
 * ## Why the mention set is pinned too, and what it does NOT cover
 *
 * A shape scan for `.set(Y_MAP_MODE` is beaten by any indirection: a local alias
 * for the key, a generic `setCtrlKey(k, v)` helper, a computed member access. So
 * the shape scan is the precise half and the mention set is the wide half — a
 * new module touching the constant at all fails this file even when its write is
 * unrecognisable to the regex.
 *
 * But the mention set is a FILE ALLOWLIST, so it cannot see a write appearing in
 * a file already on it — and `src/server/mode.ts`, which already owns
 * `readModeState`/`reportedMode` and holds the ctrl doc, is exactly where someone
 * would naturally add a `setMode()`. The third describe closes that: files on the
 * mention list that are not expected writers must contain no write shape against
 * the awareness map at all.
 *
 * Three things still outside all of it, named so nobody reads this as complete:
 *
 * 1. **`restoreCtrlDoc` is a de-facto materializer.** `persistCtrlSnapshot`
 *    encodes the whole ctrl doc, `Y_MAP_USER_AWARENESS` included, and restore
 *    blind-`applyUpdate`s it back — which is how a dead session's mode reaches a
 *    fresh ctrl doc across a restart. It never mentions the constant, so both
 *    scans miss it structurally. Causally it replays the original writes rather
 *    than issuing a new one, so "two writers" stays true; but what the snapshot
 *    carries decides what the key holds at bootstrap, and changing that fires
 *    nothing here.
 * 2. **Scope is `src/` only.** `SRC_FILES` walks `src/` and nothing else, so a
 *    writer in `scripts/`, `infra/` or `src-tauri/` is invisible.
 * 3. **A raw string key** (`awareness.set("mode", …)`) escapes both scans. That
 *    is a Critical Rule 1 violation, and its complement is
 *    `scripts/audit-ymap-keys.ts` — which is a package.json script with **no CI
 *    step and no wiring test**, so do not read it as a gate that covers this.
 */

/** Files whose code (not comments) writes the key, and how many times each. */
const EXPECTED_MODE_WRITES: Array<[string, number]> = [
  // The user's toggle. Gated on the ctrl provider's first sync so the write is
  // causally ordered rather than concurrent — that gate is #1621's fix.
  ["src/client/hooks/useTandemModeBroadcast.svelte.ts", 1],
  // The Solo-to-Tandem release, server-side and UNCONDITIONAL: any client's flip
  // writes "tandem" for everyone. This is the writer that makes adoption unsafe
  // on the client — see the both-directions spec in tandem-mode-race.test.ts.
  ["src/server/mcp/routes/mode-release.ts", 1],
];

/** Every file mentioning the constant, writers and readers alike. */
const EXPECTED_MENTIONS = [
  "src/client/hooks/useTandemModeBroadcast.svelte.ts",
  // `tandem_status` — what Claude is told the mode is.
  "src/server/mcp/document.ts",
  "src/server/mcp/routes/mode-release.ts",
  // `readModeState` / `reportedMode` — the hide predicate for held annotations.
  "src/server/mode.ts",
  // The declaration itself.
  "src/shared/constants.ts",
] as const;

/**
 * `Y_MAP_DWELL_MS` has the identical shape — singleton key, shared map, written
 * once per session from per-client settings — and today has exactly one writer.
 * Pinned now, while the answer is still "one", rather than after the second
 * arrives. It deliberately has no runtime detector; the reasoning is in the
 * dwell effect's own comment.
 */
const EXPECTED_DWELL_WRITES: Array<[string, number]> = [
  ["src/client/hooks/useTandemModeBroadcast.svelte.ts", 1],
];

function writeShape(constantName: string): RegExp {
  return new RegExp(`\\.set\\(\\s*${constantName}\\b`, "g");
}

/** `[file, occurrences]` for every file whose code matches, sorted by file. */
function writeCounts(constantName: string): Array<[string, number]> {
  const out: Array<[string, number]> = [];
  for (const [rel, contents] of SRC_FILES) {
    const hits = stripComments(contents).match(writeShape(constantName));
    if (hits) out.push([rel, hits.length]);
  }
  return out.sort(([a], [b]) => a.localeCompare(b));
}

describe("Y_MAP_MODE writer set (#1621)", () => {
  it("has exactly the writes this project has reasoned about", () => {
    expect(writeCounts("Y_MAP_MODE")).toEqual(EXPECTED_MODE_WRITES);
  });

  it("is mentioned only where this project expects", () => {
    expect(filesMentioning("Y_MAP_MODE")).toEqual([...EXPECTED_MENTIONS].sort());
  });

  it("keeps every mention-only file free of awareness-map writes", () => {
    // The hole a file allowlist cannot see: a third writer landing inside a file
    // already on the mention list passes both scans above. `src/server/mode.ts`
    // is the natural home for a `setMode()` and is already listed.
    const writers = new Set(EXPECTED_MODE_WRITES.map(([f]) => f));
    const readOnly = EXPECTED_MENTIONS.filter((f) => !writers.has(f));
    expect(readOnly.length).toBeGreaterThan(0);
    for (const rel of readOnly) {
      const code = stripComments(SRC_FILES.get(rel) ?? "");
      expect(code, `${rel} is a reader; it must not write the awareness map`).not.toMatch(
        /Y_MAP_USER_AWARENESS\s*\)?\s*\.set\(|\.set\(\s*Y_MAP_(MODE|DWELL_MS)\b/,
      );
    }
  });

  it("would notice if the constant were renamed out from under it", () => {
    // The floor. Renaming `Y_MAP_MODE` leaves both scans matching nothing, and
    // empty-equals-empty passes — the zero-of-zero failure this codebase has hit
    // before. A positive anchor is what makes the greens above mean something.
    expect(filesMentioning("Y_MAP_MODE").length).toBeGreaterThan(0);
    expect(writeCounts("Y_MAP_MODE").length).toBeGreaterThan(0);
    expect(SRC_FILES.get("src/shared/constants.ts")).toContain('Y_MAP_MODE = "mode"');
  });

  it("counts a write only in code, never in prose about one", () => {
    // `stripComments` is doing real work: this file's own doc comment contains
    // the literal `.set(Y_MAP_MODE`, and so does the hook's. A scan that read
    // comments would report writers that do not exist and mask a real one.
    const commented = "// awareness.set(Y_MAP_MODE, mode)\nconst x = 1;\n";
    expect(stripComments(commented).match(writeShape("Y_MAP_MODE"))).toBeNull();
    expect(commented.match(writeShape("Y_MAP_MODE"))).not.toBeNull();
  });
});

describe("Y_MAP_DWELL_MS writer set (#1621, same shape)", () => {
  it("still has exactly one writer", () => {
    expect(writeCounts("Y_MAP_DWELL_MS")).toEqual(EXPECTED_DWELL_WRITES);
  });

  it("would notice a rename", () => {
    expect(writeCounts("Y_MAP_DWELL_MS").length).toBeGreaterThan(0);
    expect(SRC_FILES.get("src/shared/constants.ts")).toContain("Y_MAP_DWELL_MS");
  });
});
