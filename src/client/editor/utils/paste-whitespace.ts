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

function hasVerbatimAncestor(node: Node): boolean {
  for (let el = node.parentElement; el; el = el.parentElement) {
    if (VERBATIM.has(el.tagName)) return true;
  }
  return false;
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
  if (html.includes("data-pm-slice")) return html;
  if (typeof DOMParser === "undefined") return html;

  let parsed: Document;
  try {
    parsed = new DOMParser().parseFromString(html, "text/html");
  } catch {
    // A clipboard payload we cannot parse is one we must not rewrite.
    return html;
  }
  const body = parsed.body;
  if (!body) return html;

  const walker = parsed.createTreeWalker(body, NodeFilter.SHOW_TEXT);
  const texts: Text[] = [];
  for (let n = walker.nextNode(); n; n = walker.nextNode()) texts.push(n as Text);

  for (const text of texts) {
    if (hasVerbatimAncestor(text)) continue;
    text.data = text.data.replace(/\s+/g, " ");
  }

  // Second pass for the block edges. Done after collapsing so we are trimming a
  // single space rather than trying to reason about the original run, and done
  // by walking each block's own descendants so that inline wrappers
  // (`<p><em>text</em></p>`) are trimmed at the block boundary they actually sit
  // on rather than at their own.
  const blocks = [body, ...Array.from(body.querySelectorAll("*"))].filter(
    (el) => BLOCK.has(el.tagName) && !VERBATIM.has(el.tagName),
  );
  for (const block of blocks) {
    if (hasVerbatimAncestor(block)) continue;
    const own = texts.filter((t) => block.contains(t) && !hasVerbatimAncestor(t));
    const first = own[0];
    const last = own[own.length - 1];
    if (first) first.data = first.data.replace(/^ +/, "");
    if (last) last.data = last.data.replace(/ +$/, "");
  }

  return body.innerHTML;
}
