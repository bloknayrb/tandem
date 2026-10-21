// Markdown helpers shared by `scripts/check-doc-links.mjs` (relative links in
// the checkout) and `tests/docs/shipped-doc-links.test.ts` (absolute repo links
// in the docs that ship inside the app). One copy, so the two checkers cannot
// disagree about what counts as a heading anchor or as code.
//
// Pure module: no side effects on import (`check-doc-links.mjs` itself runs on
// import, which is why these live here rather than being exported from it).

/**
 * GitHub's heading-to-anchor slugs, including its duplicate-suffix rule:
 * lowercase, strip anything that isn't a word character/space/hyphen, spaces to
 * hyphens, and `-1`, `-2` … on repeats so a link to the second "## Notes"
 * resolves.
 *
 * @param {string} markdown
 * @returns {Set<string>}
 */
export function headingSlugs(markdown) {
  const seen = new Map();
  const slugs = new Set();
  let inFence = false;
  for (const line of markdown.split("\n")) {
    if (/^\s*(```|~~~)/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    const m = /^(#{1,6})\s+(.*)$/.exec(line);
    if (!m) continue;
    const base = m[2]
      .replace(/`/g, "")
      .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1") // link text only
      .trim()
      .toLowerCase()
      .replace(/[^\w\s-]/g, "")
      .replace(/\s/g, "-");
    const n = seen.get(base) ?? 0;
    seen.set(base, n + 1);
    slugs.add(n === 0 ? base : `${base}-${n}`);
  }
  return slugs;
}

/**
 * Strip fenced blocks AND inline code spans. Both routinely contain Markdown
 * examples (`![alt](url)`) that are illustrations, not links — treating them as
 * links produces noise that trains you to ignore the checker.
 *
 * @param {string} markdown
 * @returns {string}
 */
export function stripCode(markdown) {
  return markdown.replace(/^\s*(```|~~~)[\s\S]*?^\s*\1\s*$/gm, "").replace(/`[^`\n]*`/g, "");
}
