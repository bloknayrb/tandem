import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { isSafeExternalHref } from "../../src/client/editor/utils/url-safety.js";

/**
 * `sample/welcome.md` is the ONE document every new user reads, and it is the
 * only shipped document whose links are authored by us rather than by the user
 * (#1270). Its links therefore have to survive PACKAGING, which is where they
 * rot — and rot invisibly.
 *
 * The editor's anchor intercept (`Editor.svelte#openHref`) splits every click
 * two ways:
 *
 *   - allowlisted external scheme → `window.open` → the system browser. Works
 *     in every distribution; nothing has to be bundled.
 *   - anything else → resolved relative to the OPEN FILE's path and handed to
 *     `POST /api/open`. This only works when the target is actually next to
 *     `welcome.md` in the shipped tree.
 *
 * The second branch fails SILENTLY: `openHref` logs a `console.warn` and
 * returns. The click already had `preventDefault()` called on it, so the user
 * gets no navigation, no toast, no error — a link that does nothing at all.
 *
 * And the shipped tree is much smaller than the checkout. The desktop bundle
 * carries `sample/` plus exactly one docs file (`docs/workflows.md`); the npm
 * package's `files` list carries no `docs/` at all. So a relative link into
 * `docs/` resolves for a developer running from source and for nobody else.
 * That is exactly how `[User Guide](../docs/user-guide.md)` shipped broken.
 *
 * This test reads both shipping manifests from their real sources rather than
 * restating them — a restated manifest is what would drift.
 */

const repoRoot = path.resolve(__dirname, "../..");
const WELCOME_REL = "sample/welcome.md";

/** `[text](href)` links, excluding image links (`![alt](src)`). */
function markdownLinks(md: string): Array<{ text: string; href: string }> {
  return [...md.matchAll(/(!?)\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g)]
    .filter((m) => m[1] !== "!")
    .map((m) => ({ text: m[2], href: m[3] }));
}

/** Repo-relative paths the Tauri bundle copies into the app resources dir. */
function tauriResourcePaths(): string[] {
  const conf = JSON.parse(
    readFileSync(path.join(repoRoot, "src-tauri/tauri.conf.json"), "utf-8"),
  ) as { bundle?: { resources?: Record<string, string> } };
  const resources = conf.bundle?.resources ?? {};
  const keys = Object.keys(resources);
  expect(keys.length).toBeGreaterThan(0); // we really parsed it
  // Keys are relative to `src-tauri/`, so "../docs/workflows.md" → "docs/workflows.md".
  return keys.map((k) => k.replace(/^\.\.\//, "").replace(/\\/g, "/"));
}

/** Entries of package.json `files` — what `npm pack` puts in the tarball. */
function npmPackagedPaths(): string[] {
  const pkg = JSON.parse(readFileSync(path.join(repoRoot, "package.json"), "utf-8")) as {
    files?: string[];
  };
  const files = pkg.files ?? [];
  expect(files.length).toBeGreaterThan(0);
  return files.map((f) => f.replace(/\\/g, "/"));
}

/** True when `target` (repo-relative) is inside one of `manifest`'s entries. */
function shipsWith(manifest: string[], target: string): boolean {
  return manifest.some((entry) => {
    const normalized = entry.replace(/\/$/, "");
    return target === normalized || target.startsWith(`${normalized}/`);
  });
}

describe("sample/welcome.md links survive packaging (#1270)", () => {
  const welcome = readFileSync(path.join(repoRoot, WELCOME_REL), "utf-8");
  const links = markdownLinks(welcome);

  it("has links to check at all", () => {
    // Positive control: if the extraction regex silently stopped matching,
    // every assertion below would pass vacuously.
    expect(links.length).toBeGreaterThan(0);
  });

  it.each(links)("$text → $href is reachable from a shipped build", ({ href }) => {
    if (href.startsWith("#")) return; // in-page fragment; never navigates out

    if (isSafeExternalHref(href)) {
      // Hands off to the system browser — nothing has to be bundled.
      return;
    }

    // Relative link: resolved against welcome.md's own directory and opened as
    // a Tandem tab, so the target must exist AND ship in BOTH distributions.
    const target = path
      .normalize(path.join(path.dirname(WELCOME_REL), href.split("#")[0]))
      .replace(/\\/g, "/");

    expect(existsSync(path.join(repoRoot, target)), `${target} does not exist in the repo`).toBe(
      true,
    );
    expect(
      shipsWith(tauriResourcePaths(), target),
      `${target} is not in tauri.conf.json bundle.resources — the desktop app cannot open it`,
    ).toBe(true);
    expect(
      shipsWith(npmPackagedPaths(), target),
      `${target} is not in package.json "files" — the npm distribution cannot open it`,
    ).toBe(true);
  });
});
