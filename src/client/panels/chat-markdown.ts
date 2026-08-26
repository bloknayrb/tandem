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
 * **Escape-first is the safety property.** `escapeHtml` runs over the WHOLE
 * input before any tag is constructed, and no later pass decodes an entity back.
 * Every tag below is therefore built out of text that can no longer contain `<`
 * or `"`. Any change that moves escaping later, makes it conditional, or
 * introduces a decode breaks the whole thing at once.
 *
 * **But escape-first covers quotes from INPUT, not the ones this function emits.**
 * That distinction is load-bearing and was missing here until a review found the
 * counterexample: a fenced block inside a link URL relocates this function's own
 * `class="…"` into `href="…"`, truncating the anchor and silently dropping its
 * `rel="noopener noreferrer"`. It stops short of XSS only because the emitted
 * `class` quote is always followed by `\w*"` then `>`, so input text lands in
 * content position — a property that would break if `\w` were widened or `<pre>`
 * gained a trailing attribute. Rather than rely on it, the link pass below
 * refuses any URL carrying markup. **The real invariant: every `"` in the output
 * is one of this function's own literals, and each is closed before any
 * input-derived text.**
 *
 * **Do not read the caller's `author` as a security boundary.** The one caller
 * (`ChatPanel.svelte`, `msg.author === "claude"`) renders markdown for
 * Claude-authored text only, but that is a SEMANTIC choice — a user typing `*`
 * should not silently italicize. It is not a trust boundary: Claude's output is
 * influenced by document and `.docx` content that may come from outside the
 * project, so `author: "claude"` text is as untrusted as any other. The escaping
 * is what makes this safe, for every author.
 *
 * The browser distribution has no `script-src` to fall back on — `index.html`
 * sets only `img-src`, while a Tauri **release** build ships a full CSP. Note
 * Tauri injects that CSP for `frontendDist` only, so `cargo tauri dev` also runs
 * on the `img-src`-only meta. On both of those, this function is the entire
 * defense.
 */
export function renderMarkdown(text: string): string {
  // Chat rows are read straight off the Y.Map with an unchecked `value as
  // ChatMessage` cast (`useChatState.svelte.ts`), and `ChatMessage`'s own doc
  // comment says chat is NOT allowlist-sanitized. A non-string reaching
  // `.replace` throws, and the only `<svelte:boundary>` is at the app root
  // (`Root.svelte`) — so a throw here replaces the ENTIRE app with the fallback,
  // where the plain interpolation this feeds would have rendered something
  // harmless. No current writer produces one (`tandem_reply` is `z.string()`,
  // `/api/channel-reply` hand-checks `typeof`, the local-model path buffers a
  // string), so this is a line for future writers, not a live bug.
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
  //
  // `\w` on the language tag is a SECURITY boundary, not tidiness: it is exactly
  // `[A-Za-z0-9_]`, so `lang` can neither close `class="…"` nor start a new
  // attribute. Widening it — for `c++`, `objective-c`, `f#`, which people do
  // write — is a security change, not a convenience one.
  //
  // `{0,32}` is a DoS bound. Unbounded `\w*` backtracks quadratically on an
  // unterminated fence: measured 1059ms for a 99k-char message (reachable — the
  // body limit is 100kb and no writer caps chat text), against 0.6ms bounded.
  const blocks: string[] = [];
  let result = escaped.replace(
    /```(\w{0,32})\n?([\s\S]*?)```/g,
    (_, lang: string, code: string) => {
      const idx = blocks.length;
      const cls = lang ? ` class="language-${lang}"` : "";
      blocks.push(`<pre><code${cls}>${code.trimEnd()}</code></pre>`);
      return `\x00BLOCK${idx}\x00`;
    },
  );

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
    // Links. Only http(s), mailto and fragment refs render as clickable.
    //
    // The label/URL bounds are a DoS fix, measured: on a 99k-char message of `[`
    // the unbounded `[^\]]+` costs 8795ms of MAIN-THREAD time (this runs
    // synchronously inside `{@html}` in an `{#each}`), because every `[` rescans
    // to end of input. Bounded, the same input is 166ms. The message is stored
    // verbatim in the chat Y.Map and survives restart, so the freeze repeats on
    // every render. Excluding `\n` is correctness, not speed — it measured
    // slightly *slower* — but a link cannot span lines, and it keeps the `<br>`
    // the newline pass emits below out of the href.
    .replace(/\[([^\]\n]{1,500})\]\(([^)\n]{1,2000})\)/g, (_match, text: string, url: string) => {
      const trimmed = url.trim();

      // Refuse a URL carrying markup. By this point the passes above have
      // already rewritten parts of it — `**b**` is now `<strong>b</strong>`, and
      // a fenced block is a `\x00BLOCK…\x00` placeholder that becomes
      // `<pre><code class="…">` at restore. Splicing that into `href="…"` puts a
      // quote THIS FUNCTION EMITTED inside the attribute, which truncates the
      // anchor and drops its `rel="noopener noreferrer"`. Escape-first does not
      // cover this: the offending quote never came from input.
      if (/[<\x00]/.test(trimmed)) return text;

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
  // A REPLACER FUNCTION, not a replacement string. `String.replace` expands `$`
  // patterns inside a replacement STRING — and the block was that string,
  // holding user text. Exactly three forms were reachable here, verified by
  // running the old implementation rather than reading the spec:
  //
  //   $$   → a literal `$`.        ```sh␤echo $$``` rendered `echo $`.
  //   $&   → the whole match.      ```sh␤sed 's/x/$&/'``` rendered a raw NUL
  //                                (`\x00BLOCK0\x00`) and tore the escaped `&`
  //                                of `$&` — `&amp;` — down to `amp;`.
  //   $`   → everything BEFORE the match. This is the splicer: with any
  //          preceding text, ```sh␤echo $`x``` pulled that text into the block.
  //          Reachable because `escapeHtml` does not escape backticks.
  //
  // `$'` and `$n` are NOT reachable, though they look like they should be: `'`
  // is already `&#39;` by the time the block is built, and the old restore used
  // a STRING search pattern, which has no capture groups. (An input written
  // `$'` still broke — as a `$&` match on `$&#39;`.)
  //
  // A function replacer is passed the match and does no `$` interpretation, so
  // it closes all forms including any future one.
  //
  // One regex pass rather than a `.replace(string, …)` per block: the string
  // form replaces only the FIRST occurrence, which was the other half of the
  // forged-placeholder problem the NUL strip above closes.
  //
  // `?? match` is unreachable while that strip holds — every `\x00BLOCK…\x00` in
  // `result` was inserted above with an in-range index. Kept as defense for
  // whoever weakens the strip.
  return result.replace(
    /\x00BLOCK(\d+)\x00/g,
    (match, idx: string) => blocks[Number(idx)] ?? match,
  );
}
