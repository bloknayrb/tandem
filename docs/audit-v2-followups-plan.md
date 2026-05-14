# PR #621 Review Follow-Ups — Plan

Source: 6-reviewer + Codex review of PR #621 (audit v2). This plan covers every Important and Suggestion finding. Group by intended PR boundary so each lands as a coherent, individually-revertable change.

---

## PR-F1 — Regression test for PR-A1 split-transaction fix

**Source:** pr-test-analyzer (Important #1). The CRDT reviewer's manual catch (8d9c0ce) has no test; flipping the relocation transact back to `FILE_SYNC_ORIGIN` would silently regress.

**Change:** Add `tests/server/reload-from-disk-persistence.test.ts`. Two test cases in one file:

### Test A — End-to-end durable-sync persistence
1. Create a doc with one annotation whose `textSnapshot` will move on disk reload.
2. Attach `wireAnnotationStore` **before** calling `reloadFromDisk` (the watcher path calls `attachObservers` at the end of reload; the sync observer must be attached up-front so the relocation write fires through it).
3. Capture writes via a spy on the sync function itself, NOT by reading the serialized file (`wireAnnotationStore` may debounce serialization — asserting on file contents is racy; asserting on the observer callback is deterministic).
4. Rewrite the file on disk so the snapshot text moves to a new offset.
5. `await reloadFromDisk(id, filePath, format)`.
6. Assert: the spy captured a write whose annotation entry has the relocated `range` + `relRange` (NOT the original offsets).
7. Verify the relocated range round-trips through `validateRange()` cleanly (locks in Critical Rule #4 for the relocation path).

Why this catches the regression: durable-sync skips `FILE_SYNC_ORIGIN`. If the relocation transact were `FILE_SYNC_ORIGIN`, the spy would not fire for the relocation write.

**Note for implementer:** confirm `wireAnnotationStore` is not torn down/reattached by `attachObservers` (file-opener.ts:888) — if it is, the spy reference goes stale mid-test and assertions silently miss. Read `src/server/annotations/sync.ts` lifecycle once before implementing.

### Test B — `afterTransaction` spy on origin sequence
Cheaper companion guarding the transaction *structure* (different failure mode from Test A):
- Spy on `doc.on("afterTransaction", ...)`.
- Invoke `reloadFromDisk(...)` on a doc with at least one annotation that requires relocation.
- Assert the captured transaction sequence is **exactly** `[FILE_SYNC_ORIGIN, MCP_ORIGIN]`.
- Assert the second (`MCP_ORIGIN`) transaction's `changed` set **includes the `Y_MAP_ANNOTATIONS` instance** (ref-equality on `doc.getMap(Y_MAP_ANNOTATIONS)`, per `feedback_yjs_txn_changed_ref_equality`). A naive sequence check would pass even if the relocation transact ran but did no annotation work — this guards against that silent regression too.

**Optional refactor consideration (skip unless implementing F1 reveals it's needed):** annotation reviewer suggested extracting the relocation block into a `relocateStaleAnnotations(doc, refreshed, map)` helper so it can be unit-tested without file I/O. Defer this to a future polish PR — the spy assertions in Test B give us 80% of that value without the refactor.

**Files:** `tests/server/reload-from-disk-persistence.test.ts` (new). No production change.

---

## PR-F2 — Regression test for `tandem_resolveAnnotation` NOT_FOUND code

**Source:** pr-test-analyzer (Suggestion). Plan-reviewer correction: there is no separate `tandem_acceptAnnotation` / `tandem_dismissAnnotation` — both flow through `tandem_resolveAnnotation` with `action: "accept" | "dismiss"` (single handler in `src/server/mcp/annotations.ts`). PR-A3 changed this handler's missing-annotation error code; no test asserts the new code.

**Change:** Add a `code === "NOT_FOUND"` assertion to the existing `tandem_resolveAnnotation` test (or create one under `tests/server/`). Cover **both** branches against the same handler:
- `action: "accept"` with a non-existent annotation id → `code === "NOT_FOUND"`.
- `action: "dismiss"` with a non-existent annotation id → `code === "NOT_FOUND"`.

Pattern matches the existing `tests/server/remove-annotation.test.ts:59` assertion.

**Files:** existing resolve-annotation test file under `tests/server/`. No production change.

---

## PR-F3 — Export the tutorial predicate; replace mirrored test logic

**Source:** svelte-migration + pr-test-analyzer (Suggestion). `tests/client/use-tutorial.test.ts` inlines `(a) => a.author === "user" && !a.id.startsWith(TUTORIAL_ANNOTATION_PREFIX)` instead of importing it. A revert of the production predicate would not fail the test.

**Change:**
1. In `src/client/hooks/useTutorial.svelte.ts`, extract the inline predicate at line 89 into a module-level exported function. Name it for what it actually means (the semantic is "non-tutorial user-authored," not generic "user-authored"):
   ```ts
   /**
    * True iff the annotation is authored by the user AND is not a tutorial seed.
    * Load-bearing: used by the step-1 advance effect — a tutorial-seeded annotation
    * must NOT trip this predicate even though tutorial notes have author="user"
    * to satisfy ADR-027. See `TUTORIAL_ANNOTATION_PREFIX` for the marker convention.
    */
   export function isNonTutorialUserAnnotation(a: Annotation): boolean {
     return a.author === "user" && !a.id.startsWith(TUTORIAL_ANNOTATION_PREFIX);
   }
   ```
   Replace the inline `some(...)` call with `annotations.some(isNonTutorialUserAnnotation)`.
2. In `tests/client/use-tutorial.test.ts`, delete the local re-implementation and import `isNonTutorialUserAnnotation`. Keep existing test cases.
3. Add one new test case: a tutorial-prefixed annotation later mutated (e.g., `status: "accepted"`) — predicate still returns `false`. Locks in the current "edits don't promote it to user-authored" behavior.

**Reactivity note (verified by svelte-migration reviewer):** extracting the predicate to a module-level pure function does not change `$effect` dependency tracking — the effect still calls `getAnnotations()` itself, and the predicate only reads plain object fields. `useTutorial.svelte.ts` has no top-level runes, so the test file can import the predicate without a Svelte runtime.

**Files:** `src/client/hooks/useTutorial.svelte.ts`, `tests/client/use-tutorial.test.ts`.

---

## PR-F4 — Audit script hardening

**Source:** Codex (Suggestion ×2), security (Suggestion). Two scripts have known false-negatives.

### F4a — `scripts/audit-origins.ts` identifier pass-through
Current behavior: any `Identifier` second arg that isn't `MCP_ORIGIN`/`FILE_SYNC_ORIGIN` is silently treated as tagged ("pass-through helper" assumption). This is intentional per the comment, but it hides bugs where a helper forwards `undefined` or a wrongly-named variable.

**Change:** Tighten the pass-through path. Only treat an Identifier as "pass-through tagged" if the enclosing function's parameter list has a parameter that:
- is **named** `origin` or `transactionOrigin`, AND/OR
- has a **type-node text** matching `"TransactionOrigin"` or the origin union literal `'"mcp" | "file-sync"'`.

For any other Identifier, emit a `pass-through (verify): <name>` finding so a human triages. Keep `process.exit(0)` — warn-only.

**Implementation note — syntactic only, no TypeChecker needed:** the existing script uses `createSourceFile(..., setParentNodes=true)` which gives `.parent` walks. Use `ts.findAncestor` for `FunctionDeclaration | MethodDeclaration | FunctionExpression | ArrowFunction`, then scan its `.parameters` for name + `param.type?.getText()`. This is purely syntactic and in-file — do NOT pull in `createProgram` / a TypeChecker; that's a major dependency jump for marginal gain. Document the residual gap in the script header: "Identifier bindings across modules / through aliases are not resolved — this is a known false-negative class."

### F4b — `scripts/audit-ymap-keys.ts` coverage + regex escape
Current behavior: line-by-line regex scan for `.set("VAL"` / `.get("VAL"`. Misses (a) multiline `.set(\n  "VAL"`, (b) `.has("VAL")` / `.delete("VAL")`, (c) **the `getMap`/`getArray`/`getText`/`getXmlFragment` constructor sites — which are where raw keys originate**, (d) unescaped Y_MAP value if it contains regex metacharacters.

**Change:** Rewrite as a TypeScript AST walk like `audit-origins.ts`:
- Find `CallExpression` whose expression is a `PropertyAccessExpression` with `name.text ∈ { set, get, has, delete, getMap, getArray, getText, getXmlFragment }`.
- Check first arg is a `StringLiteral` whose text is in the known-keys set.
- Report `file:line: raw "<value>" — use <Y_MAP_*>`.

The `getMap`-family additions are the highest-value coverage — they're where the raw key is constructed in the first place, before `.set/.get` is even called.

**Drop the bracket-access (`ElementAccessExpression`) branch from the original plan.** CRDT reviewer confirmed: `Y.Map`'s real API is `.get/.set/.has/.delete` — bracket access on a Y.Map is a TypeScript error, so flagging `map["annotations"]` is dead detection. Before adding it back, grep `src/` for `\[["'][a-z]` style access on a Y.Map; if zero hits today, leave it out.

Drops the regex entirely, so the escape concern is moot.

**Files:** `scripts/audit-origins.ts`, `scripts/audit-ymap-keys.ts`. No production change.

**Verification:** After rewrite, `npm run audit:origins && npm run audit:ymap-keys` must produce zero false-positive *blocking* findings. New `verify` findings on `audit:origins` are acceptable; document each known-good site in `docs/audit-v2.md` under a "Triaged pass-through tags" subsection. For `audit-ymap-keys`, also expect new findings on `getMap` call sites that *correctly* use raw strings inside `constants.ts` itself — exclude that file from the scan (`if (file === CONSTANTS) return [];` is already in the current script — preserve it).

---

## PR-F5 — Tutorial-prefix coupling comment + fullyAnchored consistency

**Source:** annotation-model (Suggestion), crdt (Suggestion).

### F5a — Comments on the load-bearing tutorial-prefix predicate
The string-prefix predicate is defense-in-depth. A future rename of `TUTORIAL_ANNOTATION_PREFIX` — or a future maintainer thinking the prefix check is paranoid — would silently re-introduce the step-1 auto-advance bug.

**Lands after PR-F3** (since F3 extracts the predicate to a named exported function — the comment belongs on that function, not the inline call site).

**Change:**
1. Add a one-line comment at the `TUTORIAL_ANNOTATION_PREFIX` constant declaration:
   ```ts
   // Load-bearing: useTutorial.svelte.ts uses this prefix to exclude tutorial
   // SEEDS from "user-authored annotation" detection. Tutorial NOTES carry
   // author="user" (ADR-027: only the user can author notes), so the prefix
   // is the ONLY thing distinguishing a seed from a real user note. Renaming
   // this constant without updating useTutorial.svelte.ts would silently
   // re-introduce the step-1 auto-advance bug from PR #621 PR-A2b.
   ```
2. Ensure the JSDoc on `isNonTutorialUserAnnotation` (added in PR-F3) makes the ADR-027 / tutorial-notes context explicit. PR-F3 already drafts this; F5a just verifies it survived.

### F5b — Tutorial seeding `relRange` assignment style
`tutorial-annotations.ts` always assigns `relRange: result.relRange` after `anchoredRange()`. Today, `anchoredRange` returns no `relRange` field when `!fullyAnchored`, so `result.relRange` is already `undefined` in that branch — the "gate" is a **no-op behaviorally**. CRDT reviewer confirmed downstream code (`client/positions.ts:309`, `server/positions.ts:301`) handles `!ann.relRange` via lazy-attach fallback. Reframe this from "bug fix" to "style consistency / intent documentation."

**Change:** In `src/server/mcp/tutorial-annotations.ts`, switch from unconditional assignment to **conditional spread**, matching the established style at lines 99-100 (`color` / `suggestedText`):
```ts
...(result.fullyAnchored ? { relRange: result.relRange } : {})
```
This makes the "only attach `relRange` when fully resolved" invariant visible at the assignment site, consistent with `reloadFromDisk` (file-opener.ts:877).

**Files:** `src/shared/constants.ts` (comment), `src/server/mcp/tutorial-annotations.ts` (conditional spread). No `src/client/hooks/useTutorial.svelte.ts` change needed beyond PR-F3's JSDoc.

---

## PR-F6 — Pre-existing two-write crash window (`reloadFromDisk`)

**Source:** Codex (Important #2). On `reloadFromDisk`, `refreshAllRanges()` (`src/server/positions.ts:352`) persists once with `MCP_ORIGIN` (its own internal `ydoc.transact`), then the explicit relocation pass at `src/server/mcp/file-opener.ts:861-884` persists a second time with `MCP_ORIGIN`. Both go through durable-sync. A crash between them leaves annotations durably stored at partially-refreshed ranges.

**Not introduced by this PR.** Pre-existing in master.

**Risk scope:** narrow but real. The two transactions are separated only by synchronous control flow inside `reloadFromDisk` — there is no `await` between them — so the exploit window is roughly "process killed during the relocation loop." The bug class is *durable-state corruption*, which is precisely what durable-annotations exists to prevent.

**Other callers of `refreshAllRanges`:**
- `src/server/mcp/annotations.ts:439` (`tandem_getAnnotations` read path)
- `src/server/mcp/annotations.ts:587` (`tandem_exportAnnotations` read path)
- `src/server/mcp/document.ts:66` (re-export only)

**Neither read-path caller is crash-vulnerable** — they don't follow with a second mutation pass. Only `reloadFromDisk` exhibits the two-write pattern. This scopes the fix correctly: change *how* `reloadFromDisk` invokes `refreshAllRanges`, not the function itself.

**Plan:** Do NOT fix in the follow-up PRs above. Open a GitHub issue with:
- **Title:** `reloadFromDisk persists annotation ranges in two separate transactions — crash window leaves stale state`
- **Body:**
  - Code refs: `src/server/mcp/file-opener.ts:815-885` (two-write pattern), `src/server/positions.ts:352-400` (`refreshAllRanges` internal transact), `src/server/annotations/sync.ts:242` (observer flushes per-transaction).
  - Why pre-existing: audit v2 (PR #621) surfaced this but did not introduce it. Both transactions tagged `MCP_ORIGIN` in master prior to #621.
  - **Suggested fix:** add an opt-in `{ skipTransact?: boolean }` parameter to `refreshAllRanges` (or extract an internal `refreshAllRangesInner` and have `refreshAllRanges` wrap it in its current `MCP_ORIGIN` transact). `reloadFromDisk` calls the no-transact variant inside a single merged `MCP_ORIGIN` transact that also contains the relocation pass. Durable-sync then flushes once. The two read-path callers (`annotations.ts:439`, `:587`) continue to call the standard `refreshAllRanges` and are unaffected.
  - **Do NOT "inline the body" at the reload call site** (an earlier draft of this plan suggested that — it's wrong; it would duplicate code and the other callers still want a self-transacting version).
  - **Test:** the PR-F1 test from this follow-up cycle will need an additional assertion — exactly *one* transaction with `Y_MAP_ANNOTATIONS` writes during `reloadFromDisk`, not two — after the fix.
- **Labels:** `bug`, `crdt`. **Milestone:** `v0.12.0`.

**Also:** add a "Known Issues" entry to `CHANGELOG.md` under the unreleased v0.11.x section noting the crash window and that durable annotations can be inconsistent if the server is killed mid-reload. Users should restart cleanly when possible.

Rationale for deferral: the fix is non-trivial (touches 3 caller sites via the parameter addition, requires a new test asserting single-transaction behavior, and changes `refreshAllRanges`'s public signature). Fixing here would balloon the audit PR's scope and re-trigger the full reviewer cycle. The risk is bounded by the narrow exploit window and the durable-sync recovery path on next clean start.

---

## PR boundary recommendation

Group the follow-ups as follows to keep each PR small and revert-clean:

| PR | Contents | Risk |
|----|----------|------|
| **#622** | F1 + F2 (test-only regression coverage) | Low |
| **#623** | F3 (predicate export + test refactor + new case) | Low |
| **#624** | F4 (audit script AST rewrites) | Low (dev tooling) |
| **#625** | F5 (comments + fullyAnchored gate) | Low |
| (issue) | F6 (pre-existing crash window) | Defer to v0.12.0 |

Ship #622 first — it locks in the headline fix from PR #621 and is the highest-value follow-up. The others can land in any order.

## Additional small follow-ups folded into existing PRs

Surfaced by plan-review pass; too small to warrant separate PRs.

- **Inline comment at `reloadFromDisk` relocation transact** *(annotation reviewer)*: in `src/server/mcp/file-opener.ts` near line 861, add a one-line note that `MCP_ORIGIN` here is deliberate — channel observer skips it, durable-sync persists it. Prevents a future "fix" flipping back to `FILE_SYNC_ORIGIN` to silence a phantom channel echo. **Fold into PR-F5** (touches the same area conceptually).

- **ADR-027 channel filtering audit grep** *(annotation reviewer)*: before closing out the follow-up cycle, grep `src/server/events/` and `src/server/mcp/` for `type !== "note"` and `type === "note"` to confirm note-filtering is consistent in every place. One-line check. **Run as part of PR-F1's PR description checklist** — no separate change unless a gap is found.

## What is explicitly NOT addressed

- **First-transact `forEach(...delete)` awareness clear** (crdt Suggestion #3): Currently safe (Y.Map snapshots iterator). Migrating to `[...keys()].forEach(delete)` would be cosmetic-only churn for no behavior change. Skip.
- **Cross-module identifier resolution in `audit-origins.ts`** (Codex F4a residual gap): would require a full TypeChecker. Accept as a documented limitation; `verify` findings + human triage are the trade-off.
- **`audit-ymap-keys.ts` bracket-access detection**: dropped per CRDT reviewer — bracket access on a Y.Map is a TypeScript error in this codebase. Reconsider only if a real raw-bracket-key site appears.
- **Extracting `relocateStaleAnnotations(doc, refreshed, map)` helper**: discussed in PR-F1 as an option for cheaper unit testing. Deferred — the spy assertions in F1 Test B give us most of that value without the refactor.
- **`docs/audit-v2.md` deferred items list**: F6 is the only deferral that comes out of *this* review pass. Leave existing deferrals as documented.
