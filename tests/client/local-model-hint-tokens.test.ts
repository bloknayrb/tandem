/**
 * #1123, the test-hardening PR, R4.4: the local-model copy in the edit modal
 * (S1/S2 block, S3 hint) and the first-run picker (S3 hint) uses
 * `--tandem-fg-muted`, as the Models tab's `models-local-intro` does for the
 * same sentences — never `--tandem-fg-subtle`, which forced colours map to
 * `GrayText` (the disabled-text colour). A source pin: no layout in happy-dom.
 */
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = path.resolve(import.meta.dirname, "../..");
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), "utf8").replace(/\r\n/g, "\n");

const CASES: Array<[string, string[]]> = [
  ["src/client/components/ModelEditModal.svelte", ["mem-local-intro", "mem-hint"]],
  ["src/client/components/FirstRunModelPickerModal.svelte", ["frm-hint"]],
];

/** Every `selector { body }` rule in the file's <style> blocks (no nesting). */
function rules(source: string): Array<{ selector: string; body: string }> {
  const css = [...source.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)].map((m) => m[1]).join("\n");
  const noComments = css.replace(/\/\*[\s\S]*?\*\//g, "");
  return [...noComments.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((m) => ({
    selector: m[1].trim(),
    body: m[2],
  }));
}

const hasClass = (selector: string, cls: string) =>
  new RegExp(`\\.${cls}(?![\\w-])`).test(selector);

describe("R4.4: the local-model hints use --tandem-fg-muted", () => {
  for (const [file, classes] of CASES) {
    const source = read(file);
    const all = rules(source);
    for (const cls of classes) {
      it(`${file}: .${cls} sets color: var(--tandem-fg-muted)`, () => {
        const own = all.filter((r) => r.selector.split(",").some((s) => s.trim() === `.${cls}`));
        expect(own.length).toBeGreaterThan(0);
        expect(own.some((r) => /(^|;|\s)color:\s*var\(--tandem-fg-muted\)/.test(r.body))).toBe(
          true,
        );
      });

      it(`${file}: no rule naming .${cls} (descendants included) uses --tandem-fg-subtle`, () => {
        const touching = all.filter((r) => hasClass(r.selector, cls));
        expect(touching.length).toBeGreaterThan(0);
        for (const r of touching) expect(r.body, r.selector).not.toContain("--tandem-fg-subtle");
      });

      it(`${file}: no element with class ${cls} carries an inline --tandem-fg-subtle`, () => {
        const tags = [...source.matchAll(/<[a-zA-Z][^>]*>/g)].map((m) => m[0]);
        const withClass = tags.filter((t) =>
          new RegExp(`class="[^"]*(?<![\\w-])${cls}(?![\\w-])`).test(t),
        );
        expect(withClass.length).toBeGreaterThan(0);
        for (const t of withClass) expect(t).not.toContain("--tandem-fg-subtle");
      });
    }
  }
});
