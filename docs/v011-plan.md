# v0.11.0 Implementation Plan: Dark Theme + UI Polish

## Context

AR1/AR2/AR3 shipped (PRs #583/#586/#590, 2026-05-10). v0.10.0 completed the full React-to-Svelte 5 migration. The codebase is stable and the current branch (`feat/redesign-bundle-2-ar2`) is at parity with master. v0.11.0 is the next milestone: dark theme verification, toolbar polish, annotation correctness fixes, and selective new features.

This plan was reviewed by three independent agents (architecture, testing, Codex) before finalization. Findings are incorporated inline.

---

## Pre-Work: Hotfixes (Ship Before v0.11.0 Development)

**v0.10.1** — Plugin URL + auth resolution (`resolveTandemUrl`, `resolveAuthToken`, ADR-028). Independent of v0.11.0. Ship immediately.

**v0.10.2** — Cowork real-time push + `plugin.json` userConfig. Gated on Sub-task D (monitor spawn in Cowork VM). Ship when spike confirms; do not hold v0.11.0.

---

## Pre-Work: Triage Pass

Before committing effort, verify these issues are still open/actionable:

| Issue | Check | Likely Outcome |
|-------|-------|----------------|
| #581 | Layout modes removed in PR #580; test is `test.skip` | Close; fold dead code cleanup into Batch F |
| #507 | `ErrorBoundary.svelte` already has capped recovery, `SuccessHook`, `errorSessionId` | Likely closeable with targeted E2E test |
| #513, #515, #516, #517, #522 | Roadmap: "blocked on #518-#521, all now shipped" | Quick `gh issue view` each; close if resolved |
| #492 | `highlight-toggle.ts` may already implement toggle-off | Verify; close or add to Batch B |

---

## Batch A: Annotation Correctness (S, ~1 day)

**Issues:** #584, #585

These are the highest-priority fixes because they affect data correctness.

### PR A1 — #585: Eliminate `audience-derived` console flood

**Root cause (confirmed by architecture review):** Every annotation in the system was written without an `audience` field. `sanitizeAnnotation` (line 83) emits `{ kind: "audience-derived" }` on every read. Server-side `migration-log.ts` deduplicates, but client-side callsites in `annotation.ts:29`, `yjsSync.svelte.ts:104`, `SidePanel.svelte:210,236` use bare `console.warn`.

**Fix — Combined Option A+B (write `audience` at creation + silence derived event):**
- **Option B (hygiene):** Add `audience: "private"` to highlight/note creation in `Toolbar.svelte` (lines 168-179). Add `audience: "outbound"` to comment creation in `Toolbar.svelte` and `createAnnotation` in `annotations.ts` (lines 236-247). New annotations never trigger the derivation path.
- **Option A (silence legacy):** Remove `audience-derived` from `SanitizationEvent` and `LegacyMigrationKind`. Deriving audience is normative behavior, not a lossy rewrite — it shouldn't fire as a migration event. Also remove from `relaySanitizationEvent` in `migration-log.ts` (lines 87-88). These must stay in lockstep per the comment at `sanitize.ts` lines 13-15.
- Combined, this fixes both new AND legacy annotations. No console flood at all.
- Extend `tests/shared/sanitize-ar1.test.ts` to verify no `audience-derived` events are emitted

**Files:** `src/client/editor/toolbar/Toolbar.svelte`, `src/server/mcp/annotations.ts`, `src/shared/sanitize.ts`, `tests/shared/sanitize-ar1.test.ts`

### PR A2 — #584: Prevent audience conflict on user notes/highlights

**Guard scope (per architecture review):** Only `author === "user"` notes/highlights must be forced `private`. Import-promoted comments (`author: "import"`, promoted from note to comment at sanitize.ts:134-137) must remain `outbound`-eligible.

**Sanitize ordering (per testing review, memory `feedback_sanitize_ordering_shadow`):** New guard branch MUST land before line 139 (flag/note early return) or it gets shadowed.

**Fix:** In `sanitizeAnnotation`, after the audience-derivation block (line 84), add:
```ts
if (ann.audience === "outbound" && ann.author === "user" && (ann.type === "note" || ann.type === "highlight")) {
  ann.audience = "private";
  events.push({ kind: "audience-conflict-resolved" });
}
```

**Files:** `src/shared/sanitize.ts`, `tests/shared/sanitize-ar1.test.ts`

**Verification:** Unit tests for both sanitize paths. Manual: open doc with legacy annotations, confirm no console flood. Confirm notes cannot have `audience:outbound`.

---

## Batch B: Toolbar + Selection UI Polish (M, ~2-3 days)

**Sequencing correction (per Codex review):** Only #548 depends on the dismiss utility (#589). #587 and #588 use existing plumbing and can start immediately.

### PR B1 — #588: ToolbarButton for B/I in selection popup (S)
- Parallelize with everything
- **E2E contract (per testing review):** `toolbar-redesign.spec.ts` locates Bold/Italic by `aria-label="Bold"` / `aria-label="Italic"` at 7 locations. Refactored `ToolbarButton` MUST produce identical aria-labels.
- **Files:** `src/client/editor/toolbar/Toolbar.svelte`

### PR B2 — #587: Move authorship toggle to main toolbar (S)
- Parallelize with everything
- Move from `AccessibilitySettings.svelte` (line 23) to toolbar right cluster
- **Guard (per architecture review):** Verify `App.svelte` lines 138-144 `_lastAuthorshipVisible` guard survives; the `$effect` → `setMeta` chain must not trigger `effect_update_depth_exceeded`
- Add `data-testid="toolbar-authorship-toggle"` to CLAUDE.md testid list
- **Files:** `src/client/editor/toolbar/Toolbar.svelte`, `src/client/panels/AccessibilitySettings.svelte`, `src/client/App.svelte`

### PR B3 — #589 + #548: Dismiss utility + inline link input (M)
- Bundle into one PR: the utility is only useful with the link input consumer
- **Scope (per architecture review):** Extract a `clickOutside` Svelte action, not a broad "dismiss utility." Toolbar's scroll/resize dismiss is lifecycle-specific and doesn't share the pattern.
- Replace `window.prompt("Enter URL:")` at `FormattingToolbar.svelte:137` with inline `InputGroup`-style input
- **Design decision needed:** Does inline input support edit-existing-link (populate with current href) or preserve remove-on-click behavior? Recommend: support edit (read `editor.getAttributes('link').href`).
- **E2E (per testing review):** `toolbar-redesign.spec.ts:159` explicitly asserts Link button is NOT visible. This assertion must be updated when the inline link UI is added. Update the block comment at lines 156-159 too.
- Add `data-testid="toolbar-link-input"`, `toolbar-link-submit`, `toolbar-link-cancel`
- **Files:** New `src/client/actions/clickOutside.svelte.ts`, `src/client/editor/toolbar/FormattingToolbar.svelte`, `tests/e2e/toolbar-redesign.spec.ts`

**Verification:** E2E extensions to `toolbar-redesign.spec.ts`. Browser automation for visual positioning check.

---

## Batch C: Dark Theme + WCAG AA (M, ~2-3 days)

**Grouping correction (per Codex review):** Split runtime/platform bugs from token audit.

### PR C1 — Dark mode WCAG AA audit + token fixes (M)
- Token infrastructure is complete (`index.html` has full `[data-theme="dark"]` block)
- **Existing automation (per testing review):** `tests/e2e/accessibility.spec.ts` already runs `@axe-core/playwright` in both themes. Extends to new chrome elements.
- **Manual gap:** axe excludes `[contenteditable]` / `.ProseMirror` — authorship colors, annotation underlines, highlight-on-content contrast are manual-only
- **Verification pattern (per testing review):** Use computed-style probes from `redesign-final-qa.spec.ts:253-321` (reads `getComputedStyle(el).borderColor` dark vs light, asserts inequality). NOT screenshots — screenshots fail silently in CI.
- Run `npm run check:tokens` to catch raw hex regressions
- **Files:** `index.html`, various `src/client/` components, `tests/e2e/accessibility.spec.ts`, `tests/e2e/redesign-final-qa.spec.ts`

### PR C2 — Theme/platform bugs: #551, #535, #536 (S-M)
- **#551:** Browser `<meta name="theme-color">` follows taskbar, not app mode. Fix: reactive meta tag update when `data-theme` changes. This is a browser-shell/meta sync issue, not a token issue.
- **#535, #536:** Theme edge cases in specific components
- **Files:** `index.html`, `src/client/hooks/useTheme.svelte.ts`

### PR C3 — #541: Disable browser reload shortcuts in Tauri (S)
- Runtime/platform concern, separate from theme tokens
- Tauri capability or JS injection in `src-tauri/`
- **Cannot be automated in CI** — requires manual `cargo tauri dev` verification with documented checklist
- **Files:** `src-tauri/capabilities/desktop.json` or `src-tauri/src/lib.rs`

**Verification:** axe spec extensions, computed-style probes, manual Tauri checklist for C3.

---

## Batch D: Independent UI Features (M-L, ~3-5 days)

All four PRs are independent and can be worked by parallel agents.

### PR D1 — #506: Browser warning banner for store readonly (M)
- `ReviewOnlyBanner.svelte` already exists with testids `review-only-banner`, `review-only-dismiss`, `convert-to-markdown-btn`
- **Gap (per testing review):** Zero E2E tests for this component. Need: open file with `readOnly: true`, confirm banner visible, click dismiss, reload, confirm persistence via `localStorage` key `tandem:reviewOnlyBannerDismissed`
- Needs: broadcast `storeReadOnly` via Y.Map to browser
- **Files:** `src/client/components/ReviewOnlyBanner.svelte`, `src/server/mcp/document-service.ts`

### PR D2 — #457: Documentation available from settings (S-M)
- Net-new feature. Add "Documentation" button to settings popover that opens bundled docs as read-only tab via `POST /api/open` (same pattern as "View Changelog")
- Lowest priority in v0.11.0 — cut if time is tight
- **Files:** `src/client/panels/SettingsPopover.svelte`

### PR D3 — #479: Internal links open within Tandem (M)
- Tiptap link-click handler intercept for relative `.md`/`.txt` links
- Path resolution relative to current document's `filePath`
- Call `POST /api/open` with resolved path
- **Guard:** File-existence check before opening; only intercept `.md`/`.txt`/`.html` relative links; absolute URLs open in default browser
- **E2E (per testing review):** Fixture infra is adequate (`createFixtureDir` supports multi-file). Need fixture with a relative link and assertion that clicking opens a new tab.
- **Files:** `src/client/editor/Editor.svelte` or Tiptap extension, `tests/e2e/` new spec

### PR D4 — #475: Temporary scratchpad (L, SPIKE FIRST)

**Risk: HIGH** — confirmed by all three reviewers.

**Spike deliverables (per architecture review, must answer before implementation):**

1. **OpenDoc model:** `document-service.ts:32` requires `filePath: string`. Scratchpad needs either a synthetic path (like `upload://` prefix) or a new `source: "scratchpad"` discriminant. Recommendation: model as ephemeral `source: "upload"` with synthetic path `scratchpad://untitled` — reuses existing `saveDocumentToDisk` skip for non-disk docs.

2. **Session restore:** `restoreOpenDocuments` at `document-service.ts:383` iterates session files. Scratchpad must be excluded or startup tries to re-open a non-existent path. Need explicit filter in restore loop.

3. **Document ID:** `docIdFromPath` produces a hash, not a literal string. Use `docIdFromPath("scratchpad://untitled")` to get a stable hash, not a magic `__scratchpad__` string — avoids special-casing `getShouldKeepDocument` sentinel (currently only `CTRL_ROOM`).

4. **Open-doc broadcast:** Will scratchpad appear in the tab bar and document-switch UI via `broadcastOpenDocs`? Probably yes — it's a normal tab. But channel events should not surface it to Claude.

**No descope — this is mandatory for v0.11.0.** Spike identifies the approach; implementation follows regardless of effort.

**Files:** `src/server/mcp/document-service.ts`, `src/server/mcp/document-model.ts`, `src/server/mcp/file-opener.ts`, `src/client/editor/DocumentTabs.svelte`

---

## Batch E: QA Closeout + Dead Code Cleanup (S, ~0.5 day)

- Delete skipped layout-switching E2E test (#581)
- Remove stale `data-testid="layout-*"` references
- Verify/close release QA issues (#513-#522)
- Add ErrorBoundary E2E test if #507 implementation is confirmed complete
- **Deletion criteria (per testing review):** Grep for `test.skip`, `SKIP`, tests referencing removed component names. Distinguish "stale because feature changed" from "intentional regression lock."

**Files:** `tests/e2e/`, CLAUDE.md testid list updates

---

## Execution Order + Critical Path

```
                    ┌─── PR B1 (#588 ToolbarButton B/I) ───┐
                    ├─── PR B2 (#587 authorship toggle) ───┤
Batch A (#584,#585) ┤                                       ├─→ Batch E (cleanup) → v0.11.0
                    ├─── PR B3 (#589+#548 dismiss+link) ───┤
                    ├─── PR C1 (WCAG AA audit) ─────────────┤
                    ├─── PR C2 (#551,#535,#536 theme) ──────┤
                    ├─── PR C3 (#541 Tauri reload) ─────────┤
                    ├─── PR D1 (#506 readonly banner) ──────┤
                    ├─── PR D2 (#457 docs in settings) ─────┤
                    ├─── PR D3 (#479 internal links) ───────┤
                    └─── PR D4 (#475 spike → impl) ─────────┘
```

**Critical path:** Batch A (correctness fixes, ~1 day) → PR B3 (#548 depends on dismiss utility). Everything else is fully parallel.

**Rebase constraint:** Batch A and Batch B both edit `Toolbar.svelte` (A touches creation literals at lines 168-179; B1/B2/B3 restructure the component). A ships first; all B PRs rebase on master after A merges.

**Longest pole:** PR D4 (#475 scratchpad) if spike succeeds — ~2-3 days. If spike fails descope trigger, the milestone shortens.

---

## Effort Summary

| Batch | Issues | Size | Days | Serial? |
|-------|--------|------|------|---------|
| A: Annotation correctness | #584, #585 | S | 1 | Yes (first) |
| B: Toolbar polish | #588, #587, #589+#548 | M | 2-3 | B1/B2 parallel with A; B3 after A |
| C: Dark theme | #59, #551, #535, #536, #541 | M | 2-3 | Parallel with A/B |
| D: UI features | #506, #457, #479, #475 | M-L | 3-5 | All parallel |
| E: QA closeout | #581, #507, #513-#522 | S | 0.5 | After all batches |

**Total: ~10-14 calendar days** with subagent parallelization. Serial path (A → B3) is ~3 days.

---

## Risks

| Risk | Severity | Mitigation |
|------|----------|-----------|
| #475 scratchpad session coupling | HIGH | Spike first; descope if >2 days |
| #548 inline link focus management | MEDIUM | Follow InputGroup pattern; edit-existing-link UX decision upfront |
| #584 sanitize ordering shadow | MEDIUM | New branch before line 139; import-promotion must stay outbound-eligible |
| Tauri theme bugs (#551, #541) can't be CI-verified | MEDIUM | Manual checklist; document repro steps |
| toolbar-redesign.spec.ts:159 Link negative assertion | MEDIUM | Update assertion + block comment in B3 PR |
| Bold/Italic aria-label contract (7 test locations) | MEDIUM | Verify identical aria-labels after ToolbarButton refactor |

---

## Descope Recommendations

**All features are committed for v0.11.0.** #475 (scratchpad) is mandatory despite HIGH risk. #457 and #506 are in scope. No descope triggers — v0.11.0 ships when all batches are complete.

**Pull into v0.11.0:**
- #492 (re-highlight toggle) — verify if already implemented in `highlight-toggle.ts`; close or fix

**Do NOT pull in:**
- #244 (Windows Playwright deadlock) — CI workaround exists
- #433 (Cowork TOCTOU) — v0.13.0, needs macOS/Linux hardware

---

## Verification Gates (All PRs)

| Gate | Tool | Notes |
|------|------|-------|
| Typecheck | `npm run typecheck` | All PRs |
| Unit tests | `npm test` | All PRs, especially sanitize paths |
| Token lint | `npm run check:tokens` | Batch C mandatory |
| E2E | `npm run test:e2e` | All PRs |
| axe accessibility | `tests/e2e/accessibility.spec.ts` | Batch C, extend for new chrome |
| Computed-style probes | `redesign-final-qa.spec.ts:253-321` pattern | Batch C token regressions |
| Browser automation | claude-in-chrome | Batch B visual checks, Batch C dark mode spot-check |
| Tauri manual | `cargo tauri dev` | PR C3 (#541), PR C2 (#551) — documented checklist |
| Pre-commit hooks | Biome + token lint | Automatic on all PRs |

---

## Post-Approval

1. Copy this plan to `docs/v011-plan.md` (per `feedback_save_plans_to_repo` — significant plans belong in the repo)
2. File any deferred items as GitHub issues if not already tracked
3. Begin with triage pass, then Batch A
