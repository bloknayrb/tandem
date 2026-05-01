function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function renderMarkdown(text: string): string {
  return (
    escapeHtml(text)
      // headers
      .replace(/^### (.+)$/gm, "<h3>$1</h3>")
      .replace(/^## (.+)$/gm, "<h2>$1</h2>")
      .replace(/^# (.+)$/gm, "<h1>$1</h1>")
      // bold + italic
      .replace(/\*\*\*(.+?)\*\*\*/g, "<strong><em>$1</em></strong>")
      .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
      .replace(/\*(.+?)\*/g, "<em>$1</em>")
      // inline code
      .replace(/`([^`]+)`/g, "<code>$1</code>")
      // unordered lists
      .replace(/^[*-] (.+)$/gm, "<li>$1</li>")
      // paragraphs (blank line separation)
      .replace(/\n\n/g, "</p><p>")
      // line breaks
      .replace(/\n/g, "<br>")
  );
}
