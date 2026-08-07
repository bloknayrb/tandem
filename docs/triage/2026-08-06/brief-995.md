# Creating tables in the editor

**Issues:** #995 **Decision needed:** Ship `/table` as a fixed 3×3-with-header insert (no size picker, no toolbar control) — yes or no?

## What these are

Filed 2026-06-03, `enhancement` + `needs-design-decision`. Tandem can render, edit and round-trip tables but has no way to create one.

Verified today:
- **Editing exists.** `Table.configure({ resizable: true })`, `TableRow`, `TableCell`, `TableHeader` are all registered — `src/client/editor/editor-extensions.ts:8–11, 103–106`.
- **The #923 menu already edits tables.** `ContextMenuKind` includes `"tableCell"` (`context-menu/types.ts:16`); insert/delete row+col, merge/split and delete-table are wired (`types.ts:43–47`, `dispatch.ts:102–127`).
- **Creation is genuinely absent.** `SlashCommandId` is exactly `heading-1|2|3, bullet-list, numbered-list, task-list, quote, code-block, horizontal-rule` (`slash-menu/commands.ts:3–12`). No toolbar table control.

**One body claim is stale and shrinks the issue.** #995 says markdown paste "silently drops tables (`ignore: true`)". That was fixed — `markdown-paste.ts:247–259` maps `table/tr/th/td` to nodes and `:337` enables the `table` rule, landed in #1184 (`624eb4e`, v0.16.0). The paste sub-scope is done; only the slash command and the optional toolbar control remain.

## Why they stalled

Not difficulty — the "notes / decisions" block asks three taste questions (starter dimensions, size-grid picker vs. fixed default, whether to fold in paste) and none had an owner. One of the three has since answered itself.

## Options

1. **`/table` only, fixed 3×3 + header row.** One entry in `commands.ts` calling `insertTable({ rows: 3, cols: 3, withHeaderRow: true })`, one icon, one test. Genuinely a day. Forecloses nothing — a picker can be added later behind the same command.
2. **`/table` + toolbar control with a grid picker.** Adds a new popover to `FormattingToolbar.svelte`, a new hover-drag interaction, and a11y work (the #1303 axe audit is live on 15 surfaces — a new popover joins that gate). Several times the cost for a second entry point to the same command.
3. **Also add column-alignment UI.** The model already stores table-level `align` (`mdast-ydoc.ts`), so it round-trips, but there is no way to set it. Real gap; separable.

## Recommendation

**Option 1, and yes — the plan's "most shippable" call holds for #995.** Everything downstream (edit menu, GFM serialize, scratchpad save pipeline) already exists; this is one command away from working end-to-end. Scratchpad parity is free, since scratchpads use the same editor — assert it as a test, not as work. Split alignment out as a follow-up rather than letting it re-stall this.

## If yes / If no

**Yes:** one PR — `commands.ts` entry + icon, unit test, plus E2E covering insert-in-scratchpad → save → reopen (round-trip is the only part that could actually be wrong). Close the paste line item as already-shipped when you do.
**No:** #995 stays open indefinitely; tables remain creatable only by hand-authoring GFM outside Tandem or importing `.docx`, which is a visible hole in the "scratchpad is a real markdown document" promise.
