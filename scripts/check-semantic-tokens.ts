import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";

const toSlash = (p: string) => p.replace(/\\/g, "/");

const ROOT = join(import.meta.dirname, "..");
const CLIENT_DIR = join(ROOT, "src/client");
const SKIP_FILE_NORM = toSlash(join(ROOT, "src/client/utils/colors.ts"));

const HEX_RE = /#[0-9a-fA-F]{3,8}\b/g;
const RGBA_RE = /\brgba?\s*\(/g;
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

function collectFiles(dir: string): string[] {
  const entries = readdirSync(dir, { recursive: true, withFileTypes: true });
  return entries
    .filter((e) => e.isFile() && /\.[tj]sx?$/.test(e.name))
    .map((e) => toSlash(join(e.parentPath, e.name)));
}

function checkFile(filePath: string): string[] {
  const violations: string[] = [];
  const rel = toSlash(relative(ROOT, filePath));

  if (filePath === SKIP_FILE_NORM) return violations;
  if (/\.(test|spec)\.[tj]sx?$/.test(filePath)) return violations;

  const lines = readFileSync(filePath, "utf-8").split("\n");
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
      }
      continue;
    }

    HEX_RE.lastIndex = 0;
    let hexMatch: RegExpExecArray | null;
    while ((hexMatch = HEX_RE.exec(line)) !== null) {
      if (hasCssIndicator(line)) {
        violations.push(`${rel}:${i + 1}: ${hexMatch[0]}`);
      }
    }

    RGBA_RE.lastIndex = 0;
    let rgbaMatch: RegExpExecArray | null;
    while ((rgbaMatch = RGBA_RE.exec(line)) !== null) {
      if (!isNeutralRgba(line, rgbaMatch.index)) {
        violations.push(`${rel}:${i + 1}: ${rgbaMatch[0]}`);
      }
    }
  }

  return violations;
}

const files = collectFiles(CLIENT_DIR);
const allViolations: string[] = [];

for (const file of files) {
  allViolations.push(...checkFile(file));
}

if (allViolations.length > 0) {
  for (const v of allViolations) {
    process.stderr.write(`${v}\n`);
  }
  process.stderr.write(`\ncheck-semantic-tokens: ${allViolations.length} violation(s) found\n`);
  process.exit(1);
} else {
  process.stderr.write("check-semantic-tokens: clean\n");
  process.exit(0);
}
