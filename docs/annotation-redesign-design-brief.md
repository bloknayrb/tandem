# Annotation Redesign — Design Brief

## Design Problem

Tandem's annotation toolbar currently asks users to choose between annotation types (Highlight, Comment, Flag) — a taxonomy question. Users don't think in types. They think in audience: "is this for me or for Claude?" The redesign reframes annotation creation around that intent.

## Current State

When a user selects text, a toolbar appears above the editor with three buttons:

- **Highlight** — color picker dropdown (yellow/green/blue/pink), creates a colored background marker, no text input
- **Comment** — opens an inline text field with Add/Cancel buttons, requires text
- **Flag** — single click, creates a red background + red underline marker, no text input

Claude creates annotations via MCP tools that appear identically in the sidebar but with different authorship. Claude can also create "suggestions" (tracked changes with replacement text) that render with violet styling and show a strikethrough→replacement diff in the sidebar card.

The sidebar has six filter categories: All types, Highlights, Comments, With replacement, For Claude, Flags.

There is a modal "review mode" entered via button click, using Tab/Y/N/Z keyboard shortcuts to navigate and resolve annotations.

## New Model

### The core insight

The user's primary decision when annotating text is audience, not type:

1. **"This is for me"** — a personal note or visual marker
2. **"This is for Claude"** — an instruction, question, or feedback

Everything else (visual treatment, notification routing, sidebar behavior) follows from that decision.

### User annotation actions (3)

**Highlight** — visual marker, no text. User picks a color. Claude can find these if asked but is not proactively notified. Unchanged from current behavior except that it absorbs the "flag" use case (flag is removed — highlight colors already carry soft severity semantics via color choice).

**Note to self** — text annotation for personal reference. Appears in the sidebar with a muted/personal treatment. Claude can access these via tools but the system instructs Claude not to act on them unprompted. Each note card has a "Convert to comment" action that promotes it to a comment (notifying Claude). This supports a natural workflow: review a document alone, mark it up with personal notes, then selectively share relevant ones with Claude.

**Comment** — text annotation directed at Claude. Claude is proactively notified. This is how the user asks Claude to change text, asks a question about a passage, or gives feedback. The user writes natural language — "make this more concise," "is this claim accurate?", "good paragraph" — and Claude responds (via chat, reply thread, or by creating a suggestion).

### Claude annotation actions (2)

**Comment** — Claude's observation, question, or feedback on a text range. Appears in the sidebar for the user to read, reply to, accept, or dismiss.

**Suggestion** — a comment that includes replacement text (a tracked change). The sidebar card shows the original text struck through and the proposed replacement in green. Accepting a suggestion replaces the text in the document. This is Claude's core value proposition — proposed edits the user can accept or reject.

Claude does not create highlights or notes. All Claude→user communication is through comments and suggestions.

### Import behavior

Word document (.docx) comments enter as **notes**, not comments. The user triages them — converting individually or batch-selecting and converting to comments — before Claude sees them. This prevents an import from flooding Claude with dozens of notifications.

## Design Deliverables

### 1. Selection popup

Replace the current toolbar with a popup positioned near the selected text. The popup has:

- A text input area (multiline, resizable)
- Two submit buttons: **"Note to self"** and **"Comment"**
- Highlight color buttons (yellow/green/blue/pink) below or beside the popup for quick no-text marking

The two-button layout is the key design moment — it should make the audience distinction feel natural and obvious without requiring explanation. The popup should feel light, not modal. It appears on text selection and dismisses on click-outside or Escape.

Design considerations:

- Button hierarchy: "Comment" is likely the more common action (sending to Claude is the main reason to use Tandem). Consider making it the primary/emphasized button.
- The text input placeholder could reinforce the distinction: something like "Write a note or instruction..."
- Highlight colors could be a small row of color dots below the text area, or a separate quick-action that doesn't require the popup at all.
- On mobile/narrow viewports, the popup needs to avoid covering the selected text.

### 2. Sidebar annotation cards

Three card variants for user-created annotations, plus two for Claude-created:

**User highlight card** — shows the highlighted text snippet with the color indicator. Minimal — no text content to display. Actions: remove.

**User note card** — shows the note text and the annotated text snippet. Should feel visually "personal" — muted, perhaps with a distinct but understated border color or icon. Key action: **"Convert to comment"** button, which promotes the note to a comment and notifies Claude. Also: edit, remove.

**User comment card** — shows the comment text and annotated text snippet. Should feel "outbound" — directed at Claude. Actions: edit, remove.

**Claude comment card** — shows Claude's comment text and the annotated text snippet. Actions: accept, dismiss, reply. Border color indicates Claude authorship.

**Claude suggestion card** — shows Claude's comment text, the original text (struck through), and the replacement text (green). This is the most complex card. Actions: accept (replaces text in document), dismiss, reply, undo (after accept, if text hasn't changed). Border color: violet/suggestion family.

Design considerations:

- The note→comment conversion should feel like a deliberate action, not accidental. A button is fine; a swipe gesture could also work.
- Batch convert: when multiple notes exist, the sidebar could offer a "Convert all" or multi-select with checkboxes. This is especially important for the Word import case where dozens of notes may arrive at once.
- Resolved annotations (accepted/dismissed) should collapse into a less prominent section, as they do today.

### 3. Editor decorations (inline rendering)

Each annotation type needs a distinct inline treatment in the editor:

**Highlight** — colored background, as today. Four colors: yellow, green, blue, pink. Light enough to read text through.

**Note** — needs a new visual treatment. Should be visible but quieter than a comment. Possible approaches: a subtle dotted underline, a light gray background, a small margin icon. Should not compete visually with comments or suggestions.

**Comment** — dashed underline (as today for plain comments). Color should signal "this is for Claude" — the current blue works.

**Claude comment** — similar to user comment but distinguishable. Current blue underline works if authorship is clear from the sidebar card.

**Claude suggestion** — wavy underline with tinted background (current violet treatment). Visually the loudest annotation because it requires user action.

Design considerations:

- Notes should be the quietest decoration — they're personal and shouldn't distract during collaborative work.
- Comments and suggestions should be the most prominent — they represent active collaboration.
- When multiple annotations overlap on the same text range, layering rules matter. Suggestions should win visually since they require action.

### 4. Sidebar filters

Replace current six filters with five:

- All
- Highlights
- Notes
- Comments
- Suggestions (replaces "With replacement")

Remove "For Claude" and "Flags" filters.

### 5. Keyboard navigation

Replace modal review mode with always-available shortcuts:

- **Next/previous annotation** — navigates between annotations, scrolls editor to show the annotated text, highlights the active card in the sidebar
- **Accept/dismiss** — available when an annotation card is focused/active

These shortcuts should be discoverable — shown in tooltips, maybe in a help overlay. No mode to enter or exit.

### 6. Tutorial annotations

The tutorial (on `sample/welcome.md`) should demonstrate:

- A **note** — showing what personal annotations look like, with the "convert to comment" button visible
- A **comment** — showing what a message to Claude looks like
- A **suggestion** — showing the tracked-change accept/reject flow

### 7. Convert-to-comment interaction

When a user clicks "Convert to comment" on a note:

- The note visually transforms into a comment (decoration changes, card styling changes)
- Claude is notified via the next `checkInbox` poll
- The action should feel like "sharing" — maybe a brief animation or transition
- For batch conversion (especially Word imports): a selection mechanism (checkboxes) + "Convert selected" button, or a "Convert all notes" action

## Visual Identity Summary

## What NOT to Design

- **Chat panel** — unchanged, separate system
- **Annotation reply threads** — unchanged
- **Settings or mode toggle** — unchanged
- **Editor formatting toolbar** — unchanged (bold, italic, etc.)
