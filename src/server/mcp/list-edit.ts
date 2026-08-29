import * as Y from "yjs";
import { isPlaintextFormat } from "../../shared/plaintext-format.js";
import {
  buildListItemsFromTree,
  type DeferredText,
  populateDeferredText,
} from "../file-io/mdast-ydoc.js";

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
  // Re-walk the path collecting ancestors. `elementAtPath` gives only the leaf.
  const chain: Y.XmlElement[] = [];
  let container: { get(i: number): unknown; length: number } = fragment;
  for (const index of path) {
    if (index < 0 || index >= container.length) return { error: "Path does not name a node." };
    const child = container.get(index);
    if (!(child instanceof Y.XmlElement)) return { error: "Path does not name an element." };
    chain.push(child);
    container = child;
  }
  // Nearest enclosing listItem, and the list holding it.
  for (let i = chain.length - 1; i >= 0; i--) {
    if (chain[i].nodeName !== "listItem") continue;
    const item = chain[i];
    const list = i > 0 ? chain[i - 1] : null;
    if (!list || (list.nodeName !== "bulletList" && list.nodeName !== "orderedList")) {
      return { error: "List item is not inside a list." };
    }
    // The item's index within its list is the path element at this depth.
    return { list, item, index: path[i], listPath: path.slice(0, i) };
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
  if (target.list.length > 0) return;

  // The list is now empty. Walk back up deleting whatever it empties in turn.
  let path = target.listPath;
  while (path.length > 0) {
    const parentPath = path.slice(0, -1);
    const childIndex = path[path.length - 1];
    let parent: { get(i: number): unknown; length: number; delete(i: number, n: number): void } =
      fragment as unknown as typeof parent;
    for (const idx of parentPath) {
      const next = parent.get(idx);
      if (!(next instanceof Y.XmlElement)) return;
      parent = next as unknown as typeof parent;
    }
    parent.delete(childIndex, 1);
    if (parent.length > 0) return;
    if (parentPath.length === 0) return; // the fragment itself may be empty
    path = parentPath;
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

/** Build items outside any transaction, then attach and populate inside one. */
export function buildItems(tree: Parameters<typeof buildListItemsFromTree>[0]): {
  items: Y.XmlElement[];
  deferred: DeferredText[];
} {
  return buildListItemsFromTree(tree);
}

/** Attach pre-built items into `list` at `index`, then run pass 2. */
export function attachItems(
  list: Y.XmlElement,
  index: number,
  items: Y.XmlElement[],
  deferred: DeferredText[],
): void {
  if (items.length > 0) list.insert(index, items);
  populateDeferredText(deferred);
}
