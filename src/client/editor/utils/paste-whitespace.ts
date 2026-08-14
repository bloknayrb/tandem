// Whitespace normalization for pasted HTML (#1448).
//
// Declaring `whitespace: "pre"` on the paragraph node — which is what stops the
// editor turning soft line wraps into hard breaks — has a second, unwanted
// effect on paste that is easy to miss, because it defeats the flag that was
// supposed to prevent it.
//
// `parseFromClipboard` passes `preserveWhitespace: !!(asText || sliceData)`,
// which is `false` for ordinary external HTML — exactly right. But that is only
// the BASE option. Once the parser enters a `<p>`, `wsOptionsFor` is consulted
// with the rule's own `preserveWhitespace` (the paragraph rule sets none) and
// falls through to `type.whitespace == "pre"`, which now wins
// (`prosemirror-model/dist/index.js:2696-2700`). The per-node setting overrides
// the paste-level intent.
//
// Consequence, reproduced: pasting pretty-printed HTML — most web pages, many
// Word and Google Docs exports —
//
//     <p>\n  Some text\n  more text\n</p>
//
// used to import as "Some text more text" and instead imports the literal
// newlines and indentation. Saved, that becomes soft wraps at arbitrary columns
// plus `&#x20;` escapes. It renders about the same, but the source is noise the
// user did not type.
//
// So we do the collapsing the browser would have done, before ProseMirror sees
// the markup. This is deliberately NOT a schema or parse-rule change: giving the
// paragraph rule an explicit `preserveWhitespace: false` would fix paste and
// silently reopen the original bug for any paragraph re-read without a node view
// desc to supply `"full"`.

/** Elements whose whitespace is significant and must be left exactly as-is. */
const VERBATIM = new Set(["PRE", "CODE", "TEXTAREA", "SCRIPT", "STYLE"]);

/**
 * Elements that establish a block box. Leading and trailing whitespace inside
 * one of these is dropped by the browser, so we drop it too — otherwise a
 * pretty-printed `<p>` keeps the space its indentation collapsed down to and
 * the paragraph saves with a leading `&#x20;`.
 */
const BLOCK = new Set([
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
  "BODY",
]);

/**
 * The whitespace characters CSS `white-space: normal` collapses — space, tab,
 * newline, carriage return and form feed.
 *
 * Deliberately NOT `\s`, which additionally matches every Unicode space
 * separator: NBSP (` `), figure space, narrow no-break space, ideographic
 * space and the rest. A browser never collapses those — that is the entire
 * point of typing one — and collapsing them here would silently rewrite
 * intentional typography on every paste, most visibly turning the NBSP a user
 * put between a number and its unit into an ordinary breakable space.
 */
const COLLAPSIBLE = /[ \t\n\r\f]+/g;

/**
 * The parents the HTML parser requires before it will accept a given tag,
 * mirroring `prosemirror-view`'s own `wrapMap`.
 *
 * The hazard: `parseFromString` foster-parents an orphan `<tr>`/`<td>` straight
 * out of the tree, so the cells survive as bare text and the table is gone. A
 * transform running BEFORE ProseMirror would destroy such a paste before
 * ProseMirror's own wrapping ever got the chance to save it.
 *
 * Honest about the evidence: this is defensive, and the premise is UNREPRODUCED.
 * The claim is that a spreadsheet or a partial table selection puts a bare `<tr>`
 * on the clipboard. Two real spreadsheet-family sources were measured (LibreOffice
 * Calc and Writer) and BOTH emit a full `<table>` wrapper, so neither exercises
 * this path. Excel — the app the claim specifically rests on — was not available
 * to test. What justifies keeping it is upstream precedent, not observation:
 * `prosemirror-view` carries this identical map in its clipboard reader, which is
 * reasonable evidence the shape occurs somewhere. It is inert unless the payload's
 * first tag is actually one of these, so the cost of being wrong is zero.
 */
const WRAP_MAP: Record<string, string[]> = {
  thead: ["table"],
  tbody: ["table"],
  tfoot: ["table"],
  caption: ["table"],
  colgroup: ["table"],
  col: ["table", "colgroup"],
  tr: ["table", "tbody"],
  td: ["table", "tbody", "tr"],
  th: ["table", "tbody", "tr"],
};

function firstTagName(html: string): string | null {
  const m = /^(\s*<!doctype [^>]*>)?\s*<([a-z][^>\s/]*)/i.exec(html);
  return m ? m[2].toLowerCase() : null;
}

/**
 * Collapse whitespace in pasted HTML the way `white-space: normal` would.
 *
 * Returns `html` untouched for a ProseMirror-internal paste. Those carry a
 * `data-pm-slice` marker and are parsed with `preserveWhitespace` already true,
 * because the markup was produced by a copy out of an editor rather than
 * authored — so its whitespace is content, not formatting, and collapsing it
 * would lose the soft wraps the user copied.
 */
export function normalizePastedHtmlWhitespace(html: string): string {
  if (typeof DOMParser === "undefined") return html;

  // A tag orphaned from its required parents has to be wrapped before parsing,
  // then unwrapped after — see WRAP_MAP.
  const wrap = WRAP_MAP[firstTagName(html) ?? ""] ?? [];
  const wrapped = wrap.length
    ? wrap.map((t) => `<${t}>`).join("") +
      html +
      [...wrap]
        .reverse()
        .map((t) => `</${t}>`)
        .join("")
    : html;

  let parsed: Document;
  try {
    parsed = new DOMParser().parseFromString(wrapped, "text/html");
  } catch {
    // A clipboard payload we cannot parse is one we must not rewrite.
    return html;
  }
  let root: Element | null = parsed.body;
  if (!root) return html;
  // Descend back through the wrappers we added, so the returned markup is the
  // caller's fragment and not our scaffolding.
  for (let i = 0; i < wrap.length; i += 1) {
    root = root.firstElementChild;
    if (!root) return html;
  }

  // The `data-pm-slice` test is a real attribute lookup, not a substring test
  // over the payload. `html.includes("data-pm-slice")` matched any page that
  // merely MENTIONS the string — a ProseMirror doc page, a diff of this file —
  // and silently disabled normalization for the whole paste. This is the same
  // check prosemirror-view makes.
  if (root.matches?.("[data-pm-slice]") || root.querySelector("[data-pm-slice]")) return html;

  const walker = parsed.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const texts: Text[] = [];
  for (let n = walker.nextNode(); n; n = walker.nextNode()) texts.push(n as Text);

  // One pass, collapsing each text node and simultaneously recording the first
  // and last text node inside every enclosing block. The edges have to be
  // trimmed against the block a text node actually sits in, not its own parent,
  // so that `<p><em>text</em></p>` trims at the paragraph — but resolving that
  // by re-scanning every text node per block (`texts.filter(t =>
  // block.contains(t))`) is quadratic in node count, and a large table paste
  // hangs the main thread on it. Walking each node's ancestors instead is
  // linear in nodes times a depth that is small in real markup.
  const edges = new Map<Element, { first: Text; last: Text }>();
  for (const text of texts) {
    let verbatim = false;
    const blocks: Element[] = [];
    for (let el = text.parentElement; el; el = el.parentElement) {
      if (VERBATIM.has(el.tagName)) {
        verbatim = true;
        break;
      }
      if (BLOCK.has(el.tagName)) blocks.push(el);
    }
    if (verbatim) continue;

    text.data = text.data.replace(COLLAPSIBLE, " ");
    for (const block of blocks) {
      const seen = edges.get(block);
      if (seen) seen.last = text;
      else edges.set(block, { first: text, last: text });
    }
  }

  for (const { first, last } of edges.values()) {
    first.data = first.data.replace(/^ +/, "");
    last.data = last.data.replace(/ +$/, "");
  }

  // Always `innerHTML`: the descent above lands on the INNERMOST wrapper we
  // added (`<tbody>` for a `<tr>` payload), whose children are the caller's
  // fragment. `outerHTML` would hand the scaffolding back as content.
  return root.innerHTML;
}
