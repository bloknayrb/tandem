# Toolbar UX Research — Tandem Formatting Tools Placement

**Date:** May 7, 2026  
**Scope:** Which formatting tools belong in the persistent toolbar vs. the selection popup (bubble menu)?

---

## What we know about the current state

### The codebase (ground truth from `FormattingToolbar.svelte` + `Toolbar.svelte`)

The **persistent toolbar** currently contains:
- Undo / Redo (Yjs-aware)
- Bold, Italic, Strikethrough, Inline code
- Heading (H1/H2/H3 dropdown)
- Bullet list, Ordered list, Blockquote
- Link (Ctrl+K)
- Horizontal rule
- Code block
- HighlightColorPicker (yellow/green/blue/pink)
- Comment button (requires selection)
- Note button (requires selection)

The **selection popup (bubble menu)** currently contains:
- Bold, Italic, Strikethrough, Inline code
- Link
- Highlight color swatches (4 colors)
- Comment button → opens InputGroup inline
- Note button → opens InputGroup inline

### The mockup's annotation popup (`annotation-redesign.jsx`)
The `ARSelectionPopup` contains only:
- Textarea
- Highlight color swatches
- "Note to self" button
- "Send to Claude" (Comment) button

The mockup **dropped** all formatting tools from the popup. The design brief explicitly says "Editor formatting toolbar — unchanged." So the current mockup is in an **intermediate state**: the annotation popup is correctly audience-focused, but the formatting tools got lost from both surfaces.

---

## Industry patterns (research findings)

### How major editors split their tools

| Editor | Persistent toolbar | Selection popup |
|--------|-------------------|-----------------|
| **Notion** | No persistent toolbar — relies entirely on selection popup + / commands | B / I / S / Code / Link / Color / Comment / Turn into block |
| **Google Docs** | Full persistent toolbar (font, size, B/I/U, align, lists, etc.) | Minimal: just Comment in right-click menu, no bubble menu |
| **Confluence** | Full persistent toolbar | No floating bubble |
| **Linear** | No persistent toolbar | B / I / Code / Link / in bubble |
| **Loom (description)** | None | Basic marks only |
| **Docmost** | Selection bubble | B / U / align / link / color |

### The key insight from the research

<cite index="3-1,3-2">One of the newer patterns is a floating menu that shows up whenever you select text. It keeps your attention on the text you are editing — instead of letting it wander to a menu bar at the very top of the page.</cite>

<cite index="8-23,8-24">When considering the placement of the toolbar, think about the size of the editing experience. For long-form writing, anchor the toolbar to the top of the editor.</cite> Tandem is a **long-form** markdown editor — this argues for a persistent toolbar.

<cite index="5-4,5-5">A floating toolbar that appears when text is selected should show a limited number of options due to space constraints. Those options should be ones expected to be used most frequently by users.</cite>

<cite index="8-7,8-8">Toolbar sections have semantic meaning, so it's important they're categorized by function. Toolbars can have up to 4 categories that are visually separated.</cite>

### Cognitive load principles

<cite index="21-27">Designers should strive to eliminate extraneous cognitive load: processing that takes up mental resources but doesn't actually help users understand the content.</cite>

<cite index="29-6,29-7">When confronted with too many choices, cognitive load will increase due to decision paralysis. It is important to minimize the choices the user must make at any given moment.</cite>

The bubble menu is already cognitively loaded in Tandem's case: it contains the **audience-choice decision** (Note vs. Comment), which is the design's primary UX moment. Piling formatting tools on top competes with that.

---

## Recommended tool placement

### Mental model: Two different intents

When a user selects text in Tandem, they have **two different intents**:

1. **"I want to format this"** — a writing act (bold, heading, etc.)
2. **"I want to react to this"** — a collaboration act (annotate, highlight)

These are cognitively different. Mixing them in one popup creates the wrong mental model and buries the audience-choice (the design's headline feature) in a sea of formatting buttons.

### Recommendation: Three-surface model

---

#### 🔵 PERSISTENT TOOLBAR — "Document-level tools"
*Always visible. Works on cursor position or selection. Used while composing.*

**Keep all of these:**
- Undo / Redo
- Heading (H dropdown)
- Bold · Italic · Strikethrough · Code
- Bullet list · Ordered list · Blockquote
- Code block
- Link
- Horizontal rule

**Move FROM popup TO toolbar:**
- Nothing needs to move here; these already live in the toolbar in the codebase. The mockup just dropped them visually — they should be restored.

**Why persistent?** These tools apply to document *structure* and *style*. They're needed while typing, not just after selecting. Users look up to the toolbar when thinking "what type of content is this?" — that's a document-level question.

---

#### 🟡 SELECTION POPUP — "Reaction tools"
*Appears on text selection. Focused, minimal. Tandem's primary collaboration surface.*

**Tier 1 — Always show (the fast path):**
- Highlight color swatches (4 colors) — one-click, no text required
- **Bold · Italic** — the two marks most applied AFTER reading (e.g., "make that word bold")

**Tier 2 — The audience moment (primary design goal):**
- Textarea (open, ready to type)
- "Note to self" button
- "Send to Claude" button

**Explicitly do NOT include in popup:**
- Heading, lists, blockquote — these are *structure* decisions made while writing, not while reviewing
- Strikethrough, code, link — too infrequent to justify space in the reaction surface
- Undo/Redo — irrelevant to a selection context

**Why minimal?** The audience-choice (Note vs. Comment) is Tandem's core design moment. <cite index="29-30,29-31">When confronted with too many choices, cognitive load increases due to decision paralysis. Minimize the choices users must make at any given moment.</cite> Adding 8 formatting buttons before the note/comment choice buries the lede.

**Why Bold+Italic specifically?** These are the only inline marks users routinely apply *after* reading a passage — "this phrase should be emphasized." All other marks (heading, list, code) are applied while *writing*. The popup is a reading-mode surface.

---

#### 🟢 KEYBOARD SHORTCUTS — "Power user path"
All toolbar tools remain keyboard-accessible (Ctrl+B, Ctrl+I, etc.). The toolbar is the discoverability surface; shortcuts are the speed surface.

---

## The two-surface order: popup THEN toolbar?

One alternative worth naming and rejecting: Notion's approach (no persistent toolbar at all, everything in the popup). This doesn't work for Tandem because:

1. Tandem's popup already has a job (audience choice + annotation textarea). Adding a full toolbar competes with it.
2. Tandem is long-form markdown — users need structure tools (headings, lists) while composing, not just after selecting.
3. The `/` slash menu handles block-level creation, but only after the toolbar issue is resolved.

---

## Current mockup gap

The `ARSelectionPopup` correctly strips formatting tools out of the annotation surface. But the persistent toolbar needs to be **re-added to the mockup artboards** — it was visually removed in a previous iteration. The artboards currently show a chrome bar with the Tandem wordmark and mode toggle, but no formatting buttons.

**Required mockup update:**
1. Restore the formatting toolbar group to the persistent top bar (after the wordmark, before the right-side controls)
2. Add Bold + Italic to the `ARSelectionPopup` as a small "quick format" row above the textarea — subtle, icon-only, doesn't compete with Note/Comment buttons
3. Show an artboard that demonstrates the two surfaces clearly: popup open with just B/I + highlights + textarea + two buttons; toolbar above with the full formatting set

---

## Decision summary

| Tool | Persistent Toolbar | Selection Popup |
|------|--------------------|-----------------|
| Undo / Redo | ✅ | ❌ |
| Heading H1/H2/H3 | ✅ | ❌ |
| Bold | ✅ | ✅ (icon, compact) |
| Italic | ✅ | ✅ (icon, compact) |
| Strikethrough | ✅ | ❌ |
| Inline code | ✅ | ❌ |
| Bullet list | ✅ | ❌ |
| Ordered list | ✅ | ❌ |
| Blockquote | ✅ | ❌ |
| Code block | ✅ | ❌ |
| Link | ✅ | ❌ (use Ctrl+K) |
| Horizontal rule | ✅ | ❌ |
| Highlight (4 colors) | ✅ (picker) | ✅ (swatches) |
| Comment | ✅ (selection-gated) | ✅ (primary CTA) |
| Note | ✅ (selection-gated) | ✅ (primary CTA) |
