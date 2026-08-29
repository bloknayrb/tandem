/**
 * Y.Doc position primitives shared by the server and the client.
 *
 * FIRST RUNTIME Y.DOC LOGIC IN `src/shared/`. Everything else here is types or
 * pure string math, so this file establishes a precedent and needs its boundary
 * stated rather than assumed.
 *
 * THREE-IMPORT CEILING — `yjs`, `./types.js`, `../offsets.js`, and nothing else,
 * ever. That ceiling is the only thing keeping `node:path` and the remark
 * pipeline out of the browser bundle. These six functions have a pure-Yjs
 * dependency closure, but four of them used to live in
 * `src/server/mcp/document-model.ts`, a 700-line module that imports `node:path`
 * and `saveMarkdown` at module level. Neither import is in the closure, but a
 * client bundle cannot reach past them — which is why this is a leaf extraction
 * rather than the file move it looks like.
 * `tests/shared/ydoc-import-ceiling.test.ts` enforces the ceiling, because
 * `biome.json` disables the linter entirely and there is no `no-restricted-imports`
 * rule to lean on. A ceiling kept by convention is not kept.
 *
 * The server keeps everything needing more than that: `relPosToFlatOffset`,
 * `collectXmlTexts`, `extractText`, `validateRange`, `anchoredRange`,
 * `refreshRange`, and every mutation helper. The client needs neither Y-to-flat
 * (it goes Y-to-PM via `relRangeToPmPositions`) nor any mutation.
 *
 * NOT re-exported from `./index.js`, deliberately: that barrel is `yjs`-free
 * today and imported for types by both sides, so routing runtime Y logic through
 * it would make every consumer pull `yjs` in invisibly.
 */

import * as Y from "yjs";
import { headingPrefixLength as sharedHeadingPrefixLength } from "../offsets.js";
import type {
  ElementPosition,
  FlatOffset,
  RelativeRange,
  SerializedRelPos,
  TextblockPosition,
} from "./types.js";
import { toSerializedRelPos } from "./types.js";

/**
 * True when a node is a sibling `hardBreak` inline-leaf element — the only inline
 * leaf a textblock holds. It occupies exactly 1 flat char and REPLACES the
 * between-block separator (matches the client, which counts every hardBreak as 1;
 * `src/client/positions.ts`). Container children (list items, table cells) instead
 * get a FLAT_SEPARATOR between siblings.
 */
export function isHardBreakElement(node: unknown): boolean {
  return node instanceof Y.XmlElement && node.nodeName === "hardBreak";
}

/**
 * A container's children as a plain array.
 *
 * `for (let i = 0; i < el.length; i++) el.get(i)` is the idiom everywhere in
 * this codebase, and on a container with many children it is QUADRATIC. Yjs
 * gives `AbstractType._searchMarker` a value only for `YArray`
 * (`types/YArray.js`); every other type leaves it null, so `typeListGet` has no
 * marker to jump from and rescans `_start` → `right` on every single call. A
 * markdown list is exactly the structure that puts thousands of children under
 * one parent, which is the shape the list-editing tools exist for. Measured on
 * `resolveToTextblock` at the last item of a list: 5.6 ms → 1.2 ms at 1000
 * items, 431 ms → 4.9 ms at 10 000 (the 5.2x cost for 2x the input is the
 * quadratic signature).
 *
 * `toArray()` walks the child list once. It calls `warnPrematureAccess` on a
 * DETACHED type, though — the same console-warn storm that #1664's first draft
 * produced — so fall back to the index loop when the element has no doc. Every
 * caller here runs on an attached document; the fallback exists so this stays
 * correct if one ever does not.
 */
function childrenOf(element: Y.XmlElement): Array<Y.XmlElement | Y.XmlText> {
  if (element.doc) return element.toArray() as Array<Y.XmlElement | Y.XmlText>;
  const out: Array<Y.XmlElement | Y.XmlText> = [];
  for (let i = 0; i < element.length; i++) {
    out.push(element.get(i) as Y.XmlElement | Y.XmlText);
  }
  return out;
}

/**
 * Compute the flat text length of a Y.XmlElement without building the string.
 * Uses the same one-character separator invariant as getElementText().
 */
export function getElementTextLength(element: Y.XmlElement): number {
  let len = 0;
  let hasPriorContent = false;
  for (const child of childrenOf(element)) {
    if (child instanceof Y.XmlText) {
      len += child.length;
      hasPriorContent = true;
    } else if (child instanceof Y.XmlElement) {
      if (isHardBreakElement(child)) {
        len += 1; // inline-leaf: exactly 1, replaces the separator (see getElementText)
      } else {
        if (hasPriorContent) len += 1;
        len += getElementTextLength(child);
      }
      hasPriorContent = true;
    }
  }
  return len;
}

/**
 * Find the Y.XmlText that contains a given flat text offset within a Y.XmlElement.
 * Returns the XmlText and the offset within it, or null if the offset falls on a
 * separator character or cannot be resolved.
 */
export function findXmlTextAtOffset(
  element: Y.XmlElement,
  textOffset: number,
): { xmlText: Y.XmlText; offsetInXmlText: number } | null {
  let accumulated = 0;
  let hasPriorContent = false;
  for (let i = 0; i < element.length; i++) {
    const child = element.get(i);
    if (child instanceof Y.XmlText) {
      const len = child.length;
      if (accumulated + len > textOffset) {
        return { xmlText: child, offsetInXmlText: textOffset - accumulated };
      }
      accumulated += len;
      hasPriorContent = true;
    } else if (child instanceof Y.XmlElement) {
      if (isHardBreakElement(child)) {
        // Inline-leaf break: 1 flat char, unaddressable like a separator. An offset
        // landing ON it returns null so the caller's assoc fallback re-anchors.
        if (textOffset === accumulated) return null;
        accumulated += 1;
        hasPriorContent = true;
      } else {
        if (hasPriorContent) {
          if (textOffset === accumulated) {
            // Offset lands ON the separator — return null (between-element gap)
            return null;
          }
          accumulated += 1;
        }
        const childTextLen = getElementTextLength(child);
        if (accumulated + childTextLen > textOffset) {
          return findXmlTextAtOffset(child, textOffset - accumulated);
        }
        accumulated += childTextLen;
        hasPriorContent = true;
      }
    }
  }
  // Handle end-of-element: offset equals total length
  if (textOffset === accumulated) {
    // Walk backwards to find the last XmlText
    for (let i = element.length - 1; i >= 0; i--) {
      const child = element.get(i);
      if (child instanceof Y.XmlText) {
        return { xmlText: child, offsetInXmlText: child.length };
      } else if (child instanceof Y.XmlElement) {
        return findXmlTextAtOffset(child, getElementTextLength(child));
      }
    }
  }
  return null;
}

/**
 * Get the heading prefix length for a Y.XmlElement.
 * Delegates to shared headingPrefixLength for the actual math.
 */
export function getHeadingPrefixLength(node: Y.XmlElement): number {
  if (node.nodeName === "heading") {
    const level = Number(node.getAttribute("level") ?? 1);
    return sharedHeadingPrefixLength(level);
  }
  return 0;
}

/**
 * The block types that own text directly and may be edited in place.
 *
 * The single home for these three names. `document-model.ts` re-exports this
 * rather than keeping its own literal: the set governs BOTH which nodes the
 * resolver descends into and which ones the block enumerator emits, so two
 * copies would let a future textblock type be added to one and not the other —
 * and a resolver silently refusing to descend into a node the enumerator
 * happily reports is invisible until an edit lands in the wrong place.
 */
export const TEXTBLOCK_NODES: ReadonlySet<string> = new Set(["paragraph", "heading", "codeBlock"]);

/** True for a node name in {@link TEXTBLOCK_NODES}. */
export function isTextblockName(name: string): boolean {
  return TEXTBLOCK_NODES.has(name);
}

/**
 * Descend into a container to find the textblock owning `offsetInElement`.
 *
 * Mirrors `collectElementFlat`'s separator contract exactly, and it has to:
 * a fourth independent walker over that contract is how the three existing ones
 * would drift. Sibling container children cost one FLAT_SEPARATOR between them
 * (the `hasPriorContent` gate); a `hardBreak` costs 1 and REPLACES the
 * separator; a nested heading contributes NO prefix.
 *
 * Returns the path suffix (child indices) and the offset within the textblock,
 * or null when the descent cannot land in one (an image-only list item, an
 * empty container).
 */
function descendToTextblock(
  element: Y.XmlElement,
  offsetInElement: number,
): { suffix: number[]; textOffset: number } | null {
  if (isTextblockName(element.nodeName)) {
    return { suffix: [], textOffset: offsetInElement };
  }

  let accumulated = 0;
  let hasPriorContent = false;
  let lastChild: { index: number; el: Y.XmlElement; len: number } | null = null;

  /** Resolve to the END of the last block child — the clamp both exits share. */
  const clampToLast = (): { suffix: number[]; textOffset: number } | null => {
    if (!lastChild) return null;
    const tail = descendToTextblock(lastChild.el, lastChild.len);
    return tail ? { suffix: [lastChild.index, ...tail.suffix], textOffset: tail.textOffset } : null;
  };

  const children = childrenOf(element);
  for (let i = 0; i < children.length; i++) {
    const child = children[i];
    if (child instanceof Y.XmlText) {
      // Inline text directly under a container (mixed content). Not a textblock,
      // but it occupies flat characters, so keep the accumulator honest.
      accumulated += child.length;
      hasPriorContent = true;
      continue;
    }
    if (!(child instanceof Y.XmlElement)) continue;
    if (isHardBreakElement(child)) {
      accumulated += 1;
      hasPriorContent = true;
      continue;
    }
    if (hasPriorContent) {
      if (accumulated === offsetInElement && lastChild) {
        // The offset sits ON the separator — resolve to the END of the block
        // before it, matching resolveToElement's own boundary behaviour. Must
        // return BEFORE the `accumulated += 1` below, or the recursive descent
        // would be handed a negative offset.
        return clampToLast();
      }
      accumulated += 1;
    }
    const childLen = getElementTextLength(child);
    if (accumulated + childLen >= offsetInElement) {
      const inner = descendToTextblock(child, offsetInElement - accumulated);
      if (inner) return { suffix: [i, ...inner.suffix], textOffset: inner.textOffset };
    }
    accumulated += childLen;
    hasPriorContent = true;
    lastChild = { index: i, el: child, len: childLen };
  }

  // Past the end: clamp to the last block child, as resolveToElement does.
  return clampToLast();
}

/**
 * Resolve a flat character offset to the TEXTBLOCK that owns it, at any depth.
 *
 * `resolveToElement` stops at the fragment's direct children, so every offset
 * inside a list resolves to the `bulletList` container — which is why
 * `tandem_edit` could not touch a list item and told callers to "edit a specific
 * paragraph or list item instead", advice no tool could follow.
 *
 * Returns null when the offset cannot land in a textblock at all (an empty
 * document, or a container holding only an image).
 */
export function resolveToTextblock(
  fragment: Y.XmlFragment,
  charOffset: FlatOffset,
): TextblockPosition | null {
  const top = resolveToElement(fragment, charOffset);
  if (!top) return null;
  const node = fragment.get(top.elementIndex);
  if (!(node instanceof Y.XmlElement)) return null;

  const inner = descendToTextblock(node, top.textOffset);
  if (!inner) return null;
  return {
    path: [top.elementIndex, ...inner.suffix],
    textOffset: inner.textOffset,
    clampedFromPrefix: top.clampedFromPrefix,
  };
}

/**
 * Walk a path, returning every element along it (root child first, leaf last).
 *
 * The ancestor chain is what callers need more often than the leaf: a list op
 * has to find the enclosing `listItem` AND the list holding it, and a collapse
 * has to delete from each ancestor in turn. Returning only the leaf pushed those
 * callers into re-walking the path themselves, which is how one path walk
 * became three.
 *
 * `Y.XmlElement extends Y.XmlFragment`, so one `Y.XmlFragment` binding accepts
 * the root and every element below it — no structural type, no cast.
 */
export function chainAtPath(fragment: Y.XmlFragment, path: number[]): Y.XmlElement[] | null {
  const chain: Y.XmlElement[] = [];
  let container: Y.XmlFragment = fragment;
  for (const index of path) {
    if (index < 0 || index >= container.length) return null;
    const child = container.get(index);
    if (!(child instanceof Y.XmlElement)) return null;
    chain.push(child);
    container = child;
  }
  return chain;
}

/** Walk a `TextblockPosition.path` back to the element it names. */
export function elementAtPath(fragment: Y.XmlFragment, path: number[]): Y.XmlElement | null {
  return chainAtPath(fragment, path)?.at(-1) ?? null;
}

/**
 * Resolve a flat character offset to a top-level Y.Doc element position.
 *
 * Kept top-level deliberately: the cross-element `tandem_edit` path needs
 * `fragment.delete` indices, and `relPosToFlatOffset` / `anchoredRange` /
 * `stampClaudeAuthorshipWholeDoc` all walk the fragment's direct children.
 * `resolveToTextblock` is the one to reach for when you need the block that
 * actually owns the text.
 */
export function resolveToElement(
  fragment: Y.XmlFragment,
  charOffset: FlatOffset,
): ElementPosition | null {
  let accumulated = 0;

  for (let i = 0; i < fragment.length; i++) {
    const node = fragment.get(i);
    if (!(node instanceof Y.XmlElement)) continue;

    const prefixLen = getHeadingPrefixLength(node);
    const textLen = getElementTextLength(node);
    const fullLen = prefixLen + textLen;

    if (accumulated + fullLen > charOffset) {
      const offsetInFull = charOffset - accumulated;
      const clampedFromPrefix = offsetInFull < prefixLen && prefixLen > 0;
      const textOffset = Math.max(0, offsetInFull - prefixLen);
      return { elementIndex: i, textOffset, clampedFromPrefix };
    }

    accumulated += fullLen;

    if (i < fragment.length - 1) {
      accumulated += 1; // \n separator
      if (accumulated > charOffset) {
        return { elementIndex: i, textOffset: textLen, clampedFromPrefix: false };
      }
    }
  }

  if (fragment.length > 0) {
    const lastNode = fragment.get(fragment.length - 1);
    if (lastNode instanceof Y.XmlElement) {
      return {
        elementIndex: fragment.length - 1,
        textOffset: getElementTextLength(lastNode),
        clampedFromPrefix: false,
      };
    }
  }

  return null;
}

/**
 * Convert a flat text offset to a JSON-serialized Yjs RelativePosition.
 * Returns null if the offset falls in a heading prefix or can't be resolved.
 *
 * Sole mint of `SerializedRelPos` — no other code path constructs the wire
 * shape. Readers (`relPosToFlatOffset` here + `relRangeToPmPositions` in
 * `src/client/positions.ts`) must tolerate `Y.createRelativePositionFromJSON`
 * throwing on stale items after `reloadFromDisk` replaces the Y.Doc content;
 * see `docs/lessons-learned.md` "Dead CRDT RelativePositions Must Be Stripped,
 * Not Preserved" for why the throw is expected rather than a bug.
 */
export function flatOffsetToRelPos(
  doc: Y.Doc,
  offset: FlatOffset,
  assoc: 0 | -1,
): SerializedRelPos | null {
  const fragment = doc.getXmlFragment("default");
  const resolved = resolveToElement(fragment, offset);
  if (!resolved || resolved.clampedFromPrefix) return null;

  const node = fragment.get(resolved.elementIndex);
  if (!(node instanceof Y.XmlElement)) return null;

  let found = findXmlTextAtOffset(node, resolved.textOffset);
  // If the offset lands exactly on an intra-element separator (between nested block children),
  // fall back based on assoc: -1 (stick left) → try offset-1; 0 (stick right) → try offset+1.
  if (!found && assoc === -1 && resolved.textOffset > 0) {
    found = findXmlTextAtOffset(node, resolved.textOffset - 1);
    if (found) {
      // Advance offsetInXmlText to end of this XmlText to stick to the left boundary
      found = { xmlText: found.xmlText, offsetInXmlText: found.xmlText.length };
    }
  } else if (!found && assoc === 0) {
    const nodeLen = getElementTextLength(node);
    if (resolved.textOffset + 1 <= nodeLen) {
      found = findXmlTextAtOffset(node, resolved.textOffset + 1);
    }
  }
  if (!found) return null;
  const rpos = Y.createRelativePositionFromTypeIndex(found.xmlText, found.offsetInXmlText, assoc);
  return toSerializedRelPos(Y.relativePositionToJSON(rpos));
}

// ---------------------------------------------------------------------------
// Range minting
// ---------------------------------------------------------------------------

/**
 * Mint both endpoints of a CRDT-anchored range from flat offsets.
 *
 * `from` sticks right (assoc 0) so text inserted at the start stays outside;
 * `to` sticks left (assoc -1) so text appended at the end stays outside.
 *
 * INTENDED to become the sole assembler of a `RelativeRange` — it is not one
 * yet, and saying so plainly matters more than the aspiration. The three
 * existing sites (`anchoredRange` and both `refreshRange` re-assembly branches
 * in `src/server/positions.ts`) still spell the pair out by hand; collapsing
 * them is deliberately a separate change, because it touches the riskiest
 * server path and because `anchoredRange` cannot be collapsed mechanically: it
 * re-resolves both endpoints on failure and logs only when NEITHER was clamped
 * by a heading prefix, distinguishing "should have anchored and didn't" from
 * "correctly declined". A helper that just returns null erases that, so porting
 * the diagnostic is a precondition, not a detail. Verified consistent: all three
 * sites do use this same assoc pair today.
 *
 * The first consumer is the client-side mint in #1471.
 *
 * All-or-nothing, and that is a real constraint rather than tidiness: the two
 * assocs refuse to mint in DIFFERENT places around an empty block — assoc 0 on
 * the leading separator, assoc -1 on the trailing one, each retrying into the
 * void. A range touching either offset therefore has to degrade as a whole; a
 * caller must never end up holding one anchored endpoint and one raw offset.
 * `tests/client/flat-offset-correspondence.test.ts` pins both refusal sets.
 *
 * Never throws — a null return means the caller falls back to flat offsets.
 * The catch is defensive rather than load-bearing: `flatOffsetToRelPos` returns
 * null for every failure it currently has, and the throw-prone Yjs call
 * (`createRelativePositionFromJSON`, which is documented as throwing on stale
 * items after `reloadFromDisk`) is on the READ path, not this one. Kept because
 * a keystroke handler must not be the place that discovers otherwise.
 */
export function anchorFlatRange(
  doc: Y.Doc,
  from: FlatOffset,
  to: FlatOffset,
): RelativeRange | null {
  try {
    const fromRel = flatOffsetToRelPos(doc, from, 0);
    const toRel = flatOffsetToRelPos(doc, to, -1);
    return fromRel && toRel ? { fromRel, toRel } : null;
  } catch {
    return null;
  }
}
