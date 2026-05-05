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

const INLINE_BLOCK_COMMENT_RE = /\/\*.*?\*\//g;
const HEX_RE = /#[0-9a-fA-F]{3,8}\b/g;
const RGBA_RE = /\brgba?\s*\(/g;
const BORDER_RADIUS_RE = /\bborder-radius\s*:\s*\d+px\b/g;
const BOX_SHADOW_RE = /\bbox-shadow\s*:\s*[^;]*rgba?\s*\(/g;
const NEUTRAL_RE = /(?:0\s*,\s*0\s*,\s*0|255\s*,\s*255\s*,\s*255)/;
const CSS_KEYWORDS = ["color", "background", "border", "fill", "stroke", "style"];

function hasCssIndicator(line: string): boolean {
  return CSS_KEYWORDS.some((kw) => line.includes(kw));
}

function isNeutralRgba(line: string, matchIndex: number): boolean {
  const parenPos = line.indexOf("(", matchIndex);
  if (parenPos === -1) return false;
  const window = line.slice(parenPos + 1, parenPos + 21);
  return NEUTRAL_RE.test(window);
}

export function collectFiles(dir: string): string[] {
  const entries = readdirSync(dir, { recursive: true, withFileTypes: true });
  return entries
    .filter((e) => e.isFile() && /\.[tj]sx?$|\.svelte$/.test(e.name))
    .map((e) => toSlash(join(e.parentPath, e.name)));
}

export function shouldSkipFile(relPath: string): boolean {
  const rel = toSlash(relPath);
  return SKIP_FILE_RELS.has(rel) || /\.(test|spec)\.[tj]sx?$/.test(rel);
}

export function checkContent(content: string, rel: string): string[] {
  const violations: string[] = [];

  const lines = content.split("\n");
  let inBlockComment = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trimStart();

    if (inBlockComment) {
      if (line.includes("*/")) inBlockComment = false;
      continue;
    }

    if (trimmed.startsWith("//")) continue;

    if (trimmed.startsWith("/*")) {
      if (!line.includes("*/")) {
        inBlockComment = true;
        continue;
      }
    }

    const scanLine = line.replace(INLINE_BLOCK_COMMENT_RE, (m) => " ".repeat(m.length));

    HEX_RE.lastIndex = 0;
    let hexMatch: RegExpExecArray | null;
    while ((hexMatch = HEX_RE.exec(scanLine)) !== null) {
      if (hasCssIndicator(line)) {
        violations.push(`${rel}:${i + 1}: ${hexMatch[0]}`);
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

    if (line.includes("style")) {
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
