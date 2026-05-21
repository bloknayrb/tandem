# Review Panel Utility

_Started 2026-04-29 00:29 UTC_

---

## User

is the "review" panel actually useful, or should we eliminate it?

## Assistant

I'll take a look at the current redesign to understand what the "review" panel is doing.

_[tool: grep]_

_[tool: list_files]_

Let me look at what Review mode actually shows and how it differs from the default editing mode + chat rail, so I can give you a real opinion.

_[tool: read_file]_

_[tool: grep]_

_[tool: grep]_

Honest take — I'd cut it.

**What Review mode currently is:** the same editor, but non-annotated paragraphs dim and the side rail shows annotations only. That's it. It overlaps with two things you already have:

1. **The annotations rail by itself** already lets the user triage and step through Claude's marks — that's the actual reviewing workflow.
2. **Share → "Review" permission** ("invitee can annotate, not edit") is a *real* concept worth keeping. That's a permission/role, not a viewing mode.

**Why the dimming doesn't earn its keep:**
- It hides context. Reviewing a comment usually means re-reading the surrounding paragraph, not just the annotated sentence.
- It's a mode the user has to remember to enter and exit — and there's no task it enables that the default view + rail doesn't already do better.
- It collides with Solo mode and the rail-mode switcher, which already cover "I want to focus on something specific."
- The status-bar `claudeState="reviewing"` it shows off can be surfaced any time Claude is actively annotating; it doesn't need a dedicated UI mode.

**What I'd do:**
- Drop the `ReviewMode` artboard and the `reviewMode` prop on `EditorBody`.
- Keep `SideRail mode="review"` only if it differs meaningfully from `mode="annotations"` — if not, collapse them into one. (Worth a quick check.)
- Keep "Review" as a **share permission** — that's the only place the word is pulling weight.
- If you want a "focus on open threads" affordance, make it a filter on the annotations rail (e.g. *Open · Resolved · All*), not a whole-app mode.

Want me to make those edits, or would you rather keep Review mode and have me sharpen it into something the default view *can't* do (e.g. a true read-only reviewer view for the share-link recipient)?

## User

yes, make those edits

## Assistant

_[tool: read_file]_

_[tool: grep]_

Now let me find where SideRail's "review" vs "annotations" mode is defined and where the annotations rail is rendered, so I can collapse them and add an Open/Resolved/All filter.

_[tool: grep]_

_[tool: grep]_

Now let me look at the existing annotations rail body (filter bar) and the review-banner CSS, so I can fold review's signal into annotations cleanly.

_[tool: read_file]_

_[tool: grep]_

_[tool: snip]_

Now I'll make the edits. Plan:

1. Remove "Review" tab from `SideRail` and the `mode === 'review'` body block.
2. Replace the filter chips with **Open / Resolved / All** (keeping author/type as a secondary row).
3. Drop `reviewMode` from `EditorBody` (and the banner + the dimming CSS).
4. Delete `ReviewMode` artboard from the canvas, plus `Toggle Review mode` from command palette and shortcuts modal.
5. Keep "Review" share permission (already a permission, untouched).
6. The read-only `.docx` artboard's "Apply to .docx" card was inside the review-mode block — move that into the annotations rail under a `readOnly` branch so we don't lose it.

_[tool: str_replace_edit]_

_[tool: read_file]_

_[tool: str_replace_edit]_

_[tool: snip]_

Now SideRail — drop the Review tab, fold the read-only "Apply to .docx" affordance into the annotations rail, and replace the filter chips with a status row (Open/Resolved/All) plus the existing author/type chips.

_[tool: str_replace_edit]_

Drop the Review tab:

_[tool: str_replace_edit]_

Now replace the filter bar with status filter + author/type, and merge the read-only "Apply to .docx" card into the annotations branch (then delete the review-mode body):

_[tool: str_replace_edit]_

Now drop the `reviewMode` tweak from the main `TandemApp`, the keyboard shortcuts row, and the command palette item:

_[tool: str_replace_edit]_

Look at the shortcuts modal & status bar mentions of "reviewing":

_[tool: read_file]_

The shortcuts "Review" section is at line ~669 (pre-edit). Let me re-locate it:

_[tool: grep]_

Recast the shortcuts section as "Annotations" (since "Review" was the mode-specific label). Update the doc-tab tooltip and status bar:

_[tool: str_replace_edit]_

Update the shortcuts modal — drop the `⌘⇧R` toggle entry and rename the section:

_[tool: str_replace_edit]_

Status bar said `claudeState="reviewing"` — keep that label since it represents Claude actively annotating. Actually, since "reviewing" was tied to the Review mode framing, change to `annotating` for clarity:

_[tool: str_replace_edit]_

Now check the command palette item:

_[tool: grep]_

_[tool: snip]_

_[tool: str_replace_edit]_

Now fix surfaces.jsx — the `partner-update.docx` review-mode artboard. It uses `mode="review"`. Switch it to `mode="annotations"` and pass `readOnly` so the new annotations branch shows the "Apply to .docx" card:

_[tool: str_replace_edit]_

Now remove the `ReviewMode` function and its artboard, plus the EditorBody review-mode prop usages elsewhere in `Tandem Redesign.html`:

_[tool: str_replace_edit]_

Remove the artboard:

_[tool: str_replace_edit]_

_[tool: snip]_

_[tool: grep]_

Now strip the dead CSS for the review banner and dimming:

_[tool: read_file]_

_[tool: str_replace_edit]_

_[tool: snip]_

Now add a small style for the new status filter row, check Tweaks panel for any reviewMode tweak, and confirm no other strays:

_[tool: grep]_

_[tool: grep]_

_[tool: snip]_

_[tool: read_file]_

Add a tighter style for the two-row filter so the status row reads as primary and the facet row as secondary:

_[tool: str_replace_edit]_

_[tool: snip]_

_[tool: done]_

_[tool: fork_verifier_agent]_

Done. Review mode is gone:

- **`SideRail`** — Review tab removed; annotations rail now has a primary **Open / Resolved / All** status filter plus the existing author/type chips. The read-only `.docx` "Apply changes" card moved here so the partner-update artboard still works.
- **`EditorBody`** — `reviewMode` prop, banner, and `.review-on` dimming CSS deleted.
- **Canvas** — `ReviewMode` artboard and component removed.
- **Shortcuts modal** — "Review" section renamed to "Annotations"; `⌘⇧R Toggle Review mode` dropped, `⇧Tab` previous-annotation added.
- **Command palette** — "Toggle Review mode" entry removed.
- **Status bar** — `claudeState="reviewing"` → `"annotating"`.
- **Kept** — the **Review** *share permission* (annotate, not edit) and the `.docx` RO badge, since those are real concepts, not a mode.

## User

Verifier agent check completed

## Assistant

Good catch.

_[tool: read_file]_

_[tool: str_replace_edit]_

_[tool: snip]_

_[tool: done]_

Renamed the two sections to **Create annotations** and **Triage annotations** — distinct keys, and they read more clearly as separate groups anyway.
