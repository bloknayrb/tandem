import * as Y from "yjs";
import { isPlaintextFormat } from "../../shared/plaintext-format.js";
import { chainAtPath } from "../../shared/positions/ydoc.js";
import { normalizeHardBreaks } from "../file-io/hardbreak-normalize.js";
import { type DeferredText, populateDeferredText } from "../file-io/mdast-ydoc.js";

/** A list container and the item within it that an op targets. */
export interface ListTarget {
  /** The enclosing `bulletList` / `orderedList`. */
  list: Y.XmlElement;
  /** The targeted `listItem`. */
  item: Y.XmlElement;
  /** Index of `item` within `list`. */
  index: number;
  /** Path to the list itself, for parent lookups. */
  listPath: number[];
  /** Every element from the fragment root down to the targeted block. */
  chain: Y.XmlElement[];
}

/**
 * Walk a textblock's path back up to the `listItem` that contains it, and that
 * item's list.
 *
 * Returns null when the path names a block that is not inside a list at all —
 * which is a caller error worth a specific message, not a crash.
 */
export function findListTarget(
  fragment: Y.XmlFragment,
  path: number[],
): ListTarget | { error: string } {
  const chain = chainAtPath(fragment, path);
  if (!chain) return { error: "Path does not name an element." };
  // Nearest enclosing listItem, and the list holding it.
  for (let i = chain.length - 1; i >= 0; i--) {
    if (chain[i].nodeName !== "listItem") continue;
    const item = chain[i];
    const list = i > 0 ? chain[i - 1] : null;
    if (!list || (list.nodeName !== "bulletList" && list.nodeName !== "orderedList")) {
      return { error: "List item is not inside a list." };
    }
    // The item's index within its list is the path element at this depth. The
    // ancestor chain rides along so `removeItemAndCollapse` need not re-derive
    // it — re-walking after a mutation, from a path captured before it, is
    // correct only by accident.
    return { list, item, index: path[i], listPath: path.slice(0, i), chain };
  }
  return {
    error:
      "That position is not inside a list. tandem_editList changes the shape of a list; " +
      "use tandem_edit to change text, or tandem_appendContent to add new blocks.",
  };
}

/**
 * Remove `item` from `list`, and collapse any container the removal empties.
 *
 * The collapse is not tidiness. `bulletList` is `listItem+` and `listItem` is
 * `block+`, so a zero-child container is schema-invalid — and invalid is not
 * inert (#1664): `createNodeFromYElement` answers a rejection by deleting the
 * node out of the shared Y.Doc, cascading upward. An emptied list left behind
 * would also contribute no text while still consuming a FLAT_SEPARATOR, shifting
 * every later offset by one until the next reload silently shifted it back.
 *
 * Recurses because removing the last item of a nested list can empty the
 * `listItem` holding it, which can in turn empty that item's own list.
 */
export function removeItemAndCollapse(fragment: Y.XmlFragment, target: ListTarget): void {
  target.list.delete(target.index, 1);
  // Walk the ancestor chain outward, deleting each container the previous
  // deletion emptied. `Y.XmlElement extends Y.XmlFragment`, so the root and
  // every element below it share one binding — no structural type and no cast,
  // which also keeps `.delete` type-checked.
  for (let k = target.listPath.length - 1; k >= 0; k--) {
    const emptied = target.chain[k];
    if (emptied.length > 0) return;
    const parent: Y.XmlFragment = k > 0 ? target.chain[k - 1] : fragment;
    parent.delete(target.listPath[k], 1);
  }
}

/**
 * Which formats can hold a list at all.
 *
 * Phrased over `isPlaintextFormat` rather than `format === "md"`: `.docx` builds
 * real `bulletList`/`orderedList` nodes on import and `docx-export` writes them
 * back to Word, so refusing it would decline an operation the system already
 * performs correctly. The plaintext set is the open-ended fallback in
 * `getAdapter`, so a denylist cannot drift the way an allowlist would.
 */
export function listFormatRefusal(format: string | undefined): string | null {
  if (!isPlaintextFormat(format)) return null;
  return (
    `'${format ?? "plaintext"}' documents have no list structure — a plaintext file stores lines, ` +
    "not items, so there is nothing to insert into or remove from. Edit the lines with " +
    "tandem_edit (one call per line), or ask the user whether this should be a .md file."
  );
}

/**
 * Attach pre-built items into `list` at `index`, then run pass 2.
 *
 * The `normalizeHardBreaks` call is the same one `insertBlocks` makes after
 * every other build, and it is not optional: mdast emits a hard break as an
 * EMBED inside the Y.XmlText, which y-prosemirror cannot render — it surfaces as
 * a literal `<hardbreak></hardbreak>` in the editor. It converts embeds into the
 * sibling elements the rest of the document already uses, and is scoped to the
 * just-inserted items so it cannot disturb existing offsets.
 */
export function attachItems(
  list: Y.XmlElement,
  index: number,
  items: Y.XmlElement[],
  deferred: DeferredText[],
): void {
  if (items.length === 0) return;
  list.insert(index, items);
  populateDeferredText(deferred);
  normalizeHardBreaks(items);
}
