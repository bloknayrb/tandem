#!/usr/bin/env node
// Link and reachability checker for the repo's Markdown (`npm run check:links`).
//
// Exists because a docs reorganisation moves files, and a moved file with a
// dangling inbound link is worse than one left where it was. "Verify with a
// sweep" is a wish; this is the gate. It runs in CI's `check` job (pinned by
// tests/scripts/check-links-wiring.test.ts) and should be run by hand before
// and after any move.
//
// Per Markdown file it checks:
//   1. every relative link target resolves to a file or directory that exists
//      inside the repository (a `../` that climbs out of it is reported)
//   2. a `#anchor` on a link to a `.md` file matches a heading in that file
//   3. a same-file `[x](#anchor)` matches a heading in the file itself
//   4. every local image — `![alt](path)` and `<img src="path">` — exists
// and across the docs vault:
//   5. every LIVE docs/**/*.md is reachable from docs/README.md (the hub) by
//      following relative .md links through live docs (orphans are reported)
//   6. every docs/screenshots/*.png is referenced by some Markdown image
//
// HISTORICAL files (below) are point-in-time records: they keep path checks
// (a moved file still breaks them) but are exempt from anchor checks, since a
// heading they cite may have been renamed long after they were written, and
// they are neither required to be reachable nor traversed for reachability.
//
// Anchor slugs follow GitHub (github-slugger): lowercase, drop everything that
// is not a letter, mark, number, connector punctuation, space or hyphen, then
// each space becomes a hyphen with no collapsing — so "A — B" is `a--b`.
// Duplicate headings get the -1, -2 suffixes GitHub appends. A code span's
// text is kept (minus the backticks). Heading anchors match case-insensitively;
// explicit `id=` / `name=` anchors keep their case and match exactly.
//
// File selection comes from git (`git ls-files` plus untracked-but-not-ignored
// files), so gitignored trees such as `.claude/worktrees/` or `.claude/plans/`
// can never make it fail locally while CI passes, and a new doc is checked
// before it is `git add`ed. Without a git checkout it falls back to a
// filesystem walk and says so.

import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const posix = path.posix;

/** The vault's entry point. Every live doc must be reachable from here. */
export const HUB = "docs/README.md";

/**
 * Historical docs: dated records, exempt from anchor checks and from the
 * reachability requirement, but never from path-existence checks. A `path`
 * ending in `/` is a directory prefix; `except` names files under it that are
 * live and therefore fully checked. Everything else under docs/ is live.
 */
export const HISTORICAL = [
  { path: "docs/plans/", except: ["docs/plans/README.md"] },
  { path: "docs/superpowers/", except: ["docs/superpowers/README.md"] },
  { path: "docs/archive/" },
  { path: "docs/triage/" },
  { path: "docs/design-history/", except: ["docs/design-history/README.md"] },
  {
    path: "docs/reviews/",
    except: ["docs/reviews/README.md", "docs/reviews/2026-10-20-docs-audit.md"],
  },
  { path: "docs/spikes/", except: ["docs/spikes/README.md"] },
  { path: "docs/roadmap-history.md" },
  { path: "docs/v10-triage.md" },
];

/** Repo-relative posix path -> is it a historical record? */
export function isHistorical(rel) {
  return HISTORICAL.some((entry) => {
    const hit = entry.path.endsWith("/") ? rel.startsWith(entry.path) : rel === entry.path;
    return hit && !(entry.except ?? []).includes(rel);
  });
}

/** A live vault doc: Markdown under docs/ that is not historical. */
export function isLiveDoc(rel) {
  return rel.startsWith("docs/") && rel.endsWith(".md") && !isHistorical(rel);
}

/**
 * Fixture files are excluded deliberately: several exist to carry hostile or
 * malformed URLs (`javascript:`, UNC paths, `file:///etc/passwd`) that the
 * product must reject. A checker that flags them is flagging the fixture for
 * doing its job.
 */
export function isFixture(rel) {
  return /(^|\/)(fixtures|__snapshots__)\//.test(rel);
}

/**
 * Inline HTML contributes no text to a slug. Repeated until stable so a nested
 * or split tag (`<scr<b>ipt>`) cannot reassemble after one pass; the result is
 * only ever compared against link fragments, never rendered.
 */
function stripTags(text) {
  let prev;
  let out = text;
  do {
    prev = out;
    out = out.replace(/<[^>]*>/g, "");
  } while (out !== prev);
  return out;
}

/** A code span: a backtick run, content, the same-length run (CommonMark). */
const CODE_SPAN_RE = /(`+)(.+?)\1(?!`)/g;

/**
 * Markdown outside code spans reduced to its text: tags stripped, links and
 * images to their text, stray backticks dropped.
 */
function inlineText(text) {
  return stripTags(text)
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1") // link / image text only
    .replace(/`/g, "");
}

/** GitHub's heading-to-anchor slug for one heading's raw Markdown text. */
export function slugify(heading) {
  // A code span's content is literal text that GitHub keeps (minus the
  // backticks), so it is protected from tag stripping: `<license|path>` in a
  // span must lose only `<`, `|` and `>` to the punctuation filter below, not
  // vanish as if it were an HTML tag.
  let text = "";
  let last = 0;
  for (const m of heading.matchAll(CODE_SPAN_RE)) {
    text += inlineText(heading.slice(last, m.index)) + m[2];
    last = m.index + m[0].length;
  }
  text += inlineText(heading.slice(last));
  return text
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{M}\p{N}\p{Pc} -]/gu, "")
    .replace(/ /g, "-");
}

/** github-slugger's duplicate rule: a repeat gets `-n`, skipping taken slugs. */
function makeSlugger() {
  const occurrences = new Map();
  return (base) => {
    let result = base;
    while (occurrences.has(result)) {
      const n = occurrences.get(base) + 1;
      occurrences.set(base, n);
      result = `${base}-${n}`;
    }
    occurrences.set(result, 0);
    return result;
  };
}

/** How far down a closing front-matter `---` may sit. */
const FRONT_MATTER_MAX_LINES = 50;

/**
 * Index of the first line after YAML front matter, or 0 when there is none.
 * An opening `---` alone is not enough — a doc may open with a horizontal
 * rule — so it also needs a closing `---` within FRONT_MATTER_MAX_LINES and
 * YAML-shaped content between: at least one `key:` line, and every non-blank
 * line a `key:`, an indented continuation, a list item or a comment.
 */
export function frontMatterEnd(lines) {
  if (lines[0] !== "---") return 0;
  const limit = Math.min(lines.length, FRONT_MATTER_MAX_LINES + 1);
  for (let end = 1; end < limit; end++) {
    if (lines[end] !== "---") continue;
    const body = lines.slice(1, end).filter((l) => l.trim() !== "");
    const isKey = (l) => /^[A-Za-z_][\w-]*\s*:(\s|$)/.test(l);
    const yamlish = body.every((l) => isKey(l) || /^(\s|- |#)/.test(l));
    return yamlish && body.some(isKey) ? end + 1 : 0;
  }
  return 0;
}

/**
 * Every anchor a file exposes, in two sets because GitHub matches them
 * differently: `headings` holds ATX and setext heading slugs (lowercase, with
 * GitHub's duplicate suffixes); `ids` holds explicit `id="…"` / `name="…"`
 * HTML anchors with their case kept, since GitHub keeps it and matches an
 * explicit id case-sensitively. Code spans are stripped before the id scan,
 * so an `id="x"` shown as an example is not an anchor.
 */
export function anchorIndex(markdown) {
  const slug = makeSlugger();
  const headings = new Set();
  const ids = new Set();
  const lines = markdown.split(/\r?\n/);
  let inFence = false;
  // YAML front matter renders as a table, not a heading.
  for (let i = frontMatterEnd(lines); i < lines.length; i++) {
    const line = lines[i];
    if (/^\s*(```|~~~)/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    const prose = line.replace(CODE_SPAN_RE, "");
    for (const m of prose.matchAll(/\b(?:id|name)\s*=\s*["']([^"']+)["']/g)) ids.add(m[1]);
    const atx = /^ {0,3}(#{1,6})\s+(.*?)(?:\s+#+)?\s*$/.exec(line);
    if (atx) {
      headings.add(slug(slugify(atx[2])));
      continue;
    }
    const next = lines[i + 1];
    if (
      next !== undefined &&
      /^ {0,3}(=+|-+)\s*$/.test(next) &&
      line.trim() !== "" &&
      !/^\s*([-*+>|]|\d+[.)]\s|<)/.test(line)
    ) {
      headings.add(slug(slugify(line)));
      i += 1;
    }
  }
  return { headings, ids };
}

/** Does `anchor` (a decoded link fragment) name an anchor in `index`? */
export function hasAnchor(index, anchor) {
  return index.ids.has(anchor) || index.headings.has(anchor.toLowerCase());
}

/** Every anchor a file exposes, headings and explicit ids together. */
export function headingSlugs(markdown) {
  const { headings, ids } = anchorIndex(markdown);
  return new Set([...headings, ...ids]);
}

/**
 * Strip fenced blocks AND inline code spans. Both routinely contain Markdown
 * examples (`![alt](url)`) that are illustrations, not links — treating them as
 * links produces noise that trains you to ignore the checker.
 */
export function stripCode(markdown) {
  return markdown.replace(/^\s*(```|~~~)[\s\S]*?^\s*\1\s*$/gm, "").replace(/`[^`\n]*`/g, "");
}

const DEST = String.raw`\(\s*(<[^>\n]*>|[^)\s]+)(?:\s+(?:"[^"]*"|'[^']*'))?\s*\)`;
/** `[text](dest)`, allowing one level of nested brackets (a badge image). */
const LINK_RE = new RegExp(String.raw`\[(?:[^\[\]]|\[[^\[\]]*\])*\]${DEST}`, "g");
const IMAGE_RE = new RegExp(String.raw`!\[[^\[\]]*\]${DEST}`, "g");
const IMG_TAG_RE = /<img\b[^>]*?\bsrc\s*=\s*["']([^"']+)["']/gi;
/** Reference-style definitions: `[label]: dest`. `[^1]: …` is a GFM footnote, not a link. */
const REF_DEF_RE = /^ {0,3}\[(?!\^)[^\]]+\]:\s*(<[^>\n]*>|\S+)/gm;

function unwrap(dest) {
  return dest.startsWith("<") && dest.endsWith(">") ? dest.slice(1, -1) : dest;
}

/**
 * Every link destination in a Markdown text, code stripped, as
 * `{ target, image }`: inline links, reference-style definitions, and images
 * from `![alt](…)` and `<img src="…">`.
 */
export function extractLinks(markdown) {
  const text = stripCode(markdown);
  const out = [];
  for (const m of text.matchAll(LINK_RE)) {
    if (m.index > 0 && text[m.index - 1] === "!") continue; // the image pass owns it
    out.push({ target: unwrap(m[1]), image: false });
  }
  for (const m of text.matchAll(REF_DEF_RE)) out.push({ target: unwrap(m[1]), image: false });
  for (const m of text.matchAll(IMAGE_RE)) out.push({ target: unwrap(m[1]), image: true });
  for (const m of text.matchAll(IMG_TAG_RE)) out.push({ target: m[1], image: true });
  return out;
}

function safeDecode(s) {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

/**
 * Resolve a link destination found in `fromRel`. Returns null for anything
 * that is not a repo-relative reference (a URL scheme, protocol-relative).
 * `path` is the repo-relative posix target; `sameFile` marks a bare `#anchor`.
 */
export function resolveTarget(fromRel, target) {
  if (/^[a-z][a-z0-9+.-]*:/i.test(target) || target.startsWith("//")) return null;
  const hash = target.indexOf("#");
  const rawPath = hash === -1 ? target : target.slice(0, hash);
  const anchor = hash === -1 ? "" : safeDecode(target.slice(hash + 1));
  const cleanPath = rawPath.split("?")[0];
  if (!cleanPath) return { path: fromRel, anchor, sameFile: true };
  const decoded = safeDecode(cleanPath);
  const joined = decoded.startsWith("/")
    ? posix.normalize(decoded.slice(1))
    : posix.normalize(posix.join(posix.dirname(fromRel), decoded));
  return { path: joined.replace(/\/$/, ""), anchor, sameFile: false };
}

/**
 * Does a resolved repo-relative path climb out of the repository? Such a
 * target can only resolve against whatever happens to sit beside the
 * checkout, so it is reported rather than looked up.
 */
export function escapesRoot(rel) {
  return rel === ".." || rel.startsWith("../");
}

/**
 * Breadth-first reachability over `edges` (rel -> rel[]) from `start`. Only
 * nodes passing `canTraverse` are expanded; others are reached but are leaves.
 */
export function reachableFrom(start, edges, canTraverse) {
  const seen = new Set([start]);
  const queue = [start];
  while (queue.length > 0) {
    const node = queue.shift();
    if (node !== start && !canTraverse(node)) continue;
    for (const next of edges.get(node) ?? []) {
      if (!seen.has(next)) {
        seen.add(next);
        queue.push(next);
      }
    }
  }
  return seen;
}

/** Live docs that the hub cannot reach through live docs, sorted. */
export function findOrphans(liveDocs, edges, hub = HUB) {
  const reached = reachableFrom(hub, edges, isLiveDoc);
  return liveDocs.filter((rel) => rel !== hub && !reached.has(rel)).sort();
}

function git(root, args) {
  return execFileSync("git", args, {
    cwd: root,
    encoding: "utf-8",
    maxBuffer: 64 * 1024 * 1024,
    stdio: ["ignore", "pipe", "ignore"],
  })
    .split("\0")
    .filter(Boolean);
}

/** Only for the no-git fallback: directories never worth scanning. */
const SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  "worktrees",
  "dist",
  "target",
  "playwright-report",
  "test-results",
  "coverage",
]);

function walk(root, dir, ext, out) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith(".") && entry.name !== ".claude") continue;
    if (SKIP_DIRS.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(root, full, ext, out);
    else if (entry.name.endsWith(ext)) {
      out.push(path.relative(root, full).split(path.sep).join("/"));
    }
  }
  return out;
}

/**
 * Files ending in `ext` that git tracks or would track (untracked but not
 * ignored), as sorted repo-relative posix paths that exist on disk. Falls back
 * to a filesystem walk when git is unavailable; `source` says which was used.
 *
 * @param {string} root
 * @param {string} ext
 * @returns {{ source: "git" | "filesystem", files: string[] }}
 */
export function listFiles(root, ext) {
  const spec = `*${ext}`;
  try {
    const files = new Set([
      ...git(root, ["ls-files", "-z", "--", spec]),
      ...git(root, ["ls-files", "-z", "--others", "--exclude-standard", "--", spec]),
    ]);
    return {
      source: "git",
      files: [...files].filter((f) => existsSync(path.join(root, f))).sort(),
    };
  } catch {
    return { source: "filesystem", files: walk(root, root, ext, []).sort() };
  }
}

/** Run every check over the repo at `root` and return a categorised report. */
export function checkRepo(root) {
  const { source, files: allMd } = listFiles(root, ".md");
  const files = allMd.filter((f) => !isFixture(f));
  const read = (rel) => readFileSync(path.join(root, rel), "utf-8");
  const anchorCache = new Map();
  const anchorsOf = (rel) => {
    if (!anchorCache.has(rel)) anchorCache.set(rel, anchorIndex(read(rel)));
    return anchorCache.get(rel);
  };
  const kindOf = (rel) => {
    try {
      return statSync(path.join(root, rel)).isFile() ? "file" : "dir";
    } catch {
      return null;
    }
  };

  const report = {
    source,
    files: files.length,
    checked: 0,
    missingPath: [],
    missingImage: [],
    missingAnchor: [],
    missingSameFileAnchor: [],
    orphans: [],
    unreferencedScreenshots: [],
    hubMissing: false,
  };
  const edges = new Map();
  const imagesUsed = new Set();

  for (const file of files) {
    const anchorsChecked = !isHistorical(file);
    const out = [];
    edges.set(file, out);
    for (const { target, image } of extractLinks(read(file))) {
      const ref = resolveTarget(file, target);
      if (!ref) continue;
      report.checked += 1;
      if (ref.sameFile) {
        if (anchorsChecked && ref.anchor && !hasAnchor(anchorsOf(file), ref.anchor)) {
          report.missingSameFileAnchor.push(`${file}: no such heading -> ${target}`);
        }
        continue;
      }
      if (escapesRoot(ref.path)) {
        (image ? report.missingImage : report.missingPath).push(
          `${file}: ${image ? "image" : "target"} is outside the repository -> ${target}`,
        );
        continue;
      }
      const kind = kindOf(ref.path);
      if (image) imagesUsed.add(ref.path);
      if (!kind) {
        (image ? report.missingImage : report.missingPath).push(
          `${file}: ${image ? "image" : "target"} does not exist -> ${target}`,
        );
        continue;
      }
      if (kind !== "file" || !ref.path.endsWith(".md")) continue;
      out.push(ref.path);
      if (anchorsChecked && ref.anchor && !hasAnchor(anchorsOf(ref.path), ref.anchor)) {
        report.missingAnchor.push(`${file}: no such heading -> ${target}`);
      }
    }
  }

  if (files.includes(HUB)) {
    report.orphans = findOrphans(files.filter(isLiveDoc), edges);
  } else {
    report.hubMissing = true;
  }

  report.unreferencedScreenshots = listFiles(root, ".png")
    .files.filter((f) => /^docs\/screenshots\/[^/]+\.png$/.test(f))
    .filter((f) => !imagesUsed.has(f));
  return report;
}

const CATEGORIES = [
  ["missingPath", "broken link targets"],
  ["missingImage", "missing images"],
  ["missingAnchor", "broken anchors (cross-file)"],
  ["missingSameFileAnchor", "broken anchors (same file)"],
  ["orphans", `live docs unreachable from ${HUB}`],
  ["unreferencedScreenshots", "screenshots referenced by no Markdown image"],
];

function main() {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const report = checkRepo(root);
  if (report.source !== "git") {
    console.warn("git unavailable: fell back to a filesystem walk (gitignored files are scanned).");
  }
  console.log(`Checked ${report.checked} relative links across ${report.files} markdown files.`);

  const failing = CATEGORIES.filter(([key]) => report[key].length > 0);
  if (report.hubMissing) {
    console.error(
      `\n${HUB} does not exist: the vault has no hub, so reachability was not checked.`,
    );
  }
  for (const [key, label] of failing) {
    console.error(`\n${report[key].length} ${label}:`);
    for (const item of report[key]) console.error(`  ${item}`);
  }
  if (report.hubMissing || failing.length > 0) {
    console.error("\nSummary:");
    if (report.hubMissing) console.error(`  hub missing: ${HUB}`);
    for (const [key, label] of failing) console.error(`  ${report[key].length} ${label}`);
    process.exit(1);
  }
  console.log("All resolve; every live doc is reachable and every screenshot is used.");
}

/**
 * Run `main` only when executed, not imported. Both sides go through
 * `realpathSync`: Node resolves the entry module's symlinks into
 * `import.meta.url` but leaves `argv[1]` as typed, so a plain comparison is
 * false from a symlinked checkout and the gate would exit 0 having checked
 * nothing.
 */
function isEntryPoint() {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isEntryPoint()) main();
