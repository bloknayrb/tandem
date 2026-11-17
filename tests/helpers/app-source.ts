/**
 * `src/client/App.svelte` with its comments stripped, for the source pins that
 * stand in for mounting App (nothing mounts it in tests; see
 * `cowork-ship-dark.test.ts`). #2433 M2.
 *
 * Markup comments are cut by an `indexOf` loop, never a regex or a `.replace`
 * over `"<!--"` (CodeQL's incomplete multi-character sanitization rule): find
 * `<!--`, find the next `-->` from four characters on (as Svelte's parser
 * reads it, so `<!-->` does not close itself), cut. An opener with no closer
 * strips to the end of the file. Then script comments: `/* … *\/` blocks and
 * whole-line `//` comments (a trailing `//` on a code line is left; a `/*`
 * inside a script string would be read as a comment). Each strip runs over
 * the whole file: a `<!--` inside a script string or `//` comment would cut
 * to the next `-->`, and markup text such as `accept="image/*"` would start a
 * block strip. These limits are listed in the pin files' headers.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect } from "vitest";

export function stripAppComments(src: string): string {
  let out = "";
  let from = 0;
  for (;;) {
    const open = src.indexOf("<!--", from);
    if (open === -1) {
      out += src.slice(from);
      break;
    }
    out += src.slice(from, open);
    const close = src.indexOf("-->", open + 4);
    if (close === -1) break;
    from = close + 3;
  }
  return out.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

/** App.svelte, comment-stripped. */
export function readAppSource(): string {
  return stripAppComments(
    readFileSync(join(import.meta.dirname, "../../src/client/App.svelte"), "utf8"),
  );
}

/**
 * The chat panel's mount: from the `<PanelSlot` that opens it to the first
 * `/>` after `kind="chat"`. A self-closing child or an attribute containing
 * `/>` would cut it short.
 */
export function chatMount(app: string): string {
  const kind = app.indexOf('kind="chat"');
  expect(kind, "App mounts a chat PanelSlot").toBeGreaterThan(-1);
  const start = app.lastIndexOf("<PanelSlot", kind);
  expect(start, 'kind="chat" sits on a PanelSlot').toBeGreaterThan(-1);
  const end = app.indexOf("/>", kind);
  expect(end, "the chat mount closes").toBeGreaterThan(-1);
  return app.slice(start, end);
}
