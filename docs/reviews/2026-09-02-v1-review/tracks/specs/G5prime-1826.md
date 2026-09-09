# G5' — #1826 annotation-lifecycle Lows: push/pull disagree after a failed Accept; `userActions` has no status gate

Branch `fix/audience-remnants-1698`. Closes #1826. Refs #1656 (already closed on master — this PR only confirms its pin). Ledger: `docs/reviews/2026-09-02-v1-review/areas/annotations.md:23`.

The issue lists five items. Two are fixed here; three are refuted or belong elsewhere.

## Problem

**1 — push and pull disagree after a failed Accept.** `resolveAnnotation` (`src/client/panels/useAnnotationReview.svelte.ts`) writes `withBrowser(y, () => map.set(id, { ...ann, status }))` FIRST, then calls `applySuggestion`, and on a `false` return writes `revertedToPending(ann)`. The observer's `action === "update" && ann.author === "claude"` branch (`src/server/events/observers/annotations.ts`) emits `annotation:accepted` for `status === "accepted"` and has **no arm for a revert to `pending`**. So Claude gets `annotation:accepted` on push and reads `pending` on every pull. Reachable through both of `applySuggestion`'s `false` returns (unresolvable range; `snapshotContradicts`, #1629), each already pinned in `tests/client/use-annotation-review.test.ts`.

**2 — `userActions` has no status gate.** In `processUnsurfacedInboxAnnotations` (`src/server/mcp/awareness.ts`) the user bucket admits `ann.author === "user" && ann.type === "comment" && isClaudeFacing(ann)` with no `status` test, while the Claude bucket beside it tests `ann.status !== "pending"`. Reproduced in-memory on this branch: a `{author: "user", type: "comment", audience: "outbound", status: "dismissed"}` record lands in `userActions`. `surfacedIds` is a module-level `Map`, so **every server restart re-surfaces every resolved user comment as a fresh user action**.

**2a — the gate must not create a new divergence.** The observer's user-comment `update` arm emits `annotation:edited` on **any** `editedAt` advance with no status test, `transitionPending` leaves Dismiss open to a user's comment, and `editAnnotation` (`src/client/panels/annotation-actions.ts`) has no status gate. A bare `status === "pending"` gate would therefore make *surface -> Claude dismisses -> user edits* emit on the channel while `tandem_checkInbox` returned nothing — item 1's own defect class, newly created. The gate is `status === "pending" || edited`, and `|| edited` **holds within one server run only** (see Fix). The observer is not changed.

**Refuted or elsewhere.** *2b*: "`tandem_resolveAnnotation` accepts user highlights" — closed by #1803; `transitionPending` gates on `isWithheldFromClaude` and a user highlight is `audience: "private"` after sanitize, so it answers `invalid-note` (pinned in `tests/server/adr027-note-write-guards.test.ts`). *3*: concurrent `map.set` resolving by clientID is Y.Map's defined LWW semantics; the proposed "`version` field with compare-and-set" cannot hold in a CRDT (two peers both read N, both write N+1, Yjs still resolves by clientID) and would report a false guarantee. The real fix is server-serialized annotation writes — an authority change, not a Low, so no code here; but it is a REPRODUCED condition (`annotations.md:23`, "verified 3/3, `experiments/yjs-race.ts`"), and this PR carries `Closes #1826`, so it needs a tracked home before it merges — see `## Done when`. *4*: `user-guide.md:296` and the Solo `tandem_comment` copy are #1779's, as the issue body says. *5*: `tandem_save` on `.docx` in Solo — `prepareExportComments` (`src/server/file-io/docx-comment-export.ts:305-318`) sanitizes first, then admits only `type === "comment" && audience !== "private" && status === "pending"` **plus `{author: "import", importSource}` round-trips**, so a user note or highlight is never written to the file while an imported Word comment (note or private included) returns to its own `.docx`. Do not write "notes and highlights are never exported".

**#1656 — pin confirmed, discriminating, nothing to change.** The gate is `isClaudeFacing` (`src/server/annotations/projection.ts`). `tests/server/adr027-note-write-guards.test.ts:200-243` is a **read**-side spec at the bucket call site: it calls `processInboxAnnotations` directly (`:228`) and asserts `userResponses` (`:239`) with both seeds `audience: "outbound"` (`:216-222`), so `type !== "note"` is the only exclusion — mutating `isClaudeFacing` to `return ann.audience === "outbound"` turns it red (measured). `tests/server/read-audience-filter.test.ts:286` independently pins the (type x audience) grid. **No test is added — "already correct" is the outcome**; record it in the PR body.

## Fix

**Item 1 — `src/client/panels/useAnnotationReview.svelte.ts`, `resolveAnnotation`.** Apply first, write the status once, only on success — and keep the failure write:

```ts
if (status === "accepted" && ann.suggestedText !== undefined) {
  const editor = getEditor();
  if (editor && !applySuggestion(ann, editor, y, getFormat?.())) {
    // Normalizing write, NOT a status change: the record is still `pending`, so
    // the observer's claude-update arm has no matching case and emits nothing.
    // What it does do is strip a stale `resolvedBy` (#1770).
    withBrowser(y, () => map.set(id, revertedToPending(ann)));
    onApplyFailed?.(ann);
    return;
  }
}
withBrowser(y, () => map.set(id, { ...ann, status }));
```

- **Do not replace the failure branch with a bare `return`.** `tests/client/use-annotation-review.test.ts:281` seeds a pending record carrying `resolvedBy: "claude"`, drives a failed accept and asserts the stamp is gone; `revertedToPending` is the only stripper, `sanitize.ts:144-146` carries the field through, and `awareness.ts` excludes `resolvedBy === "claude"` from `userResponses`. Writing nothing turns that pin red and would silence the user's next accept forever. Keeping it costs one no-op-status transaction on a failure path and leaves the pin **unchanged**.
- `applySuggestion` reads only its `ann` argument and the editor state — never the map's `status` — so the reorder is safe by construction. No wrap may span `applySuggestion`: nesting y-prosemirror's own `doc.transact(..., ySyncPluginKey)` inside ours makes it inherit OUR origin, and `yUndoPlugin` stops capturing the accepted text.
- `withBrowser` stays (Critical Rule 2). It is hygiene, not the delivery mechanism — client tags never cross the wire; Hocuspocus re-tags, so both writes reach the observer regardless.
- **Bound, recorded:** today a throw or late failure inside `applySuggestion` leaves the record `accepted` with nothing applied; after the reorder it leaves `pending` with the text possibly applied, so a second Accept could re-apply. `snapshotContradicts` (#1629) refuses any record carrying a `textSnapshot`, so only the snapshot-less legacy arm is exposed — a strictly smaller window than the state it replaces.
- **Three comments in this file become false and change in the same commit:** `applySuggestion`'s guard-inside-the-`try` rationale (`:335-337`, "has already written `status: accepted`"); `onApplyFailed`'s docblock (`:443`, "already been reverted to `pending`" — it was never moved off it); and the "THREE SEPARATE ONE-STATEMENT TRANSACTIONS" comment (`:541-549`), which sits above the write being deleted — move it above the apply block, re-word it onto what it protects, and drop the literal count. `resolveAnnotation`'s idempotency comment (`:536-540`) keeps its claim only for a double-fire from a later task; say so rather than deleting it (no such path exists today — `SidePanel.svelte` iterates distinct ids).

**Item 2 — `src/server/mcp/awareness.ts`, `processUnsurfacedInboxAnnotations`.** Hoist the ledger read above the bucket branch and gate the user arm on it:

```ts
const key = inboxLedgerKey(documentId, ann);
const lastSurfacedEditedAt = surfaced.get(key);
const edited = lastSurfacedEditedAt !== undefined && (ann.editedAt ?? 0) > lastSurfacedEditedAt;

if (
  ann.author === "user" &&
  ann.type === "comment" &&
  isClaudeFacing(ann) &&
  (ann.status === "pending" || edited)
) {
```

with the existing body reusing `key` and `edited` (the `channelKey` line and the `surfaced.set` otherwise unchanged).

- **`|| edited` holds WITHIN A SERVER RUN only; state the bound in the branch comment, do not widen the predicate.** It is what stops the gate creating **2a**'s divergence. It does not cover restart-then-edit: `edited` needs `lastSurfacedEditedAt !== undefined`, and a restart empties the in-memory ledger, so a comment resolved before a restart and edited after it surfaces on the channel and not on pull. No pure predicate does better — comparing against `lastSurfacedEditedAt ?? 0` would re-surface every previously-edited resolved comment on every restart, which is the bug being fixed. Accepted and named in `## Not in scope`.
- **The gate is a term of the `if` condition, never a check inside the block** — same reason as the Solo hold's `continue`: a rejected record must take no `surfaced.set`, or the ledger is poisoned and the record is permanently dedup-skipped. Position among the conjuncts is immaterial; all four are pure predicates over `ann`.
- Write the gate in its positive form (`status === "pending"`), not `status !== "dismissed"` — `accepted` is a reachable end state for a user comment (`transitionPending` refuses an accept only for a claude author or a suggestion-bearing record, `src/server/annotations/lifecycle.ts:952-957`).
- Path is read-only; no origin helper involved.

## Tests

**`tests/client/use-annotation-review.test.ts` — item 1.**

1. **The discriminator.** Attach a `map.observe` collecting every `status` written for the id. On a failed apply (reuse the existing unresolvable-range fixture), assert the observed sequence is `["pending"]` — today it is `["accepted", "pending"]`. Assert the sequence, not a count and not "zero writes": the failure branch still writes. A status-only assertion is not enough — the existing specs already assert `pending` and stay green under the bug.
2. **Positive control.** On a successful apply, exactly ONE write, `status: "accepted"`. Kills a fix that stops writing the status, and a double-write.
3. **The #1770 pins stay green, unchanged** (`:248-315`, two `it`s) — that is the check that the failure write was kept.

**`tests/server/inbox-ledger-undo.test.ts` — item 2.** The file already exists (four #1770 specs). **Append** a new `describe("#1826: the userActions bucket has a status gate")`; never `Write` over the file.

4. **The discriminator, over BOTH resolved statuses.** `it.each(["dismissed", "accepted"] as const)`: a fresh `surfaced` Map and a record never surfaced while pending — seeded directly at `{author: "user", type: "comment", audience: "outbound", status}`, with `resolvedBy: "claude"` on the `accepted` case so the fixture is what `transitionPending` actually writes — yields `userActions: []`. Both rows red on `origin/master`. The `accepted` row is what separates the specified gate from a lazy `status !== "dismissed"`; no existing spec covers it (every user-comment fixture in `awareness-tools.test.ts`, `mcp-output-schemas.test.ts`, `mcp-tool-integration.test.ts` and `read-audience-filter.test.ts` is `status: "pending"`). The existing spec at `:129` is not red on master — the ledger's dedup hides it there — so it cannot stand in for this row.
5. **Control, or a gate that empties the bucket passes:** the identical record at `status: "pending"` yields one `userAction`.
6. **Edit-after-dismiss, the 2a row.** Surface a pending user comment (same `surfaced` Map), flip it to `dismissed`, bump `editedAt`. The second poll returns it with `edited: true`. Green on master and after the fix; red against a bare `status === "pending"` gate — its job is to stop the gate being narrowed later.

Run: `npx vitest run tests/client/use-annotation-review.test.ts tests/server/inbox-ledger-undo.test.ts tests/server/awareness.test.ts tests/server/awareness-tools.test.ts tests/server/adr027-note-write-guards.test.ts tests/server/read-audience-filter.test.ts tests/server/held-in-solo-stamp.test.ts tests/server/mcp-output-schemas.test.ts tests/server/mcp-tool-integration.test.ts`, plus `npm run typecheck`. No E2E, no Rust, no skill bump. `awareness-tools.test.ts` is the densest driver of this bucket (the ledger-VALUE rows at `:268-271` and `:409-411`, the Solo rows at `:584-610`); every user-comment fixture in it is `status: "pending"`, so none is expected to go red. The promotion path is safe today because both entry points are pending-gated (`canSendToClaude`; the batch selection pruned against `filteredData.pending`) — a later widening of either is what re-opens this.

## Done when

Items 1 and 2 are fixed with specs red on `origin/master`; `git diff --stat` on the two test files shows added lines only; items 2b, 3, 4 and the `.docx` lead are written up as refutations in the PR body with their evidence; the #1656 result is recorded there; suites and typecheck green.

Item 3 has a tracked home that outlives this PR. `Closes #1826` retires the only issue holding it, and a refutation paragraph in a merged PR body is not a tracked home — the sweep doc lists #1826 nowhere but its wave rows (`docs/plans/2026-09-06-open-issues-sweep.md:86`, `:219`, `:411`) and it is absent from the DECIDE bucket at `:54`, so on merge the two named consequences (a live suggestion left over applied text; a force-reload clear resurrecting a record anchored into gone content) would survive only in prose nothing reads. **File a new issue for server-serialized annotation writes**, quoting `annotations.md:23`'s reproduction and naming `experiments/yjs-race.ts`, and reference it from the PR body; a DECIDE row in `docs/plans/2026-09-06-open-issues-sweep.md` naming "#1826 item 3" explicitly is the alternative if Bryan prefers to decide it in the sweep. Either one, but not neither.

Word the ledger and PR claim as **"no SILENT divergence after a failed Accept"**, not "push and pull agree after Accept", and do not extend it to the edit path.

*Not a gate, verified by reading the diff:* the corrected comments in `useAnnotationReview.svelte.ts` and the branch comment in `awareness.ts` carrying the within-a-server-run bound.

## Not in scope

**The Undo path reproduces the same divergence, by design.** `undoResolveAnnotation` writes `revertedToPending(ann)` after `annotation:accepted` was emitted, and the observer still has no revert arm. That is a deliberate user reversal, recovered on pull via #1770's `(id, status)` ledger key. This PR closes only the failed-Accept arm.

**Restart-then-edit of a resolved user comment reproduces the same class, and this PR accepts it.** Bounded in the item-2 Fix; closing it properly means a durable ledger, which is scope this group does not carry. Do not word the PR claim as though the edit path is covered after a restart.

`docs/mcp-tools.md` and `docs/security.md` — untouched (see the scope cut). A new channel event type for un-resolve. Server-serialized annotation writes (item 3's real fix). #1779's Solo copy. #1813's force-open envelope decision. Any change to the observer, to `isClaudeFacing`, to the four write guards, or to `addUserReply` / `removeAnnotationRecord`, which the two seam tests pin as unguarded.

## Review corrections (scope cut)

**Removed, not repaired**

- **The `docs/mcp-tools.md:1101` amendment.** This is what round 2's first blocking finding targeted — the prescribed replacement wording ("on any later edit whatever its status") would have landed a claim the in-memory ledger does not honour. Removing the edit moots it: the existing sentence, "`userActions`: new or edited user comments", is exactly the shape of the new gate (`status === "pending" || edited`) and is not made false by it. The restart bound now lives in the branch comment and `## Not in scope` only.
- **Test row 10** (a `{dismissed, editedAt: 5}` record with a fresh Map yielding `[]`). It was green on master too, so it pinned prose rather than behaviour. The bound it documented is stated in the Fix and in `## Not in scope`.
- **Test row 7**, the separate restart control — row 4 already constructs a fresh `surfaced` Map, which is the restart.
- **Test row 9**, the added ledger-key-shape assertion inside the existing `:129` spec. Repairing a mutation-kill in a spec this PR does not otherwise touch is drift-guard maintenance the issue did not ask for; the additions-only rule for that file stands.
- **The `withoutResolver` extraction** and its test row. The stale `resolvedBy` on the SUCCESS write is a #1770 residual, not #1826 item 1, and it carried a `TS2322` hazard (`Omit` over a discriminated union) plus two forbidden ways of clearing the red. The failure-path stripper is unchanged, so both existing #1770 pins stay green.
- **`docs/security.md`'s `## Privacy` sentence** (durable envelope stores notes in clear) and **the `g-inbox-ledger.test.ts` header amendment**. Both are lead/bookkeeping edits to files item 1 and item 2 do not name.
- **The `tests/server/inbox-ledger-undo.test.ts` file-header amendment.** Re-read on this branch: the sentence is about the ledger KEY (bare id for user comments) and the re-surface rule, neither of which changes — first *surfacing* gains a gate, re-surfacing does not. No edit needed.
- Both rounds of prior review-correction prose (~45 lines).

**Fixed directly**

- **Round 2 finding 2 — the item-2 test set was seeded at `status: "dismissed"` only**, so a lazy `status !== "dismissed"` would pass every row while leaving half the defect live. Verified: `transitionPending` refuses an accept only for `ann.author === "claude"` and for a record carrying `suggestedText` (`lifecycle.ts:952-957`), and an outbound user comment is not withheld — so `tandem_resolveAnnotation(id, "accepted")` yields `{author: "user", type: "comment", status: "accepted", resolvedBy: "claude"}`, which master re-surfaces on restart exactly as the dismissed one does. Row 4 is now `it.each(["dismissed", "accepted"] as const)` with the `resolvedBy` stamp on the accepted fixture, and the Fix requires the gate in its positive form.
- **Round 2 finding 1's non-doc half** — the `|| edited` invariant is now scoped to "within a server run" in the Fix bullet and the branch comment, and the restart-then-edit sequence is named in `## Not in scope` as accepted. The predicate is deliberately not widened.

**Not adopted**

- *Nothing was refused on its merits.* Finding 1's prescribed doc wording and its test row 10 were dropped with the mechanisms they attached to, as above.

## Review corrections (post-cut)

**Adopted**

- **Item 3 lost its tracked home.** The spec refuted the proposed `version`-field compare-and-set correctly (it cannot hold in a CRDT), then parked the real fix "under `bryan`" — a list that does not exist. Checked: `grep -n 1826 docs/plans/2026-09-06-open-issues-sweep.md` returns only the wave-table row (`:86`), the bulk mention (`:219`) and the status table (`:411`); the DECIDE bucket at `:54` does not list it. Meanwhile `docs/reviews/2026-09-02-v1-review/areas/annotations.md:23` records the race as reproduced 3/3 with two named consequences. Refuting an item is not the same as closing it, and `Closes #1826` would have retired both together. `## Done when` now requires a filed issue (or an explicit DECIDE row) before merge. No code change: the refutation itself stands.
