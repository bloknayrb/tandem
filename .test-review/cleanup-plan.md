# Test-suite cleanup plan — cleared set, set-level interactions, exclusions

Read-only synthesis. Built from `.test-review/removal-candidates.md` (160 proposed actions) and
five reviews: `removal-review-A.md` (34 `consolidate` rows), `-B.md` (67 `remove test` rows,
BATCH-01..08), `-C.md` (44 distinct proposals, BATCH-09..16, all actions), `-D.md` (33 `remove
assertions` rows), and `removal-review.md` (16-row sample spanning several batches). Row numbers
below are the source line number in `removal-candidates.md` unless noted. "Cleared" = at least one
reviewer marked `AGREE` and no reviewer marked the same proposal `WRONG-DEFECT`, `WRONG-ACTION`,
`WRONG-SURVIVOR`, `NEEDS-EVIDENCE`, or gave a materially different recommended action.

No files were mutated to build this document; no test or source file has been touched.

---

## TASK 1 — Cleared set

### `tests/server/document-service.test.ts`

| Location | Action | Reason | Cleared by |
|---|---|---|---|
| `:155-180` `addDoc/removeDoc/hasDoc/docCount` (4 its) | remove test | Same functions already exercised as fixtures/oracles by `closeDocumentById`'s suite (`:378-529`). | B |
| `:184-197` `getActiveDocId/setActiveDocId` (3 its) | remove test | `getCurrentDoc` (`:209-236`) and `closeDocumentById`'s null-clearing path already exercise the real effect. | B |
| `:240-243`+`:256-264` `requireDocument` (2 its) | remove test | `requireDocument` is a thin wrapper over `getCurrentDoc`, whose own branch tests already cover both cases. | B |
| `:369-374` `getOpenDocs` (1 it) | remove test | The underlying map is exercised via `getOrCreateDocument` elsewhere in the suite (see caveat below — this is the weakest row in this file: B corrected the audit's own citation, which was imprecise). | B |

### `tests/server/session-restore.test.ts`

| Location | Action | Reason | Cleared by |
|---|---|---|---|
| `:138-147` "returns empty array when no sessions exist" | remove test | Own comment admits it only checks `Array.isArray`; `:149-157` is a strictly stronger positive case on the same path. | B |

Note: the sibling row at `:200-221` ("quarantines corrupt JSON files") is **excluded** — see Task 3. Do not remove it alongside the above.

### `tests/server/mcp-tool-integration.test.ts`

| Location | Action | Reason | Cleared by |
|---|---|---|---|
| `:722` "tandem_getAnnotations rejects type: note (ADR-027)" | remove assertions | `isError:true` alone doesn't distinguish ADR-027 rejection from any other error; add the real rejection-code assertion (mirrors `NOT_OWNED` pattern at `:831`/`:850`/`:863`). Strengthening, not a loss. | D |
| `:1321` "tandem_status updates awareness when text param is provided" | remove assertions | Response-echo alone doesn't prove persistence; add a real `Y_MAP_USER_AWARENESS` read after the call. Strengthening. | D |
| `:1490` "withErrorBoundary catches unexpected errors gracefully" | remove test | Duplicate of `:137`'s `NO_DOCUMENT` control; never exercises an actual unexpected-throw path. | B |

### `tests/server/awareness-tools.test.ts`

| Location | Action | Reason | Cleared by |
|---|---|---|---|
| `:895-925` checkInbox chat messages (2 cases) | remove test | Hand-writes `chatMap.forEach` filter inline; no call to the real inbox-surfacing function. | B |
| `:948-966` `tandem_reply` raw Y.Map ops (2 cases) | remove test | Misleading describe name; asserts nothing about the tool it's named after. | B |
| `:988-1053` `tandem_status` raw Y.Map ops (3 cases) | remove test | Same pattern — no handler invoked. | B |
| `:1056-1077` tandemMode via Y.Map (3 cases) | remove test | Reimplements the `?? TANDEM_MODE_DEFAULT` fallback inline; the real schema is exercised by the `/api/mode` endpoint block below. | B |

**Interaction warning — see Task 2:** removing all four of the above, together with `chat.test.ts` and `chat-extended.test.ts` below, retires every mock-based chat/inbox test in the suite. Real protection survives only via `mcp-tool-integration.test.ts`'s `tandem_checkInbox`/`tandem_reply` describe blocks (verified present, untouched, real `client.callTool`).

### `tests/server/file-watcher.test.ts`

| Location | Action | Reason | Cleared by |
|---|---|---|---|
| `:760` "swapHandle stores new handle before closing old: re-entrant defence only" | remove test | Own in-file comment states the scenario is "NOT reachable in production." Real store-before-close order is proven by `:575`'s positive control and `document-write-rearm.test.ts`'s AST-pinned ordering. | B (judgment call) |

### `tests/server/annotation-replies.test.ts`

| Location | Action | Reason | Cleared by |
|---|---|---|---|
| `:283,:310` "deletes orphaned replies…" / "does not delete replies belonging to other annotations" | remove test | Hand-simulates the sweep via `ydoc.transact`; never calls `removeAnnotationRecord`. Real survivor confirmed: `tests/server/remove-annotation.test.ts:76` and `:100`, which call the real function and assert the identical properties. | B, sample (sample supplies the correct survivor citation the batch audit lacked) |

### `tests/server/annotation-tools.test.ts`

| Location | Action | Reason | Cleared by |
|---|---|---|---|
| `:208-213` "returns error for non-existent annotation ID" | remove test | Reads `map.get("fake_id")` directly; never calls `acceptPending`/`dismissPending`. | B |
| `:216` "removes annotation from map" / `:227` "returns false for non-existent annotation" | remove test | `map.delete`/`map.has` called directly; no lifecycle function invoked despite the "tool logic" describe title. | B, sample |
| `:145,154,165,174` filter-by-author/type/status/compound (4 its) | remove test | Calls real `collectAnnotations` (unfiltered) then applies `.filter()` in test code; production filtering logic in `tandem_getAnnotations` is never invoked. | B |

**Zero-protection flag — see Task 2:** annotation filter-by-author/type/status has no real coverage anywhere in the suite, before or after this cleanup. Removing these rows costs nothing (they never protected anything), but the gap stays open and visible.

### `tests/server/annotations.test.ts`

| Location | Action | Reason | Cleared by |
|---|---|---|---|
| `:109,116,122,130` filter logic (4 its — entire `describe("filter logic")` block) | remove test | Identical `.filter()`-on-test-side anti-pattern, second file. | B |
| `:166,179` "resolve changes status to accepted/dismissed" | remove test | Hand-writes `map.set({...ann, status})`; superseded by the real-function version at `annotation-tools.test.ts:184` (`it.each` over `acceptPending`/`dismissPending`, confirmed present and untouched). | B |
| `:191,201` "remove deletes from map" / "get nonexistent ID returns undefined" (entire `describe("resolve and remove")` block) | remove test | `map.delete`/`map.get` directly; no lifecycle function called. | B |

**Execution note:** removing `:166,179,191,201` empties `describe("resolve and remove", ...)` entirely (verified — these are its only four members). Removing `:109,116,122,130` empties `describe("filter logic", ...)` entirely (verified — also its only four members). Delete both `describe` wrappers, not just their `it`s.

### `tests/server/document-model.test.ts`, `tests/server/docx.test.ts`

| Location | Action | Reason | Cleared by |
|---|---|---|---|
| `document-model.test.ts:235-243` "extractText handles nested lists" | remove test | (See Task 3 — **excluded**, reviewers disagree with this action.) | — |
| `docx.test.ts:485-494` "read-only guard" pattern | remove test | Literal object asserted against itself; no production guard exercised. | B |

### `tests/server/file-opener-edge-cases.test.ts`

| Location | Action | Reason | Cleared by |
|---|---|---|---|
| `:52-76` "rejects .csv/.pdf/.js" (consolidate to `.csv` only) | consolidate | All three hit the identical `SUPPORTED_EXTENSIONS.has()` gate; no distinct branch. | A |

Note: the sibling row `:211-226` ("SUPPORTED_EXTENSIONS contains/does not contain") is **excluded** — keep the "contains" half, since `.htm`/`.docx` presence is otherwise unexercised anywhere in the file.

### `tests/server/info-route.test.ts`

| Location | Action | Reason | Cleared by |
|---|---|---|---|
| `:389-439` "welcomePath field" (3 its) | remove test | `changelogPath`/`welcomePath` are structurally identical branches in `info.ts:104-111`; the `changelogPath` triad (`:332-386`) already proves the shared branch. | B |

### `tests/server/issue-377-position-diagnostics.test.ts`

| Location | Action | Reason | Cleared by |
|---|---|---|---|
| `:93-102` "loads roadmap.md and extracts flat text without throwing" | remove test | The BUG A/B/C tests below use the same real fixture with materially stronger oracles. | B |
| `:247-268` "\n boundary edge cases" (consolidate) | consolidate | Second `it` is byte-identical to `positions.test.ts:508-514`. | A |
| `:356-388` "stale flat offsets from before content replacement point to wrong text" | remove test | Two independent `Y.Doc`s, plain `.slice` comparison; never calls `refreshRange` or any production repair/validation function. | B |

Note: `:306-354` (the `refreshRange` "repaired or degraded" test) is **excluded** — see Task 3. It is the sole test approaching the critical, open #1764 repair-path risk; delete only alongside a real strengthened replacement, not as a bare removal in this pass.

### `tests/server/edit-annotation.test.ts`

| Location | Action | Reason | Cleared by |
|---|---|---|---|
| `:152` "rejects edit on a user note (ADR-027)" | remove assertions | Delete the `toMatch(/note/i)` message check; keep the `INVALID_ARGUMENT` code + unchanged-content assertions, which independently prove the safety property against this fixture. | D |
| `:247` "edits suggestedText on a comment that already has it" | consolidate → `:73` | Strict subset of `:73`'s setup/assertions. | A |

### `tests/server/authorship-tracking.test.ts`

| Location | Action | Reason | Cleared by |
|---|---|---|---|
| `:29,52,69,102,132` — all 5 its in `describe("Authorship tracking — Y.Map overlay")` | remove test | Raw `Y.Map` set/get/round-trip; the real `stampClaudeAuthorshipWholeDoc` function is never called in this block. | B |

**Verified survivor:** `describe("stampClaudeAuthorshipWholeDoc — whole-document authorship (#937)", ...)` at `:179` calls the real function repeatedly and is untouched by any proposal. Whole-file gutting concern resolved — real protection remains.

### `tests/server/document-tools.test.ts`

| Location | Action | Reason | Cleared by |
|---|---|---|---|
| `:127-136` "read-only documents block edits" | remove test | Own comment: verifies the flag is set, not that the guard checks it. | B |
| `:138-151` "rejects from > to" | remove test | Only proves offset monotonicity, never invokes the real guard. | B |
| `:153-161` "from === to is a valid insert point" | remove test | Tautology — two calls to `resolveOffset(5)` compared to each other. | B |
| `:200-215` "detects heading prefix in edit range" | consolidate | Booleans-only oracle; real superset survivor confirmed both at `document-offset.test.ts:133-192` (structural equality, more offsets) and `document-edit.test.ts:193-221` (full `applyEdit`→`validateRange` path, higher layer). Same underlying deletion target cited twice in the source table (lines 23 and 57) — delete once. | A |
| `:217-231` "upload source documents identified for session-only save" | remove test | Only re-asserts values just passed to `addDoc`; no `tandem_save` logic exercised. | B |
| `:284-298` `tandem_switchDocument` (2 cases) | remove assertions | Delete "rejects switching to non-existent document" (only assertion is `hasDoc===false`, unrelated to the tool); keep "switches active document." | D |

### `tests/server/rename-route.test.ts`

| Location | Action | Reason | Cleared by |
|---|---|---|---|
| `:217-228` `errorCodeToHttpStatus` direct table (7 codes) | consolidate | Handler-level `it.each` at `:118-131` covers all 7 codes plus 2 more through the real `handleRename` route. | A |

### `tests/server/docx-footnote-reconstruction.test.ts`, `tests/server/file-watcher-real-fs.test.ts`, `tests/server/platform.test.ts`

| Location | Action | Reason | Cleared by |
|---|---|---|---|
| `docx-footnote-reconstruction.test.ts:264` "does NOT change the pre-existing footnote-ref offset gap" | remove test | Only checks content contains `"[1]"`; no gap comparison performed despite the title. | B |
| `file-watcher-real-fs.test.ts:204` "reports the observed eventType sequence" | remove test | Own comment: "The only assertion is that SOMETHING arrives." | B |
| `platform.test.ts:37-39` "does not throw on an unused port" | remove test | No fault detection. | B |

### `tests/server/license.test.ts`

| Location | Action | Reason | Cleared by |
|---|---|---|---|
| `:167-170` "carries a valid PEM format public key" | consolidate → `:191-200` | The fingerprint test's own comment: "the PEM check passes for ANY well-formed key" — subsumed. | A, sample |

**`:25-113` and `:202-258` are EXCLUDED as a pair — see Task 2.** Do not apply both; see the named interaction below.

### `tests/server/index.startup-ordering.test.ts`

| Location | Action | Reason | Cleared by |
|---|---|---|---|
| `:22-51` "awaits maybeOpenStartupFile before any startHocuspocus invocation" | consolidate | The `main()`-body-scoped test below is a confirmed strict superset that also closes a documented textual-position blind spot. | A |

### `tests/server/annotation-relpos.test.ts`

| Location | Action | Reason | Cleared by |
|---|---|---|---|
| `:105-149` "edge cases: doc start/end/whole-paragraph/zero-width" | remove assertions | Replace the two bare `.not.toBeNull()` checks with exact-value assertions matching the sibling cases' pattern. Pure strengthening. | D |

### `tests/server/authorship-edit-integration.test.ts` (whole file)

| Location | Action | Reason | Cleared by |
|---|---|---|---|
| All 5 cases | remove test | `applyEditWithAuthorship` is a hand-rolled reimplementation of tandem_edit+authorship (own docstring), including a raw `"mcp"` string literal instead of the shared origin constant. | B |

### `tests/server/awareness.test.ts`

| Location | Action | Reason | Cleared by |
|---|---|---|---|
| `:50-123` "tandem_checkInbox logic" (4 cases) | remove test | Own comment: "verify the inbox logic directly since we can't easily call MCP tools"; never calls `processUnsurfacedInboxAnnotations`. | B |

### `tests/server/chat-extended.test.ts` (whole file)

| Location | Action | Reason | Cleared by |
|---|---|---|---|
| All 7 cases (pruning×2, ordering×1, doc-context×2, threading×1, mixed-author×1) | remove test | First test's own comment: "Simulate pruning (same logic as saveCtrlSession)." No Tandem-authored function beyond raw `Y.Map` ops is called anywhere in the file. | B |

**Verified survivor:** `saveCtrlSession` (the real pruning/persistence function) is also exercised by `chat-durable-clear.test.ts`, `session.test.ts`, and `save-ordering-1749-1750.test.ts` — none of which are touched by this cleanup. Real chat-persistence coverage remains, at the session layer rather than a mock layer.

### `tests/server/integration.test.ts` (server), `tests/server/navigation.test.ts`

| Location | Action | Reason | Cleared by |
|---|---|---|---|
| `integration.test.ts:34-76` `applyEdit` helper (3 cases) | remove test | Hand-rolled reimplementation calling only low-level primitives directly, not the real `tandem_edit` handler. | B |
| `navigation.test.ts` `search()` helper + describe (8 cases) | remove test | Real equivalent: `navigation-tools.test.ts`'s `describe("searchText", ...)`. | B |
| `navigation.test.ts` `resolveRange()` helper + describe (5 cases) | remove test | Real equivalent: `navigation-tools.test.ts`'s `findOccurrence` suite. | B |
| `navigation.test.ts` `getContext()` helper + describe (4 cases) | remove test | Real equivalent: `navigation-tools.test.ts`'s `extractContext` suite. | B |
| `navigation.test.ts:164-180` "search on Y.Doc extracted text" (2 cases) | remove test | Duplicated by `navigation-tools.test.ts`'s real `searchText`-on-real-Y.Doc suite. | B |

**Execution note:** this empties `navigation.test.ts` almost entirely (17 of its cases removed across 4 describe blocks). Confirm no residual describe wrapper or shared helper import is left orphaned; if the file becomes fully empty, delete it.

### `tests/server/format-adapter.test.ts`, `tests/server/reload.test.ts`

| Location | Action | Reason | Cleared by |
|---|---|---|---|
| `format-adapter.test.ts:173` (Docx `save`-omitted/`saveBinary`-defined case) | remove assertions (whole `it`) | Byte-for-byte duplicate of `:34-39`'s `getAdapter("docx")` assertions. | D |
| `reload.test.ts:68-108` "textSnapshot-based relocation finds moved text after reload" | remove assertions | Make the `vr.ok`/`RANGE_MOVED` assertion unconditional — verified by hand that the fixture (`"brown"` at offset 10 → offset 2) deterministically moves the text, so the `vr.ok` branch is dead code today. | D |
| `reload.test.ts:181-227` "preserves annotation through markdown reload with heading changes" | remove assertions | Same fix — verified paragraph offset moves deterministically (9 → 13); make the relocation assertion unconditional. | D |

Note: `reload.test.ts:30-66` is **excluded** — see Task 3 (needs `remove test` or a real position-correctness assertion added in the same change, not a bare trim).

### `tests/server/chat.test.ts` (all 4 cases), `tests/server/dirty-state.test.ts` (whole file), `tests/server/issue-377-structure-probe.test.ts` (whole file), `tests/server/license-kv-store.test.ts`, `tests/server/multi-document.test.ts`

| Location | Action | Reason | Cleared by |
|---|---|---|---|
| `chat.test.ts:20,46,66,86` — all 4 its | remove test | Raw `chatMap.set`/`get`; no real handler called for reads, unread-marking, replies, or `replyTo` linking. | B |
| `dirty-state.test.ts` — all 3 cases (whole file) | remove test | No `dirty.ts` function imported or called anywhere in the file. | B |
| `issue-377-structure-probe.test.ts:19,29,46,66` — all 4 its (whole file) | remove test | File's own docstring: "Structure probe... understanding Y.Doc shapes." Oracles are `toBeDefined()`/vacuous-true only. | B |
| `license-kv-store.test.ts:94` "skip path logs" | remove test | `:43`/`:63`/`:81` already establish both halves (unconfigured skip + content-checked logging) this row adds nothing to. | B |
| `multi-document.test.ts:70` "separate annotation maps per doc" | remove test | `:53` (real `populateYDoc`) already falsifies the same fault via real production code. | B |

**Zero-protection flags — see Task 2 for both `chat.test.ts`/`dirty-state.test.ts`/`issue-377-structure-probe.test.ts`.**

### `tests/client/use-tandem-settings-migration.test.ts`

| Location | Action | Reason | Cleared by |
|---|---|---|---|
| `:450,461,472` v1/v2/v3 `showIntegrationWizard` migration (3 its) | consolidate | Chain-integrity value covered by dedicated tests for other fields at the same versions; field-stripping step itself pinned at `:343`/`:355`. | A |
| `:398` "full v2→current migration also strips holdAnnotationsWhileOffline + coerces manual" | consolidate | Same reasoning — coercion pinned at `:371`/`:388`. | A |
| `:431` "full v2→current migration also strips defaultMode" | consolidate | Same reasoning — pinned at `:423`. | A |

### `tests/client/cowork-settings.test.ts`, `tests/client/cowork-settings-mounted.test.ts`

| Location | Action | Reason | Cleared by |
|---|---|---|---|
| `cowork-settings.test.ts:888-894` reachability-copy loop | remove assertions | Delete the two generic `.length > 0` checks; keep `:881`'s family-token assertion and `:894`'s real `title===""` branch check. | D |
| `cowork-settings.test.ts:997-1009` "returns a rejecting stub when import fails" | remove test | The mounted suite's real mock already fully replaces this function. | B |

Note: `cowork-settings-mounted.test.ts`'s "surfaces a re-read failure" row is **excluded** — see Task 3 (keep `toContain("refresh")`, it's the only thing distinguishing two real ternary branches).

### `tests/client/document-workspace.svelte.test.ts`

| Location | Action | Reason | Cleared by |
|---|---|---|---|
| `:905` "saves a plain file tab in place" | remove test | Byte-identical body to `:987`. | B |

### `tests/client/coordinate-conversion.test.ts`, `tests/client/authorship-block-structure.test.ts`, `tests/client/markdown-paste.test.ts`, `tests/client/slash-command.test.ts`

| Location | Action | Reason | Cleared by |
|---|---|---|---|
| `coordinate-conversion.test.ts:240-256` "pmNodeFlatTextLength… for list" | remove test | Survivor `:258-275` asserts exact round-trip equality at 10 offsets including 9. | B |
| `authorship-block-structure.test.ts:406-439` "reuses endpoint instead of re-minting" | remove assertions | Delete only the `fromRel` equality check (test's own comment: this half is "a GUARD, not evidence," confirmed mutation-tested). | D |
| `markdown-paste.test.ts:459-469` `createMarkdownParser` binds to schema | consolidate | Fold the `parser.schema===schema` identity assertion into the `markdownToSlice` bold-conversion test as an added line — **verify the assertion is actually landed there, not silently dropped.** | A |
| `slash-command.test.ts:86-101` table command via mocked chain | remove test | Survivor `:103-120` uses the real editor and asserts the actual resulting table node. | B |

### `tests/client/app-action-mount-contract.test.ts`, `tests/client/FileOpenDialog.test.ts`

Both consolidate rows in this file group (`:260`, `:291`) are **excluded** — see Task 3.

### `tests/client/editor-stage.test.ts`

| Location | Action | Reason | Cleared by |
|---|---|---|---|
| `:252-263` "non-docx full mode: four presence combos" | remove test | The `it.each` table's first two rows already cover the same two effective cases (the function is per-side, so left-only/right-only repeat the same two calls). | B |

Note: `:433` (`narrowThresholdPx` rails=0) is **excluded** — the named survivor file (`marginModeThresholds.test.ts`) does not exist in the repository.

### `tests/client/push-support.test.ts` (integration-wizard)

| Location | Action | Reason | Cleared by |
|---|---|---|---|
| `:471` (`.toBe("Copied")` in "copies both commands") | remove assertions | `clickCopy()`'s own `waitFor(/Copied/)` already establishes the content before this line runs; redundant. | D |

Note: `:492`'s `.toBe("Copied")` in "empties the status between copies" is **excluded** — it is the central oracle for that test's stated purpose (a repeat click that clears-but-never-refills the status would pass without it). Delete `:471` only.

### `tests/client/scratchpad-persistence.test.ts`, `tests/client/settings-push-routes.test.ts`, `tests/client/use-annotation-review.test.ts`

| Location | Action | Reason | Cleared by |
|---|---|---|---|
| `scratchpad-persistence.test.ts:132` "keeps extractFragmentText as plain-text view" | remove test | No distinct fault detection beyond `:56`'s survivor. | C |
| `settings-push-routes.test.ts:276,280,286` reduced-motion transition group (3 its) | remove test | Pure source-regex match with no runtime signal. **This leaves reduced-motion transition-suppression with no coverage — real, uncompensated gap, stated by the audit.** | C |
| `use-annotation-review.test.ts:25-35` `isReviewTarget` 3 named its | remove test | The `it.each` at `:38-44` is already exhaustive over `Annotation["author"]`. | C |

### `tests/client/context-menu-policy.test.ts`, `tests/client/link-paste.test.ts`, `tests/client/network-settings-autostart.test.ts`, `tests/client/store-readonly-banner.test.ts`

| Location | Action | Reason | Cleared by |
|---|---|---|---|
| `context-menu-policy.test.ts:87` "CONTEXT_MENU_ALLOW_SELECTOR is a single string" | remove test | Subsumed by the functional `isContextMenuAllowed` case. | C |
| `link-paste.test.ts:82-99` "records whether… links a URL" probe | remove test | Final assertion is `typeof===boolean`, tautologically true. | C |
| `network-settings-autostart.test.ts:205-211` restart-button label | remove test | No accessibility name/parsed value/doc-consistency test backs the string. | C |
| `store-readonly-banner.test.ts:183` Y.Map propagation | remove test | Observes its own inline `meta.observe()`; never drives the real `yjsSync.svelte.ts` observer. | C |

### `tests/client/useAppInfo.test.ts`, `tests/client/useFirstRunNeeded.test.ts`

| Location | Action | Reason | Cleared by |
|---|---|---|---|
| `:70` "throws when abort signal already aborted" | consolidate → `:63` | `fetchAppInfo` has zero special-case handling for `AbortError`; identical propagation path. | A, C |
| `:81` "includes optional loopback fields" | consolidate → `:50` | `fetchAppInfo` is a blind JSON passthrough with no field-specific logic. | A, C |
| `:104,109` "callable/idempotent without throwing" (2 its) | remove test | Both `not.toThrow()` only; survivor `:133` is the real behavioral test. | C |
| `useFirstRunNeeded.test.ts:181` "refetch() updates values" | consolidate → `:202` | The out-of-order (gen-counter) case is a strict superset of the sequential case. | A, C |

Note: `use-models-no-key-leak.test.ts:124` is **excluded** — keep both, genuinely distinct code paths (client-side validation vs. real 503 network failure).

### `tests/client/accent-contrast-sweep.test.ts`, `tests/client/cowork-admin-declined-modal.test.ts`, `tests/client/editor-smart-typography.test.ts`

| Location | Action | Reason | Cleared by |
|---|---|---|---|
| `accent-contrast-sweep.test.ts:47,53` light/dark WCAG sweep | remove test | Hand-approximated sRGB literals; never reads `index.html`'s real oklch token chain. | C |
| `cowork-admin-declined-modal.test.ts:41,45,49,53` "Modal visibility condition" (4 its) | remove test | Local `shouldShowModal` reimplementation; never imports the component. | C |
| `editor-smart-typography.test.ts:48-58` Typography-registered pair | remove test | Constructs its own local ternary and mounts a hand-built editor; never touches `Editor.svelte`'s real `$effect`. **No cheap alternative currently covers the real reactive gate — stated gap.** | C |

### `tests/client/license-rebuild.test.ts`, `tests/client/model-first-run.test.ts`, `tests/client/OutlinePanel.svelte.test.ts` (excluded, see Task 3), `tests/client/PeekStrip.svelte.test.ts`

| Location | Action | Reason | Cleared by |
|---|---|---|---|
| `license-rebuild.test.ts:25-33` "the method exists" | remove assertions | The mechanism test below fails informatively if the method disappears. | C, D |
| `model-first-run.test.ts:27-29` "edge(a) shows with no tutorial input" | consolidate → `:19-21` | Byte-identical input and assertion. | A, C |
| `PeekStrip.svelte.test.ts:65-71`/`:73-77` zero-ticks pair | consolidate → `:73-77` | `headingLevels=[]` default and an omitted prop resolve identically at the Svelte level. | A, C |

### `tests/client/review-target-integration.test.ts`, `tests/client/toolbar-button-title.test.ts`, `tests/client/use-review-completion.test.ts` (whole file), `tests/client/useEditorFont.test.ts`

| Location | Action | Reason | Cleared by |
|---|---|---|---|
| `review-target-integration.test.ts:70-72` badge test | remove assertions | Mathematically identical to the SidePanel `reviewAllPendingCount` test above it; proposal honestly flags it does not cover the active-tab-suppression branch. | C, D |
| `toolbar-button-title.test.ts:8-69` `computeTitle` (5 its) | remove test | Hand-copies the ternary from `ToolbarButton.svelte`; never imports the component. | C |
| `use-review-completion.test.ts` — all 8 cases (whole file) | remove test | Hand-written local mirrors of the real hook; the real hook is never imported. | C |
| `useEditorFont.test.ts` — 4 fallback-font `.toContain` checks | remove assertions | The token-prefix regex checks are per-variant literal and already fully discriminate; fallback font *names* are free-editable once that's true. | C, D |

### `tests/channel/reply-abort.test.ts` (whole file), `tests/cli/rotate-token.test.ts`

| Location | Action | Reason | Cleared by |
|---|---|---|---|
| `reply-abort.test.ts` — all 3 cases (whole file) | consolidate | Own header comment: "reproduces the run.ts handler logic in isolation." `run-timeouts.test.ts:58-63` (regex-pins real source) + `fetch-with-timeout.test.ts` (real primitives) survive. **Caveat: neither survivor pins the outer catch's `isError`/message construction against real `run.ts` source — a pre-existing gap this deletion does not create.** | A, C |
| `rotate-token.test.ts:462-471` "fingerprint produces 8-char lowercase hex" | remove test | `fingerprint()` is unexported; the real fingerprint strings are already exercised by the rollback/403-message rows above via real stdout. | C |

### `tests/server/integrations/backup.test.ts`, `tests/scripts/coverage-gate-wiring.test.ts`, `tests/crdt/authorship-marks-size.test.ts` (whole file), `tests/server/file-io/roundtrip-repo-metric.test.ts`

| Location | Action | Reason | Cleared by |
|---|---|---|---|
| `backup.test.ts:191-207` symlink-exclusion | remove test | Calls `fs.promises.open` directly against a planted symlink; never calls the real `writeBackup`. Hard Gate-3 failure. Recommended replacement: injectable/mockable predicted filename so the real function is driven at a known path, or spy on the real `fs.open` call site. | C, sample |
| `coverage-gate-wiring.test.ts:80` "names no module twice" | remove test | `:76`'s ordered array-equality already fails on any duplicate. | C, sample |
| `authorship-marks-size.test.ts` — 4 grouped its (whole file) | remove test | Own docstring: "RESULT: RED... Decision: use Y.Map overlay strategy" — measures byte overhead for a REJECTED design; imports no `src/` production module. | C |
| `roundtrip-repo-metric.test.ts:248` "reports the current state" | remove assertions | `byteDifferent.length<=scanned` is structurally tautological (subset by construction); keep the `console.log` reporting body. | C, D |

Note: `tests/server/integrations/storage.test.ts` TOCTOU regex row is **excluded** on a technicality — see Task 3 (C independently verified it as a real Gate-3 failure, but the sample review's `NEEDS-EVIDENCE` on the row-numbering blocks automatic clearance).

### `tests/server/launcher/api-routes.test.ts`

| Location | Action | Reason | Cleared by |
|---|---|---|---|
| `L879-928` "429s while a relaunch is in flight" | remove test, or rewrite the fixture to start from a null supervisor | The idempotent-supervisor-exists branch (`api-routes.ts:531-536`) wins before `spawnOpInFlight()` is ever reached — confirmed against source, and the test's own comment admits it. | C |

Note: `L852-862` ("rejects a replayed nonce with 403") is **excluded** — see Task 3, disagreement on remedy shape.

### `tests/monitor/mode-cache.test.ts`, `tests/monitor/index.test.ts`, `tests/monitor/sse-parsing.test.ts`, `tests/monitor/solo-filter.test.ts`, `tests/monitor/retry.test.ts`

| Location | Action | Reason | Cleared by |
|---|---|---|---|
| `mode-cache.test.ts:167` "main() calls /api/mode once before SSE" | remove assertions | Replace `toBeGreaterThanOrEqual(1)` with exact `toBe(1)` or explicit ordering — the title claims both exactness and ordering, current assertion checks neither. | C, D |
| `index.test.ts:206` "eventId advances ONLY after stdout.write completes" | consolidate → `sse-parsing.test.ts:203` | Identical EPIPE-on-stdout-write setup and assertion; survivor carries the #288 citation. | A, C |
| `index.test.ts:254` "suppresses non-chat events when mode is solo" | consolidate → `solo-filter.test.ts:33` | Drop the duplicate suppression check; fold the `onEventId`-advances assertion into the survivor. **Execution caveat, load-bearing:** A found the deleted test's own vehicle (`document:opened`) is not wake-worthy, so it was already passing for a reason unrelated to solo suppression — when folding the `onEventId` assertion in, it MUST use `solo-filter.test.ts`'s existing `annotation:created` (wake-worthy) vehicle, or the folded assertion is hollow too. | A (reasoning), C (action) |
| `index.test.ts:488` "reports MONITOR_CONNECT_FAILED but stays SILENT" | consolidate → `retry.test.ts:48`/`:106` | Identical scenario and assertions; carry the #1354 rationale comment onto the survivor. | A, C |

Note: `integration.test.ts:46` and `:52` (the mode-default drift-detection pair) are **excluded** — see Task 3 and Task 2. Do not remove either.

### `tests/shared/offsets.test.ts`

| Location | Action | Reason | Cleared by |
|---|---|---|---|
| `:47-51` `FLAT_SEPARATOR` is `"\n"` | remove test | No consumer/loader/precedence exercised anywhere in the file. (Table lines 166 and 167 are the same `it` block, extracted twice — one action.) | C |

---

## TASK 2 — Set-level interactions

### 2.1 `license.test.ts:25-113` + `:202-258` — the seeded example (confirmed, restated for completeness)

Both rows individually pass per-proposal review (row `:25-113` reimplements the algorithm under a
different name — B/sample AGREE removal; row `:202-258` is CI-invisible today because it silently
`return`s before any assertion when the gitignored private key is absent — sample AGREE removal
with a rewrite caveat, B WRONG-ACTION "should be rewritten, not deleted"). Applying both leaves
**zero** CI coverage of `verifyLicense`'s real successful-verification path — SRVAPI-45, a
critical-impact security function. **Both rows are EXCLUDED from the cleared set.** Neither ships
without a same-change replacement: a locally-generated (non-production) keypair that calls the
real `verifyLicense`, unconditionally runnable in CI — the pattern `license-state.test.ts` already
uses, and the pattern `:25-113`'s own removal reason implicitly endorses (call the real function
instead of reimplementing it).

### 2.2 Chat / inbox surfacing — `chat.test.ts` + `chat-extended.test.ts` + half of `awareness-tools.test.ts`

The cleared set removes: `chat.test.ts` (4/4 its), `chat-extended.test.ts` (7/7 its, whole file),
and `awareness-tools.test.ts:895-1077` (12 its across 4 describe blocks — checkInbox chat reads,
`tandem_reply`, `tandem_status`, tandemMode). All of these share one production behavior: chat
message read/write/pruning/ordering and inbox surfacing.

**Checked what remains:** `tests/server/mcp-tool-integration.test.ts` has real, untouched,
`client.callTool`-driven tests for `tandem_checkInbox` (`:185,1335,1405,1457`) and `tandem_reply`
(`:1475`) — confirmed by direct grep, not inferred. Chat pruning/persistence at the session layer
(`saveCtrlSession`) is independently exercised by `chat-durable-clear.test.ts`, `session.test.ts`,
and `save-ordering-1749-1750.test.ts`, none of which this cleanup touches. **Protection remains —
real, at the MCP-tool and session layers rather than the removed mock layer.** No rescue needed,
but flag for the executor: this consolidates ALL chat/inbox protection onto those three files: if
a future PR touches any of them, chat/inbox behavior now has a single point of failure where it
previously had (fake) redundancy.

### 2.3 Annotation filter-by-author/type/status — pre-existing zero protection, not created by this cleanup

`annotation-tools.test.ts:145,154,165,174` and `annotations.test.ts:109,116,122,130` (both cleared
for removal) are the *only* tests anywhere in the suite whose titles mention author/type/status
filtering. Both were independently verified (source read, not audit-text) to call
`collectAnnotations` unfiltered and then `.filter()` **in test code** — neither ever exercised the
real `tandem_getAnnotations` MCP handler's filtering logic. Removing them does not destroy existing
protection (gate 3 — "would detect a plausible relevant fault" — already failed for both). **This
is a pre-existing, real, and currently uncompensated gap, not a set-interaction created by this
plan.** Recorded here per Task 2's instruction to note it, not moved to Task 3, since there is no
cleared-set combination whose removal is what causes it — leaving them in would not fix it either.

### 2.4 `annotations.test.ts` — two describe blocks emptied

Removing `:109,116,122,130` empties `describe("filter logic", ...)`. Removing `:166,179,191,201`
empties `describe("resolve and remove", ...)`. Both were verified directly: each block's `it`s are
*exactly* the cleared rows, no others. This is an execution-mechanics finding (Task 4), not a
protection-loss finding — the "resolve"/"remove" real behavior survives via
`annotation-tools.test.ts:184`'s `it.each` (real `acceptPending`/`dismissPending`) and
`remove-annotation.test.ts`'s real `removeAnnotationRecord` suite, both confirmed present and
untouched.

### 2.5 `dirty-state.test.ts` (whole file) — `dirty.ts` (SRVDOC-26) has no real test anywhere in the reviewed batches

B confirms no function from `dirty.ts` is imported or called in the file being removed. The
candidate table's own reason text states this plainly. Since the removed test never protected
`dirty.ts` (gate 3 fails on inspection), this is not new loss from combining cleared rows — but
unlike 2.3, no other reviewed batch names an alternative real test for `dirty.ts` either. **Flagged
as an open, uncompensated gap for a real production module; not moved to excluded, since nothing in
the cleared set is what removes protection that existed.**

### 2.6 `issue-377-structure-probe.test.ts` (whole file, 4 cases)

All four cases were purpose-built exploratory probes (own docstring: "understanding Y.Doc
shapes"), with vacuous or `toBeDefined()`-only oracles — none protected real behavior before
removal (B independently verified each). Whole-file removal here is a no-op on real protection, not
an interaction to worry about.

### 2.7 `use-tandem-settings-migration.test.ts` — three consolidate rows on the same module

`:450/461/472`, `:398`, `:431` are three separate consolidate proposals against the same migration
module. Each was checked individually against its own direct-step survivor (`:343`/`:355`,
`:371`/`:388`, `:423`) — A confirmed each field's direct-step behavior is pinned once, and each
field's chain-integrity is covered by *other* fields' tests at the same source version. Applying
all three together does not create a combined gap: no single version-transition step loses its
last remaining test, because each consolidation targets a different field. Verified field-by-field,
not just batch-approved.

### 2.8 `navigation.test.ts` — near-total file emptying

Four of five describe blocks are cleared for removal (17 of the file's cases). The fifth (any
residual, if present) and all real coverage now live entirely in `navigation-tools.test.ts`
(`searchText`, `findOccurrence`, `extractContext` — all confirmed real-function suites, all
untouched). No protection loss — this file was a mirror-of-the-mirror throughout — but note for
Task 4: if nothing survives in `navigation.test.ts` after the four removals, delete the file
outright rather than leaving an empty shell.

### 2.9 `authorship-tracking.test.ts` — half the file removed

Five of the file's cases (the entire first describe block) are cleared. Verified the second
describe block (`stampClaudeAuthorshipWholeDoc — whole-document authorship (#937)`, `:179+`, 7+
cases against the real function) is untouched and not proposed for any action. No protection loss.

---

## TASK 3 — Excluded set

### Excluded by direct per-proposal reviewer refusal (WRONG-*/NEEDS-EVIDENCE, single reviewer)

| Location | Proposed action | Reviewer | Reason to keep / alternative |
|---|---|---|---|
| `session-restore.test.ts:200-221` "quarantines corrupt JSON files" | remove test | B (WRONG-SURVIVOR) | Named survivor (`#1800` `it.each`) exercises a different function against valid JSON with a corrupt payload — not the same malformed-JSON-syntax path. **Genuinely bad citation, real test — keep as-is.** |
| `plaintext-flatten.test.ts:524-590` "documented limitation" | remove test | B (WRONG-DEFECT) | Expected offsets are independently derived from an in-comment first-principles explanation, not a re-assertion of current output. **Genuinely good test — proposal was simply wrong.** |
| `document-model.test.ts:235-243` "extractText handles nested lists" | remove test | B (WRONG-ACTION) | Sole coverage of nested-list traversal in this batch. **Genuinely bad oracle (order/nesting blind), real behavior worth protecting — different remedy: strengthen to assert relative order (e.g. regex on expected line sequence), don't delete.** |
| `issue-377-position-diagnostics.test.ts:306-354` refreshRange "repaired or degraded" | remove test | B, sample (both WRONG-ACTION) | Sole test approaching the critical, open #1764 repair-path risk. **Bad oracle (accepts either outcome), real invariant — different remedy: assert the specific expected `kind` and where the repair resolves, in the same change, before any deletion.** |
| `search-worker.test.ts:279` timeout-defaults pin | remove test | B (WRONG-ACTION) | Entirely two real `toBe` pins on genuine timing thresholds, not prose. **Proposal was simply wrong — keep.** |
| `FileOpenDialog.test.ts:157` "drop-anywhere hint only in Tauri runtime" | remove test | B (WRONG-ACTION) | Sole coverage of a real `isTauriRuntime()`-gated branch. **Genuinely bad anchor (prose string), real branch — different remedy: add a `data-testid`, out of scope for this pass.** |
| `editor-stage.test.ts:433` `narrowThresholdPx` rails=0 | remove test | B (WRONG-SURVIVOR) | Named survivor file (`marginModeThresholds.test.ts`) does not exist in the repository — confirmed by `find`/`grep`. **Bad citation; keep the circular-but-only test until a real independent one exists.** |
| `file-opener-edge-cases.test.ts:211-226` "SUPPORTED_EXTENSIONS contains/does not" | consolidate | A (WRONG-DEFECT, partial) | The "contains" half (`.htm`/`.docx`) is the only place either extension is checked at all. **Different remedy: keep the "contains" half, only the "does not contain" half may go.** |
| "Group" (table artifact) | consolidate | A (WRONG-ACTION) | Not a real proposal — mechanical extraction pulled a table-header cell. **Drop from the candidate list entirely, nothing to review.** |
| `app-action-mount-contract.test.ts:260` "no longer references wireActionDeps" | consolidate | A (WRONG-DEFECT) | Survivor's `checkActionMountContract` never inspects for the string. **Genuinely distinct, cheap regression guard — keep.** |
| `FileOpenDialog.test.ts:291` "(d2) Clear all cancel disarms" | consolidate | A (WRONG-DEFECT, low severity) | Survivor (h) never asserts the clear API wasn't called. **Different remedy: add the no-API-call assertion to (h) first, or keep (d2).** |
| `use-models-no-key-leak.test.ts:124` | consolidate | A (WRONG-SURVIVOR), C (WRONG-ACTION) | Verified: genuinely different code paths (client-side validation throw vs. real 503 network failure). **Proposal was simply wrong — keep both.** |
| `docx-comments.test.ts:504-516` "handles multiple comments" | consolidate | A (WRONG-SURVIVOR) | Named survivor's second call has one new + one drifted comment, never two brand-new. Real survivor exists (`:518-533`) but wasn't cited. **Fix the citation before deleting.** |
| `event-types.test.ts` `formatEventContent` (as `consolidate`, row 83) | consolidate | A (NEEDS-EVIDENCE) | Mislabeled action — no external survivor to compare against; this is really a `remove assertions` proposal. See the separate `remove assertions` row below (also excluded, different reason). |
| `adr-034-open-characterization.test.ts` large-document warnings | remove assertions | D (WRONG-ACTION) | No structured `severity` field exists as an alternative pin (unlike `save-ordering-1749-1750.test.ts`). Deleting the escalation test's sole assertion leaves a zero-assertion `it`. **Different remedy: keep all three regex checks until a structured field is added.** |
| `range-bounds-validation.test.ts:411-473` clamp-signal wording | remove assertions | D (WRONG-ACTION) | The wording replaced an earlier factually-wrong description — documented regression history, the retention standard's own positive example. **Keep the wording check.** |
| `cowork-settings-mounted.test.ts` "surfaces a re-read failure" | remove assertions | D (WRONG-ACTION) | `"refresh"` is the only thing distinguishing two real ternary branches sharing an error string. **Keep it; the component's real conditional is what's being protected.** |
| `annotation-card-helpers.test.ts:83-127` `formatRelativeTime` | remove assertions | C, D, sample (all WRONG-ACTION) | Pins a stated off-by-one-prone boundary. **Genuinely bad specific pin (the " ago" suffix), real boundary logic — different remedy: narrow to number+unit via regex (e.g. `/^59m\b/`), don't delete the boundary cases.** |
| `recent-files.test.ts:176-201` `formatWhen` | remove assertions | C, D, sample (all WRONG-ACTION) | Same shape, worse: output has no decorative suffix to strip at all (`"59m"` not `"59m ago"`). **Keep the boundary-edge cases as-is; no narrowing is possible here (unlike `formatRelativeTime`).** |
| `event-types.test.ts:23-127` `formatEventContent` (as `remove assertions`, row 73) | remove assertions | D (WRONG-ACTION, partial) | `document:opened`/`closed`/`switched` and `annotation:accepted`/`dismissed` are discriminated ONLY by the fixed verb, which also reaches Claude over the real channel (`event-bridge.ts`). **Different remedy: keep exact matches for the event-type/verdict-verb cases specifically; `toContain` is safe only for id/selection-interpolated cases.** |
| `push-support.test.ts:492` "empties status between copies" | remove assertions | D (WRONG-ACTION, partial) | The stated purpose of the test (repeat click re-announces) has no other assertion protecting it. **Keep `:492`; `:471`'s deletion (cleared above) is fine on its own.** |
| `annotation-body.test.ts:78-86` "carries shared markdown class" | remove assertions | D (WRONG-ACTION/WRONG-DEFECT) | Neither cited survivor actually checks the `.tandem-markdown` class (verified: they check different concerns — DOM nesting and parsing, not stylesheet class). **No real survivor exists; keep both checks.** |
| `OutlinePanel.svelte.test.ts:29-34` "empty state when no headings" | remove assertions | D (WRONG-ACTION), also see contradiction below | Removing the only positive assertion degenerates into a negative-only assertion resting on a locator that never matched. **Different remedy: keep the text check until a `data-testid` exists on the empty state.** |
| `list-edit.test.ts:215-230` guard mirror | remove assertions | D (WRONG-ACTION, "too timid") | The defective part is the entire mirrored oracle, not one assertion; a partial trim leaves a duplicate husk. **Different remedy: `remove test`, paired with importing the real guard predicate elsewhere — not a partial trim.** |
| `reload.test.ts:30-66` "refreshAllRanges re-anchors annotations" | remove assertions | D (WRONG-ACTION, "too timid") | `expect(stored).toBeDefined()` proves survival, never correct position — the test's stated purpose. **Different remedy: `remove test`, or add the real position-correctness assertion in the same change.** |
| `api-routes.test.ts L852-862` "rejects a replayed nonce with 403" | remove assertions | D (WRONG-ACTION, "too timid") | Correcting to `toBe(200)` (as C separately agreed) produces a test structurally identical to the sibling `:812-822` idempotency test. **Different remedy: resolve as `remove test`/consolidate into `:812-822`, not a corrected-but-duplicate `remove assertions`.** |
| `sse-parsing.test.ts:64` "logs the specific parse error message" | remove assertions | D (NEEDS-EVIDENCE) | The loose OR-match may be deliberate (Node/V8 `SyntaxError` text is version-dependent) rather than lazy. **Unresolved without running the suite — keep the loose-but-scoped check, or assert `error.name==="SyntaxError"` instead of message text, as a lower-risk alternative.** |
| `tests/server/integrations/storage.test.ts` TOCTOU regex | remove test | sample (NEEDS-EVIDENCE, on row identity) | C independently opened and confirmed this is a real, distinct Gate-3 failure (regex-matches source text, no filesystem interaction). **This is process-blocked, not substantively contested — a quick follow-up read of `BATCH-13.md` against source (which C already did) clears the ambiguity sample flagged. Recommend re-reviewing this one row in isolation before the next pass rather than treating it as genuinely unsettled.** |

### Excluded by cross-reviewer contradiction (two reviewers disagree on the same proposal)

| Location | Proposed action | Reviewer split | Why unsettled |
|---|---|---|---|
| `license.test.ts:25-113` + `:202-258` | remove test (both) | B: WRONG-ACTION on both / sample: AGREE on both | See Task 2.1 — the combination zeroes CI coverage of `verifyLicense`'s real success path. Do not resolve by majority; both rows stay excluded until a same-change rewrite lands. |
| `dedup.test.ts` (whole file) | consolidate → `dedup-extended.test.ts` | A: WRONG-DEFECT (mild) / C: AGREE | A found the survivor's multi-item cases use `.toHaveLength(N)` + a single spot-checked `.id`, never full-array equality — a bug returning the right count but wrong/reordered entries would pass the survivor and be caught by the original. C did not check oracle strength, only scenario coverage. **Genuine disagreement about oracle adequacy, not a citation error — exclude until either 1-2 of the original's full-array-equality cases are kept, or the survivor's cases are strengthened.** |
| `mode-cache.test.ts` dedup pair — `integration.test.ts:46` and `:52` | consolidate → `mode-cache.test.ts:44`/`:103` | A: WRONG-SURVIVOR (both) / C: AGREE (both) | A found `integration.test.ts`'s own module comment states its purpose is to catch **drift between the server-side and monitor-side mode defaults** by co-locating both sides in one file — a property `mode-cache.test.ts` alone cannot detect since it only tests the monitor side. C verified scenario-level duplication but did not weigh the file's stated convergence-testing purpose. **Real disagreement about what property is being protected, not a citation error — exclude both rows. If kept, replace with a narrower assertion that still fails on drift (e.g. importing `TANDEM_MODE_DEFAULT` into the assertion) rather than deleting outright.** |
| `annotation-body.test.ts:78-86` | remove assertions | C: AGREE / D: WRONG-ACTION/WRONG-DEFECT | C accepted the audit's stated survivors; D independently re-read both and found neither actually checks the `.tandem-markdown` class. **Exclude — D's finding is the more specific one, but this is a genuine disagreement about survivor coverage, not resolved by this pass.** |
| `OutlinePanel.svelte.test.ts:29-34` (and its duplicate extraction at line 145) | remove assertions | C: AGREE / D: WRONG-ACTION | C treated the surviving `queryAllByRole("button")).toHaveLength(0)` check as sufficient; D treated the resulting negative-only assertion as the catalog's own named anti-pattern (passes because nothing was found, including if the component silently renders nothing at all). **Exclude both line references — same underlying proposal.** |
| `list-edit.test.ts:215-230` | remove assertions | D: WRONG-ACTION (too timid) / sample: AGREE ("apply as proposed") | Sample treated this as a clean strengthening; D found the surviving husk (after trimming just the mirror loop) is itself redundant with the file's equivalence-table describe block, and the actual fix needs to be `remove test` + new coverage of the real guard predicate. **Exclude — different remedy, not resolved.** |
| `api-routes.test.ts L852-862` | remove assertions | C: AGREE ("replace with toBe(200)") / D: WRONG-ACTION (too timid, wants remove test/consolidate) | Both agree on the diagnosis (structurally can't reach 403); disagree on whether the corrected test still earns its place once it's identical to `:812-822`. **Exclude — resolve the remedy shape before acting.** |

**Total exclusions from set-level interaction analysis specifically (Task 2), as distinct from per-proposal refusal:** 1 pair (`license.test.ts` rows), already counted in the contradiction table above since a second reviewer's disagreement is what made it visible as a pair rather than two independent proposals. No other Task-2-only exclusion was needed — every other flagged interaction (2.2–2.9) resolved with real protection confirmed to survive, so nothing else moved to excluded on interaction grounds alone.

---

## TASK 4 — Execution notes (cleared set only)

### Suggested order

1. **`tests/server/license.test.ts`** — skip entirely this pass (both proposed rows excluded per Task 2.1). Do not touch this file.
2. **Server unit-test files with simple, isolated `remove test`/`remove assertions` actions and no empty-describe risk** first: `document-service.test.ts`, `session-restore.test.ts`, `mcp-tool-integration.test.ts`, `file-watcher.test.ts`, `docx.test.ts`, `document-model.test.ts` (excluded — skip), `info-route.test.ts`, `docx-footnote-reconstruction.test.ts`, `file-watcher-real-fs.test.ts`, `platform.test.ts`, `document-tools.test.ts`, `rename-route.test.ts`, `annotation-relpos.test.ts`, `format-adapter.test.ts`, `license-kv-store.test.ts`, `multi-document.test.ts`, `edit-annotation.test.ts`, `index.startup-ordering.test.ts`.
3. **Files needing empty-describe cleanup — do these as one deliberate step per file, not incidentally:**
   - `tests/server/annotations.test.ts` — removing `:109,116,122,130` empties `describe("filter logic", ...)`; removing `:166,179,191,201` empties `describe("resolve and remove", ...)`. Delete both `describe` wrappers.
   - `tests/server/annotation-tools.test.ts` — after removing 4 of 5 its in `describe("tandem_getAnnotations tool logic", ...)`, exactly one (`"returns all annotations unfiltered"`) remains; the describe block stays but shrinks to 1 case — verify it still reads coherently on its own (it no longer documents "filter" behavior despite being adjacent to filter-named removals in a sibling file).
   - `tests/server/navigation.test.ts` — 4 of its describe blocks are fully cleared (17 cases). Check what remains; if nothing does, delete the file outright rather than leaving an empty shell, and remove it from any test-glob or index that references it by name.
4. **Whole-file removals** (verify import cleanliness — a whole-file delete can leave a barrel/index import dangling): `authorship-edit-integration.test.ts`, `chat-extended.test.ts`, `dirty-state.test.ts`, `issue-377-structure-probe.test.ts`, `authorship-marks-size.test.ts`, `use-review-completion.test.ts`, `reply-abort.test.ts`.
5. **Consolidations last**, since several require verifying an assertion actually lands on the survivor before the deletion is safe, not just deleting the loser:
   - `markdown-paste.test.ts:459-469` → verify `parser.schema===schema` is added to the bold-conversion test.
   - `index.test.ts:254` → verify the folded `onEventId` assertion uses `solo-filter.test.ts`'s wake-worthy `annotation:created` vehicle, not the non-wake-worthy `document:opened` the deleted test used.
   - `index.startup-ordering.test.ts:22-51`, `rename-route.test.ts:217-228`, `license.test.ts:167-170`, `document-tools.test.ts:200-215`, `file-opener-edge-cases.test.ts:52-76`, `useAppInfo.test.ts` pairs, `useFirstRunNeeded.test.ts:181`, `model-first-run.test.ts:27-29`, `PeekStrip.svelte.test.ts:65-71/73-77`, `dedup.test.ts` — **excluded, do not touch**, `use-tandem-settings-migration.test.ts` (3 rows), `index.test.ts:206`, `index.test.ts:488` — apply as documented.

### Files needing care beyond empty-describe

- **`tests/server/awareness-tools.test.ts`**: 12 of its cases across 4 describe blocks are cleared. After removal, verify no now-unused local helper (e.g. hand-rolled inbox-filter functions) is left imported but uncalled.
- **`tests/client/document-workspace.svelte.test.ts`**, **`tests/client/coordinate-conversion.test.ts`**, **`tests/client/slash-command.test.ts`**: single-row removals, low risk, no orphan-import concern expected.
- **`tests/monitor/index.test.ts`**: three separate consolidate rows (`:206`, `:254`, `:488`) target the same file. Apply all three in one pass over the file rather than three separate edits, since they interact with the same describe structure.

### Verification

Run the affected test files individually first (`vitest run <file>` per touched file), then the
full suite. **Compare against the stated baseline — 643/645 files passing, with three known
load-induced timeouts in `tests/server/docx-apply.test.ts` that pass in isolation — not against an
all-green expectation.** A new failure in a file this plan did not touch is out of scope for this
cleanup and should be investigated separately, not folded into this batch's rollback decision. A
new failure in a touched file, or `docx-apply.test.ts` failing even in isolation (a change from the
stated baseline), blocks that batch specifically.

Do not run `npm test`, `npx vitest`, or any git/npm command as part of producing this plan — this
document is read-only output. Execution and verification are a separate, later pass.

---

## Summary

- **Cleared actions:** 113 distinct test-location actions (consolidations, whole-file removals,
  assertion trims, and test removals), spanning ~55 files.
- **Excluded:** 33 distinct proposals — 27 from direct per-proposal reviewer refusal (a single
  reviewer marked `WRONG-DEFECT`/`WRONG-ACTION`/`WRONG-SURVIVOR`/`NEEDS-EVIDENCE`), plus 6 where two
  reviewers gave contradictory verdicts on the same proposal (the `license.test.ts` pair,
  `dedup.test.ts`, the `mode-cache.test.ts`/`integration.test.ts` pair, `annotation-body.test.ts`,
  `OutlinePanel.svelte.test.ts`, `list-edit.test.ts`, and `api-routes.test.ts L852-862` — several of
  these span both categories and are counted once, under contradiction, since that is the more
  specific reason).
- **Zero-protection behaviors rescued from the cleared set:** 1 — the `license.test.ts` pair
  (`:25-113` + `:202-258`), the seeded example, confirmed and kept excluded.
- **Zero-protection behaviors flagged but NOT created by this cleanup** (pre-existing, stated for
  visibility per Task 2's instruction, not moved to excluded because no cleared-row combination is
  what causes them): annotation filter-by-author/type/status (§2.3), `dirty.ts`/SRVDOC-26 (§2.5),
  and the reduced-motion transition-suppression property in `settings-push-routes.test.ts` (stated
  directly in its own cleared row).
