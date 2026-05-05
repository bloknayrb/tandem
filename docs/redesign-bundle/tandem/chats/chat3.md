# Button Keyboard Shortcuts

_Started 2026-04-28 23:58 UTC_

---

## User

lets add keyboard shortcut tooltips to buttons that have keyboard shortcuts associated with their actions

## Assistant

I'll explore the current Tandem Redesign file to find buttons with keyboard shortcuts.

_[tool: list_files]_

_[tool: read_file]_

Let me look at the buttons and where shortcuts are defined.

_[tool: grep]_

Let me look at the buttons in app.jsx to find which have shortcut associations.

_[tool: read_file]_

I'll add proper keyboard shortcut tooltips to buttons. The current titles use parens like `"Undo (⌘Z)"` but I want richer tooltips with styled keys. Let me build a Tooltip component and apply it to all the buttons that have shortcuts.

Let me check styles.css briefly for tooltip styling conventions:

_[tool: grep]_

_[tool: grep]_

I have a clear picture now. Let me design and add proper keyboard-shortcut tooltips. I'll:

1. Build a `<Tooltip>` component with styled `<kbd>` chips for the key combo
2. Apply it to all buttons with shortcuts in the toolbar, mini-toolbar, side rail, and chat input

Let me start by adding tooltip CSS and a component, then wire them up.

_[tool: snip]_

Now let me add tooltip styles to styles.css:

_[tool: read_file]_

Now let me append tooltip styles. I'll add them at the end of styles.css:

_[tool: read_file]_

Now let me append tooltip styles:

_[tool: str_replace_edit]_

Now let me create a Tooltip component. I'll add it to icons.jsx (since shortcut formatting already lives there):

_[tool: read_file]_

Now let me append the Tooltip component and a parser for shortcut keys:

_[tool: str_replace_edit]_

_[tool: snip]_

Wait — I have a duplicate `formatShortcut` declaration now. Let me check and fix:

_[tool: grep]_

Good — only one. The replacement worked because there was only one match originally. Now let me update `app.jsx` to use `ShortcutTooltip` for buttons with shortcuts. The buttons that have shortcuts:

- TopToolbar: Undo (⌘Z), Redo (⌘⇧Z), Search (⌘F), Shortcuts (⌘/), Settings (⌘,)
- Mini selection toolbar: Bold (⌘B), Italic (⌘I), Link (⌘K), Comment (⌘⇧M), Ask Claude (⌘⇧A)
- Side rail: Start review (⌘⇧R)

Let me update TopToolbar first:

_[tool: str_replace_edit]_

Now the panel layout buttons + theme + shortcuts + settings. Panel buttons don't have keyboard shortcuts; only Settings (⌘,) and Shortcuts (⌘/) do. Let me also keep tooltips on buttons without shortcuts but they only need labels. Let me focus on the ones with shortcuts:

_[tool: str_replace_edit]_

_[tool: snip]_

Now mini selection toolbar:

_[tool: str_replace_edit]_

_[tool: snip]_

Now I need to update the "Start review" button. Let me also handle the chat input ⌘↵ tooltip. Let me find them:

_[tool: grep]_

_[tool: str_replace_edit]_

_[tool: snip]_

Now let me also update the chat input "Send" button (with ⌘↵). Let me find it:

_[tool: grep]_

_[tool: str_replace_edit]_

_[tool: snip]_

Now let me also tackle the Find/Replace bar tooltips and reply button (⌘↵ to send) in surfaces.jsx. Let me also check the SelectionMiniToolbar — it's used in EditorBody and ToolsCloseUp without platform. Let me verify it works without platform (default 'mac' is fine).

Let me also check that surfaces.jsx ThreadFrame Reply button uses ⌘↵:

_[tool: grep]_

_[tool: str_replace_edit]_

_[tool: snip]_

Now let me also tackle the Open command palette button (⌘K), and the Find/Replace open button. Let me also check ShortcutTooltip handles complex keys properly. Let me verify by viewing the result:

_[tool: str_replace_edit]_

_[tool: snip]_

_[tool: done]_

_[tool: snip]_

_[tool: fork_verifier_agent]_

Added keyboard shortcut tooltips. They now appear on hover for buttons across the app:

- **Top toolbar:** Undo (⌘Z), Redo (⌘⇧Z), Search (⌘F), Shortcuts (⌘/), Settings (⌘,)
- **Selection mini-toolbar:** Bold (⌘B), Italic (⌘I), Link (⌘K), Comment (⌘⇧M), Ask Claude (⌘⇧A), Flag (⌘⇧F)
- **Side rail:** Start review (⌘⇧R)
- **Chat input:** Send (⌘↵)
- **Thread reply:** Reply (⌘↵)
- **Find/Replace surface:** Open command palette (⌘K)

Each tooltip is a dark chip with the action label and individual key chips (e.g. `⌘` `⇧` `A`), placement-aware (top/bottom/left to avoid clipping at window edges), and platform-aware — Mac shows glyphs, Windows/Linux shows `Ctrl+Shift+A`. The native `title` attributes were removed where shortcut tooltips replaced them so the OS tooltip doesn't double up, and `aria-label` carries the shortcut for screen readers.

