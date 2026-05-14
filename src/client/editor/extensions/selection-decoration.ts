import { Extension } from "@tiptap/core";
import { Plugin, PluginKey, TextSelection } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";

export const selectionDecorationPluginKey = new PluginKey("tandemSelectionDecoration");

/**
 * Renders the active text-selection range as an inline decoration so the visual
 * highlight survives focus loss. The browser's native `::selection` background only
 * paints while its containing element has focus — when an annotation popup, BubbleMenu
 * input, or any other surface takes focus, the native highlight vanishes and the user
 * loses any signal of what they're about to act on. The decoration stays put.
 *
 * CSS in `editor.css` hides the decoration while `.tandem-editor:focus-within` so the
 * native `::selection` paints unobstructed during normal editing; when focus leaves,
 * the decoration becomes visible (a fainter accent fill — distinguishable from the
 * active blue so the user knows the editor is no longer the focus owner).
 *
 * Only `TextSelection` is decorated. `NodeSelection` and `CellSelection` (tables)
 * keep their own ProseMirror-provided visuals.
 */
export const SelectionDecorationExtension = Extension.create({
  name: "tandemSelectionDecoration",

  addProseMirrorPlugins() {
    return [
      new Plugin({
        key: selectionDecorationPluginKey,
        props: {
          decorations(state) {
            const { selection } = state;
            if (!(selection instanceof TextSelection)) return DecorationSet.empty;
            const { from, to } = selection;
            if (from === to) return DecorationSet.empty;
            return DecorationSet.create(state.doc, [
              Decoration.inline(from, to, { class: "tandem-selection-blurred" }),
            ]);
          },
        },
      }),
    ];
  },
});
