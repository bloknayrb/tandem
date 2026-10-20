import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { headingSlugs, stripCode } from "../../scripts/markdown-anchors.mjs";
import { isSafeExternalHref } from "../../src/client/editor/utils/url-safety.js";

/**
 * `docs/workflows.md` is the one file under `docs/` that ships inside the
 * desktop app (`tauri.conf.json` `bundle.resources`), and it is what Settings →
 * About → documentation opens, read-only, in an editor tab. Its links are
 * therefore clicked INSIDE Tandem, through the editor's anchor intercept
 * (`Editor.svelte#openHref`), not on GitHub.
 *
 * That intercept splits a click two ways: an allowlisted external URL goes to
 * the system browser, and anything else is resolved relative to the open
 * file's path and opened as a Tandem tab. Next to the bundled `workflows.md`
 * there is no `user-guide.md`, no `troubleshooting.md`, no `decisions.md` —
 * none of the rest of `docs/` ships — so every relative link in it was a dead
 * click for every desktop user, while resolving perfectly in a source checkout
 * and on GitHub, which is where anyone reviewing the doc would test it.
 * `scripts/check-doc-links.mjs` reads the checkout, so it cannot see this.
 *
 * `CHANGELOG.md` is in the same position: it is also a bundled resource, and
 * Settings → View Changelog (and the first launch after an upgrade) opens it
 * read-only in an editor tab, so its links are clicked through the same
 * intercept. Its relative links were converted to absolute URLs for that
 * reason. Example link syntax inside a code span is not a link (the editor
 * renders it as code), which is why `stripCode` drops inline code too.
 *
 * Bundling the targets would not fix it either: a relative link opens its
 * target with no `readOnly` flag, so a bundled guide would become an editable
 * tab on a file inside the installed app, and the 60 s autosave would
 * round-trip it through `remark-stringify` (the hazard `CHANGELOG.md` is opened
 * read-only to avoid). `tests/docs/welcome-links.test.ts` records the same
 * reasoning for `sample/welcome.md`, the other shipped document with authored
 * links, and covers its relative links. Its absolute repo links are checked
 * here instead (the last block below): welcome-links skips every external href
 * and the link checker reads relative links only, so its User Guide link —
 * the first link every new user is offered — was checked by nothing.
 *
 * An in-page `#fragment` is no better: the editor's link handler returns on a
 * bare fragment without navigating, so it is a dead click too. So the rule is:
 * every link is an external URL.
 * Converting to absolute GitHub URLs loses the link checker's coverage, which
 * only follows relative links — so this test also checks that every
 * `github.com/bloknayrb/tandem/blob/master/...` link names a file that exists
 * and, if it has one, a heading that exists in it.
 */

const repoRoot = path.resolve(__dirname, "../..");
const REPO_BLOB = "https://github.com/bloknayrb/tandem/blob/master/";

/** Docs opened inside the app whose links must all leave it. */
const IN_APP_DOCS = ["docs/workflows.md", "CHANGELOG.md"];

/** Inline `[text](href)` links (not images) plus reference-style definitions. */
function hrefs(md: string): string[] {
  // Drop images before matching links, so a linked badge `[![alt](img)](url)`
  // yields its outer `url` rather than reading the image's `img` as a link.
  const text = stripCode(md).replace(/!\[[^\]]*\]\([^)]*\)/g, "");
  const inline = [...text.matchAll(/\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g)].map((m) => m[1]);
  const refs = [...text.matchAll(/^\s{0,3}\[[^\]]+\]:\s*<?([^>\s]+)>?/gm)].map((m) => m[1]);
  return [...inline, ...refs];
}

/** Repo `blob/master` links whose file or heading does not exist in this checkout. */
function brokenRepoLinks(links: string[]): string[] {
  const broken: string[] = [];
  for (const href of links.filter((h) => h.startsWith(REPO_BLOB))) {
    const [target, anchor] = href.slice(REPO_BLOB.length).split("#");
    const file = path.join(repoRoot, decodeURIComponent(target));
    if (!existsSync(file)) {
      broken.push(`${href} (no such file)`);
      continue;
    }
    if (anchor && file.endsWith(".md")) {
      if (!headingSlugs(readFileSync(file, "utf-8")).has(anchor.toLowerCase())) {
        broken.push(`${href} (no such heading)`);
      }
    }
  }
  return broken;
}

function tauriResourcePaths(): string[] {
  const conf = JSON.parse(
    readFileSync(path.join(repoRoot, "src-tauri/tauri.conf.json"), "utf-8"),
  ) as { bundle?: { resources?: Record<string, string> } };
  return Object.keys(conf.bundle?.resources ?? {}).map((k) =>
    k.replace(/^\.\.\//, "").replace(/\\/g, "/"),
  );
}

describe.each(IN_APP_DOCS)("%s links work from inside the app", (rel) => {
  const md = readFileSync(path.join(repoRoot, rel), "utf-8");
  const links = hrefs(md);

  it("is still a bundled resource (the premise of this test)", () => {
    // If this fails because the doc stopped shipping, drop its row above.
    expect(tauriResourcePaths()).toContain(rel);
  });

  it("has links to check at all", () => {
    // Positive control: a regex that silently stopped matching would make
    // every assertion below pass vacuously.
    expect(links.length).toBeGreaterThan(0);
  });

  it("contains no relative link", () => {
    const relative = links.filter((h) => !isSafeExternalHref(h));
    expect(
      relative,
      `${rel} opens inside the app, where a relative link resolves next to the bundled ` +
        `file and finds nothing (and a bare #fragment does nothing). Use ${REPO_BLOB}<path>#<anchor> instead.`,
    ).toEqual([]);
  });

  it("points every absolute repo link at a file and heading that exist", () => {
    expect(brokenRepoLinks(links)).toEqual([]);
  });
});

describe("sample/welcome.md absolute repo links", () => {
  const links = hrefs(readFileSync(path.join(repoRoot, "sample/welcome.md"), "utf-8"));

  it("has repo links to check at all", () => {
    expect(links.filter((h) => h.startsWith(REPO_BLOB)).length).toBeGreaterThan(0);
  });

  it("points every absolute repo link at a file and heading that exist", () => {
    expect(brokenRepoLinks(links)).toEqual([]);
  });
});
