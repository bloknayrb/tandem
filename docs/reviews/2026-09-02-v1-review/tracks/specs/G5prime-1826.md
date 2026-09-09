# G5′ — #1826 annotation-lifecycle Lows: push/pull disagree after a failed Accept; `userActions` has no status gate; concurrent `map.set` races

Branch `fix/audience-remnants-1698`. Closes #1826. Refs #1656 (already closed on master — this PR only confirms its pin, see below). Ledger: `docs/reviews/2026-09-02-v1-review/areas/annotations.md:23` (the L row), plus "Already tracked or already fixed", "Leads not run" and "Doc drift" in the same file. Probe: `experiments/harness/g-inbox-ledger.test.ts` case 2 (re-run below).

The issue lists five numbered items. Two are real and fixed here, one is refuted as posed, one belongs to another issue, one splits into a refutation and a one-sentence doc line.

## Problem

**1 — push and pull disagree after a failed Accept.** `resolveAnnotation` in `src/client/panels/useAnnotationReview.svelte.ts` writes `withBrowser(y, () => map.set(id, { ...ann, status }))` FIRST, then calls `applySuggestion`, and on a `false` return writes `revertedToPending(ann)`. Both writes are `withBrowser`, so both reach the channel observer — but only the first produces an event: `src/server/events/observers/annotations.ts`'s `action === "update" && ann.author === "claude"` branch emits `annotation:accepted` for `status === "accepted"` and `annotation:dismissed` for `dismissed`, and has **no arm for a revert to `pending`**. Claude gets `annotation:accepted` on the push path and reads `pending` on every pull path. The failure is reachable through both of `applySuggestion`'s `false` returns (unresolvable range; `snapshotContradicts`, #1629), each already pinned in `tests/client/use-annotation-review.test.ts`.

**2 — `userActions` has no status gate.** In `processUnsurfacedInboxAnnotations` (`src/server/mcp/awareness.ts`), the user bucket admits `ann.author === "user" && ann.type === "comment" && isClaudeFacing(ann)` with no `status` test, while the Claude bucket next to it tests `ann.status !== "pending"`. **Reproduced** (in-memory, this branch): a `{author: "user", type: "comment", status: "dismissed", audience: "outbound"}` record lands in `userActions` with length 1. `audience: "outbound"` is not a contrivance — `sanitizeAnnotation` derives exactly that for a user comment (measured). The dedup ledger (`surfacedIds`) hides this while a server run lasts and `transitionPending` does not bump `editedAt`; it is a module-level `Map`, so **every server restart re-surfaces every resolved user comment as a fresh user action**, and a user edit of a resolved comment does the same within one run.

**2b — REFUTED as posed.** The issue adds "`tandem_resolveAnnotation` accepts user highlights (no author guard)". #1803 closed that: `transitionPending` gates on `isWithheldFromClaude` (= `!isClaudeFacing`), and every user highlight is `audience: "private"` after sanitize's user-scoped demotion, so it answers `invalid-note`. Pinned by `tests/server/adr027-note-write-guards.test.ts` → "refuses a user's private HIGHLIGHT on resolve and remove (#1803 residual)". No change; record it in the PR body.

**3 — REFUTED as posed.** The observation (concurrent `map.set` on one key resolves by clientID, `experiments/yjs-race.ts`) is correct and is Y.Map's defined LWW semantics. The proposed remedy — "a `version` field with compare-and-set on the write helpers" — cannot hold in a CRDT: two clients both read version *N*, both write *N + 1*, and Yjs still resolves by clientID; there is no atomic read-modify-write across peers, so the field would report a false guarantee. The two named symptoms are also already bounded: browser-Accept vs Claude `editPending` is closed by `editPending`'s `status !== "pending"` refusal once the accept syncs (the residue is sync latency, which no per-key version removes), and force-reload-clear vs browser-Accept is force-open's documented destructiveness, decided in #1827 C and tracked in #1813. Fixing this properly means an authority change (server-serialized annotation writes), which is a design decision, not a Low. Listed under `bryan`; no code.

**4 — not this issue's.** `user-guide.md:296` "held back from the document" and the Solo `tandem_comment` copy are #1779's, as the issue body itself says.

**5 — the two leads.** `tandem_save` on `.docx` in Solo: **refuted.** `docx-export.ts` → `prepareExportComments` (`docx-comment-export.ts`) already applies the ADR-027 gate (notes and highlights are never exported, and it sanitizes — its `warn` on "sanitize rewrote …" is that call). What Solo holds is the USER's own annotations from *Claude*; writing them into the user's own file is not a Claude-facing surface. The durable envelope holding notes in clear on disk is by design and gets its one sentence.

**#1656 — pin confirmed, nothing to change.** The gate is `isClaudeFacing` in `src/server/annotations/projection.ts` (`type !== "note" && audience === "outbound"`), reached from both inbox buckets. **Measured on this branch:** mutating it to `return ann.audience === "outbound"` turns `adr027-note-write-guards.test.ts` → "drops a claude-authored record that sanitizes to a note" red (2 failures in that file, that spec among them). The pin is discriminating — both of its seeds are `outbound`, so the type half is the only thing excluding the legacy record. No test is added.

## Fix

**Item 1 — `src/client/panels/useAnnotationReview.svelte.ts`, `resolveAnnotation`.** Apply first, write the status once, only on success:

```ts
if (status === "accepted" && ann.suggestedText !== undefined) {
  const editor = getEditor();
  if (editor && !applySuggestion(ann, editor, y, getFormat?.())) {
    onApplyFailed?.(ann);
    return;                       // nothing written — no event, no divergence
  }
}
withBrowser(y, () => map.set(id, { ...ann, status }));
```

- Emitting a compensating event was the other option in the issue; it is bigger (a new wire type through `events/queue.ts`, `delivery-state.ts` and the channel schema) and still leaves a window in which push and pull disagree. Rejected; state it in the PR body.
- `applySuggestion` reads only its `ann` argument and the editor state — never the map's `status` — so the reorder is safe by construction. The "THREE SEPARATE ONE-STATEMENT TRANSACTIONS" rule is preserved: still no wrap spanning the block, so y-prosemirror's own transaction never inherits our origin and `yUndoPlugin` keeps capturing the accepted text.
- `withBrowser` is the right helper and must stay: this is the user's action and it is the only origin that reaches the channel.
- **Two docblocks become false and must change in the same commit** (verify cross-references): `applySuggestion`'s "`resolveAnnotation` has already written `status: "accepted"` and only reverts on a `false` RETURN, so a throw escaping here would strand the annotation accepted" — after the reorder a throw strands nothing, and the guard-inside-the-`try` rationale should say so; and `UseAnnotationReviewOptions.onApplyFailed`'s "The annotation has already been reverted to `pending` by the time this fires" — it was never moved off `pending`.
- `revertedToPending` stays — `undoResolveAnnotation` still calls it, so this is not dead code.

**Item 2 — `src/server/mcp/awareness.ts`, `processUnsurfacedInboxAnnotations`.** Add `ann.status === "pending"` to the user-comment branch condition, immediately after the type test and before `isClaudeFacing`. Placement matters for the same reason the Solo hold's does: a non-matching record must take no `surfaced.set`, so the ledger is never poisoned and a record the user later re-opens (Undo writes `pending` without touching `editedAt`) still surfaces. Update the branch comment to name the gate and the symmetry with the Claude bucket. No origin helper involved — this path only reads.

**Doc — `docs/security.md`, `## Privacy`.** One sentence on the ADR-027 bullet: the durable annotation envelope under the annotations dir stores notes in clear on disk, by design — ADR-027 governs what Claude may read, not at-rest encryption. Nothing else in that file changes.

**Review artifact — `experiments/harness/g-inbox-ledger.test.ts`.** Its header says case 1 is superseded and "the SECOND case is #1826's and still reproduces". Amend that line to name this PR and note the fixture needed `audience: "outbound"` to reproduce post-#1619. The file stays uncollected; do not otherwise "fix" it.

## Tests

1. **`tests/client/use-annotation-review.test.ts` — the discriminator for item 1.** Attach a `map.observe` collecting every `status` written for the id. On a failed apply (reuse the existing unresolvable-range fixture at "reverts to pending and calls onApplyFailed…"), assert the observer saw **zero** writes and the stored status is still `pending`. Today it sees `["accepted","pending"]`, so this is red on master. A status-only assertion is not enough — the existing specs already assert `pending` and stay green under the bug, which is exactly why the bug survived them.
2. Same file, **positive control**: on a successful apply, exactly ONE write, `status: "accepted"`. Kills a fix that stops writing the status at all, and kills a double-write.
3. Same file, **dismiss control**: `resolveAnnotation(id, "dismissed")` on a record with `suggestedText` still writes `dismissed` exactly once (the apply block must remain accept-only).
4. **`tests/server/inbox-ledger-undo.test.ts` (or a sibling in `tests/server/`) — item 2.** Port `g-inbox-ledger.test.ts` case 2 to a real spec, with `audience: "outbound"` on the fixture: a `{author: "user", type: "comment", status: "dismissed"}` record yields `userActions: []`. Then the **control** in the same spec: the identical record at `status: "pending"` yields one `userAction` — without it, a gate that empties the bucket passes.
5. Same spec, **ledger control**: a pending user comment surfaces once, and a second poll after Claude dismisses it returns nothing, with a fresh `surfaced` Map standing in for a server restart. That is the reachability the fix is for.

Run: `npx vitest run tests/client/use-annotation-review.test.ts tests/server/inbox-ledger-undo.test.ts tests/server/awareness.test.ts tests/server/adr027-note-write-guards.test.ts`, plus `npm run typecheck`. No E2E, no Rust, no skill bump.

## Done when

Items 1 and 2 are fixed with specs that are red on `origin/master`; items 2b, 3, 4 and the `.docx` lead are written up as refutations in the PR body with their evidence; the #1656 mutation result is recorded there; the `security.md` sentence and the two false docblocks land in the same commits; suites and typecheck green.

## Not in scope

A new channel event type for un-resolve. Server-serialized annotation writes (item 3's real fix). #1779's Solo copy. #1813's force-open envelope decision. Any change to `isClaudeFacing`, to the four write guards, or to `addUserReply` / `removeAnnotationRecord`, which the two seam tests pin as unguarded.
