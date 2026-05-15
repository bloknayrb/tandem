import type { Editor as TiptapEditor } from "@tiptap/core";

export type SlashCommandId =
  | "heading-1"
  | "heading-2"
  | "heading-3"
  | "bullet-list"
  | "numbered-list"
  | "quote"
  | "code-block"
  | "horizontal-rule";

export interface SlashCommandItem {
  id: SlashCommandId;
  label: string;
  keywords: string[];
  run: (editor: TiptapEditor) => void;
}

// Tiptap exposes StarterKit commands but doesn't generically type them on the
// chain -- keep the narrow surface we actually call here.
type SlashCommandChain = ReturnType<TiptapEditor["chain"]> & {
  toggleHeading: (attributes: { level: 1 | 2 | 3 }) => SlashCommandChain;
  toggleBulletList: () => SlashCommandChain;
  toggleOrderedList: () => SlashCommandChain;
  toggleBlockquote: () => SlashCommandChain;
  toggleCodeBlock: () => SlashCommandChain;
  setHorizontalRule: () => SlashCommandChain;
};

function chain(editor: TiptapEditor): SlashCommandChain {
  return editor.chain().focus() as SlashCommandChain;
}

export const SLASH_COMMANDS: SlashCommandItem[] = [
  {
    id: "heading-1",
    label: "Heading 1",
    keywords: ["h1", "heading", "title"],
    run: (editor) => chain(editor).toggleHeading({ level: 1 }).run(),
  },
  {
    id: "heading-2",
    label: "Heading 2",
    keywords: ["h2", "heading", "subtitle"],
    run: (editor) => chain(editor).toggleHeading({ level: 2 }).run(),
  },
  {
    id: "heading-3",
    label: "Heading 3",
    keywords: ["h3", "heading", "subheading"],
    run: (editor) => chain(editor).toggleHeading({ level: 3 }).run(),
  },
  {
    id: "bullet-list",
    label: "Bullet list",
    keywords: ["bullet", "ul", "list"],
    run: (editor) => chain(editor).toggleBulletList().run(),
  },
  {
    id: "numbered-list",
    label: "Numbered list",
    keywords: ["numbered", "ordered", "ol", "list"],
    run: (editor) => chain(editor).toggleOrderedList().run(),
  },
  {
    id: "quote",
    label: "Quote",
    keywords: ["blockquote", "quote"],
    run: (editor) => chain(editor).toggleBlockquote().run(),
  },
  {
    id: "code-block",
    label: "Code block",
    keywords: ["code", "pre", "snippet"],
    run: (editor) => chain(editor).toggleCodeBlock().run(),
  },
  {
    id: "horizontal-rule",
    label: "Horizontal rule",
    keywords: ["hr", "divider", "rule", "separator"],
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
