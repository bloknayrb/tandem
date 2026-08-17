import { Fragment, type Node as PMNode, Slice } from "@tiptap/pm/model";

// Turn a pasted break into a block boundary for plaintext documents (#1460).
//
// This is the second of the two doorways a person reaches by hand. The first is
// Shift+Enter (see `extensions/plaintext-breaks.ts`); this one is far more
// common, because it needs no intent at all — any ordinary Ctrl+V from a web
// page, Word, Slack or Google Docs carries `text/html`, and `text/html` carries
// real `<br>` tags.
//
// It was invisible to the guard already in place. `normalizePastedHtmlWhitespace`
// collapses a literal NEWLINE inside a `<p>` to a space, and
// `tests/client/txt-intra-paragraph-newline.test.ts` pins that. A `<br>` is not
// whitespace, so nothing touched it, and it parses to a real `hardBreak` node —
// which `extractText` renders as `"\n"`, indistinguishable from a block
// boundary. Measured: pasting `<p>alpha<br>bravo</p>` yields one block holding
// one hardBreak, text `"alpha\nbravo"`, which reopens as two paragraphs.
//
// Done on the HTML string rather than on the parsed Slice deliberately. Slices
// carry `openStart`/`openEnd` depths, and splitting a block that one of those
// depths reaches through invalidates them — so the same operation costs an
// open-depth recomputation there and nothing here.

/**
 * Elements that establish a block box, so splitting one yields two blocks that
 * ProseMirror will parse as siblings.
 *
 * Kept separate from `paste-whitespace.ts`'s near-identical set on purpose: that
 * one answers "where does the browser trim edge whitespace", which is a question
 * about CSS. This one answers "what can I clone to make a second block", which
 * is a question about the parse. They agree today and have no reason to stay
 * agreed — sharing one set would couple two unrelated rules.
 */
const SPLITTABLE_BLOCK = new Set([
  "P",
  "DIV",
  "LI",
  "BLOCKQUOTE",
  "FIGCAPTION",
  "DD",
  "DT",
  "SECTION",
  "ARTICLE",
]);

/**
 * Blocks where a `<br>` becomes a SPACE rather than a boundary, because splitting
 * one invents structure the file will not contain.
 *
 * - **A heading**, for the reason `plaintext-flatten.ts` collapses one at Save-As:
 *   `extractText` maps a heading's newlines to spaces, so a two-line heading
 *   serializes as `# one two`. Splitting writes `# one\n# two` — a heading and a
 *   line that were never pasted. The two surfaces have to agree, and this one used
 *   to disagree.
 * - **A table cell**, which is worse than an invented line: `container.after()` on
 *   a `<td>` inserts a cell into the ROW, so the row gains a column and
 *   ProseMirror's table parser pads every other row with blanks to match.
 *   Measured; found in review.
 */
const COLLAPSE_TO_SPACE = new Set(["H1", "H2", "H3", "H4", "H5", "H6", "TD", "TH"]);

/**
 * Preformatted content, where the break becomes a literal NEWLINE.
 *
 * A newline inside a `<pre>` is representable and correct: it parses to a
 * `codeBlock`, which stores newlines literally — the one node type that can. The
 * whitespace normalizer treats `PRE` as verbatim, so the newline survives it.
 *
 * `CODE` is deliberately absent. A bare inline `<code>` span lives inside a
 * paragraph, and putting a newline there would produce exactly the intra-block
 * break this whole module exists to prevent.
 */
const PREFORMATTED = "PRE";

/** How a given `<br>` must be handled, decided by its nearest meaningful ancestor. */
type BreakPlan =
  | { kind: "split"; container: Element }
  | { kind: "text"; value: string }
  | { kind: "wrap" };

/**
 * A pathological payload must not hang the main thread.
 *
 * Measured on the real function (happy-dom, one paragraph): 1 000 breaks 39 ms,
 * 5 000 breaks 225 ms, 20 000 breaks 286 ms. The first cut capped at 5 000, which
 * a long log pasted out of a `<br>`-based viewer can plausibly exceed.
 *
 * **The bail returns the HTML unchanged, and that is the deliberate direction.**
 * It leaves the breaks in place, so a >20 000-line paste reopens with the shape
 * divergence this module exists to prevent — but the bytes are right, and the
 * alternative cheap bail (collapse every `<br>` to a space) would destroy the line
 * structure in the file itself. Divergent shape with correct bytes is recoverable;
 * a file whose lines were merged is not.
 */
const MAX_SPLITS = 20_000;

/**
 * What to do with this `<br>`, decided by the FIRST ancestor that has an opinion.
 *
 * One walk, three answers, rather than a splittable-or-root pair — because the
 * cases that are neither are the ones that were silently wrong: a cell split
 * sideways into the row, and a `<pre>` fell through to the root branch and got
 * wrapped in a `<p>` it cannot legally sit inside.
 */
function planFor(br: Element, root: Element): BreakPlan {
  for (let el = br.parentElement; el && el !== root; el = el.parentElement) {
    if (el.tagName === PREFORMATTED) return { kind: "text", value: "\n" };
    if (COLLAPSE_TO_SPACE.has(el.tagName)) return { kind: "text", value: " " };
    if (SPLITTABLE_BLOCK.has(el.tagName)) return { kind: "split", container: el };
  }
  return { kind: "wrap" };
}

/**
 * Tags that cannot legally sit inside a `<p>`.
 *
 * The root branch wraps each half in a paragraph, and doing that around a block
 * element is not merely untidy — the next HTML parse auto-closes the `<p>` before
 * it, so `<p><pre>…</pre></p>` reparses as an EMPTY paragraph followed by the
 * `<pre>`. That empty paragraph is a blank line the user never pasted, and it
 * reaches the file. Measured; found in review.
 */
const BLOCK_LEVEL = new Set([
  "ADDRESS",
  "ARTICLE",
  "ASIDE",
  "BLOCKQUOTE",
  "DD",
  "DIV",
  "DL",
  "DT",
  "FIELDSET",
  "FIGCAPTION",
  "FIGURE",
  "FOOTER",
  "FORM",
  "H1",
  "H2",
  "H3",
  "H4",
  "H5",
  "H6",
  "HEADER",
  "HR",
  "LI",
  "MAIN",
  "NAV",
  "OL",
  "P",
  "PRE",
  "SECTION",
  "TABLE",
  "UL",
]);

/** Does this fragment hold anything that a `<p>` may not contain? */
function holdsBlockContent(node: Node): boolean {
  for (const child of Array.from(node.childNodes)) {
    if (child.nodeType === 1 && BLOCK_LEVEL.has((child as Element).tagName)) return true;
  }
  return false;
}

/** Move every sibling after `node` into `into`, preserving order. */
function moveTrailingSiblings(node: Node, into: Node): void {
  for (let sib = node.nextSibling; sib; ) {
    const next = sib.nextSibling;
    into.appendChild(sib);
    sib = next;
  }
}

/**
 * Split `container` at `br`, dropping the `br`.
 *
 * Walks up from the `<br>` cloning each intervening inline element, so
 * `<p>a<em>b<br>c</em>d</p>` reopens the `<em>` around the tail rather than
 * flattening it and losing the emphasis on `c`. Each clone is inserted directly
 * after its original, which means the next level up sweeps it in for free.
 *
 * Deliberately NOT `Range.extractContents`, which is the obvious tool and reads
 * more cleanly: happy-dom's implementation of it does not perform the split, so
 * the whole guard silently no-opped under test while looking correct. A
 * correctness rule I cannot exercise in CI is not a rule, so this uses only
 * `cloneNode`/`appendChild`/`after` — operations the test environment and every
 * browser implement the same way.
 */
function splitAtBreak(br: Element, root: Element, doc: Document): void {
  const plan = planFor(br, root);

  // A context where a boundary would invent structure: substitute a character and
  // leave the shape alone. No ancestor walk, because nothing is being split.
  if (plan.kind === "text") {
    br.replaceWith(doc.createTextNode(plan.value));
    return;
  }

  const container = plan.kind === "split" ? plan.container : root;

  // Split every inline ancestor between the break and the container.
  let node: Node = br;
  for (let parent = br.parentNode; parent && parent !== container; parent = node.parentNode) {
    const clone = parent.cloneNode(false);
    moveTrailingSiblings(node, clone);
    (parent as Element).after(clone);
    node = parent;
  }

  if (plan.kind === "split") {
    // `cloneNode(false)` keeps the tag and its attributes but no children, so
    // the second half stays the same kind of block as the first — a list item
    // splits into two list items.
    const sibling = container.cloneNode(false) as Element;
    moveTrailingSiblings(node, sibling);
    container.after(sibling);
    br.remove();
    return;
  }

  // At the top level there is no block to clone, so wrapping both halves in
  // paragraphs is what makes them parse as two blocks instead of one. Order
  // matters: sweep the tail out and drop the break BEFORE collecting the head,
  // or the head would swallow both.
  const second = doc.createElement("p");
  moveTrailingSiblings(node, second);
  br.remove();
  const head = doc.createElement("p");
  while (root.firstChild) head.appendChild(root.firstChild);

  // Wrap only what a paragraph may legally hold. A half that is already block
  // content is appended as-is: it parses as its own block anyway, which is the
  // whole point, and wrapping it manufactures an empty paragraph in front of it.
  root.append(...unwrapIfBlock(head), ...unwrapIfBlock(second));
}

/** The wrapper, or its children if a paragraph may not hold them. */
function unwrapIfBlock(wrapper: Element): Node[] {
  return holdsBlockContent(wrapper) ? Array.from(wrapper.childNodes) : [wrapper];
}

/**
 * Turn every `hardBreak` in an already-parsed clipboard Slice into a block
 * boundary — the `text/plain` counterpart of `splitPastedHardBreaks`.
 *
 * Needed because a clipboard carrying no `text/html` flavour never reaches
 * `transformPastedHTML` at all. That is an ordinary Ctrl+V out of a terminal, a
 * code editor, `less`, or an OS text field, and `clipboardTextParser` hands the
 * text to `markdownToSlice`, whose token spec maps markdown break syntax straight
 * onto a `hardBreak` node. A sixth producer, found in review after the commit that
 * claimed five were the complete set.
 *
 * Operates on the Slice rather than on the text, so the markdown parse is KEPT: a
 * heading, a list or bold in the pasted text still arrives as itself. Falling back
 * to the plain-text splitter instead would have pasted `**bold**` as four literal
 * characters whenever the text also contained a break, and as real bold when it
 * did not — the same paste behaving two ways.
 *
 * `openStart`/`openEnd` are carried through unchanged: they describe the first and
 * last node's open depth, and a split leaves a first and a last node of the same
 * type at the same depth.
 */
export function splitSliceHardBreaks(slice: Slice): Slice {
  const content = splitFragmentBreaks(slice.content);
  return content === slice.content ? slice : new Slice(content, slice.openStart, slice.openEnd);
}

function splitFragmentBreaks(fragment: Fragment): Fragment {
  const out: PMNode[] = [];
  let changed = false;
  fragment.forEach((node) => {
    if (node.isTextblock) {
      const pieces = splitTextblockBreaks(node);
      if (pieces) {
        changed = true;
        out.push(...pieces);
      } else {
        out.push(node);
      }
      return;
    }
    if (node.isLeaf) {
      out.push(node);
      return;
    }
    const inner = splitFragmentBreaks(node.content);
    if (inner === node.content) {
      out.push(node);
    } else {
      changed = true;
      out.push(node.copy(inner));
    }
  });
  return changed ? Fragment.fromArray(out) : fragment;
}

/** One node per line, or `null` when there is nothing to split. */
function splitTextblockBreaks(node: PMNode): PMNode[] | null {
  // A code block stores newlines literally and admits no hardBreak — the same
  // exemption the other four surfaces make.
  if (node.type.spec.code) return null;

  const groups: PMNode[][] = [[]];
  let sawBreak = false;
  node.content.forEach((child) => {
    if (child.type.name === "hardBreak") {
      sawBreak = true;
      groups.push([]);
    } else {
      groups[groups.length - 1].push(child);
    }
  });
  if (!sawBreak) return null;

  // A heading collapses to one block joined with spaces, matching
  // `plaintext-flatten.ts` and `applyAsBlocks`: `extractText` maps a heading's
  // newlines to spaces, so splitting would invent a heading the file cannot hold.
  if (node.type.name === "heading") {
    const joined: PMNode[] = [];
    for (const [i, group] of groups.entries()) {
      if (i > 0 && node.type.schema.text) joined.push(node.type.schema.text(" "));
      joined.push(...group);
    }
    return [node.type.create(node.attrs, Fragment.fromArray(joined), node.marks)];
  }

  return groups.map((group) => node.type.create(node.attrs, Fragment.fromArray(group), node.marks));
}

/**
 * Replace every `<br>` in `html` with a block boundary.
 *
 * Only for plaintext-routed documents — the caller gates on format. In markdown
 * a `<br>` is a legitimate hard break that the serializer writes as a trailing
 * `\`, and rewriting it there would destroy a distinction the file can express.
 *
 * An empty half is correct, not a bug to guard: `<p><br></p>` is two lines, and
 * two empty paragraphs is also two lines. Collapsing it would drop one.
 */
export function splitPastedHardBreaks(html: string): string {
  if (typeof DOMParser === "undefined") return html;
  if (!/<br[\s/>]/i.test(html)) return html;

  let parsed: Document;
  try {
    parsed = new DOMParser().parseFromString(html, "text/html");
  } catch {
    // A clipboard payload we cannot parse is one we must not rewrite.
    return html;
  }
  const root = parsed.body;
  if (!root) return html;

  // Deliberately NOT skipped for a ProseMirror-internal paste
  // (`[data-pm-slice]`), unlike the whitespace normalizer beside it. That skip
  // exists because internal markup's whitespace is content the user copied. A
  // hardBreak copied out of a markdown document and pasted into a `.txt` one is
  // the reverse: it is a shape the destination cannot store, and the copy's
  // provenance does not change that.
  const breaks = [...root.querySelectorAll("br")];
  if (breaks.length > MAX_SPLITS) return html;

  // Last to first: splitting at a later `<br>` leaves every earlier one in the
  // head container, still connected and still needing the same treatment.
  // Front-to-back would have to re-find them after each split.
  for (let i = breaks.length - 1; i >= 0; i -= 1) {
    const br = breaks[i];
    if (br.isConnected) splitAtBreak(br, root, parsed);
  }
  return root.innerHTML;
}
