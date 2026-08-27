# AI-assisted maintainability review and remediation plan

**Date:** 2026-08-24

**Status:** Proposed; architecture review complete, implementation not started

**Reviewed snapshot:** `bb39320` (`master`)

**Primary audience:** Claude Code and human reviewers

**Plan review:** Two adversarial architecture reviews completed on 2026-08-24.
The reviews corrected the dependency order, split unsafe bundles, tightened the
configuration-lock transaction boundary, and checked the written work units for
independent executability.

**Independent verification:** Every finding below was re-checked against
`master` on 2026-08-24 by four parallel agents given the *question* to test, not
a candidate answer, plus direct reads. All ten findings survived. Five unit
scopes were corrected and four gaps were added; see
[Verification record](#verification-record-2026-08-24).

This document records a code-grounded architecture and maintainability review
of Tandem, with particular attention to autonomous AI development. It is the
execution handoff for the remaining work. It supplements the historical
`docs/superpowers/plans/2026-05-15-adr-031-037-implementation.md` plan and
supersedes only that plan's sequencing for the incomplete ADR-033, ADR-034, and
ADR-035 work.

## Claude Code execution contract

Do not implement this document as one change.

1. Re-read `CLAUDE.md`, `AGENTS.md`, the referenced ADR, and the current code
   before starting each work unit. File references below describe snapshot
   `bb39320`; they are not a substitute for checking the current branch.
2. Use one branch and one PR per numbered work unit unless a unit explicitly
   defines smaller PRs. Keep commits conventional and scoped.
3. Preserve unrelated working-tree changes.
4. Add characterization tests before moving load-bearing behavior.
5. Run the focused tests after each commit and the stated verification set
   before requesting review.
6. Have an independent agent test the review question named in each work unit.
   Give the reviewer the question to investigate, not a proposed answer.
7. Update the implementation-status table in this document as the **final
   commit of the unit's own PR**, recording the PR number, tests run, and any
   deliberate divergence from the plan. Not on merge, and not the merge commit:
   the table is the resume point for a stopped run, so a merged unit still
   reading `Not started` makes a resuming session re-run it — and a commit
   cannot record its own SHA anyway. The PR number is known at `gh pr create`
   time and the merge commit is recoverable from the PR.

   **Two states, because a commit cannot know it will be merged.** The unit's
   own PR writes `In review` with its PR number; the *next* unit's PR flips
   that row to `Merged` after confirming it actually landed. Writing `Merged`
   from inside the open PR is a prediction, and it fails in the one direction
   that matters: if the PR is closed or its head rewritten, a resuming session
   reads `Merged`, skips the unit, and the work is silently absent — exactly
   what this item exists to prevent.
8. Treat code examples as shape illustrations, not paste-ready implementations.
   Current types and platform behavior remain authoritative.

## Implementation status

| Unit | Concern | Status | PR / evidence |
|---|---|---|---|
| 0 | Repo hygiene: ignore `.codex/`; unblock `audit:dead-code` | Merged | #1601; 15/15 CI green |
| 1 | Doctor Windows path-safety closure | Merged | #1608 (merged 2026-08-25); tsc clean, 9085/0 vitest, cargo green, CI green. 3x `/code-review high` (13 findings) + 6-agent `review-pr` (14 findings); all real, all fixed |
| 2 | Test + `src/cli` TypeScript gate | Merged | #1616; 895 test-only type errors -> 0 across three configs. typecheck:tests, typecheck, 557 files / 9103 vitest green; all 15 CI checks green. Gate hardened after adversarial review (10 findings, 16 named mutations). Five review agents then found a mutation guard this branch had DISARMED (`event-queue.test.ts` fed the delivery-state check the same subscriber count the wiring under test manipulates), eight false explanatory comments, four latent annotation fixtures the gate structurally cannot see, and a CodeQL ReDoS whose fix exposed a bare-`echo` hole in the guard's own tsc matcher. All addressed and mutation-proved. Out-of-scope findings filed: #1612 #1613 #1614 #1615 |
| 3 | Honest coverage baseline | Merged | #1617 (merged 2026-08-26); all 16 CI checks green. the node project (324 of 557 test files) was collecting ZERO V8 coverage while exiting 0 -- a negated glob in `test.include` selects files correctly and instruments none of them. Also fixed: coverage declared per-project is silently discarded (`TestProject._configureServer` overwrites it), and all 101 `.svelte` files were absent from the report rather than at 0%. Baseline: statements 68.39% (23214/33939), lines 70.11%, branches 64.65%, functions 63.8%; 351/351 `.ts`, 57/57 `.svelte.ts`, 101/101 `.svelte`. **Two review rounds each found the unit's own failure class inside its fix.** Round 1: the anti-partial-run check guarded 3 of 7 top-level `src/` areas -- live, not theoretical, with `src/stdio-bridge/` at 0/3 and `src/channel/` at 2/70 invisible; area list now derived from disk. Round 2: that derived check still required `filesInReport > 0`, so an area ABSENT from the report passed at 0/0 -- deleting every node-project area's entries returned ok:true, i.e. a whole project failing to run published as a successful baseline. Also: the wiring test pinned the script's source TEXT, so the most load-bearing check could be deleted with the suite green; validation is now a pure `buildManifest()` with 22 behavioural tests driving every refusal. 17 mutations proved across both rounds. Two false comment claims corrected (instrumentation adds 10-30%, not 'roughly doubles'). Bundled: a docx-apply timeout flake, root-caused by per-test duration (1977ms against a 15s ceiling), not the two explanations I reached for first. 559/559 files, 9136 vitest green; typecheck + typecheck:tests clean; cargo green. **`coverage` is NOT a required status check -- repo setting, flagged for Bryan** |
| 4 | Config-race acceptance: track, bound, document | Merged | #1618 (merged as `ab71d07`); accepted 2026-08-24, tracked as #1599. No behavior change in `apply.ts` (the one source edit is a docblock). `docs/security.md` gains an **Accepted (bounded)** section rather than an ACCEPTED prefix inside the open list — that list states its own convention that a reader scanning for what is still open must not have to parse a prefix, and `Closed since` entries all narrate a real code change. **The bound is corrected in two ways review found.** Rotation fails closed; uninstall does not, and nothing in the scrub revokes the auth token, so a resurrected entry carries a LIVE credential — and the standing “they could have written the config anyway” argument does not cover undoing a deletion by timing. **The bound gained a THIRD case in review — first install is silent, permanent and reported as success**, because `applyConfig` reads once and `repairEntryInPlace` returns no-op for an absent entry, so nothing recreates a dropped install; my own first draft and #1599's body both wrongly said everything outside the credential cases recomputes, and both are corrected. **The guard test was defeated FOUR ways across two review rounds and all four are closed:** a bare `writeFile` the idiom regex did not know, a writer file outside the two scan roots, a `.mts` file INSIDE a scan root, and a `.mjs` file ANYWHERE under `src/` — invisible to all four surfaces at once, because the extension sweep only covered the scan roots while the extension list also gated the repo-wide walk. Every defeat was a scope that looked total and was not; that pattern is now named in the test's header. It now pins four surfaces: per-file call-site COUNTS in the scan roots, the extensions actually present on disk, the repo-wide durable-writer FILE set, and repo-wide access to the config-path and token-file resources. The scan scope the plan specified would have been structurally blind to `src/server/auth/token-store.ts`, where the invariant the whole acceptance rests on lives; that half scans all of `src/` deliberately. 15 mutations proved across three batteries, including all four prior bypasses and a fifth idiom closed pre-emptively. Two wrong line citations corrected against source. typecheck + typecheck:tests clean |
| 5 | Complete ADR-033 registry lifecycle | Merged | PR #1640 (merged 2026-08-26). `src/server/yjs/lifecycle.ts` exports the named `HocuspocusLifecycle`, replacing all four free callback slots, and `bootstrap/hocuspocus-lifecycle.ts` is the composition root that assembles it from the three modules that own its parts — the registry does NOT implement the interface, because satisfying that shape would pull the event queue into its import graph. **Four documented divergences from the ADR sketch**, each a decision: a fourth member `expectedGenerationToken()` (a **method**, non-optional — a captured `string | null` field would freeze at `null` at the composition root and fail-close every connection for the whole run, logging the same line as a legitimate stale-tab rejection); five mutators rather than three; `getYDoc`/`eachOpen` not added. The registry now owns `broadcastOpenDocs`, and its whole mutating surface ends in exactly one broadcast. **The plan's "collapse the open paths into `openDocument`" would have moved the broadcast EARLIER than the code it replaced** — the five open paths do real setup (doc meta, saved baseline, annotation store) between the registry write and the publish — so `openDocumentWhenReady(entry, prepare)` takes that work instead. Save-As and rename could not keep their broadcast where it sat either: `markClean` reads the entry's `source` via `isDirtyMirrorEligible`, so a stale `"upload"` would silently suppress the dirty mirror for a now-real file. **Full privacy was not reachable** — 34 test files legitimately arrange registry state without a broadcast — so the primitives are `unsafe*`-prefixed behind `registry-testing.ts` with a CI-enforced containment guard, rather than a 34-file behavioural rewrite. **Review found four real defects, two of them in this branch's own guards.** The Save-As and rename publishes HAD moved earlier: Save-As published `source: "file"` (which gates the rename affordance) while the annotation store and channel observers were still wired for an upload doc, and rename published across a real `fs.stat` before the document's own `fileName` agreed — both now deferred through `updateDocumentWhenReady`, whose broadcast is in a `finally` unlike the open variant, because an update's entry is already on screen and skipping would make a transient inconsistency permanent. `maybeOpenStartupFile` re-activated the doc `openFileByPath` had just activated, advancing the epoch twice for one gesture — redundant before ADR-033 too, and the comment I wrote claiming otherwise was wrong. **Both guards were defeatable by RENAMING, not by evading their logic**: the containment sweep's vocabulary is fixed and `registry.ts` is necessarily exempt from it, so a new export there handed out the same capability under an unheard-of name (now an exact export-set pin); and the bind-site scan matched call TEXT, so an aliased third call site contributed nothing to it (now derived from the import binding, with exactly one binding asserted — `{ startHocuspocus, startHocuspocus as bindWs }` is legal ES). Also moved `installTandemLifecycle()` ahead of the session restore: until it runs the dirty-mirror predicate is unset and `dirty.ts` mirrors everything. **Two reviewers disagreed on the Save-As window and both were right** — different axes, settled at the source rather than averaged. **A second review round found a real flaw in the first round's fix.** The `finally` I added was right for rename and wrong for Save-As — a throw in `attachObservers` published `source: "file"` on a document whose observers were still upload-mode, so annotations stayed suppressed from Claude with no later broadcast to correct it; against **master** that sequence's broadcast was its last statement, so it was a regression against the baseline rather than against the previous commit. The helper now skips on a throw like its open sibling, and rename catches inside its own prepare — the decision at the site that owns it, not a flag. Rename's `fs.stat` moved back above the registry write (no `await` in the prepare at all), which also returned it from a nested closure to a plain statement and cleared **a new high-severity CodeQL `js/path-injection` alert** — the same false positive dismissed under #1042, re-raised because the move broke its fingerprint. **The rename case is now driven through `renameDocument` itself**, failure injected at the one write only its prepare performs: a mutation proved the hand-built callback of the same shape could not see the catch being removed. 34 mutations across five batteries (12 characterization, 12 ownership, B5/B6 bind ordering, 7 guard, 3 failure-path); two ownership survivors and one failure-path survivor closed by tests for properties the prose claimed and nothing asserted. 259 files / 4210 vitest green; typecheck + typecheck:tests clean |
| 6 | Characterize and redirect file-open Interface | In review | PR #1642. **Characterization first, production second, in that commit order** — the suite (`tests/server/adr-034-open-characterization.test.ts`, 26 tests) was written before anything moved, and every case in it exists because the existing suite is structurally blind to that property: broadcast count (a wrapper that helpfully calls `activateDocument` passes every prior test while advancing `activeDocEpoch` twice, which the client reads as a focus event overriding a tab switch the user made in between), populate-before-wire, the saved-at baseline VALUE (mtime vs wall clock, which drives autosave's external-modification guard), error-code identity, scratchpad's `adapter.apply` bypass, success-path warnings, and session restore at its current dynamic-import call path. **Every disk, upload and scratchpad caller in `src/` now imports `documents/open.ts`**; restore deliberately does not, because `openFromRestore` is 7a's and a static redirect would re-form the cycle its dynamic import exists to break. `mcp/document.ts`'s duplicate re-export of the same three entries is **deleted** rather than carried to 7c — zero consumers in src, tests and scripts. The seam's header claimed two false things and both are corrected: upload content is not "never written back" (Save-As promotes it), and `openScratchpad()` does not open "an empty" buffer (optional content since #979). **The seam test's three `openFromDisk === openFileByPath` assertions are gone** — true of a re-export and of nothing else, so green through every behavioural break and red on exactly the 7a move they sit in front of. **A real defect was found, filed as #1641 and deliberately NOT fixed**: `reloadFromDisk` returns false on a skipped reload and the file-watcher caller discards it, reporting a reload that did not happen; Unit 6 is behaviour-preserving, so it is pinned as current behaviour and 7b owns the fix. **Review defeated both new guards, and neither by out-thinking its matching logic.** The redirect invariant matched two import *shapes*, so `import * as fo`, `export { openFileByPath } from …` (the exact line this PR deletes), a bare `(await import(…)).openFileByPath` and a multi-line destructure all passed — it now keys on which files name the legacy specifier at all, with a written-down five-module exception list and a symbol layer over it. Half its old matcher was additionally unfalsifiable, since the only expected offender is a dynamic import. The startup guard compared textual positions while the invariant is about execution order: a helper defined above `main()` and called after the bind passed everything, and extracting index.ts's two version-check opens into a helper is exactly that refactor — every open must now sit directly in `main()`'s body. The #1641 pin asserted two toasts and nothing else, which two REAL reloads also satisfy, so it now measures the reload count against a single-callback baseline. Four uncharacterized failures added: `FILE_TOO_LARGE` from both gates, `INVALID_SOURCE`, and OS errno passthrough (EBUSY/EPERM are the "Microsoft Word has it open" 423 and nothing asserted them). The characterization suite now calls through the seam, because importing from `file-opener.ts` would have forced an edit at 7a and voided its own claim to be evidence. **26 mutations proved across three batteries**, each refusing to start from a dirty tree and re-checking green after restoring; two survivors closed (a destructuring-rename evasion, and one mutant that turned out unreachable and was replaced). 572 files / 9346 vitest green; typecheck + typecheck:tests clean |
| 7a | Move ADR-034 pipeline ownership | Not started | — |
| 7b | Migrate ADR-034 failure/result contract | Not started | — |
| 7c | Delete ADR-034 compatibility module | Not started | — |
| 8a | ADR-035 `ChannelEligible` brand (`narrowForChannel`) | Merged | #1620 (merged as `3a8f9cb`). **The plan's "larger half" (retype `queue.ts`'s `pushEvent`) is not implementable and was dropped**: annotation payloads are flat primitives, never `Annotation` objects, so there is nothing to brand; `emitModeReleaseWake` legitimately hand-builds one; and branding the payload type would tax nine unrelated test files. Brand sits at the projection boundary; the hand-built path is covered by a source-derived guard plus one named escape. Predicate is `audience === "outbound" && type !== "note"`, not ADR-035's literal `type === "comment"`; ADR-035 amended rather than diverged from. **A privacy hole was found by this branch's own test**: `sanitizeAnnotation` does not reject an unrecognized type — `sanitize.ts:213-215` coerces it to `comment`, and since `derivedAudience` keys off the type the record no longer has, that comment derives `outbound`. So `sanitizeAnnotation({})` returned a PROJECTABLE record and a note that lost its type field would have projected its content; `type !== "note"` was a denylist and the coercion composed what survived it. Now refuses on sanitize's own `unknown-type` signal. **Five deltas, not the three measured** — review found three the characterization suite was not written to catch (including one in the EMITTING direction, and a master bug where promoting a legacy `flag` emitted nothing at all) and WITHDREW one it had: the tutorial-highlight delta was accepted until review noted `isReviewTarget` is `author !== "user"`, so the seed is in the review queue and the delta was silently dropping a first-run user's Dismiss. Fixed at the seed (`audience: "outbound"`, as `createAnnotation` always stamped) — gate unmoved, delta gone rather than accepted. **Six review agents; four substantive findings.** The brand was FORGEABLE via `Exclude<keyof ChannelEligible, keyof Annotation>` — a `unique symbol` is private as a value but the type is exported, and `Parameters<typeof createdPayload>[0]` recovers it too; verified by compiling, now a `declare class` with a private member and both forges are `@ts-expect-error` assertions. Refusal reporting was EXACTLY INVERTED (the only reason logged was the one that cannot fire; `unknown-type` and `private` were discarded and three redaction-safe formatters had no caller), and `replies.ts` passed no `onRefused` at all. `reply.private === true` failed OPEN on a non-boolean. A test comment claimed to exercise the `annotationId` guard and could not reach it. **The guard was defeated four more times** — twice by its own mutation battery (`toContain` beaten by a LONGER rename) and twice by review (`[a-z]+` missing a camelCase event name; a new observer using const indirection). Closed with word boundaries and a fourth surface keyed on REGISTRATION rather than text shape. 16 mutations across three batteries, all biting. Out of scope, filed: **#1619** (the audience fix is push-only; `tandem_checkInbox`, which CLAUDE.md makes authoritative, still gates on type alone). 563 files / 9214 vitest green (clean run, exit 0 read directly not through a pipe); typecheck + typecheck:tests clean. **Merge policy changed 2026-08-26**: the gate is `/simplify` + `/pr-review-toolkit:review-pr`, no `/code-review high`. Both ran on this branch — the earlier note here saying the gate was unmet is void |
| 8b | ADR-035 create lifecycle | Not started | — |
| 8c | ADR-035 edit lifecycle | Not started | — |
| 8d | ADR-035 resolve lifecycle | Not started | — |
| 8e | ADR-035 remove lifecycle | Not started | — |
| 8f | ADR-035 replies and projection | Not started | — |
| 8g | ADR-035 note promotion | Not started | — |
| 8h | ADR-035 imported-note creation | Not started | — |
| 8i | ADR-035 tombstone: verify, pin, fix stale ADR text | Not started | — |
| 8j | Collapse the shallow DocumentStore | Not started | — |
| 9 | Replace global client action wiring | Not started | — |
| 10a | Extract client document workspace | Not started | — |
| 10b | Extract client rail-layout workspace | Not started | — |
| 10c | Extract rail content/review coordination | Not started | — |
| 11a | Extract Tauri pending-update marker | Merged | #1630 (merged 2026-08-26); pure move, verified line-by-line with zero lines not found verbatim (`lib.rs` -710/+5). `check_for_update_now` deliberately stayed: its body calls a private crate-root function four unrelated sites use, so moving it would have widened visibility OUTSIDE this cluster. Visibility is `pub(crate)`, not `pub` -- `mod pending_update;` is bare, so nothing is reachable from `src-tauri/tests/*.rs` either way. **The guard was widened to a disk-derived scan of `src-tauri/src`, not re-pointed at a fixed pair** -- a two-file list would have reproduced the same bug one extraction later, so 11b--11f are covered by construction. Widening a scan is where a guard becomes zero-of-zero (#1399), so each derivation step got its own control: a positive control on the walk (>10 files, both named), and the `ROUTED_ELSEWHERE` exemption must now be earned in a file the scan actually reached. **Two holes found by battery and review, not by reading.** A TEST was satisfying the production-routing claim -- `pending_update_tests` calls `surface_pending_update_hint_with(CODE_...)`, so rewriting the real call site to a literal left the file green; that hole PREDATES the extraction. Closed with `#[cfg(test)]` stripping -- which review then showed was itself defeated by text it already scans: `b"{ not json"` is an unbalanced brace in a byte-string literal, so the counter ran off the end, correct today ONLY because that test module is last in the file. The next item appended after it would have vanished from the scan silently. Literals are now skipped and an unbalanced block THROWS rather than truncating. **11 of 11 mutations bite.** `cargo fmt` deliberately not run (repo is not rustfmt-clean; it reformatted 16 untouched files). First full-gate run flaked on `apply-malformed.test.ts`'s parallel-rename race (#1599 area, load-dependent, identical commit green on rerun) -- recorded, not dismissed. `/code-review high` not run -- **merge policy changed mid-programme to /simplify + review-pr**, both of which ran |
| 11b | Extract Tauri context-menu specifications | Merged | PR #1638 (merged 2026-08-26); verbatim move of 822 non-blank lines, 9 differing and all deliberate: seven `pub(crate)` prefixes, plus the `#[allow(dead_code)]` on `has_selection` (false -- four live read sites) and the prefix check becoming a named predicate. **The plan calls 11b the one cluster with no external guard test, and that is confirmed**: a repo-wide search found nothing reading `lib.rs` as text for a context-menu construct. So the move takes something with it that colocation was providing for free -- the `ctx:` prefix separating these ids from the tray's `MENU_*` ids was convention, visible while both id spaces lived in one file, asserted by nothing. `context_menu_id_space_tests` pins both directions over an id set derived by RUNNING every builder across its whole (all-bool) input space, with a positive control on the sweep. **Two holes closed that predate the unit**: deleting a name from `generate_handler!` or repointing `.on_menu_event` compiles clean with all 285 Rust tests green while `invoke()` starts rejecting in the WebView, so `tauri-command-registration-claims.test.ts` derives BOTH sides from source and fails loud on any `invoke()` argument it cannot resolve -- three real call sites pass a module constant, and a blind spot that reports itself is a gap while one that does not is a false pass. **14 of 15 mutations bite.** The survivor is named in the code: `forward_context_menu_event`'s emit is window-scoped so a second window cannot receive another's action, and flattening it to `app.emit(...)` is green everywhere -- reaching it needs a live `AppHandle` and a second window, so it is documented rather than covered by a source-text assertion that would read stronger than it is. **A method fix, because it nearly cost that finding**: an interrupted battery run left a mutation in the tree, the next run's backup adopted it as the baseline, and that row reported BITES when it does not; the harness now refuses to start, and fails after finishing, unless both suites are green. /simplify and review-pr converged on one real defect -- inserting the new predicate between `forward_context_menu_event` and its doc comment silently reassigned the doc to the predicate, since a blank line is what separates `///` blocks. `/code-review high` not run -- **merge policy changed mid-programme to /simplify + review-pr**, both of which ran |
| 11c | Extract Tauri native-theme decisions | Not started | — |
| 11d | Extract Tauri Cowork commands | Not started | — |
| 11e | Extract Tauri sidecar lifecycle | Not started | — |
| 11f | Reduce Tauri startup helpers; retain `lib.rs::run` root | Not started | — |
| 12 | Correct and bound annotation diagnostics | In review | #1625; 561 files / 9204 vitest green, typecheck + typecheck:tests clean. **Sample-versus-scan resolved toward the bounded scan**, and the plan's premise was too generous to the old code: the parse gate was `sampleSchemaVersion === null`, which a FAILED parse also leaves null, so a store of unparseable files already read every file synchronously with no cap -- the unbounded worst case already existed. **A store whose active files were all garbage reported PASS**, because the empty catch discarded its own parse failures while claiming they were counted by a filename filter computed before the loop. Two more the plan did not name: `.json.future` files, parked by a newer Tandem, matched neither filter and were invisible to a downgraded install; and the `!endsWith(".corrupt.json")` clause was dead, since the writer quarantines as `<hash>.json.corrupt.<ts>`. Adversarial review found three real silent failures -- a file vanishing between listing and read was in NO bucket at all (quarantining is itself a `rename`, so the one untraceable failure was the one where the store was handling corruption), `parseAnnotationDoc` was the only fallible step with no per-file containment (a future throwing migration would lose every other file's verdict via `Recorder.check`), and unreadable files carried no reason -- which `doctor --json`, `tandem_diagnostics` and `/api/diagnostics` all need, since none of them sees the loader's stderr. A coverage review then found six behaviour-changing mutations the suite could not see, including both byte-cap production defaults being unverified end-to-end; all closed. **21 mutations, 20 bite.** The survivor is honest and platform-gated: deleting the raw-input screen is invisible on Windows because `win32.join` preserves the prefix, while on posix the four forward-slash spellings collapse and the input screen is the only thing left -- #1529's shape, so the collapse is pinned platform-independently and the discriminating rows are `runIf(!win32)` with CI as their evidence. `redactHomePaths` needed no change: verified against `scrubDeep` rather than its docblock. `/code-review high` not run -- **merge policy changed mid-unit to /simplify + review-pr**, both of which ran |
| 13 | Add targeted coverage gates | Not started | — |

## Executive assessment

Tandem has unusually strong semantic anchors for a solo, AI-built project:
explicit ADRs, documented invariants, origin helpers for Yjs writes, named
constants, tagged outcomes in newer code, and extensive tests. CI spans
TypeScript, Svelte, Rust, E2E, security, and performance concerns. These
qualities make autonomous changes safer because an agent can recover intent
from the repository rather than infer it from implementation details.

The primary weakness is unfinished migration. Several accepted ADRs currently
exist as thin compatibility seams while the real behavior remains in large
legacy modules. An agent must load the new Interface, old Implementation,
compatibility aliases, callers, dynamic-import workarounds, and tests at once.
The largest examples are document registration/opening, annotation lifecycle,
`App.svelte`, and the Tauri runtime. File size alone is not a verdict: several
large format-conversion modules are cohesive, deep, and well tested. The risk is
low Locality and shallow abstraction, not line count by itself.

Regression safety is broad but has important gaps. Tests are not TypeScript
checked, coverage configuration is inactive, some tests verify aliases or
reproduce production logic instead of exercising behavioral boundaries, and a
Windows path-safety invariant is inconsistently applied. No general hot-path
scalability crisis was found. The most concrete performance concern is
synchronous, unbounded diagnostic filesystem work exposed through request-led
diagnostics.

## Review scope and evidence

The review inspected the client, server, CLI, shared code, Tauri shell, tests,
CI, architecture documentation, security documentation, and ADRs relevant to
the findings below.

Snapshot metrics are signals, not targets:

- About 529 TypeScript, Svelte, and Rust source files and 132,000 source lines.
- About 63 source files are at least 500 lines, containing roughly half of the
  source lines.
- Largest reasoning boundaries include `src-tauri/src/lib.rs` (~9,300 lines),
  `src/client/App.svelte` (~3,900), `src/cli/doctor.ts` (~2,600),
  `src/server/integrations/apply.ts` (~2,300), and
  `src/server/mcp/file-opener.ts` (~1,900).
- More than 600 test/spec source files exist. The observed Vitest run discovered
  555 test files and roughly 9,000 tests.

Verification performed during the review:

- Source TypeScript and Svelte checking completed with zero reported errors or
  warnings when invoked through the local binaries.
- Focused document-open and document-store tests passed: 2 files, 26 tests.
- A focused TypeScript compile of the document-store tests exposed stale test
  contracts that Vitest accepts at runtime.
- The full Vitest run was not clean in the restricted review environment:
  8,934 tests passed, 54 failed, and 23 were skipped. Failures were dominated by
  denied home/AppData access and subprocess environment errors, plus one client
  import timeout. This result is not evidence that the branch is CI-red, but it
  is also not a claim that the full suite passed.
- Origin, Y.Map-key, and Knip audits could not complete in the restricted
  environment because the `tsx` subprocess failed while querying the user
  environment and Knip could not scan `.pytest_cache`. **The Knip half is a
  real repo defect, but not the one named.** `npm run audit:dead-code` was run
  on this machine and exits 2 on
  `Error loading tests/perf/playwright.config.ts — Performance gate: no
  production client build at dist/perf-client/index.html`; `.pytest_cache`
  never appears in the output, and that directory is already git-ignored by
  the `.pytest_cache/.gitignore` pytest writes itself. So the audit does fail
  everywhere, for a different reason. Unit 0 addresses the actual blocker.

## Verification record (2026-08-24)

Every finding was re-checked against `master` (`bb39320`) after the audit was
written. Four agents were dispatched in parallel, each given the question to
test rather than a proposed answer, plus direct reads of the modules in
question. Recorded here so a later reader can tell which claims rest on a
re-check and which corrections were applied.

**Confirmed at the level of the finding, not every sub-claim.** All ten
findings hold, and these metrics were checked exactly: 529 source files;
`lib.rs` 9,298; `App.svelte` 3,936; `doctor.ts` 2,688; `apply.ts` 2,318;
`file-opener.ts` 1,930; `open.ts` 54; `lifecycle.ts` 96. Read "confirmed" as
"the finding is real and the headline number is right" — a later review pass
found several supporting details in this same section off by a line or a
count, and each is corrected in place below. Line references throughout this
document are to `bb39320`; re-check them on your branch before editing.

**Confirmed and sharpened:**

- `checkTandemPlugin` (`src/cli/doctor.ts:1725-1754`) calls
  `rejectUnsafeWindowsPrefix` nowhere. It reads
  `join(home, ".claude", "settings.json")` at :1732 and re-derives *the same*
  path `checkUserMcpConfig` refused at :961, reading it at :1744. Both reads
  sit in `try`/`catch` blocks whose catch bodies are comment-only, so a blocked
  SMB read fails silently. The two guarded checks are at :961 and :1306.
- `YDocStore` requires three arguments (`document-store.ts:189`). **Every one
  of the 17 test call sites passes two** — all in
  `tests/server/document-store.test.ts`. Both production call sites pass three.
- `src/server/documents/open.ts` is 54 lines, of which 7 of 14 code lines are a
  re-export block. **Zero production modules import it.** Its tests assert
  alias identity (`expect(openFromDisk).toBe(openFileByPath)`) plus a pure
  helper against a hand-built literal; no file is opened.
- `src/server/annotations/lifecycle.ts` is 96 lines owning exactly
  `acceptPending` / `dismissPending`. It takes `ydoc` and `map` as parameters,
  so callers still hold raw Yjs — it is not yet a state-owning Interface.
- `apply.ts` contains no lock of any kind. The only mutexes are per-route, in
  `integrations/api-routes.ts:169` and `:207`, so a CLI process calling
  `applyConfig` directly bypasses them.
- `src-tauri/src/lib.rs` is ~31 percent tests: 17 `#[cfg(test)]` blocks
  totalling roughly 2,860 lines. The non-test reasoning boundary is ~6,440
  lines, and `run` alone is a single ~700-line function (1552–2252).

**Corrections applied to unit scope:**

1. **Unit 2 understated the gap.** CI runs only `tsconfig.client.json` and
   `tsconfig.server.json` (`.github/workflows/ci.yml:154-158`); the pre-push
   hook runs no typecheck at all. Neither config includes `src/cli`, so
   `doctor.ts` — the location of the Critical finding — is typechecked only by
   the bare `tsc --noEmit` inside `npm run typecheck`, which no automation
   invokes. Unit 2 now covers production `src/cli` as well as tests.
2. **Unit 4 omitted its own tracked home, and the choice it implied was never
   actually made.** This race is already an open finding in
   [docs/security.md](../security.md#open-findings), which scopes it to a lost
   update and offers two outcomes — lock it, or accept it as a documented
   bounded risk. The audit assumed the first without noting the second existed.
   **Bryan decided on 2026-08-24 to accept**, so Unit 4 is rewritten from a
   locking epic into a documentation-and-guardrail PR. #1501 is the *merged PR
   whose review surfaced it*, not an open issue, and the finding still has no
   tracked issue at all — filing one is now that unit's first task.
3. **Unit 5 missed a fourth callback slot.** `provider.ts` has
   `setShouldKeepDocument`, `setDocLifecycleCallbacks` (two slots), *and*
   `setGenerationTokenSource` / `getExpectedGenerationToken` (:40-42), whose
   own comment names it as the same pattern.
4. **Unit 6's caller count was wrong in the safe direction.** Redirecting is
   not a light touch: 11 production modules import `file-opener.ts` statically
   and `document-service.ts` holds *three* dynamic imports of it (:855, :1135,
   :1650), not one.
5. **Unit 10 described a feature the product no longer has.** ADR-037 landed
   `createLayoutModel` (`src/client/layout/model.svelte.ts`) and its header
   records that **Wave I removed the cross-rail tab picker**, so there is no
   tab movement left to extract; `activeRailTab` is a two-value `$state` at
   `App.svelte:1211`. A second layout module,
   `layout/editor-stage.svelte.ts` (492 lines), already owns the margin-track
   width continuum. Unit 10 is rewritten around those — but see correction 5
   below, which walks back the persistence and animation halves of this.

**Gaps added:**

- Unit 0 (repo hygiene) is new, though its original premise was wrong on both
  halves — see the corrections below.
- `src/server/startup-file.ts:41` calls `setActiveDocId` with **no**
  broadcast, and `file-opener.ts:493` broadcasts with no registry mutation.
  These two asymmetries are the concrete evidence for finding 4 and belong in
  Unit 5's characterization set.
- ADR-035's load-bearing privacy mechanism — the branded `ChannelEligible`
  type produced by `narrowForChannel` — exists nowhere in `src/` and was
  absent from Unit 8. It is now Unit 8a, and it does not depend on Unit 7.
- Unit 12 as written asks for two things that conflict; see that unit.
- Units 5 and 7b gained hazards from the second review pass: broadcast must
  belong to composite operations rather than primitives (per-primitive
  broadcast double-advances `activeDocEpoch`); the generation-token lifecycle
  member must stay a method and stay non-optional; the unload path is
  asymmetric with swap and was uncharacterized; and the four-arm `OpenResult`
  sketch drops `restored`, drops success-path `warnings`, and promotes an
  accidentally-disjoint boolean triple to a discriminator.

**Corrections to this document's own revisions.** Two claims added in the first
revision pass were wrong and are retracted here:

1. **ADR-035's tombstone item is already implemented; an added Unit 8i wrongly
   said the coupling was "intact and unaddressed".** #695/#700 removed the
   `recordTombstone` call from `removeAnnotationById` — see the comment now at
   `mcp/annotations.ts:65-66` and the reversal recorded at decisions.md:489.
   The remaining callers seed the ledger from on-disk state and cannot move
   into a Y.Map observer at any snapshot width. Unit 8i is rescoped from
   "migrate" to "verify, pin, and fix the stale ADR text".
2. **Unit 8a's "preserve the existing runtime behavior exactly" was false.**
   `narrowForChannel`'s predicate differs from the four live observer gates.
   The claude-update gate is `type !== "note"`, which admits
   highlights, and a Claude-authored highlight ships on first run via
   `mcp/tutorial-annotations.ts`. Unit 8a now requires enumerating all four
   gates and declaring the delta rather than denying it. A third review pass
   then found the brand also runs the *other* way — `sanitize.ts:78-86`
   derives `outbound` for a Claude-authored comment, which the `author ===
   "user"` gates reject — so it differs on two axes, not one.
3. **Unit 0's premise was wrong on both halves.** `.pytest_cache/` is already
   git-ignored by the `.gitignore` pytest writes inside it, and
   `npm run audit:dead-code` fails on `tests/perf/playwright.config.ts`
   demanding a prior perf build, not on `.pytest_cache` at all. Unit 0 is
   rewritten around the real blocker; only the `.codex/` half survives intact.
4. **The `src/cli` "coverage hole" does not exist.** `ci.yml:196` runs
   `npm run build`, which begins with `npm run typecheck`, which includes a
   bare `tsc --noEmit` over the root config whose `include` is `["src"]`. The
   real residual is that this runs late — inside Build, after the test and
   acceptance-harness steps — and that `.husky/pre-push` has no typecheck.
   Unit 2's production half is rescoped from "close a hole" to "move the check
   earlier", which is ergonomics.
5. **Unit 10 overreached in the other direction.** Tab *movement* is genuinely
   gone, but `primaryTab` is a persisted setting that seeds `activeRailTab`
   (`useTandemSettings.ts:114`/:260/:533, `App.svelte:1211-1213`), so per-rail
   persistence survives and PR B must carry it. And
   `layout/editor-stage.svelte.ts` is 492 lines owning *width*; its own
   comments defer animation to Stage D, so citing it as the animation owner
   was wrong.

**Rejected — checked and not a finding.** The `tandem_diagnostics` MCP tool
does not apply `redactHomePaths` while the HTTP route does. This looked like an
inconsistency and is not: both sides carry comments
(`mcp/diagnostics.ts:73-76`, `routes/diagnostics.ts:110-119`) explaining that
redaction exists for the loopback user about to paste a report into a public
issue, and that an agent on the MCP transport needs the real path. No change.

## Prioritized findings

### Critical

#### 1. Windows network-path protection is bypassed in plugin diagnostics

- **Location:** `src/cli/doctor.ts` — `checkUserMcpConfig`,
  `checkDesktopMcpConfig`, `checkTandemPlugin`, and `runDoctor`;
  `src/server/mcp/routes/diagnostics.ts`; `src/server/mcp/diagnostics.ts`.
- **Problem:** Two doctor checks reject unsafe Windows UNC/device prefixes
  before filesystem access because an SMB read can disclose Windows
  credentials. `checkTandemPlugin` then reads `.claude/settings.json` and
  `.claude.json` without the same guard. `runDoctor` is callable through HTTP
  and MCP diagnostics. A redirected or attacker-controlled home path can
  therefore reach the unsafe reads. The duplicated reads make recurrence
  likely.
- **Recommended solution:** Introduce one bounded, path-safe Claude-config
  loader. Resolve the effective home once, reject unsafe prefixes before every
  filesystem probe, cap file size, and parse each file once. Pass typed read
  outcomes to all checks. Tests must assert zero filesystem calls for rejected
  paths, not merely a warning string.
- **Two hazards the fix must not walk into.** *Home resolution is not currently
  uniform.* `checkUserMcpConfig` (:944) and `checkTandemPlugin` (:1726) use
  `process.env.HOME || process.env.USERPROFILE || ""`, while
  `checkDesktopMcpConfig` reaches `os.homedir()` / `%APPDATA%` through
  `claudeDesktopConfigPath`, and `runDoctor`'s `opts.homeOverride` is
  deliberately *not* threaded into `checkUserMcpConfig` (see the doc comment at
  :2485-2488). "Resolve the effective home once" is therefore a behavior
  change on at least one check, not a pure refactor — pin each check's current
  resolution in a test before unifying, and say in the PR which one moved.
  *The two working doctor guards are untested, but the corpus and the exact
  test pattern already exist elsewhere — reuse them.* `tests/cli/doctor.test.ts`
  (2,243 lines) contains no reference to UNC, device paths, or
  `rejectUnsafeWindowsPrefix`, so this unit does add the first doctor-side
  coverage. But `tests/cli/win-path-guard.test.ts:20-33` already asserts
  "refuses %s without calling lstat or realpath" over the `NETWORK_PATHS` and
  `LOCAL_EXTENDED_PATHS` corpora in `tests/helpers/unc-fixtures.ts`, and
  `tests/shared/unc-check-duplication.test.ts` exists specifically to stop a
  second divergent implementation of this check from appearing. Extend those
  fixtures rather than writing a parallel corpus — and note that the
  duplication guard will constrain whatever bounded loader Unit 1 introduces,
  so read it before designing the loader.
- **Code example:**

```ts
function readDoctorJson(path: string): ConfigReadResult {
  const unsafeReason = rejectUnsafeWindowsPrefix(path);
  if (unsafeReason) return { kind: "unsafe-path", reason: unsafeReason };
  return readBoundedJson(path);
}

const claudeConfig = loadClaudeDoctorContext(home);
checkUserMcpConfig(result, claudeConfig);
checkTandemPlugin(result, claudeConfig);
```

### Moderate

#### 2. Tests compile at runtime but are not protected by TypeScript

- **Location:** `tsconfig.json`, `tsconfig.server.json`,
  `tsconfig.client.json`, `package.json`, `.github/workflows/ci.yml`, and
  `tests/server/document-store.test.ts`.
- **Problem:** Production source is typechecked, but tests are excluded.
  Concrete drift exists: `YDocStore` requires a `documentId`, while all 17 test
  call sites construct it with two arguments. Vitest still reports these tests
  as passing because runtime transformation does not enforce the contract. A
  green test can therefore be stale after an AI changes a production Interface.
- **A smaller adjacent gap, stated carefully — an earlier revision of this
  document overstated it.** The two named CI typecheck steps
  (`ci.yml:154-158`) cover only `tsconfig.client.json` and
  `tsconfig.server.json`, neither of which includes `src/cli`. But `src/cli`
  **is** typechecked in CI, indirectly: `ci.yml:196` runs `npm run build`,
  `package.json:46` makes `build` start with `npm run typecheck`, and
  `package.json:49` includes a bare `tsc --noEmit` against the root config,
  whose `include` is `["src"]`. So the claim "checked by nothing automated" is
  false. What is actually true is narrower and still worth fixing: that check
  runs *late* — inside the Build step, after `npm test` and the acceptance
  harness — so a CLI type error is reported minutes after the failures that
  would be diagnosed first, and `.husky/pre-push` (biome + vitest +
  `cargo test`) has no typecheck at all, so it never surfaces before a push.
  Promote the root check to its own early CI step and consider adding
  `npm run typecheck` to pre-push. This is ergonomics, not a coverage hole.
- **Recommended solution:** Inventory every executable TypeScript test and
  harness, then add focused configurations for Node/Vitest, client/Vitest,
  primary and performance Playwright, screenshot/design harnesses, and
  tauri-driver behind one `typecheck:tests` command. Include required source
  declaration files and fix the current errors. Do not weaken production types
  to accommodate stale tests. Run the gate in CI before the architectural
  migrations below.
- **Code example:**

```json
{
  "scripts": {
    "typecheck:tests": "npm run typecheck:tests:vitest && npm run typecheck:tests:e2e && npm run typecheck:tests:harnesses && tsc -p tests/tauri-driver/tsconfig.json --noEmit"
  }
}
```

```ts
// Before
new YDocStore(ydoc, FILE_PATH);

// After
new YDocStore(ydoc, FILE_PATH, DOCUMENT_ID);
```

#### 3. Configuration writes are atomic but not transactionally serialized

- **Location:** `src/server/integrations/apply.ts` — `applyConfig`,
  `removeConfigEntries`, `refreshMcpEntryBinary`,
  `refreshAllMcpEntryBinaries`, and `applyConfigWithToken`; also
  `src/cli/setup.ts`, `src/cli/rotate-token.ts`, and
  `tests/server/integrations/apply-malformed.test.ts`.
- **Problem:** Atomic rename prevents torn JSON but not lost updates. Two
  processes can read the same old document, make disjoint changes, and overwrite
  one another. The existing concurrency test accepts that last-writer-wins
  outcome. Some preservation decisions happen before `applyConfig`, so a lock
  around only that function would retain the race. The concrete instance:
  `src/cli/setup.ts:193` calls `resolveChannelShimIntent`, which **reads the
  config file itself** (`apply.ts:2254-2261`) to decide whether to preserve an
  opted-in channel shim, and only then calls `applyConfig` at :202, which reads
  the same file a second time and writes. `rotate-token.ts:152` runs the same
  read-decide-read-write sequence per target through `applyConfigWithToken`.
- **This finding already has a home, and a standing choice.** It is the config-race
  open finding in [docs/security.md](../security.md#open-findings), which
  bounds it to a lost update — not corruption, not privilege escalation, since
  anyone able to write the config could add their own MCP entry outright — and
  offers two acceptable outcomes: real cross-process locking, or accepting it
  as a documented bounded risk. #1501 is the merged PR whose review surfaced
  the race, not an open tracking issue; the paragraph in `docs/security.md` is
  currently its only tracked home, which means nothing will ever surface it in
  `gh issue list`.
- **DECIDED 2026-08-24 — accepted, not fixed. The recommendation below is
  superseded and retained only as the record of what was weighed.** Bryan chose
  the second of the two outcomes `docs/security.md` offers. Unit 4 is now a
  documentation-and-guardrail PR: file a dated tracked issue, record the
  acceptance and a revisit criterion in `docs/security.md`, pin the writer set
  so the bound cannot widen silently, and annotate the concurrency test that
  now serves as the executable record of the accepted behavior. **Do not
  implement what follows.**
- **Superseded recommendation:** Create one cross-process `withConfigMutation` Seam
  owning the complete read-decide-backup-write transaction. Acquire it after
  path/reparse/UNC validation, use an owner token, define timeout and stale-owner
  recovery, compare the owner again before reclaiming, and fail closed. Preserve
  the distinction between apply paths that may create a config and
  remove/repair/sweep paths that must not create one merely to obtain a lock.
  Ensure every top-level orchestration acquires exactly once. Prove it with
  multi-process disjoint-update, process-crash, owner-replacement, stale-lock,
  timeout, and no-create tests on Windows.
- **Code example (superseded — not to be implemented):**

```ts
await withConfigMutation(configPath, async (mutation) => {
  const current = await mutation.read();
  const intent = resolveChannelShimIntent(current, options);
  await mutation.commit(mergeConfig(current, operations, intent));
});
```

#### 4. The document registry does not enforce the invariants it should own

- **Location:** `src/server/documents/registry.ts`,
  `src/server/mcp/document-service.ts`, `src/server/yjs/provider.ts`, and
  ADR-033 in `docs/decisions.md`.
- **Problem:** `addDoc`, `removeDoc`, and `setActiveDocId` mutate state but do
  not own broadcast. Callers must remember a separate `broadcastOpenDocs` —
  which lives in `document-service.ts:969`, not in the registry — and
  `setActiveDocId` accepts IDs absent from the registry. Provider integration
  still uses free callback slots. This preserves the call-order hazard ADR-033
  rejected and prevents the file-open pipeline from becoming structurally safe.
- **The hazard is not hypothetical.** Ten production sites pair a registry
  mutation with a separate broadcast, and two are already asymmetric:
  `src/server/startup-file.ts:41` calls `setActiveDocId` with **no** broadcast
  (relying on a broadcast issued earlier inside `openFileByPath`), and
  `file-opener.ts:493` broadcasts with no registry mutation at all. Both are
  exactly what ADR-033's consequence — "callers can't add to `openDocs`
  without broadcasting because they can't touch `openDocs` directly" — was
  meant to make unrepresentable.
- **There are four free callback slots, not two.** Alongside
  `setShouldKeepDocument` and `setDocLifecycleCallbacks` (`onDocSwapped` /
  `onDocUnloaded`), `provider.ts:39-41` holds `setGenerationTokenSource` /
  `getExpectedGenerationToken`, whose comment names it as the same pattern.
  Note `onDocSwapped` already has a warn-only unregistered fallback
  (`provider.ts:187-194`) — that console error is today's only detector for
  "bound before lifecycle installed", and it is the behavior Unit 5's startup
  tests replace with a structural one.
- **Recommended solution:** Complete ADR-033 before ADR-034. Registry mutations
  must validate active IDs and own their broadcast. Replace free callback slots
  with the named `HocuspocusLifecycle` Interface, installed from one explicit
  startup composition root before every Hocuspocus bind. Characterize CTRL_ROOM
  retention, Y.Doc replacement, unload behavior, cold-start state, bind order,
  and activation-epoch semantics before moving production wiring.
- **Code example:**

```ts
// Before
addDoc(id, metadata);
setActiveDocId(id);
broadcastOpenDocs();

// After
documentRegistry.open(id, metadata);
// open() validates, updates active/epoch, and broadcasts.
```

#### 5. The new file-open module is a shallow alias over a cyclic Implementation

- **Location:** `src/server/documents/open.ts`,
  `src/server/mcp/file-opener.ts`, `src/server/mcp/document-service.ts`, their
  production callers, `tests/server/documents-open.test.ts`, and ADR-034.
- **Problem:** `documents/open.ts` is explicitly “part 1/N” and mainly
  re-exports functions from `file-opener.ts`. Production callers still import
  the old module, session restore uses dynamic imports to break a cycle, and the
  new tests largely assert alias identity. Deleting the new module would remove
  almost no production complexity. The shallow Seam adds navigation without
  hiding the pipeline.
- **Scale of the redirect.** **No production module imports
  `documents/open.ts` at all** — its only importer anywhere is
  `tests/server/documents-open.test.ts`. Eleven production modules import
  `file-opener.ts` statically: `startup-file.ts`, `server/index.ts`,
  `mcp/document.ts` (which also re-exports it), `mcp/convert.ts`,
  `mcp/docx-apply.ts`, and the `routes/` handlers `upload`, `open`,
  `scratchpad`, `external-conflict`, `document-reload`, `backups`. On top of
  that `document-service.ts` holds **three** cycle-breaking dynamic imports —
  `:855` (Save-As promote), `:1135` (`wireAnnotationStore` / `wireFileWatcher`)
  and `:1650` (restore) — so Unit 7a's "remove the dynamic import cycle" is
  three call sites, and only one of them is restore.
- **Recommended solution:** After ADR-033, characterize successful and failure
  behavior, redirect disk/upload/scratchpad imports through `documents/open`,
  move restore and pipeline ownership, introduce a tagged `OpenResult` without
  flattening Adapter-specific error behavior, and finally remove the
  compatibility module. Preserve cold-start-before-bind behavior. Do not mix in
  the separate format-adapter design.
- **Code example:**

```ts
type OpenResult =
  | { kind: "opened"; document: OpenDoc }
  | { kind: "already-open"; document: OpenDoc }
  | { kind: "reloaded-from-disk"; document: OpenDoc }
  | { kind: "failed"; reason: OpenFailure };
```

#### 6. `DocumentStore` is an Interface almost as complicated as its only Implementation

- **Location:** `src/server/mcp/document-store.ts`,
  `src/server/annotations/lifecycle.ts`, `src/server/local-model/tools.ts`,
  `tests/server/document-store.test.ts`, and ADR-035.
- **Problem:** `YDocStore` is intentionally thin, exposes raw `Y.Doc` and
  transaction escape hatches, and delegates to existing helpers. Its tests
  assert parity with helpers instead of behavior through a meaningful Seam.
  With one hardwired Adapter, the abstraction adds context and navigation cost
  without hiding Yjs, origins, or annotation lifecycle.
- **Recommended solution:** Deepen `AnnotationLifecycle` one mutation family at
  a time: create, edit, resolve, remove, replies/projection, explicit note
  promotion, then imported-note creation. Move all callers, including
  local-model and `.docx` paths, behind that Interface while preserving origin
  and ADR-027 privacy tests. Remove `ydoc` and `transactMcp` escape hatches once
  callers no longer need them, then collapse or delete the shallow store.
- **Two load-bearing pieces of ADR-035 were missing from this roadmap.**
  First, the ADR's privacy mechanism is a **branded `ChannelEligible` type**
  produced by `narrowForChannel(ann): ChannelEligible | null`, whose predicate
  is `audience === "outbound" && type === "comment"` — *both*, because the
  audience derivation in `sanitizeAnnotation`, not the type alone, is the gate
  (decisions.md:647, :662). Neither identifier exists anywhere in `src/`.
  Today's enforcement is still the prose-backed `if (ann.type !== "comment")`
  at `events/observers/annotations.ts:38` plus the parent check at
  `observers/replies.ts:32`. The brand's entire purpose is to make a dropped
  narrow a TypeScript error instead of a silent note leak, so it carries the
  highest safety return in ADR-035 and needs its own unit rather than riding
  along with "replies/projection".
  Second — **and ADR-035 is stale here, so read this before acting on it** —
  the ADR calls for moving tombstone tracking into the sync observer by
  widening its snapshot, on the premise that `removeAnnotationById` calls
  `recordTombstone` before the delete transact with a load-bearing ordering
  comment (decisions.md:643). **It no longer does.** #695/#700 already made
  that move: `mcp/annotations.ts:65-66` now documents that "tombstones are
  recorded automatically by the sync observer on the Y.Map delete event", and
  the function body (:79-88) contains no `recordTombstone` call. The reversal
  is recorded at decisions.md:489. The remaining direct caller,
  `rename-recovery.ts:226`, **cannot** move into an observer at any snapshot
  width: it seeds the ledger from a recovered on-disk envelope after a rename,
  where nothing was deleted and no Y.Map event exists. The same is true of the
  seed at `sync.ts:562-578` and of `migrateTombstoneLedger` (`sync.ts:372`).
  Deleting those in the name of "widening" removes the anti-resurrection seed
  and fails silently — a stale tab reconnecting after a rename resurrects an
  annotation the user deleted before it.
- **Layering question Unit 8b must answer.** `lifecycle.ts`'s only consumer in
  `src/` is `document-store.ts` (imported :41, used :251/:256) — the lifecycle
  is currently reached *through* the store it is meant to outlive, and it takes
  `ydoc` and `map` as parameters rather than owning them. Unit 8b must state
  which of the two becomes the seam callers hold, or every later family
  inherits the ambiguity and Unit 8j becomes unbounded.
- **Code example:**

```ts
const result = annotationLifecycle.create(docId, input);
switch (result.kind) {
  case "created":
    return result.annotation;
  case "rejected":
    return mapLifecycleFailure(result);
}
```

#### 7. `App.svelte` and global action wiring create a hidden lifecycle

- **Location:** `src/client/App.svelte`,
  `src/client/actions/builtin.svelte.ts`,
  `src/client/actions/registry.svelte.ts`,
  `src/client/components/CommandPalette.svelte`, and related client tests.
- **Problem:** `App.svelte` owns document state, rail behavior, shortcuts,
  chat, annotations, save flows, and animation. `wireActionDeps` stores more
  than twenty dependencies in mutable module-global state with no disposer.
  Some closures refer to state declared much later and work only because calls
  are deferred. Command-palette execution discards returned promises. Existing
  tests often reproduce App logic or scan source rather than mount the
  composition boundary.
- **Measured shape, so the extraction is aimed at the right thing.**
  `App.svelte` is 3,936 lines split 1–2443 script / 2444–3936 markup, with 29
  top-level `$state` declarations, 73 top-level functions and `$effect`s — and
  **27 already-extracted stores and hooks that it constructs and owns**
  (`src/client/hooks/` holds 67 modules). The file is large *after* heavy
  extraction, so the remaining problem is composition-root breadth, not a
  monolith. `wireActionDeps` is `builtin.svelte.ts:108` writing a single
  module-level `let deps: ActionDeps | null` (:106); `ActionDeps` declares
  **26** members (:37-104); there is no unwire, reset or disposer, and the
  guard is `guardedRun` (:112) warning on the *unset* case only, never the
  stale one. The registry has the same shape: `registry.svelte.ts:35` is a
  `$state` Map with `registerAction` and `getActionsMap` and **no
  unregister**, so Unit 9's disposer must cover both. The discarded promise is
  `CommandPalette.svelte:310`, `void result.action.run()`, against an
  `Action.run` typed `() => void | Promise<void>` (`registry.svelte.ts:30`) —
  the `void` operator makes the discard deliberate but still leaves an async
  action's rejection unhandled.
- **Recommended solution:** First introduce a lifecycle-bound action executor
  that returns a disposer and centrally awaits failures. Add a shallow App mount
  contract. Then extract a deep `createDocumentWorkspace`, followed by a
  `createRailLayoutWorkspace` and a separate rail content/review coordinator
  depending on small Interfaces. Preserve static action metadata needed before
  first paint. Do not combine these changes.
- **Code example:**

```ts
const documents = createDocumentWorkspace(documentDeps);
const actions = bindBuiltinActions({ documents, notify });

onDestroy(actions.dispose);
await executeAction(selectedAction, notify);
```

#### 8. The Tauri runtime is a 9,300-line reasoning boundary

- **Location:** `src-tauri/src/lib.rs` — `run`, sidecar management, startup
  feedback, context menus, native theme, Cowork commands, updater logic, and
  nested tests.
- **Problem:** One Rust module owns application construction, plugin order,
  sidecar lifecycle, updater state, crash reporting, window events, menus,
  themes, Cowork commands, and extensive tests. An agent modifying one concern
  must traverse unrelated platform-sensitive code. Registration order is
  load-bearing, so broad extraction would also have a large blast radius.
- **Recommended solution:** Mechanically extract one cohesive cluster per PR.
  Start with pure decision modules, then Cowork commands. Move sidecar and
  startup orchestration last. Keep tests with implementations, prefer
  `pub(crate)`, and do not add traits when no Adapter variation exists.
- **Code example:**

```rust
mod context_menu;
mod native_theme;
mod pending_update;
mod cowork;
mod sidecar;

// Keep the load-bearing plugin chain visible at the composition root.
pub fn run() {
    let app = tauri::Builder::default()
        // Existing plugin order remains explicit here.
        .setup(setup_application);
    app.run(tauri::generate_context!()).expect("run Tandem");
}
```

#### 9. Annotation diagnostics can report malformed active data as healthy

- **Location:** `src/cli/doctor.ts`, annotation-store inspection and summary.
- **Problem:** Files containing `.corrupt.` are counted, but parsing failures in
  active `.json` envelopes are caught without incrementing a failure counter.
  The summary can report zero corruption despite unreadable active data. The
  same path synchronously stats and reads the entire directory and is reachable
  through request-led diagnostics.
- **It is worse than a missing counter: the check is a sample, not a scan.**
  In `checkAnnotationStore` (`doctor.ts:2227`), the parse at :2264 is gated on
  `if (sampleSchemaVersion === null)`, so reading stops at the **first
  successfully parsed file**. A malformed envelope after that point is never
  opened at all. The empty catch at :2268 claims the file is "counted under
  corruptFiles check below", but `corruptFiles` (:2249) is a filename filter
  for `.includes(".corrupt.")` and the failing file is by construction in
  `jsonFiles` — a name *without* `.corrupt.`. So it is counted as a healthy doc
  in `docCount` and produces no warning. The unbounded synchronous work is real
  and independent of this: `readdirSync` at :2242 and `statSync` at :2257 walk
  every entry with no count or size cap, unlike `globalTandemEditorVersion`
  (:2391), which does set `maxBuffer` and `timeout`.
- **The two asks in Unit 12 conflict, and the unit must resolve it.** Counting
  every malformed active envelope means converting a first-hit sample into a
  full read of every file — which *increases* the synchronous request-led work
  the same unit is asked to bound. Pick one and say so: either validate all
  files behind an explicit count/byte cap and report `scan: "incomplete"` when
  the cap is hit, or keep sampling and stop reporting a corruption count that
  reads as a whole-store verdict. Do not ship a check that samples while its
  summary field implies a scan.
- **Recommended solution:** Reject unsafe effective app-data prefixes before
  the first directory probe and prove rejected inputs cause zero filesystem
  calls. Track quarantined and unreadable-active files separately, return a
  tagged outcome, and warn on both. Bound file count and size, report incomplete
  scans, and use an asynchronous scanner for HTTP/MCP invocation. Add unsafe
  path, malformed active-envelope, oversize, and limit tests.
- **Code example:**

```ts
let unreadableActive = 0;

try {
  validateAnnotationEnvelope(await readBoundedJson(path));
} catch {
  unreadableActive++;
}
```

### Minor / polish

#### 10. Coverage configuration does not provide a regression floor

- **Location:** `vitest.config.ts`, `package.json`, and
  `.github/workflows/ci.yml`.
- **Problem:** V8 coverage is configured for only `src/**/*.ts`, excluding
  Svelte and Rust, while the coverage provider dependency and script are absent
  and CI does not execute it. No thresholds exist. This looks like coverage
  infrastructure without producing a useful baseline, especially for
  `App.svelte`.
- **Recommended solution:** Add a non-blocking coverage artifact first. Include
  transformed Svelte coverage if reliable; otherwise label it TS-only. After
  deep modules gain behavioral tests, check in explicit per-module floors and a
  small JSON-summary comparator. Select only modules with stable source mapping
  instead of applying an arbitrary repository-wide percentage.
- **Code example:**

```ts
coverage: {
  provider: "v8",
  include: ["src/**/*.{ts,svelte}"],
  reporter: ["text", "json-summary", "html"],
}
```

## Execution roadmap

### Unit 0 — Repo hygiene (do this first; it is small)

**Claude Code instruction:**

> Add `.codex/` to `.gitignore`. It is currently untracked only because all
> four files in it happen to end in `.log`, matched by the existing `*.log`
> rule at `.gitignore:8` — the first non-log file written there becomes a
> commit candidate, which is why this document's execution contract otherwise
> has to carry a manual "do not commit `.codex` files" reminder. Delete that
> reminder from the contract once the ignore rule lands. Verify with
> `git check-ignore -v .codex/`, which currently returns nothing.
>
> Do **not** add `.pytest_cache/` — pytest writes its own `.pytest_cache/.gitignore`
> containing `*`, so the directory is already ignored; only the *root*
> `.gitignore` lacks a rule, which is cosmetic.
>
> Separately, `npm run audit:dead-code` does not currently run to completion,
> but not for the reason the audit assumed. It exits 2 on
> `Error loading tests/perf/playwright.config.ts — Performance gate: no
> production client build at dist/perf-client/index.html`. Knip loads the perf
> Playwright config, which refuses without a prior `npm run perf:gate` build.
>
> **Only one of the two obvious fixes works, and it is not the cheap one.**
> This document originally offered "add `tests/perf/playwright.config.ts` to
> `knip.json`'s ignore list" as a co-equal choice. It is a no-op, measured:
> knip's playwright plugin globs `playwright.config.{js,ts,mjs}` at any depth
> and *loads* every match during plugin-config discovery, before its own
> `ignore`/`project` filtering applies. Ignoring the file, ignoring all of
> `tests/perf/**`, and negating it out of the plugin's own `config` list all
> reproduce the identical exit 2. The fix is to make the config's build
> assertion lazy so a config *load* does not require the artifact.
>
> Two constraints on doing that. The assertion must **not** move to
> `globalSetup` — Playwright starts every webServer before globalSetup runs, so
> a missing build would surface as a 120-second `vite preview` health-check
> timeout instead of the one-line "run `npm run perf:gate`" message. And the
> `existsSync` throw is not the only load-time failure: the provenance print
> and staleness warning below it call `statSync` on the same artifacts, so
> removing only the throw swaps a clear error for a bare ENOENT and fixes
> nothing.
>
> **"Completes" is the criterion, not "exits 0".** Once it loads, the audit
> reports a pre-existing backlog — 21 unused files, 1 unused dependency, 20
> unlisted, 9 unused exports, 8 unused exported types — and exits 1. That
> backlog is not Unit 0's to clear, and `audit:dead-code` is wired to no CI job
> or hook, so this unit makes the command runnable, not a gate. Anyone later
> wiring it into `check` must first decide about the backlog; reaching for
> `|| true` is the anti-pattern this repo already has a lesson about.

**Review question:** Does `git status --short` stay clean after writing a
non-`.log` file under `.codex/`, and does `npm run audit:dead-code` complete
without a prior perf build?

**Rollback:** Trivial; revert the two files.

### Unit 1 — Close the doctor path-safety hole

**Claude Code instruction:**

> Fix the Windows network-path safety bypass in `src/cli/doctor.ts`. Create one
> bounded Claude-config loader that resolves the effective home once and calls
> `rejectUnsafeWindowsPrefix` before every filesystem probe. Make
> `checkUserMcpConfig`, `checkDesktopMcpConfig`, and `checkTandemPlugin` consume
> its typed results. Add Windows path-corpus tests that mock filesystem
> operations and assert zero `stat`, `exists`, or read calls for unsafe paths.
> Before unifying home resolution, pin each check's *current* resolution in a
> test — `checkUserMcpConfig` and `checkTandemPlugin` read
> `HOME`/`USERPROFILE`, `checkDesktopMcpConfig` reaches `os.homedir()` and
> `%APPDATA%`, and `runDoctor`'s `homeOverride` is deliberately not threaded
> into the first — then state in the PR body which check's behavior moved.
> There is no existing test for the two guards that already work; add coverage
> for all three, not only the new one.
> Run the focused doctor tests, `npm run typecheck`, and the available security
> audits. Do not include annotation-diagnostic changes in this PR.

**Review question:** Can any rejected home/config path reach a filesystem probe
before the rejection is returned?

**Rollback:** Revert the loader and its call-site migration together. Do not
retain a mix of direct and guarded reads.

**Divergence, as shipped in #1608:** the loader landed and all three checks
consume it, but **home resolution was NOT unified** and no check's resolution
moved. `checkTandemPlugin`'s `if (!home) return;` makes the whole check vanish
where `checkUserMcpConfig` falls back to `homedir()`; unifying that un-silences
a check — a product change with no security value, invisible to the existing
wiring tests, which filter by check name. Three characterization tests pin the
current behaviour so the unification can be done as its own PR. Both pre-code
reviewers recommended this split independently.

**Two defects the six-agent review found in the unit's own gate**, both
worth carrying forward because the later units reuse these patterns. The
corpus marker was derived from the raw hostile home, but `path.posix.join`
collapses `/./`, so one row filtered to `[]` on Linux no matter what doctor
read — a zero-of-zero inside the file written to prevent zero-of-zero. The
fix derives the marker *through* `join` and adds a per-row positive control;
it also recovered a real corpus row, so the input screen discriminates four
rows on POSIX rather than three. Separately, all three refusal warnings were
asserted by nothing: replacing any `r.warn` body with a bare `return` left
the suite green. **Assert the report, not only the absence of a syscall.**

A correspondence was also deleted rather than documented. `doctor.ts` had
mirrored `claudeDesktopConfigPath`'s precedence so it could screen the right
input, and reproduced only one of that resolver's two caller-supplied inputs
— they have opposite precedence. `claudeDesktopConfigTarget` now returns
`{ screenInput, path }` so the two cannot drift. Any later unit tempted to
mirror a resolver should return the value from the resolver instead.

Scope also grew in one direction and was held in another. Grew: the Claude
Desktop check gained an input screen it never had, because screening only the
resolved path leaves four of the fourteen corpus spellings unguarded under
`path.posix.join` — and CI is ubuntu-only. Held: `checkAnnotationStore` (Unit
12) and three sites in no unit at all — `TANDEM_CLAUDE_CMD`, the
`homedir()`-derived `~/.local/bin` probe, and the `PATH`-walk `statSync` — are
enumerated in `docs/security.md` rather than fixed here.

### Unit 2 — Typecheck the tests, and the untyped half of src/

**Claude Code instruction:**

> Inventory every TypeScript test and harness under `tests/`, then add a
> `typecheck:tests` command backed by focused configurations for Node/Vitest,
> client/Vitest, primary and performance Playwright suites, screenshot/design
> harnesses, and `tests/tauri-driver`. Reuse the tauri-driver config where
> appropriate. Every test file must belong to a checked configuration or have a
> documented reason why it is data rather than executable TypeScript. Include
> the declarations each environment needs and retain strict production types.
> Fix every current test-only error, including missing `documentId` arguments to
> `YDocStore` and invalid anchored-range unions — all 17 two-argument
> `new YDocStore(...)` call sites are in `tests/server/document-store.test.ts`.
> Two files deserve specific attention because they are *currently vacuous*:
> `tests/server/integrations/contract.test.ts:30,34,38` and
> `tests/shared/models-contract.test.ts:16,20,24` use `expectTypeOf`, but
> `vitest.config.ts` has no `typecheck` key and there are no `*.test-d.ts`
> files, so those two "contract tests" assert whatever the types happen to
> say and can never fail. That is a zero-of-zero gate sitting in the exact
> area this unit is fixing; wire them into the new configuration and confirm
> they can go red.
> Add the umbrella command to CI before architecture migrations. Run all source
> typechecks, `typecheck:tests`, and focused tests for every corrected fixture.
>
> In the same PR, tighten the production-side timing. The two named CI
> typecheck steps cover only `tsconfig.client.json` and
> `tsconfig.server.json`, and `.husky/pre-push` has no typecheck at all — so
> a type error in `src/cli/**`, including the 2,688-line `doctor.ts` this plan
> is about to rewrite, surfaces only once the Build step is reached. Add the
> root `tsc --noEmit` as its own early CI step, and assert in a wiring test
> that every directory under `src/` belongs to at least one config CI
> invokes. This is about *when*, not *whether* — `src/cli` already qualifies
> via the root check inside `npm run build` — so do not describe it as closing
> a coverage hole. `npx tsc --noEmit` was run on `bb39320` and exits 0, so no
> source fixes are required; also consider adding `npm run typecheck` to
> `.husky/pre-push`.

**Review question:** Can any executable TypeScript test or harness — or any
production file under `src/` — call a production Interface with a stale shape
and still pass every CI type gate?

**Rollback:** The CI gate and corrected fixtures are one unit. Revert both if a
configuration proves incompatible; do not leave an ignored or non-blocking
typecheck script.

### Unit 3 — Establish an honest coverage baseline

**Claude Code instruction:**

> Install and configure the Vitest V8 coverage provider, add a `test:coverage`
> script, and publish a non-blocking CI artifact. Include Svelte coverage if the
> current transform is reliable; otherwise label the artifact TS-only and
> document the exclusion. Do not add repository-wide failure thresholds yet.

**Review question:** Does the published artifact clearly identify which source
families are measured and omitted?

**Rollback:** Remove the artifact job and dependency together if the transform
is unstable. Do not retain misleading partial reporting without an explicit
label.

### Unit 4 — Accept the config-mutation race as a bounded risk

**Decided 2026-08-24 by Bryan: accept, do not lock.** `docs/security.md`'s
open-findings register offered two acceptable outcomes for this race —
cross-process locking, or accepting it as a documented bounded risk — and the
second was chosen. **Do not build `withConfigMutation`.** Do not add a lockfile
to `src/server/integrations/apply.ts`. The rationale for accepting is on the
record: the impact is a lost update, not corruption or privilege escalation;
each individual `atomicWrite` remains atomic; and anyone who can already write
the config file could add their own runnable MCP entry outright without needing
the race at all. The trigger is narrow — a user or setup script running the
wizard, `tandem setup --apply` or `tandem rotate-token` at roughly the moment
Tandem's server boots and runs its npx-convergence sweep.

**State the bound precisely, because "merely replaceable" is false.** An
earlier draft of this unit argued the loss always fails closed. That is right
for one case and wrong for another, and the difference is the whole point.

*What is genuinely fail-closed — token reversion.* `rotate-token.ts` writes the
new token to the token store at :53-57 and confirms the server accepts it
*before* calling `applyConfigWithToken` at :152, so the store is the authority
by the time any config write races. The concrete race is the boot sweep:
`refreshAllMcpEntryBinaries` reads the whole config (`apply.ts:1876`) and, if
anything was repaired, writes back **`opened.root` wholesale** (`apply.ts:1944`)
— a full pre-rotation snapshot replayed over the rotation's write. The client is
then pointing at a token the server has already stopped accepting, so it breaks
loudly once the 60-second grace closes. A superseded token never keeps working.
Cost: one re-run of `tandem rotate-token`, with nothing pointing at the cause.

*What is not fail-closed — uninstall resurrection.* `removeConfigEntries`
(`apply.ts:1282-1298`, called from `uninstall-scrub.ts:453`) deletes the
`tandem` and `tandem-channel` entries, **bearer token included**, and writes the
whole root. If a concurrently-booting server's sweep write lands after it, those
entries come back — leaving a bearer token in the config *after an explicit
scrub*. That is credential remanence, not a replaceable field, and re-running
uninstall fixes it only if the user knows to.

So the honest sentence for the issue and for `docs/security.md` is: **a lost
update — which in the rotation case strands a client on a dead credential, and
in the uninstall case can resurrect one after a scrub.** Everything else that
can be lost (binary path, npx→absolute convergence, channel-shim entry,
`SKILL.md` content) genuinely does recompute on the next boot or command. Do not
write "not corruption or privilege escalation" and stop there; it is true and it
is not the whole bound.

Keep one adjacent problem distinct from this decision: `rotate-token.ts:160-169`
already documents that rotation does not re-walk Cowork workspaces, stranding
post-rotation Cowork sessions on a dead token. That is a separate known gap with
its own TODO, not a consequence of this race, and accepting the race does not
accept it.

An accepted risk is still work, just much less of it. What remains is making
the acceptance *legible and bounded*, because an acceptance nobody can find and
whose scope can silently widen is indistinguishable from having missed the
problem.

**Claude Code instruction:**

> This is a documentation-and-guardrail PR. Change no behavior in
> `src/server/integrations/apply.ts`.
>
> 1. ~~**Give the finding a tracked home.**~~ **Done — #1599**, filed
>    2026-08-24 with the review date in its title and the corrected bound. The
>    remaining steps below are still open. For reference, what it had to be:
>    an issue whose title carries the review date, describing the lost-update
>    race across
>    `applyConfig`, `removeConfigEntries`, `refreshMcpEntryBinary`,
>    `refreshAllMcpEntryBinaries`, `installSkill`, `refreshExistingSkillIfStale`
>    and the `applyConfigWithToken` orchestrator, plus the earlier
>    unsynchronized read in `resolveChannelShimIntent` (`apply.ts:2254`, called
>    from `setup.ts:193` before `applyConfig` at :202). Record it as accepted,
>    not open-for-fix. Today the finding exists only as a paragraph at
>    `docs/security.md:170`, so nothing surfaces it in `gh issue list` — which
>    is exactly the failure mode `CLAUDE.md`'s dated-gates rule exists to
>    prevent. Note that #1501 is the merged PR whose review found this, not a
>    tracking issue; #1599 supersedes it as this finding's tracked home.
> 2. **Record the decision where the finding lives.** Amend the
>    `docs/security.md` entry to say accepted, by whom, on 2026-08-24, with the
>    impact bound restated and a link to the new issue. Move it out of
>    "open findings" if that register means unresolved, or mark it
>    `Accepted (bounded)` in place — pick whichever the document's own
>    convention supports and keep the register honest either way.
> 3. **State a revisit criterion that is answerable from tracked files — and
>    not one that is already true.** An earlier draft proposed voiding the
>    acceptance "if a config writer gains a path where a lost update loses a
>    security-relevant field". That is **already true on day one** (see the
>    uninstall-resurrection case above), so it would oblige the first honest
>    reviewer to void the acceptance immediately. A criterion satisfied at the
>    moment of writing is a contradiction, not a gate. Move the credential
>    cases into the *scope* of what is accepted, and make the void conditions
>    things that are currently false and greppable:
>
>    - The config-writer guard test (step 4) fails and the new writer is not
>      added to this acceptance by name.
>    - Any `/api` route or MCP tool reaching a config writer stops calling both
>      `assertOriginAllowlisted` and `assertLoopbackForMutation`. Today
>      `POST /api/integrations/apply` calls both at handler top
>      (`api-routes.ts:747-748`) and no MCP tool reaches a writer at all.
>    - **The server's accepted-token source moves into a file any `apply.ts`
>      writer touches.** Today `rotate-token.ts:53-57` writes the token store
>      independently of every config writer, and that separation is the single
>      fact keeping a lost update from resurrecting a *live* credential. Name
>      this one explicitly: it is the load-bearing invariant, and checking it is
>      one grep.
>
>    Put a review date in the issue title.
> 4. **Pin the bound so it cannot widen silently.** Add a guard test that
>    derives the config-writer set **from source** and asserts it against a
>    pinned list, so a new writer fails rather than silently joining the
>    accepted set. Copy both halves of the existing pattern: the source
>    derivation and comment-stripping from
>    `tests/docs/loopback-gate-claims.test.ts` (whose header states the rule
>    that matters here — a test seeded from the doc list only confirms the docs
>    against themselves), and the both-directions pinned-list check from
>    `tests/server/license-gate-coverage.test.ts`.
>
>    **Scope the scan to directories, not to `apply.ts`.** The set is larger
>    than the five writers the audit named. In `apply.ts` alone it also
>    includes `installSkill` (:2022) and `refreshExistingSkillIfStale` (:2120),
>    both writing `~/.claude/skills/tandem/SKILL.md` unsynchronized — harmless
>    today because both write identical content, but not if a future write ever
>    becomes version-conditional. Outside it, `uninstall-scrub.ts:325`
>    (`rewriteJson`) and `storage.ts:129`/:139 (`atomicWriteConfigFile`) have
>    the same read-modify-write shape on other files. Scan
>    `src/server/integrations/` and `src/cli/` at minimum, and strip comments
>    before matching — `apply.ts` names `atomicWrite` in prose several times.
> 5. **Annotate the test that pins the accepted behavior.** The concurrency
>    test at `tests/server/integrations/apply-malformed.test.ts:245` asserts
>    last-writer-wins, and after this decision that assertion *is* the
>    executable record of what was accepted. Add a comment saying so and
>    linking the issue, so a future reader does not read it as a latent bug and
>    "fix" it. Keep its second property intact and call it out: the losing
>    writer's token appears nowhere in the final file — no half-merge, no token
>    leak. That property is **not** part of what was accepted and must never
>    regress.

**Out of scope for this unit, but file it while you are here.**
`src/cli/uninstall-scrub.ts:325` (`rewriteJson`) does its own
read-parse-mutate-tmp-rename on three Cowork files — `installed_plugins.json`,
`known_marketplaces.json`, `cowork_settings.json` (:651, :656, :661) — while the
Rust side mutates **those same files** under a real cross-process sidecar
lockfile, `with_locked_json` (`src-tauri/src/cowork_atomic_json.rs:130`, used
throughout `cowork_installer.rs`). A TS scrub running concurrently with a Rust
install or remove defeats the lock the Rust side bothered to acquire. **Filed
as #1600 on 2026-08-24**, cross-referenced with #1599. This is a
strictly worse instance than the one being accepted — it is the one place where
a lock exists and a writer simply does not take it — and it is not covered by
this acceptance. (`rewriteJson`'s docblock does cite `with_locked_json`, but
about *trusting callers* for path validation, not about lock parity; do not
read it as a claim that locking was considered.) It is out of the acceptance and stays out.

**Review question:** Can a reader who knows nothing about this conversation
discover, from tracked files alone, that the race is known and deliberately
accepted — and can a config writer be added without anyone noticing that the
acceptance now covers it?

**Rollback:** Documentation and one guard test; revert freely. Note that the
prior locking design is preserved in this document's git history if the
decision is ever revisited — `src/server/annotations/store.ts` remains the
closest prior art, with the caveat that its own header (:10-11) calls
`store.lock` "a belt-and-braces fallback on top of the port 3479 bind, which is
the primary concurrent-writer lock." A CLI process mutating config has no port
bind behind it, so that lock has never had to be a sole cross-process
guarantee.

### Unit 5 — Complete ADR-033

**Claude Code instruction:**

> Add characterization tests for active-ID validation, activation epochs,
> CTRL_ROOM retention, Y.Doc swap/unload behavior, open-document broadcasting,
> and cold-start state. Then make registry mutations own validation and
> broadcast. Include the two existing asymmetries in the characterization set:
> `startup-file.ts:41` sets the active doc with no broadcast, and
> `file-opener.ts:493` broadcasts with no registry mutation. Pin what each
> currently produces before the registry owns broadcast, so the PR can name
> which one changed. `broadcastOpenDocs` lives in `document-service.ts:969`
> and must move with the ownership, not be called from it.
> Introduce the named `HocuspocusLifecycle` Interface and replace the
> provider's free callback slots — there are **four**, not two:
> `setShouldKeepDocument`, the `onDocSwapped` / `onDocUnloaded` pair set by
> `setDocLifecycleCallbacks`, and `setGenerationTokenSource` /
> `getExpectedGenerationToken` (`provider.ts:40-42`). Either fold the
> generation-token slot in or exclude it deliberately and say why; if folded
> in, the generation id must keep travelling over HTTP only and must never
> reach the ctrl Y.Map (`CLAUDE.md`, Y.js/CRDT gotchas). `onDocSwapped`'s
> warn-only unregistered fallback (`provider.ts:187-194`) is today's only
> bind-before-install detector, so do not remove it in the same PR that adds
> the structural startup tests.
>
> **Broadcast belongs to the composite operations, not the primitives.** The
> finding text reads as "add broadcast to `addDoc` / `removeDoc` /
> `setActiveDocId`"; do not do that. `file-opener.ts:167-171` does `addDoc` →
> `setActiveDocId` → `wireAnnotationStore` → **one** broadcast, and
> broadcasting per primitive would publish an intermediate state listing the
> new doc under the old active id. Worse, `setActiveDocId` advances
> `activeDocEpoch` on every call (`registry.ts:95-98`) and the epoch exists so
> clients can tell a genuine focus event from a stale re-broadcast
> (`registry.ts:42-47`) — two broadcasts per open means two epoch-advancing
> `documentMeta` writes per user action, fanned out to CTRL_ROOM and every
> open doc room (`document-service.ts:988-999`). Make `open` / `close` /
> `activate` the broadcasting operations and the primitives private, and add a
> characterization test counting `documentMeta` writes per open, close and
> switch before and after.
>
> **The generation-token member must be a method, not a value, and must not be
> optional.** `provider.ts:139` calls `getExpectedGenerationToken?.() ?? null`
> on every connection, and `writeGenerationId()` (`document-service.ts:1613`)
> registers the *function*, not the minted string. An interface shaped
> `{ expectedGenerationToken: string | null }` freezes at `null` if the
> lifecycle installs before the id is minted at `index.ts:461` — which is
> exactly the direction this unit pushes installation — and then rejects every
> connection for the whole run with the same log line as a legitimate stale
> rejection. This is the server-side mirror of the client-side "tokens are
> pinned strings, never closures" gotcha. Require a method, keep the member
> non-optional, keep `null` meaning reject, and add a test that installs the
> lifecycle before minting.
>
> **Fold in the two module-load side effects or say why not.**
> `registry.ts:51` calls `setShouldKeepDocument` and :69 calls
> `setDirtyMirrorEligibility` at *import* time. Leaving those as import-order
> dependencies while moving lifecycle installation to an explicit root leaves
> two coexisting registration mechanisms — which this unit's own rollback note
> forbids.
>
> **Characterize the unload path, not just swap.** Swap runs
> `reattachObservers` (`events/queue.ts:519-526`) *plus*
> `reattachFileSyncObserver` (`file-sync-registry.ts:105-120`) with phase
> `"swap"` so the tombstone ledger survives. Unload runs `detachObservers`
> only — it never calls `clearFileSyncContext`, so the durable-annotation
> observer and its store context stay registered for an evicted doc. That is
> invisible today because the keep predicate means a tracked doc never
> unloads; it stops being invisible the moment the registry owns
> close-and-broadcast as one operation. Add Y.Doc-unload-after-`removeDoc` to
> the characterization set explicitly.
>
> Make `src/server/index.ts` (or one named
> bootstrap module invoked from it) the sole composition root that constructs
> and installs the lifecycle Adapter before every Hocuspocus bind path. Do not
> introduce a provider-to-registry or registry-to-provider initialization cycle.
> Add startup tests for HTTP and stdio modes proving lifecycle installation
> precedes bind. Remove caller-managed `broadcastOpenDocs` sequences only after
> the tests pass. Update ADR status and architecture docs. Run focused
> registry/provider tests and the full server suite.

**Review question:** Can any production caller change open or active document
state without a consistent `documentMeta` broadcast, or bind Hocuspocus before
the lifecycle Adapter is installed?

**Rollback:** Revert registry, lifecycle, and caller migration together. The
old and new lifecycle registration mechanisms must not coexist after merge.

### Unit 6 — Characterize and redirect the file-open Interface

This is a behavior-preserving precursor to ADR-034, not the pipeline move.

**Claude Code instruction:**

> Add behavioral tests for fresh disk open, already-open, force reload, upload,
> scratchpad, observer wiring, and cold-start-before-bind ordering. Characterize
> the current `restoreOpenDocuments` dynamic-import behavior in place, but do
> not add or redirect a restore entry point yet. Add failure characterization
> for missing and unsafe paths, unsupported formats, oversized input, partial
> import issues, and force-reload failures. Pin the existing HTTP status, MCP
> error code, startup-rejection, and user-notification behavior for each entry
> path. Replace alias-identity assertions with outcome and side-effect
> assertions. Redirect only disk, upload, and scratchpad production callers from
> `src/server/mcp/file-opener.ts` through `src/server/documents/open.ts` without
> changing behavior or result shapes. Keep the old module as the temporary
> Implementation and verify startup order.
>
> Scope check before estimating: **no production module imports
> `documents/open.ts` today** — its only importer is its own test file. Eleven
> production modules import `file-opener.ts` statically (`startup-file.ts`,
> `server/index.ts`, `mcp/document.ts` which also re-exports it,
> `mcp/convert.ts`, `mcp/docx-apply.ts`, and `routes/` `upload`, `open`,
> `scratchpad`, `external-conflict`, `document-reload`, `backups`), and
> `document-service.ts` holds three dynamic imports of it (:855, :1135,
> :1650). Only the :1650 one is restore; the other two are Save-As promote and
> observer wiring, so Unit 7a's "remove the cycle" is three call sites.
> `mcp/document.ts`'s re-export is a second seam — decide in this PR whether it
> follows the redirect or is deleted in 7c, and say which.

**Review question:** Do disk, upload, and scratchpad production paths cross the
named Interface without changing behavior, while restore remains deliberately
characterized at its current call path?

**Rollback:** Import redirection is mechanical and can be reverted without
removing the characterization tests.

### Unit 7 — Complete ADR-034

This unit is three PRs: pipeline ownership, result/failure migration, then
compatibility deletion.

**Claude Code instruction for Unit 7a:**

> Move session restore and the shared open pipeline into
> `src/server/documents/open.ts`, using the completed registry for structural
> registration and broadcast. Add the named `openFromRestore` entry point and
> remove the dynamic `document-service` to `file-opener` import cycle. Preserve
> current result shapes and thrown-error behavior in this PR. Do not alter
> format-adapter architecture.

**Claude Code instruction for Unit 7b:**

> Using Unit 6's failure characterization, define which existing open failures
> remain exceptional and which become `OpenFailure` variants. Preserve each
> Adapter's HTTP status, MCP error code, startup-rejection behavior, and user
> notification. Replace boolean result combinations with an exhaustive
> `OpenResult` tagged union and migrate callers with exhaustive switches. Update
> ADR status and architecture docs only when the result contract is complete.
>
> **Three things the four-arm sketch above loses. Resolve each explicitly.**
> `OpenFileResult` (`file-opener.ts:81-94`) carries twelve fields; `OpenDoc`
> (`registry.ts:28-34`) carries five.
>
> 1. **`restored` is a fifth kind and the repo already names it.**
>    `documents/open.ts:47` declares
>    `"fresh" | "restored" | "already-open" | "force-reloaded"`, and
>    `mcp/document.ts:347-351` produces a distinct user-facing message for the
>    restored case. The sketch folds it into `opened`, which contradicts this
>    unit's own instruction to preserve each Adapter's user notification. Add
>    the arm or state that the message collapses.
> 2. **`warnings` attach to *successful* opens.** `buildResult`
>    (`file-opener.ts:1480-1495`) emits large- and very-large-document warnings
>    on every success path. A union whose only warning-carrying arm is `failed`
>    drops them, along with `format`, `fileName`, `tokenEstimate` and
>    `pageEstimate`, none of which `OpenDoc` has.
> 3. **The booleans are disjoint by accident, not by type.** The force branch
>    hardcodes `restoredFromSession: false` (:180) and `buildResult` hardcodes
>    `alreadyOpen: false, forceReloaded: false` (:1493-1494), so today's data
>    happens to be four-way disjoint; only `kindOfOpenResult`'s precedence
>    ordering (`open.ts:50-52`) makes it total. Pin that precedence as a test
>    before promoting it to a discriminator, or a future
>    restored-and-already-open path silently reports `already-open`.

**Claude Code instruction for Unit 7c:**

> Search source, tests, scripts, and documentation for remaining imports of
> `src/server/mcp/file-opener.ts`. Delete the compatibility module only when no
> production or test consumer remains, then add or update the narrow audit that
> prevents the legacy path from returning. Run the complete server verification
> set without changing file-open behavior.

**Review question:** Do all entry points execute one ordered pipeline without a
caller-managed registration postlude or dynamic import cycle, while retaining
the distinct failure contract at each external Adapter?

**Rollback:** Each PR must be independently revertible. Do not delete the
compatibility module in the same PR that first redirects callers.

### Unit 8 — Deepen ADR-035 one mutation family at a time

This is an epic containing multiple PRs. Order: **the channel-eligibility
brand**, create, edit, resolve, remove, replies/projection, note promotion,
imported-note creation, tombstone verify-and-pin, then shallow-wrapper cleanup.
`promoteNoteToComment` and the `.docx` `importNote` entry path are separate
families because their ADR-027 privacy boundary deserves an isolated review and
rollback.

The status mapping is Unit 8a `ChannelEligible` brand, 8b create, 8c edit, 8d
resolve, 8e remove, 8f replies/projection, 8g note promotion, 8h imported-note
creation, 8i tombstone verify-and-pin, and 8j `DocumentStore` cleanup.

**Unit 8a comes first, and it is the highest-value PR in this epic.** ADR-035's
actual privacy mechanism is a branded `ChannelEligible` type produced by
`narrowForChannel(ann): ChannelEligible | null`, with the predicate
`audience === "outbound" && type === "comment"` — both conditions, because
`sanitizeAnnotation`'s audience derivation is the load-bearing gate, not the
type (decisions.md:647, :662). Neither identifier exists in `src/`. Enforcement
today is `if (ann.type !== "comment")` at `events/observers/annotations.ts:38`
and the parent check at `observers/replies.ts:32` — correct, but prose-backed.
Introducing the brand converts a future dropped narrow from a silent note leak
into a compile error, and it does not depend on any mutation family moving
first. Do it before the migrations, not after.

**Unit 8a instruction:**

> Add `narrowForChannel(ann): ChannelEligible | null` as the sole producer of a
> branded `ChannelEligible`, calling `sanitizeAnnotation` inside it rather than
> duplicating any rule. Narrow at projection time, not write time — note→comment
> promotion is a real path that must surface as a channel event, so audience can
> change after the write. Retype the channel observer projection functions in
> `src/server/events/observers/annotations.ts` and `replies.ts` to take
> `ChannelEligible`, not `Annotation`. Add a test that a projection function
> called with a plain `Annotation` fails to typecheck, or the brand is
> decorative.
>
> **Retyping the two observers is only half the mechanism, and the smaller
> half.** The original ADR-035 implementation plan
> (`docs/superpowers/plans/2026-05-15-adr-031-037-implementation.md:216`)
> requires that `src/server/events/queue.ts`'s `pushEvent` annotation-payload
> field be typed to require `ChannelEligible`, so **direct-push paths fail to
> typecheck** — that is what closes the "a future channel path bypasses the
> observer" hole ADR-035 named. The same plan (:215) also calls for a runtime
> re-assertion of both conditions inside the narrow, as defence against a
> JS-level brand bypass, and puts `narrowForChannel` in a new
> `src/server/annotations/projection.ts`. Without the `pushEvent` half this
> unit does not deliver the definition-of-done bullet it is written against. **That test only bites after Unit 2**: `@ts-expect-error` is
> already used in `tests/` (for example
> `tests/client/annotation-context-menu-host.test.ts`), but nothing typechecks
> `tests/`, so such an assertion is inert today and would pass whether or not
> the brand works. Unit 8a therefore depends on Unit 2, not on Unit 7.
>
> **Do not claim this preserves runtime behavior exactly — it does not, and an
> earlier draft of this unit wrongly said so.** The brand's predicate
> (`audience === "outbound" && type === "comment"`) **differs from the four
> live gates on two axes at once — it is narrower on type and weaker on
> authorship** — so it is neither a superset nor a subset, and at least one
> delta is reachable on first run. Enumerate all four against the brand before
> writing code:
>
> | Site | Current predicate |
> |---|---|
> | `observers/annotations.ts:32,38` (user add) | `author === "user" && type === "comment"` |
> | `observers/annotations.ts:54` (user edit / promotion) | `author === "user" && type === "comment"` |
> | `observers/annotations.ts:89,94` (claude accept/dismiss) | `author === "claude" && type !== "note"` |
> | `observers/replies.ts:21,32` | `reply.author === "user" && parent.type === "comment"` |
>
> The third row **admits highlights**, and a Claude-authored highlight ships on
> first run: `mcp/tutorial-annotations.ts:22` defines `type: "highlight"` and
> :88 assigns `author: "claude"` to everything that is not a note, while
> `sanitize.ts:155-158` demotes an explicit `audience: "outbound"` only for
> `author === "user"`. So accepting or dismissing the tutorial highlight on
> `sample/welcome.md` emits a channel event today and would emit none under the
> brand. Either keep the claude-update branch's `type !== "note"` gate outside
> the brand, or accept the change and say so in the PR body — but do not claim
> both "sole producer" and "behavior preserved".
>
> The **weaker-on-authorship** direction is the mirror image and is easier to
> miss. `sanitize.ts:78-86` derives `outbound` for anything that is not an
> import and not a highlight/note/flag, so a **Claude-authored comment
> sanitizes to `outbound`** and satisfies the brand — while rows 1 and 2 above
> require `author === "user"`. The brand preserves behavior on those rows only
> if the authorship gate stays *outside* the narrow. Decide that explicitly;
> ADR-035 does not.
>
> The same enumeration must cover a `type: "comment"` record carrying a stored
> `audience: "private"` (reachable via stale-tab CRDT merge or a legacy
> envelope, since `sanitize.ts` only demotes, never promotes): it emits today
> and would not under the brand.
>
> One more side effect to pin: `observers/replies.ts:24` reads the parent with
> a bare `as Annotation | undefined` and never sanitizes it, and `audience` is
> optional on the type (`shared/types.ts:236`). `narrowForChannel` calls
> `sanitizeAnnotation` internally, so routing that read through the narrow
> changes what the observer sees, not merely how it is typed.
>
> **The brand does not cover reply privacy, and retyping `replies.ts` will make
> it look like it does.** `AnnotationReply.private` (`types.ts:118-125`) is
> enforced on MCP egress by `channelVisibleReplies` in `mcp/annotations.ts`,
> which strips `private` even after a note→comment promotion. The SSE observer
> at `replies.ts:21-32` never reads `private` at all — it is safe today only by
> construction, because a private reply's parent is a note at add time.
> Branding the *parent* (used only for `textSnippet` at :33) leaves the reply a
> plain `AnnotationReply` with an unchecked `private` field, inside a function
> that now reads as fully guarded. Either add a `ChannelEligibleReply` produced
> by a narrow that consults `private`, or state in the PR that the reply half
> stays prose-backed. Either way add the regression: add a private reply to a
> note, promote the note, assert no `annotation:reply` event and no
> `textSnapshot` on the wire.

**Unit 8i instruction — verify and pin, do not migrate.** An earlier draft of
this unit said "move tombstone tracking into the sync observer by widening its
snapshot", quoting ADR-035. Adversarial review established that the move
already happened in #695/#700 and that executing the instruction literally
would delete a correctness mechanism. The unit is rescoped accordingly.

> Do **not** move `recordTombstone` out of `rename-recovery.ts:226`,
> `sync.ts:562-578`, or `migrateTombstoneLedger` (`sync.ts:372`). None of them
> observes a Y.Map delete — they seed the ledger from on-disk state — so no
> observer, at any snapshot width, can replace them. Instead, mark ADR-035's
> tombstone item implemented, delete the now-wrong "widen the observer's
> snapshot" consequence at decisions.md:680, and correct the stale premise at
> decisions.md:643 that says `removeAnnotationById` calls `recordTombstone`.
>
> Then pin the four behaviors that a future refactor in this area would break,
> none of which is currently covered:
>
> 1. A `Y.Map` delete whose old value carries **no `rev`**: `sync.ts:271-281`
>    falls back to `prevRev = 0` and warns, so the tombstone lands at `rev: 1`
>    and loses the merge against any live copy at `rev >= 1` (the delete rule
>    is `stone.rev > ymapRec.rev`, decisions.md:489). This is a real
>    resurrection path on legacy session blobs.
> 2. A delete arriving during the rename's observer-detached gap, recorded
>    under the **old** hash and folded forward by `migrateTombstoneLedger` —
>    assert the union-not-clobber property at `sync.ts:548-578`.
> 3. Cleanup phase `"swap"` versus `"close"`: `sync.ts:302-308` drops
>    `tombstonesByDoc[docHash]` only on `"close"`, and
>    `file-sync-registry.ts:70`/`:111` deliberately pass different phases on
>    the replace and reattach paths. A wrong phase serializes
>    `tombstones: []` from an in-flight debounced write.
> 4. The property the original instruction wanted: a write path that bypasses
>    the lifecycle still tombstones. This already holds —
>    `sync.ts:261-274` records for **all** origins including `file-sync`, with
>    the reasoning at :21-31 — so pin it with a test that never calls a
>    lifecycle method, rather than rebuilding it.

**Unit 8b must settle the layering.** `lifecycle.ts` is reached *through*
`document-store.ts` today (its only `src/` consumer, imported :41, used
:252/:256), and it takes `ydoc` and `map` as parameters rather than owning
them. State in the 8b PR which of the two is the seam callers hold from then
on. Leaving it open makes 8j unbounded.

**Claude Code instruction:**

> Expand `AnnotationLifecycle` through one mutation family only in this PR.
> Migrate the corresponding MCP, server, and local-model callers behind the
> lifecycle Interface. Preserve ADR-027 note/reply privacy behavior and ADR-031
> origin behavior with focused tests. Return tagged success/failure outcomes and
> keep handlers as thin Adapters. Do not expose raw Yjs state through the new
> Interface. After all families have migrated in separate PRs, remove raw
> `ydoc` and `transactMcp` escape hatches and collapse or delete `DocumentStore`.

For note promotion, pin the rule that a note reaches the channel only after an
explicit promotion. For imported-note creation, migrate the `.docx` path
through the lifecycle and prove imported notes do not reach
`tandem_checkInbox` before promotion. Update ADR-035 status only after Units
8a–8j are complete.

**Review question for every family:** Can this mutation bypass lifecycle origin,
revision, privacy, or projection policy through another production call path?

**Rollback:** Revert one mutation family at a time. Do not combine privacy
projection changes with every mutation rewrite.

### Unit 9 — Replace global client action wiring

**Claude Code instruction:**

> Add tests for action binding, disposal, synchronous failures, and rejected
> promises. Replace the global mutable `ActionDeps` bag — one module-level
> `let deps` at `builtin.svelte.ts:106`, 26 members, no unwire — with a
> lifecycle-bound executor that returns a disposer and centrally awaits and
> reports action failures. The registry needs the disposer too, though not for
> the reason an earlier draft gave: `registry.svelte.ts:35` is a `$state` Map
> with `registerAction` and no unregister, and a re-registration does **not**
> silently double the map — `registerAction` (:41-52) throws in DEV on an id
> collision and warns-and-replaces in production. So a remount fails loudly in
> development and mutates global state in production; both want teardown, and
> neither is a duplicate-entry bug. The unhandled rejection is
> `CommandPalette.svelte:310`, `void result.action.run()` against an
> `Action.run` typed `() => void | Promise<void>`; the current `guardedRun`
> (`builtin.svelte.ts:112`) warns only on the *unset* case and cannot detect a
> stale one, which is the failure this unit exists to make impossible.
> Preserve static action metadata required before App mount. Add a
> shallow `App.svelte` mount/composition contract. Run focused action tests and
> E2E. Do not extract document or rail workspaces in this PR.

**Review question:** Can an action execute with stale dependencies, survive App
unmount, or produce an unhandled promise rejection?

**Rollback:** Revert executor wiring and disposer use together while keeping the
new behavioral tests where they also describe the old contract.

### Unit 10 — Extract client workspaces

This unit is three PRs: document workspace, rail-layout workspace, then rail
content/review coordination.

**Read this before starting — the original Unit 10b described a feature the
product no longer has.** ADR-037 is marked implemented: `createLayoutModel`
(`src/client/layout/model.svelte.ts`) already owns rail visibility, including
the solo-mode suppression, and `App.svelte:313` constructs it. Its header
records that **Wave I removed the cross-rail tab picker** — the left rail is
hard-coded to the outline, the right to Annotations plus Chat, and the
`leftTabs` / `rightTabs` getters and `moveTabs` action were deleted. So there
is no tab movement and no per-rail tab persistence left to extract;
`activeRailTab` is a two-value `$state` at `App.svelte:1211` with one setter,
`selectRailTab` (:2070). A second module, `layout/editor-stage.svelte.ts`
(492 lines, `createEditorStageModel`), already owns the margin-track width
continuum. ADR-037's own sketch of `moveTabToRail` / `setActiveTab` /
`disabledLeftTabs` describes a pre-Wave-I product and should not be treated as
a to-do list.

The settings schema confirms the *movement* half: the **v4→v5 migration deletes
both `leftRailTabs` and `rightRailTabs` from the schema outright**
(`src/client/hooks/useTandemSettings.ts:678-684`, documented at :428-431 and
:520, with both keys listed among the removed fields at :893-894), and
`leftTabs` / `rightTabs` / `moveTabs` / `moveTabToRail` / `disabledLeftTabs`
appear nowhere in `src/client/`.

**Two corrections to an earlier draft of this preamble, which overreached:**

1. **Rail-tab persistence is not gone.** `primaryTab` is a persisted user
   setting — type at `useTandemSettings.ts:14`, schema field :114, default
   :260, normalizer :533, persisted under `TANDEM_SETTINGS_KEY` — with a
   radio group in `AppearanceSettings.svelte:130-153`, and `App.svelte:1211-1213`
   seeds `activeRailTab` from it. Any extraction must carry that dependency,
   so PR B must *not* be told to ignore per-rail persistence. While in there,
   check an apparent asymmetry: :260 defaults `primaryTab` to `"annotations"`
   while :533 coerces every non-`"annotations"` parsed value — `undefined`
   included — to `"chat"`. Confirm whether the normalizer ever sees an absent
   field before treating that as a defect.
2. **`editor-stage.svelte.ts` does not own animation state.** It owns width.
   Animation is explicitly deferred: ":20 animated tracks land in Stage D",
   ":113 animated track widths are Stage D", ":267 animatable (Stage D)". Do
   not cite it as covering animation.

**Doc fix to bundle here.** ADR-037's status line reads "Accepted;
implemented", but its Context and Decision sections still describe the
pre-Wave-I product — `moveTabToRail`, `disabledLeftTabs`, the four settings
fields, the v1→v2 migrations. An agent sent to "complete the layout model"
will read those as remaining work, which is exactly the mistake this unit's
first draft made. Amend ADR-037 in the 10b PR to record what Wave I removed.

**Consequences for this unit.** `src/client/layout/*.svelte.ts` is the
established pattern — a factory invoked exactly once in `App.svelte`'s script
scope, returning getters so reactivity flows through the store underneath, and
explicitly *not* a module-level singleton because internal `$effect`s must run
in a component effect root. Follow it; do not invent a parallel "workspace"
convention beside it. Unit 10b is therefore not a new extraction but a small
one: move `activeRailTab`, `selectRailTab`, the pending-annotation badge
derivation (:1215) and the cross-tab activation writes (:998, :3121) into the
existing `createLayoutModel`, or into one sibling module in the same
directory. Say in the PR which, and why. Unit 10a and 10c are unaffected.

**Claude Code instruction for PR A:**

> Extract `createDocumentWorkspace()` from `App.svelte`. It must own active
> document, tab, save, source-view, close, reopen, and cleanup behavior behind a
> small typed Interface. Add a dedicated harness that tests behavior rather than
> reproducing App expressions. Preserve existing `data-testid` values. Run the
> harness, client tests, typechecks, and E2E.

**Claude Code instruction for PR B:**

> Move active rail-tab selection out of `App.svelte` after the document
> workspace merges — `activeRailTab` (:1211), `selectRailTab` (:2070), the
> pending-annotation badge derivation (:1215) and the two cross-tab activation
> writes (:998, :3121). Put it in the existing `createLayoutModel`
> (`src/client/layout/model.svelte.ts`) or one sibling in that directory, and
> state which and why. Do not add rail visibility — `createLayoutModel` already
> owns it — and do not add tab *movement*; Wave I removed the cross-rail picker
> and none of `leftTabs` / `rightTabs` / `moveTabs` / `moveTabToRail` /
> `disabledLeftTabs` exists. **Do carry the `primaryTab` dependency**: it is a
> persisted setting (`useTandemSettings.ts:114`, :260, :533) that seeds
> `activeRailTab` at `App.svelte:1211-1213`, so the extracted module needs the
> settings store, not just the document workspace. Do not touch
> `layout/editor-stage.svelte.ts`, which owns the width continuum (its
> animation is still deferred to Stage D, so it is not the animation owner).
> Depend only on the document workspace's small Interface. Preserve
> cross-tab activation behavior and every existing `data-testid`. Run focused
> harness tests, client tests, typechecks, and E2E.

**Claude Code instruction for PR C:**

> Extract the remaining rail content coordination from `App.svelte`: chat
> reveal/anchor state, annotation review selection and pending counts, and the
> dependencies between those states and the active document. Give it a small
> typed Interface to the document and rail-layout workspaces. Preserve chat
> continuity, review-target behavior, badges, and every existing `data-testid`.
> Add behavioral harness coverage and run client tests, typechecks, and E2E.

**Review question:** Can either workspace be understood and tested without
loading unrelated App domains or reproducing its internal derivations?

**Rollback:** Each workspace PR must be independently revertible. Never combine
document, rail-layout, and rail-content extraction in one commit.

### Unit 11 — Split the Tauri runtime

This is an epic, not one refactor. Extract one cluster per PR in this order:

1. Pending-update marker logic.
2. Context-menu specifications.
3. Native-theme decisions.
4. Cowork commands.
5. Sidecar lifecycle.
6. Startup helpers last; retain `lib.rs::run` as the visible composition root.

**Calibration.** About 2,860 of the 9,298 lines — 31 percent — are the 17
`#[cfg(test)] mod *_tests` blocks, so the non-test reasoning boundary is
roughly 6,440 lines. Since each cluster's tests move with it, the early PRs
are larger in diff and smaller in risk than the raw line count suggests. The
one genuinely hard piece is `run` itself: a single ~710-line function spanning
lines 1552–2252 that holds the load-bearing plugin chain. It is correctly
sequenced last, and the sizes to expect per cluster are pending-update
~591–980, context menus 2661–3094, native theme ~3887–4624, Cowork
~4626–6140, sidecar lifecycle ~3095–3880.

**Claude Code instruction:**

> Extract only the next listed concern from `src-tauri/src/lib.rs`. Move its
> nested tests with the Implementation so Rust privacy does not force broad
> public APIs. Prefer `pub(crate)` and do not introduce traits without real
> Adapter variation. Preserve plugin registration and startup ordering exactly.
> Extract callbacks and helpers around `run`, but keep the load-bearing plugin
> chain and final application construction visibly ordered in `lib.rs::run`
> unless a later measured review justifies another decision.
> Run formatting, Clippy if configured, and the Rust test suite. Require the
> existing Windows, macOS, and Linux CI matrix before merging.

**Review question for every cluster:** Did the extraction alter platform
conditionals, plugin order, thread boundaries, or visibility beyond what the
move requires?

**Rollback:** One module extraction per PR makes rollback mechanical. Keep
startup orchestration in `lib.rs` until all leaf modules are stable.

### Unit 12 — Correct and bound annotation diagnostics

**Claude Code instruction:**

> Resolve the sample-versus-scan conflict first and state the choice in the PR
> body. `checkAnnotationStore` does not scan today: the parse at
> `doctor.ts:2264` is gated on `if (sampleSchemaVersion === null)`, so reading
> stops at the first successfully parsed file and a malformed envelope after
> that point is never opened. Counting every malformed active file therefore
> means reading every file — the opposite direction from "bound the request-led
> work". Choose one: validate all files behind an explicit count and byte cap
> and report an incomplete scan when the cap is hit, or keep sampling and stop
> emitting a `corruptCount` that reads as a whole-store verdict. Do not ship a
> check that samples while its summary implies a scan.
>
> Then fix annotation-store diagnostics so malformed active envelopes are
> counted separately from quarantined `.corrupt.` files. Delete the comment at
> :2269 claiming the failing file is "counted under corruptFiles check below" —
> it is not, because `corruptFiles` (:2249) is a filename filter and the
> failing file is by construction in `jsonFiles`. Before the first `exists`,
> directory enumeration, stat, or read, reject unsafe Windows prefixes derived
> from `TANDEM_APP_DATA_DIR`, redirected `LOCALAPPDATA`, or other effective
> app-data inputs. Add zero-filesystem-call tests for UNC, device, and extended
> unsafe prefixes. Return explicit outcomes, warn on incomplete bounded scans,
> cap file count and file size, and avoid unbounded synchronous filesystem work
> on the HTTP/MCP path. Add tests for malformed active files, oversized files,
> and scan limits. Keep this separate from the Claude-config path fix and
> coverage work.

**Review question:** Can an unsafe annotation-store path reach a filesystem
probe, or can unreadable active data or an incomplete scan be reported healthy?

**Rollback:** Retain the malformed-file regression test even if the asynchronous
scanner needs to be reverted independently.

### Unit 13 — Add targeted coverage gates

**Claude Code instruction:**

> Review the coverage baseline after the registry, open pipeline, annotation
> lifecycle, and client workspace migrations. Check in a small coverage policy
> file mapping each selected deep module to exact line, function, branch, and
> statement floors, plus a comparator that reads Vitest's JSON summary and
> fails if a selected module is missing or falls below its floor. Select only
> modules whose source mapping is stable and visible on all applicable CI
> branches; document platform or Svelte-transform exclusions beside the policy.
> Seed each floor from the observed baseline with at most a one-point rounding
> allowance, and include those observed values in the PR description for
> approval. Do not use a repository-wide threshold or optimize for 100 percent.
> Require behavioral coverage through public Interfaces and failure variants.

**Review question:** Can a critical branch in a newly deepened module be removed
without a test or coverage gate failing?

**Rollback:** Adjust thresholds with evidence rather than deleting the reporting
job. Record unavoidable generated or platform-specific exclusions explicitly.

## Cross-unit sequencing

The dependency chain is:

```text
Unit 0   repo hygiene — do first, blocks nothing, unblocks audit:dead-code
Unit 1   independent
Unit 2   test + early-typecheck gate ──> Units 4-12 rely on it
Unit 3   coverage baseline — independent; informs Unit 13
Unit 4   DECIDED: accept, not lock — docs + one guard test; independent
Unit 5   ADR-033 ──> Unit 6 ──> Unit 7 (ADR-034) ──> Units 8b-8j (ADR-035)
Unit 8a  independent after Unit 2 (needs typechecked tests to bite)
Unit 9   ──> Unit 10
Unit 11  independent after Unit 2
Unit 12  independent after Unit 2
Unit 13  after Units 5, 7, 8 and 10 — the modules it gates
```

The load-bearing correction from plan review is **ADR-033 before ADR-034**.
ADR-034 assumes registration and broadcast are structural. Moving the open
pipeline first would preserve the exact call-order hazard under a cleaner API.

The second correction, from verification: **Unit 8a does not wait for Unit 7.**
The `ChannelEligible` brand is a typing change over the channel observers and
depends on no mutation family having moved. It is the cheapest structural
privacy win in the plan and sits behind the longest dependency chain only by
accident of numbering.

## Definition of done

The remediation program is complete when:

- [x] `.codex/` is git-ignored and `npm run audit:dead-code` completes without
  a prior perf build. (Completes, exit 1 on a pre-existing findings backlog;
  the config-load error is gone. The backlog is out of Unit 0's scope.)
- [ ] Every doctor config read rejects unsafe Windows prefixes before any
  filesystem probe.
- [ ] Every executable TypeScript test and harness is covered by a strict
  typecheck configuration that CI invokes, the two `expectTypeOf` contract
  tests among them, and the root `src/` check runs as its own early CI step
  rather than buried inside Build.
- [ ] The config-mutation lost-update risk is recorded as accepted in
  `docs/security.md` with a dated tracked issue, a revisit criterion
  answerable from tracked files, and a guard test that fails if the set of
  config writers grows.
- [ ] Channel projection consumes a branded `ChannelEligible`, so dropping the
  narrow is a compile error rather than a note leak.
- [ ] The document registry owns active-state validation and broadcast.
- [ ] All open paths use one named pipeline with tagged outcomes and no dynamic
  cycle.
- [ ] Annotation mutations cross one deep lifecycle Interface without raw Yjs
  escape hatches at handler call sites.
- [ ] Client actions are lifecycle-bound and promise failures are handled.
- [ ] App document and rail state are testable through small, behavioral
  Interfaces.
- [ ] Tauri concerns live in cohesive modules while startup order remains
  explicit.
- [ ] Diagnostics cannot report unreadable active annotation data as healthy
  and do not perform unbounded request-led scans.
- [ ] Coverage reporting is honest and critical new modules have focused
  regression gates.
- [ ] ADR statuses and `docs/architecture.md` match the final Implementation.

## Deliberately out of scope

- Rewriting large files solely to reduce line counts.
- Introducing dependency-injection frameworks or speculative Adapters.
- Combining the ADR-036 format capability redesign with ADR-034.
- Changing MCP public behavior except where an existing accepted ADR explicitly
  requires it.
- Chasing 100 percent coverage.
- Treating source-text scans or alias-identity tests as substitutes for
  behavioral tests.
