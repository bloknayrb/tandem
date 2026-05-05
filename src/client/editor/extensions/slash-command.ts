import { Extension, type Editor as TiptapEditor } from "@tiptap/core";
import { type EditorState, Plugin, PluginKey, type Transaction } from "@tiptap/pm/state";

export type SlashCommandId =
  | "heading-1"
  | "heading-2"
  | "bullet-list"
  | "numbered-list"
  | "quote"
  | "code-block";

export interface SlashCommandItem {
  id: SlashCommandId;
  label: string;
  keywords: string[];
  run: (editor: TiptapEditor) => void;
}

export interface SlashCommandMatch {
  fromOffset: number;
  query: string;
}

interface ActiveSlashCommand {
  from: number;
  to: number;
  query: string;
  selectedIndex: number;
}

interface SlashCommandPluginState {
  active: ActiveSlashCommand | null;
  dismissedKey: string | null;
}

type SlashCommandChain = ReturnType<TiptapEditor["chain"]> & {
  toggleHeading: (attributes: { level: 1 | 2 }) => SlashCommandChain;
  toggleBulletList: () => SlashCommandChain;
  toggleOrderedList: () => SlashCommandChain;
  toggleBlockquote: () => SlashCommandChain;
  toggleCodeBlock: () => SlashCommandChain;
};

interface SlashCommandMeta {
  type: "select" | "close";
  selectedIndex?: number;
}

export interface SlashCommandOptions {
  onOpenChange?: (open: boolean) => void;
}

export const slashCommandPluginKey = new PluginKey<SlashCommandPluginState>("tandemSlashCommand");

function slashCommandChain(editor: TiptapEditor): SlashCommandChain {
  return editor.chain().focus() as SlashCommandChain;
}

export const SLASH_COMMANDS: SlashCommandItem[] = [
  {
    id: "heading-1",
    label: "Heading 1",
    keywords: ["h1", "heading", "title"],
    run: (editor) => slashCommandChain(editor).toggleHeading({ level: 1 }).run(),
  },
  {
    id: "heading-2",
    label: "Heading 2",
    keywords: ["h2", "heading", "subtitle"],
    run: (editor) => slashCommandChain(editor).toggleHeading({ level: 2 }).run(),
  },
  {
    id: "bullet-list",
    label: "Bullet list",
    keywords: ["bullet", "ul", "list"],
    run: (editor) => slashCommandChain(editor).toggleBulletList().run(),
  },
  {
    id: "numbered-list",
    label: "Numbered list",
    keywords: ["numbered", "ordered", "ol", "list"],
    run: (editor) => slashCommandChain(editor).toggleOrderedList().run(),
  },
  {
    id: "quote",
    label: "Quote",
    keywords: ["blockquote", "quote"],
    run: (editor) => slashCommandChain(editor).toggleBlockquote().run(),
  },
  {
    id: "code-block",
    label: "Code block",
    keywords: ["code", "pre"],
    run: (editor) => slashCommandChain(editor).toggleCodeBlock().run(),
  },
];

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

function activeKey(active: ActiveSlashCommand): string {
  return `${active.from}:${active.to}:${active.query}`;
}

function resolveActiveSlashCommand(
  state: EditorState,
  selectedIndex = 0,
): ActiveSlashCommand | null {
  const { selection } = state;
  if (!selection.empty) return null;

  const $from = selection.$from;
  const textBeforeCursor = $from.parent.textBetween(0, $from.parentOffset, "\n", "\n");
  const match = findSlashCommandMatch(textBeforeCursor);
  if (!match) return null;

  const from = $from.start() + match.fromOffset;
  const to = $from.pos;
  const items = filterSlashCommands(match.query);
  if (items.length === 0) return null;

  return {
    from,
    to,
    query: match.query,
    selectedIndex: Math.min(selectedIndex, items.length - 1),
  };
}

function applySlashCommandMeta(
  tr: Transaction,
  previous: SlashCommandPluginState,
): SlashCommandPluginState | null {
  const meta = tr.getMeta(slashCommandPluginKey) as SlashCommandMeta | undefined;
  if (!meta) return null;

  if (meta.type === "close") {
    return {
      active: null,
      dismissedKey: previous.active ? activeKey(previous.active) : previous.dismissedKey,
    };
  }

  if (meta.type === "select" && previous.active) {
    return {
      ...previous,
      active: {
        ...previous.active,
        selectedIndex: meta.selectedIndex ?? previous.active.selectedIndex,
      },
    };
  }

  return previous;
}

function renderSlashCommandMenu(
  element: HTMLDivElement,
  active: ActiveSlashCommand,
  editor: TiptapEditor,
  dispatchSelection: (selectedIndex: number) => void,
  executeCommand: (command: SlashCommandItem) => void,
) {
  const commands = filterSlashCommands(active.query);
  element.innerHTML = "";
  element.setAttribute("role", "listbox");
  element.setAttribute("aria-label", "Slash commands");

  commands.forEach((command, index) => {
    const button = document.createElement("button");
    button.type = "button";
    button.role = "option";
    button.id = `slash-command-${command.id}`;
    button.setAttribute("aria-selected", String(index === active.selectedIndex));
    button.textContent = command.label;
    button.dataset.commandId = command.id;
    button.style.cssText =
      "display: block; width: 100%; padding: 7px 10px; border: 0; border-radius: 4px; " +
      "background: transparent; color: var(--tandem-fg); font: inherit; font-size: 13px; " +
      "text-align: left; cursor: pointer;";

    if (index === active.selectedIndex) {
      button.style.background = "var(--tandem-accent-bg)";
      button.style.color = "var(--tandem-accent)";
    }

    button.addEventListener("mouseenter", () => dispatchSelection(index));
    button.addEventListener("mousedown", (e) => {
      e.preventDefault();
      executeCommand(command);
    });
    element.appendChild(button);
  });

  const coords = editor.view.coordsAtPos(active.from);
  element.style.display = "block";
  element.style.position = "fixed";
  element.style.left = `${Math.max(8, coords.left)}px`;
  element.style.top = `${coords.bottom + 8}px`;
  element.style.zIndex = "1100";
  element.style.minWidth = "180px";
  element.style.padding = "4px";
  element.style.border = "1px solid var(--tandem-border)";
  element.style.borderRadius = "6px";
  element.style.background = "var(--tandem-surface)";
  element.style.boxShadow =
    "0 1px 2px color-mix(in srgb, var(--tandem-fg) 4%, transparent), " +
    "0 8px 28px color-mix(in srgb, var(--tandem-fg) 10%, transparent)";
}

function executeSlashCommand(editor: TiptapEditor, active: ActiveSlashCommand) {
  const command = filterSlashCommands(active.query)[active.selectedIndex];
  if (!command) return false;

  editor.chain().focus().deleteRange({ from: active.from, to: active.to }).run();
  command.run(editor);
  return true;
}

export const SlashCommandExtension = Extension.create<SlashCommandOptions>({
  name: "slashCommand",

  addOptions() {
    return {
      onOpenChange: undefined,
    };
  },

  addProseMirrorPlugins() {
    const editor = this.editor;
    const onOpenChange = this.options.onOpenChange;

    return [
      new Plugin<SlashCommandPluginState>({
        key: slashCommandPluginKey,
        state: {
          init: (_, state) => ({
            active: resolveActiveSlashCommand(state),
            dismissedKey: null,
          }),
          apply(tr, value, _oldState, newState) {
            const metaState = applySlashCommandMeta(tr, value);
            if (metaState) return metaState;

            const nextActive = resolveActiveSlashCommand(
              newState,
              value.active?.selectedIndex ?? 0,
            );
            if (nextActive && activeKey(nextActive) === value.dismissedKey) {
              return { active: null, dismissedKey: value.dismissedKey };
            }

            return {
              active: nextActive,
              dismissedKey: nextActive ? null : value.dismissedKey,
            };
          },
        },
        props: {
          handleKeyDown(view, event) {
            const pluginState = slashCommandPluginKey.getState(view.state);
            const active = pluginState?.active;
            if (!active) return false;

            const commands = filterSlashCommands(active.query);
            if (event.key === "ArrowDown") {
              event.preventDefault();
              const selectedIndex = (active.selectedIndex + 1) % commands.length;
              view.dispatch(
                view.state.tr.setMeta(slashCommandPluginKey, {
                  type: "select",
                  selectedIndex,
                }),
              );
              return true;
            }

            if (event.key === "ArrowUp") {
              event.preventDefault();
              const selectedIndex = (active.selectedIndex - 1 + commands.length) % commands.length;
              view.dispatch(
                view.state.tr.setMeta(slashCommandPluginKey, {
                  type: "select",
                  selectedIndex,
                }),
              );
              return true;
            }

            if (event.key === "Enter") {
              event.preventDefault();
              return executeSlashCommand(editor, active);
            }

            if (event.key === "Escape") {
              event.preventDefault();
              view.dispatch(view.state.tr.setMeta(slashCommandPluginKey, { type: "close" }));
              return true;
            }

            return false;
          },
        },
        view(view) {
          const menu = document.createElement("div");
          menu.dataset.testid = "slash-command-menu";
          menu.style.display = "none";
          document.body.appendChild(menu);
          let wasOpen = false;

          const setOpen = (open: boolean) => {
            if (open === wasOpen) return;
            wasOpen = open;
            onOpenChange?.(open);
          };

          const hide = () => {
            menu.style.display = "none";
            menu.innerHTML = "";
            setOpen(false);
          };

          const update = () => {
            const active = slashCommandPluginKey.getState(view.state)?.active;
            if (!active) {
              hide();
              return;
            }

            renderSlashCommandMenu(
              menu,
              active,
              editor,
              (selectedIndex) => {
                view.dispatch(
                  view.state.tr.setMeta(slashCommandPluginKey, {
                    type: "select",
                    selectedIndex,
                  }),
                );
              },
              (command) => {
                editor.chain().focus().deleteRange({ from: active.from, to: active.to }).run();
                command.run(editor);
                hide();
                view.dispatch(view.state.tr.setMeta(slashCommandPluginKey, { type: "close" }));
              },
            );
            setOpen(true);
          };

          update();
          return {
            update,
            destroy() {
              setOpen(false);
              menu.remove();
            },
          };
        },
      }),
    ];
  },
});
