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

## #5 — Selection surface + formatting bar (Sub-PRs: Decorations → Selection)

> **Updated 2026-05-25** with Bryan's explicit sign-off — supersedes the original "secondary, collapsed-by-default formatting controls" resolution. Additive to Conflict #2 (does **not** override the floating-pill visual port).
> **Further updated 2026-05-26** (Bryan): (a) the Decorations split button lives in the **formatting bar**, not the title bar — see [Applied Overrides → Sub-PR 1.13 Decorations placement](#sub-pr-113-decorations-control--placed-in-the-formatting-bar-not-the-title-bar); (b) the annotate-popover keybindings changed from "Note=`⏎` / Send=`⌘⏎`" to **Enter = newline · Alt+Enter = Note to self · Ctrl/Cmd+Enter = Send to Claude** — see [Applied Overrides → Sub-PR 1.11 annotate keybindings](#sub-pr-111-annotate-popover-keybindings--enter-is-a-newline-both-submits-are-modifier-gated). The clauses below reflect the current decision.
> **Further updated 2026-06-03** (Bryan): (c) the **horizontal-rule control is dropped from the popup** (stays on the bar) — a narrow, control-specific lift of the full-mirror clause; see [Applied Overrides → Sub-PR R0](#sub-pr-r0-a8-final--horizontal-rule-dropped-from-the-selection-popup-full-mirror-partially-lifted).

- **Resolution:** The selection popup is **always the full stacked surface** — a format pill (B/I/S/code/link · H/lists/quote/codeblock) over an annotate pill (highlight swatches + an **Annotate** button → anchored note popover) — and it mirrors the **full** formatting-bar control set (including the Decorations split button) even while the bar is visible. The floating formatting bar ported under Conflict #2 is **retained but becomes optional/hideable** via a swap control, governed by a new `formattingBarVisible` setting (default `true`). Decoration display toggles (authorship + per-annotation-type) consolidate into a **Decorations split button in the formatting bar** (eye = mute/restore, caret = per-type options), subsuming the standalone authorship toggle added in sub-PR 1.2.
- **Why:** ADR-027's audience-first model — **Note to self `⏎` vs Send to Claude `⌘⏎`** — stays structurally primary, and the Annotate popover is the default annotation entry point. Bundle's `A8 - Selection Mini-Toolbar.html` is a formatting-only toolbar with no audience awareness, so it is layered in as the format pill rather than replacing the popup. Putting Decorations in the formatting bar is safe even though the bar is hideable: because the selection popup mirrors the full bar control set, the controls remain reachable when the bar is hidden — the popup is the mirror, so no separate title-bar home is needed.
- **Sub-PR constraint:** Audience-first popup is primary and is the default entry point (sub-PR asserts this). `data-testid="popup-*"` selectors stay verbatim. The per-type decoration split (`showComments` / `showHighlights` / `showNotes`) is **display-only** — it never affects ADR-027 (notes are still never read by Claude; it only hides the user's own marks in their own view). No parallel shadow scale (Conflict #2). Ships as two PRs: **Decorations control first**, then **Selection surface + optional bar**.

## #6 — Token Reconciliation (Phase 0c, enforced across all sub-PRs)

- **Resolution:** Production tokens win for shipped colors. Bundle contributes ONLY new tokens that have no production analogue.
- **Why:** Production tokens passed the WCAG AA audit (#556) and the v7 dark-mode pass (#776). Wholesale adoption of the bundle's tokens risks regressing the audit on every surface. The protected-token list in `token-audit.md` is non-negotiable (`--tandem-author-{user,claude}`, `--tandem-claude-focus-{bg,border}`, `--tandem-suggestion*`).
- **Sub-PR constraint:** A bundle color may only appear in production CSS if (a) it has no production equivalent, OR (b) a per-token WCAG re-audit is committed alongside the change.
- **Enforcement status:** the original Phase 0 plan called for `scripts/check-semantic-tokens.ts` to ship a bundle-token blocklist as a CI-blocking mechanical gate. The Phase 0c commit landed the token-audit doc and the protected-token snapshot test but NOT the blocklist extension — building the blocklist requires deriving the exact bundle-color set as a follow-up, tracked in [#799](https://github.com/bloknayrb/tandem/issues/799). Sub-PRs in Phases 1–3 enforce this conflict via the audit doc + reviewer attention rather than a CI block until #799 lands. #799 should ship before Phase 3 starts.

## #7 — Paragraph Authorship Gutter (Sub-PRs 1.3, 1.5, 3.10)

- **Resolution:** Keep the production paragraph-level gutter (`data-tandem-author-block`).
- **Why:** ADR-026 specifies character-level authorship with a paragraph-level aggregation gutter for legibility. The HANDOFF document supports this reading: "the gutter reduces character-level tints to a single dominant indicator at the paragraph level for legibility." Bundle's silence on the gutter reflects scope, not removal intent.
- **Sub-PR constraint:** No PR may remove `data-tandem-author-block` or the gutter CSS. Sub-PR 3.10 (annotation decorations) must document the per-paragraph aggregation policy (last-writer / majority / any-Claude wins) and add unit + visual coverage for mixed-authorship paragraphs.

## #8 — AnnotationCard Architecture (Sub-PR 1.5)

- **Resolution:** Visual-only layer. Preserve the five-file split (`Note/Comment/Suggestion/Highlight/ImportedCard.svelte`) plus dispatcher plus shared chrome (`AnnotationCardActions`, `AnnotationCardHeader`, `AnnotationSnippet`).
- **Why:** ADR-027 codifies audience-first annotation handling. The five-file split is the structural enforcement: Note's render path is intentionally segregated from Comment's so the "Send to Claude" affordance literally cannot leak into a private note's render. Bundle's 68-line single-component demo would re-couple them. Additionally, the taxonomy in `derived-spec.md` is five rows because suggestions are Claude-only — users author notes, comments, and highlights, never suggestions.
- **Sub-PR constraint:** Lift typography/spacing/color from bundle's `AnnotationCard.svelte` into the five production components individually. Keep the dispatcher. Preserve `data-testid="annotation-private-pill"`. Explicitly forbid merging Note + Comment render paths. The `tandem_createAnnotation` server tool should reject a user-authored annotation with `suggestedText` set (filed as a follow-up if not already enforced); the UI must never render a user-authored suggestion.

## #9 — Animation Language Rollout (Phase 4, deferred)

- **Resolution:** Defer the bundle's 9 motion scenes to a follow-up PR series after the umbrella merges. Tracked as [#798](https://github.com/bloknayrb/tandem/issues/798).
- **Why:** Threading motion through every animated surface is roughly equal in scope to the visual re-skin itself. Doing both in one umbrella ~2x the work; the visual surfaces benefit from being in their final shape before motion lands. The umbrella merge is a v1.0-prep milestone; v1.0 GA gates on #798 closing.
- **Sub-PR constraint:** Sub-PRs in Phases 1–3 may use existing motion (don't strip what's there) but should not introduce new animation choreography. `motion.md` (deferred to land alongside #798's pickup) is the canonical reference for future scenes.

---

## Override Protocol

If a sub-PR finds a resolution above is wrong for its specific surface:
1. Surface the divergence in the PR body under a "Conflict resolution override" header.
2. State which conflict ID, the new resolution, and the new rationale.
3. Get explicit reviewer confirmation before merging.
4. Update this document with the override in the same PR.

This is intentionally heavyweight — the default is "follow the locked resolution" so 40+ PRs don't each re-debate the same nine tradeoffs.

---

## Applied Overrides

### Sub-PR 1.13 (Decorations control) — placed in the formatting bar, not the title bar

- **What changed:** Conflict #5 (as updated 2026-05-25) located the Decorations split button in the **title bar**, reasoning that authorship needed a non-hideable home once the formatting bar became optional. On 2026-05-26 Bryan directed it into the **formatting bar** instead, and confirmed the standalone authorship toggle (`formatbar-authorship-toggle`, added in 1.2) is **subsumed** into the Decorations dropdown's authorship row.
- **Why this is consistent, not a regression of the hideable-bar feature:** the same Conflict #5 update already specifies that the selection popup mirrors the **full** formatting-bar control set even when the bar is visible (sub-PR 1.11's D1). So when the bar is hidden, the Decorations control is still reachable via the popup — the popup is the mirror, which removes the original reason for a title-bar home. The hideable-bar feature (1.11's D3) survives unchanged.
- **Scope guardrails still hold:** display-only; ADR-027 untouched (notes never read by Claude); no `src/server/` changes; all `decorations-*` testids preserved (only the now-redundant `formatbar-authorship-toggle` is removed, its E2E coverage relocated to assert the Decorations control). The control is mounted outside the bar's `overflow:hidden` track so its dropdown is never clipped.
- **Downstream:** sub-PR 1.11's plan (`docs/plans/2026-05-25-1.11-selection-surface.md`) D1 now includes Decorations in the popup mirror, and D4 changes from "remove authorship from the bar" to "authorship is already subsumed into the bar's Decorations control" (no separate removal step).

### Sub-PR 1.11 (annotate popover keybindings) — Enter is a newline; both submits are modifier-gated

- **What changed:** Conflict #5's original keybinding clause locked **Note to self = `⏎`** / **Send to Claude = `⌘⏎`** (plain Enter committed a private note; Shift+Enter was the newline). On 2026-05-26 Bryan directed the scheme to: **plain `Enter` = newline inside the annotation textarea** (no submit), **`Alt+Enter` = Note to self**, **`Ctrl+Enter`/`⌘Enter` = Send to Claude**.
- **Why this is an improvement, not just a swap:** the original inversion ("Enter = private note") carried a documented missed-send risk (a user with send-muscle-memory hits Enter and silently gets a private note Claude never receives — sub-PR 1.11 D2's MED mitigation). Making **both** submit actions modifier-gated and Enter a literal newline removes that failure mode entirely: an accidental Enter now just inserts a line break, costing nothing. It also matches the conventional "Enter = newline in a multiline field, modifier+Enter = submit" affordance, so it's more discoverable, not less.
- **Scope guardrails still hold:** ADR-027's audience-first model stays structurally primary (Note=private, Comment=outbound at the data layer — only the *key* that triggers each changes); the annotate popover is still the default annotation entry point; display/UI only; no `src/server/` change; `popup-note-submit` / `popup-comment-submit` testids preserved verbatim (only the visible label/keyhint and the key handler change). The empty-content guard on **both** submit paths is mandatory (an empty Alt+Enter or Ctrl+Enter must be a no-op), and both buttons render their key hint (`⌥⏎ Note to self`, `⌘⏎ Send to Claude`) so the mapping is discoverable.

### Sub-PR R0 (A8 final) — horizontal-rule dropped from the selection popup (full-mirror partially lifted)

- **What changed:** Conflict #5's resolution specifies the popup mirrors the **full** formatting-bar control set. On 2026-06-03 Bryan directed that the **horizontal-rule control be dropped from the selection popup** ("we can drop hr from the selected text popup, since it makes little sense that a user would want to use it in that context"). The `—` button is now gated to `variant === "bar"` in `FormattingToolbar.svelte`, so it stays on the persistent formatting bar but no longer appears in the popup.
- **Why this is consistent, not a regression of reachability:** the full-mirror's purpose is that every control stays *reachable when the bar is hidden*. Inserting a horizontal rule requires a **caret position**, not a **text selection** — and the popup only ever appears over a non-empty selection, where "replace the selection with an `<hr>`" is a semantically incoherent action. So hr was never a meaningful popup affordance; dropping it removes noise, not capability. hr remains on the bar and via any caret-context entry. This is a *narrow, control-specific* lift of the full-mirror clause, not a reversal of it — every other bar control (marks, blocks, Decorations, swap) still mirrors into the popup.
- **Scope guardrails still hold:** client-only, no `src/server/` change; the hr button carries no `data-testid` (no test contract broken) and has zero annotation-model coupling (`setHorizontalRule()` is a pure ProseMirror node command); all `popup-*` testids preserved; ADR-027 and the suggestion-authoring guard untouched. Verified by the svelte / crdt / annotation-model plan reviewers (annotation-model: CLEAN).
- **Downstream:** sub-PR 1.11's plan (`docs/plans/2026-05-25-1.11-selection-surface.md`) D2 + concrete-edit #2 + the test section are updated to this scheme; the old D2 "missed-send risk (MED)" mitigation is now moot (Enter doesn't submit) and is recorded as resolved rather than carried.

### Sub-PR 1.9 (NewTabMenu) — elevated "clean port" → full feature rebuild

- **What changed:** the master plan labeled 1.9 a "clean port," but the bundle's `a7-new-tab` is a structurally richer two-column **searchable launcher** (search/filter, recent metadata + "when" timestamp, reopen-last-closed, from-clipboard, keyboard footer) than production's simple recents dropdown. On 2026-05-25 Bryan explicitly chose a **full feature rebuild** over a visual-only restyle.
- **Why this is an override:** it intentionally breaks Phase 1's "visual-only / no `src/server`" rule. So a future reader doesn't mistake it for an accidental scope violation: the recents-with-timestamps schema change (1.9a) and the launcher feature work (1.9b) are sanctioned. Exploration found the feature is achievable almost entirely client-side (recents are client `localStorage`; closed-tab history already exists in `useClosedTabStack`; clipboard import reuses the existing `/api/upload` ingestion) — so in practice `src/server` is untouched, but the *intent* exceeds visual-only.
- **Scope guardrails still hold:** all existing testids preserved; clipboard content flows through the existing sanitization-equivalent ingestion (security-reviewed); no server route added.
- **Update 2026-05-25:** the from-clipboard import was dropped from 1.9b ("lets drop it for now and move on" — Bryan). The launcher ships search/filter, recent metadata + "when", and reopen-last-closed; clipboard import is shelved (not deferred to a tracked issue).

### Sub-PR 1.10 (Toasts → Activity Center) — elevated "clean port" → full feature

- **What changed:** the master plan labeled 1.10 a "clean port" of the transient toast stack, but the bundle's `d1-toasts` is an **activity center** — a persistent, expandable notification tray (collapsed pill → scrollable history with coalesce counts, relative time, per-row dismiss, and "Clear all") alongside the brief transient pops. On 2026-05-25 Bryan chose the **full activity center** (tray + persistence + action infra) over a visual-only restyle, and set three sub-decisions: (1) warning/error still POP transiently AND land in the tray; info goes quiet-to-tray; (2) the tray persists across reload (localStorage); (3) info-pop is gated by **entry point** — client echoes pop, ambient SSE info stays quiet.
- **Why this is an override:** like 1.9, the *intent* exceeds Phase 1's "visual-only" rule. In practice it stays client-only: `TandemNotification`'s fixed `type` union already lets the client derive actions (Retry-for-`save-error` lands in 1.10b), so **no `src/server/` change** was needed.
- **Scope guardrails still hold:** the `NotificationsState` interface (`toasts`/`dismiss`/`push`) is preserved verbatim so App.svelte's ~10 call sites and the test harness keep working; all transient `toast-*` testids preserved; no new color tokens (reuses info/warning/error families); the bundle's trayIn/rowIn/ledpulse animations are deferred to #798 per Conflict #9 (shipped static).
- **1.10b (Retry action):** the tray's per-row action button is wired for `save-error` → **Retry** only (re-run the failed doc's save). **Undo is deferred** — no production notification has a safe revert semantic (they're post-hoc). A closed-doc Retry surfaces a "reopen to retry" notice rather than silently no-opping. Still client-only.
