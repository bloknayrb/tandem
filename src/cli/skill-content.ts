/**
 * SKILL.md content installed to ~/.claude/skills/tandem/ by `tandem setup`.
 * Single source of truth lives at `skills/tandem/SKILL.md`. This module
 * reads that file at module load so the plugin install path and the
 * `tandem setup` install path always deliver byte-identical content.
 *
 * The file is shipped via package.json `files: ["skills/", ...]`, and the
 * CLI entry (dist/cli/index.js) is not self-contained — so at runtime the
 * relative path `../../skills/tandem/SKILL.md` resolves from either
 * dist/cli/ (tsx dev) or dist/cli/ (npm install) to the package-root
 * `skills/tandem/SKILL.md`.
 */
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SKILL_PATH = resolve(__dirname, "../../skills/tandem/SKILL.md");

export const SKILL_CONTENT = readFileSync(SKILL_PATH, "utf-8");
