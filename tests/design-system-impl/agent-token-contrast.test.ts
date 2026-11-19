import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import postcss from "postcss";
import { describe, expect, it } from "vitest";
import { agentColor } from "../../src/client/utils/agent-color";
import type { ModelProvider } from "../../src/shared/models/contract";
import type { AgentIdentity } from "../../src/shared/types";
import { stripCssComments } from "../helpers/css-source";

/**
 * ADR-039 item 20, read over both local-model agent tokens (#1123): every place
 * `--tandem-agent-local-ollama` / `--tandem-agent-local-llamacpp` colours TEXT
 * reaches 4.5:1 against the ground it sits on, and every place they colour a
 * non-text mark reaches 3:1 — in the light, warm and dark themes.
 *
 * Why a Node test rather than only the canvas-measured E2E sweep
 * (`tests/e2e/token-contrast.spec.ts`, which carries the plain-surface pairs
 * too): the chat bubble's ground is `color-mix(in srgb, <agent> 10%, surface)`,
 * a mix of the very token being measured, which no `--tandem-*` variable names,
 * so the E2E `add(fgVar, bgVar)` shape cannot express it. And this runs in
 * `check` on every PR, where the E2E suite needs a browser.
 *
 * The values are read from `index.html`'s inline `<style>` (emitted verbatim,
 * so its text is the shipped truth). The resolver understands exactly what
 * these tokens and grounds are written in — `oklch(L C h)`, `#rrggbb`,
 * `var(--x)` and `color-mix(in srgb, A p%, B)` — and THROWS on anything else,
 * so a token rewritten into a form it cannot read fails here instead of being
 * skipped (the E2E sweep's `add()` silently skips an unresolved token).
 *
 * OKLCH → sRGB is Björn Ottosson's matrices, each channel clipped to [0, 1]
 * after gamma encoding (what a browser does for an out-of-gamut colour, to
 * within its gamut-mapping refinements). WCAG 2.x relative luminance and ratio.
 */

const ROOT = join(import.meta.dirname, "..", "..");
const INDEX_HTML = readFileSync(join(ROOT, "index.html"), "utf-8");

// ---------------------------------------------------------------------------
// Token blocks
// ---------------------------------------------------------------------------

type Block = Map<string, string>;

function themeBlocks(): { root: Block; dark: Block; warm: Block } {
  const css = [...INDEX_HTML.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)]
    .map((m) => stripCssComments(m[1]))
    .join("\n");
  const ast = postcss.parse(css);
  const wanted: Record<string, Block | undefined> = {
    ":root": undefined,
    '[data-theme="dark"]': undefined,
    '[data-theme="warm"]': undefined,
  };
  ast.walkRules((rule) => {
    // Top-level rules only: the forced-colors block's `:root, [data-theme="dark"]`
    // sits inside @media and must not be read as a theme.
    if (rule.parent?.type !== "root") return;
    if (!(rule.selector in wanted)) return;
    if (wanted[rule.selector])
      throw new Error(`two top-level ${rule.selector} blocks in index.html`);
    const block: Block = new Map();
    rule.walkDecls((d) => {
      if (d.prop.startsWith("--")) block.set(d.prop, d.value.trim());
    });
    wanted[rule.selector] = block;
  });
  const root = wanted[":root"];
  const dark = wanted['[data-theme="dark"]'];
  const warm = wanted['[data-theme="warm"]'];
  if (!root || !dark || !warm) throw new Error("index.html is missing a :root, dark or warm block");
  return { root, dark, warm };
}

const BLOCKS = themeBlocks();
const THEMES = {
  light: [BLOCKS.root],
  // The dark and warm blocks override :root; anything they omit inherits it.
  dark: [BLOCKS.dark, BLOCKS.root],
  warm: [BLOCKS.warm, BLOCKS.root],
} as const;
type Theme = keyof typeof THEMES;

// ---------------------------------------------------------------------------
// Colour maths
// ---------------------------------------------------------------------------

type Rgb = [number, number, number]; // gamma-encoded sRGB, 0..1

const clip = (x: number) => Math.min(1, Math.max(0, x));
const toGamma = (c: number) => (c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055);
const toLinear = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);

function oklchToSrgb(L: number, C: number, hDeg: number): Rgb {
  const h = (hDeg * Math.PI) / 180;
  const a = C * Math.cos(h);
  const b = C * Math.sin(h);
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ].map((v) => clip(toGamma(v))) as Rgb;
}

function luminance(c: Rgb): number {
  const [r, g, b] = c.map(toLinear);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(a: Rgb, b: Rgb): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

/** `color-mix(in srgb, A p%, B)`: a straight mix of the gamma-encoded channels. */
const mixSrgb = (a: Rgb, p: number, b: Rgb): Rgb => a.map((v, i) => v * p + b[i] * (1 - p)) as Rgb;

// ---------------------------------------------------------------------------
// Resolver — throws on anything it does not understand
// ---------------------------------------------------------------------------

function lookup(theme: Theme, name: string): string {
  for (const block of THEMES[theme]) {
    const v = block.get(name);
    if (v !== undefined) return v;
  }
  throw new Error(`${name} is not declared for the ${theme} theme`);
}

/** Substitute every `var(--x)` inside a value (for hue vars inside `oklch()`). */
function substitute(theme: Theme, value: string, depth = 0): string {
  if (depth > 8) throw new Error(`var() cycle resolving ${value}`);
  const next = value.replace(/var\((--[a-z0-9-]+)\)/g, (_m, n: string) => lookup(theme, n));
  return next === value ? value : substitute(theme, next, depth + 1);
}

function parseColor(theme: Theme, raw: string): Rgb {
  const value = substitute(theme, raw).trim();
  let m = /^oklch\(\s*([\d.]+)\s+([\d.]+)\s+([\d.]+)(?:deg)?\s*\)$/.exec(value);
  if (m) return oklchToSrgb(Number(m[1]), Number(m[2]), Number(m[3]));
  m = /^#([0-9a-f]{6})$/i.exec(value);
  if (m) return [0, 2, 4].map((i) => Number.parseInt(m![1].slice(i, i + 2), 16) / 255) as Rgb;
  m = /^color-mix\(\s*in srgb\s*,\s*(.+?)\s+([\d.]+)%\s*,\s*(.+)\)$/.exec(value);
  if (m) return mixSrgb(parseColor(theme, m[1]), Number(m[2]) / 100, parseColor(theme, m[3]));
  throw new Error(`cannot parse colour value "${raw}" (resolved "${value}") for ${theme}`);
}

const token = (theme: Theme, name: string): Rgb => parseColor(theme, lookup(theme, name));

// ---------------------------------------------------------------------------
// The tokens under test, read from the one module that maps providers to them
// ---------------------------------------------------------------------------

const LOCAL_PROVIDERS: ModelProvider[] = [
  "local-ollama",
  "local-llamacpp",
  "local-lmstudio",
  "local-other",
];

function varName(css: string): string {
  const m = /^var\((--[a-z0-9-]+)\)$/.exec(css);
  if (!m) throw new Error(`agentColor returned ${css}, not a bare var()`);
  return m[1];
}

const LOCAL_TOKENS = [
  ...new Set(
    LOCAL_PROVIDERS.map((provider) =>
      varName(agentColor({ provider, modelId: "m", displayName: "m" } as unknown as AgentIdentity)),
    ),
  ),
];

// ---------------------------------------------------------------------------
// Where they are painted. Kept in step with the consumer inventory below.
// ---------------------------------------------------------------------------

type Ground = { name: string; rgb: (theme: Theme, fg: Rgb) => Rgb };
const plain = (t: string): Ground => ({ name: t, rgb: (theme) => token(theme, t) });

/**
 * TEXT, 4.5:1.
 *  - Chat author label (`ChatPanel.svelte`, `chat-author-*`) on the identified
 *    bubble, whose ground is `color-mix(in srgb, <agent> 10%, --tandem-surface)`.
 *  - Reply byline (`CommentThread.svelte` `.ct-author`, pinned in
 *    `reply-thread.test.ts`) on the annotation card it renders inside. The card
 *    is tinted by its ROOT author (`getCardTint`): claude, user or import
 *    (a promoted import keeps its ground), or `--tandem-accent-bg` while it is
 *    the review target. A local model can reply on any of them.
 *  - `--tandem-bg` and `--tandem-surface`: the panel grounds those sit on,
 *    included as a margin so a later consumer on a plain panel is covered.
 */
const TEXT_GROUNDS: Ground[] = [
  {
    name: "chat bubble (agent 10% over surface)",
    rgb: (theme, fg) => mixSrgb(fg, 0.1, token(theme, "--tandem-surface")),
  },
  plain("--tandem-author-claude-bg"),
  plain("--tandem-author-user-bg"),
  plain("--tandem-author-import-bg"),
  plain("--tandem-accent-bg"),
  plain("--tandem-surface"),
  plain("--tandem-bg"),
];

/**
 * NON-TEXT, 3:1 (SC 1.4.11). Card-header dot and note ring and the reply's dot
 * (on the card tints, covered above at 4.5 already); peek-strip dot (rail,
 * `--tandem-surface-muted`); margin leader and decoration underline (the page:
 * `--tandem-page-paper`, and `--tandem-page-bg` around it).
 */
const NON_TEXT_GROUNDS: Ground[] = [
  plain("--tandem-surface-muted"),
  plain("--tandem-page-paper"),
  plain("--tandem-page-bg"),
];

const THEME_NAMES: Theme[] = ["light", "warm", "dark"];

describe("local agent tokens are readable (ADR-039 item 20)", () => {
  it("covers both local tokens", () => {
    expect(LOCAL_TOKENS.sort()).toEqual([
      "--tandem-agent-local-llamacpp",
      "--tandem-agent-local-ollama",
    ]);
  });

  const rows: Array<[string, Theme, string, number]> = [];
  for (const theme of THEME_NAMES)
    for (const t of LOCAL_TOKENS) {
      for (const g of TEXT_GROUNDS) rows.push([t, theme, g.name, 4.5]);
      for (const g of NON_TEXT_GROUNDS) rows.push([t, theme, g.name, 3]);
    }

  const grounds = new Map([...TEXT_GROUNDS, ...NON_TEXT_GROUNDS].map((g) => [g.name, g]));

  it.each(rows)("%s in %s on %s reaches %s:1", (tokenName, theme, groundName, min) => {
    const fg = token(theme, tokenName);
    const bg = grounds.get(groundName)!.rgb(theme, fg);
    const ratio = contrast(fg, bg);
    expect(
      Number(ratio.toFixed(2)),
      `${tokenName} on ${groundName} (${theme}) is ${ratio.toFixed(2)}:1`,
    ).toBeGreaterThanOrEqual(min);
  });

  it("the resolver refuses a value it cannot read", () => {
    expect(() => parseColor("light", "rgb(1 2 3)")).toThrow(/cannot parse/);
    expect(() => parseColor("light", "var(--tandem-no-such-token)")).toThrow(/not declared/);
  });

  it("the converter agrees with known sRGB anchors", () => {
    const white = oklchToSrgb(1, 0, 0);
    expect(white.map((v) => Number(v.toFixed(3)))).toEqual([1, 1, 1]);
    // oklch(0.627955 0.257683 29.2339) is sRGB red.
    const red = oklchToSrgb(0.627955, 0.257683, 29.2339);
    expect(red.map((v) => Number(v.toFixed(2)))).toEqual([1, 0, 0]);
    expect(Number(contrast([0, 0, 0], [1, 1, 1]).toFixed(1))).toBe(21);
  });

  it("high contrast does not override the agent tokens; forced colours map them to CanvasText", () => {
    const hc = /\[data-high-contrast="true"\]\s*\{([^}]*)\}/.exec(INDEX_HTML)?.[1] ?? "";
    expect(hc).not.toContain("--tandem-agent-local");
    const forced = /@media \(forced-colors: active\)\s*\{([\s\S]*?)\n {6}\}/.exec(INDEX_HTML)?.[1];
    expect(forced, "forced-colors block not found").toBeTruthy();
    for (const t of LOCAL_TOKENS) expect(forced).toMatch(new RegExp(`${t}: CanvasText;`));
  });
});

// ---------------------------------------------------------------------------
// Consumer inventory: the grounds above are only as good as this list.
// ---------------------------------------------------------------------------

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) sourceFiles(p, out);
    else if (/\.(svelte|ts)$/.test(name)) out.push(p);
  }
  return out;
}

describe("agent colour consumers (ADR-039 item 20 inventory)", () => {
  it("every reader of the local tokens is one this file measures", () => {
    const files = sourceFiles(join(ROOT, "src", "client"));
    const callers = files
      .filter((f) => /\bagent(Tint)?Color\(/.test(stripCssComments(readFileSync(f, "utf-8"))))
      .map((f) => relative(ROOT, f).replace(/\\/g, "/"))
      .filter((f) => f !== "src/client/utils/agent-color.ts")
      .sort();
    // A new file here is a new place an agent colour is painted: decide whether
    // it is text or non-text, add its ground above, then add it to this list.
    expect(callers).toEqual([
      "src/client/editor/extensions/annotation.ts", // underline (non-text, page)
      "src/client/panels/AnnotationCardHeader.svelte", // dot + note ring (non-text, card)
      "src/client/panels/ChatPanel.svelte", // author label (text, bubble)
      "src/client/panels/CommentThread.svelte", // reply byline (text, card) + dot
      "src/client/panels/PeekStrip.svelte", // dot (non-text, rail)
      "src/client/panels/marginLeaderGeometry.ts", // leader (non-text, page)
    ]);
    const direct = files
      .filter((f) => readFileSync(f, "utf-8").includes("--tandem-agent-local-"))
      .map((f) => relative(ROOT, f).replace(/\\/g, "/"));
    expect(direct, "the local tokens are read only through agent-color.ts").toEqual([
      "src/client/utils/agent-color.ts",
    ]);
  });
});
