# Redesign items deferred — need Bryan's input

Drafted overnight during the W4b + W8 + W10 batch (2026-05-17/18).

## 1. macOS wincontrols / system traffic-lights conflict

**Status:** Tonight's W4b ships `.tandem-wincontrols` pill styling on all Tauri
platforms (Win/Mac/Linux) because `src-tauri/tauri.conf.json` has
`"decorations": false`, which hides system traffic-lights on macOS too.

**Plan intent:** Windows-only `.tandem-wincontrols` pill; macOS relies on
system traffic-lights drawn over the canvas (handoff design assumption).

**Conflict:** Honoring the plan needs platform-conditional Tauri config —
either:
- `decorations: true` + `titleBarStyle: "Overlay"` on macOS only (Tauri
  supports per-platform window config via `tauri.macos.conf.json`); or
- Runtime feature detection + custom controls hidden when system controls
  exist.

**Risk:** Decorations changes ripple through CSP, drag-region, decorum
hit-test, and the title-bar height math. Not safe to ship without a Mac
build/QA pass.

**Decision needed:** confirm we want the macOS switch, or keep
cross-platform custom controls (current shipped behavior) and update the
plan's wording.

## 2. W10 stretch slope

Slash-menu polish landed tonight as visual-only (no data-model changes).
Items I noticed while reading but didn't touch — flag if you want them
folded in:

- Slash-menu shows `/heading`, `/bullet`, etc. with no section dividers —
  the design groups them. Tonight's polish stops at the floating-pill
  recipe + keyboard nav; section grouping is a content question (which
  items group together?).
- Empty-state copy ("No matching commands") could use a friendlier prompt.

## 3. W7 highlight palette legacy data

Already shipped (#743) — visible legacy `red`/`purple` annotations get
remapped to `pink`/`blue` on read. Confirm you're seeing the remap in
practice on any of your real files; if not, the migration shim is
behaving unexpectedly.

## 4. Highlight from Margin View

Margin-view annotation cards (PR #720/#721) — bubble layout is fine but
the "tap-to-edit" affordance is subtle. Possible touch-up: hover state
on the bubble border, or a small edit icon on hover.
Not blocking; surfacing for taste.
