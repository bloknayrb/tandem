// Fixed shortcuts not in the action registry: text-formatting / Tiptap keymaps,
// help, and tab navigation. Single source of truth for the read-only "Other"
// section in the Help modal and Settings → Shortcuts. Shortcuts that became
// user-remappable (ADR-041) — New Scratchpad (Ctrl+N) and Comment on selection
// (Ctrl+Alt+M) — were moved out of here into the editable list.
export const STATIC_SHORTCUT_ROWS = [
  { keys: "Ctrl+B", description: "Bold" },
  { keys: "Ctrl+I", description: "Italic" },
  { keys: "Ctrl+Z", description: "Undo" },
  { keys: "Ctrl+Y", description: "Redo" },
  { keys: "? or Ctrl+/", description: "Show keyboard shortcuts" },
  { keys: "Ctrl+Tab", description: "Next document tab" },
  { keys: "Ctrl+Shift+Tab", description: "Previous document tab" },
  { keys: "Ctrl+1 – Ctrl+9", description: "Jump to tab by number" },
  { keys: "Ctrl+Alt+1", description: "Heading 1" },
  { keys: "Ctrl+Alt+2", description: "Heading 2" },
  { keys: "Ctrl+Alt+3", description: "Heading 3" },
  { keys: "Ctrl+Alt+4", description: "Heading 4" },
  { keys: "Ctrl+Alt+5", description: "Heading 5" },
  { keys: "Ctrl+Alt+6", description: "Heading 6" },
] as const;
