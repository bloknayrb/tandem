# Tandem test-suite behavior-coverage heat map

Built from `.test-review/project-model.md` + `model-parts/*.md` (429 behaviors) and
`audit-parts/BATCH-01..16.md` + `server-launcher.md`. Read-only; no code or test files were run.

> `model-parts/` and `audit-parts/` are untracked — they are ~17,700 markdown lines and exceeded the
> budget of the repo-wide markdown round-trip metric, which scans every tracked `.md`. They remain on
> the machine the audit ran on; the rows below carry their conclusions.

## Scope and method (read this before the table)

The model marks **~370 of 429 behaviors `critical` or `high` impact** (SRVDOC 61/70, SRVAPI 65/78,
CLIED 28/39, CLISH ~19/42, TOOL ~185/200 by the model's own per-entry impact field). A literal
one-row-per-critical/high-behavior table would run past 350 rows, most of which no batch's closing
section discusses by ID — the sixteen audits are organized by **file**, not by **behavior ID**, and
only name an ID explicitly when a row maps cleanly to one or when a gap is being flagged. Reading
all ~9,800 lines of per-test audit tables at full depth to hand-verify every ID was not achievable
in this pass.

**What this document actually is:** every behavior ID that appears **by name** anywhere in a
batch's closing "Behavior gaps," "Confirmed-bad groups," or per-row Findings text (evidence-backed
`strong`/`weak`/`absent`), plus a representative, impact-ordered set of the remaining critical/high
IDs carried as `unknown` — the honest default per the task's own instructions, not a claim of
absence. TOOL (CLI/scripts/CI/Rust desktop, 200 entries) is scoped to its `critical`-impact subset
(~48 of ~137 critical+high) for the same reason; TOOL `high`-impact rows were not individually
re-verified against audit rows and are omitted rather than filled with unverified guesses.
**Cell rule:** `strong` names a real test; `weak`/`absent` are stated in a batch's own gap section;
`unknown` means no batch discussed this ID by name in the material read for this pass — it is not
a claim of absence, per the task brief.

Where two batches disagree on the same territory (e.g., a predicate tested indirectly in one file
but flagged untested-by-name in another), both readings are given rather than picked silently.

---

## 1. Heat map

### SRVDOC — document/annotation/CRDT core, file-watcher, events, positions

| ID | Behavior | Impact | Unit | Integration/contract | E2E/other | Gap or retained protection |
|---|---|---|---|---|---|---|
| SRVDOC-01 | Origin-tag helper choice gates every downstream observer | critical | unknown | unknown | n/a | No batch names a test that plants a wrong-helper write and observes the downstream miss; `audit:origins` census (TOOL-69) exits 0 unconditionally regardless. |
| SRVDOC-02 | Range validation check order (staleness before upper bound) | critical | unknown | **strong** — `range-bounds-validation.test.ts` (BATCH-05) | n/a | Notification-wording sub-assertion had one unpinned clause (removed); ordering itself well exercised. |
| SRVDOC-03 | Surrogate-pair PAIRED predicate | high | unknown | **strong** — `range-bounds-validation.test.ts:286-317` (BATCH-05) | n/a | Only 2 of 4 `surrogates:"ignore"` call sites (`.docx` capture/import) exercised in the batches read; the two watcher sites (`documents/reload-family.ts`) not confirmed anywhere read. |
| SRVDOC-05 | `refreshRange` "repaired" branch re-anchors from stale offsets, no snapshot check (#1764, open) | critical | unknown | **weak** — `reload.test.ts` (BATCH-05: 3 cases hedge/no-op on the exact branch, actioned `remove assertions`, not removed outright); `document-store.test.ts:311-329` (BATCH-03: "covers only the simple re-anchor case"); `issue-377-position-diagnostics.test.ts:306-354` (BATCH-03: "central oracle accepts either outcome") | n/a | **Headline gap**, corroborated independently in 3 batches (01, 03, 05) for the exact defect class CLAUDE.md's own gotcha names. |
| SRVDOC-08 | File-watcher self-write suppression (counter + fingerprint) | critical | **strong** — `document-write-rearm.test.ts` (AST-pinned sequence) | **strong** — `document-service.test.ts` save-arm wiring, `file-watcher.test.ts` (BATCH-02) | n/a | One re-entrancy-only test in `file-watcher.test.ts:760` removed as redundant; core suppression well covered. |
| SRVDOC-09 | `rename` re-arm is POSIX-only, async, ordered | high | **strong** (Linux/Windows) — `file-watcher.test.ts` stubs `"linux"`/`"win32"` (BATCH-02) | n/a | n/a | **macOS re-arm path is untested** — no `"darwin"` stub case exists despite the idiom trivially supporting one (BATCH-02 gap note). |
| SRVDOC-10 | Reload-vs-conflict dispatch (never silently reload dirty/conflicted docs) | critical | n/a | **strong** — `external-conflict.test.ts` (BATCH-01 Part C, 0 confirmed-bad of 124 rows) | unknown | — |
| SRVDOC-11 | `reloadFromDisk` two-pass repair, silent mispin on relocation failure | critical | unknown | **weak** — same corroborated gap as SRVDOC-05 (BATCH-02 gap note groups them) | n/a | — |
| SRVDOC-12 | `clearAndReload` (`force:true`) deletes the durable annotation envelope from disk (#1813, open) | critical | n/a | **weak** — Y.Map-level clear tested (`file-open-api.test.ts`, BATCH-04); **the on-disk `fs.unlink` half is asserted nowhere across the 44 files in BATCH-04**, and BATCH-01 independently flags the same absence | n/a | **Headline gap** — the destructive half of a project-flagged-open policy question has zero test evidence. |
| SRVDOC-13 | `pickWinner` merge tie-break (rev → editedAt → Y.Map-wins) | high | unknown | **weak** — "no conflict scenario constructed in this batch" (BATCH-04) | n/a | — |
| SRVDOC-15 | ADR-027 boundary enforced at 4 write families by 2 predicates (create side) | critical | unknown | **strong**, create side only — `sanitizeAnnotation`/`mintAnnotation` structural guarantee, well-exercised annotation-creation lifecycle tests (BATCH-03) | n/a | The **edit/resolve/remove** predicates are a separate, weak/absent item — see SRVDOC-57..60 below; do not read this row as covering those. |
| SRVDOC-18 | Annotation store disabled after 3 consecutive write failures | high | n/a | **absent** — "no test anywhere in this batch" (BATCH-01) | n/a | No other batch names it either. |
| SRVDOC-21 | Session-restore fallback cloning on `restoreYDoc` throw (#1800) | critical | n/a | **strong** — `session-restore.test.ts` `#1800` family: 5-shape `it.each`, GC/mtime pair, eviction (both branches), 3 failure-isolation cases (BATCH-01, extensively detailed) | n/a | One of the best-protected behaviors in the whole model. |
| SRVDOC-25 | Registry composite mutators / `broadcastOpenDocs` | high | n/a | **strong** — `document-service.test.ts:300-365` (real Y.Map read/write, epoch-on-reselect case; BATCH-01) | unknown | — |
| SRVDOC-26 | `dirty.ts` flag drives autosave, race-safe version comparison | high | n/a | **strong** — `document-service.test.ts` `autoSaveAllToDisk` family (BATCH-01 rows 81-84); **not** via `dirty-state.test.ts`, which BATCH-06 confirms tests only raw Yjs Map semantics and was actioned `remove test` (no loss — coverage lives elsewhere) | unknown | — |
| SRVDOC-27 | Autosave isolates one throwing document's failure from the shared tick (#1750) | critical | n/a | **absent** — "no test in this batch... `autoSaveAllToDisk`'s tests all use a failure-free happy path" (BATCH-01, explicit gap-note row in the table itself) | n/a | **Headline gap** — direct data-loss vector, explicitly critical, zero coverage found. |
| SRVDOC-31 | `resolveExternalConflict` episode-identity check (#1238) | critical | unknown | **weak**, adjacent finding — SRVAPI-61: "only the origin gate is tested" for `external-conflict.ts`'s `detectedAt` episode match (BATCH-04) | n/a | — |
| SRVDOC-33 / SRVDOC-34 | Schema `.passthrough()` forward-compat / migration runner | critical | n/a | **strong** — `schema.test.ts` (BATCH-14, 48 rows, high quality) | n/a | — |
| SRVDOC-36 | Rename recovery (#313), read-only/feature-disabled bail rails | critical | unknown | **weak** — `rename-document.test.ts` never opens with `allowRecovery:true` against a genuinely orphaned envelope; the read-only-store bail is unexercised (BATCH-02) | n/a | — |
| SRVDOC-37 / SRVDOC-38 | Held-in-Solo stamp / ADR-035 channel projection | critical | n/a | **strong** — `channel-projection-characterization.test.ts` (24/24), `channel-eligible-brand.test.ts` (20/20) (BATCH-15) | n/a | — |
| SRVDOC-39 | `doc-hash.ts` real-path vs. upload-id keying | high | n/a | **strong** — `document-service.test.ts:1260-1346` (BATCH-01: full re-key round trip via real per-doc store, proves old key does NOT also hold data) | n/a | — |
| SRVDOC-41 | Event queue `"external"`/`"internal"` subscriber classes, Solo gate on external only | critical | n/a | **strong** — `wake-socket.test.ts:242,265` positive/negative pair (BATCH-15), `event-queue.test.ts` (BATCH-01 Part C) | n/a | — |
| SRVDOC-43 | `sse.ts` wake-filter fails closed (400) on unrecognized value | high | n/a | **strong** — `sse-wake-filter.test.ts` (13/13, BATCH-15) | n/a | — |
| SRVDOC-44 | `wake-socket.ts` socket-address auth, dead-consumer reaping | high | n/a | **strong**, auth half — `wake-socket.test.ts` (24/24, BATCH-15) | n/a | **weak**, idle-reaper pin-blindness half — "SRVAPI-9/SRVDOC-44 idle-session-reaper pin-blindness... untouched" (BATCH-01) |
| SRVDOC-46 | Per-map observer factory, annotation-delete latent gap | high | unknown | **weak** — "no test in `event-queue.test.ts` exercises a `withBrowser`-origin delete on the annotations map" (BATCH-01, model's own flagged latent gap) | n/a | — |
| SRVDOC-51 | Nested-list `tandem_edit` resolution | high | n/a | **absent** for the write path — "`document-edit.test.ts`'s harness structurally cannot reach nested containers... zero real-handler coverage" (BATCH-02) | n/a | `positions.test.ts:685-738` covers *resolution* only, not the edit write path. |
| SRVDOC-53 | `.html` read-only-by-policy (#1798) | critical | n/a | **strong** for `.html` specifically — `document-service.test.ts:633-659` (BATCH-01, both directions) | n/a | **weak** for the general "read-only by format" class — "well covered for `.html`; no other read-only-by-format case exercised" (BATCH-04) |
| SRVDOC-54 | `finalizeDocOpen` ordering (dirty-observer-after-content-load) | high | n/a | **strong** — `document-service.test.ts:1434-1471` (#851 positive+negative pair, BATCH-01) | n/a | — |
| SRVDOC-57 | `editPendingAnnotation` guard = `isPrivateForClaude`, 6-step order | critical | n/a | **absent** — none of `edit-annotation.test.ts`, `document-store.test.ts`, `resolve-annotation.test.ts`, `replies-privacy.test.ts` exercises the guard predicate itself (BATCH-05, direct file-by-file check) | n/a | **Headline gap.** |
| SRVDOC-58 | `transitionPending` guard = `isWithheldFromClaude` | critical | n/a | **absent** — same finding as SRVDOC-57 (BATCH-05); "zero coverage" also independently stated for the related boundary in BATCH-03 | n/a | **Headline gap.** |
| SRVDOC-59 / SRVDOC-60 | `removeForClaude` guard vs. unguarded `removeAnnotationRecord` | critical | n/a | **absent** — "SRVDOC-59/60's guard boundary... has zero coverage in this batch" once bad Y.Map-primitive tests are removed (BATCH-03); confirmed independently by BATCH-04/05 | n/a | **Headline gap** — `remove-annotation.test.ts` tests the unguarded producer correctly but never the guard. |
| SRVDOC-61 | `writeReply` single-builder, no author branching | high | n/a | **strong**, adjacent — `annotation-reply-seam.test.ts` pins the importer/who-may-call set (BATCH-03) | n/a | — |
| SRVDOC-62 | `addUserReply` deliberately unguarded, HTTP-reachable | high | n/a | **weak** — "no test drives an actual unauthenticated-origin POST" (BATCH-04); importer-pin only | n/a | — |
| SRVDOC-64 | Write-side privacy predicates: 2 functions, not 4 | critical | n/a | **absent** — same evidence as SRVDOC-57/58/59/60 (no batch tests the predicates directly) | n/a | Same headline family. |
| SRVDOC-65 | `tandem_getAnnotations` applies `isClaudeFacing` before WS-A2 Solo hold | critical | n/a | **weak** — "the actual author/type/status filter stage inside the real `tandem_getAnnotations` handler is untested" (BATCH-03); privacy-adjacent `read-audience-filter.test.ts` is good but doesn't confirm the specific ordering | n/a | — |
| SRVDOC-66 | `channelVisibleReplies` (pull) vs. `narrowReplyForChannel` (push) author-check asymmetry | critical | n/a | **strong**, push side — `channel-projection-characterization.test.ts:383` `it.each(["import","claude"])`, `channel-eligible-brand.test.ts:201,288` (BATCH-15, source-verified) | **absent**, pull side — confirmed independently by BATCH-03, BATCH-05, and BATCH-15 that no test anywhere read exercises `channelVisibleReplies`/`src/server/mcp/annotations.ts` for this | **Headline gap**, one of two findings the model itself raised during modeling ("Findings raised during modeling," SRVDOC-66) and the audit corroborates it is unresolved by test. |
| SRVDOC-67 | `tandem_checkInbox` Solo-hold-before-ledger-write ordering | critical | n/a | **absent** — "SRVDOC-67's actual load-bearing property (gate-before-ledger ordering) is untested" after `awareness.test.ts`'s reimplementation-only cases are removed (BATCH-03) | n/a | **Headline gap.** |
| SRVDOC-70 | ADR-027 write guards carry NO Solo-mode check (model's own flagged open question) | critical | n/a | **absent** — independently confirmed by BATCH-01, BATCH-03, BATCH-04, BATCH-05, and BATCH-14 ("no test constructs a Solo-held annotation and exercises `transitionPending`/`removeForClaude` against it") | n/a | **The single most repeatedly-corroborated absence in this audit** — 5 independent batches, same finding, same behavior ID, matching the model's own "unknown whether intentional" framing. |

### SRVAPI — MCP tools, `/api` routes, license, launcher, integrations, channel

| ID | Behavior | Impact | Unit | Integration/contract | E2E/other | Gap or retained protection |
|---|---|---|---|---|---|---|
| SRVAPI-09 | Idle-session reaper pin-blind to attached-but-quiet SSE streams | high | unknown | **weak** — "untouched by either file in Part C" (BATCH-01) | n/a | — |
| SRVAPI-11 | License gate Surface B (`gatedTool`) blocking branch | critical | n/a | **weak** — "never exercised in `mcp-tool-integration.test.ts`... a regression that made `gatedTool` fail to actually block would not be caught here" (BATCH-01) | n/a | — |
| SRVAPI-21 | Supervisor subscribes as `"external"`, honors Solo gate | critical | n/a | **strong** — Group K, `stream-json-protocol.test.ts` (server-launcher.md); the exact `"external"` argument itself is asserted in `event-queue.test.ts`, confirmed present by cross-reference, not duplicated here | n/a | — |
| SRVAPI-22 / SRVAPI-23 | Bootstrap turn on spawn / `--resume` session-scoping gate | critical / high | n/a | **strong** — `stream-json-protocol.test.ts` "fresh spawn"/"resumed spawn" groups, real subprocess, no `spawn` mock (server-launcher.md) | n/a | — |
| SRVAPI-24 | Self-armed wake socket (`/api/wake`) three-layer guard | critical | n/a | **strong** — `wake-socket.test.ts` (24/24, BATCH-15) | n/a | — |
| SRVAPI-32 | `tandem_comment` range-validation gate | high | n/a | **weak** — "exercised at the `positions.ts` level but never through the actual `tandem_comment` tool handler" (BATCH-03) | n/a | — |
| SRVAPI-33 | `resolveAnnotation`/`removeAnnotation`/`editAnnotation` ADR-027 guards | critical | n/a | **absent** — same headline family as SRVDOC-57..60 | n/a | — |
| SRVAPI-38 | `tandem_checkInbox` gate-before-ledger ordering (server side) | critical | n/a | **weak** — "not directly exercised by this file's `checkInbox` tests" (BATCH-01), matches SRVDOC-67 | n/a | — |
| SRVAPI-45 | License activation real happy-path (bound-before-allocate) | high | n/a | **weak, delivery gap** — the one test that could exercise the real verifier's successful path in CI (`license.test.ts:202-258`) never actually runs (early-return-before-assertion on every CI run) and is itself flagged for removal/skip-conversion (BATCH-04) | n/a | — |
| SRVAPI-47 | Launcher circuit breaker (trip-time, #1268) | high | n/a | **strong** — real restart loop, real crash attempts, all 4 diagnosis branches (server-launcher.md) | n/a | — |
| SRVAPI-48 | `relaunch`/`startFresh` shared `respawn`, statement-order invariant | high | n/a | **weak/mixed** — the stdin-error-handler-attach ordering is pinned only by a source-text regex parse ("mixed... coupled to exact source formatting," server-launcher.md); behaviorally unobservable otherwise | n/a | Auditor's own words: "the kind of test the removal catalog is generally suspicious of," kept for lack of a cheaper alternative. |
| SRVAPI-49 | `previewCwdDrift` fails toward silence | normal(model)/high(functional) | n/a | **strong** — `cwd-preview.test.ts`, called "the cleanest of the four files," real un-seamed `os.homedir()` (server-launcher.md) | n/a | — |
| SRVAPI-51 | `assertPathSafe` walk-up symlink screening (integrations) | critical | unknown | unknown | n/a | Distinct from `resolveSafeCwd` (launcher), which IS strongly tested (server-launcher.md); `assertPathSafe` itself not confirmed by name in batches read. |
| SRVAPI-52 | Bundled-skill auto-refresh, extraction-defeat resistance | high | n/a | **unresolved** (explicit, not a verdict) — "whether this test is vulnerable to the same call-site-extraction defeat its sibling documents having been found and fixed... not confirmed this pass" (BATCH-04) | n/a | Auditor declined to guess; carried here as `unknown` per the same discipline. |
| SRVAPI-61 | `external-conflict.ts` episode-matching (`detectedAt`) | high | n/a | **weak** — "only the origin gate is tested" (BATCH-04) | n/a | — |
| SRVAPI-62 | `annotation-reply.ts`/`remove-annotation.ts` unguarded routing | high | n/a | **weak** — same as SRVDOC-62 | n/a | — |
| SRVAPI-66 | `shutdown.ts` hand-rolled stricter gate pair | critical | unknown | unknown | n/a | Not named by ID in any gap section read; no negative finding surfaced either. |
| SRVAPI-71 | `POST /api/integrations/apply` nonce+mutex+re-detection | critical | n/a | **strong** — "extensively and well tested" (BATCH-14, Parts C1-C3, cross-checked) | n/a | — |
| SRVAPI-72 | `install-claude-cli.ts` scheme-repin, byte-cap, stall-timeout | critical | n/a | **absent** — "`MAX_SCRIPT_BYTES` byte-cap and `FETCH_TIMEOUT_MS` stall-timeout... have no test anywhere in `install-claude-cli.test.ts`" (BATCH-14) | n/a | — |
| SRVAPI-74 | `acl-win.ts` — `icacls` exit-0-on-partial-failure awareness | critical | n/a | **weak** — the one direct TOCTOU-regression test for the per-file ACL call is a source-text regex "defeated by an ordinary rename," actioned for removal (BATCH-14, confirmed-bad item 2) | n/a | Real property (Windows ACL protecting a bearer-token file) currently has only a fragile guard. |
| SRVAPI-75 | `keychain.ts` throws NOT memoized (self-heal) | high | n/a | **absent** — "zero direct test coverage — every test in `keychain.test.ts` bypasses the memoize path by injecting an explicit backend" (BATCH-14) | n/a | — |
| SRVAPI-77 | Launcher `api-routes.ts` per-route nonce rotation | high | n/a | **strong**, overall — extensive real-HTTP coverage (server-launcher.md, 12 rows) | n/a | **weak**, 2 sub-cases — 2 disjunctive `[200,429]`/`[200,403]` assertions confirmed by source read to hide a deterministic branch (server-launcher.md, both actioned for removal/rewrite). |
| SRVAPI-78 | Supervisor `stopInternal` 3-stage escalation (SIGTERM→SIGKILL→abandon) | high | n/a | **weak** — "no test in this batch that exercises the *timed* escalation itself... nor observes the actual SIGTERM-before-SIGKILL sequencing" (server-launcher.md); subscription-cleanup side effect of the abandon branch IS tested | n/a | — |

### CLIED — Tiptap editor, decorations, coordinates, sync, paste, link safety

| ID | Behavior | Impact | Unit | Integration/contract | E2E/other | Gap or retained protection |
|---|---|---|---|---|---|---|
| CLIED-09 | `$state` writes from Tiptap sync callbacks (`createCoalescingTick`) | critical | unknown | unknown | n/a | Not named by ID in batches read; CLAUDE.md's own named gotcha. |
| CLIED-10 | Hocuspocus provider bootstrap, per-tab lifecycle, stale-tab recovery | critical | **weak** — only the `backoffOptionsFor` sub-function is exercised (`yjs-backoff.test.ts`); "the per-tab lifecycle, generation-id auth rejection, epoch-gating and rebuild-vs-reconnect distinction are not reached here" (BATCH-11) | unknown | n/a | Large critical-impact surface with narrow actual coverage in the batch that owns it. |
| CLIED-16 | Editor lifecycle rebuild on Y.Doc/provider identity change | high | n/a | **weak** — after a proposed removal (`editor-smart-typography.test.ts:48-58`, a reimplementation-only test), "no test in this batch exercises the real rebuild effect" (BATCH-11) | n/a | — |
| CLIED-20 / CLIED-28 | Plaintext newline/hardBreak containment (keystroke + paste boundaries) | critical | unknown | unknown | n/a | Not named by ID; #1448-lineage class, no explicit batch finding read. |
| CLIED-21 | Verbatim-passthrough markdown attributes, write-only from CRDT | critical | n/a | **weak** — `attribute-parity.test.ts` covers the schema-declaration half; "the higher-impact write-only-from-CRDT rule is not reached by this batch's files" (BATCH-11) | n/a | — |
| CLIED-32 | Annotation-reply client-display filter (ADR-027 client half) | high | unknown | unknown | n/a | Not confirmed by ID in batches read; server-side twin (SRVDOC-66) is a confirmed absence. |
| CLIED-36 | `editor-props.ts` paste-handler precedence | critical | unknown | unknown | n/a | Not named by ID in batches read. |
| CLIED-38 | `url-safety.ts` render/click-time scheme gates | critical | unknown | **strong, adjacent** — `context-menu.test.ts`'s "Copy Link" link-scheme-filter check is adjacent to but distinct from CLIED-38 itself (BATCH-09) | n/a | — |

### CLISH — Shell, tabs, panels, settings, theming, dialogs, keyboard

| ID | Behavior | Impact | Unit | Integration/contract | E2E/other | Gap or retained protection |
|---|---|---|---|---|---|---|
| CLISH-01 | Tab reorder drag, snapshot-based geometry | high | **strong**, data functions — `applyReorder`/`reconcileOrder` pure-function coverage (BATCH-11) | unknown, DOM/geometry half | n/a | "This batch covers only the pure data functions... expected for a hooks-and-leaves batch, named so a later batch does not assume it is already covered" (BATCH-11). |
| CLISH-02 | Tab-strip snapshot invalidation (id-set / width / resize) | high | n/a | **strong**, 2 of 3 triggers — id-set (`:526`) and width-only (`:747`) covered; **weak**, 1 of 3 — the `ResizeObserver` trigger has no test (BATCH-07) | n/a | — |
| CLISH-04 | Target-aware save/save-as (`saveExactTarget`) | critical | unknown | unknown | n/a | Not named by ID in batches read. |
| CLISH-05 | Tab context menu re-validates target by Y.Doc identity | high | n/a | **absent** — "no coverage anywhere in this batch — `DocumentTabs.svelte.test.ts` covers pointer-drag and keyboard reorder thoroughly but not the native-menu `runTabAction` re-check path" (BATCH-07) | n/a | — |
| CLISH-08 | Saved-sessions delete/clear-all, two-step arm-then-confirm | critical | unknown | unknown | n/a | Not named by ID in batches read. |
| CLISH-09 / CLISH-24 | Recent-time formatting, two independently-drifting formatters | normal/low(model)/functional-real | n/a | **weak after proposed removal** — see §3, `recent-files.test.ts`/`annotation-card-helpers.test.ts` boundary cases lose coverage | n/a | — |
| CLISH-13 | Settings persistence, read-only short-circuit on newer schema | high | unknown | unknown | n/a | Not named by ID in batches read. |
| CLISH-14 | `useNotifications.svelte.ts` dedupe/coalesce/TTL | normal-high | n/a | **weak** — "only leaf helpers are covered here, not the machinery" (BATCH-11) | n/a | — |
| CLISH-17 | Error boundary, capped in-place recovery then forced reload | critical | unknown | unknown | n/a | Not named by ID in batches read. |
| CLISH-26 | Settings modal read-only mode disables every write control | high | unknown | unknown | n/a | Not named by ID in batches read. |
| CLISH-27 | Settings modal "stranded focus" recovery | high | unknown | unknown | n/a | Not named by ID in batches read. |
| CLISH-29 | License-tab dark-gate-aware status copy | high | unknown | unknown | n/a | Not named by ID in batches read. |
| CLISH-31 | ChatPanel insert author attribution | high | unknown | unknown | n/a | Not named by ID in batches read. |
| CLISH-32 | Chat/annotation Markdown-to-HTML renderer, injection defense | high | n/a | **absent (in this batch)** — "described in the model as 'the entire defense' against injection — no coverage in this batch" (BATCH-11) | n/a | — |
| CLISH-36 | Persisted custom-shortcut blob validation | high | unknown | **strong**, mention-only-file guard — but "a real, disclosed gap against key-aliasing indirection" (BATCH-16) | n/a | Regex-shaped guard, not an AST scan; disclosed gap, not a removal target. |
| CLISH-37 | Cowork firewall/subnet error-copy accuracy | high | n/a | **strong** — `cowork-settings.test.ts`'s ~25-case `firewallErrorHint` family, named historical misdiagnosis bugs #1298/#1371/#1372/#1436/#1438 (BATCH-07) | n/a | — |
| CLISH-40 | Keychain dual-backend, unified error contract | high | unknown | unknown | n/a | Not named by ID in batches read. |
| CLISH-41 | `untagged-write-warning.ts` DEV-only Critical Rule 2 detector | high | unknown | unknown | n/a | Not named by ID in batches read; only two enforcement layers total per CLAUDE.md, so an unverified test here matters more than usual. |

### TOOL — `tandem` CLI, `scripts/`, `.github/workflows`, Rust desktop (critical-impact subset only — see scope note)

| ID | Behavior | Impact | Unit | Integration/contract | E2E/other | Gap or retained protection |
|---|---|---|---|---|---|---|
| TOOL-01 | Channel-shim intent is three-valued, never re-derived | critical | unknown | unknown | n/a | Not confirmed by name in BATCH-12/13 gap sections (setup.ts territory largely `uncertain`/unresolved per BATCH-12). |
| TOOL-07 / TOOL-08 / TOOL-09 / TOOL-14 | mcp-stdio bridge: never-exit, reconnect-replay, side-effect-free replay gating, deadline-bounds-the-send | critical | unknown | unknown | n/a | Not named by ID in batches read (mcp-stdio territory not covered by BATCH-12/13's file list as read). |
| TOOL-16 / TOOL-17 / TOOL-18 / TOOL-19 / TOOL-20 / TOOL-21 | `doctor.ts` diagnostics: crash-isolation, secret-redaction, raw-input UNC screening (×2), URL-non-interpolation, `tauri.localhost` exclusion | critical | **partially strong** — `doctor.test.ts:2754-2869`'s port-resolution slice is `uncertain`/not fully re-verified (BATCH-12); the rest of `doctor.test.ts` not individually confirmed by ID | unknown | n/a | BATCH-12 explicitly flags `doctor.test.ts` port-helper as unresolved rather than verified. |
| TOOL-26 | Annotation-store scan `unreadableActive` degrade | critical | unknown | unknown | n/a | — |
| TOOL-32 / TOOL-33 | Node-version floor gates CLI; stdio suppresses update-notifier | critical | unknown | unknown | n/a | — |
| TOOL-37 | Uninstall-scrub Windows path safety, 5-step chain | critical | unknown | unknown | n/a | — |
| TOOL-41 | Rotate-token atomic write → POST → 3-way outcome | critical | n/a | **strong** — `rotate-token.test.ts` extensively covers rollback/403-message paths (BATCH-12); the one removed row (`fingerprint()` local reimplementation) "loses nothing — it never protected the function it names" | n/a | — |
| TOOL-45 | `claudeDesktopConfigTarget` Windows override precedence | critical | unknown | unknown | n/a | — |
| TOOL-51 | `rejectUnsafeWindowsPrefix` mixed-separator normalization | critical | unknown | unknown | n/a | Shared implementation across TOOL-17/18/19/37; no batch confirms it by name. |
| TOOL-54 | `sanitizeAnnotation` — the entire ADR-027 data-layer boundary | critical | unknown | **strong, indirect** — exercised as setup/oracle throughout the annotation-lifecycle test files (BATCH-03/05), never isolated by ID | n/a | — |
| TOOL-56 | `sanitizeImageSrc` allowlist (XSS) | critical | unknown | unknown | n/a | — |
| TOOL-57 | Origin-tag helper choice (duplicate framing of SRVDOC-01) | critical | unknown | unknown | n/a | Same absence as SRVDOC-01. |
| TOOL-58 | `snapshotContradicts` asymmetric fail-closed (#1631) | critical | unknown | unknown | n/a | — |
| TOOL-60 / TOOL-61 / TOOL-62 | `flattenHeadingText` CRLF→2-spaces; `flatOffsetToRelPos` sole mint; `anchorFlatRange` all-or-nothing | critical | unknown | unknown | n/a | Coordinate-system primitives; not confirmed by ID in batches read (likely covered by `positions.test.ts`/`plaintext-flatten.test.ts`, neither fully audited by ID here). |
| TOOL-63 | `isWakeWorthy`, shared by 4 wake consumers | critical | unknown | **strong, partial** — the supervisor/SSE/wake-socket consumers are each independently well-tested (server-launcher.md, BATCH-15); cross-consumer agreement itself not confirmed as a single test | n/a | — |
| TOOL-65 | `sse-consumer.ts` infinite retry, no `process.exit` | critical | unknown | unknown | n/a | — |
| TOOL-77 / TOOL-78 | Node-sidecar version pin / cached-binary acceptance | critical | unknown | unknown | n/a | Model itself flags TOOL-77's hash correctness as having "zero self-verification... no automated oracle anywhere in the repo." |
| TOOL-82 / TOOL-83 | Coverage floors are deletion-blind / coverage job is advisory | critical | n/a | **strong, by design** — `coverage-gate.mjs` unit tests + `tests/scripts/coverage-gate-wiring.test.ts` (BATCH-14, one sub-row removed as redundant) | n/a | Advisory-by-ADR-051-pattern; the wiring test inside `check` is the real gate, per CLAUDE.md. |
| TOOL-87 | `windows-acl-proof.mjs` per-describe assertion | critical | unknown | unknown | **delivery-relevant** — see §4 | — |
| TOOL-88 | `run_acceptance_tests.py` 6-branch refusal chain | critical | unknown | unknown | n/a | — |
| TOOL-94 / TOOL-95 | `e2e-guard.ts` foreign-server probe / served-client harness check | critical | unknown | unknown | n/a | — |
| TOOL-97 | `test-ports.ts` reserved constants | critical | unknown | unknown | n/a | — |
| TOOL-101 / TOOL-102 / TOOL-103 | Licensing key generation / signing / entitlement write | critical | unknown | unknown | n/a | Model flags `canonicalize()` as "the one open crypto question in this area," audited by no pass — same gap the model itself declares. |
| TOOL-105 / TOOL-107 | `ci.yml` `check` job / acceptance-harness step | critical | n/a | n/a | **strong, by design** — `tests/scripts/acceptance-harness-wiring.test.ts` (CLAUDE.md Status section) | — |
| TOOL-112 / TOOL-113 | `publish.yml` tag-pinned checkout / no pre-publish verification | critical | n/a | n/a | **weak, historical** — v0.25.0 hit exactly the TOOL-112 defeat condition per MEMORY | Structural risk, not closed by a test. |
| TOOL-116 / TOOL-117 | `tauri-release.yml` Apple-signing validation / `verify-release-manifest` | critical | n/a | n/a | unknown | Not exercised by any CI leg reachable from a PR (release-only trigger). |
| TOOL-120 | `tauri-webdriver.yml` — the one honestly-documented null gate | critical | n/a | n/a | **absent, by design** — `workflow_dispatch`-only, currently inert | Self-disclosed by the model, not a suite gap. |
| TOOL-121–200 (Rust desktop, ~40 remaining critical entries: plugin order, window visibility, launcher-deferred latch, updater endpoint, sidecar spawn/restart, firewall/Cowork path-safety chain, keychain, system-paths, theme) | various | critical | unknown (not individually re-verified) | unknown | n/a | `cargo test` runs on the pre-push hook (maintainer's machine) and in the 3-OS `rust-test` CI matrix per CLAUDE.md; individual row-level confirmation against `src-tauri/tests/` was out of this pass's time budget — carried as `unknown`, not `absent`. |

---

## 2. Headline gap list — critical/high impact, weak or absent at every layer

Ordered by how destructive the failure would be, then impact.

1. **SRVDOC-70** — ADR-027 write guards (`transitionPending`, `removeForClaude`) carry no Solo-mode
   check. A write path that knows an annotation's id can act on a record the read filter withholds.
   Confirmed absent independently by **5 batches** (01, 03, 04, 05, 14) — the strongest corroboration
   in this audit. The model itself flags this as an open, unresolved question.
2. **SRVDOC-57 / SRVDOC-58 / SRVDOC-59 / SRVDOC-60 / SRVDOC-64 / SRVAPI-33** — the actual ADR-027
   edit/resolve/remove *guard predicates* (`isPrivateForClaude`, `isWithheldFromClaude`) are never
   directly exercised by any dedicated test file checked (`edit-annotation.test.ts`,
   `resolve-annotation.test.ts`, `remove-annotation.test.ts`, `replies-privacy.test.ts` all confirmed
   by direct read). What exists instead is coverage of the *unguarded* producers and the *importer
   pins* — real but adjacent properties, not the guard itself. This is the second-most-corroborated
   absence (BATCH-03 and BATCH-05 independently).
3. **SRVDOC-66** — `channelVisibleReplies` (pull side, `tandem_getAnnotations`/`tandem_checkInbox`)
   applies no author check while `narrowReplyForChannel` (push side) does. Push side is well-tested;
   pull side is confirmed untested by **3 independent batches** (03, 05, 15). A Claude session can
   currently read its own or an import's replies back through the pull path with no test that would
   catch a regression either direction. Also a model-flagged open finding.
4. **SRVDOC-27** — autosave per-document failure isolation (#1750). Explicitly flagged in-table as a
   gap by the audit itself: "`autoSaveAllToDisk`'s tests all use a failure-free happy path per
   document; none simulates one document's save throwing mid-tick." Direct data-loss vector, critical
   impact, zero test.
5. **SRVDOC-12** — `clearAndReload`'s unconditional `fs.unlink` of the durable annotation envelope on
   `force:true` open (#1813, an explicitly *open policy question* in CLAUDE.md). The Y.Map-level
   clear is tested; the disk-deletion half — which destroys personal notes with no backup coverage —
   is asserted nowhere across the 44 files audited for it.
6. **SRVDOC-05 / SRVDOC-11** — `refreshRange`'s "repaired" branch, which re-anchors a dead relative
   position from stale flat offsets with no snapshot comparison (#1764, an acknowledged open defect).
   Three tests touch adjacent territory but each is disclosed as covering only a byte-neutral or
   either-outcome-accepted case, not a genuinely moved-text scenario. Corroborated in 3 batches.
7. **SRVDOC-67 / SRVAPI-38** — `tandem_checkInbox`'s gate-before-ledger ordering (Solo hold applied
   before the dedup ledger is written, specifically to avoid poisoning it on a later Tandem-mode
   switch). No test constructs the Solo scenario needed to observe this.
8. **SRVAPI-75** — `keychain.ts`'s "throws are not memoized" self-healing property has zero direct
   coverage; every test bypasses the memoize path via dependency injection.
9. **SRVAPI-72** — `install-claude-cli.ts`'s `MAX_SCRIPT_BYTES` cap and `FETCH_TIMEOUT_MS` stall
   timeout (both model-critical, protecting against a hung or oversized download of an externally
   fetched, then-executed script) have no test anywhere in `install-claude-cli.test.ts`.
10. **SRVDOC-51** — nested-list `tandem_edit` write path has zero real-handler coverage; the harness
    that would exercise it structurally cannot reach nested containers.
11. **CLIED-10** — Hocuspocus provider bootstrap / per-tab lifecycle / stale-tab restart recovery
    (critical, "THE client sync mechanism" per the model). Only one leaf helper is tested in the batch
    that owns this file; generation-id auth rejection, epoch-gating, and rebuild-vs-reconnect are
    unreached.
12. **CLISH-05** — tab context-menu re-validation by Y.Doc identity (protects against a stale-menu
    action acting on the wrong document after a fast close/reopen race). No coverage anywhere in the
    batch that owns `DocumentTabs.svelte.test.ts`.

---

## 3. Protection that would be lost if the audit's proposed removals were applied

Stated plainly per the task brief — no replacement required, visibility is the point. Several
batches disclosed this explicitly rather than glossing over it.

- **`recent-files.test.ts` (`formatWhen`) and `annotation-card-helpers.test.ts`
  (`formatRelativeTime`) minute/hour boundary-transition cases (rollover at 59m→1h, etc.)** — BATCH-10
  states plainly: "has no surviving protection in the retained suite once their literal-string
  assertions are deleted, since nothing else in either file or elsewhere in this batch exercises those
  specific thresholds. This is a real, stated cost of both removals, not a claim that nothing is
  lost." (CLISH-09/24.)
- **`FileOpenDialog.test.ts:157`'s drop-hint test** — BATCH-08: removal "drops the only coverage of
  the 'drop-anywhere hint shows only in Tauri runtime' branch — no other test in the batch exercises
  `isTauriRuntime()`-gating of that specific hint." Disclosed as real but low-impact (cosmetic
  onboarding hint).
- **`settings-push-routes.test.ts:276,280,286`** — BATCH-09: removal "leaves the reduced-motion
  transition-suppression behavior of `PushRoutesInfo.svelte`'s copy button... without any test
  coverage in this batch," and no cheaper-and-correct replacement was found (jsdom/happy-dom cannot
  evaluate `@media` queries).
- **`search-worker.test.ts:279`'s `DEFAULT_DEADLINE_MS`/`DEFAULT_HARD_TIMEOUT_MS` constant pin
  (1800/2000ms)** — BATCH-04: proposed for removal (matches the config-echo removal pattern), but
  "removing it loses exact protection of [these constants] specifically; the timing tests above it
  only loosely bound these values."
- **`tests/server/integrations/backup.test.ts:191-207`'s symlink-exclusion test** — BATCH-13: the
  test calls the wrong boundary (a raw `fs.promises.open`, not `writeBackup` itself) and is proposed
  for removal, but "lost on removal: the only direct test of `writeBackup`'s own symlink-exclusion
  safety" — a suggested replacement (inject the UUID suffix) is offered but not authored.
- **`tests/server/integrations/storage.test.ts:361-379`'s per-file-ACL TOCTOU regression guard** —
  BATCH-13/14: a fragile source-text regex, proposed for removal, but "lost on removal: the only test
  that would catch a REINTRODUCED per-file ACL call under the exact current spelling."
- **`tests/channel/reply-abort.test.ts`** (whole file) — BATCH-12: tests a hand-copied reproduction
  of the real catch/retry handler rather than the handler itself, proposed `consolidate`, but
  "removing it loses the only place in the suite that exercises the *composition* of `fetchWithTimeout`
  + a JSON-body-read timeout + the isError-shaped MCP response... against the real `run.ts` handler."
- **`tests/server/launcher/api-routes.test.ts`'s "429s while a relaunch is in flight" test** —
  server-launcher.md: the fixture makes the 429 branch unreachable, so nothing is actually lost by
  removing it, but the audit separately notes a **currently-untested** case that removal makes
  explicit rather than creates: "a replayed nonce against `/start` while the supervisor is still null
  is rejected" has no test before or after.
- **`integration.test.ts`'s 3 cases (server-documents territory)** — BATCH-03: if removed without a
  replacement, this is "this batch's only coverage of a cross-element-span edit going through the
  composed primitives... as opposed to each individually." Whether a real handler-level replacement
  exists elsewhere in the suite is `unresolved`.
- **`CoworkAdminDeclinedModal`'s combined visibility rule** (`uacDeclined && !adminPopupDismissed()`)
  — BATCH-11: removing `cowork-admin-declined-modal.test.ts`'s 4 reimplementation-only cases leaves
  the `adminPopupDismissed()` half covered elsewhere for real, "but after removal the **conjunction**
  has no coverage against the real component... the one place in this batch where a removal genuinely
  thins live cover."
- **`ToolbarButton`'s real `titleAttr` derivation and `createReviewCompletion`'s real reactive
  wiring** — BATCH-11: both removals ("test never touches the subject") make an existing, uncovered
  gap honest rather than creating a new one — stated for completeness, not a net loss.

---

## 3b. Modeled behaviors no batch mapped a test to

Distinguishing "declared unmodeled by the model" (not a coverage claim) from "modeled but genuinely
no test found."

**Modeled, and no batch names a supporting test (genuine coverage-claim gaps):**
- SRVDOC-18 (annotation store disabled after 3 write failures) — explicit "no test anywhere in this
  batch," no other batch names it either.
- SRVDOC-27 (autosave per-doc failure isolation) — same, explicit in-table gap note.
- SRVDOC-57/58/59/60/64 and SRVAPI-33 (ADR-027 edit/resolve/remove guard predicates) — explicit,
  corroborated across multiple batches.
- SRVDOC-66 pull side / SRVDOC-67 / SRVAPI-38 (gate-before-ledger, reply-gate asymmetry) — explicit.
- SRVAPI-72 (`install-claude-cli.ts` byte-cap/timeout), SRVAPI-75 (`keychain.ts` throw-memoization).
- CLISH-05 (tab context-menu Y.Doc re-validation), CLISH-32 (`chat-markdown.ts` injection defense, in
  the batch that owns adjacent files).

**Declared unmodeled by `project-model.md` itself, but the audit found real, high-quality test
coverage anyway** (not a gap — the model's scope note, not a test-quality problem):
- `docx-comment-export.ts`'s ADR-027 export gate, `docx-lost-features.ts`'s silent-loss detector
  (BATCH-02) — "both are load-bearing... and both are thoroughly protected... a downstream reader
  should not read 'unknown' as 'unprotected' for these two."
- The stale-binary-repair family (`refreshMcpEntryBinary` et al.) and channel-shim-decision family
  (`resolveChannelShimIntent`/`applyConfigWithToken`), both declared model gaps in
  `server-mcp-api.md` — BATCH-14: "extensively and well tested... a gap in the model's declared
  scope, not in the suite's actual protection."
- `sentry.ts`'s `scrub()`, `sessions.ts` (LAN-disclosure basename scrub, #1121 F5),
  `search-worker.ts`/`typing-presence.ts`/`wake-advisory.ts`/`tutorial-annotations.ts` (BATCH-05) —
  all unmodeled, all found to carry real, sometimes security-relevant, well-tested behavior.
- `useTauriTheme.svelte.ts`, `CoworkSettings.svelte`, `IntegrationTargetCard.svelte`/
  `integration-target-card-reason.ts` (credential redaction, #1422), `useDocumentWorkspace.svelte.ts`
  (ADR-035 Unit 10a, source-view dirty lifecycle + stale-ydoc save-target guard, same risk class as
  critical CLISH-04) — BATCH-07/09/10: all unmodeled, all carrying dense, regression-motivated
  coverage the model simply never reached.
- `structural-snapshot-undo.test.ts`'s subject (`undoResolveAnnotation`, `textSnapshotBreaks`) sits
  on the #1486/#1631 document-corruption lineage with no CLIED entry (BATCH-08).
- Status surfaces (`aiIndicatorView`, `cwdDriftPill`, `StatusBar`) — BATCH-10: no CLISH entry despite
  three named previously-shipped defects (#1268, #1287, #1282).

**Genuinely unresolved rather than either bucket:**
- SRVAPI-52 (bundled-skill auto-refresh extraction-defeat resistance) — BATCH-04 explicitly declined
  to guess ("not confirmed this pass"); carried here as `unknown`, not as a coverage claim either way.

---

## 4. Delivery gaps — protection that exists but doesn't run where it matters

Per the CI facts: `check` (the only vitest job, and the one required status check) is ubuntu-only;
`windows-acl-proof` runs exactly two named describes; every other `runIf(win32)`/`skipIf(!WIN_ONLY)`
spec runs only on the maintainer's Windows box via the pre-push hook; every `runIf(POSIX)` spec never
runs there.

- **SRVDOC-09's macOS re-arm path** — `file-watcher.test.ts` stubs only `"linux"` and `"win32"`; there
  is no `"darwin"` case. This is a *test* gap (BATCH-02), not purely a delivery gap, but it compounds
  one: even if a `"darwin"` case existed, no CI leg runs on macOS at all (`rust-test`'s 3-OS matrix
  covers Rust, not this file), so a macOS-specific regression here has no path to being caught
  anywhere short of the release smoke checklist (per CLAUDE.md's own §1/#1596 tracking).
- **`file-watcher-real-fs.test.ts` and `platform.test.ts`'s Windows-gated sub-cases** (BATCH-04) —
  "run in CI nowhere (ubuntu-only `check`, not on the `windows-acl-proof` allowlist) — delivery gaps,
  not test defects."
- **`startup-open-failure-wiring-claims.test.ts:109`'s macOS Apple-Event row** (BATCH-13) — "protects
  code compiled by macOS CI but executed by no CI leg anywhere."
- **`tauri-release.yml`'s TOOL-116/117/118/119** (Apple-signing validation, `verify-release-manifest`,
  `release-check`, Linux package verification) — release-tag-only trigger (`release: published`), so
  no PR-time CI reaches any of it; CLAUDE.md's own #1745/#1746 register names this "fixed but
  unverified" for the same structural reason.
- **TOOL-120, `tauri-webdriver.yml`** — `workflow_dispatch`-only, currently inert by design; the
  model's own "one honestly-documented null gate."
- **§1 Windows smoke** (release-checklist territory, not a `tests/` file) has gone four releases
  unrun per MEMORY/CLAUDE.md (#1596) — orthogonal to unit/integration coverage but relevant to any
  behavior whose *only* real protection is a manual Windows pass (e.g., the #1118 post-update banner
  false-positive).
- **The entire `tests/design-system-impl/*` (15 files, 80 cases) and CSS-pipeline-contract territory**
  run only in the ubuntu `check` job; no cross-browser or Windows-rendering leg exists for any of it
  (BATCH-15).
- **`scripts/check-semantic-tokens.ts`'s actual pre-commit wiring** (BATCH-12) — "runs in
  lint-staged pre-commit only — never in CI... a developer who commits with a skipped-hooks flag ships
  a raw-hex regression that nothing in CI catches." The scanner's own logic is well-unit-tested; the
  wiring that would make it a gate on every commit is not itself verified anywhere.
- **`storage.test.ts`'s EXDEV cross-device-rename fallback branch in `atomicWrite`** (BATCH-13) — "no
  re-hardening test in CI (honestly disclosed as untestable in this environment by the existing
  test's own comment)."
- **`#827` POSIX-only path-widening/symlink-guard tests** (`document-service.test.ts`, BATCH-01) — a
  positive delivery note, not a gap: these `skipIf(win32)` specs *do* run in the required `check` job
  (ubuntu), so despite being platform-gated they are not one of the maintainer's-machine-only cases;
  they are skipped only on the Windows pre-push leg, where a distinct UNC-specific test (not platform
  gated) covers the Windows-specific policy instead.
