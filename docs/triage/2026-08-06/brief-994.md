# Global context-menu policy for app chrome

**Issues:** #994, #1262 **Decision needed:** Do we adopt the allowlist policy (suppress the WebView menu everywhere by default, opt back in for text-bearing surfaces) — yes or no?

## What these are

Filed 2026-06-03, `enhancement` + `needs-design-decision`. Right-clicking anywhere outside the #923-owned surfaces yields the browser's generic Reload/Back/Inspect menu.

Verified today:
- `prevent_default_flags()` returns exactly `Flags::RELOAD` (`src-tauri/src/lib.rs:2687–2688`) — right-click is deliberately preserved app-wide, with no `debug_assertions` gate, so this reaches production.
- There is no global client `contextmenu` policy; handlers exist only where the #923 work put them.

**The body has drifted on surface count.** It says two surfaces (editor #972, tabs #980). There are **three** — Phase 3 added annotation cards in both the right rail and the margin view (`c76d8ba`; `src/client/panels/annotation-context-menu-host.ts`, `SidePanel.svelte`, `MarginColumn.svelte`). That matters, because #994's "keep the default menu so Copy survives" bucket lists annotation-card text — those cards now ship a native **Copy text** item, so they belong in the *suppress* bucket, not the keep bucket. The allowlist that remains is chat messages plus real `<input>`/`<textarea>`, which is a much shorter list than the issue implies.

## Why they stalled

The issue asks the reader to enumerate every text-selectable surface in the app before the first line of code, and warns that missing one silently breaks Copy. That is an unbounded audit gated on nothing, so it never started. Phase 3 has since shrunk it without anyone updating the issue.

## Options

1. **Allowlist (issue's option 1).** Capture-phase `contextmenu` listener, default `preventDefault()`, opt in via `closest()` for the editor (the macOS Look-Up passthrough at `install.ts:78–81` must be excluded *entirely*), inputs, `[contenteditable]`, and a `data-allow-context-menu` marker on chat text. One module, testable. Risk: a missed surface loses Copy.
2. **Suppress-list.** `preventDefault` only on named chrome. Never breaks Copy; scattered, and every new chrome element re-opens the bug.
3. **Close as cosmetic.**

## Recommendation

**Option 1.** Post-Phase-3 the allowlist is short enough to enumerate honestly, and it makes "polished by default" the default state. Do **not** use `Flags::CONTEXT_MENU` — it would kill the passthrough the editor depends on.

Treat #992, #994 and #997 as **one decision**: how much more to invest in the #923 native-menu surface. My combined position — do #994 (real polish, bounded), do #992 (small, with the Windows caveat in `brief-992.md`), close #997 in favour of extending the existing menu (`brief-997.md`).

## If yes / If no

**Yes:** one client module + per-surface markers + unit tests asserting the editor and inputs are exempt. No Rust change.
**No:** the browser menu stays on window controls and the brand icon in shipped desktop builds.

---

## Rider: #1262 Settings taxonomy

Filed 2026-08-02, unlabelled, one sentence: *"Editor Font settings can go under 'Editor' instead of 'Appearance'."*

Current state (`SettingsModal.svelte:120–176` — tabs: Appearance, Editor, Network, Accessibility, Collaboration, AI Assistant, Models, Shortcuts, License, About). **Appearance** carries Theme, Default Tab, Text Size, Accent Color, Editor Font, Font by File Type, Spacing Density, Decorations, plus *Show formatting bar*, *Show raw markdown*, *Uniform tab width*. **Editor** carries only Reading Measure, Default Save Folder, Smart typography, Spellcheck. Editor is nearly empty while Appearance is a dumping ground.

**Question:** should the split be *"Appearance = how the app looks; Editor = how the document behaves and reads"* — moving Editor Font, Font by File Type and Show raw markdown into Editor, and leaving Theme, Text Size, Accent Color, Spacing Density, Decorations, Default Tab, Show formatting bar and Uniform tab width in Appearance?

**Recommended:** yes, exactly that. Fonts and raw-markdown are properties of the document surface; formatting-bar and tab-width are app chrome. Client-only, no schema change (settings keys are flat — this moves markup between two `.svelte` files), so it costs one small PR plus updating any E2E selectors that assume the tab (`appearance-show-raw-markdown` would need renaming or an alias).
