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

**Audited, no second instance — of the raw-type class.** Every other server-side note/type gate reads a sanitized value: `awareness.ts`'s two inbox buckets and `mcp/annotations.ts`'s two disclosure counters run on `collectAnnotations`/`listAnnotationsRefreshed` output (`collectAnnotations` calls `sanitizeAnnotation` per record); `events/observers/annotations.ts` narrows through `narrowForChannel` and reads the OLD type through `sanitizeOldType`; `file-io/docx.ts`'s `exportAnnotations` filter takes an already-sanitized `Annotation[]`; the four write families sanitize first (`lifecycle.ts`). Client-side raw reads are #1678's, already closed.

**The audit's bound, stated so it is not over-read (review round 1).** It covers raw-type-before-sanitize reads only. After this fix the guard is still the **note half alone**: a stored `{type: "comment", audience: "private"}` record and a user highlight both still have their id echoed into `Y_MAP_CLAUDE`. That is deliberate, not an oversight — the `annotationId` here **originates from the caller**: the only call site is `tandem_annotationReply`, whose own `lifecycle.reply` then refuses both a private comment (`isPrivateForClaude`, `src/server/annotations/lifecycle.ts`) and a highlight (`not-repliable`), so echoing the id Claude just supplied back into a marker rendered on the user's own client discloses nothing Claude did not already hold. Widening this guard to `isClaudeFacing` is out of scope for this PR; the docblock must not claim more than the note rule.

## Fix

One file. In `sanitizeAnnotationIdForPresence`:

- Replace the raw `ann.type === "note"` test with `sanitizeAnnotation(ann as RawAnnotation, (e) => relaySanitizationEvent(docName, e)).type === "note"`. The model is `transitionPending` / `removeForClaude` in `src/server/annotations/lifecycle.ts`: sanitize, then gate. Import `sanitizeAnnotation` + `RawAnnotation` from `../../shared/sanitize.js` and `relaySanitizationEvent` from `../annotations/migration-log.js` (neither import creates a cycle — `migration-log.ts` pulls only the shared event type).
- `onLossy` is **required by design** (a `() => {}` there is the exact regression Unit 8d removed from `transitionPending`); `docName` is already in hand and is the room name, which is what the relay dedups on. **This is now pinned by a test** — see Tests 1, which observes the `flag-to-note` line the relay produces. Without that assertion the whole `onLossy` requirement is asserted by nothing.
- The existing `try { … } catch { return undefined }` stays and now also covers a malformed record that `sanitizeAnnotation` chokes on — fail-closed, which is the documented posture ("when in doubt, drop it").
- **Correct the docblock, without overstating it.** The safe-to-broadcast list becomes `comment`, `highlight` — **delete `flag`** — and the text says the check runs on the **sanitized** value. Add one clause recording the bound above: the check is the note half only, deliberately **not** `isClaudeFacing`, because the id originates from the caller (`tandem_annotationReply`) and the marker is rendered to the user's own client; a stored `{comment, private}` or a user highlight is still echoed here and that is out of this PR's scope.

Rules that bite here: no Y.Doc write is added, so no origin helper changes (the guard is read-only; `withTypingPresence`'s own writes stay `withMcp` — `withBrowser` would emit channel events for Claude's own presence). `Y_MAP_ANNOTATIONS` continues to arrive as the caller-passed `annotationsMapKey`, not a literal. No new MCP tool or `/api` route, so no license-gate table row. No `data-testid`, no skill edit.

**No `docs/security.md` entry.** The issue asked for one "alongside the fix" because it was filed as an open finding; the register is for findings that remain open, and this PR closes it. The `## Privacy` section's ADR-027 bullet already states the after-sanitize rule for the write guards — the fix makes the awareness guard match the sentence that is already there, so nothing in that file becomes false. (Assumption; listed in `assumptions`.)

## Tests

`tests/server/typing-presence.test.ts`, beside the existing note case:

1. **The discriminator, in two halves.**
   - **Predicate:** seed a record stored as `{ type: "flag" }` and assert `sanitizeAnnotationIdForPresence` returns `undefined`. `seedAnnotation`'s parameter is typed `Annotation["type"]`, which cannot express `flag`; widen it to `Annotation["type"] | "flag"` and cast at the `map.set` (the same shape `adr027-note-write-guards.test.ts` uses for its `flag` seeds). Red against `origin/master`, green after — it is the only thing that kills the raw read. A test seeded with `type: "note"` does not: the existing note case stays green under the bug.
   - **Relay:** in the same spec, `resetMigrationLog()` in `beforeEach` (exported from `src/server/annotations/migration-log.ts`) and `vi.spyOn(console, "error")`; after the `flag` call, assert the spy saw a line matching `/legacy migration: flag-to-note in .*/` naming `TEST_DOC`. **This half is what makes the fix's shape load-bearing**: it is red for a hardcoded `ann.type === "note" || ann.type === "flag"` (which returns `undefined` and logs nothing) and red for an `onLossy` passed as `() => {}`. Without it the spec is passed by the exact anti-pattern this issue exists to kill.
2. **Positive control, so a guard that refuses everything cannot pass.** The existing `comment` case already covers one; add a `highlight` case asserting the id IS returned. Frame it as **"a non-note type is broadcast"** — its job is to kill an over-narrowing to `type === "comment"`, which the corrected docblock would otherwise invite. It is explicitly **not** a pin that a private highlight *should* be broadcast: a later tightening onto `isClaudeFacing` is expected to change this row, and the comment in the test must say so.
3. **Wiring, not just the predicate.** Drive `withTypingPresence({ tool: "tandem_annotationReply", documentId: TEST_DOC, annotationId: sanitizeAnnotationIdForPresence(...) })` over the `flag` record and assert the marker has no `annotationId` while `tool` is still set — i.e. the indicator degrades to the generic one rather than vanishing. Kills a "fix" that drops the whole presence write.
   **Take the reading INSIDE the handler closure.** `withTypingPresence`'s `finally` calls `clearPresenceOn` and `withWorking(prev, null)`, so a `readWorking(doc)` taken after the await is `null` for every implementation, correct or buggy, and both halves of the assertion pass vacuously. Mirror the existing "broadcasts annotationId for non-note annotations" case (`tests/server/typing-presence.test.ts:95-113`): capture `observed = readWorking(doc)` into a `let` inside the handler, then re-assert the declared type at the `expect` (TS narrows the `let` to `never`; that neighbouring spec documents why the re-assert is sound). The `tool`-is-still-set half is what makes it non-vacuous.

Run: `npx vitest run tests/server/typing-presence.test.ts tests/server/adr027-note-write-guards.test.ts`.

## Done when

The `flag` predicate spec and its relay assertion are red on `origin/master` and green on the branch; the wiring spec reads inside the handler and holds; the non-note positive control holds; `npm run typecheck` + the two suites green.

*Not a gate, verified by reading the diff:* the docblock no longer lists `flag`, says the check runs on the sanitized value, and carries the note-half-only clause. No test pins docblock prose and none is added for it — `tests/docs/` pins the loopback and config-writer claims, not this one.

## Not in scope

The client-side raw-type reads in `src/client/panels/annotation-actions.ts` and `annotation-card-helpers.ts` (#1678, closed). `presence-expiry.ts`'s write-back — it re-writes the already-sanitized id held in `active`, so it inherits the fix. Any change to what MCP tools may read from awareness. **Widening the guard from the note half to `isClaudeFacing`** — the `{comment, private}` and user-highlight ids are still echoed here, same client-only exposure, bounded in `## Problem` above.

## Review corrections (round 1)

**Adopted**

- **BLOCKING — the only discriminator is passed by a hardcoded `|| ann.type === "flag"`, and the `onLossy` requirement is asserted by nothing.** Confirmed: `relaySanitizationEvent` → `logLegacyMigration` (`src/server/annotations/migration-log.ts:44-53`) emits `console.error("[ANNOTATION-STORE] legacy migration: flag-to-note in <docHash>")`, and `resetMigrationLog` (`:63`) is exported for exactly this. Test 1 now has a relay half: `resetMigrationLog()` + a `console.error` spy asserting the `flag-to-note` line. That is the row that pins sanitize-then-gate rather than a second hardcoded literal.
- **Test 3 is vacuous if `readWorking` is called after `withTypingPresence` resolves** (raised twice). Confirmed: the `finally` calls `clearPresenceOn` and strips `working`, so `readWorking(doc)?.annotationId` is `undefined` under any implementation. Test 3 now requires the capture-inside-the-handler shape and cites the existing spec at `typing-presence.test.ts:95-113`, including the TS `never`-narrowing re-assert.
- **The fix stops at the note half; `{comment, private}` and user highlights are still broadcast, and the prescribed docblock ("safe: `comment`, `highlight`") would assert as ADR-027 something false for the other four write families since #1803.** Adopted as the *narrow fix, stated*: `## Problem` gains a bound paragraph, `## Fix` requires the docblock to carry the note-half-only clause with its rationale (the id originates from the caller; `lifecycle.reply` refuses both classes anyway), and `## Not in scope` names the widening. Verified `isPrivateForClaude` at `src/server/annotations/lifecycle.ts:272` and `isClaudeFacing` at `src/server/annotations/projection.ts:293`.
- **"Audited, no second instance" is true only for RAW-TYPE reads**, and test 2 pinned the private-highlight case as required behaviour. The audit heading is now scoped to the class, and test 2 is reframed as "a non-note type is broadcast" with an in-test comment saying a later `isClaudeFacing` tightening is expected to change it.
- **Two Done-when items are checked by no test and no lint.** The docblock line is moved out of the gate list and labelled verified-by-diff; the `docs/security.md` assumption stays in `## Fix` where it is already flagged as an assumption.

**Not adopted**

- *Nothing was refused.* The one item with two competing remedies — mirror `isPrivateForClaude` here versus state the narrowing — took the reviewer's own option (b), because option (a) changes the guard's shape on a path whose single caller already refuses both widened classes, which is scope this group does not carry.

*File set unchanged:* `src/server/mcp/typing-presence.ts` + `tests/server/typing-presence.test.ts`.
