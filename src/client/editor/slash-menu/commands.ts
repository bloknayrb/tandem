import type { Editor as TiptapEditor } from "@tiptap/core";

export type SlashCommandId =
  | "heading-1"
  | "heading-2"
  | "heading-3"
  | "bullet-list"
  | "numbered-list"
  | "task-list"
  | "quote"
  | "code-block"
  | "horizontal-rule";

// One SVG primitive inside an icon badge. `attrs` are applied verbatim via
// setAttribute; the extension wraps these in a 16x16 stroke=currentColor svg.
export interface SvgIconElement {
  tag: "path" | "circle";
  attrs: Record<string, string>;
}

// Per-row icon for the menu. A `glyph` renders as text in the badge (e.g. "H¹",
// "—"); an `svg` renders 16x16 primitives via createElementNS in the extension
// (some B3 icons mix filled circles with stroke paths). Display-only — never
// enters `label`/`keywords`, so it cannot drift the filter set.
export type SlashCommandIcon =
  | { kind: "glyph"; glyph: string }
  | { kind: "svg"; els: SvgIconElement[] };

export interface SlashCommandItem {
  id: SlashCommandId;
  label: string;
  keywords: string[];
  // Short alias shown right-aligned in the row (e.g. "h1", "ul"). Display-only.
  hint: string;
  icon: SlashCommandIcon;
  run: (editor: TiptapEditor) => void;
}

// Tiptap exposes StarterKit commands but doesn't generically type them on the
// chain -- keep the narrow surface we actually call here.
type SlashCommandChain = ReturnType<TiptapEditor["chain"]> & {
  toggleHeading: (attributes: { level: 1 | 2 | 3 }) => SlashCommandChain;
  toggleBulletList: () => SlashCommandChain;
  toggleOrderedList: () => SlashCommandChain;
  updateAttributes: (typeOrName: string, attributes: Record<string, unknown>) => SlashCommandChain;
  toggleBlockquote: () => SlashCommandChain;
  toggleCodeBlock: () => SlashCommandChain;
  setHorizontalRule: () => SlashCommandChain;
};

function chain(editor: TiptapEditor): SlashCommandChain {
  return editor.chain().focus() as SlashCommandChain;
}

// SVG primitives lifted verbatim from the B3 bundle mockup
// (`B3 - Slash Menu.html`). All render at viewBox 0 0 16 16.
const LIST_LINES: SvgIconElement = { tag: "path", attrs: { d: "M6 4.5h7M6 8h7M6 11.5h7" } };

export const SLASH_COMMANDS: SlashCommandItem[] = [
  {
    id: "heading-1",
    label: "Heading 1",
    keywords: ["h1", "heading", "title"],
    hint: "h1",
    icon: { kind: "glyph", glyph: "H¹" },
    run: (editor) => chain(editor).toggleHeading({ level: 1 }).run(),
  },
  {
    id: "heading-2",
    label: "Heading 2",
    keywords: ["h2", "heading", "subtitle"],
    hint: "h2",
    icon: { kind: "glyph", glyph: "H²" },
    run: (editor) => chain(editor).toggleHeading({ level: 2 }).run(),
  },
  {
    id: "heading-3",
    label: "Heading 3",
    keywords: ["h3", "heading", "subheading"],
    hint: "h3",
    icon: { kind: "glyph", glyph: "H³" },
    run: (editor) => chain(editor).toggleHeading({ level: 3 }).run(),
  },
  {
    id: "bullet-list",
    label: "Bullet list",
    keywords: ["bullet", "ul", "list"],
    hint: "ul",
    icon: {
      kind: "svg",
      els: [
        {
          tag: "circle",
          attrs: { cx: "3", cy: "4.5", r: "0.7", fill: "currentColor", stroke: "none" },
        },
        {
          tag: "circle",
          attrs: { cx: "3", cy: "8", r: "0.7", fill: "currentColor", stroke: "none" },
        },
        {
          tag: "circle",
          attrs: { cx: "3", cy: "11.5", r: "0.7", fill: "currentColor", stroke: "none" },
        },
        LIST_LINES,
      ],
    },
    run: (editor) => chain(editor).toggleBulletList().run(),
  },
  {
    id: "numbered-list",
    label: "Numbered list",
    keywords: ["numbered", "ordered", "ol", "list"],
    hint: "ol",
    icon: {
      kind: "svg",
      els: [
        {
          tag: "path",
          attrs: { d: "M2 3.5h1V6M2 6h2M2 9.5c0-.5.5-1 1-1s1 .5 1 1c0 1-2 1.3-2 2.5h2" },
        },
        LIST_LINES,
      ],
    },
    run: (editor) => chain(editor).toggleOrderedList().run(),
  },
  {
    id: "task-list",
    label: "Task list",
    keywords: ["task", "todo", "checkbox", "check", "checklist"],
    hint: "todo",
    icon: {
      kind: "svg",
      els: [
        { tag: "path", attrs: { d: "M3 3h10v10H3z" } },
        { tag: "path", attrs: { d: "M5.5 8l2 2 3.5-4" } },
      ],
    },
    // GFM task list (#982): a bullet list whose first item is an unchecked
    // checkbox (`checked: false`). Subsequent items become checkboxes by typing
    // `[ ] ` or stay plain bullets — they coexist in one list.
    run: (editor) =>
      chain(editor).toggleBulletList().updateAttributes("listItem", { checked: false }).run(),
  },
  {
    id: "quote",
    label: "Quote",
    keywords: ["blockquote", "quote"],
    hint: "q",
    icon: {
      kind: "svg",
      els: [
        { tag: "path", attrs: { d: "M3 6c0-1.5 1-2.5 2-2.5" } },
        { tag: "path", attrs: { d: "M3 6v3h3V6z" } },
        { tag: "path", attrs: { d: "M9 6c0-1.5 1-2.5 2-2.5" } },
        { tag: "path", attrs: { d: "M9 6v3h3V6z" } },
      ],
    },
    run: (editor) => chain(editor).toggleBlockquote().run(),
  },
  {
    id: "code-block",
    label: "Code block",
    keywords: ["code", "pre", "snippet"],
    hint: "code",
    icon: {
      kind: "svg",
      els: [
        { tag: "path", attrs: { d: "M5 4l-3 4 3 4" } },
        { tag: "path", attrs: { d: "M11 4l3 4-3 4" } },
      ],
    },
    run: (editor) => chain(editor).toggleCodeBlock().run(),
  },
  {
    id: "horizontal-rule",
    label: "Horizontal rule",
    keywords: ["hr", "divider", "rule", "separator"],
    hint: "hr",
    icon: { kind: "glyph", glyph: "—" },
    run: (editor) => chain(editor).setHorizontalRule().run(),
  },
];

export interface SlashCommandMatch {
  fromOffset: number;
  query: string;
}

export function findSlashCommandMatch(textBeforeCursor: string): SlashCommandMatch | null {
  const match = /(?:^|\s)\/([A-Za-z0-9 -]*)$/.exec(textBeforeCursor);
  if (!match) return null;

  const query = match[1] ?? "";
  const slashOffset = textBeforeCursor.length - query.length - 1;
  return { fromOffset: slashOffset, query };
}

export function filterSlashCommands(query: string): SlashCommandItem[] {
  const normalized = query.trim().toLowerCase();
  if (!normalized) return SLASH_COMMANDS;

  return SLASH_COMMANDS.filter((command) => {
    const haystack = [command.label, ...command.keywords].join(" ").toLowerCase();
    return haystack.includes(normalized);
  });
}
