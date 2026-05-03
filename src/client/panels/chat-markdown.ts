function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function renderMarkdown(text: string): string {
  const escaped = escapeHtml(text);

  // Pull fenced code blocks out first so the inline-code and newline passes
  // don't mangle their content. Each block is replaced with a null-byte
  // placeholder that can't appear in normal text.
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

  // Restore fenced code blocks after all inline passes
  for (let i = 0; i < blocks.length; i++) {
    result = result.replace(`\x00BLOCK${i}\x00`, blocks[i]);
  }

  return result;
}
