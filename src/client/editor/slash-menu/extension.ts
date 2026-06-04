import { Extension, type Editor as TiptapEditor } from "@tiptap/core";
import { type EditorState, Plugin, PluginKey, type Transaction } from "@tiptap/pm/state";
import {
  filterSlashCommands,
  findSlashCommandMatch,
  type SlashCommandIcon,
  type SlashCommandItem,
} from "./commands";
import { isSlashMenuSuppressed } from "./suppression";

const SVG_NS = "http://www.w3.org/2000/svg";

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

interface SlashCommandMeta {
  type: "select" | "close";
  selectedIndex?: number;
}

export interface SlashCommandOptions {
  onOpenChange?: (open: boolean) => void;
}

export const slashCommandPluginKey = new PluginKey<SlashCommandPluginState>("tandemSlashCommand");

function activeKey(active: ActiveSlashCommand): string {
  return `${active.from}:${active.to}:${active.query}`;
}

/**
 * True when `tr` represents the user *typing* text that ends at the caret --
 * i.e. an insertion (not a caret move, paste/drop, or remote sync) whose
 * inserted run terminates exactly at the resulting selection head.
 *
 * Used to gate slash-menu *opening* (#998): a bare caret move/click that merely
 * lands after a pre-existing "/" must NOT re-open the menu -- only typing the
 * "/" (or query chars while already open) may. Mirrors the local-vs-remote
 * discrimination in `authorship.ts` (`y-sync$` meta marks remote/MCP syncs).
 */
function isTypedInsertionAtCaret(tr: Transaction): boolean {
  // Selection-only transactions (click, arrow keys) never open the menu.
  if (!tr.docChanged) return false;
  // Remote collaborative / MCP-driven syncs are not local typing.
  if (tr.getMeta("y-sync$")) return false;
  // Clipboard paste / drag-drop are explicit UI events, not typing.
  const uiEvent = tr.getMeta("uiEvent");
  if (uiEvent === "paste" || uiEvent === "drop" || tr.getMeta("paste")) return false;

  const caret = tr.selection.from;
  let typedAtCaret = false;
  // Iterate the mapping's own maps (NOT tr.steps -- different index spaces): the
  // map-index `i` is what tr.mapping.slice() is keyed on. Map each inserted-run
  // end forward through the remaining maps with LEFT bias (-1) so a later
  // same-position step (input rule / IME finalize) can't push it past the caret.
  tr.mapping.maps.forEach((map, i) => {
    map.forEach((_oldStart, _oldEnd, newStart, newEnd) => {
      if (newEnd <= newStart) return; // nothing inserted by this map
      const finalEnd = tr.mapping.slice(i + 1).map(newEnd, -1);
      if (finalEnd === caret) typedAtCaret = true;
    });
  });
  return typedAtCaret;
}

function resolveActiveSlashCommand(
  state: EditorState,
  selectedIndex = 0,
): ActiveSlashCommand | null {
  // D10 suppression: never activate while a competing UI surface is mounted.
  // Probing the DOM here keeps the rule centralized -- both initial activation
  // and every subsequent keystroke pass through this function.
  if (isSlashMenuSuppressed()) return null;

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

function clearChildren(element: HTMLDivElement) {
  while (element.firstChild) element.removeChild(element.firstChild);
}

function buildHintRow(): HTMLDivElement {
  const hint = document.createElement("div");
  hint.className = "tandem-slash-menu__hint";
  const groups: Array<[string, string]> = [
    ["↑↓", "navigate"],
    ["↵", "insert"],
    ["esc", "close"],
  ];
  for (const [key, label] of groups) {
    const span = document.createElement("span");
    const kbd = document.createElement("kbd");
    kbd.textContent = key;
    span.appendChild(kbd);
    span.appendChild(document.createTextNode(` ${label}`));
    hint.appendChild(span);
  }
  return hint;
}

function buildIconBadge(icon: SlashCommandIcon): HTMLSpanElement {
  const badge = document.createElement("span");
  badge.className = "tandem-slash-menu__icon";
  badge.setAttribute("aria-hidden", "true");

  if (icon.kind === "glyph") {
    badge.textContent = icon.glyph;
    return badge;
  }

  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("viewBox", "0 0 16 16");
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "1.6");
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");
  for (const el of icon.els) {
    const node = document.createElementNS(SVG_NS, el.tag);
    for (const [name, value] of Object.entries(el.attrs)) {
      node.setAttribute(name, value);
    }
    svg.appendChild(node);
  }
  badge.appendChild(svg);
  return badge;
}

function renderSlashCommandMenu(
  element: HTMLDivElement,
  active: ActiveSlashCommand,
  editor: TiptapEditor,
  dispatchSelection: (selectedIndex: number) => void,
  executeCommand: (command: SlashCommandItem) => void,
) {
  const commands = filterSlashCommands(active.query);
  clearChildren(element);
  element.className = "tandem-floating-pill tandem-slash-menu";

  // Listbox holds ONLY the option buttons so ARIA's "listbox children must
  // be options" rule isn't violated by the hint footer.
  const listbox = document.createElement("div");
  listbox.setAttribute("role", "listbox");
  listbox.setAttribute("aria-label", "Slash commands");

  // Empty results are filtered upstream by resolveActiveSlashCommand (the
  // menu closes), so commands.length is always > 0 by the time we render.
  commands.forEach((command, index) => {
    const button = document.createElement("button");
    button.type = "button";
    button.role = "option";
    button.id = `slash-command-${command.id}`;
    button.className = "tandem-slash-menu__item";
    button.setAttribute("aria-selected", String(index === active.selectedIndex));
    // The icon badge and shortcut alias are decorative (aria-hidden); the
    // explicit aria-label keeps the option's accessible name exactly the label.
    button.setAttribute("aria-label", command.label);
    button.dataset.commandId = command.id;

    button.appendChild(buildIconBadge(command.icon));

    const label = document.createElement("span");
    label.className = "tandem-slash-menu__label";
    label.textContent = command.label;
    button.appendChild(label);

    const shortcut = document.createElement("span");
    shortcut.className = "tandem-slash-menu__shortcut";
    shortcut.setAttribute("aria-hidden", "true");
    shortcut.textContent = command.hint;
    button.appendChild(shortcut);

    button.addEventListener("mouseenter", () => dispatchSelection(index));
    button.addEventListener("mousedown", (e) => {
      e.preventDefault();
      executeCommand(command);
    });
    listbox.appendChild(button);
  });

  element.appendChild(listbox);
  element.appendChild(buildHintRow());

  const coords = editor.view.coordsAtPos(active.from);
  element.style.display = "block";
  element.style.position = "fixed";
  element.style.left = `${Math.max(8, coords.left)}px`;
  element.style.top = `${coords.bottom + 8}px`;
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
          // Never active at construction: "just typed" can't be true at init,
          // and a doc that loads with the caret after a "/token" must not
          // auto-open the menu (#998).
          init: () => ({
            active: null,
            dismissedKey: null,
          }),
          apply(tr, value, _oldState, newState) {
            const metaState = applySlashCommandMeta(tr, value);
            if (metaState) return metaState;

            const nextActive = resolveActiveSlashCommand(
              newState,
              value.active?.selectedIndex ?? 0,
            );

            // Gate the inactive -> active transition: only a typed insertion
            // ending at the caret may *open* the menu. A caret move/click, a
            // paste, or a remote sync that merely lands after an existing "/"
            // is plain text. Once already open we keep re-deriving (below) so
            // the query tracks and the menu closes when the caret leaves. (#998)
            if (nextActive && !value.active && !isTypedInsertionAtCaret(tr)) {
              return { active: null, dismissedKey: value.dismissedKey };
            }

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
            clearChildren(menu);
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
