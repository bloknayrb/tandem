import { describe, expect, it } from "vitest";
import { renderMarkdown } from "../../src/client/panels/chat-markdown.js";

describe("renderMarkdown", () => {
  it("renders supported markdown tags after escaping message text", () => {
    const html = renderMarkdown("### Title\n**bold** and `code`");

    expect(html).toContain("<h3>Title</h3>");
    expect(html).toContain("<strong>bold</strong>");
    expect(html).toContain("<code>code</code>");
  });

  it("does not preserve raw html from plain message text", () => {
    const html = renderMarkdown("<script>alert('x')</script>");

    expect(html).not.toContain("<script>");
    expect(html).not.toContain("</script>");
    expect(html).toContain("&lt;script&gt;alert(&#39;x&#39;)&lt;/script&gt;");
  });

  it("escapes html payloads inside markdown captures", () => {
    const html = renderMarkdown('**<img src=x onerror="alert(1)">**');

    expect(html).toBe("<strong>&lt;img src=x onerror=&quot;alert(1)&quot;&gt;</strong>");
    expect(html).not.toContain("<img");
    expect(html).not.toContain('onerror="alert(1)"');
  });

  it("renders fenced code blocks without mangling by the inline-code pass", () => {
    const html = renderMarkdown("```ts\nconst x = `hello`;\n```");

    expect(html).toContain("<pre><code");
    expect(html).toContain("const x = `hello`;");
    // The backtick inside the block must not be wrapped in <code>
    expect(html).not.toMatch(/<code>[^<]*`hello`[^<]*<\/code>/);
  });

  it("renders markdown links as anchor tags", () => {
    const html = renderMarkdown("[docs](https://example.com)");

    expect(html).toContain('<a href="https://example.com"');
    expect(html).toContain("docs</a>");
    expect(html).toContain('target="_blank"');
    expect(html).toContain('rel="noopener noreferrer"');
  });
});
