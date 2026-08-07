# Annotation System Redesign

## Motivation

A first-principles analysis of Tandem's annotation system revealed that the current type-based model (highlight / comment / flag) asks users "what kind of annotation is this?" when the more natural question is "who is this for?" The user's three actual intents when annotating text are:

1. **Ask Claude to change something** — instructions about the selected text
2. **Ask Claude a question** — prompting a back-and-forth about the text
3. **Leave a note to themselves** — personal reference for later

The current system encodes these intents indirectly through type choice and hidden sub-fields (`suggestedText`, `directedAt`), creating five visual presentations from three types. The redesign simplifies to an audience-based model.

## The New Model

### User creates

### Claude creates

### Removed

### Changed

### Kept (unchanged)

## Creation UI

The selection toolbar becomes a popup positioned near the selected text (similar to Claude Design's annotation popup):

```
┌─────────────────────────────────┐
│  [text input area]              │
│                                 │
│  [Note to self]    [Comment]    │
└─────────────────────────────────┘
  [🟡] [🟢] [🔵] [🩷]  ← highlight color buttons (no text needed)
```

- **"Note to self"** creates a note annotation — personal, not sent to Claude
- **"Comment"** creates a comment annotation — sent to Claude, appears in `checkInbox`
- **Color buttons** create a highlight — visual marker, no text, not sent to Claude
- Notes display a "Convert to comment" button in their sidebar card

## Keyboard Shortcuts

Replace modal review mode with always-available shortcuts:

Exact key bindings TBD — need to avoid conflicts with editor formatting shortcuts.

## Type System Changes

### Before (ADR-022)

```
AnnotationTypeSchema = z.enum(["highlight", "comment", "flag"])

comment.suggestedText?: string    // tracked change
comment.directedAt?: "claude"     // question for Claude
```

### After (ADR-027)

```
AnnotationTypeSchema = z.enum(["highlight", "note", "comment"])

comment.suggestedText?: string    // tracked change (Claude-only)
// directedAt removed entirely
// flag removed entirely
```

### Migration

- Existing `flag` annotations → `note` (they had no text and were user markers)
- Existing `comment` with `directedAt: "claude"` → plain `comment` (drop the field)
- Existing `comment` (plain) → `comment` (unchanged)
- Existing `highlight` → `highlight` (unchanged)
- `sanitizeAnnotation()` updated to handle legacy `flag` and `directedAt` shapes

## MCP Tool Changes

### Removed

- `tandem_highlight` — Claude doesn't create highlights
- `tandem_flag` — flag type removed
- `tandem_suggest` — already deprecated, remove entirely

### Modified

- `tandem_comment` — remove `directedAt` parameter. Keep `suggestedText`.
- `tandem_checkInbox` — filter out notes and highlights from `userActions`. Only surface comments.
- `tandem_getAnnotations` — still returns all annotation types (notes, highlights, comments) so Claude can access them when explicitly asked

### Unchanged

- `tandem_resolveAnnotation` — accept/dismiss
- `tandem_removeAnnotation` — delete
- `tandem_editAnnotation` — edit pending annotations
- `tandem_annotationReply` — threaded replies
- `tandem_exportAnnotations` — export all
- `tandem_reply` — chat (separate system)

## Open Questions

1. **Note-to-self visual treatment** — what editor decoration and card border color for notes? Muted/gray to signal "personal"? Or a distinct color?
2. **Batch convert UI** — how does multi-select + batch convert work in the sidebar? Checkboxes? Select-all?
3. **Keyboard shortcut bindings** — exact keys for annotation navigation, avoiding conflicts with Tiptap formatting shortcuts
4. **Tutorial update** — what tutorial annotations demonstrate the new model? A note, a comment, and a suggestion covers the three concepts.
5. **Skill update** — Claude's Tandem skill needs to reflect: don't act on notes, respond to comments, ignore highlights unless asked

## Relationship to Other Work

- **Supersedes parts of ADR-022** (annotation type unification) — that ADR narrowed 5→3 types; this narrows to 3 different types with audience-based semantics
- **Affects v0.10.0 Svelte migration** — the new UI (popup, cards, sidebar filters) will be built in Svelte, not ported from React
- **Affects v0.10.0 issue scope** — #467 (hooks), #469 (tabs/FileOpenDialog), #470 (panels) all touch annotation-related code
