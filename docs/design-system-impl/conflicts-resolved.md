# Conflicts Resolved — Tandem Design System Impl Umbrella

Locked Phase 0g of the design-system-impl plan (`feat/design-system-impl`). Every sub-PR references this document instead of re-litigating the tradeoffs.

All nine conflicts default to **Option A** from the plan. If a sub-PR believes a different resolution is needed for its specific surface, it must raise the divergence in the PR body and get explicit confirmation before changing the resolution.

Conventions used below:
- **Resolution** — the locked choice.
- **Why** — the load-bearing reason, stated tersely so future-you can re-derive the decision.
- **Sub-PR constraint** — the rule downstream PRs must follow.

---

## #1 — TitleBar (Sub-PR 1.1)

- **Resolution:** Layer bundle visuals onto the production `src/client/shell/TitleBar.svelte`.
- **Why:** Production wires tauri-plugin-decorum, macOS traffic-light spacing, Windows drag-region, default-model display, mode toggle, and the document tab strip (PR #602, v0.11.1). The bundle's `ui_kits/app/TitleBar.svelte` is a ~90-line visual mockup with no platform logic. Wholesale replacement regresses window chrome on every desktop platform.
- **Sub-PR constraint:** Keep all production Tauri integration intact. Update markup/CSS only to match bundle typography, spacing, and color treatment. No removal of `tauri-plugin-decorum` calls, drag-region handlers, or platform-conditional CSS. `data-testid="titlebar-*"` selectors per the testid manifest stay verbatim.

## #2 — FormatBar / Toolbar (Sub-PR 1.2)

- **Resolution:** Layer bundle visuals onto the production floating-pill recipe.
- **Why:** Waves 3–8 (#587, #588, #548, #740, #752, #755, #762) shipped the `tandem-floating-pill`, HighlightColorPicker integration, undo/redo, heading dropdown, and the audience-first selection popup (ADR-027). Bundle's `ui_kits/app/FormatBar.svelte` is a visual demo with no audience awareness. Replacing it wholesale regresses ADR-027.
- **Sub-PR constraint:** Preserve the audience-first selection popup behavior end-to-end. Preserve the HighlightColorPicker. Update spacing/typography/color only. Reuse `tandem-floating-pill` recipe — do not introduce a parallel shadow scale.

## #3 — CommandPalette (Sub-PR 1.6)

- **Resolution:** Layer bundle visuals onto the production component.
- **Why:** PR #575 shipped the full action registry (query routing for `#/@/?/>`); Wave 10 (#757) added floating-pill polish. Bundle's `CommandPalette.svelte` is a 78-line demo. The registry is the value; the visual is the gap.
- **Sub-PR constraint:** Action registry contract is frozen for this sub-PR. Visual updates only. Keyboard-hint footer must remain.

## #4 — Settings (Sub-PR 1.7)

- **Resolution:** Layer bundle visuals onto the production responsive shell.
- **Why:** Wave 9 (#745) shipped narrow-viewport hamburger; #659 added the Models tab with wizard sub-flows; the tab registry contract is consumed by 5+ tab components. Bundle's `Settings.svelte` (197 lines, 8 sections) is a single non-responsive layout that drops both the hamburger and the Models wizard scaffolding.
- **Sub-PR constraint:** Responsive shell + tab registry contract are frozen. Visual updates only to tab content and the section list. Models tab wizard sub-flows untouched in this PR.

## #5 — Selection Mini-Toolbar (Sub-PR 1.11)

- **Resolution:** Keep the production audience-first popup. Layer the bundle's formatting controls into a secondary affordance.
- **Why:** ADR-027's audience-first model ("Note to self ⏎ vs Send to Claude ⌘⏎") is structurally central to Tandem's annotation system. Bundle's `A8 - Selection Mini-Toolbar.html` is a formatting-focused toolbar with no audience awareness. Replacement regresses ADR-027.
- **Sub-PR constraint:** Audience popup is primary; formatting controls are secondary (collapsed by default, expandable). Sub-PR must add an explicit assertion that the audience-first popup is the default entry point. `data-testid="popup-*"` selectors stay verbatim.

## #6 — Token Reconciliation (Phase 0c, enforced across all sub-PRs)

- **Resolution:** Production tokens win for shipped colors. Bundle contributes ONLY new tokens that have no production analogue.
- **Why:** Production tokens passed the WCAG AA audit (#556) and the v7 dark-mode pass (#776). Wholesale adoption of the bundle's tokens risks regressing the audit on every surface. The protected-token list in `token-audit.md` is non-negotiable (`--tandem-author-{user,claude}`, `--tandem-claude-focus-{bg,border}`, `--tandem-suggestion*`).
- **Sub-PR constraint:** A bundle color may only appear in production CSS if (a) it has no production equivalent, OR (b) a per-token WCAG re-audit is committed alongside the change. The `check-semantic-tokens.ts` extension (Phase 0c) enforces the blocklist mechanically; the gate is CI-blocking, not advisory.

## #7 — Paragraph Authorship Gutter (Sub-PRs 1.3, 1.5, 3.10)

- **Resolution:** Keep the production paragraph-level gutter (`data-tandem-author-block`).
- **Why:** ADR-026 specifies character-level authorship with a paragraph-level aggregation gutter for legibility. The HANDOFF document supports this reading: "the gutter reduces character-level tints to a single dominant indicator at the paragraph level for legibility." Bundle's silence on the gutter reflects scope, not removal intent.
- **Sub-PR constraint:** No PR may remove `data-tandem-author-block` or the gutter CSS. Sub-PR 3.10 (annotation decorations) must document the per-paragraph aggregation policy (last-writer / majority / any-Claude wins) and add unit + visual coverage for mixed-authorship paragraphs.

## #8 — AnnotationCard Architecture (Sub-PR 1.5)

- **Resolution:** Visual-only layer. Preserve the five-file split (`Note/Comment/Suggestion/Highlight/ImportedCard.svelte`) plus dispatcher plus shared chrome (`AnnotationCardActions`, `AnnotationCardHeader`, `AnnotationSnippet`).
- **Why:** ADR-027 codifies audience-first annotation handling. The five-file split is the structural enforcement: Note's render path is intentionally segregated from Comment's so the "Send to Claude" affordance literally cannot leak into a private note's render. Bundle's 68-line single-component demo would re-couple them. Additionally, the taxonomy in `derived-spec.md` is five rows because suggestions are Claude-only — users author notes, comments, and highlights, never suggestions.
- **Sub-PR constraint:** Lift typography/spacing/color from bundle's `AnnotationCard.svelte` into the five production components individually. Keep the dispatcher. Preserve `data-testid="annotation-private-pill"`. Explicitly forbid merging Note + Comment render paths. The `tandem_createAnnotation` server tool should reject a user-authored annotation with `suggestedText` set (filed as a follow-up if not already enforced); the UI must never render a user-authored suggestion.

## #9 — Animation Language Rollout (Phase 4, deferred)

- **Resolution:** Defer the bundle's 9 motion scenes to a follow-up PR series after the umbrella merges.
- **Why:** Threading motion through every animated surface is roughly equal in scope to the visual re-skin itself. Doing both in one umbrella ~2x the work; the visual surfaces benefit from being in their final shape before motion lands. Phase 0k filed the follow-up tracking issue.
- **Sub-PR constraint:** Sub-PRs in Phases 1–3 may use existing motion (don't strip what's there) but should not introduce new animation choreography. `motion.md` (Phase 0, deferred to alongside this work) is the canonical reference for future scenes.

---

## Override Protocol

If a sub-PR finds a resolution above is wrong for its specific surface:
1. Surface the divergence in the PR body under a "Conflict resolution override" header.
2. State which conflict ID, the new resolution, and the new rationale.
3. Get explicit reviewer confirmation before merging.
4. Update this document with the override in the same PR.

This is intentionally heavyweight — the default is "follow the locked resolution" so 40+ PRs don't each re-debate the same nine tradeoffs.
