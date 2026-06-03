import { InputRule } from "@tiptap/core";
import ListItem from "@tiptap/extension-list-item";
import type { NodeType } from "@tiptap/pm/model";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { Decoration, DecorationSet, type EditorView } from "@tiptap/pm/view";

/**
 * GFM task lists (#982), the mdast-native way: rather than Tiptap's separate
 * `TaskList`/`TaskItem` nodes (which can't mix plain bullets and checkboxes in
 * one list), an ordinary `listItem` carries a per-item `checked` tri-state —
 * exactly how CommonMark/GFM/mdast and GitHub model it:
 *
 *   null  → plain bullet                 (serializes `- text`)
 *   false → unchecked checkbox           (serializes `- [ ] text`)
 *   true  → checked checkbox             (serializes `- [x] text`)
 *
 * Because `checked` is just an attribute on the unchanged `listItem` node:
 *  - one list can hold plain + checkbox items (mixed lists round-trip exactly);
 *  - ordered task lists (`1. [ ] x`) work for free;
 *  - the Y.Doc node name stays `listItem`, so flat-text offsets and annotation
 *    anchoring are provably untouched (the attribute is invisible to
 *    `getElementText`/`getElementTextLength`). The server mapping in
 *    `mdast-ydoc.ts` reads/writes the same attribute.
 *
 * The checkbox itself is a **widget decoration**, not a NodeView (this editor
 * has none): the node's `contentDOM` stays the default `<li>`, so list
 * rendering, selection, and other decorations are unchanged. Unlike the
 * annotation/authorship decoration plugins (which map a DecorationSet across
 * transactions to preserve inline-range positions), this set is purely
 * attribute-derived and cheap, so it is rebuilt directly in
 * `props.decorations` — there is no position state to carry forward.
 */

const checkboxPluginKey = new PluginKey("listItemCheckbox");

/** `[ ] ` / `[x] ` typed at the start of a list item promotes it to a checkbox. */
const TASK_INPUT_RULE = /^\[([ xX])\]\s$/;

export const ListItemCheckbox = ListItem.extend({
  addAttributes() {
    return {
      // Preserve any attributes the base ListItem declares.
      ...this.parent?.(),
      checked: {
        default: null,
        // A split (Enter) starts a fresh plain bullet rather than inheriting a
        // pre-checked box; users type `[ ] ` or use the slash command to make
        // the next item a checkbox. (Enter-continues-as-task is a deferrable
        // nicety; keeping default split behavior avoids overriding the list
        // keymap.)
        keepOnSplit: false,
        parseHTML: (element) => {
          const raw = element.getAttribute("data-checked");
          if (raw === "true") return true;
          if (raw === "false") return false;
          return null;
        },
        renderHTML: (attributes) => {
          if (attributes.checked === null || attributes.checked === undefined) {
            return {};
          }
          return { "data-checked": String(attributes.checked) };
        },
      },
    };
  },

  addInputRules() {
    const itemType = this.type;
    return [
      new InputRule({
        find: TASK_INPUT_RULE,
        handler: ({ state, range, match }) => {
          const checked = match[1] !== " ";
          const $from = state.doc.resolve(range.from);
          // Find the enclosing listItem.
          let liPos = -1;
          let liAttrs: Record<string, unknown> = {};
          for (let depth = $from.depth; depth > 0; depth--) {
            const node = $from.node(depth);
            if (node.type === itemType) {
              liPos = $from.before(depth);
              liAttrs = node.attrs;
              break;
            }
          }
          if (liPos < 0) return null;
          const tr = state.tr;
          // Remove the literal `[ ] ` / `[x] ` marker the user typed.
          tr.delete(range.from, range.to);
          tr.setNodeMarkup(liPos, undefined, { ...liAttrs, checked });
        },
      }),
    ];
  },

  addProseMirrorPlugins() {
    const itemType = this.type;
    const parentPlugins = this.parent?.() ?? [];
    return [
      ...parentPlugins,
      new Plugin({
        key: checkboxPluginKey,
        props: {
          decorations: (state) => {
            const decorations: Decoration[] = [];
            state.doc.descendants((node, pos) => {
              if (node.type !== itemType) return;
              if (node.attrs.checked === null || node.attrs.checked === undefined) {
                return;
              }
              const checked = node.attrs.checked === true;
              decorations.push(
                Decoration.widget(
                  pos + 1,
                  (view, getPos) => buildCheckbox(view, getPos, checked, itemType),
                  // `side: -1` renders the widget as the first child of the
                  // <li>, before its paragraph; the key includes `checked` so
                  // the widget is recreated when the state flips.
                  { side: -1, key: `tandem-checkbox-${checked}` },
                ),
              );
            });
            return DecorationSet.create(state.doc, decorations);
          },
        },
      }),
    ];
  },
});

/** Build the non-editable checkbox widget for a checkbox list item. */
function buildCheckbox(
  view: EditorView,
  getPos: () => number | undefined,
  checked: boolean,
  itemType: NodeType,
): HTMLElement {
  const label = document.createElement("label");
  label.className = "tandem-list-checkbox";
  label.contentEditable = "false";

  const input = document.createElement("input");
  input.type = "checkbox";
  input.checked = checked;
  input.setAttribute("aria-label", checked ? "Checked task" : "Unchecked task");

  // Keep the editor selection from collapsing onto the widget when clicked.
  input.addEventListener("mousedown", (event) => event.preventDefault());
  input.addEventListener("change", () => {
    // The model drives the rendered state; revert the native toggle in
    // read-only mode (the decoration will be rebuilt from the unchanged attr).
    if (!view.editable) {
      input.checked = checked;
      return;
    }
    const widgetPos = getPos();
    if (widgetPos == null) return;
    const liPos = widgetPos - 1;
    const node = view.state.doc.nodeAt(liPos);
    // Defensive: the widget is created at the listItem's content-start, so
    // liPos is always a listItem in practice — but guard the node type so a
    // future placement/mapping change can never inject `checked` onto the
    // wrong node (mirrors the input rule's own type check).
    if (!node || node.type !== itemType) return;
    view.dispatch(
      view.state.tr.setNodeMarkup(liPos, undefined, {
        ...node.attrs,
        checked: !node.attrs.checked,
      }),
    );
  });

  label.appendChild(input);
  return label;
}
