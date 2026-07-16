import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { transform } from "lightningcss";
import { resolveConfig } from "vite";
import { beforeAll, describe, expect, it } from "vitest";

/**
 * CSS pipeline contract.
 *
 * `backdrop-filter-guard.test.ts` next door asserts our *source* stays clear of a known
 * footgun. This file asserts the *toolchain assumption underneath that rule* — i.e. that
 * writing the standard property alone is still the safe thing to do. If lightningcss or
 * Vite's baseline ever drifts, that advice silently stops being true and macOS loses its
 * `-webkit-` prefix with nothing to say so. These gates make that drift loud.
 *
 * Two facts drive everything here (both measured against the real toolchain, #1188):
 *
 *  1. **There are two CSS pipelines.** `index.html`'s inline `<style>` is emitted verbatim
 *     — no minification, no autoprefixing (its comments survive into `dist/` intact).
 *     Component `<style>` blocks and `src/client/**\/*.css` go through lightningcss
 *     (`cssMinify: true` falls through to it — see Vite's `minifyCSS`). The same CSS text
 *     therefore compiles differently depending on which file it lives in. That asymmetry —
 *     not the collapse alone — is what shipped the #1189 blur: the recipe's blur survived
 *     verbatim in index.html while the component's reset was collapsed away.
 *
 *  2. **In bundled CSS, hand-writing a vendor prefix is what breaks it.** lightningcss is
 *     an autoprefixer; a hand-written pair fights it. For `backdrop-filter` it collapses
 *     the pair to the `-webkit-` form ALONE, which Chromium does not implement — so the
 *     declaration goes inert. Writing the standard property by itself is correct AND gets
 *     the prefix added for Safari automatically.
 *
 * The rule is deliberately not "never hand-write a prefix": `-webkit-line-clamp` is
 * REQUIRED (lightningcss won't add it), and index.html gets no autoprefixing at all, so
 * prefixes there must be hand-written. Both are pinned below so the rule can't be
 * over-generalised into a blanket ban that breaks shipped UI.
 */

const ROOT = join(import.meta.dirname, "..", "..");
const CLIENT_ROOT = join(ROOT, "src", "client");

/**
 * Vite's own esbuild-name -> lightningcss-key table, transcribed from
 * `vite/dist/node/chunks/node.js` (`const map = {...}`, beside `convertTargets`).
 *
 * Do NOT hand-roll this and do NOT route through `browserslist` (not a dependency here).
 * `ios` -> `ios_saf` is the entry that bites: `browserslistToTargets(["ios 16.4"])` yields
 * an `ios` key, which lightningcss **silently ignores** — no error, no warning, and the
 * desktop `safari` entry masks the difference, so the whole iOS axis can be wrong forever
 * while every assertion here stays green. `assertHonouredKeys` exists for exactly that.
 */
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

/** Keys lightningcss actually honours (`lightningcss/node/targets.d.ts`). */
const LIGHTNINGCSS_KEYS = new Set([
  "android",
  "chrome",
  "edge",
  "firefox",
  "ie",
  "ios_saf",
  "opera",
  "safari",
  "samsung",
]);

type Targets = Record<string, number>;

/** Mirrors Vite's `convertTargets`: name via the map, version as `major << 16 | minor << 8`. */
function convertTargets(cssTarget: string | string[]): Targets {
  const targets: Targets = {};
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

let targets: Targets;

beforeAll(async () => {
  // `root` must be explicit. Resolved from any other cwd, Vite finds no config file and
  // silently returns its DEFAULT cssTarget — which is byte-identical to ours today, since
  // we don't override it. So a missing config would go unnoticed without the assertion in
  // "reads Tandem's real Vite config" below.
  const config = await resolveConfig({ root: ROOT }, "build");
  expect(config.configFile, "resolveConfig must actually find vite.config.ts").toBeDefined();
  targets = convertTargets(config.build.cssTarget);
});

/** Minify one snippet exactly the way the real build's `minifyCSS` would. */
function minify(css: string): string {
  const { code, warnings } = transform({
    filename: "probe.css",
    code: Buffer.from(css),
    minify: true,
    targets,
  });
  // The draft version of this file ignored warnings; a reviewer pointed out that feeding
  // lightningcss something it flags is how you end up asserting against a facsimile.
  expect(warnings, `lightningcss warned on: ${css}`).toEqual([]);
  return code.toString();
}

const declares = (css: string, prop: string) => new RegExp(`[;{]\\s*${prop}\\s*:`).test(css);

describe("the Vite CSS target our authoring rule depends on", () => {
  it("reads Tandem's real Vite config", () => {
    // Guards the beforeAll assertion above from being silently skipped.
    expect(Object.keys(targets).length).toBeGreaterThan(0);
  });

  it("converts every target to a key lightningcss actually honours", () => {
    // The silent-failure gate. An unhonoured key (e.g. `ios` instead of `ios_saf`) is
    // dropped by lightningcss without complaint, so this would otherwise be invisible.
    const unhonoured = Object.keys(targets).filter((k) => !LIGHTNINGCSS_KEYS.has(k));
    expect(unhonoured).toEqual([]);
  });
});

describe("bundled CSS: hand-written vendor pairs keep their standard property", () => {
  it("survives lightningcss in BOTH declaration orders, for every property we pair", () => {
    const pairs = handWrittenPairs();

    // A zero here would pass vacuously. That is not hypothetical: the first prototype of
    // this scan returned 0 pairs while 12 existed (a mangled regex), and looked green.
    expect(
      pairs.length,
      "no hand-written vendor pairs found — extractor desynced?",
    ).toBeGreaterThan(0);

    const dropped: string[] = [];
    for (const { prop, value, where } of pairs) {
      // Order is the load-bearing variable, not the value: `backdrop-filter` collapses only
      // when the -webkit- form comes LAST. Probing one order would report green on the very
      // bug this exists to catch, so probe both and let order stop being a hidden variable.
      for (const css of [
        `.probe{${prop}:${value};-webkit-${prop}:${value}}`,
        `.probe{-webkit-${prop}:${value};${prop}:${value}}`,
      ]) {
        if (!declares(minify(css), prop)) dropped.push(`${where}: ${prop} (${css})`);
      }
    }
    expect(dropped).toEqual([]);
  });
});

describe("bundled CSS: writing the standard property alone is still the safe advice", () => {
  it("autoprefixes backdrop-filter for Safari when written alone", () => {
    // This is what makes "write the standard property, never the pair" correct rather than
    // merely tidy. If Vite's baseline ever moves past safari16.4 this fails, and macOS
    // WKWebView silently losing its prefix becomes a decision instead of an accident.
    const out = minify(".probe{backdrop-filter:blur(8px)}");
    expect(out).toContain("-webkit-backdrop-filter");
    expect(declares(out, "backdrop-filter")).toBe(true);
  });

  it("collapses a hand-written backdrop-filter pair to the inert -webkit- form", () => {
    // The #1189 bug, pinned. Chromium never implemented -webkit-backdrop-filter, so the
    // surviving declaration does nothing there and a scoped reset evaporates.
    // If this ever stops being true, the ban next door can be relaxed — this failing is
    // good news, not a regression.
    const out = minify(".probe{backdrop-filter:none;-webkit-backdrop-filter:none}");
    expect(declares(out, "backdrop-filter")).toBe(false);
  });

  it("does NOT add -webkit-line-clamp, so that pair must stay hand-written", () => {
    // The live counterexample that stops the rule above becoming a blanket "no prefixes"
    // ban. This pins WHY the hand-written pair is required; the gate that protects the
    // actual declaration is the source rule below.
    expect(minify(".probe{line-clamp:1}")).not.toContain("-webkit-line-clamp");
  });

  it("keeps the hand-written -webkit-line-clamp everywhere we clamp", () => {
    // The mirror image of the backdrop-filter ban, and the other half of the contract:
    // there the pair is forbidden (lightningcss adds it), here it is MANDATORY
    // (lightningcss won't). Chromium only implements the prefixed form, so a rule that
    // clamps without it silently stops clamping.
    //
    // This exists because the synthetic fixture above does not guard our source: deleting
    // AnnotationCard's declaration failed nothing until this gate was added.
    const missing = bundledCssFiles(CLIENT_ROOT).flatMap((file) =>
      [...styleBlocks(file).matchAll(/([^{}]+)\{([^{}]*)\}/g)]
        .filter(([, , body]) => /(^|[;\s])line-clamp\s*:/.test(body))
        .filter(([, , body]) => !/-webkit-line-clamp\s*:/.test(body))
        .map(([, selector]) => `${relative(ROOT, file).replace(/\\/g, "/")}: ${selector.trim()}`),
    );
    expect(missing).toEqual([]);
  });
});

/** Every `.svelte` `<style>` / `.css` file whose CSS the build routes through lightningcss. */
function bundledCssFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) bundledCssFiles(full, out);
    else if (full.endsWith(".svelte") || full.endsWith(".css")) out.push(full);
  }
  return out;
}

function stripCssComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, "");
}

function styleBlocks(file: string): string {
  const src = readFileSync(file, "utf-8");
  if (file.endsWith(".css")) return stripCssComments(src);
  return stripCssComments(
    [...src.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)].map((m) => m[1]).join("\n"),
  );
}

/**
 * Every rule body in bundled CSS that hand-writes both `-webkit-X` and `X`.
 *
 * Scoped to rule *bodies* on purpose. `scroll-fade.css`'s
 * `@supports (mask-image: ...) or (-webkit-mask-image: ...)` mentions both spellings in its
 * *condition* while declaring nothing — an occurrence-based scan counts it as a 13th pair
 * and reports a number that is simply wrong. (It is also why the probes below are synthetic:
 * 4 of these rules sit behind Svelte's `:global(...)`, which the real build strips before
 * lightningcss sees it. Feeding raw source selectors would make lightningcss warn on a
 * selector that never reaches it in production. Safe because the collapse is a property of
 * the declaration block, independent of selector and of any @media/@supports/@keyframes
 * wrapper — verified in #1188.)
 */
function handWrittenPairs(): { prop: string; value: string; where: string }[] {
  const found = new Map<string, { prop: string; value: string; where: string }>();
  for (const file of bundledCssFiles(CLIENT_ROOT)) {
    const css = styleBlocks(file);
    for (const rule of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      const body = rule[2];
      for (const decl of body.matchAll(/-webkit-([a-z-]+)\s*:\s*([^;}]+)/g)) {
        const prop = decl[1];
        if (found.has(prop)) continue;
        if (!new RegExp(`(^|[;\\s])${prop}\\s*:`).test(body)) continue;
        found.set(prop, {
          prop,
          value: decl[2].trim().replace(/\s+/g, " "),
          where: relative(ROOT, file).replace(/\\/g, "/"),
        });
      }
    }
  }
  return [...found.values()];
}
