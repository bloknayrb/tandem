import { readFileSync } from "node:fs";
import { join } from "node:path";
import { transform } from "lightningcss";
import { resolveConfig } from "vite";
import { beforeAll, describe, expect, it } from "vitest";

/**
 * Activity messages must have somewhere to break (#1269).
 *
 * The two surfaces that render a `TandemNotification.message` — the transient
 * `ToastContainer` card and the `ActivityTray` row it feeds — both put the text
 * in a flex item carrying `min-width: 0`. That permits the item to shrink below
 * its min-content width, and it is easy to read as "so it will never overflow".
 * It is not: shrinking is permitted, but the text still needs a BREAK
 * OPPORTUNITY, and several of the app's own messages end in a filesystem path
 * ("Claude restarting in C:\Users\…\com.tandem.editor\sample") which is one
 * unbroken word — no space, and `\` is not a break opportunity either.
 *
 * So the line rendered at full min-content width and left its box. The two
 * surfaces then failed differently, which is why the issue carries two
 * screenshots: the tray shell has `overflow: clip`, so the path was sheared
 * mid-character; the toast card does not clip, so the path simply ran out past
 * the rounded border.
 *
 * WHAT THIS TEST CAN AND CANNOT DO. No layout engine is available here —
 * happy-dom and jsdom do not lay out text, so the visual outcome is not
 * assertable in a unit test and is covered by the manual browser gate. What is
 * assertable, and what this pins, is that the declaration granting the break
 * opportunity is present in BOTH surfaces AND survives the real build. That
 * second half is not ceremony: component `<style>` blocks go through
 * lightningcss (see `css-pipeline-contract.test.ts`), which rewrites and drops
 * declarations it considers redundant for the configured `cssTarget`, so a
 * property that is correct in source is not automatically a property that ships.
 */

const ROOT = join(import.meta.dirname, "..", "..");

/** Both components that render a notification `message` string. */
const SURFACES = [
  {
    file: "src/client/components/ActivityTray.svelte",
    selector: ".toast-row .msg",
  },
  {
    file: "src/client/components/ToastContainer.svelte",
    selector: ".toast-card .msg",
  },
] as const;

/**
 * Values that let a line break INSIDE an otherwise unbreakable word. `normal`
 * and `break-spaces` are excluded deliberately — neither breaks a long path.
 */
const BREAKING_VALUES = ["anywhere", "break-word"];

const VITE_TARGET_MAP: Record<string, string | false> = {
  chrome: "chrome",
  edge: "edge",
  firefox: "firefox",
  hermes: false,
  ie: "ie",
  ios: "ios_saf",
  node: false,
  opera: "opera",
  rhino: false,
  safari: "safari",
};

/** Mirrors Vite's `convertTargets` (transcribed in css-pipeline-contract.test.ts). */
function convertTargets(cssTarget: string | string[]): Record<string, number> {
  const targets: Record<string, number> = {};
  for (const entry of [cssTarget].flat()) {
    const index = entry.search(/\d/);
    if (index < 0) throw new Error(`unparseable cssTarget entry: ${entry}`);
    const browser = VITE_TARGET_MAP[entry.slice(0, index)];
    if (browser === false) continue;
    if (!browser) throw new Error(`cssTarget entry not in Vite's map: ${entry}`);
    const [major, minor = 0] = entry
      .slice(index)
      .split(".")
      .map((v) => parseInt(v, 10));
    const version = (major << 16) | (minor << 8);
    if (!targets[browser] || version < targets[browser]) targets[browser] = version;
  }
  return targets;
}

let targets: Record<string, number>;

beforeAll(async () => {
  const config = await resolveConfig({ root: ROOT }, "build");
  expect(config.configFile, "resolveConfig must actually find vite.config.ts").toBeDefined();
  targets = convertTargets(config.build.cssTarget);
});

/** The component's `<style>` block, which is what the bundler compiles. */
function styleBlock(file: string): string {
  const source = readFileSync(join(ROOT, file), "utf-8");
  const m = source.match(/<style[^>]*>([\s\S]*?)<\/style>/);
  expect(m, `${file} has no <style> block`).toBeTruthy();
  return (m as RegExpMatchArray)[1];
}

/**
 * Strip Svelte's `:global` syntax, which lightningcss does not parse — the real
 * pipeline never sees it either, because the Svelte compiler resolves scoping
 * before handing CSS to the bundler. Both forms are in use here:
 * `:global(sel)` inline (ActivityTray) and a bare `:global { … }` wrapper around
 * an `@keyframes` (ToastContainer, which lightningcss rejects outright as an
 * unknown at-rule rather than warning).
 */
function stripSvelteGlobal(css: string): string {
  const inlineStripped = css.replace(/:global\(([^)]*)\)/g, "$1");
  let out = "";
  let i = 0;
  while (true) {
    const at = inlineStripped.indexOf(":global", i);
    if (at === -1) {
      out += inlineStripped.slice(i);
      return out;
    }
    const open = inlineStripped.indexOf("{", at);
    if (open === -1) {
      out += inlineStripped.slice(i);
      return out;
    }
    out += inlineStripped.slice(i, at);
    // Splice out the wrapper braces, keeping the block's contents in place.
    let depth = 0;
    let j = open;
    for (; j < inlineStripped.length; j++) {
      if (inlineStripped[j] === "{") depth++;
      else if (inlineStripped[j] === "}" && --depth === 0) break;
    }
    out += inlineStripped.slice(open + 1, j);
    i = j + 1;
  }
}

/** Minify exactly the way the real build's `minifyCSS` would. */
function minify(css: string, filename: string): string {
  const { code, warnings } = transform({
    // lightningcss keys its parser off the extension; a `.svelte` name makes it
    // reject `@keyframes`. The real build hands it plain CSS.
    filename: `${filename.replace(/[^a-z0-9]/gi, "-")}.css`,
    code: Buffer.from(stripSvelteGlobal(css)),
    minify: true,
    targets,
  });
  expect(warnings, `lightningcss warned while compiling ${filename}`).toEqual([]);
  return code.toString();
}

/**
 * The declaration block declared for `selector`, or null.
 *
 * The trailing boundary is load-bearing: `.toast-row .msg` is a prefix of
 * `.toast-row .msg-row`, which sits a few lines above it in the same file and
 * has no `overflow-wrap`. A prefix match reads that neighbour's body and
 * reports the property missing while it is right there.
 */
function ruleBody(css: string, selector: string): string | null {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "\\s+");
  const m = css.match(new RegExp(`(?:^|[};])[^{}]*${escaped}\\s*(?:,[^{}]*)?\\{([^}]*)\\}`));
  return m ? m[1] : null;
}

describe("notification messages can break inside a long path (#1269)", () => {
  it.each(SURFACES)("$selector declares a breaking overflow-wrap in source", ({
    file,
    selector,
  }) => {
    const css = styleBlock(file);
    const body = ruleBody(css, selector);
    expect(body, `${selector} rule not found in ${file}`).not.toBeNull();
    const value = (body as string).match(/overflow-wrap\s*:\s*([a-z-]+)/)?.[1];
    expect(
      value,
      `${selector} in ${file} has no overflow-wrap — a path with no space in it ` +
        `will render at full min-content width and leave the box`,
    ).toBeDefined();
    expect(BREAKING_VALUES).toContain(value);
  });

  it.each(SURFACES)("$selector keeps it through lightningcss", ({ file, selector }) => {
    const compiled = minify(styleBlock(file), file);
    const body = ruleBody(compiled, selector);
    expect(body, `${selector} rule vanished from the compiled CSS of ${file}`).not.toBeNull();
    const value = (body as string).match(/overflow-wrap\s*:\s*([a-z-]+)/)?.[1];
    expect(
      value,
      `${selector} lost its overflow-wrap during minification of ${file} — ` +
        `correct in source is not the same as shipped`,
    ).toBeDefined();
    expect(BREAKING_VALUES).toContain(value);
  });

  it("the extractor really reads these files (positive control)", () => {
    // Every assertion above would pass vacuously on an empty read. Pin something
    // that has been in both files since long before this change.
    for (const { file } of SURFACES) {
      expect(styleBlock(file)).toContain("--tandem-");
    }
  });
});
