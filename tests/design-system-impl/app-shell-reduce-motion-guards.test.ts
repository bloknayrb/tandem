import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { type CssRule, cssRulesBySelector, styleBlocks } from "../helpers/css-source";

/**
 * Reduce-motion guard coverage for `src/client/App.svelte` — and ONLY that file.
 *
 * #1425: two of App.svelte's `transition` rules (`.rail-tab`,
 * `.panel-edge-collapse`/`::before`) shipped with no reduce-motion guard, purely
 * because whoever wrote them didn't remember to add the pair every other motion
 * rule in this file carries. This file makes that omission loud instead of silent
 * by DERIVING the set of motion-bearing rules from source and requiring each to
 * be guarded, rather than hardcoding the selectors this fix happens to touch — an
 * enumeration seeded from a fix can never catch the NEXT unguarded rule, which is
 * exactly how App.svelte got here. `docs/design-system-impl/motion.md`'s
 * `prefers-reduced-motion` policy section documents the codebase-wide convention
 * this file pins one instance of.
 *
 * **Scope: App.svelte only.** The same convention is not pinned anywhere else in
 * the codebase. The #1425 audit that found this file's gaps also found gaps in
 * roughly ten other files — mixed guarded/unguarded properties inside one
 * shorthand, `@media`-only guards with no in-app `:global(body.tandem-reduce-motion)`
 * half, and one file whose own comment overstates its coverage. That backlog is
 * tracked in #1530, not here: folding it into this file would mean
 * either fixing all of it first or mislabeling real bugs as sanctioned exceptions.
 *
 * **Why this can't be a selector-existence check.** `resolveSelectors` in
 * `../helpers/css-source` deliberately treats `@media` as transparent (see its
 * doc comment), so a rule's resolved selector is identical whether it sits inside
 * `@media (prefers-reduced-motion: reduce)` or at the top level — a selector-only
 * scan cannot tell guarded from unguarded. And a helper that joins every matching
 * rule's body together (the shape `mode-toggle-thumb-contract.test.ts` uses for a
 * single-rule case) would find `transition: none` in ANY rule sharing the
 * selector, including a hypothetical guard with no `@media` wrapper at all — green
 * on a broken fix. This file reads each candidate guard rule's OWN `body`, gated
 * on its OWN `atRules`, using the two fields added to `CssRule` for exactly this.
 */

const ROOT = join(import.meta.dirname, "..", "..");
const APP_SVELTE = join(ROOT, "src", "client", "App.svelte");
const GLOBAL_TOGGLE = ":global(body.tandem-reduce-motion) ";

/**
 * The WHOLE at-rule chain a reduce-motion guard is allowed to sit under, anchored
 * end to end: `@media (prefers-reduced-motion: reduce)`, or the bare
 * `(prefers-reduced-motion)` form, and nothing else.
 *
 * Anchored-and-whole rather than a substring/`.some()` test because three
 * different inversions all satisfy the loose forms, and each was mutation-proved
 * during #1425 review:
 *
 * - VALUE: `.includes("prefers-reduced-motion")` matches the FEATURE NAME only,
 *   so `@media (prefers-reduced-motion: no-preference) { .rail-tab { transition:
 *   none } }` — the exact inverse of the intent, killing motion for users who did
 *   NOT ask for it and leaving it running for users who did — satisfies it.
 * - QUERY: a floating `/prefers-reduced-motion\s*(?::\s*reduce\s*)?\)/` fixes the
 *   value half but not this one. `@media not all and (prefers-reduced-motion:
 *   reduce)` is the SAME inversion written as a query negation, and the floating
 *   regex matches it happily — the reduce feature genuinely is in there, just
 *   negated.
 * - CHAIN: `atRules.some(...)` asks whether SOME enclosing at-rule mentions
 *   reduce, which is strictly weaker than "reduce is the only condition". A guard
 *   nested inside an unrelated restrictive query — `@media (min-width: 900px) {
 *   @media (prefers-reduced-motion: reduce) { … } }` — passes while leaving every
 *   narrow viewport unguarded.
 *
 * So the check is this anchored regex against a chain asserted to be length 1.
 */
const REDUCE_MOTION_QUERY = /^@media\s*\(\s*prefers-reduced-motion\s*(?::\s*reduce\s*)?\)$/;

/**
 * True only when `atRules` is a chain of exactly one at-rule and that at-rule is
 * an unnegated, unqualified reduce-motion query — i.e. the rule applies when the
 * user asks for reduced motion, and under no other condition.
 */
function isReduceMotionOnly(atRules: string[]): boolean {
  return atRules.length === 1 && REDUCE_MOTION_QUERY.test(atRules[0]);
}

const RULES = cssRulesBySelector(styleBlocks(APP_SVELTE));

type Decl = { prop: "transition" | "animation"; value: string };

/**
 * `rule.body`'s `transition`/`animation` declarations. Splitting on `;` is safe
 * here specifically because `cssRulesBySelector` re-serializes one declaration
 * per `; `-joined segment (see its doc comment) — postcss has already collapsed
 * each property (including comma-separated multi-value ones like
 * `transition: background 140ms ease, color 140ms ease`) into a single decl node,
 * so no value in this file contains a literal `;`.
 */
function motionDecls(body: string): Decl[] {
  return body
    .split(";")
    .map((s) => s.trim())
    .filter(Boolean)
    .flatMap((raw) => {
      const i = raw.indexOf(":");
      if (i === -1) return [];
      const prop = raw.slice(0, i).trim();
      const value = raw.slice(i + 1).trim();
      return prop === "transition" || prop === "animation" ? [{ prop, value } as Decl] : [];
    });
}

/**
 * A `none` motion declaration, in EITHER sanctioned form.
 *
 * `cssRulesBySelector` re-serializes `!important` back into the value (see its
 * `body` builder in `../helpers/css-source`), so an exact `=== "none"` compare
 * reads `transition: none !important` — the STRONGER form, and the one this
 * codebase already uses where a guard races a higher-specificity or inline rule
 * (`ActivityTray.svelte`, `status/StatusBar.svelte`) — as a real MOTION
 * declaration. That mis-read is wrong in both directions at once: the guard gets
 * counted as a motion target needing a guard of its own, and it simultaneously
 * stops satisfying the target it actually guards, so the failures point at the
 * wrong rule. Strip the flag before comparing. Mutation-proved during #1425
 * review; App.svelte's own new `.rail-tab` comment names `!important` as the
 * sanctioned shape for the racing case, so the next person following #1530 into
 * this file would have hit it.
 */
function isNone(value: string): boolean {
  return (
    value
      .replace(/\s*!important\s*$/i, "")
      .trim()
      .toLowerCase() === "none"
  );
}

/**
 * One real (non-`none`) motion declaration on one selector — the unit this file
 * requires to be guarded. A rule with a grouped selector list (the float-slide
 * rules below carry two selectors per rule) yields one target per selector,
 * since guard coverage is checked per selector.
 *
 * `selector` is the rule's RESOLVED selector (`fullSelectors`), never the
 * authored ancestor-relative one (`selectors`), and everything downstream —
 * `EXCEPTIONS`, `mediaGuardRule`, `globalGuardRule` — matches in the same
 * coordinate system. That choice is what makes this file's central claim true
 * rather than merely asserted. The claim is "the guard's specificity is
 * IDENTICAL to its target's, so source order decides", and only the resolved
 * selector can witness it: `selectors` is relative to an ancestor it does not
 * name, so two rules with the same `selectors` entry can have wildly different
 * specificity. Wrapping App.svelte's base `.rail-tab` rule in a
 * `.rail-tabs-track { … }` — an ordinary CSS-nesting tidy-up, which Svelte 5
 * accepts and lightningcss compiles — makes the base `(0,2,0)` while the
 * `@media` guard stays `(0,1,0)`, so the GUARD LOSES and OS-level reduced-motion
 * users get their motion back (the `:global(body.tandem-reduce-motion)` half
 * still wins, so exactly the half of the audience that never opened Settings
 * regresses). Under `selectors` that mutation is fully green; under
 * `fullSelectors` the guard simply stops being found for the now-`.rail-tabs-track
 * .rail-tab` target and the file reds. Mutation-proved during #1425 review (M12).
 * `../helpers/css-source`'s own doc comment warns about exactly this — it is how
 * a nesting rewrite defeated `mode-toggle-thumb-contract.test.ts`'s width gate.
 *
 * Matching resolved-to-resolved rather than banning nesting outright is
 * deliberate: nesting BOTH a rule and its guard under the same parent keeps their
 * specificities equal and the source-order argument sound, and that stays green.
 * Where the two forms disagree the disagreement always errs safe — a guard that
 * resolves differently from its target is reported missing rather than assumed
 * fine.
 */
type MotionTarget = { selector: string; prop: "transition" | "animation"; rule: CssRule };

const MOTION_TARGETS: MotionTarget[] = RULES.flatMap((rule) =>
  motionDecls(rule.body)
    .filter((d) => !isNone(d.value))
    .flatMap((d) => rule.fullSelectors.map((selector) => ({ selector, prop: d.prop, rule }))),
);

/**
 * The one place App.svelte's guard selector doesn't textually match what it
 * guards: the float-slide animations (#798) are declared on
 * `.rail-shell-{side}.{floating|float-closing} .rail-full-{side}` /
 * `.rail-float-shadow-{side}`, but the reduced-motion guard (~App.svelte:3642)
 * targets `.rail-shell.rail-floating-chrome .rail-full` / `.rail-float-shadow` —
 * a DIFFERENT selector that matches the SAME element only because the markup
 * puts both class sets on it at once. That's a fact about the markup, not the
 * CSS, so it's verified against the markup itself by the second `describe` below
 * — which fails if the two class sets are ever split onto different elements,
 * the thing that would actually break this guard (the CSS match is fine either
 * way, textually). Don't add an entry here without also adding or confirming its
 * markup proof below.
 *
 * `declared` and `guardedAs` are RESOLVED selectors (`fullSelectors`), the same
 * coordinate system `MOTION_TARGETS` and both guard lookups use — see the
 * `MotionTarget` doc comment. Every rule involved is top-level today, so the
 * resolved and authored forms coincide; if one is ever nested, the entry here
 * must be written as the resolved selector.
 */
const FLOAT_SLIDE_REASON =
  "the float-slide animation selector and its reduce-motion guard selector are " +
  "different strings that happen to match the same element, because the markup " +
  "applies both class sets to it at once — see the markup-verified describe block below";
const EXCEPTIONS: Array<{ declared: string; guardedAs: string; reason: string }> = [
  {
    declared: ".rail-shell-left.floating .rail-full-left",
    guardedAs: ".rail-shell.rail-floating-chrome .rail-full",
    reason: FLOAT_SLIDE_REASON,
  },
  {
    declared: ".rail-shell-left.floating .rail-float-shadow-left",
    guardedAs: ".rail-shell.rail-floating-chrome .rail-float-shadow",
    reason: FLOAT_SLIDE_REASON,
  },
  {
    declared: ".rail-shell-right.floating .rail-full-right",
    guardedAs: ".rail-shell.rail-floating-chrome .rail-full",
    reason: FLOAT_SLIDE_REASON,
  },
  {
    declared: ".rail-shell-right.floating .rail-float-shadow-right",
    guardedAs: ".rail-shell.rail-floating-chrome .rail-float-shadow",
    reason: FLOAT_SLIDE_REASON,
  },
  {
    declared: ".rail-shell-left.float-closing .rail-full-left",
    guardedAs: ".rail-shell.rail-floating-chrome .rail-full",
    reason: FLOAT_SLIDE_REASON,
  },
  {
    declared: ".rail-shell-left.float-closing .rail-float-shadow-left",
    guardedAs: ".rail-shell.rail-floating-chrome .rail-float-shadow",
    reason: FLOAT_SLIDE_REASON,
  },
  {
    declared: ".rail-shell-right.float-closing .rail-full-right",
    guardedAs: ".rail-shell.rail-floating-chrome .rail-full",
    reason: FLOAT_SLIDE_REASON,
  },
  {
    declared: ".rail-shell-right.float-closing .rail-float-shadow-right",
    guardedAs: ".rail-shell.rail-floating-chrome .rail-float-shadow",
    reason: FLOAT_SLIDE_REASON,
  },
];

function guardedSelectorFor(target: MotionTarget): string {
  return EXCEPTIONS.find((e) => e.declared === target.selector)?.guardedAs ?? target.selector;
}

/**
 * The `@media (prefers-reduced-motion: reduce)` rule declaring `${prop}: none`
 * for `guardedSelector`, or undefined. Reads each candidate rule's OWN `body` —
 * never a joined-body form — and gates on that rule's OWN `atRules` being exactly
 * a reduce-motion query (`isReduceMotionOnly`), so neither a `none` declared with
 * no `@media` wrapper at all (a broken "fix") nor one under a negated or
 * additionally-constrained query can satisfy this. Matches on `fullSelectors`,
 * for the reason given on `MotionTarget`.
 */
function mediaGuardRule(guardedSelector: string, prop: string): CssRule | undefined {
  return RULES.find(
    (r) =>
      isReduceMotionOnly(r.atRules) &&
      r.fullSelectors.includes(guardedSelector) &&
      motionDecls(r.body).some((d) => d.prop === prop && isNone(d.value)),
  );
}

function globalGuardRule(guardedSelector: string, prop: string): CssRule | undefined {
  const wanted = `${GLOBAL_TOGGLE}${guardedSelector}`;
  return RULES.find(
    (r) =>
      r.fullSelectors.includes(wanted) &&
      motionDecls(r.body).some((d) => d.prop === prop && isNone(d.value)),
  );
}

describe("App.svelte reduce-motion guard coverage (#1425)", () => {
  it(
    "finds the expected number of motion-bearing declarations — if this fails, " +
      "App.svelte gained or lost a transition/animation rule; guard the new one " +
      "(both the @media and :global(body.tandem-reduce-motion) halves, declared " +
      "AFTER it) or add it to EXCEPTIONS above with a markup proof, then update " +
      "this count",
    () => {
      expect(MOTION_TARGETS.length).toBe(14);
    },
  );

  it.each(
    MOTION_TARGETS.map((t) => [`${t.selector} (${t.prop})`, t] as const),
  )("%s is guarded by both halves, declared after the rule it guards", (_label, target) => {
    const guardedSelector = guardedSelectorFor(target);
    const media = mediaGuardRule(guardedSelector, target.prop);
    expect(
      media,
      `no \`@media (prefers-reduced-motion: reduce) { ${guardedSelector} { ${target.prop}: none } }\` rule ` +
        `found. Add one directly after \`${target.selector}\`'s own rule (source order matters here — see the ` +
        "comment on the `.rail-shell.dragging` rule for why identical specificity makes this load-bearing), " +
        `or if \`${target.selector}\` is guarded under a DIFFERENT selector, add an entry to EXCEPTIONS above ` +
        "with a markup proof in the describe block below.",
    ).toBeDefined();

    const global = globalGuardRule(guardedSelector, target.prop);
    expect(
      global,
      `no \`:global(body.tandem-reduce-motion) ${guardedSelector} { ${target.prop}: none }\` rule found — the ` +
        "in-app reduceMotion setting does nothing for this rule without it.",
    ).toBeDefined();

    if (media && global) {
      expect(
        media.start,
        `the @media guard for ${guardedSelector} must be declared AFTER the rule it guards — its specificity ` +
          "is identical (it was matched by RESOLVED selector, so same-selector really does mean " +
          "same-specificity, and an at-rule adds none), so it wins only by source order.",
      ).toBeGreaterThan(target.rule.start);
      expect(
        global.start,
        `the :global(body.tandem-reduce-motion) guard for ${guardedSelector} must be declared after the rule ` +
          "it guards.",
      ).toBeGreaterThan(target.rule.start);
    }
  });
});

describe("App.svelte reduce-motion guard coverage (#1425): the float-slide exception is markup-verified, not assumed", () => {
  const raw = readFileSync(APP_SVELTE, "utf-8");

  /**
   * The full `<div class="rail-shell rail-shell-{side}" ...>` opening tag's OWN
   * attribute list, not a wider slice. This is deliberately narrower than "the
   * rail block" below: `rail-floating-chrome`/`floating` must sit on THIS
   * element specifically, because that is what the reduced-motion guard selector
   * (`.rail-shell.rail-floating-chrome .rail-full`) requires — a compound
   * selector on one element, not a descendant relationship. A slice spanning the
   * whole block would still contain both strings if `rail-floating-chrome` moved
   * onto a CHILD (the `.rail-full`/`.rail-float-shadow` element two levels down
   * also appears inside that span), which is exactly the false pass a wider
   * slice produced during #1425 review: moving the class down still matched.
   *
   * The tag's closing `>` cannot be found with a bare `indexOf(">")` — several
   * attributes are arrow-function event handlers (`onmouseenter={() => ...}`),
   * and `=>` contains a `>` that isn't the tag's own. Depth-counting `{`/`}`
   * from the `<div` and only accepting a `>` at depth 0 skips those: every `=>`
   * in this markup lives inside a `{...}` attribute-expression, so it is never
   * seen at depth 0.
   */
  function shellOpenTag(classMarker: string): string {
    const classIdx = raw.indexOf(classMarker);
    expect(
      classIdx,
      `marker not found: \`${classMarker}\` — App.svelte's rail markup changed; re-verify the ` +
        "float-slide EXCEPTIONS entries above still hold and update this marker.",
    ).toBeGreaterThanOrEqual(0);
    const tagStart = raw.lastIndexOf("<div", classIdx);
    expect(
      tagStart,
      `no preceding \`<div\` found before \`${classMarker}\``,
    ).toBeGreaterThanOrEqual(0);
    let depth = 0;
    let i = tagStart;
    for (; i < raw.length; i++) {
      const c = raw[i];
      if (c === "{") depth++;
      else if (c === "}") depth--;
      else if (c === ">" && depth === 0) break;
    }
    expect(i, `no closing '>' found for the <div starting at offset ${tagStart}`).toBeLessThan(
      raw.length,
    );
    return raw.slice(tagStart, i + 1);
  }

  function slice(startMarker: string, endMarker: string): string {
    const start = raw.indexOf(startMarker);
    expect(
      start,
      `marker not found: \`${startMarker}\` — App.svelte's rail markup changed; re-verify the float-slide ` +
        "EXCEPTIONS entries above still hold (do the animated child and the `rail-floating-chrome`/`floating` " +
        "classes still land on the same element?) and update this marker.",
    ).toBeGreaterThanOrEqual(0);
    const end = raw.indexOf(endMarker, start);
    expect(end, `marker not found after \`${startMarker}\`: \`${endMarker}\``).toBeGreaterThan(
      start,
    );
    return raw.slice(start, end);
  }

  it("left rail: rail-floating-chrome/floating are on the shell element's OWN tag, not a descendant", () => {
    const shellTag = shellOpenTag('class="rail-shell rail-shell-left"');
    expect(
      shellTag,
      "the left rail-shell's own opening tag no longer sets `class:rail-floating-chrome` — the " +
        "float-slide EXCEPTIONS entries above assume this class, ON THIS ELEMENT, drives the guard " +
        "selector `.rail-shell.rail-floating-chrome .rail-full`. Finding it on a descendant instead " +
        "does not satisfy that compound selector.",
    ).toContain("class:rail-floating-chrome=");
    expect(shellTag).toContain("class:floating=");
  });

  it("left rail: rail-full-left/rail-float-shadow-left are descendants of that shell", () => {
    const block = slice('class="rail-shell rail-shell-left"', '{@render resizeHandle("left"');
    expect(
      block,
      "`.rail-float-shadow-left` no longer appears inside the left rail-shell block — the float-slide " +
        "exception assumes it's a descendant of the element carrying `rail-floating-chrome`.",
    ).toContain('class="rail-float-shadow rail-float-shadow-left"');
    expect(block).toContain('class="rail-full rail-full-left"');
  });

  it("right rail: rail-floating-chrome/floating are on the shell element's OWN tag, not a descendant", () => {
    const shellTag = shellOpenTag('class="rail-shell rail-shell-right"');
    expect(
      shellTag,
      "the right rail-shell's own opening tag no longer sets `class:rail-floating-chrome` — the " +
        "float-slide EXCEPTIONS entries above assume this class, ON THIS ELEMENT, drives the guard " +
        "selector `.rail-shell.rail-floating-chrome .rail-full`. Finding it on a descendant instead " +
        "does not satisfy that compound selector.",
    ).toContain("class:rail-floating-chrome=");
    expect(shellTag).toContain("class:floating=");
  });

  it("right rail: rail-full-right/rail-float-shadow-right are descendants of that shell", () => {
    const block = slice('class="rail-shell rail-shell-right"', '{@render edgeCollapse("right"');
    expect(
      block,
      "`.rail-float-shadow-right` no longer appears inside the right rail-shell block — the float-slide " +
        "exception assumes it's a descendant of the element carrying `rail-floating-chrome`.",
    ).toContain('class="rail-float-shadow rail-float-shadow-right"');
    expect(block).toContain('class="rail-full rail-full-right"');
  });
});

describe("App.svelte reduce-motion guard coverage (#1425): inline `style` attributes are invisible to the derived scan above", () => {
  const raw = readFileSync(APP_SVELTE, "utf-8");

  /**
   * `styleBlocks()` — the extractor `MOTION_TARGETS` above is built on — reads
   * `<style>` blocks only, by contract (see its own doc comment). An inline
   * `style="…"` / `style={\`…\`}` attribute is therefore structurally OUTSIDE
   * everything asserted above: a `transition`/`animation` written there cannot
   * be found, guarded, or counted by any of it. This is not hypothetical — it
   * is exactly how `.editor-scroll`'s crossfade shipped unguarded in the first
   * place (moved into a stylesheet rule by this same PR) and the identical
   * shape #1396 hit for the rail drag strip
   * (`rail-clearance-contract.test.ts:93-99` pins that one the same way this
   * block does). So this file needs its OWN, separate scan of raw markup — the
   * derived test above cannot be extended to cover this, only supplemented.
   *
   * A `style={` value can nest `${...}` JS interpolations with their own
   * braces (e.g. `` style={`width: ${x}px;`} ``), so the closing brace is found
   * by depth-counting brace characters, not by the first `}`.
   */
  function inlineStyleValues(src: string): string[] {
    const values: string[] = [];
    const re = /style=("|\{)/g;
    let m: RegExpExecArray | null = re.exec(src);
    while (m) {
      if (m[1] === '"') {
        const openedAt = m.index + m[0].length;
        const close = src.indexOf('"', openedAt);
        values.push(src.slice(openedAt, close));
        re.lastIndex = close + 1;
      } else {
        // `style={` is COMMONLY — not always — followed by a template-literal
        // backtick (`` style={`...`} ``). Of the 16 occurrences in this file
        // today, three are not: two ternaries whose backtick sits after the
        // condition (`` style={cond ? `width: …` : ""} ``, ~2587/2649) and one
        // bare member expression (`style={editorStage.layerStyle}`, ~3192; see
        // the JS-builder block below, which is what covers that shape). A
        // leading backtick, where present, is not itself CSS text and must not
        // become the first character of the extracted value — it would defeat
        // the offender scan's `(?:^|[;\s])` anchor below, since
        // `` `transition: … `` neither starts with nor is preceded by a
        // separator before the literal word "transition". So skip exactly one
        // leading backtick IF present and leave every other shape alone;
        // depth-counting for the matching `}` still starts at the `{` itself; a
        // trailing backtick (if any) is harmless left in the extracted value
        // since nothing here anchors on end-of-string.
        let depth = 1;
        let i = m.index + m[0].length;
        const valueStart = src[i] === "`" ? i + 1 : i;
        while (depth > 0 && i < src.length) {
          if (src[i] === "{") depth++;
          else if (src[i] === "}") depth--;
          i++;
        }
        values.push(src.slice(valueStart, i - 1));
        re.lastIndex = i;
      }
      m = re.exec(src);
    }
    return values;
  }

  const values = inlineStyleValues(raw);

  // Guarded first, matching rail-clearance-contract.test.ts:87-90's discipline:
  // if the scanner ever desyncs from App.svelte's attribute-quoting style and
  // starts matching nothing, every assertion below passes VACUOUSLY. This is
  // the corpus-sweep half of that pattern (css-source.test.ts's "the extractor
  // still reads what this repo authors" describe block uses the same shape).
  it("finds inline style attributes to scan — a count of zero means the scanner desynced from App.svelte's markup", () => {
    expect(values.length).toBeGreaterThan(0);
  });

  it("declares no transition/animation in any inline style attribute written as literal CSS", () => {
    const offenders = values.filter((v) => /(?:^|[;\s])(?:transition|animation)\s*:/.test(v));
    expect(
      offenders,
      "an inline `style` attribute is structurally unreachable by any stylesheet rule (#1396), " +
        "including every reduce-motion guard above — they all read <style> blocks only. If the " +
        "duration is STATIC, move the declaration into a stylesheet rule and guard THAT (see " +
        "`.editor-scroll`'s fix, #1425, and docs/design-system-impl/motion.md's " +
        "`prefers-reduced-motion` policy section); only a genuinely DYNAMIC (JS-computed) duration " +
        "needs token-zeroing (morphTiming.css/tabDragMotion.css) instead.",
    ).toEqual([]);
  });

  /**
   * The scan above is titled "written as literal CSS" for a reason, and this is
   * the other half. It reads each `style={…}` occurrence's EXPRESSION SOURCE
   * TEXT, which for `` style={`width: ${x}px`} `` and for a ternary over two
   * literals IS the CSS — but for `style={someIdentifier}` is just a variable
   * name. A `transition` the expression PRODUCES at runtime is invisible to it,
   * and would be exactly as unreachable by every guard above as
   * `.editor-scroll`'s inline crossfade was before this PR moved it into a rule.
   *
   * So each such occurrence is pinned to the module that builds its string, and
   * that module is scanned directly. `editorStage.layerStyle` is the only one
   * today (App.svelte ~3192); it comes from `stageLayerStyle()`, which emits
   * custom properties plus `display`/`grid-template-columns` and no motion — a
   * fact about THAT file, which is why it is asserted here rather than asserted
   * in a comment.
   */
  const JS_BUILT_INLINE_STYLES: Array<{ expression: string; builder: string }> = [
    {
      expression: "editorStage.layerStyle",
      builder: join(ROOT, "src", "client", "layout", "editor-stage.svelte.ts"),
    },
  ];

  it("pins every `style={identifier}` occurrence to the module that builds its CSS", () => {
    const found = [
      ...raw.matchAll(/style=\{\s*([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)\s*\}/g),
    ].map((m) => m[1]);
    expect(
      [...new Set(found)].sort(),
      "App.svelte gained (or lost) a `style={someExpression}` whose value is built in JS. The " +
        "literal-CSS sweep above scans the expression's SOURCE TEXT, so it cannot see a " +
        "transition/animation the expression produces at runtime. Add the expression to " +
        "JS_BUILT_INLINE_STYLES with the module that builds its string, so the assertion below " +
        "scans that module too — otherwise the declaration is unguardable AND unnoticed.",
    ).toEqual([...JS_BUILT_INLINE_STYLES.map((e) => e.expression)].sort());
  });

  it.each(
    JS_BUILT_INLINE_STYLES.map((e) => [e.expression, e] as const),
  )("%s's builder module declares no transition/animation", (_label, entry) => {
    // Comments stripped first so prose can neither satisfy nor trip the scan:
    // block comments wholesale, and `//` comments only where one OPENS a line,
    // which never touches a `//` inside a string (a URL, say) and so cannot
    // hide a real declaration.
    const src = readFileSync(entry.builder, "utf-8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^[ \t]*\/\/.*$/gm, "");
    const offenders = [
      ...src.matchAll(/(?:^|[;\s"'`])((?:transition|animation)\s*:[^;\n`"']*)/g),
    ].map((m) => m[1].trim());
    expect(
      offenders,
      `\`${entry.expression}\` is written into an inline \`style\` attribute in App.svelte, and ` +
        "an inline style is structurally unreachable by every reduce-motion guard in this file " +
        "(#1396, #1425). A motion declaration emitted from here is therefore unguardable where it " +
        "lands. Move it into a stylesheet rule and guard THAT, or — if the timing is genuinely " +
        "JS-computed — use token-zeroing (morphTiming.css/tabDragMotion.css) and record it here.",
    ).toEqual([]);
  });
});
