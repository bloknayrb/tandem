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

/**
 * The four attributes this renderer is allowed to emit. Anything else is a
 * finding by default.
 */
const ALLOWED_ATTRIBUTES = new Set(["class", "href", "target", "rel"]);

/**
 * Every attribute in the parsed tree that this renderer has no business
 * emitting, plus any `href` outside the scheme allowlist.
 *
 * Deliberately an ALLOWLIST rather than a blocklist of `on*` handlers. A
 * blocklist has to anticipate the attack: `ping`, `srcdoc`, `poster`, `srcset`,
 * `style` and `formaction` all navigate or execute and none of them start with
 * `on`. Inverting it means any attribute the renderer starts emitting fails this
 * check until someone reasons about it — which is the point of keeping the
 * helper as the markdown subset grows.
 */
function dangerousAttributes(root: HTMLElement): string[] {
  const found: string[] = [];
  for (const el of Array.from(root.querySelectorAll("*"))) {
    const tag = el.tagName.toLowerCase();
    for (const name of el.getAttributeNames()) {
      const value = el.getAttribute(name) ?? "";
      if (!ALLOWED_ATTRIBUTES.has(name.toLowerCase())) {
        found.push(`<${tag} ${name}>`);
      } else if (name.toLowerCase() === "href" && !/^(https?:\/\/|mailto:|#)/i.test(value.trim())) {
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

    expect(html).toBe("<p><strong>&lt;img src=x onerror=&quot;alert(1)&quot;&gt;</strong></p>");
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
  it("does not expand $& from code-block content (regression)", () => {
    // `$&` is the whole match. The restored block was a replacement STRING, so
    // this spliced the matched placeholder back into its own output: it rendered
    // a literal `\x00BLOCK0\x00` and tore the escaped `&` of `$&` — `&amp;` —
    // down to `amp;`. (Both `&#39;` entities survived; an earlier draft of this
    // comment named the wrong one.)
    //
    // `$&` is the whole-match reference in Perl and JS regexes — exactly what
    // people paste into a code block.
    const html = renderMarkdown("```sh\nsed 's/x/$&/'\n```");

    expect(html).not.toContain("\x00");
    expect(html).not.toContain("BLOCK0");
    expect(html).toBe('<pre><code class="language-sh">sed &#39;s/x/$&amp;/&#39;</code></pre>');
  });

  it("does not expand $$ from code-block content (regression)", () => {
    // `$$` is a literal `$` — so this rendered `echo $`, quietly eating a
    // character. Ordinary in shell (PID), LaTeX and jQuery.
    expect(renderMarkdown("```sh\necho $$\n```")).toBe(
      '<pre><code class="language-sh">echo $$</code></pre>',
    );
  });

  it("does not let $` splice preceding output into a code block (regression)", () => {
    // THE splice case. "$`" is everything BEFORE the match, so the document text
    // ahead of the block was pulled inside it. Reachable because `escapeHtml`
    // does not escape backticks.
    //
    // This is the test the `$'` case was mislabelled as: `$'` is unreachable —
    // `'` is `&#39;` before the block is ever built — so the input below is the
    // only form that actually splices.
    const html = renderMarkdown("PREFIX\n```sh\necho $`x\n```");

    expect(html).not.toContain("\x00");
    // "PREFIX" appears once, ahead of the block — not also inside it.
    expect(html.match(/PREFIX/g)).toHaveLength(1);
    expect(html).toBe('<p>PREFIX</p><pre><code class="language-sh">echo $`x</code></pre>');
  });

  it("handles a literal $' without expanding anything (regression)", () => {
    // `$'` cannot expand — but this input still broke, as a `$&` match on the
    // `$&#39;` that escaping produced. Kept because it is what a user types.
    const html = renderMarkdown('before\n```sh\necho "$\'"\n```\nafter');

    expect(html).not.toContain("\x00");
    expect(html).toContain("echo &quot;$&#39;&quot;");
    expect(html.endsWith("<p>after</p>")).toBe(true);
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
    expect(html).toMatch(/^<p>BLOCK0 decoy<\/p>/);
  });

  it("restores every block when there is more than one", () => {
    // The single-pass regex replaced a per-block loop; this is the arm that
    // would catch it restoring only the first.
    const html = renderMarkdown("```\none\n```\nmid\n```\ntwo\n```");

    expect(html).toContain("<pre><code>one</code></pre>");
    expect(html).toContain("<pre><code>two</code></pre>");
    expect(html).not.toContain("\x00");
  });

  it("restores past the tenth block, where the index stops being one digit", () => {
    // `\d+`, not `\d`. With `\d` the eleventh block's `\x00BLOCK10\x00` never
    // matches and a raw NUL reaches the screen — precisely the failure this
    // whole change exists to remove, reintroduced by a one-character slip.
    const html = renderMarkdown(
      Array.from({ length: 11 }, (_, i) => "```\nb" + i + "\n```").join("\n"),
    );

    expect(html).not.toContain("\x00");
    expect(html).toContain("<pre><code>b10</code></pre>");
  });

  it("keeps leading indentation inside a code block", () => {
    // `trimEnd`, not `trim`. Indentation is the thing a code block exists to
    // preserve, and `trim` would strip it off the first line only — which reads
    // as a rendering quirk rather than a bug.
    expect(renderMarkdown("```\n    indented\nnext\n```")).toBe(
      "<pre><code>    indented\nnext</code></pre>",
    );
  });

  it("strips a NUL that appears inside a code block too", () => {
    // A consequence of stripping before extraction, asserted so it is a decision
    // rather than an accident. Narrowing the strip to placeholder-shaped NULs
    // would pass every other test here while reopening the forgery hole.
    expect(renderMarkdown("```\na\x00b\n```")).toBe("<pre><code>ab</code></pre>");
  });

  it("neutralises a forged placeholder wherever it sits relative to the real block", () => {
    // The existing decoy test puts the forgery BEFORE the block, because the old
    // bug was first-match-only and ordering was load-bearing. These are the
    // other three positions.
    expect(renderMarkdown("```js\nreal\n```\n\x00BLOCK0\x00 decoy")).toBe(
      '<pre><code class="language-js">real</code></pre><p>BLOCK0 decoy</p>',
    );
    // Inside the fence — the twin of the prose decoy.
    expect(renderMarkdown("```\n\x00BLOCK0\x00\n```")).toBe("<pre><code>BLOCK0</code></pre>");
    // With no real block at all. This is the input `?? match` was written for,
    // and it never reaches it: the strip removes the NULs first.
    expect(renderMarkdown("\x00BLOCK0\x00")).toBe("<p>BLOCK0</p>");
  });

  it("emits a language class that cannot carry anything but a word", () => {
    // `\w` on the fence tag is what stops `lang` closing `class="…"`. Asserted
    // from the parsed DOM: the element's attribute set is exactly `class`, so a
    // widened tag pattern that let a second attribute through fails here.
    const code = parse(renderMarkdown("```js\nx\n```")).querySelector("code");
    expect(code?.getAttributeNames()).toEqual(["class"]);
    expect(code?.getAttribute("class")).toMatch(/^language-\w+$/);

    // A tag outside `\w` is not a class at all — it falls into the body.
    const odd = parse(renderMarkdown("```js{onload=1}\nx\n```")).querySelector("code");
    expect(odd?.getAttributeNames()).toEqual(["class"]);
    expect(odd?.getAttribute("class")).toBe("language-js");
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
      // The `^` ANCHOR, pinned. Every payload above puts the hostile scheme at
      // position 0, so all of them still pass with the anchor removed — the
      // guard was `^`-anchored but nothing tested that it was. These four each
      // smuggle an allowed token LATER in the string, and `#` is the cheap one:
      // any javascript: URL with a fragment defeats an unanchored test.
      "javascript:alert(1)#x",
      "javascript:alert(1)//https://ok.test",
      "data:text/html,x#https://ok.test",
      "vbscript:msgbox(1)#a",
    ]) {
      const html = renderMarkdown(`[click](${url})`);
      expect(html, url).not.toContain("<a ");
      expect(html, url).toContain("click");
    }
  });

  it("allows exactly the schemes and the fragment ref the renderer claims to", () => {
    for (const url of ["https://x.test", "http://x.test", "mailto:a@b.test", "#section"]) {
      const anchor = parse(renderMarkdown(`[go](${url})`)).querySelector("a");
      expect(anchor?.getAttribute("href"), url).toBe(url);
    }
  });

  it("refuses a URL carrying markup rather than emitting a truncated anchor", () => {
    // Escape-first covers quotes that came from INPUT. It does not cover the
    // ones this function emits: a fenced block inside a URL relocates
    // `class="…"` into `href="…"`, which closes the href early. The anchor is
    // then truncated and silently loses `rel="noopener noreferrer"` — and the
    // leftover `language-js"` is parsed as a junk boolean attribute.
    //
    // Not XSS (the emitted quote is always followed by `>` before any input
    // text), but the anchor was wrong and the invariant was unstated.
    const block = renderMarkdown("[click](https://a.test/```js\nonmouseover=alert(1)\n```)");
    expect(block).not.toContain("<a ");

    // Same root cause, every earlier pass that can rewrite the URL in place.
    for (const payload of [
      "[click](https://a.test/**b**c)",
      "[click](https://a.test/`b`c)",
      "[click](https://a.test/*b*c)",
    ]) {
      expect(renderMarkdown(payload), payload).not.toContain("<a ");
    }

    // A newline can't reach the href at all now — the URL class excludes it, so
    // this never matches as a link. `assembleBlocks` then sees two ordinary
    // paragraph lines and joins them with a `<br>`, never touching a URL.
    expect(renderMarkdown("[click](https://a.test/a\nb)")).not.toContain("<a ");

    // And an ordinary link still works, so the guard isn't just rejecting.
    expect(parse(renderMarkdown("[ok](https://a.test/x)")).querySelector("a")).not.toBeNull();
  });

  it("bounds the link label and url, so a pathological message cannot freeze the ui", () => {
    // A DoS bound, pinned by behaviour rather than by a timer. Unbounded, the
    // label pattern rescans to end of input from every `[`: 8795ms on a
    // 99k-char message, on the main thread, repeated on every render and
    // surviving restart (the message is stored verbatim in the chat Y.Map).
    // Bounded, the same input is 166ms.
    expect(renderMarkdown(`[${"L".repeat(501)}](https://x.test)`)).not.toContain("<a ");
    expect(renderMarkdown(`[ok](https://x.test/${"p".repeat(2001)})`)).not.toContain("<a ");

    // The bounds sit far above any real link.
    expect(
      parse(renderMarkdown(`[${"L".repeat(500)}](https://x.test)`)).querySelector("a"),
    ).not.toBeNull();
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
    // A Set, not an array: the strictness is what catches an injected fourth
    // attribute, but emission ORDER is a template detail no behaviour depends on.
    expect(new Set(anchor?.getAttributeNames())).toEqual(new Set(["href", "target", "rel"]));
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

/**
 * Balanced block assembly (#1639).
 *
 * Every structural assertion here goes through the PARSED DOM, because the
 * defect this describe exists for is invisible to string inspection: the parser
 * rescues unbalanced markup, so `a\n\nb` reads fine as a string and is a bare
 * text node plus one `<p>` once parsed.
 *
 * **The discriminator is `childNodes.length === children.length`, not
 * `closest("p")`.** Measured in this suite's own happy-dom, `pre.closest("p")`
 * is null for EVERY implementation — the parser always reparents a `<pre>` out
 * of a `<p>`, which is the issue's own premise — so it discriminates nothing and
 * is kept below only as a redundant companion. A bare text node at top level is
 * the thing the parser has no escape hatch for, and counting it is what fails on
 * the broken form.
 */
describe("renderMarkdown — balanced block assembly", () => {
  it("case 1: makes two real <p> elements from a blank-line split", () => {
    // The headline defect. Before this, `a` was a TEXT NODE and only `b` was an
    // element — so `> :first-child` in `markdown-body.css` selected paragraph
    // TWO. The childNodes half is what kills a fix emitting two `<p>` plus a
    // stray text node.
    const host = parse(renderMarkdown("a\n\nb"));

    expect(host.children.length).toBe(2);
    expect(host.childNodes.length).toBe(2);
    expect(Array.from(host.children).map((el) => el.tagName)).toEqual(["P", "P"]);
  });

  it("case 2: keeps document order across a same-chunk fence", () => {
    // A fence separated from its prose by a SINGLE newline, which no blank-line
    // example exercises. Kills two things at once: a chunk-level wrapper (which
    // yields `P,PRE` plus a bare trailing text node) and a placeholder arm that
    // emits without flushing the buffered runs first, which would reorder the
    // block ahead of the prose that preceded it.
    const host = parse(renderMarkdown("intro\n```js\nc\n```\noutro"));

    expect(host.childNodes.length).toBe(host.children.length);
    expect(Array.from(host.children).map((el) => el.tagName)).toEqual(["P", "PRE", "P"]);

    const pre = host.querySelector("pre");
    expect(pre?.previousElementSibling?.textContent).toContain("intro");
    expect(pre?.nextElementSibling?.textContent).toContain("outro");
    expect(pre?.parentElement).toBe(host);
  });

  it("case 3: never tears an element that an inline fence sits inside", () => {
    // NOTE: these three are already green on master and discriminate NOTHING
    // about this change — all three inputs produce byte-identical output before
    // and after, because each reaches assembly as a single line containing a
    // placeholder and is emitted bare either way. They guard the REJECTED
    // piece-level split (which would cut an element opened by an earlier inline
    // pass), not the new assembly. The discriminating cases are 1, 2, 6 and 7.
    //
    // "Intact" here means NOT CUT. It is not a claim that the nesting is valid:
    // `pre.parentElement` is `STRONG` / `A` / `H1`, an invalid content model the
    // parser tolerates rather than repairs, and that is a recorded bound of the
    // subset rather than something this change introduces. The empty `<pre>` is
    // why each expected string carries two spaces.
    for (const [input, selector, text] of [
      ["**a ```x``` b**", "strong", "a  b"],
      ["[lab ```x``` el](https://x.test)", "a", "lab  el"],
      ["# head ```x``` tail", "h1", "head  tail"],
    ] as const) {
      const host = parse(renderMarkdown(input));
      expect(host.querySelectorAll(selector), input).toHaveLength(1);

      const el = host.querySelector(selector);
      expect(el?.querySelector("pre"), input).not.toBeNull();
      expect(el?.textContent, input).toBe(text);
    }
  });

  it("case 4: keeps a fence inside the <li> it was written in", () => {
    // Arm order is the contract: `<li>` is tested BEFORE the placeholder. `<li>`
    // legally accepts flow content, so the block belongs inside the item. An arm
    // order that tested the placeholder first would hoist it out of the list.
    const host = parse(renderMarkdown("- see ```x``` here"));

    expect(host.querySelectorAll("ul")).toHaveLength(1);
    expect(host.querySelectorAll("li")).toHaveLength(1);
    expect(host.querySelector("li")?.querySelector("pre")).not.toBeNull();
  });

  it("case 5: leaves no empty <p> around a fenced block", () => {
    // This is what let `p:empty { display: none }` be deleted from
    // `markdown-body.css`. Before, the `</p><p>` pair straddled the placeholder
    // and left a stray EMPTY paragraph carrying real vertical space.
    const html = renderMarkdown("intro\n\n```js\nc\n```\n\n");
    const host = parse(html);

    expect(host.querySelectorAll("p")).toHaveLength(1);
    for (const p of Array.from(host.querySelectorAll("p"))) {
      expect(p.textContent?.trim()).not.toBe("");
    }

    // The one deliberately STRING-level assertion in this suite, and it has to
    // be: acceptance item 2 ("a fenced block is never inside a `<p>`") has no
    // assertion that survives the parser for the lone-placeholder shape.
    // `<p><pre>x</pre></p>` parses to `P,PRE,P` with 3 childNodes and 3
    // children, so the discriminator above is blind to it — the invalid nesting
    // exists only in the emitted string. Do not "tidy" this onto the DOM.
    expect(html).not.toMatch(/<p>\s*<pre/);
  });

  it("case 6: wraps list items in one <ul>, with no <br> between them", () => {
    // Kills three implementations at once: unwrapped `<li>`; a `<br>` left
    // between items (the old `\n` pass ran AFTER the list pass, so every `<li>`
    // was preceded by one); and the list swallowed into the paragraph above it.
    const host = parse(renderMarkdown("Findings:\n- alpha\n- beta"));

    expect(host.querySelectorAll("ul")).toHaveLength(1);

    const ul = host.querySelector("ul");
    expect(Array.from(ul?.children ?? []).map((el) => el.tagName)).toEqual(["LI", "LI"]);
    expect(ul?.querySelectorAll("br")).toHaveLength(0);

    const intro = ul?.previousElementSibling;
    expect(intro?.tagName).toBe("P");
    expect(intro?.textContent).toBe("Findings:");
  });

  it("case 7: opens a separate <ul> per run, not one around the whole body", () => {
    // Both the one-chunk form (a paragraph line between two bullet runs) and the
    // across-chunks form. A fix that opens a single `<ul>` around everything
    // passes case 6 and fails here.
    for (const input of ["- a\nmid\n- b", "- a\n\nmid\n\n- b"]) {
      const host = parse(renderMarkdown(input));
      expect(host.querySelectorAll("ul"), input).toHaveLength(2);
      expect(host.querySelectorAll("li"), input).toHaveLength(2);
    }
  });

  it("case 8: leaves a heading as its own top-level element", () => {
    // Kills a fix that wraps every line: `<p><h1>H</h1></p>` parses to `P,H1,P`,
    // against the exact `H1,P` asserted here.
    const host = parse(renderMarkdown("# H\n\npara"));

    expect(Array.from(host.children).map((el) => el.tagName)).toEqual(["H1", "P"]);
    // Redundant companion, NOT the discriminating assertion — see this
    // describe's docblock.
    expect(host.querySelector("h1")?.closest("p")).toBeNull();
  });

  it("case 9: dispatches on tags it emitted, never on tags the user typed", () => {
    // The escape-first property, which nothing pinned before. The tag-prefix
    // dispatch and the placeholder test are sound ONLY because every `<` and
    // every `\x00` in the intermediate string was emitted by this function: a
    // user typing `<li>` is already `&lt;li&gt;` by then. A change that moves
    // escaping later fails here as well as in the XSS describe.
    const host = parse(renderMarkdown("<li>x</li>\n<h1>y</h1>"));

    expect(host.querySelectorAll("p")).toHaveLength(1);
    expect(host.querySelectorAll("li, h1, ul")).toHaveLength(0);
    expect(host.textContent).toBe("<li>x</li><h1>y</h1>");
  });

  it("case 10: keeps a soft newline inside a paragraph as a <br>", () => {
    // The SURVIVOR case, and it is load-bearing twice over: it kills a fix that
    // drops `<br>` wholesale, and it is what keeps the `br { display: none }`
    // density rule in `AnnotationCard.svelte` honest — that rule is still
    // reachable precisely because this shape still emits a break.
    const host = parse(renderMarkdown("a\nb"));

    expect(host.querySelectorAll("p")).toHaveLength(1);
    expect(host.querySelectorAll("br")).toHaveLength(1);
    expect(host.textContent).toBe("ab");
  });

  it("case 11: drops a whitespace-only line rather than rendering it", () => {
    // Pins the `line.trim() !== ""` predicate. A bare `line !== ""` would treat
    // the middle line as paragraph content and emit a second `<br>`.
    const host = parse(renderMarkdown("a\n   \nb"));

    expect(host.querySelectorAll("p")).toHaveLength(1);
    expect(host.querySelectorAll("br")).toHaveLength(1);
  });

  it("case 12: renders empty and whitespace-only input as nothing at all", () => {
    // `""` pins existing behaviour, and two things now depend on it:
    // `AnnotationBody` funnels its placeholder through this same call, and
    // deleting `p:empty` removed the net that used to hide a stray `<p></p>`.
    // Without the flush guards, assembly emits exactly that.
    expect(renderMarkdown("")).toBe("");

    // `"   "` is a deliberate BEHAVIOUR CHANGE, not a pin: it returned `"   "`
    // before (nothing touched whitespace) and returns `""` now. The one consumer
    // is `AnnotationBody`'s `text || placeholder`, where `"   "` is truthy and
    // so reaches the renderer as-is — a whitespace-only Claude body now renders
    // an empty div instead of a div holding three spaces. Neither shape is
    // visible to a reader; recorded because it is a value change.
    expect(renderMarkdown("   ")).toBe("");
  });

  it("case 13: splits paragraphs on a CRLF blank line, not just an LF one", () => {
    // PR-review round 1. The chunk split and the per-line loop are both written
    // against `\n`, so without the CRLF normalisation in `renderMarkdown` a
    // `\r\n\r\n` blank line arrives here as a `\r`-only line, which
    // `line.trim() === ""` DROPS — merging the two paragraphs into one `<p>`
    // holding a single `<br>`. That is reachable: `tandem_reply` and
    // `tandem_comment` take a bare `z.string()` and nothing on the wire
    // normalises line endings, so a Claude message composed with CRLF endings
    // lost every paragraph break on all four markdown surfaces.
    const host = parse(renderMarkdown("a\r\n\r\nb"));

    expect(host.querySelectorAll("p")).toHaveLength(2);
    expect(host.querySelectorAll("br")).toHaveLength(0);
    expect(Array.from(host.querySelectorAll("p")).map((p) => p.textContent)).toEqual(["a", "b"]);
  });

  it("case 14: keeps a CRLF soft newline as a <br> inside one paragraph", () => {
    // The other half of case 13: normalisation must not eat a single line break.
    // Pins that `\r\n` behaves exactly as `\n` does in case 10, and that no
    // stray CR survives into the rendered text.
    const host = parse(renderMarkdown("a\r\nb"));

    expect(host.querySelectorAll("p")).toHaveLength(1);
    expect(host.querySelectorAll("br")).toHaveLength(1);
    expect(host.textContent).toBe("ab");
  });

  it("case 15: recognises a heading and a list item written with CRLF endings", () => {
    // NOT mutation-sensitive, and kept deliberately rather than sold as a pin:
    // measured, this case still passes with the normalisation removed, because
    // the HTML parser normalises a stray CR out of the markup stream before
    // `textContent` ever sees it. So it records that the line-oriented passes
    // (heading anchor, list-item anchor, one `<ul>` per run) behave under CRLF —
    // cases 13 and 14 are the two that go red when the normalisation is removed.
    const host = parse(renderMarkdown("# H\r\n\r\n- one\r\n- two"));

    expect(host.querySelector("h1")?.textContent).toBe("H");
    expect(host.querySelectorAll("ul")).toHaveLength(1);
    expect(Array.from(host.querySelectorAll("li")).map((li) => li.textContent)).toEqual([
      "one",
      "two",
    ]);
  });
});
