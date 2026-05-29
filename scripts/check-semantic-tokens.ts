import { readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const toSlash = (p: string) => p.replace(/\\/g, "/");

const ROOT = join(import.meta.dirname, "..");
const CLIENT_DIR = join(ROOT, "src/client");
const SKIP_FILE_RELS = new Set([
  "src/client/utils/colors.ts",
  "src/client/svelte-harness/Harness.svelte",
  "src/client/svelte-harness/HookDebug.svelte",
]);

const HEX_RE = /#[0-9a-fA-F]{3,8}\b/g;
const RGBA_RE = /\brgba?\s*\(/g;
const BORDER_RADIUS_RE = /\bborder-radius\s*:\s*\d+px\b/g;
const BOX_SHADOW_RE = /\bbox-shadow\s*:\s*[^;]*rgba?\s*\(/g;
const NEUTRAL_RE = /(?:0\s*,\s*0\s*,\s*0|255\s*,\s*255\s*,\s*255)/;
const CSS_KEYWORDS = ["color", "background", "border", "fill", "stroke", "style"];

/**
 * Bundle-token blocklist (issue #799 / Conflict #6 in the design-system-impl plan).
 *
 * These hex values were lifted from the redesign-bundle assets
 * (docs/design-system-impl/bundle/extracted/*.{css,svelte,html}) and are NOT
 * part of the production-approved `--tandem-*` palette in index.html. They must never
 * appear in src/client because the audit-doc-plus-reviewer-attention pathway
 * is too soft a gate as bundle-explicit ports expand in later phases.
 *
 * Values are normalized: lowercase, 3-char shorthand expanded to 6-char so
 * `#fff` and `#ffffff` compare equal. Pure neutrals (`#000`/`#000000`,
 * `#fff`/`#ffffff`) are intentionally omitted — they are foundational CSS
 * primitives used for masks/gradients, not bundle-origin design tokens.
 * Approved bundle colors (e.g. `#d97757`, `#e89a78`) are also omitted:
 * production already exposes them via `--tandem-author-claude` tokens.
 *
 * Adding a new bundle adoption? First add the hex to index.html's `:root` (or
 * the matching theme block) under a new `--tandem-*` token, then remove it
 * from this set. The CI gate is the contract — do not weaken it by
 * deletion-only.
 */
export const BUNDLE_BLOCKLIST_HEX: ReadonlySet<string> = new Set([
  "#1095d4",
  // Prototype dark-theme stand-in in `D7 - Onboarding Tutorial.html`'s BrandMenu
  // swatch mock. Production has --tandem-swatch-dark for this; cluster 3.11 ports
  // D7, so guard against the literal leaking in. (2026-05-27 refreshed-bundle pass.)
  "#1e1e2e",
  "#222222",
  "#28c840",
  "#29261b",
  "#2a78a4",
  "#2d8a5e",
  "#2a1215",
  "#2a251f",
  "#34c759",
  "#3b7dd8",
  "#5b5bd6",
  "#5b9f4d",
  "#5a4a2a",
  "#5c2b2e",
  "#666666",
  "#7ac8ed",
  "#999999",
  "#b25bd6",
  "#ecece6",
  "#f57018",
  "#aaaaaa",
  "#bbbbbb",
  "#c96442",
  "#cccccc",
  "#dddddd",
  "#e81123",
  "#f0eee9",
  "#f0f0f0",
  "#faf9f5",
  "#febc2e",
  "#fef4a8",
  "#ff5f57",
  "#ff8a80",
]);

/**
 * Normalize a hex string (`#abc`, `#aaBBcc`, `#abcdef12`) to a comparable
 * lowercase 6-char form (`#aabbcc`). 3- and 4-char shorthands expand the rgb
 * component (4-char drops alpha); 8-char `#rrggbbaa` also drops alpha. So a
 * bundle color with an alpha suffix still matches its base entry. Returns
 * `null` for malformed input.
 *
 * Scope: only 3/4/6/8-digit hex bodies are recognized. Tokens with 9+ hex
 * digits (e.g. `#c964421234`) are out of scope and return `null` — they also
 * never reach this function because `HEX_RE`'s trailing `\b` won't match a
 * blocklisted prefix embedded in a longer hex-like token. Such tokens are not
 * valid CSS colors; treating an arbitrary-length hex run as a maskable bundle
 * color would risk flagging unrelated identifiers/hashes.
 */
export function normalizeHexForBlocklist(raw: string): string | null {
  const m = /^#([0-9a-fA-F]{3,8})$/.exec(raw);
  if (!m) return null;
  const body = m[1].toLowerCase();
  if (body.length === 3 || body.length === 4) {
    return `#${body[0]}${body[0]}${body[1]}${body[1]}${body[2]}${body[2]}`;
  }
  if (body.length === 6) return `#${body}`;
  if (body.length === 8) return `#${body.slice(0, 6)}`;
  return null;
}

function hasCssIndicator(line: string): boolean {
  return CSS_KEYWORDS.some((kw) => line.includes(kw));
}

function isNeutralRgba(line: string, matchIndex: number): boolean {
  const parenPos = line.indexOf("(", matchIndex);
  if (parenPos === -1) return false;
  const window = line.slice(parenPos + 1, parenPos + 21);
  return NEUTRAL_RE.test(window);
}

interface CommentState {
  inBlockComment: boolean;
  inHtmlComment: boolean;
}

/**
 * Mask comment regions in a single line while preserving column indices so
 * violation positions stay accurate. Maintains running state across lines for
 * multi-line CSS block comments (`/* ... *\/`) and HTML comments
 * (`<!-- ... -->`). HTML comments are recognized only when `html` is true,
 * which the caller sets for `.html` and `.svelte` files (both use `<!-- -->`
 * markup); for `.ts`/`.js`/`.css` files `<!--` is left as-is.
 *
 * Block comments and HTML comments are masked (replaced with spaces). A leading
 * `//` line comment (after whitespace) masks the remainder of the line, but
 * only when not already inside a block/HTML comment — matching the prior
 * line-start `//` skip behavior without dropping code that precedes a mid-line
 * `/*` opener.
 *
 * Known limitation: this scanner has no string-literal awareness, so a `/*`
 * (or, in `.svelte`/`.html`, a `<!--`) inside a string literal is treated as a
 * comment opener and masks the rest of the literal — a potential false
 * negative. This matches the prior regex-based behavior (which was equally
 * string-unaware) and is an accepted tradeoff for a lint gate; full
 * string-literal parsing is out of scope.
 */
function maskComments(line: string, state: CommentState, html: boolean): string {
  const out: string[] = [];
  let i = 0;
  const n = line.length;

  while (i < n) {
    if (state.inBlockComment) {
      const close = line.indexOf("*/", i);
      if (close === -1) {
        // Rest of line is inside the block comment.
        out.push(" ".repeat(n - i));
        i = n;
      } else {
        out.push(" ".repeat(close + 2 - i));
        i = close + 2;
        state.inBlockComment = false;
      }
      continue;
    }

    if (state.inHtmlComment) {
      const close = line.indexOf("-->", i);
      if (close === -1) {
        out.push(" ".repeat(n - i));
        i = n;
      } else {
        out.push(" ".repeat(close + 3 - i));
        i = close + 3;
        state.inHtmlComment = false;
      }
      continue;
    }

    // Not currently inside a comment: find the next comment opener.
    const blockOpen = line.indexOf("/*", i);
    const htmlOpen = html ? line.indexOf("<!--", i) : -1;
    // A line-comment opener only counts when everything before the `//` (from
    // the absolute start of the line) is whitespace, preserving the original
    // `trimmed.startsWith("//")` skip semantics for indented comments.
    const slashes = line.indexOf("//", i);
    const lineCommentOpen = slashes !== -1 && line.slice(0, slashes).trim() === "" ? slashes : -1;

    const candidates = [blockOpen, htmlOpen, lineCommentOpen].filter((p) => p !== -1);
    if (candidates.length === 0) {
      out.push(line.slice(i));
      break;
    }

    const next = Math.min(...candidates);
    // Emit the visible code before the comment opener.
    out.push(line.slice(i, next));

    if (next === lineCommentOpen) {
      // Mask the rest of the line.
      out.push(" ".repeat(n - next));
      i = n;
    } else if (next === blockOpen && (htmlOpen === -1 || blockOpen <= htmlOpen)) {
      state.inBlockComment = true;
      out.push("  "); // mask the `/*`
      i = next + 2;
    } else {
      state.inHtmlComment = true;
      out.push("    "); // mask the `<!--`
      i = next + 4;
    }
  }

  return out.join("");
}

export function collectFiles(dir: string): string[] {
  const entries = readdirSync(dir, { recursive: true, withFileTypes: true });
  return entries
    .filter((e) => e.isFile() && /\.[tj]sx?$|\.svelte$|\.css$|\.html$/.test(e.name))
    .map((e) => toSlash(join(e.parentPath, e.name)));
}

export function shouldSkipFile(relPath: string): boolean {
  const rel = toSlash(relPath);
  return SKIP_FILE_RELS.has(rel) || /\.(test|spec)\.[tj]sx?$/.test(rel);
}

export function checkContent(content: string, rel: string): string[] {
  const violations: string[] = [];

  const lines = content.split("\n");
  // `.svelte` files use the same `<!-- -->` markup comments as `.html`, and
  // both are in `collectFiles` scope, so they get the same HTML-comment gate.
  const isHtml = rel.endsWith(".html") || rel.endsWith(".svelte");
  const state: CommentState = { inBlockComment: false, inHtmlComment: false };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Mask out comment regions (CSS block, HTML, and line-start `//`) while
    // preserving column indices. The masked line is used for BOTH the
    // CSS-keyword indicator checks and the regex passes so commented-out hex
    // and keywords never produce false positives — including comments opened
    // mid-line after live code, and code that follows a mid-line comment close.
    const scanLine = maskComments(line, state, isHtml);

    // Per-line dedupe of hex matches by character index so the bundle-blocklist
    // pass below does not double-report a position the CSS-keyword pass
    // already flagged. Position-keyed (not string-keyed) so multiple distinct
    // occurrences of the same hex on the same line each get reported by
    // whichever pass owns them.
    const reportedHexAtIndex = new Set<number>();

    HEX_RE.lastIndex = 0;
    let hexMatch: RegExpExecArray | null;
    while ((hexMatch = HEX_RE.exec(scanLine)) !== null) {
      if (hasCssIndicator(scanLine)) {
        violations.push(`${rel}:${i + 1}: ${hexMatch[0]}`);
        reportedHexAtIndex.add(hexMatch.index);
      }
    }

    // Bundle-blocklist pass: any hex in BUNDLE_BLOCKLIST_HEX is forbidden
    // regardless of CSS-keyword context. Catches bundle-origin drift in
    // string literals, prop defaults, and other non-CSS surfaces that the
    // CSS-keyword heuristic intentionally skips.
    HEX_RE.lastIndex = 0;
    let bundleHexMatch: RegExpExecArray | null;
    while ((bundleHexMatch = HEX_RE.exec(scanLine)) !== null) {
      if (reportedHexAtIndex.has(bundleHexMatch.index)) continue;
      const raw = bundleHexMatch[0];
      const normalized = normalizeHexForBlocklist(raw);
      if (normalized && BUNDLE_BLOCKLIST_HEX.has(normalized)) {
        violations.push(`${rel}:${i + 1}: ${raw} [bundle-blocklist]`);
        reportedHexAtIndex.add(bundleHexMatch.index);
      }
    }

    RGBA_RE.lastIndex = 0;
    let rgbaMatch: RegExpExecArray | null;
    while ((rgbaMatch = RGBA_RE.exec(scanLine)) !== null) {
      if (!isNeutralRgba(scanLine, rgbaMatch.index)) {
        violations.push(`${rel}:${i + 1}: ${rgbaMatch[0]}`);
      }
    }

    BORDER_RADIUS_RE.lastIndex = 0;
    let radiusMatch: RegExpExecArray | null;
    while ((radiusMatch = BORDER_RADIUS_RE.exec(scanLine)) !== null) {
      violations.push(`${rel}:${i + 1}: ${radiusMatch[0]}`);
    }

    if (scanLine.includes("style")) {
      BOX_SHADOW_RE.lastIndex = 0;
      let shadowMatch: RegExpExecArray | null;
      while ((shadowMatch = BOX_SHADOW_RE.exec(scanLine)) !== null) {
        violations.push(`${rel}:${i + 1}: ${shadowMatch[0]}`);
      }
    }
  }

  return violations;
}

export function checkFile(filePath: string, root = ROOT): string[] {
  const rel = toSlash(relative(root, filePath));

  if (shouldSkipFile(rel)) return [];

  const content = readFileSync(filePath, "utf-8");
  return checkContent(content, rel);
}

export function main(args = process.argv.slice(2)): void {
  const files = args.length > 0 ? args.map((f) => toSlash(resolve(f))) : collectFiles(CLIENT_DIR);
  const allViolations: string[] = [];

  for (const file of files) {
    allViolations.push(...checkFile(file));
  }

  const warnings = allViolations.filter(
    (v) => v.includes("border-radius:") || v.includes("box-shadow:"),
  );
  const errors = allViolations.filter((v) => !warnings.includes(v));

  for (const v of errors) {
    process.stderr.write(`${v}\n`);
  }
  for (const v of warnings) {
    process.stderr.write(`${v} [warn]\n`);
  }

  if (errors.length > 0) {
    process.stderr.write(
      `\ncheck-semantic-tokens: ${errors.length} error(s), ${warnings.length} warning(s) found\n`,
    );
    process.exit(1);
  } else if (warnings.length > 0) {
    process.stderr.write(`\ncheck-semantic-tokens: ${warnings.length} warning(s) found\n`);
    process.exit(0);
  } else {
    process.stderr.write("check-semantic-tokens: clean\n");
    process.exit(0);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
