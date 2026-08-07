# Right-click on a selection should surface the selection pop-up

**Issues:** #997 **Decision needed:** Do we ship the *reduced* version (right-click inside a selection re-arms the existing pop-up above the click point), or close #997 as not-worth-it?

## What these are

Filed 2026-06-03, `enhancement` + `needs-design-decision`, no comments in 2 months.

Verified today:
- The selection pop-up is DOM (`src/client/editor/toolbar/Toolbar.svelte`), placed by `computeSelectionToolbarPosition` (`selection-toolbar.ts`).
- The right-click menu is a real OS menu — `install.ts` calls `show_context_menu` via Tauri invoke (`context-menu/install.ts:56–120`), shipped in #923 (`01cc62b`, `5f49f80`, `c76d8ba`).
- The two are uncoordinated. `install.ts:88–95` deliberately *preserves* the selection when the click lands inside it, so the raw material for this is already there.

**Two body claims have drifted.** #997 says the pop-up defaults to *above* the selection; since #798's cursor-origin work it defaults to **below**, flipping above only on viewport overflow (`selection-toolbar.ts:36–42`). And the pop-up is armed only by `pointerup` / keyboard dwell settle (`Toolbar.svelte:196–197`, `:391` — `e.button !== 0` early-return), so a right-click never arms it at all. This is not "gets covered"; it's "never appears".

## Why they stalled

The issue is honest that the literal ask is impossible — a DOM popup cannot z-order above an OS menu — and then hands back an open question ("does the DOM popup even paint before `popup_menu` blocks?") that only a real run answers. Nobody ran it. The issue is a design question wearing a bug's clothes.

## Options

1. **Reduced version.** Right-click inside an existing selection arms the pop-up, forced `above`, before the invoke. ~1 file plus a placement flag. Cost: the paint-before-block question is real and may just not work on Windows; you'd find out in an hour of dev-mode clicking, not from planning.
2. **Add the annotate actions to the native menu instead.** The editor menu already carries Comment/Note (`ContextMenuHostDeps.composeAnnotation`, `install.ts:26–28`). Extending it costs nothing new and gets one surface, not two stacked ones.
3. **Close.** Nothing is broken; the pop-up path still works via normal selection.

## Recommendation

**Option 2, then close #997.** The pop-up-above-a-native-menu shape exists only because the pop-up predates the native menu. Two floating surfaces from one gesture is worse UX than one, and option 2 has no unknowns. Answer this together with #992/#994 — see `brief-994.md`; they are one question about how far to invest in the #923 surface.

## If yes / If no

**Yes (option 2):** a small dispatch/menu-item addition in `context-menu/{types,dispatch}.ts` + Rust menu build; verify the existing annotate entries actually cover the pop-up's actions (highlight colours currently do not).
**No (option 1):** must be verified by hand on Windows *before* estimating; budget the spike, not the feature.
