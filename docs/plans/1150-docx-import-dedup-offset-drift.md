# Fix #1150 — docx imported-comment dedup is offset-sensitive (duplicates on file-watcher reload after drift)

Plan reviewed by crdt-reviewer + annotation-model-reviewer + a general adversarial pass; findings folded in (two convergent Criticals + the promote-drift ghost + precision items).

## Context

Imported Word comments are deduped by `importAnnotationId(commentId, from, to, bodyText)`
(`src/server/file-io/docx-comments.ts:34-46`), a SHA-256 over the comment id **plus its flat
offsets and body**. The injection loop dedupes with `map.has(id)` (line 394). When a comment's
offsets (or body) change between imports — an external process edits the open `.docx`, moving the
comment, and the user picks "reload" on the conflict banner — the recomputed id no longer matches
the live annotation's key, so a **duplicate** imported note is injected under the new key while the
stale-offset one remains.

Why it bites **only** the reload path:
- **Fresh open** injects under `withInternal`, which durable-sync skips, so imported notes are
  transient and re-derived into an empty map on every reopen → exactly one note (pinned by a #1149
  test).
- **File-watcher reload** (`reloadFromDisk`, `file-opener.ts:1371-1399`) re-injects under
  `withReload` into a map that **still holds the live note**, before `refreshAllRanges` runs. Offset
  drift → id miss → duplicate, persisted to the annotations JSON.

Pre-existing (predates #1149/#1068); #1149 made it more reachable (imported comments now round-trip
back into the saved file, so a duplicate double-writes the `.docx`).

## Design

Add a **second dedup axis keyed on the stable Word comment identity** (`importSource.commentId`),
under the existing offset-hash dedup. The offset hash stays primary (cheap, exact, unchanged for the
common no-drift case); the commentId index is the fallback that catches drift.

### Key: `commentId` alone (general reviewer confirmed safe)

Verified by full caller trace: only `reloadFromDisk` (file-watcher / source-view reload /
backup-restore) injects into a non-empty map, and every entry point re-imports **the same room's own
path** — same `w:id` namespace. Force-reload clears the map first (`clearDocMaps`). Room-per-path
makes "two files → one map" architecturally impossible, and `parseCommentMetadata` keys by `w:id` so
two comments can't share an id within one docx. Including `importSource.file` in the key would
*reintroduce* the duplicate on the edges where it diverges (open uses `displayName`, reload uses
`basename`, Save-As/rename repoints the path). **No `file` tie-breaker** — first-seen-wins plainly
(per general reviewer S1; the tie-breaker added reasoning surface for ~zero benefit).

### Index build — guarded against the slice-collision (general reviewer C1, Real)

Stored `importSource.commentId` is sliced to `IMPORT_COMMENT_ID_MAX` (32). Keying the index on a
sliced value would let two crafted ids sharing a 32-char prefix collapse into one bucket → a silent
cross-comment content swap on drift, **worse** than the duplicate it replaces. Guard: only index /
look up entries whose commentId is a **canonical non-negative decimal** AND **`length <
IMPORT_COMMENT_ID_MAX`** (i.e. provably un-truncated — and consistent with the export side's existing
`reusableCommentId` decimal validation). Real Word ids are short decimals, so this covers every real
case; crafted/truncated ids skip the secondary axis and degrade to today's accepted
duplicate-on-drift — never a silent swap.

Build `byCommentId: Map<string, { key; ann }>` in one pass over the annotation map. **Index two
record kinds**, tracking which:
- `author === "import"` notes → candidates for **in-place drift-update**.
- Promoted-from-import records (`promotedFrom === "note"` **and** `importSource?.commentId` present;
  `annotation-actions.ts:46-65` keeps `importSource` and stamps `promotedFrom:"note"` on promote) →
  candidates for **skip** (see I1 below). The update filter is `author === "import"` **exactly**
  (NOT `importSource != null`, which survives promotion) — this is the ADR-027 load-bearing guard
  both specialists flagged.

On a `commentId` collision within the index, first-seen-wins.

### Algorithm (in `injectCommentsAsAnnotations`, `docx-comments.ts:355-490`)

Inside the existing loop, **reusing the `result` already computed at line 377** (still inside the
`if (!result.ok) continue` guard — do not recompute `anchoredRange`; crdt I3), after
`const offsetId = importAnnotationId(...)` resolve the **effective key**:

1. `map.has(offsetId)` → `effectiveKey = offsetId`. Offsets stable: existing migration / #1068
   backfill branches run unchanged (they already key on `author === "import"`, so a promoted record
   here is left alone).
2. else, if the commentId passes the canonical-decimal guard and `byCommentId` has it:
   - matched record is **`author === "import"`** → **drift-update in place** under `entry.key`
     (`effectiveKey = entry.key`; do NOT insert `offsetId`). Build a fresh record:
     - reuse the explicit override block from the migration branch (`docx-comments.ts:401-412`):
       `type: "note" as const, audience: "private" as const, content: comment.bodyText,
       importSource: { author, file, commentId }`, `rev: nextRev(existing)` (NOT `nextRev()`; S2),
     - `range: { from: result.range.from, to: result.range.to }`,
     - **`relRange: result.fullyAnchored ? result.relRange : undefined`** — an explicit ternary, and
       on the `undefined`/not-anchored path ensure the key is actually **removed**, not inherited
       from `...existing`. **This is the convergent Critical (crdt C1 + annotation-model C1):** a
       conditional spread `...(fullyAnchored ? {relRange} : {})` over `...existing` leaves the
       pre-reload `relRange` (a RelativePosition into content `htmlToYDoc` just deleted) glued to a
       fresh flat range. `refreshRange` resolves relRange *first* and can overwrite the correct flat
       offsets with garbage — silent offset corruption, persisted under `withReload`. Mirror
       `refreshRange`'s degraded branch (`positions.ts:358-359`) / the relocation pass at
       `file-opener.ts:1440`: set/strip relRange explicitly.
     - count as `migrated`, not `injected`.
   - matched record is **promoted** (`promotedFrom:"note"`) → **skip entirely** (I1): do not inject a
     note, do not touch the promotion, and **skip this comment's reply loop**. Leaving it to the
     "new" branch would inject a ghost private note for a Word comment the user already promoted —
     the map would hold both, and the comment would **round-trip twice into the `.docx` and re-ghost
     on every subsequent drift reload** (the promoted copy can never be re-indexed). `effectiveKey`
     is irrelevant here (we `continue`).
3. else → genuinely new. `effectiveKey = offsetId`; insert as today.

**Reply injection** (`docx-comments.ts:462-477`): change `annotationId: id` → `annotationId:
effectiveKey`. **Do NOT change `importReplyId(comment.commentId, ...)` at line 463** — its first arg
is the raw Word id (a different namespace from the map key); swapping it would re-hash every reply
and regress the #1000 idempotency test (annotation-model I2). Existing replies are skipped by
`repliesMap.has(replyId)` (offset-independent dedup); only genuinely-new replies attach, and they
must attach to the kept root (`effectiveKey`), never the never-inserted `offsetId`. On the stable
path `effectiveKey === offsetId === id`, so this is a no-op there.

### Deliberately out of scope (documented residues)
- **No auto-heal of pre-existing duplicates** (incl. an already-ghosted promote pair). Prevents new
  duplicates; doesn't merge old ones (healing must pick which key to keep without orphaning replies).
- **Legacy notes without `importSource.commentId`** (pre-#1068, not yet backfilled) can't be indexed
  → a drift on one still duplicates. Vanishingly narrow.
- **Crafted/truncated/non-decimal commentIds** skip the secondary axis → degrade to duplicate-on-drift
  (never a silent swap).

## Files

- `src/server/file-io/docx-comments.ts` — the `byCommentId` index + guard + drift branch + promote-skip
  + `effectiveKey` threading (`injectCommentsAsAnnotations`, ~355-490). A small `isCanonicalDecimal`
  helper (or reuse the export-side validator if exported).
- No type changes — `importSource.commentId` and `promotedFrom` already exist (`src/shared/types.ts`).
- Tests: `tests/server/docx-comments.test.ts`, `tests/server/docx-comment-export.test.ts` stay green.

## Tests (`tests/server/docx-comments.test.ts`)

1. **Drift dedup — end-to-end (acceptance).** Inject a comment, then drive a real reload-style
   re-inject of the same `commentId` with **different `from`/`to`** into the populated map, **then run
   `refreshAllRanges`** (crdt/annotation-model I3 — asserting right after inject would miss the
   step-3 clobber). Assert: exactly one `author:"import"` annotation, key unchanged, stored `range`
   == new offsets, AND `relRange` resolves to those same offsets.
2. **Drift onto a `!fullyAnchored` boundary** (e.g. heading-prefix) → assert the rewritten record has
   **no** `relRange` (not the stale one). Directly guards C1.
3. **Drift with a NEW reply on the drifted root** → assert the new reply's `annotationId ===
   effectiveKey` (kept root) and existing replies aren't duplicated. Must be a *new* reply — existing
   ones are skipped before the `annotationId` write (annotation-model I4).
4. **Promote-then-drift** → promote the note (`author:"user"`, `promotedFrom:"note"`), then drift-
   reload. Assert the promotion is preserved (still `author:"user"`/`type:"comment"`) AND **no ghost
   import note** is injected (I1).
5. **New-comment-after-drift isolation** → a second genuinely-new comment in the same reload still
   injects normally.

Regression (unchanged): #1000 "idempotent across re-imports (no duplicate replies)", #1068
"round-trips … anchors to the same text", #1149 writeback.

Verify: `npm test -- docx-comments docx-comment-export` + `npm run typecheck`. The duplicate is a
pure function of map state, so unit assertions are the right altitude; no new E2E required.

## Review gate — COMPLETE

crdt-reviewer (C1 relRange-strip), annotation-model-reviewer (privacy airtight; I1 promote-ghost; I2
reply-arg boundary; S1/S2), general (C1 slice-collision; commentId-only + reply crux confirmed;
return-value production-invisible). Privacy verified clean: the drift-update hardcodes
`type:"note"`/`audience:"private"`, never reaches a Claude-visible combination, and replies stay
`private:true`.

## Post-review amendments (PR #1166, 6-agent review)

Reviewed by code / tests / comments / silent-failure / annotation-model / crdt agents. Real
findings folded in:

- **Reply preserved on promoted+drift (silent-failure MEDIUM).** The promoted-skip branch
  originally `continue`d past the reply loop, silently dropping a Word reply added *after*
  promotion. It now falls through (`effectiveKey = drift.key`, no note written) so the reply lands
  threaded under the promoted record. Safe because an import reply is private by its own durable
  property regardless of root (annotation-model confirmed). An edited body is still intentionally
  not applied — promotion makes the content user-owned.
- **Deterministic promoted-wins index tiebreak (convergent: tests / silent-failure / annotation-
  model).** When two stored records share one canonical `commentId` (a legacy pre-#1150 duplicate),
  the index now prefers the promoted record over an import note instead of relying on Y.Map
  iteration order, and logs the collision so it is discoverable.
- **Stale `textSnapshot` strip (crdt LOW).** The drift re-anchor destructure now drops a stale
  `textSnapshot` alongside the stale `relRange`, by the same pre-reload-anchor symmetry (defensive;
  import notes do not carry one today).
- **Shared predicate extracted + comment corrected.** `isCanonicalWordId` lives in the new
  `docx-comment-id.ts` leaf module, consumed by both the import dedup and export `reusableCommentId`
  (the prior "must stay in lockstep / byte-identical copies" history was fabricated and was removed).
- **Tests added:** non-canonical `w:id` duplicates-on-drift (safety boundary), promoted-wins
  tiebreak (note inserted first so it regresses without the fix), new-reply-after-promotion lands,
  `isCanonicalWordId` unit table.

Deferred (noted, out of scope): garbage-collecting the legacy duplicate import note itself (the
tiebreak makes the skip reliable, but the stale note persists until removed); swapping the raw
NUL-byte delimiter in `importReplyId` for an escape sequence (pre-existing, makes the file diff as
binary — not a regression, and the harness cannot emit the literal escape).
