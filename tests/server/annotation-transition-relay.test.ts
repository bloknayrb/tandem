/**
 * The sanitization relay on accept/dismiss (ADR-034/035 Unit 8d).
 *
 * Until 8d, `transitionPending` sanitized into a literal `() => {}`. Accepting a
 * legacy-shaped record therefore performed the migration — `flag→note`,
 * `question→comment`, a malformed suggestion JSON, an unknown type — and
 * reported nothing. This file is the guard that the real relay is wired, and it
 * is deliberately at TWO altitudes because the seam has two halves that fail
 * independently:
 *
 *  - the **store** must hand its own docHash-bound relay down
 *    (`YDocStore.acceptAnnotation`), and
 *  - the **lifecycle** must forward the argument it was given rather than
 *    substituting a sink of its own (`createAnnotationLifecycle`).
 *
 * A spec at either altitude alone passes with the other half broken.
 *
 * **Three hazards make a relay spec silently vacuous, and all three are handled
 * here rather than noted.** `logLegacyMigration` dedups on `${docHash}:${kind}`
 * in module-level state, so (1) `resetMigrationLog()` runs before every spec —
 * **this is the one that carries the invariant**; and (2) no spec reads an
 * annotation before the transition, because `listAnnotations` AND the
 * single-record `getAnnotation` both relay under the same key, and
 * `removeAnnotation` calls `getAnnotation` internally, so a read is an
 * invisible consumer.
 *
 * The per-spec `filePath` below is redundancy, deliberately not stated as a
 * requirement: `beforeEach` already clears the Set and vitest isolates module
 * state per file, so `document-store.test.ts`'s shared `/tmp/doc.md` cannot
 * reach here. It costs nothing and it means a future `resetMigrationLog`
 * removal degrades instead of silently voiding the file — but calling it
 * necessary would be inventing the kind of folk rule this header exists to
 * prevent.
 *
 * The assertion is a **count of exactly one message naming this doc's hash**,
 * never a bare "console.error was called". `relaySanitizationEvent(undefined, e)`
 * still logs — the `(no docHash)` variant with dedup disabled — so a presence
 * check passes with the docHash binding destroyed.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as Y from "yjs";
import { docHash } from "../../src/server/annotations/doc-hash.js";
import {
  acceptPending,
  createAnnotationLifecycle,
  dismissPending,
} from "../../src/server/annotations/lifecycle.js";
import { resetMigrationLog } from "../../src/server/annotations/migration-log.js";
import { YDocStore } from "../../src/server/mcp/document-store.js";
import type { OnLossy, SanitizationEvent } from "../../src/shared/sanitize.js";
import type { Annotation } from "../../src/shared/types.js";
import { getAnnotationsMap, makeDoc, seedRawAnnotation } from "../helpers/ydoc-factory.js";

let doc: Y.Doc;
let map: Y.Map<unknown>;
let errors: string[];

beforeEach(() => {
  resetMigrationLog();
  doc = makeDoc("Hello world");
  map = getAnnotationsMap(doc);
  errors = [];
  // `vitest.config.ts` sets no `restoreMocks`, so this restores explicitly in
  // `afterEach` — an un-restored console spy swallows diagnostics for every
  // later spec in the run.
  vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
    errors.push(args.map(String).join(" "));
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

/** Shorthand for the shared raw-record seeder, bound to this file's doc. */
function seed(id: string, extra: Record<string, unknown>): void {
  seedRawAnnotation(map, doc, id, extra);
}

/** A store with a filePath nothing else in this file uses. The distinct path
 *  is redundancy over `resetMigrationLog` (see the header), but deriving it
 *  from the label means a new spec gets it without knowing that. */
function storeFor(label: string): { store: YDocStore; filePath: string } {
  const filePath = `/tmp/relay-${label}.md`;
  return { store: new YDocStore(doc, filePath, `relay-${label}`), filePath };
}

/** Messages naming THIS doc's hash. The hash is in the message body —
 *  `logLegacyMigration` formats `legacy migration: ${kind} in ${docHash}`. */
function relayedFor(filePath: string): string[] {
  const hash = docHash(filePath);
  return errors.filter((e) => e.includes("legacy migration") && e.includes(hash));
}

describe("YDocStore.acceptAnnotation relays sanitization events", () => {
  it("emits exactly one migration line, keyed to the store's own docHash", () => {
    // `question` is the fixture because it survives BOTH guards: it sanitizes
    // to a pending comment, so this one spec asserts the relay fired AND the
    // transition completed. A fixture that gets refused cannot do the second
    // half, which is how a relay spec passes on a path that gave up early.
    const { store, filePath } = storeFor("accept");
    seed("q1", { type: "question", author: "claude", audience: "outbound" });

    const result = store.acceptAnnotation("q1");

    expect(result.kind, "the transition itself still completes").toBe("ok");
    expect((map.get("q1") as Annotation).status).toBe("accepted");
    expect(relayedFor(filePath), "one line, under THIS doc's hash").toHaveLength(1);
    expect(relayedFor(filePath)[0]).toContain("question-to-comment");
  });

  it("dismiss relays too — the two share a body and can still diverge at the store", () => {
    const { store, filePath } = storeFor("dismiss");
    seed("q2", { type: "question", author: "claude", audience: "outbound" });

    expect(store.dismissAnnotation("q2").kind).toBe("ok");
    expect(relayedFor(filePath)).toHaveLength(1);
  });

  it("relays a rewrite even when the ADR-027 guard then refuses the write", () => {
    // Reads backwards and is worth pinning: sanitize runs BEFORE the note
    // guard, so a stored `flag` fires `flag-to-note` and is only then refused.
    // The event describes what sanitize read, not what the lifecycle wrote.
    const { store, filePath } = storeFor("flag");
    seed("f1", { type: "flag" });

    expect(store.acceptAnnotation("f1")).toStrictEqual({ kind: "invalid-note" });
    expect(relayedFor(filePath)).toHaveLength(1);
    expect(relayedFor(filePath)[0]).toContain("flag-to-note");
    expect((map.get("f1") as Annotation).status, "and nothing was written").toBe("pending");
  });

  it("writes the SANITIZED record, not the raw one", () => {
    // Two mutants live here and neither is visible from a return value.
    // `const ann = raw as Annotation` (no sanitize) and
    // `map.set(id, {...raw, status, rev})` (sanitize, return it, write the raw
    // one) both leave `result.data.type === "comment"` correct while the stored
    // record keeps its legacy `question`. A clean fixture cannot separate them
    // from correct code at all, because for a minted record raw and sanitized
    // are the same object.
    const { store } = storeFor("sanitized-write");
    seed("q9", { type: "question", author: "claude", audience: "outbound" });

    const result = store.acceptAnnotation("q9");

    expect(result.kind === "ok" && result.data.type, "the RETURNED type").toBe("comment");
    expect((map.get("q9") as Annotation).type, "and the STORED one").toBe("comment");
    expect((map.get("q9") as Annotation).status).toBe("accepted");
  });

  it.each([
    ["malformed-suggestion-json", { type: "suggestion", content: "not json{" }],
    ["unknown-type", { type: "zzz-from-the-future" }],
  ])("relays %s too", (kind, extra) => {
    // The header names four kinds that the pre-8d no-op swallowed. Two of them
    // had no spec, which made the header claim more coverage than the file had.
    // One sink argument covers every kind, so these are cheap — but "cheap to
    // add" is not "already asserted".
    const { store, filePath } = storeFor(`kind-${kind}`);
    seed("k1", { author: "claude", audience: "outbound", ...extra });

    expect(store.acceptAnnotation("k1").kind).toBe("ok");

    expect(relayedFor(filePath)).toHaveLength(1);
    expect(relayedFor(filePath)[0]).toContain(kind);
  });

  it("a clean record relays nothing", () => {
    // The negative control. Without it, a relay that fires unconditionally —
    // or a spy that captures some other console.error — passes every spec
    // above.
    const { store, filePath } = storeFor("clean");
    seed("c1", { type: "comment", author: "claude", audience: "outbound" });

    expect(store.acceptAnnotation("c1").kind).toBe("ok");
    expect(relayedFor(filePath)).toHaveLength(0);
    expect(
      errors.filter((e) => e.includes("no docHash")),
      "and no un-keyed line either",
    ).toHaveLength(0);
  });

  it("the message names the store's docHash, not the undefined variant", () => {
    // The kill for `relaySanitizationEvent(this.docHash, e)` →
    // `(undefined, e)`. That mutant still logs, so every count-of-errors
    // assertion above survives it; only the docHash in the body distinguishes
    // the two, and `logLegacyMigration` prints `(no docHash)` for the mutant.
    const { store, filePath } = storeFor("keyed");
    seed("q3", { type: "question", author: "claude", audience: "outbound" });

    store.acceptAnnotation("q3");

    expect(relayedFor(filePath)).toHaveLength(1);
    expect(
      errors.filter((e) => e.includes("no docHash")),
      "the undefined-docHash variant is what this spec exists to exclude",
    ).toHaveLength(0);
  });

  it("dedups per (doc, kind), so a second accept of the same kind is silent", () => {
    // Pinned because the dedup is what every other spec in this file is working
    // around; a reader who does not know it exists cannot tell why the header
    // insists on `resetMigrationLog`.
    const { store, filePath } = storeFor("dedup");
    seed("q4", { type: "question", author: "claude", audience: "outbound" });
    seed("q5", { type: "question", author: "claude", audience: "outbound" });

    // Both arms asserted, because "one line" is also what a mutant that makes
    // the second transition fail early produces — and that reads as dedup
    // working.
    expect(store.acceptAnnotation("q4").kind).toBe("ok");
    expect(store.acceptAnnotation("q5").kind).toBe("ok");

    expect(relayedFor(filePath)).toHaveLength(1);
  });
});

describe("the lifecycle forwards the sink it was given", () => {
  it.each([
    [
      "accept",
      (l: ReturnType<typeof createAnnotationLifecycle>, id: string, s: OnLossy) => l.accept(id, s),
    ],
    [
      "dismiss",
      (l: ReturnType<typeof createAnnotationLifecycle>, id: string, s: OnLossy) => l.dismiss(id, s),
    ],
  ])("%s reaches the caller's own sink", (_label, op) => {
    // **The store half cannot see this.** A `createAnnotationLifecycle` that
    // accepts `onLossy` and still passes `() => {}` down to `sanitizeAnnotation`
    // leaves every store spec above green, because the store's relay is a
    // `console.error` the mutant simply never triggers — indistinguishable from
    // "this record needed no migration". Asserting on a caller-supplied sink is
    // what separates "the argument was accepted" from "the argument was used".
    const seen: SanitizationEvent[] = [];
    const lifecycle = createAnnotationLifecycle(doc);
    seed("q6", { type: "question", author: "claude", audience: "outbound" });

    op(lifecycle, "q6", (e) => seen.push(e));

    expect(seen).toStrictEqual([{ kind: "question-to-comment", id: "q6" }]);
  });

  it("the bare exports forward it too", () => {
    const seen: SanitizationEvent[] = [];
    seed("q7", { type: "question", author: "claude", audience: "outbound" });

    acceptPending("q7", doc, map, (e) => seen.push(e));

    seed("q8", { type: "question", author: "claude", audience: "outbound" });
    dismissPending("q8", doc, map, (e) => seen.push(e));

    expect(seen.map((e) => e.kind)).toStrictEqual(["question-to-comment", "question-to-comment"]);
  });
});
