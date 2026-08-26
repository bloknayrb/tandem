import { describe, expect, it } from "vitest";
import { renderMarkdown } from "../../src/client/panels/chat-markdown.js";

/**
 * Parse renderer output the way the `{@html}` sink will, and assert against the
 * resulting DOM.
 *
 * A string-level regex cannot tell an escaped payload apart from a live one:
 * `&lt;img src=x onerror=alert(1)&gt;` is what CORRECT escaping looks like, and it
 * matches every naive "no event handlers" pattern. The parser is the same
 * component that decides whether markup is executable, so ask it.
 *
 * `innerHTML` does not RUN an injected script, but it does build a `<script>`
 * element — which is exactly the detection we want.
 */
function parse(html: string): HTMLElement {
  const host = document.createElement("div");
  host.innerHTML = html;
  return host;
}

/** Every attribute in the parsed tree that could execute or navigate somewhere hostile. */
function dangerousAttributes(root: HTMLElement): string[] {
  const found: string[] = [];
  for (const el of Array.from(root.querySelectorAll("*"))) {
    const tag = el.tagName.toLowerCase();
    for (const name of el.getAttributeNames()) {
      const value = el.getAttribute(name) ?? "";
      if (name.toLowerCase().startsWith("on")) {
        found.push(`<${tag} ${name}>`);
      } else if (
        /^(href|src|action|formaction|xlink:href)$/i.test(name) &&
        !/^(https?:\/\/|mailto:|#)/i.test(value.trim())
      ) {
        found.push(`<${tag} ${name}="${value}">`);
      }
    }
  }
  return found;
}

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

  it("returns an empty string for a non-string value rather than throwing", () => {
    // `sanitizeAnnotation` copies `content`/`text` through with no type guard, and
    // these values come off a Y.Map. A throw here takes down the surrounding
    // component subtree, where the plain interpolation this feeds would have
    // rendered something harmless.
    for (const value of [undefined, null, 42, {}, ["a"]]) {
      expect(renderMarkdown(value as unknown as string), String(value)).toBe("");
    }
  });

  it("renders markdown links as anchor tags", () => {
    const html = renderMarkdown("[docs](https://example.com)");

    expect(html).toContain('<a href="https://example.com"');
    expect(html).toContain("docs</a>");
    expect(html).toContain('target="_blank"');
    expect(html).toContain('rel="noopener noreferrer"');
  });
});

/**
 * The block-restore pass, which had two defects that corrupted ordinary content.
 *
 * Neither was XSS — escape-first holds, so nothing here could ever forge a tag —
 * but both rendered visibly wrong output, and one of them put a raw NUL on
 * screen in a chat message.
 */
describe("renderMarkdown — fenced-block restoration", () => {
  it("does not expand $ patterns from code-block content (regression)", () => {
    // `String.replace` interprets `$&`, `$'`, "$`" and `$n` in a replacement
    // STRING, and the restored block was that string. `$&` spliced the matched
    // placeholder back into the output — so this rendered a literal
    // `\x00BLOCK0\x00` and tore the following `&#39;` entity into `#39;`.
    //
    // `$&` is not exotic: it is the whole-match reference in sed, awk, Perl and
    // JS regexes, which is exactly what people paste into a code block.
    const html = renderMarkdown("```sh\nsed 's/x/$&/'\n```");

    expect(html).not.toContain("\x00");
    expect(html).not.toContain("BLOCK0");
    expect(html).toBe('<pre><code class="language-sh">sed &#39;s/x/$&amp;/&#39;</code></pre>');
  });

  it("does not let $' splice surrounding output into a code block (regression)", () => {
    // The other expansion form: `$'` means "everything after the match", so the
    // trailing document text was duplicated INTO the code block.
    const html = renderMarkdown('before\n```sh\necho "$\'"\n```\nafter');

    expect(html).not.toContain("\x00");
    expect(html).toContain("echo &quot;$&#39;&quot;");
    // "after" appears once, at the end — not also spliced inside the <pre>.
    expect(html.match(/after/g)).toHaveLength(1);
    expect(html).toMatch(/<\/pre><br>after$/);
  });

  it("strips NULs so a forged placeholder cannot capture a real block", () => {
    // The placeholders are NUL-delimited on the reasoning that a NUL "can't
    // appear in normal text". True of typing, false of text arriving over MCP —
    // nothing strips control characters on the way in. Combined with
    // `.replace(string, …)` replacing only the FIRST match, a forged
    // placeholder ahead of the real one captured the block and left the genuine
    // placeholder rendered as a literal.
    const html = renderMarkdown("\x00BLOCK0\x00 decoy\n```js\nreal code\n```");

    expect(html).not.toContain("\x00");
    expect(html).toContain('<pre><code class="language-js">real code</code></pre>');
    // The forged text survives as inert prose, in its original position.
    expect(html).toMatch(/^BLOCK0 decoy/);
  });

  it("restores every block when there is more than one", () => {
    // The single-pass regex replaced a per-block loop; this is the arm that
    // would catch it restoring only the first.
    const html = renderMarkdown("```\none\n```\nmid\n```\ntwo\n```");

    expect(html).toContain("<pre><code>one</code></pre>");
    expect(html).toContain("<pre><code>two</code></pre>");
    expect(html).not.toContain("\x00");
  });
});

/**
 * The escaping invariant, tested directly rather than through a caller.
 *
 * This matters more than the count of surfaces suggests. `renderMarkdown` feeds
 * a Svelte `{@html}` sink, and the BROWSER distribution has no `script-src` to
 * fall back on — `index.html` sets only `img-src`, while the Tauri build ships a
 * full CSP. On the most exposed target, this function is the entire defense.
 *
 * Note what these do NOT assert: that the text is trustworthy. Callers render
 * markdown for Claude-authored text only, but that is a semantic choice about
 * not restyling a user's prose, not a trust boundary — Claude's output is shaped
 * by document and `.docx` content that can come from outside the project. The
 * escaping is what makes the sink safe, for every author.
 */
describe("renderMarkdown — the {@html} escaping invariant", () => {
  it("rejects javascript: and data: hrefs, keeping the link text as prose", () => {
    for (const url of [
      "javascript:alert(1)",
      "JaVaScRiPt:alert(1)",
      "data:text/html,<script>alert(1)</script>",
      "vbscript:msgbox(1)",
      "  javascript:alert(1)",
    ]) {
      const html = renderMarkdown(`[click](${url})`);
      expect(html, url).not.toContain("<a ");
      expect(html, url).toContain("click");
    }
  });

  it("allows exactly the three protocols the renderer claims to allow", () => {
    for (const url of ["https://x.test", "http://x.test", "mailto:a@b.test", "#section"]) {
      expect(renderMarkdown(`[go](${url})`), url).toContain(`<a href="${url}"`);
    }
  });

  it("cannot be made to break out of the href attribute", () => {
    // The quote is escaped to &quot; before the link pass ever runs, so it
    // stays INSIDE the attribute value rather than closing it.
    //
    // Asserted against the PARSED DOM, not the string. The string still
    // contains the characters `onmouseover=` — inside the href value, where
    // they are inert — so a regex over the markup reports a breakout that did
    // not happen. What matters is the attribute list the browser builds.
    const anchor = parse(
      renderMarkdown('[x](https://a.test" onmouseover="alert(1))'),
    ).querySelector("a");

    expect(anchor).not.toBeNull();
    expect(anchor?.getAttributeNames()).toEqual(["href", "target", "rel"]);
    expect(anchor?.getAttribute("href")).toContain('"');
  });

  it("never builds a script element, an event-handler attribute, or a script URL", () => {
    // The invariant every future markdown feature has to keep, asserted over
    // the shapes an attacker would actually try — rather than one example per
    // shape, which is how a gap in a regex pass survives review.
    //
    // Again via the parsed DOM. Escaped text like `&lt;img src=x onerror=…&gt;`
    // is SUPPOSED to appear in the output — that is the escaping working — and
    // a string-level assertion cannot tell it apart from a live attribute.
    const payloads = [
      "<script>alert(1)</script>",
      "<img src=x onerror=alert(1)>",
      "<svg/onload=alert(1)>",
      "**<script>alert(1)</script>**",
      "`<script>alert(1)</script>`",
      "```\n<script>alert(1)</script>\n```",
      "# <img src=x onerror=alert(1)>",
      "[a](javascript:alert(1))",
      '[x](https://a.test" onmouseover="alert(1))',
      "[<script>x</script>](https://a.test)",
      "* <script>alert(1)</script>",
      "***<svg/onload=alert(1)>***",
      "<script\n>alert(1)</script\n>",
      "\x00<script>alert(1)</script>",
      "<a href=javascript:alert(1)>x</a>",
      "&lt;script&gt;alert(1)&lt;/script&gt;",
      "&amp;lt;script&amp;gt;alert(1)&amp;lt;/script&amp;gt;",
    ];

    for (const payload of payloads) {
      const root = parse(renderMarkdown(payload));
      expect(root.querySelectorAll("script"), payload).toHaveLength(0);
      expect(root.querySelectorAll("img, svg, iframe, object, embed"), payload).toHaveLength(0);
      expect(dangerousAttributes(root), payload).toEqual([]);
    }
  });

  it("does not decode an entity back into markup on any pass", () => {
    // The single load-bearing property: escaping is monotonic. If any pass ever
    // decodes `&lt;` back to `<`, every other test here becomes meaningless.
    const html = renderMarkdown("&lt;script&gt;alert(1)&lt;/script&gt;");

    expect(html).toContain("&amp;lt;script&amp;gt;");
    expect(html).not.toContain("<script");
  });
});
