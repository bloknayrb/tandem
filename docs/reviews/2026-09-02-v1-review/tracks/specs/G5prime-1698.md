# G5′ — #1698 the ADR-027 presence guard reads the RAW type, so a legacy `flag` note's id is broadcast

Branch `fix/audience-remnants-1698`. Closes #1698. Ledger: `docs/reviews/2026-09-02-v1-review/areas/annotations.md:30` ("no further raw-type-before-sanitize reads on Claude-facing paths") and the wave-4 row `docs/plans/2026-09-06-open-issues-sweep.md:86`. Probe: mutation-run of `tests/server/typing-presence.test.ts` (below).

## Problem

`sanitizeAnnotationIdForPresence` (`src/server/mcp/typing-presence.ts`, search the symbol — line numbers drifted) reads the Y.Map record and gates on the **stored** type:

```ts
const ann = map.get(annotationId) as Annotation | undefined;
if (!ann || typeof ann !== "object") return undefined;
if (ann.type === "note") return undefined;
```

`sanitizeAnnotation` (`src/shared/sanitize.ts`, the `flag`/`note` branch) is what decides a record is a note: a stored `{ type: "flag" }` — reachable from a pre-ADR-027 document or a stale-tab CRDT merge — normalizes to `note` and emits `flag-to-note`. So a `flag` passes this guard and its id is written into `Y_MAP_AWARENESS`/`Y_MAP_CLAUDE` by `withTypingPresence`. The function's own docblock additionally lists `flag` among the types "safe to broadcast", which contradicts `sanitize.ts` in writing.

**State the exposure precisely, the way the #1656 close did.** Nothing on the MCP surface reads `working.annotationId` back — the only readers are `src/client/**` (`editor/extensions/awareness.ts`, `hooks/yjsSync.svelte.ts`) and the server's own sweep in `presence-expiry.ts`. So this is not a demonstrated wire disclosure to Claude; what it does today is render Claude's typing indicator on the user's private note card, and leave the one guard ADR-027 named for awareness disagreeing with the normalizer. It is the same class as #1680/#1619 — CLAUDE.md already states the rule ("a legacy `flag` is a note only once normalized"), and the write families obey it while this read path does not.

The single call site is `tandem_annotationReply` (`src/server/mcp/annotations.ts`, the `gatedTool("tandem_annotationReply", …)` body).

**Audited, no second instance.** Every other server-side note/type gate reads a sanitized value: `awareness.ts`'s two inbox buckets and `mcp/annotations.ts`'s two disclosure counters run on `collectAnnotations`/`listAnnotationsRefreshed` output (`collectAnnotations` calls `sanitizeAnnotation` per record); `events/observers/annotations.ts` narrows through `narrowForChannel` and reads the OLD type through `sanitizeOldType`; `file-io/docx.ts`'s `exportAnnotations` filter takes an already-sanitized `Annotation[]`; the four write families sanitize first (`lifecycle.ts`). Client-side raw reads are #1678's, already closed.

## Fix

One file. In `sanitizeAnnotationIdForPresence`:

- Replace the raw `ann.type === "note"` test with `sanitizeAnnotation(ann as RawAnnotation, (e) => relaySanitizationEvent(docName, e)).type === "note"`. The model is `transitionPending` / `removeForClaude` in `src/server/annotations/lifecycle.ts`: sanitize, then gate. Import `sanitizeAnnotation` + `RawAnnotation` from `../../shared/sanitize.js` and `relaySanitizationEvent` from `../annotations/migration-log.js` (neither import creates a cycle — `migration-log.ts` pulls only the shared event type).
- `onLossy` is **required by design** (a `() => {}` there is the exact regression Unit 8d removed from `transitionPending`); `docName` is already in hand and is the room name, which is what the relay dedups on.
- The existing `try { … } catch { return undefined }` stays and now also covers a malformed record that `sanitizeAnnotation` chokes on — fail-closed, which is the documented posture ("when in doubt, drop it").
- Correct the docblock: the safe-to-broadcast list becomes `comment`, `highlight` — **delete `flag`** — and say the check runs on the sanitized value.

Rules that bite here: no Y.Doc write is added, so no origin helper changes (the guard is read-only; `withTypingPresence`'s own writes stay `withMcp` — `withBrowser` would emit channel events for Claude's own presence). `Y_MAP_ANNOTATIONS` continues to arrive as the caller-passed `annotationsMapKey`, not a literal. No new MCP tool or `/api` route, so no license-gate table row. No `data-testid`, no skill edit.

**No `docs/security.md` entry.** The issue asked for one "alongside the fix" because it was filed as an open finding; the register is for findings that remain open, and this PR closes it. The `## Privacy` section's ADR-027 bullet already states the after-sanitize rule for the write guards — the fix makes the awareness guard match the sentence that is already there, so nothing in that file becomes false. (Assumption; listed in `assumptions`.)

## Tests

`tests/server/typing-presence.test.ts`, beside the existing note case:

1. **The discriminator.** Seed a record stored as `{ type: "flag" }` and assert `sanitizeAnnotationIdForPresence` returns `undefined`. `seedAnnotation`'s parameter is typed `Annotation["type"]`, which cannot express `flag`; widen it to `Annotation["type"] | "flag"` and cast at the `map.set` (the same shape `adr027-note-write-guards.test.ts` uses for its `flag` seeds). This spec is red against `origin/master` and green after — it is the only thing that kills the raw read. A test seeded with `type: "note"` does not: the existing note case stays green under the bug.
2. **Positive controls, so a guard that refuses everything cannot pass.** The existing `comment` case already covers one; add a `highlight` case asserting the id IS returned — that one kills an over-narrowing to `type === "comment"`, which the corrected docblock would otherwise invite.
3. **Wiring, not just the predicate.** Drive `withTypingPresence({ tool: "tandem_annotationReply", annotationId: sanitizeAnnotationIdForPresence(...) })` over the `flag` record and assert `readWorking(doc)?.annotationId` is `undefined` while `tool` is still set — i.e. the indicator degrades to the generic one rather than vanishing. Kills a "fix" that drops the whole presence write.

Run: `npx vitest run tests/server/typing-presence.test.ts tests/server/adr027-note-write-guards.test.ts`.

## Done when

The `flag` spec is red on `origin/master` and green on the branch; the two positive controls hold; the docblock no longer lists `flag`; `npm run typecheck` + the two suites green.

## Not in scope

The client-side raw-type reads in `src/client/panels/annotation-actions.ts` and `annotation-card-helpers.ts` (#1678, closed). `presence-expiry.ts`'s write-back — it re-writes the already-sanitized id held in `active`, so it inherits the fix. Any change to what MCP tools may read from awareness.
