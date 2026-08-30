/**
 * ADR-035 Unit 8c — the edit family behind `AnnotationLifecycle.editPending`.
 *
 * **Every spec here exists because a first draft of it was defeatable.** The
 * plan for this unit proposed four tests; adversarial review constructed a
 * passing-but-wrong implementation for three of them before any code was
 * written. Those constructions are recorded at each spec, because the defeat is
 * more useful than the assertion — the assertion only tells you what is
 * checked, and the defeat tells you why the obvious version was not enough.
 *
 * Guard order, arm mapping and MCP envelopes are covered by
 * `edit-annotation.test.ts` and `document-store.test.ts`, which continue to
 * drive `YDocStore.editAnnotation`. Those two suites now exercise a *delegating
 * shell*, so this file calls `editPending` directly — otherwise the move itself
 * is checked by nothing, and "the old call site still works" is an inference
 * about the new function rather than a test of it.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import * as Y from "yjs";

// Spied, not stubbed: `relaySanitizationEvent`'s whole effect is a deduped
// `console.error` (via `logLegacyMigration`), so there is no observable state
// to assert against. That normally argues for testing the effect rather than
// the call — but here the effect IS the call, and the thing under test is
// whether the shell hands its own relay down or quietly substitutes something
// else. `importOriginal` is spread so the real implementation still runs.
vi.mock("../../src/server/annotations/migration-log.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../src/server/annotations/migration-log.js")>();
  return { ...actual, relaySanitizationEvent: vi.fn(actual.relaySanitizationEvent) };
});

import { createAnnotationLifecycle } from "../../src/server/annotations/lifecycle.js";
import { relaySanitizationEvent } from "../../src/server/annotations/migration-log.js";
import { YDocStore } from "../../src/server/mcp/document-store.js";
import { BROWSER_ORIGIN, MCP_ORIGIN, withBrowser } from "../../src/shared/origins.js";
import type { OnLossy } from "../../src/shared/sanitize.js";
import type { Annotation } from "../../src/shared/types.js";
import { getAnnotationsMap } from "../helpers/ydoc-factory.js";
import { asChangedKey } from "../helpers/yjs-transactions.js";

let doc: Y.Doc;
let map: Y.Map<unknown>;
let lifecycle: ReturnType<typeof createAnnotationLifecycle>;
const noLossy: OnLossy = () => {};

/** Seed a record RAW, bypassing the create path, so a spec can choose a stored
 *  `rev` or a legacy shape the minting path would never produce. */
function seed(id: string, extra: Record<string, unknown> = {}): void {
  map.set(id, {
    id,
    type: "comment",
    author: "claude",
    audience: "outbound",
    status: "pending",
    range: { from: 0, to: 4 },
    content: "original",
    timestamp: Date.now(),
    rev: 1,
    // A deliberately STALE editedAt: `editedAt: ann.editedAt ?? Date.now()` is a
    // plausible "don't clobber an existing timestamp" refactor, and it was
    // measured green against every suite in the repo. `expect.any(Number)`,
    // `toBeGreaterThan(0)` and `toBeDefined()` are all satisfied by a stale
    // value; only a seeded old one makes the failure to advance visible.
    editedAt: 1,
    // Optional fields the edit path must carry through untouched. Each was
    // dropped from the spread as a separate mutation and each came back GREEN:
    // `relRange` is the CRDT anchor (dropping it degrades the annotation to flat
    // offsets on the next reload), `heldInSolo` is the Solo-hold marker
    // (dropping it releases a held annotation when Claude edits it), and
    // `textSnapshotTruncated` is #1486's undo guard.
    textSnapshot: "orig",
    textSnapshotTruncated: true,
    heldInSolo: true,
    ...extra,
  });
}

beforeEach(() => {
  doc = new Y.Doc();
  map = getAnnotationsMap(doc);
  lifecycle = createAnnotationLifecycle(doc);
});

describe("editPending — rev", () => {
  it("increments from the record's OWN rev across sequential edits", () => {
    // The defeat: pinning a single edit to `2` does not distinguish
    // `nextRev(ann)` from `nextRev()`. `nextRev()` is `(undefined?.rev ?? 0) + 1`
    // = 1... and on a record already at `rev: 1`, `nextRev(ann)` is 2 as well, so
    // both implementations agree on the FIRST edit and diverge only after it.
    // `lifecycle.ts` already warns that "make these two consistent" is a
    // plausible edit at the mint site; this is the spec that would catch it.
    seed("a");

    const first = lifecycle.editPending("a", { content: "one" }, noLossy);
    const second = lifecycle.editPending("a", { content: "two" }, noLossy);

    expect(first.kind).toBe("ok");
    expect(second.kind).toBe("ok");
    if (first.kind !== "ok" || second.kind !== "ok") return;
    expect(first.annotation.rev, "first edit advances past the stored rev").toBe(2);
    expect(second.annotation.rev, "an argument-free nextRev would pin this at 2").toBe(3);
  });

  it("advances from a stored rev that is not 1", () => {
    // The second, independent kill for the same mutant, and the one that does
    // not depend on edit order: a record at rev 5 must land at 6, where
    // `nextRev()` would drive it backwards to 1.
    seed("b", { rev: 5 });

    const result = lifecycle.editPending("b", { content: "changed" }, noLossy);

    expect(result.kind).toBe("ok");
    if (result.kind !== "ok") return;
    expect(result.annotation.rev).toBe(6);
  });

  it("treats a record with no stored rev as 0, then keeps advancing", () => {
    // Read the title back as a claim and it is a DISCRIMINATION between two
    // treatments of a missing `rev`. The first assertion alone cannot make it:
    // no implementation produces anything but 1 there, so `toBe(1)` is the
    // symptom with nothing distinguishing the cause — measured, this spec
    // survived the `nextRev()` mutant that its two siblings kill. The second
    // edit is the discriminating half: "treated as 0 and advancing" reaches 2,
    // "pinned at 1" does not.
    seed("c", { rev: undefined });

    const first = lifecycle.editPending("c", { content: "one" }, noLossy);
    const second = lifecycle.editPending("c", { content: "two" }, noLossy);

    expect(first.kind).toBe("ok");
    expect(second.kind).toBe("ok");
    if (first.kind !== "ok" || second.kind !== "ok") return;
    expect(first.annotation.rev, "an absent rev is 0, not absent").toBe(1);
    expect(second.annotation.rev, "and it keeps advancing from there").toBe(2);
  });

  it("advances editedAt on every edit, rather than keeping the first", () => {
    // `editedAt: ann.editedAt ?? Date.now()` reads like a safe refactor and was
    // measured green against all six suites. It is not safe: `pickWinner` in the
    // durable-annotation merge resolves rev ties on `editedAt`, and the promote
    // path has an edit-suppression branch keyed on it advancing.
    seed("k");

    const first = lifecycle.editPending("k", { content: "one" }, noLossy);
    const second = lifecycle.editPending("k", { content: "two" }, noLossy);

    if (first.kind !== "ok" || second.kind !== "ok") throw new Error("edits failed");
    // THIS is the assertion that kills the mutant — it makes the stale seeded
    // value visible. The monotonicity check below does not: under
    // `editedAt: ann.editedAt ?? Date.now()` the two edits produce the EQUAL
    // value that `toBeGreaterThanOrEqual` accepts. It is kept as a
    // regression bound on ordering, not credited as the kill.
    expect(first.annotation.editedAt, "the seeded stale value must not survive").toBeGreaterThan(1);
    const firstAt = first.annotation.editedAt as number;
    expect(second.annotation.editedAt).toBeGreaterThanOrEqual(firstAt);
  });
});

describe("editPending — the lossy sink", () => {
  it("passes the CALLER's sink to sanitize, on a record that actually emits", () => {
    // The defeat: editing a healthy record observes zero sink calls whether the
    // sink is the caller's or a leftover `() => {}` copied from
    // `transitionPending`. `sanitizeAnnotation` emits only on specific legacy
    // branches (`shared/sanitize.ts` — audience-conflict-resolved,
    // malformed-suggestion-json, question-to-comment, flag-to-note,
    // unknown-type), so a spec built on `create()` output is vacuous BY
    // CONSTRUCTION rather than by the code being right. Seed the legacy shape.
    const onLossy = vi.fn();
    seed("d", { type: "question" });

    const result = lifecycle.editPending("d", { content: "changed" }, onLossy);

    expect(result.kind, "control: the edit itself succeeded").toBe("ok");
    expect(onLossy, "the caller's sink, not a swallowed no-op").toHaveBeenCalledWith(
      expect.objectContaining({ kind: "question-to-comment", id: "d" }),
    );
  });

  it("still reports through the sink when a later guard rejects the edit", () => {
    // Sanitize runs BEFORE the note guard, so a lossy note reaches the sink and
    // is then refused. An implementation that moved sanitize inside the
    // non-note branch would pass the spec above and fail this one — which is
    // the point of having both: the first proves the sink is wired, the second
    // proves it is wired where the guard order says it is.
    const onLossy = vi.fn();
    seed("e", { type: "flag", author: "user" });

    const result = lifecycle.editPending("e", { content: "changed" }, onLossy);

    expect(result.kind, "a flag sanitizes to a note, and notes are refused").toBe("invalid-note");
    expect(onLossy).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "flag-to-note", id: "e" }),
    );
  });
});

describe("editPending — what reaches the Y.Map", () => {
  it("stores every optional field it did not patch, not just the ones asserted", () => {
    // Measured: dropping `relRange`, `heldInSolo` or `textSnapshotTruncated`
    // from the spread is green against every suite in the repo. The old
    // preservation checks read exactly one field (`content`) off the RETURNED
    // object, and `edit-annotation.test.ts` pins four more — none of these
    // three. This asserts the STORED record, which is the other half: a
    // `map.set` that writes a different object from the one returned was also
    // green here and caught only by the sibling suites the file header argues
    // now drive a delegating shell.
    seed("l", { relRange: { some: "anchor" } });

    const result = lifecycle.editPending("l", { content: "changed" }, noLossy);
    expect(result.kind).toBe("ok");
    const stored = map.get("l") as Record<string, unknown>;

    expect(stored.content, "the patch reached the store, not just the return").toBe("changed");
    expect(stored.relRange, "the CRDT anchor survives an edit").toEqual({ some: "anchor" });
    expect(stored.heldInSolo, "the Solo-hold marker survives an edit").toBe(true);
    expect(stored.textSnapshotTruncated, "#1486's undo guard survives an edit").toBe(true);
    if (result.kind !== "ok") return;
    expect(stored, "the stored record IS the returned one").toEqual(result.annotation);
  });

  it("applies an empty string, rather than reading it as an absent field", () => {
    // The archetypal /simplify rewrite is `if (!patch.content && !patch.suggestedText)`,
    // and it was measured green: no spec anywhere passes an empty string. It is
    // wrong — clearing a comment's body and withdrawing a suggestion are both
    // real operations, and under a truthy check both return `empty-patch`.
    seed("m");

    const result = lifecycle.editPending("m", { content: "" }, noLossy);

    expect(result.kind, "an empty string is a value, not an absent field").toBe("ok");
    expect((map.get("m") as Record<string, unknown>).content).toBe("");
  });

  it("decides the suggestion target on the SANITIZED type, not the stored one", () => {
    // The docblock claims sanitize-before-guards for the whole sequence; only
    // the note guard was pinned. Measured: `raw.type !== "comment"` here is green
    // against every suite. A stored `question` sanitizes to `comment`, so under
    // that mutation this returns `invalid-suggestion-target` carrying
    // `annotationType: "question"` — a value outside the `AnnotationType` union
    // the arm claims, leaked to the MCP caller.
    seed("n", { type: "question" });

    const result = lifecycle.editPending("n", { suggestedText: "replacement" }, noLossy);

    expect(result.kind, "a legacy question sanitizes to a comment first").toBe("ok");
    if (result.kind !== "ok") return;
    expect(result.annotation.suggestedText).toBe("replacement");
  });
});

describe("editPending — origin tagging", () => {
  /** Origins of every transaction that changed THIS annotation's key. */
  function watchKey(id: string): unknown[] {
    const origins: unknown[] = [];
    doc.on("afterTransaction", (txn: Y.Transaction) => {
      if (txn.changed.get(asChangedKey(map))?.has(id)) origins.push(txn.origin);
    });
    return origins;
  }

  it("tags the write `mcp`, so the edit generates no channel event", () => {
    // Count FIRST, then attribute. `toContain(MCP_ORIGIN)` over a bag of origins
    // is the exact shape that passed in `restore-backup.test.ts` with the write
    // under test DELETED — two of the three entries in that bag came from an
    // unrelated `publishDirty`. Here the length assertion is what fails if the
    // `map.set` is dropped, and the index assertion is what fails on a retag.
    seed("f");
    const origins = watchKey("f");

    lifecycle.editPending("f", { content: "changed" }, noLossy);

    expect(origins, "exactly one transaction touched this key").toHaveLength(1);
    expect(origins[0]).toBe(MCP_ORIGIN);
  });

  it("control: a browser-origin write to the same key IS observed as browser", () => {
    // Without this, the spec above cannot tell "tagged mcp" from "the watcher
    // never fired". It is the positive control for the observation mechanism,
    // not for the edit path — and it is the reason the assertion above is
    // falsifiable at all.
    seed("g");
    const origins = watchKey("g");

    withBrowser(doc, () => map.set("g", { ...(map.get("g") as Annotation), content: "x" }));

    expect(origins).toHaveLength(1);
    expect(origins[0]).toBe(BROWSER_ORIGIN);
  });
});

describe("the DocumentStore shell", () => {
  it("hands its OWN relay down, rather than substituting a sink", () => {
    // Measured, not assumed: replacing the shell's `(e) => this.onLossy(e)`
    // with `() => {}` was GREEN against every pre-existing suite AND against
    // the lifecycle specs above. The lifecycle cannot catch it — `editPending`
    // faithfully uses whatever sink it is given, so being handed the wrong one
    // is correct behaviour from where it stands. Only the shell's own test can
    // see the substitution, which is why this spec is here and not there.
    const relay = vi.mocked(relaySanitizationEvent);
    relay.mockClear();
    const store = new YDocStore(doc, "C:/tmp/edit-shell.md", "doc-shell");
    seed("j", { type: "question" });

    const result = store.editAnnotation("j", {
      content: "changed",
      // Both fields, deliberately: a shell that forwarded only `content` was
      // green against this spec when it passed one field.
      suggestedText: "replacement",
    });

    expect(result.kind, "control: the edit itself succeeded").toBe("ok");
    if (result.kind === "ok") {
      expect(result.annotation.content).toBe("changed");
      expect(result.annotation.suggestedText, "the whole patch reached the seam").toBe(
        "replacement",
      );
    }
    expect(relay).toHaveBeenCalledWith(
      store.docHash,
      expect.objectContaining({ kind: "question-to-comment", id: "j" }),
    );
  });
});

describe("editPending — the seam itself", () => {
  it("is reachable without going through DocumentStore", () => {
    // `edit-annotation.test.ts` and `document-store.test.ts` both drive
    // `YDocStore.editAnnotation`, which is now a delegating shell. If this file
    // did not import `editPending` directly, every assertion about the edit
    // family would still be routed through the old call site, and "the move
    // landed" would rest on the shell forwarding correctly rather than on the
    // moved function being tested.
    seed("h");

    const result = lifecycle.editPending("h", { suggestedText: "replacement" }, noLossy);

    expect(result.kind).toBe("ok");
    if (result.kind !== "ok") return;
    expect(result.annotation.suggestedText).toBe("replacement");
    expect(result.annotation.content, "an unset field is left alone, not cleared").toBe("original");
    expect(result.annotation.editedAt).toEqual(expect.any(Number));
  });

  it("refuses a resolved note as a note, not as resolved", () => {
    // The one guard-order fact worth restating at the seam: the note check
    // precedes the pending check, so a resolved note reports `invalid-note`.
    // The other ordering would tell a caller that the note exists and is merely
    // resolved, which is a disclosure ADR-027 does not make.
    seed("i", { type: "note", author: "user", status: "accepted" });

    expect(lifecycle.editPending("i", { content: "x" }, noLossy).kind).toBe("invalid-note");
  });
});
