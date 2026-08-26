function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * Renders a small markdown subset to HTML for a Svelte `{@html}` sink.
 *
 * **The safety property is escape-first, and it is the only one.** `escapeHtml`
 * runs over the WHOLE input before any tag is constructed, and no later pass
 * decodes an entity back. Every tag below is therefore built by this function
 * out of text that can no longer contain `<`, and the `href="…"` attribute
 * cannot be closed early because `"` is already `&quot;`. Any change that moves
 * escaping later, makes it conditional, or introduces a decode breaks the whole
 * thing at once.
 *
 * **Do not read the caller's `author` as a security boundary.** Callers render
 * markdown for Claude-authored text only, but that is a SEMANTIC choice — a user
 * typing `*` should not silently italicize. It is not a trust boundary: Claude's
 * output is influenced by document and `.docx` content that may come from
 * outside the project, so `author: "claude"` text is as untrusted as any other.
 * The escaping above is what makes this safe, for every author.
 *
 * The browser distribution has no `script-src` to fall back on — `index.html`
 * sets only `img-src`, while the Tauri build ships a full CSP
 * (`src-tauri/tauri.conf.json`). So on the most exposed target this function is
 * the entire defense.
 */
export function renderMarkdown(text: string): string {
  // `sanitizeAnnotation` copies `content`/`text` through with no type guard, and
  // these values come off a Y.Map. A non-string reaching `.replace` throws and
  // takes the surrounding component subtree down with it, where the plain
  // interpolation this replaces would have rendered something harmless. No
  // current writer produces one — both the durable and MCP zod schemas enforce
  // `string` — so this costs a line to close for every future caller.
  if (typeof text !== "string") return "";

  // Strip NULs BEFORE anything else. The block placeholders below are delimited
  // with `\x00`, on the reasoning that it "can't appear in normal text" — which
  // is true of typed input and false of text arriving over MCP, where nothing
  // strips control characters. A forged `\x00BLOCK0\x00` in the input would
  // otherwise capture a real code block's restoration and leave the genuine
  // placeholder rendered on screen as a literal.
  const escaped = escapeHtml(text.replace(/\x00/g, ""));

  // Pull fenced code blocks out first so the inline-code and newline passes
  // don't mangle their content. Each is swapped for a placeholder that, given
  // the strip above, cannot collide with anything in the input.
  const blocks: string[] = [];
  let result = escaped.replace(/```(\w*)\n?([\s\S]*?)```/g, (_, lang: string, code: string) => {
    const idx = blocks.length;
    const cls = lang ? ` class="language-${lang}"` : "";
    blocks.push(`<pre><code${cls}>${code.trimEnd()}</code></pre>`);
    return `\x00BLOCK${idx}\x00`;
  });

  result = result
    // headers
    .replace(/^### (.+)$/gm, "<h3>$1</h3>")
    .replace(/^## (.+)$/gm, "<h2>$1</h2>")
    .replace(/^# (.+)$/gm, "<h1>$1</h1>")
    // bold + italic
    .replace(/\*\*\*(.+?)\*\*\*/g, "<strong><em>$1</em></strong>")
    .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
    .replace(/\*(.+?)\*/g, "<em>$1</em>")
    // inline code (single backtick only — triple-backtick blocks already extracted)
    .replace(/`([^`\n]+)`/g, "<code>$1</code>")
    // links (protocol-validated: only http(s), mailto, and fragment refs render as clickable)
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_match, text: string, url: string) => {
      const trimmed = url.trim();
      if (/^(https?:\/\/|mailto:|#)/i.test(trimmed)) {
        return `<a href="${trimmed}" target="_blank" rel="noopener noreferrer">${text}</a>`;
      }
      return text;
    })
    // unordered lists
    .replace(/^[*-] (.+)$/gm, "<li>$1</li>")
    // paragraphs
    .replace(/\n\n/g, "</p><p>")
    // line breaks
    .replace(/\n/g, "<br>");

  // Restore fenced code blocks after all inline passes.
  //
  // A REPLACER FUNCTION, not a replacement string. `String.replace` expands
  // `$&`, `$'`, "$`" and `$n` inside a replacement STRING — and the block is
  // that string, holding user text. A code block containing `$&` (ordinary in
  // sed, awk, regex and shell) spliced the matched placeholder back into its own
  // output, rendering a raw NUL on screen and tearing the neighbouring `&#39;`
  // entity in half. A function replacer is passed the match instead and does no
  // `$` interpretation.
  //
  // One regex pass rather than a `.replace(string, …)` per block: the string
  // form replaces only the FIRST occurrence, which was the other half of the
  // forged-placeholder problem the NUL strip above closes.
  return result.replace(
    /\x00BLOCK(\d+)\x00/g,
    (match, idx: string) => blocks[Number(idx)] ?? match,
  );
}
