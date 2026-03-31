# Tandem UX Opportunities

Findings from a deep exploration of client components, MCP tools, roadmap, and open issues. Grouped by theme, roughly prioritized by impact.

---

## 1. Discoverability & Onboarding

The biggest UX gap. Tandem has good features that users won't find.

- **No onboarding flow.** Roadmap 8b spec'd a 90-second tutorial with a pre-loaded sample doc — never built. New users land on a blank editor with no guidance.
- **Keyboard shortcuts are hidden.** Review mode (Ctrl+Shift+R), Ask Claude (Ctrl+Shift+A), and the Tab/Y/N review workflow are only discoverable via tiny inline banners or tooltips. No help modal, no shortcut reference.
- **Interruption modes unexplained.** The All/Urgent/Paused buttons in the status bar have no tooltips explaining what they do. "Urgent-only" mode is effectively broken — no UI to set annotation priority, so it filters to zero pending annotations.
- **Chat anchor selection is non-obvious.** Users can capture a text selection when sending a chat message, but nothing tells them this exists.

## 2. Missing Editor Basics

Tiptap's StarterKit is loaded but there are no toolbar buttons for it.

- **No formatting toolbar.** Can't bold, italic, bullet list, or code-block from the UI. Only annotation buttons exist. Users must know Tiptap keyboard shortcuts (Ctrl+B, etc.) or go without.
- **No undo/redo buttons.** Yjs handles undo/redo under the hood, but there's no visible UI for it.
- **No document search (Ctrl+F).** Claude has `tandem_search`, but the user has no equivalent in the browser. Browser-native Ctrl+F works but doesn't integrate with Tandem's coordinate system.

## 3. Annotation Workflow Gaps

The review flow is Tandem's strongest feature but has several rough edges.

- **No undo for accept/dismiss.** Actions are immediate and irreversible. Accidental accept on a suggestion applies the text change permanently.
- **Can't edit annotations after creation.** Typo in a comment? Must delete and recreate.
- **No text snippet on annotation cards.** Side panel shows the comment text but not *what text it's attached to*. Users must click to scroll to the annotation to see context.
- **Bulk actions are risky.** "Accept All" / "Dismiss All" apply to all *unfiltered* pending annotations. If filters are active, users might not realize they're bulk-acting on a subset.
- **Filter state resets on tab switch.** Annoying when working across documents.

## 4. Claude Communication & Presence

Users can't always tell what Claude is doing or whether it heard them.

- **No typing indicator.** Status bar says "Claude -- Reviewing..." but there's no "Claude is typing..." in chat or editor. Users send messages and wait with no feedback.
- **Polling-only inbox.** Claude must explicitly call `tandem_checkInbox()` to see user actions. If Claude is busy with a long task, user messages sit unseen. (Issue #43 tracks this.)
- **Claude doesn't know about interruption mode.** No MCP tool to query whether the user has paused annotations. Claude might emit annotations the user won't see.
- **Silent annotation failures.** If `tandem_highlight()` fails (file locked, range invalid), only Claude sees the error. No user-facing toast or alert.

## 5. Document Management

- **No recent files.** FileOpenDialog requires typing a full absolute path or uploading. No history, no favorites, no file browser.
- **No unsaved-changes indicator.** Tabs look identical whether saved or dirty. Easy to close and lose work.
- **Tab overflow.** Many open tabs just get cramped — no scroll, no ellipsis, no overflow menu.
- **No tab reordering.** Can't drag tabs to rearrange.

## 6. Visual Polish & Accessibility

- **No dark mode.** Issue #59 exists, unprioritized. Table-stakes for a document editor.
- **Color-only annotation differentiation.** Comments = blue underline, flags = red underline, etc. No icons, patterns, or labels for colorblind users. (Issue #33.)
- **No ARIA landmarks or labels.** Side panel, editor, chat panel have no semantic roles. Screen readers get no structure.
- **Hardcoded user name.** Collaboration cursor always says "Bryan."
- **All inline styles.** Issue #24 tracks migrating to Tailwind. Current inline styles make theming and responsive design harder.

## 7. .docx Workflow

Issues #84 and #85 cover the big items. Additional observations:

- **No indication of what's lost.** When .docx opens in review-only mode, there's a small "RO" badge but no explanation of *why* or what can't be done.
- **Word comments are invisible.** Existing `<w:comment>` elements in .docx files are silently dropped during import. (#85 addresses this.)
- **No export path.** Can't export Tandem annotations back to Word-native comments. (Roadmap Phase 3.)

## 8. Session & Error Recovery

- **No auto-reopen on restart.** If the server crashes and restarts, documents don't reopen. Claude must call `tandem_open()` again.
- **Vague connection errors.** "Reconnecting..." with no explanation. "Cannot reach server" with no suggestions.
- **No session browser.** Users can't see or manage persisted sessions. Must delete files from disk to clear stale sessions.

---

## Already Tracked in Issues

| Issue | Topic |
|-------|-------|
| #85 | Import Word comments as annotations |
| #84 | Convert .docx to markdown button |
| #59 | Dark theme |
| #43 | Claude inbox polling cadence |
| #33 | Accessibility for annotations |
| #31 | Tauri desktop packaging |
| #24 | Tailwind CSS migration |

## Not Yet Tracked

The items above without issue numbers. Highest-impact candidates for new issues:

1. **Onboarding tutorial** — sample doc + 3-step walkthrough
2. **Formatting toolbar** — bold/italic/list/code buttons
3. **Undo for accept/dismiss** — prevents accidental text changes
4. **Text snippets on annotation cards** — shows what the annotation is attached to without clicking
5. **Recent files in FileOpenDialog** — localStorage history
6. **Unsaved-changes indicator on tabs** — dot or icon
7. **Help/shortcuts modal** — Ctrl+? or menu item
8. **Claude typing indicator** — in chat panel and/or status bar
