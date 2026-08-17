import { Extension } from "@tiptap/core";
import { isPlaintextFormat } from "../../../shared/plaintext-format.js";

/**
 * Keep a plaintext document's textblocks free of newlines (#1460).
 *
 * `.txt` and friends load one block per line and save by joining blocks with
 * `\n`, so a newline INSIDE a block is a shape the file cannot spell: the bytes
 * say two lines, the model says one block, and the next open believes the bytes.
 * The paragraph the user saved comes back as two. See `shared/plaintext-format.ts`
 * for why the fix has to live at the write points rather than the load path.
 *
 * This extension closes the two doorways a person reaches by hand. Both produce
 * a `hardBreak` element, which `extractText` renders as `\n`, indistinguishable
 * from a block boundary:
 *
 *   1. **Shift+Enter / Mod+Enter** — Tiptap's `HardBreak` default keymap.
 *   2. **Rich paste** — any clipboard carrying `text/html` with a `<br>`.
 *      Handled in `editor-props.ts#transformPastedHTML`, not here, because it
 *      has to run on the HTML string before ProseMirror parses it.
 *
 * In a `.txt` file, Enter and Shift+Enter both mean "line break" — there is no
 * third thing for the second one to mean. Making them do the same is the honest
 * reading of the format, not a compromise, and it is why this can be a keymap
 * override rather than something that has to undo a break after the fact.
 *
 * **`getFormat` is a live getter, and that is load-bearing.** Save-As promotes a
 * document IN PLACE (`document-service.ts` — same docId, same Y.Doc, same
 * provider), so the Tiptap instance survives a `.md` scratchpad becoming a
 * `.txt` file on disk. A format captured at `.configure()` time — the pattern
 * `HeadingCollapseExtension` uses, whose comment justifies it by the editor
 * being keyed to the tab — would stay `"md"` for the rest of that editor's life
 * and keep accepting hardBreaks into a document that is now plaintext. That is
 * the guard failing in precisely the case it was added for, so it must re-read
 * on every keystroke.
 *
 * Not in `buildSchemaExtensions()`: that builder is documented as taking no
 * reactive arguments, and the schema tests call it with no format context.
 *
 * Nothing here touches Svelte state, so it does not go near the
 * `state_unsafe_mutation` hazard that bridging a Tiptap callback normally needs
 * `createCoalescingTick` for.
 */
export interface PlaintextBreaksOptions {
  /** The ACTIVE document's format, re-read on every use. Never a captured value. */
  getFormat: () => string | undefined;
}

export const PlaintextBreaksExtension = Extension.create<PlaintextBreaksOptions>({
  name: "plaintextBreaks",

  addOptions() {
    // Defaulting to `undefined` means `isPlaintextFormat` reads false and the
    // extension is inert — the right default for a guard that reshapes content.
    return { getFormat: () => undefined };
  },

  addKeyboardShortcuts() {
    const splitInsteadOfBreak = () => {
      if (!isPlaintextFormat(this.options.getFormat())) return false;
      // A code block is exempt, matching the other four surfaces
      // (`plaintext-flatten.ts` excludes `codeBlock`; `applySuggestion` checks
      // `inCode`): a newline in there is genuinely a newline and the node stores
      // it literally, so there is nothing to convert. Without this the override
      // was actively harmful rather than merely redundant — `splitBlock` has no
      // `code` guard, so it SUCCEEDED and cut the code block in two, claiming the
      // keystroke and killing `Mod-Enter`'s exit-the-code-block affordance. Found
      // in review.
      if (this.editor.state.selection.$from.parent.type.spec.code) return false;
      // `false` would fall through to HardBreak's own binding; returning the
      // result of splitBlock claims the keystroke. Inside a list item or table
      // cell `splitBlock` splits that container, which is the same thing Enter
      // does there and still leaves no newline inside a textblock.
      this.editor.commands.splitBlock();
      // Claimed unconditionally, INCLUDING when `splitBlock` declines. Returning
      // its result reads more honestly but falls through to HardBreak's binding at
      // exactly the positions where the split was impossible — so the one case the
      // override could not handle would be the one case that inserts the shape it
      // exists to prevent. A keystroke that does nothing is recoverable; a file
      // that comes back a different shape is not.
      return true;
    };
    return {
      "Shift-Enter": splitInsteadOfBreak,
      "Mod-Enter": splitInsteadOfBreak,
    };
  },
});
