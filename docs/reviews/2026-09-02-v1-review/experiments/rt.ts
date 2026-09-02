import * as Y from "yjs";
import { loadMarkdown, saveMarkdown } from "../../../../src/server/file-io/markdown.ts";
import { extractText } from "../../../../src/server/mcp/document-model.ts";

function rt(md: string): { out: string; out2: string; flat: string } {
  const doc = new Y.Doc();
  doc.transact(() => loadMarkdown(doc, md), "internal");
  const out = saveMarkdown(doc);
  const flat = extractText(doc);
  const doc2 = new Y.Doc();
  doc2.transact(() => loadMarkdown(doc2, out), "internal");
  const out2 = saveMarkdown(doc2);
  return { out, out2, flat };
}

const cases: Record<string, string> = {
  "inline image mid-sentence": "Click the ![save icon](save.png) button to save.\n",
  "two images one line": "![a](a.png) ![b](b.png)\n",
  "image with title standalone": '![alt text](img.png "The Title")\n',
  "linked image (badge)": "[![Build](https://x/badge.svg)](https://x/ci)\n",
  "code fence meta": "```js title=\"app.js\" {1,3}\nconsole.log(1)\n```\n",
  "code fence tilde": "~~~python\nprint(1)\n~~~\n",
  "code fence no lang": "```\nplain\n```\n",
  "indented code": "    indented code\n    line 2\n",
  "escaped parens (math)": "Inline math \\(x^2\\) and dollars \\$5 and \\$10.\n",
  "escaped misc": "a \\. b \\, c \; d \\: e \\? f \\! g \\' h \\\" i \\/ j \\= k \\% l \\^ m \\{ n \\} o \\| p \\~ q \\@ r \\< s \\> t \\& u \\# v \\+ w \\- x \\* y \\_ z \\` aa \\[ bb \\] cc \\( dd \\)\n",
  "escaped backslash": "path C:\\\\Users\\\\me and a \\\\ lone pair\n",
  "nbsp": "a\u00A0b and\u00A0c\n",
  "BOM + frontmatter": "\uFEFF---\ntitle: X\ntags: [a]\n---\n\n# Hello\n",
  "BOM + heading": "\uFEFF# Hello\n\nworld\n",
  "frontmatter CRLF": "---\r\ntitle: X\r\n---\r\n\r\n# Hi\r\n\r\nbody\r\n",
  "setext h1": "Title\n=====\n\ntext\n",
  "heading trailing #": "## Title ##\n\ntext\n",
  "hard break spaces": "line one  \nline two\n",
  "hard break backslash": "line one\\\nline two\n",
  "soft wrap": "line one\nline two\n",
  "task list": "- [ ] todo\n- [x] done\n  - [ ] nested\n",
  "nested mixed markers": "- a\n  * b\n    + c\n- d\n",
  "ordered start 3 paren": "3) three\n4) four\n",
  "ordered start 0": "0. zero\n1. one\n",
  "loose list": "- a\n\n- b\n\n- c\n",
  "list w/ code block": "- item\n\n  ```sh\n  ls\n  ```\n- next\n",
  "blockquote with list": "> quote\n>\n> - a\n> - b\n",
  "nested blockquote": "> outer\n>\n> > inner\n",
  "table basic": "| a | b |\n|---|---|\n| 1 | 2 |\n",
  "table align": "| a | b | c |\n|:--|:-:|--:|\n| 1 | 2 | 3 |\n",
  "table with pipe & br": "| a | b |\n|---|---|\n| x \\| y | line<br>two |\n",
  "table missing cells": "| a | b | c |\n|---|---|---|\n| 1 |\n",
  "table inline formatting": "| **bold** | `code` | [l](u) |\n|---|---|---|\n| *i* | ~~s~~ | text |\n",
  "footnote": "Text[^1] here.\n\n[^1]: The note.\n",
  "footnote multi-para": "Text[^a].\n\n[^a]: First para.\n\n    Second para of note.\n",
  "ref link": "See [docs][d] and [collapsed][] and [shortcut].\n\n[d]: https://x.y \"Title\"\n[collapsed]: https://c\n[shortcut]: https://s\n",
  "html block": "<div align=\"center\">\n  <b>hi</b>\n</div>\n\ntext\n",
  "html comment": "<!-- comment -->\n\ntext\n",
  "inline html": "Press <kbd>Ctrl</kbd>+<kbd>S</kbd> now.\n",
  "emphasis underscore": "_em_ and __strong__ and snake_case_name and *a*b\n",
  "emphasis intraword star": "foo*bar*baz\n",
  "strike single tilde": "~one~ and ~~two~~\n",
  "autolink angle": "<https://example.com> and <me@x.org>\n",
  "autolink literal": "Visit https://example.com or www.example.com or mail me@x.org today.\n",
  "link title": "[a](https://x \"T\") and [b](<url with space> 'S')\n",
  "code span backticks": "Use `` a ` b `` and `x`\n",
  "thematic variants": "a\n\n***\n\nb\n\n___\n\nc\n\n- - -\n\nd\n",
  "entities": "&copy; &amp; &lt;tag&gt; &nbsp; &#x1F600;\n",
  "emoji": "Hello 👋🏽 world 🇺🇸 e\u0301\n",
  "heading with code and link": "## The `code` and [link](u)\n",
  "heading levels 1-6": "# a\n## b\n### c\n#### d\n##### e\n###### f\n",
  "empty list item": "- a\n-\n- b\n",
  "bare blockquote": ">\n",
  "leading blank lines": "\n\n\ntext\n",
  "no trailing newline": "text",
  "trailing multiple newlines": "text\n\n\n",
  "two spaces trailing (not break)": "a \nb\n",
  "tabs in code": "```\n\tindented\n```\n",
  "html then md no blank": "<div>\nx\n</div>\n# heading\n",
  "math block": "$$\nE = mc^2\n$$\n",
  "wiki link (obsidian)": "See [[Other Note]] and [[Note|alias]] and ![[image.png]]\n",
  "obsidian callout": "> [!NOTE]\n> This is a callout.\n",
  "obsidian highlight": "This is ==highlighted== text\n",
  "obsidian tags": "Tags: #project #todo/sub\n",
  "obsidian embed comment": "%%hidden comment%%\n",
  "mdx-ish jsx": "<Callout type=\"warn\">\n  Text\n</Callout>\n",
  "definition list style": "Term\n: Definition\n",
  "numbered para": "2024. Was a year.\n",
  "line starting with number dot not list": "Version\n1.5 was released\n",
  "hash in text": "C# and F# are languages; issue #12\n",
  "asterisk list vs emphasis": "* item *with* emph\n",
  "plus bullets": "+ a\n+ b\n",
  "html block img": "<img src=\"x.png\" width=\"100\">\n",
  "nested list 4-space": "1. one\n    - sub\n    - sub2\n2. two\n",
  "long fence": "````md\n```js\nx\n```\n````\n",
  "link ref case": "[Foo][BAR]\n\n[bar]: /u\n",
  "image ref": "![alt][img]\n\n[img]: /i.png\n",
  "link in bold": "**[bold link](u)** and *[em](u)*\n",
  "bold in link": "[**bold** text](u)\n",
  "code in bold": "**bold `code` here**\n",
  "strike bold same run": "~~**x**~~\n",
  "url with underscores": "https://ex.com/a_b_c and [t](https://ex.com/x_y)\n",
  "trailing spaces in list": "- a  \n- b\n",
  "heading followed by para no blank": "# H\ntext\n",
  "html entity in code": "`&amp;` and `<b>`\n",
  "percent encoded url": "[a](https://x/%20y)\n",
  "angle brackets text": "a < b > c and <notatag\n",
  "cr only": "a\rb\r",
  "mixed nested inline": "***bold italic*** and **bold *nested italic* bold**\n",
  "list item multiple paras": "- para one\n\n  para two\n- b\n",
  "list ends then para indented": "- a\n\n  continuation\n\nnormal\n",
  "html inline in heading": "# Title <sup>2</sup>\n",
  "nested list in blockquote in list": "- a\n  > q\n  > - x\n",
  "table in list": "- a\n\n  | x | y |\n  |---|---|\n  | 1 | 2 |\n",
  "heading in list": "- # heading in item\n",
  "hard break in list": "- a  \n  b\n",
  "hardbreak then bold": "a **b  \nc** d\n",
  "empty doc": "",
  "only whitespace": "   \n\n",
  "backslash at eol": "a\\\n",
  "unicode punct": "“quotes” — em-dash … ellipsis\n",
  "trailing hash escape": "## Title #\n",
  "line ending inside code with CRLF": "```\r\na\r\nb\r\n```\r\n",
  "link with parens": "[a](https://x/foo_(bar))\n",
  "image in list": "- ![i](i.png) caption\n",
  "star hr after list": "- a\n\n* * *\n",
  "numbers with dot in sentence": "Buy 2. Then go.\n",
};

const results: string[] = [];
for (const [name, md] of Object.entries(cases)) {
  const { out, out2, flat } = rt(md);
  const same = out === md;
  const idem = out === out2;
  results.push(`### ${name}\n- byte-identical: ${same}${idem ? "" : "  NOT-IDEMPOTENT"}`);
  if (!same) {
    results.push("```in\n" + md.replace(/\r/g, "\\r").replace(/\uFEFF/g, "\\uFEFF").replace(/\u00A0/g, "\\u00A0") + "\n```\n```out\n" + out.replace(/\r/g, "\\r").replace(/\uFEFF/g, "\\uFEFF").replace(/\u00A0/g, "\\u00A0") + "\n```");
    if (!idem) results.push("```out2\n" + out2.replace(/\r/g, "\\r") + "\n```");
  }
  results.push("```flat\n" + flat.replace(/\r/g, "\\r").replace(/\n/g, "⏎\n") + "\n```\n");
}
console.log(results.join("\n"));
