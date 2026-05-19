# Cross-PR Review Summary — Waves D + A–L Redesign Sweep · 2026-05-18

Two-pass review (codex + pr-review-toolkit + situational `svelte-migration-reviewer` / `silent-failure-hunter`) on 7 open PRs forming the redesign-parity stack. Per-PR detail in `pr-review-{N}-2026-05-18.md`.

| PR | Wave | Crit | Imp | Notes file |
|----|------|------|-----|------------|
| #759 | D — outline-only left rail | **1** | 3 | `pr-review-759-2026-05-18.md` |
| #760 | A — chrome polish | 0 | 1 | `pr-review-760-2026-05-18.md` |
| #761 | B — scroll fade masks | **1** | 3 | `pr-review-761-2026-05-18.md` |
| #762 | C — popup shadow | 0 | 0 | `pr-review-762-2026-05-18.md` |
| #763 | F — placeholder + margin hover | 0 | 1 | `pr-review-763-2026-05-18.md` |
| #764 | E — peek panels | 0 | 3 | `pr-review-764-2026-05-18.md` |
| #765 | G–L — sweep | **2** | 5 | `pr-review-765-2026-05-18.md` |

## Critical block (verbatim concatenation)

### PR #759
- **`tests/e2e/settings-models.spec.ts:274` asserts `schemaVersion: 3` but the new v3→v4 migration will produce `4` on a v2-seeded blob — this is the exact cause of the known CI hard-fail.** Fix is one-line: bump assertion to `4`. Verified against branch.

### PR #761
- **MutationObserver scope is too broad — fires `update()` (forcing layout-read) on every keystroke inside descendant inputs / contenteditable / Tiptap decoration patches.** `src/client/actions/scrollFade.svelte.ts:55`. Per-keystroke jank in ChatPanel composer and SettingsModal. *(Note: PR #764 removes the MO entirely. If #764 lands together with or before #761, this is moot. Otherwise backport the fix into #761.)*

### PR #765
- **`tests/e2e/settings-models.spec.ts:273` asserts `schemaVersion: 3` but the chain in this PR climbs v2→v3→v4→v5 — assertion must bump to `5`.** Same flavor as #759's bug but at the terminal version (5, not 4).
- **`tests/client/use-tandem-settings-migration.test.ts:178-179` pins the wrong contract for v99 forward-compat** — asserts named fields (`leftRailTabs`, `rightRailTabs`) flow through, but v5 strips them. Future schema reuse would silently leak. Fix: assert `toBeUndefined()`.

## Recommended merge order + action list

The stack is `master ← #759 (D) ← #760 (A) ← #761 (B) ← #762 (C) ← #763 (F) ← #764 (E)`, plus `#765 (G–L)` rebased onto master containing the union of all six.

**Recommendation:** land the six wave PRs bottom-up with their fixes, then rebase #765 to narrow its diff to G–L only. Squashing the stack into #765 loses per-wave review history and bypasses the per-wave CI signal.

Pre-merge action list, in order:

1. **#759 — Wave D**
   - [REQUIRED] `tests/e2e/settings-models.spec.ts:274`: change `expect(settings?.schemaVersion).toBe(3)` → `toBe(4)`. Single-line.
   - [RECOMMENDED] Add v1/v2 → v4 chain unit tests with displaced left-rail tabs seeded; idempotency test on already-v4 blobs; `rightRailTabs` absent / non-array case.
   - [OPTIONAL] Hoist `LEFT_RAIL_LOCKED` const to avoid fresh array allocation per `mergeAndClampSettings` call.

2. **#760 — Wave A**
   - [DISCUSS] Status-pill `opacity: 0.4` at rest fades interactive text/buttons inside the pill. PR body marks this as Bryan-requested. Confirm intent vs WCAG 1.4.3 concern. Mitigations available: per-control carve-outs via `:has(:focus-visible)`, or rest opacity 0.55+, or independent focus-visible ring.
   - [OPTIONAL] Replace raw px literals (`font-size: 11.5px`, `padding: Npx`, `gap: 3px`) with `--tandem-text-*` / `--tandem-space-*` tokens. Style debt, not a blocker.

3. **#761 — Wave B**
   - [REQUIRED if landing without #764] Drop `characterData: true` + `subtree: true` from the MutationObserver options (or remove the MO entirely — PR #764 does this). Cheapest fix is `{ childList: true }` only.
   - [RECOMMENDED] Add `if (!node.isConnected) return;` guard at top of `update()`.
   - [RECOMMENDED] Wrap observer construction in try/catch with `logError`; ensure `destroy()` tears down whatever did register.
   - [OPTIONAL] Add vitest coverage for the action (jsdom mocks both observers easily — 30-line test).
   - [OPTIONAL] Add `@supports (mask-image: ...)` fallback in `scroll-fade.css`.
   - [OPTIONAL] Rename `.svelte.ts` → `.ts` (no runes in the file).

4. **#762 — Wave C**
   - [NONE required] Eyeball the new `backdrop-filter: saturate(140%) blur(8px)` inheritance from `.tandem-floating-pill` in a browser — it's a new visual effect not present in the pre-PR popup.

5. **#763 — Wave F**
   - [REQUIRED] Fix `MarginColumn.svelte` halo: `drop-shadow(0 0 0 var(--tandem-accent-border))` is invisible. Change to `drop-shadow(0 0 6px var(--tandem-accent-border))` or similar non-zero blur, or delete the line if the soft drop-shadow alone is intended affordance. *(Same bug surfaces in #764 and #765 — fix once where it lands first.)*

6. **#764 — Wave E**
   - [REQUIRED] Right-rail 8px edge-collapse zone occludes the native scrollbar hit area AND the RailTabPicker trigger button's rightmost ~8px. Two viable fixes: narrow the collapse zone, or restrict it to top/bottom edges so the right side (where scrollbar + picker live) is uncovered.
   - [RECOMMENDED] Restore focus to the newly-mounted toggle after keyboard-triggered collapse/expand.
   - [RECOMMENDED] Add `aria-expanded` to PeekStrip.
   - [OPTIONAL] Change PeekStrip + edge-collapse cursor from `e-resize`/`w-resize` to `pointer` — they're click-to-toggle, not drag.
   - [INTERNAL] Note that this PR removes scrollFade's MutationObserver, addressing #761's Critical. If #761 ships first, the perf concern lives until #764 lands — backport or merge together.

7. **#765 — Waves G–L** (rebase onto master after #759–#764 are in)
   - [REQUIRED] `tests/e2e/settings-models.spec.ts:273`: bump assertion to `5` (the chain's new terminal version after Wave I's v4→v5 migration).
   - [REQUIRED] Fix `tests/client/use-tandem-settings-migration.test.ts:178-179` — change `s.leftRailTabs).toEqual(["chat","annotations"])` to `s.leftRailTabs).toBeUndefined()` so we don't pin a contract the migration intends to suppress.
   - [REQUIRED] Verify Wave G TitleBar in `cargo tauri dev`: root has `data-tauri-drag-region` with descendant buttons. Repo memory says this is a known anti-pattern. Either confirm clicks still land on titlebar buttons in production WebView, or restore the sibling pattern from #760 (root attribute-free, drag-region on three sibling spacer divs).
   - [RECOMMENDED] Add unit tests for `src/client/editor/toolbar/handlers.ts` (`applyLink`, `getInitialLinkHref`, `withPreventDefault`) — pure functions, two callers, branchy logic.
   - [RECOMMENDED] Add v4→v5 idempotency test + v2-with-rail-tabs chain test.
   - [OPTIONAL] Gate `FormattingToolbar.svelte`'s 9× `void tick` `$derived` blocks on a coarser signal (`selectionUpdate`) or one parent `editorState` `$derived`.
   - [OPTIONAL] Wrap `linkInputEl` focus in `untrack` or move to action / `onMount` to avoid the dual-fire effect pattern.
   - [OPTIONAL] Add singleton guard to `createLayoutModel` (currently safe — only one consumer — but mirrors the established `useTandemSettings.svelte.ts` pattern).

## Stack-wide patterns

1. **Schema-version assertions in E2E tests are not migration-aware.** Two separate PRs (#759, #765) trip the same `settings-models.spec.ts:~273` assertion because the chain's terminal version changes. **Defensive fix:** replace the literal `.toBe(3)` with `.toBe(LATEST_SCHEMA_VERSION)` imported from the source module, so future v→v+1 migrations don't need to remember to bump the test. File as a follow-up issue.

2. **Migration unit-test coverage is thin at the chain extremes.** Both #759 and #765 had test gaps: missing v1/v2-seed chain tests, missing idempotency, missing `rightRailTabs`-absent paths. The repo could benefit from a parameterised table test `for (const startVersion of [1,2,3,4]) { ... }` that seeds with rail-tabs displaced and asserts the post-migration shape across the full chain. Add to follow-up scope.

3. **The `.tandem-floating-pill` shared recipe is a winner** — Wave C/J both consume it cleanly with one-line surface conversion. The pattern is now established; no rework needed.

4. **Multi-reviewer hallucinations are a real problem on this stack:** three false-positive Criticals were caught (code-reviewer on #760 and #761; svelte-migration-reviewer on #765). Each was verified against branch HEAD before propagating. Per `feedback_pr_review_findings_can_be_wrong.md`: reviewer agents read partial files / infer from diff context / sometimes fabricate tool output. **Always verify load-bearing Criticals against the actual file on the PR branch (not the diff, not master).** This pattern played out exactly as the memory predicted.

5. **`MarginColumn` invisible drop-shadow halo (Wave F #4) is present in #763, #764, and #765.** A single one-line fix lands once in whichever wave merges first; mark the others "deferred to wave-N landing" so we don't fix it three times.

6. **Tauri drag-region pattern is fragile.** PR #760 had a correct sibling layout; PR #765 (Wave G) regresses to root + descendants. The repo memory warns about this pattern. Add a Playwright Tauri smoke test if not present, asserting titlebar button clicks fire (handler ran, panel toggled, etc.) — would have caught this in #765 automatically.

7. **scrollFade action lifecycle:** the MO was added in #761, then removed in #764 after a reviewer-flagged perf concern. Net evolution in two PRs. The chain works, but a sequential merge of #761 alone exposes the regression to master for the merge gap. Either merge #761 + #764 as a group, or backport the MO removal directly into #761 before merge.

## Reviewer-quality observations

- **codex:codex-rescue** — strongest signal on Tauri drag-region (#765 Critical, correctly identified despite contradicting code-reviewer), and on the #759 schema-version cause-of-failure diagnosis. Also produced one false-positive Critical on #760 (drag-region) — verified against branch.
- **pr-review-toolkit:code-reviewer** — two false-positive Criticals (#761 signature; #765 schema-version target). One real Critical (#763 — no, that was direct review). Several solid Suggestions (px-token violations, observability gaps).
- **svelte-migration-reviewer** — one fabricated Critical with hallucinated svelte-check output (#765). Real Critical on #761 MO scope. Generally trustworthy on rune-pattern findings.
- **pr-review-toolkit:pr-test-analyzer** — most reliable across the stack. Caught the #759 + #765 E2E assertion gap (the highest-leverage finding) and the v99 forward-compat contract issue. No false positives.
- **pr-review-toolkit:silent-failure-hunter** — solid on observability gaps. Suggestion-grade signal.

Cross-PR review took 4 hours of agent runtime equivalent. The two highest-leverage findings (Critical #759 E2E + Critical #765 E2E) saved at minimum two CI iterations on merge.

## Open questions for Bryan

1. **Status-pill fade (#760)** — confirmed intentional per PR body. The a11y concern is real but the override is informed. Keep as-is, or apply one of the mitigations? Default: keep.
2. **Right-rail edge-collapse occlusion (#764)** — pick a geometry fix (narrow zone vs. top/bottom-only).
3. **Stack merge strategy** — bottom-up with rebase of #765, or squash into #765? Default recommendation: bottom-up.
4. **Cross-cutting `MarginColumn` halo fix** — should the fix land in #763, #764, or #765? Default: #763 (lowest in stack that touches the file).
