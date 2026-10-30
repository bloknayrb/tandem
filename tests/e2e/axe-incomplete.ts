/**
 * The pure half of #1721's handling of axe's `color-contrast` **incomplete**
 * nodes: the per-surface count ceiling, and the per-node verdict that measures
 * each such node without axe. Why axe leaves nodes incomplete, and the waiver
 * table, are on `behindModalScrim` in `accessibility.spec.ts`, kept there so the
 * history has one home; the page-side sampler is `sampleIncompleteNodes` in
 * `axe-incomplete-sampler.ts`.
 *
 * Not a `.spec.ts`/`.test.ts`: Playwright's default `testMatch` under
 * `testDir: "tests/e2e"` must not collect it, and neither must vitest's node
 * project. It imports nothing, so it resolves into either program.
 */

export type AxeBucketEntry = { id: string; nodes: unknown[] };

/** Nodes of the `color-contrast` entry in an axe bucket; `0` when absent. */
export function colorContrastNodeCount(entries: AxeBucketEntry[]): number {
  return entries.find((e) => e.id === "color-contrast")?.nodes.length ?? 0;
}

/**
 * `null` when `observed` is within the committed ceiling, else a message.
 *
 * `context` is appended to that message verbatim. The ceiling has no headroom by
 * design (padding an unexplained number is what the baseline file forbids), so
 * the first question on a red is always "did the environment move or did the UI
 * move?" — the caller passes the browser it seeded on and the browser it is
 * running on so that question is answered in the failure text rather than by a
 * bisect under merge pressure. It never changes the verdict: a message-only
 * argument cannot make a passing run fail or a failing one pass.
 *
 * Fails CLOSED on a key with no baseline row: a surface added to `SURFACES`
 * must be measured, not silently unmeasured — an unmeasured surface is the same
 * gap this issue is about, and `check` would stay green over it forever.
 */
export function checkIncompleteBaseline(
  key: string,
  observed: number,
  baseline: Record<string, number>,
  context = "",
): string | null {
  const suffix = context ? ` ${context}` : "";
  const limit = baseline[key];
  if (typeof limit !== "number") {
    return `${key}: no baseline row (observed ${observed}). Measure this surface and commit its count to tests/e2e/axe-incomplete-baseline.json.${suffix}`;
  }
  if (observed <= limit) return null;
  return `${key}: ${observed} color-contrast incomplete nodes, baseline ${limit}. Something changed what axe cannot evaluate on this surface — investigate before re-seeding.${suffix}`;
}

// ---------------------------------------------------------------------------
// Per-node resolution (#1721, options 1/2)
// ---------------------------------------------------------------------------

/** sRGB 0-255 channels, alpha 0-1. */
export type Rgba = [number, number, number, number];

/**
 * What the page reports about one node axe left `incomplete`: everything the
 * contrast arithmetic needs, gathered from computed style, plus the reasons that
 * arithmetic cannot be trusted for this node.
 */
export type IncompleteNodeSample = {
  /** axe's selector for the node. */
  target: string;
  /** axe's own reason for giving up (`nonBmp`, `bgOverlap`, …). */
  messageKey: string | null;
  text: string;
  /** Computed `color`, resolved through a canvas so `oklch()` reads correctly. */
  fg: Rgba;
  /** Root → node: each element's background colour and its own `opacity`. */
  layers: Array<{ bg: Rgba; opacity: number }>;
  fontSizePx: number;
  fontWeight: number;
  /** Why the layer arithmetic would describe something other than the screen. */
  unresolvable: string[];
  /**
   * The opaque element painted over the WHOLE text, when there is one — the
   * text is not on screen, so there is no contrast to measure. A background
   * control under an open popover is the case this names.
   */
  coveredBy: string | null;
  /**
   * A waiver key's node half: nearest `data-testid` ancestor, tag, classes
   * minus Svelte's hashed scope class, and the text. axe's own selector carries
   * those hashes, so keying on it would orphan a waiver on any style edit.
   */
  descriptor: string;
};

/** Porter-Duff source-over, straight (non-premultiplied) alpha. */
export function compositeOver(src: Rgba, dst: Rgba): Rgba {
  const a = src[3] + dst[3] * (1 - src[3]);
  if (a === 0) return [0, 0, 0, 0];
  const ch = (i: 0 | 1 | 2) => (src[i] * src[3] + dst[i] * dst[3] * (1 - src[3])) / a;
  return [ch(0), ch(1), ch(2), a];
}

const CANVAS: Rgba = [255, 255, 255, 1];

/**
 * The two pixels a reader compares: a glyph pixel and the ground beside it.
 *
 * `opacity` makes each ancestor a GROUP — its subtree is painted, then the
 * whole result is faded onto what lies beneath — so a faded ancestor fades the
 * text and its own background together, not the text alone. Multiplying the
 * opacities into the text alpha is the shortcut this deliberately avoids: it
 * is wrong whenever a faded ancestor paints its own background.
 */
export function paintedPair(sample: Pick<IncompleteNodeSample, "fg" | "layers">): {
  text: Rgba;
  ground: Rgba;
} {
  const flatten = (withText: boolean): Rgba => {
    let group: Rgba | null = null;
    for (let i = sample.layers.length - 1; i >= 0; i--) {
      const { bg, opacity } = sample.layers[i];
      let g: Rgba = bg;
      if (group) g = compositeOver(group, g);
      else if (withText) g = compositeOver(sample.fg, g);
      group = [g[0], g[1], g[2], g[3] * opacity];
    }
    return compositeOver(group ?? [0, 0, 0, 0], CANVAS);
  };
  return { text: flatten(true), ground: flatten(false) };
}

function luminance([r, g, b]: Rgba): number {
  const f = (c: number) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}

/** WCAG 2.x contrast ratio, unrounded — what a threshold is compared against. */
function rawContrastRatio(a: Rgba, b: Rgba): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

/**
 * WCAG 2.x contrast ratio rounded to two places, for display only. Never
 * compare a threshold against it: 4.496:1 rounds to 4.5 and would pass a 4.5:1
 * bar it misses.
 */
export function contrastRatio(a: Rgba, b: Rgba): number {
  return Math.round(rawContrastRatio(a, b) * 100) / 100;
}

/**
 * The ratio a node owes.
 *
 * - 3:1 for large text (SC 1.4.3: ≥ 24px, or ≥ 18.66px at bold).
 * - 3:1 for text made only of pictographic symbols — `▾`, `⇅`, `↵`, `●`. These are
 *   symbols drawn with a font, i.e. graphical objects, so SC 1.4.11's 3:1 is
 *   the criterion that applies, not 1.4.3's 4.5:1. This is the bucket axe
 *   reports as `nonBmp`, and it is NOT an exemption: a glyph below 3:1 fails.
 * - 4.5:1 for everything else, including one-letter text such as the B/I/S
 *   toolbar buttons axe reports as `shortTextContent` — a letter is text.
 */
export function requiredRatio(
  sample: Pick<IncompleteNodeSample, "text" | "fontSizePx" | "fontWeight">,
): number {
  if (sample.fontSizePx >= 24 || (sample.fontSizePx >= 18.66 && sample.fontWeight >= 700)) {
    return 3;
  }
  // Pictographic symbols only: Unicode So (▾ ● ⇅ ↵ ⇧) plus the Arrows block,
  // where ↑ and ↓ are classed Sm. The rest of Sm (`+`, `×`, `=`), punctuation
  // and empty text keep 4.5 — those read as text, and when unsure the
  // stricter bar wins.
  if (/^[\p{So}\u2190-\u21FF\s]+$/u.test(sample.text) && sample.text.trim() !== "") return 3;
  return 4.5;
}

const rgb = (c: Rgba) => `rgb(${c.slice(0, 3).map(Math.round).join(",")})`;

/**
 * A keyed exemption for a node computed style cannot measure. `expect` must
 * match EVERY reason the sampler gave: a new reason appearing on a waived node
 * (a background image added later, say) is a new question, not the old one.
 */
export type IncompleteWaiver = { reason: string; expect: RegExp };

export type NodeVerdict =
  | { kind: "measured"; ratio: number; required: number }
  | { kind: "covered"; by: string }
  | { kind: "waived"; reason: string }
  | { kind: "failure"; message: string };

/**
 * Turn one `incomplete` node into a pass, a keyed waiver, or a failure.
 *
 * Fails CLOSED twice: a node the arithmetic cannot describe (`unresolvable` is
 * non-empty) is a failure unless a waiver names it, and so is one that
 * measures below what it owes. A waiver can only excuse the former — it never
 * excuses a node that measured and failed, because then the waiver would be
 * the gate.
 */
export function assessIncompleteNode(
  key: string,
  sample: IncompleteNodeSample,
  waiver: IncompleteWaiver | undefined,
): NodeVerdict {
  const where = `${key}: ${sample.descriptor} (axe: ${sample.messageKey ?? "no messageKey"})`;
  if (sample.coveredBy) return { kind: "covered", by: sample.coveredBy };
  if (sample.unresolvable.length > 0) {
    // `lastIndex = 0`: one RegExp is shared by several waivers and every theme,
    // and a `g`/`y` flag would otherwise make `test` alternate between calls.
    const covers = (r: string) => {
      if (!waiver) return false;
      waiver.expect.lastIndex = 0;
      return waiver.expect.test(r);
    };
    const unexpected = sample.unresolvable.filter((r) => !covers(r));
    if (waiver && unexpected.length === 0) return { kind: "waived", reason: waiver.reason };
    return {
      kind: "failure",
      message: `${where} cannot be measured from computed style (${unexpected.join("; ")})${waiver ? " — reasons its waiver does not cover" : ""}. Measure it another way or add a keyed waiver with its reason.`,
    };
  }
  const { text, ground } = paintedPair(sample);
  const ratio = contrastRatio(text, ground);
  const required = requiredRatio(sample);
  const raw = rawContrastRatio(text, ground);
  if (raw < required) {
    // Truncated, as axe reports it, so a near miss never prints as "4.5:1, needs 4.5:1".
    return {
      kind: "failure",
      message: `${where} measures ${Math.floor(raw * 100) / 100}:1, needs ${required}:1 (text ${rgb(text)} on ${rgb(ground)}).`,
    };
  }
  return { kind: "measured", ratio, required };
}

/** axe's own reason for leaving a node incomplete, from its `any` checks. */
export function incompleteMessageKey(node: { any: Array<{ data?: unknown }> }): string | null {
  for (const check of node.any) {
    const key = (check.data as { messageKey?: unknown } | null | undefined)?.messageKey;
    if (typeof key === "string") return key;
  }
  return null;
}

/**
 * Waivers that excused nothing in this run. A waiver counts as used only when
 * it produced a `waived` verdict — merely matching a node that then measured is
 * the rot mode, because the waiver outlives its reason.
 */
export function staleWaivers(
  waivers: Record<string, IncompleteWaiver>,
  used: ReadonlySet<string>,
): string[] {
  return Object.keys(waivers).filter((k) => !used.has(k));
}

/** One log line's worth of a verdict. */
export function describeVerdict(v: NodeVerdict): string {
  switch (v.kind) {
    case "measured":
      return `${v.ratio}:1 ≥ ${v.required}:1`;
    case "covered":
      return `covered by ${v.by}`;
    case "waived":
      return `waived — ${v.reason}`;
    case "failure":
      return v.message;
  }
}
