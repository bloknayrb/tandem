import { describe, expect, it } from "vitest";
import {
  extractLinks,
  findOrphans,
  headingSlugs,
  isHistorical,
  isLiveDoc,
  reachableFrom,
  resolveTarget,
  slugify,
} from "../../scripts/check-doc-links.mjs";

/**
 * Pure-function coverage for `scripts/check-doc-links.mjs`. The CI wiring is
 * owned by `check-links-wiring.test.ts`; this file owns what the checker
 * decides.
 */

describe("slugify (github-slugger semantics)", () => {
  it("does not collapse the double hyphen an em-dash leaves", () => {
    expect(slugify("ADR-046: Start at Login — Desktop-Only, Hidden Boot, Deferred AI Launch")).toBe(
      "adr-046-start-at-login--desktop-only-hidden-boot-deferred-ai-launch",
    );
  });

  it("keeps Unicode letters, numbers and underscores", () => {
    expect(slugify("Café über_alles 2")).toBe("café-über_alles-2");
    expect(slugify("tandem_getActivity")).toBe("tandem_getactivity");
  });

  it("drops punctuation, symbols, inline code ticks, link syntax and HTML", () => {
    expect(slugify("Origin tagging — which helper to use (Critical Rule 2)")).toBe(
      "origin-tagging--which-helper-to-use-critical-rule-2",
    );
    expect(slugify("The `tandem_edit` tool!")).toBe("the-tandem_edit-tool");
    expect(slugify("See [the docs](x.md) here")).toBe("see-the-docs-here");
    expect(slugify('<a id="x"></a>Anchored')).toBe("anchored");
    expect(slugify("Emoji 🚀 ok")).toBe("emoji--ok");
  });
});

describe("headingSlugs", () => {
  it("suffixes duplicates the way GitHub does", () => {
    const slugs = headingSlugs("# Notes\n\n## Notes\n\n### Notes\n");
    expect([...slugs]).toEqual(["notes", "notes-1", "notes-2"]);
  });

  it("ignores headings inside fences and front matter, reads setext and explicit ids", () => {
    const md = [
      "---",
      "title: x",
      "---",
      "```",
      "# not a heading",
      "```",
      "Setext Title",
      "============",
      '<a name="custom-anchor"></a>',
      "## Closing hashes ##",
    ].join("\n");
    const slugs = headingSlugs(md);
    expect(slugs.has("not-a-heading")).toBe(false);
    expect(slugs.has("title-x")).toBe(false);
    expect(slugs.has("setext-title")).toBe(true);
    expect(slugs.has("custom-anchor")).toBe(true);
    expect(slugs.has("closing-hashes")).toBe(true);
  });
});

describe("extractLinks", () => {
  it("separates links from images, including <img src> and nested badges", () => {
    const md = [
      "[doc](a.md#x) and [same](#here)",
      "![shot](screenshots/a.png)",
      '<img src="screenshots/b.png" alt="b">',
      "[![badge](img/badge.svg)](https://example.com)",
      "[spaced](<my file.md>)",
    ].join("\n");
    expect(extractLinks(md)).toEqual([
      { target: "a.md#x", image: false },
      { target: "#here", image: false },
      { target: "https://example.com", image: false },
      { target: "my file.md", image: false },
      { target: "screenshots/a.png", image: true },
      { target: "img/badge.svg", image: true },
      { target: "screenshots/b.png", image: true },
    ]);
  });

  it("reads reference-style definitions", () => {
    expect(extractLinks("See [the guide][g].\n\n[g]: ../user-guide.md#start\n")).toEqual([
      { target: "../user-guide.md#start", image: false },
    ]);
  });

  it("ignores links inside code", () => {
    expect(extractLinks("`[x](nope.md)`\n\n```\n![y](nope.png)\n```\n")).toEqual([]);
  });
});

describe("resolveTarget", () => {
  it("resolves relative, root-absolute and same-file references", () => {
    expect(resolveTarget("docs/maps/a.md", "../gotchas.md#y")).toEqual({
      path: "docs/gotchas.md",
      anchor: "y",
      sameFile: false,
    });
    expect(resolveTarget("docs/a.md", "/README.md")).toEqual({
      path: "README.md",
      anchor: "",
      sameFile: false,
    });
    expect(resolveTarget("docs/a.md", "#top")).toEqual({
      path: "docs/a.md",
      anchor: "top",
      sameFile: true,
    });
  });

  it("skips anything with a URL scheme", () => {
    expect(resolveTarget("a.md", "https://x.y")).toBeNull();
    expect(resolveTarget("a.md", "mailto:a@b")).toBeNull();
    expect(resolveTarget("a.md", "//cdn.example/x.png")).toBeNull();
  });
});

describe("historical vs live", () => {
  it("honours prefixes, exact files and exceptions", () => {
    expect(isHistorical("docs/plans/x.md")).toBe(true);
    expect(isHistorical("docs/roadmap-history.md")).toBe(true);
    expect(isHistorical("docs/reviews/2026-09-02-v1-review/README.md")).toBe(true);
    expect(isHistorical("docs/reviews/README.md")).toBe(false);
    expect(isHistorical("docs/spikes/README.md")).toBe(false);
    expect(isLiveDoc("docs/design-system-impl/testid-manifest.md")).toBe(true);
    expect(isLiveDoc("docs/screenshots/README.md")).toBe(true);
    expect(isLiveDoc("README.md")).toBe(false);
    expect(isLiveDoc("docs/spikes/old.md")).toBe(false);
  });
});

describe("reachability", () => {
  const edges = new Map<string, string[]>([
    ["docs/README.md", ["docs/maps/a.md", "docs/spikes/old.md", "README.md"]],
    ["docs/maps/a.md", ["docs/deep/b.md"]],
    // Reached only through a historical doc, which is a leaf: still an orphan.
    ["docs/spikes/old.md", ["docs/hidden.md"]],
    // Reached only through a file outside docs/: also an orphan.
    ["README.md", ["docs/outside-only.md"]],
  ]);

  it("follows live docs to any depth and stops at historical ones", () => {
    const reached = reachableFrom("docs/README.md", edges, isLiveDoc);
    expect(reached.has("docs/deep/b.md")).toBe(true);
    expect(reached.has("docs/spikes/old.md")).toBe(true);
    expect(reached.has("docs/hidden.md")).toBe(false);
  });

  it("reports unreachable live docs as orphans, never historical ones", () => {
    const live = [
      "docs/README.md",
      "docs/maps/a.md",
      "docs/deep/b.md",
      "docs/hidden.md",
      "docs/outside-only.md",
    ];
    expect(findOrphans(live, edges)).toEqual(["docs/hidden.md", "docs/outside-only.md"]);
  });
});
