# G5' — #1698 the ADR-027 presence guard reads the RAW type, so a legacy `flag` note's id is broadcast

Branch `fix/audience-remnants-1698`. Closes #1698. Ledger: `docs/reviews/2026-09-02-v1-review/areas/annotations.md:30`, wave-4 row `docs/plans/2026-09-06-open-issues-sweep.md:86`.

## Problem

`sanitizeAnnotationIdForPresence` (`src/server/mcp/typing-presence.ts`, search the symbol — line numbers drift) reads the Y.Map record and gates on the **stored** type:

```ts
const ann = map.get(annotationId) as Annotation | undefined;
if (!ann || typeof ann !== "object") return undefined;
if (ann.type === "note") return undefined;
```

A stored `{ type: "flag" }` — reachable from a pre-ADR-027 document or a stale-tab CRDT merge — is a note only once `sanitizeAnnotation` normalizes it (`src/shared/sanitize.ts`, the `flag`/`note` branch). So a `flag` passes this guard and its id is written into `Y_MAP_AWARENESS`/`Y_MAP_CLAUDE` by `withTypingPresence`. Same class as #1680/#1619; CLAUDE.md already states the rule the write families obey and this read path does not. The function's own docblock also lists `flag` among the types "safe to broadcast", contradicting `sanitize.ts` in writing.

**Exposure, stated precisely.** Nothing on the MCP surface reads `working.annotationId` back — its only readers are `src/client/**` (`editor/extensions/awareness.ts`, `hooks/yjsSync.svelte.ts`), and `presence-expiry.ts` reads only whether `working` is set (`:115`). So this is not a demonstrated wire disclosure; what it does today is render Claude's typing indicator on the user's private note card and leave the one guard ADR-027 named for awareness disagreeing with the normalizer.

**The fix is the note half only, deliberately.** The single call site is `tandem_annotationReply` (`src/server/mcp/annotations.ts`), so the `annotationId` **originates from the caller**, and `lifecycle.reply` already refuses both a private comment (`isPrivateForClaude`) and a highlight (`not-repliable`). Echoing a caller-supplied id back into a marker rendered on the user's own client discloses nothing Claude did not hold. Widening to `isClaudeFacing` is out of scope (see below).

## Fix

One file, `src/server/mcp/typing-presence.ts`:

- Replace the raw `ann.type === "note"` test with `sanitizeAnnotation(ann as RawAnnotation, (e) => relaySanitizationEvent(docName, e)).type === "note"`. The model is `transitionPending` in `src/server/annotations/lifecycle.ts`: sanitize, then gate. Import `sanitizeAnnotation` + `RawAnnotation` from `../../shared/sanitize.js` and `relaySanitizationEvent` from `../annotations/migration-log.js` (neither creates a cycle). A `() => {}` for `onLossy` is the anti-pattern Unit 8d removed from `transitionPending`; `docName` is in hand and is what the relay dedups on.
- The existing `try { … } catch { return undefined }` stays and now also covers a record `sanitizeAnnotation` chokes on — fail-closed, the documented posture.
- **Correct the docblock.** Safe-to-broadcast becomes `comment`, `highlight` — **delete `flag`** — and the text says the check runs on the **sanitized** value. Say "the note half, on the sanitized value", never "notes are now caught": a record whose `type` sanitize does not recognize is coerced to `{comment, outbound}` (`sanitize.ts:222`) and still passes. Add one clause recording the caller-originated bound above.

No Y.Doc write is added (the guard is read-only; `withTypingPresence`'s own writes stay `withMcp`). `Y_MAP_ANNOTATIONS` keeps arriving as the caller-passed `annotationsMapKey`. No MCP tool, no `/api` route, no `data-testid`, no skill edit, no doc file.

## Tests

`tests/server/typing-presence.test.ts`, beside the existing note case:

1. **The discriminator.** Seed a record stored as `{ type: "flag" }` and assert `sanitizeAnnotationIdForPresence` returns `undefined`. Red on `origin/master`, green after — it is the only thing that kills the raw read (a `type: "note"` seed stays green under the bug). Seed it via the shared `seedRawAnnotation` (`tests/helpers/ydoc-factory.ts:116`), whose `extra` is `Record<string, unknown>` and needs no cast; the file's local `seedAnnotation` is typed `Annotation["type"]` and cannot express `flag` — do **not** widen and cast it, and leave the well-formed rows on it.
2. **Positive control.** Add a `highlight` row asserting the id IS returned, framed as "a non-note type is broadcast" so an over-narrowing to `type === "comment"` dies. An in-test comment must say this is not a pin that a private highlight *should* broadcast — a later `isClaudeFacing` tightening is expected to change this row.

Run: `npx vitest run tests/server/typing-presence.test.ts tests/server/adr027-note-write-guards.test.ts`, plus `npm run typecheck`.

## Done when

The `flag` row is red on `origin/master` and green on the branch; the non-note control holds; typecheck and the two suites green.

*Not a gate, verified by reading the diff:* the docblock no longer lists `flag`, says the check runs on the sanitized value, and carries the note-half-only clause. No test pins docblock prose and none is added.

## Not in scope

The client-side raw-type reads (#1678, closed). `presence-expiry.ts` — it never writes `working` (its docblock at `:38-46` forbids it; the field's only occurrence is the read at `:115`), so it cannot re-broadcast a filtered id. **Widening the guard from the note half to `isClaudeFacing`** — a stored `{comment, private}` and a user highlight still have their ids echoed, bounded above. **The `unknown-type` coercion** — `sanitize.ts:222` coerces an unrecognized type to `comment`, so a note whose `type` was dropped still passes; the companion refusal (`narrowForChannel`, `src/server/annotations/projection.ts:201-251`, which refuses on the lossy *signal*) is the shape a later widening adopts, not this PR. `docs/security.md` — the register is for findings that stay open, and the `## Privacy` ADR-027 bullet already states the after-sanitize rule this fix makes true here.

## Review corrections (scope cut)

Removed, not repaired:

- **The `relaySanitizationEvent` console-spy test row** (`resetMigrationLog()` + `vi.spyOn(console, "error")` asserting a `flag-to-note` line). It pinned the *shape* of the implementation rather than the issue's defect, and asserting on a log line is machinery the issue did not ask for. The `onLossy` requirement stays stated in the Fix as the codebase pattern; row 1 is the discriminator that matters.
- **The `withTypingPresence` wiring row** (capture-inside-the-handler, degrade-to-generic assertion). The issue is about what the guard returns; the caller already passes the guard's result and nothing in this PR touches that seam.
- **The audit-of-every-other-gate enumeration** (`collectAnnotations`, `observers/annotations.ts`, `docx`, the four write families). It was a sweep, not a change, and its conclusion was "no second instance"; the one line worth keeping is that this is the same class as #1680/#1619.
- Both rounds of prior review-correction prose (~30 lines), which restated findings already folded into the text.

No blocking finding was outstanding against this spec; nothing was refused.
