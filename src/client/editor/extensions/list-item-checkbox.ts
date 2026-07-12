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
        // `keepOnSplit: false` means Tiptap's own split-attribute propagation
        // (`getSplittedAttributes`) never carries `checked` onto a new item —
        // it always starts `null` (plain bullet) unless something overrides
        // it. Enter-continues-as-task (below, in `addKeyboardShortcuts`)
        // explicitly overrides the new item to `checked: false` when the
        // split originates inside a checkbox item; a bare `keepOnSplit: true`
        // can't be used instead because it would propagate `checked: true`
        // as-is and can't distinguish "continuing a checked item" from
        // "continuing a plain item".
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

  addKeyboardShortcuts() {
    const itemType = this.type;
    return {
      ...this.parent?.(),
      // Continue the checkbox on Enter: splitting inside a checked/unchecked
      // item should produce a new checkbox item (unchecked, so completing a
      // task doesn't propagate to the next one), not a plain bullet. Splitting
      // inside a plain item stays plain (no override — `checked` defaults to
      // `null` via `keepOnSplit: false` above).
      //
      // Accepted deviation from GitHub: splitting at position 0 of a checked
      // item (cursor before any text) leaves the emptied *first* item as
      // `checked: true` and moves the original content into the *second*,
      // newly created item, which gets `checked: false`. GitHub instead keeps
      // the checked state on the item that retains the content and makes the
      // new (empty) item unchecked. Reproducing GitHub's behavior would
      // require detecting the position-0 case and swapping which side gets
      // which attrs — not worth the complexity for a rare edge case; pinned
      // by a test below.
      Enter: () => {
        const { $from } = this.editor.state.selection;
        let checked: unknown;
        for (let depth = $from.depth; depth > 0; depth--) {
          const node = $from.node(depth);
          if (node.type === itemType) {
            checked = node.attrs.checked;
            break;
          }
        }
        if (checked !== null && checked !== undefined) {
          return this.editor.commands.splitListItem(this.name, { checked: false });
        }
        // Plain item (or empty item at list end): fall through to the
        // default split, which returns `false` for an empty item, letting
        // the keymap chain continue to StarterKit's liftEmptyBlock (list
        // exit/outdent) — same as plain-list Enter behavior.
        return this.editor.commands.splitListItem(this.name);
      },
    };
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
                  // `side: -1` renders the widget as the first child of the <li>,
                  // before its paragraph. The key includes `pos` (unique per item)
                  // and `checked` (so the widget recreates when the state flips).
                  // `stopEvent` prevents bubbling clicks from reaching editor-level
                  // handlers (annotation/link); `ignoreSelection` keeps the widget
                  // outside selection boundaries (avoids off-by-one cursor positioning).
                  {
                    side: -1,
                    key: `tandem-checkbox-${pos}:${checked}`,
                    stopEvent: () => true,
                    ignoreSelection: true,
                  },
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
    // `nodeAt` only searches direct children of `doc`, so it returns null for
    // a listItem (which is always nested inside a bulletList/orderedList). Use
    // `resolve(liPos).nodeAfter` instead — it descends the tree to the position
    // before the listItem's opening token and returns the node there.
    const node = view.state.doc.resolve(liPos).nodeAfter;
    // Guard the node type so a future placement/mapping change can never inject
    // `checked` onto the wrong node (mirrors the input rule's own type check).
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
