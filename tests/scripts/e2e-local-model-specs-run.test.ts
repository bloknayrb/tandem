import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The four local-model E2E specs run in `check` now that local models are on
 * (#1123, ADR-039's amendment 2026-11-20 on the flip). While local models were
 * dark they were skipped at file level and run only by the temporary
 * `byo-flag-on` job, whose anchor refused a skipped file. The flip deleted that
 * job, its anchor and the skips, so without this pin a `test.skip` or a flag
 * guard could return to one of these files and `check` would stay green while
 * the spec ran nothing.
 *
 * Text checks on the source, flag-neutral. A positive anchor (each file exists
 * and declares at least one `test(`) keeps an emptied or renamed file from
 * passing by having nothing to object to.
 */
const SPECS = [
  "agent-identity.spec.ts",
  "chat-answerer.spec.ts",
  "local-model-chat.spec.ts",
  "settings-models.spec.ts",
] as const;

const E2E_DIR = join(__dirname, "..", "e2e");

/** Source with line and block comments removed, so prose about skips is not a skip. */
function code(file: string): string {
  return readFileSync(join(E2E_DIR, file), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
}

describe("the formerly gated local-model E2E specs run in check (#1123)", () => {
  it.each(SPECS)("%s exists and declares at least one test", (file) => {
    expect(code(file)).toMatch(/\btest\(/);
  });

  it.each(SPECS)("%s has no skip, fixme or only", (file) => {
    const src = code(file);
    expect(src).not.toMatch(/\btest(?:\.describe)?\.skip\(/);
    expect(src).not.toMatch(/\btest(?:\.describe)?\.fixme\(/);
    expect(src).not.toMatch(/\.only\(/);
  });

  it.each(SPECS)("%s does not import BYO_MODELS_ENABLED", (file) => {
    expect(code(file)).not.toMatch(/\bBYO_MODELS_ENABLED\b/);
  });

  it("the checks see a skip, a fixme, an only and the flag (positive control)", () => {
    const planted = [
      'test.skip(!X, "y");',
      "test.describe.fixme('x', () => {});",
      "test.only('x', async () => {});",
      'import { BYO_MODELS_ENABLED } from "../../src/shared/constants";',
    ];
    expect(planted[0]).toMatch(/\btest(?:\.describe)?\.skip\(/);
    expect(planted[1]).toMatch(/\btest(?:\.describe)?\.fixme\(/);
    expect(planted[2]).toMatch(/\.only\(/);
    expect(planted[3]).toMatch(/\bBYO_MODELS_ENABLED\b/);
  });
});
