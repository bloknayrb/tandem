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
  [
    "src/client/components/ModelEditModal.svelte",
    ["mem-local-intro", "mem-hint", "mem-unavailable"],
  ],
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

const MUTED = /color\s*:\s*var\(--tandem-fg-muted\)/i;

/** The component source with its `<style>` blocks cut out (by position, not
 *  a regex replace: this is a test reading its own repo's source, never
 *  sanitising HTML). An unclosed block cuts to the end. */
function withoutStyleBlocks(source: string): string {
  let out = "";
  let at = 0;
  for (let open = source.indexOf("<style", at); open !== -1; open = source.indexOf("<style", at)) {
    out += source.slice(at, open);
    const close = source.indexOf("</style>", open);
    if (close === -1) return out;
    at = close + "</style>".length;
  }
  return out + source.slice(at);
}

/** The element opening at `start` through its matching close tag (same-name
 *  nesting counted); the open tag alone when it is self-closing. */
function elementSource(markup: string, start: number, tag: string): string {
  const open = markup.slice(start, markup.indexOf(">", start) + 1);
  if (open.endsWith("/>")) return open;
  const re = new RegExp(`<(/?)${tag}\\b[^>]*>`, "g");
  re.lastIndex = start + open.length;
  let depth = 1;
  for (let m = re.exec(markup); m; m = re.exec(markup)) {
    if (m[0].endsWith("/>")) continue;
    depth += m[1] ? -1 : 1;
    if (depth === 0) return markup.slice(start, m.index + m[0].length);
  }
  throw new Error(`no close tag for <${tag}> at ${start}`);
}

const hasClass = (selector: string, cls: string) =>
  new RegExp(`\\.${cls}(?![\\w-])`).test(selector);

describe("R4.4: the local-model hints use --tandem-fg-muted", () => {
  for (const [file, classes] of CASES) {
    const source = read(file);
    const all = rules(source);
    for (const cls of classes) {
      it(`${file}: .${cls} sets color: var(--tandem-fg-muted), and every rule naming it that sets a color uses that token`, () => {
        const own = all.filter((r) => r.selector.split(",").some((s) => s.trim() === `.${cls}`));
        expect(own.length).toBeGreaterThan(0);
        expect(own.some((r) => MUTED.test(r.body))).toBe(true);
        // A later rule for the same class (or a descendant) cannot override it
        // with any other colour.
        for (const r of all.filter((x) => hasClass(x.selector, cls))) {
          for (const decl of r.body.match(/(?:^|[;\s])color\s*:[^;]*/gi) ?? []) {
            expect(decl.trim().replace(/^;/, "").trim(), r.selector).toMatch(MUTED);
          }
        }
      });

      it(`${file}: no rule naming .${cls} (descendants included) uses --tandem-fg-subtle`, () => {
        const touching = all.filter((r) => hasClass(r.selector, cls));
        expect(touching.length).toBeGreaterThan(0);
        for (const r of touching) expect(r.body, r.selector).not.toContain("--tandem-fg-subtle");
      });

      // Finds the class in `class="…"`, `class={…}` and `class:${cls}`
      // forms (any tag naming the class as a whole word), and checks each such
      // element's whole subtree up to its matching close tag, so a child's
      // inline style (the <p>s inside .mem-local-intro) is covered too. The
      // limit: a class added from script (`classList`, a computed string not
      // naming it literally) is not seen; none exists in these components.
      it(`${file}: no element with class ${cls}, or inside one, carries an inline --tandem-fg-subtle`, () => {
        const markup = withoutStyleBlocks(source);
        const word = new RegExp(`(?<![\\w-])${cls}(?![\\w-])`);
        const opens = [...markup.matchAll(/<([a-zA-Z][\w-]*)\b[^>]*>/g)].filter(
          (m) => /\bclass[=:]/.test(m[0]) && word.test(m[0]),
        );
        expect(opens.length).toBeGreaterThan(0);
        for (const m of opens) {
          const subtree = elementSource(markup, m.index ?? 0, m[1]);
          expect(subtree, `<${m[1]}> with .${cls}`).not.toContain("--tandem-fg-subtle");
        }
      });
    }
  }
});
