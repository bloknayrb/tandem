/**
 * Every OK/Cancel question in the client goes through `confirmDialog`
 * (`src/client/utils/confirm.ts`), never `window.confirm` or a bare `confirm`.
 *
 * In the desktop app `tauri-plugin-dialog` replaces `window.confirm` with an
 * async function, so `if (!confirm(msg)) return;` sees a Promise — always
 * truthy — and runs the guarded action before the user has answered: a
 * scratchpad with unsaved content closed before its "Close it anyway?" dialog
 * appeared, and Cancel did nothing. The browser's synchronous `confirm` hid
 * this from every test.
 *
 * eslint enforces the same rule for `.ts` files; it does not parse `.svelte`,
 * so this scan covers both. Comments are stripped first (several explain the
 * hazard by naming `confirm()`).
 */
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../src/client");
const HELPER = path.join(ROOT, "utils", "confirm.ts");

const RAW_CONFIRM =
  /(?<![\w.$])confirm\s*\(|\bwindow\s*\.\s*confirm\b|\bglobalThis\s*\.\s*confirm\b/;

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(full);
    return /\.(ts|svelte)$/.test(entry.name) ? [full] : [];
  });
}

// Drops `<!-- -->`, `/* */` and `//` comments (a `//` after `:` is kept, so a
// URL survives) by walking the text once. A scanner rather than chained regex
// replaces: the output only feeds the scan below, never HTML, but CodeQL reads
// a replace-based stripper as an incomplete HTML sanitizer.
function stripComments(source: string): string {
  let out = "";
  let i = 0;
  while (i < source.length) {
    if (source.startsWith("<!--", i)) {
      const end = source.indexOf("-->", i + 4);
      i = end === -1 ? source.length : end + 3;
    } else if (source.startsWith("/*", i)) {
      const end = source.indexOf("*/", i + 2);
      i = end === -1 ? source.length : end + 2;
    } else if (source.startsWith("//", i) && source[i - 1] !== ":") {
      const end = source.indexOf("\n", i);
      i = end === -1 ? source.length : end;
    } else {
      out += source[i];
      i += 1;
    }
  }
  return out;
}

describe("confirm dialogs go through confirmDialog", () => {
  it("the scan sees the one sanctioned call (positive control)", () => {
    expect(RAW_CONFIRM.test(stripComments(readFileSync(HELPER, "utf8")))).toBe(true);
  });

  it("no other client file calls window.confirm or a bare confirm", () => {
    const offenders = sourceFiles(ROOT)
      .filter((file) => file !== HELPER)
      .filter((file) => RAW_CONFIRM.test(stripComments(readFileSync(file, "utf8"))))
      .map((file) => path.relative(ROOT, file));
    expect(offenders).toEqual([]);
  });
});
