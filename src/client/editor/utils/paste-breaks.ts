// Turn a pasted `<br>` into a block boundary for plaintext documents (#1460).
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
  "TD",
  "TH",
  "BLOCKQUOTE",
  "H1",
  "H2",
  "H3",
  "H4",
  "H5",
  "H6",
  "FIGCAPTION",
  "DD",
  "DT",
  "SECTION",
  "ARTICLE",
]);

/** A pathological payload must not hang the main thread. */
const MAX_SPLITS = 5000;

/** The block a `<br>` should split, or `root` when it sits at the top level. */
function splittableContainer(br: Element, root: Element): Element {
  for (let el = br.parentElement; el && el !== root; el = el.parentElement) {
    if (SPLITTABLE_BLOCK.has(el.tagName)) return el;
  }
  return root;
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
  const container = splittableContainer(br, root);

  // Split every inline ancestor between the break and the container.
  let node: Node = br;
  for (let parent = br.parentNode; parent && parent !== container; parent = node.parentNode) {
    const clone = parent.cloneNode(false);
    moveTrailingSiblings(node, clone);
    (parent as Element).after(clone);
    node = parent;
  }

  if (container !== root) {
    // `cloneNode(false)` keeps the tag and its attributes but no children, so
    // the second half stays the same kind of block as the first — a heading
    // splits into two headings, a list item into two list items.
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
  root.append(head, second);
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
