import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { htmlToYDoc } from "../../src/server/file-io/docx-html.js";
import { loadMarkdown } from "../../src/server/file-io/markdown.js";

/**
 * `docs/lessons-learned.md` §33 states WHERE a hostile hyperlink is stopped,
 * and the whole point of #1409 is that it previously named the wrong layer:
 * it credited "Tiptap renders the links" for a control that actually runs at
 * import, in `docx-html.ts`. That defect was invisible for as long as it
 * existed because nothing connected the prose to the code.
 *
 * The correction deliberately does NOT transcribe the editor's `isAllowedUri`
 * expression — a copied expression is a second source of truth that goes stale
 * the moment the real one is edited (#1537 / PR #1568 rewrite that exact line).
 * What the bullet does still assert is the ASYMMETRY between the two
 * importers, and that is what this file pins, behaviourally:
 *
 *   - `.docx` import (`docx-html.ts`) allowlists `http:`, `https:`, `mailto:`
 *     and blanks everything else, so the href never reaches the Y.Doc.
 *   - `.md` import (`mdast-ydoc.ts`) writes `node.url` verbatim, which is why
 *     the render-time guard is the ONLY layer for markdown.
 *
 * Flip either half and the lesson becomes false again, silently. These
 * assertions describe layers, not safety: whether the render-time guard is
 * adequate is tracked in `docs/security.md#open-findings` (#1420), and nothing
 * here should be read as answering that.
 */

const repoRoot = path.resolve(__dirname, "../..");

/** The href on the first inline segment of the first block, or `undefined`. */
function firstLinkHref(doc: Y.Doc): string | undefined {
  const block = doc.getXmlFragment("default").get(0) as Y.XmlElement;
  const delta = (block.get(0) as Y.XmlText).toDelta() as Array<{
    attributes?: { link?: { href?: string } };
  }>;
  return delta[0]?.attributes?.link?.href;
}

function docxHref(href: string): string | undefined {
  const doc = new Y.Doc();
  try {
    htmlToYDoc(doc, `<p><a href="${href}">click</a></p>`);
    return firstLinkHref(doc);
  } finally {
    doc.destroy();
  }
}

function markdownHref(url: string): string | undefined {
  const doc = new Y.Doc();
  try {
    loadMarkdown(doc, `[click](${url})\n`);
    return firstLinkHref(doc);
  } finally {
    doc.destroy();
  }
}

describe("lessons-learned §33 — the .docx link allowlist runs at import", () => {
  it.each([
    "http://example.com/x",
    "https://example.com/x",
    "mailto:a@example.com",
  ])("keeps %s", (href) => {
    expect(docxHref(href)).toBe(href);
  });

  it.each([
    "javascript:alert(1)", // the bullet's own subject
    "data:text/html,<script>alert(1)</script>",
    "vbscript:alert(1)",
    "tel:+15551234567", // Tiptap allowlists it; the .docx importer does not
    "ftps://example.com/x", // ditto — this is what "only three" means
    "ms-msdt:/id", // #1537's class, stopped here regardless of the render guard
    "docs/spec.md", // scheme-less: kept by the RENDER guard, blanked on .docx import
  ])("blanks %s", (href) => {
    expect(docxHref(href)).toBe("");
  });
});

describe("lessons-learned §33 — .md import has no href layer at all", () => {
  it.each([
    "https://example.com/x",
    "javascript:alert(1)",
    "ms-msdt:/id",
    "docs/spec.md",
  ])("writes %s verbatim", (url) => {
    expect(markdownHref(url)).toBe(url);
  });
});

describe("lessons-learned §33 — the bullet names the layers, not an expression", () => {
  const bullet = (() => {
    const md = readFileSync(path.join(repoRoot, "docs/lessons-learned.md"), "utf-8");
    const found = md
      .split("\n")
      .find((l) => l.startsWith("- Imported `.docx` content can contain `javascript:` URLs"));
    expect(found, "the §33 hyperlink bullet moved or was reworded away").toBeDefined();
    return found as string;
  })();

  it("attributes the .docx control to docx-html.ts", () => {
    expect(bullet).toContain("docx-html.ts");
  });

  it("names mdast-ydoc.ts as the importer that does not sanitize", () => {
    expect(bullet).toContain("mdast-ydoc.ts");
  });

  it("does not transcribe the isAllowedUri expression (that is #1537's moving target)", () => {
    // The composed expression is the part that goes stale — PR #1568 rewrites
    // this exact line. Naming a symbol in passing is fine; copying the union
    // is not.
    expect(bullet).not.toContain("isAllowedUri:");
    expect(bullet).not.toContain("defaultValidate(url)");
    expect(bullet).not.toContain("isSchemelessPathHref(url)");
  });

  it("defers the safety question to the open-findings register", () => {
    expect(bullet).toContain("security.md#open-findings");
    const security = readFileSync(path.join(repoRoot, "docs/security.md"), "utf-8");
    expect(security).toMatch(/^## Open findings$/m);
  });
});
