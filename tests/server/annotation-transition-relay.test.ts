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
 * in module-level state, so (1) `resetMigrationLog()` runs before every spec;
 * (2) each spec uses its OWN `filePath`, since every store in
 * `document-store.test.ts` shares `/tmp/doc.md` and one relay anywhere in a file
 * silences every later assertion of the same kind; and (3) no spec reads an
 * annotation before the transition — `listAnnotations` AND the single-record
 * `getAnnotation` both relay under the same key, and `removeAnnotation` calls
 * `getAnnotation` internally, so a read is an invisible consumer.
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
import { getAnnotationsMap, makeDoc, rangeOf } from "../helpers/ydoc-factory.js";

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

/** Seed a record RAW, so a spec can store a shape the mint path never produces. */
function seed(id: string, extra: Record<string, unknown>): void {
  map.set(id, {
    id,
    type: "comment",
    author: "user",
    audience: "private",
    status: "pending",
    range: rangeOf(0, 5, doc).range,
    content: "legacy",
    timestamp: Date.now(),
    rev: 1,
    ...extra,
  });
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
    const filePath = "/tmp/relay-accept.md";
    const store = new YDocStore(doc, filePath, "relay-accept");
    seed("q1", { type: "question", author: "claude", audience: "outbound" });

    const result = store.acceptAnnotation("q1");

    expect(result.kind, "the transition itself still completes").toBe("ok");
    expect((map.get("q1") as Annotation).status).toBe("accepted");
    expect(relayedFor(filePath), "one line, under THIS doc's hash").toHaveLength(1);
    expect(relayedFor(filePath)[0]).toContain("question-to-comment");
  });

  it("dismiss relays too — the two share a body and can still diverge at the store", () => {
    const filePath = "/tmp/relay-dismiss.md";
    const store = new YDocStore(doc, filePath, "relay-dismiss");
    seed("q2", { type: "question", author: "claude", audience: "outbound" });

    expect(store.dismissAnnotation("q2").kind).toBe("ok");
    expect(relayedFor(filePath)).toHaveLength(1);
  });

  it("relays a rewrite even when the ADR-027 guard then refuses the write", () => {
    // Reads backwards and is worth pinning: sanitize runs BEFORE the note
    // guard, so a stored `flag` fires `flag-to-note` and is only then refused.
    // The event describes what sanitize read, not what the lifecycle wrote.
    const filePath = "/tmp/relay-flag.md";
    const store = new YDocStore(doc, filePath, "relay-flag");
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
    const filePath = "/tmp/relay-sanitized-write.md";
    const store = new YDocStore(doc, filePath, "relay-sanitized-write");
    seed("q9", { type: "question", author: "claude", audience: "outbound" });

    const result = store.acceptAnnotation("q9");

    expect(result.kind === "ok" && result.data.type, "the RETURNED type").toBe("comment");
    expect((map.get("q9") as Annotation).type, "and the STORED one").toBe("comment");
    expect((map.get("q9") as Annotation).status).toBe("accepted");
  });

  it("a clean record relays nothing", () => {
    // The negative control. Without it, a relay that fires unconditionally —
    // or a spy that captures some other console.error — passes every spec
    // above.
    const filePath = "/tmp/relay-clean.md";
    const store = new YDocStore(doc, filePath, "relay-clean");
    seed("c1", { type: "comment", author: "claude", audience: "outbound" });

    expect(store.acceptAnnotation("c1").kind).toBe("ok");
    expect(relayedFor(filePath)).toHaveLength(0);
    expect(errors, "and no un-keyed line either").toHaveLength(0);
  });

  it("the message names the store's docHash, not the undefined variant", () => {
    // The kill for `relaySanitizationEvent(this.docHash, e)` →
    // `(undefined, e)`. That mutant still logs, so every count-of-errors
    // assertion above survives it; only the docHash in the body distinguishes
    // the two, and `logLegacyMigration` prints `(no docHash)` for the mutant.
    const filePath = "/tmp/relay-keyed.md";
    const store = new YDocStore(doc, filePath, "relay-keyed");
    seed("q3", { type: "question", author: "claude", audience: "outbound" });

    store.acceptAnnotation("q3");

    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain(`in ${docHash(filePath)}`);
    expect(errors[0]).not.toContain("no docHash");
  });

  it("dedups per (doc, kind), so a second accept of the same kind is silent", () => {
    // Not a nicety — it is why every spec in this file needs its own filePath,
    // and pinning it here is what makes that requirement discoverable rather
    // than folk knowledge.
    const filePath = "/tmp/relay-dedup.md";
    const store = new YDocStore(doc, filePath, "relay-dedup");
    seed("q4", { type: "question", author: "claude", audience: "outbound" });
    seed("q5", { type: "question", author: "claude", audience: "outbound" });

    store.acceptAnnotation("q4");
    store.acceptAnnotation("q5");

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
