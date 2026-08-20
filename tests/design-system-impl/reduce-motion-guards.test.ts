import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import {
  type CssRule,
  cssRulesBySelector,
  neutralizeSvelteGlobal,
  styleBlocks,
} from "../helpers/css-source";

/**
 * Reduce-motion guard coverage across the WHOLE client, generalizing
 * `app-shell-reduce-motion-guards.test.ts` (which pins `App.svelte` alone).
 *
 * #1425 pinned one file and recorded that roughly ten others had the same gaps;
 * #1530 is that backlog. Its own doc comment explains why it could not simply be
 * widened at the time: "folding it into this file would mean either fixing all of
 * it first or mislabeling real bugs as sanctioned exceptions." #1530 fixed all of
 * it, so this file is the widening — and it exists so the NEXT unguarded rule
 * fails a test instead of shipping. Both are derived scans, never enumerations of
 * the selectors a fix happened to touch: an enumeration seeded from a fix can
 * only ever catch the bug that is already fixed.
 *
 * `docs/design-system-impl/motion.md`'s `prefers-reduced-motion` policy section
 * is the convention this file pins. Two mechanisms, both required, because Tandem
 * ships an in-app reduced-motion toggle independent of the OS setting:
 * `@media (prefers-reduced-motion: reduce)` and `body.tandem-reduce-motion`
 * (`:global(...)`-wrapped in a `.svelte` file, bare in a plain stylesheet).
 *
 * ## Why this file and the App.svelte one both exist
 *
 * `App.svelte` is deliberately EXCLUDED here — see `APP_SVELTE` below. Its eight
 * float-slide rules are guarded under a different selector that matches the same
 * element only because of a fact about the markup, and that fact is proved
 * against the markup by a second `describe` block over there. Re-deriving that
 * proof here would duplicate ~120 lines to reach the same verdict. The exclusion
 * is asserted, not assumed: if that file ever disappears, the test below reds
 * rather than quietly leaving the largest stylesheet in the client unscanned.
 */

const ROOT = join(import.meta.dirname, "..", "..");
const CLIENT = join(ROOT, "src", "client");
const APP_SVELTE = join(CLIENT, "App.svelte");
const APP_SVELTE_TEST = join(import.meta.dirname, "app-shell-reduce-motion-guards.test.ts");
const GLOBAL_TOGGLE = "body.tandem-reduce-motion";

/** `.svelte` and `.css` under `src/client/`, plus `index.html`, minus App.svelte. */
function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) walk(p, out);
    else if (/\.(svelte|css)$/.test(entry.name) && p !== APP_SVELTE) out.push(p);
  }
  return out;
}
const FILES = [...walk(CLIENT), join(ROOT, "index.html")].sort();
/**
 * A repo-relative path in POSIX separators — the coordinate system every
 * hardcoded key in this file (`EXCEPTIONS[].file`, `INLINE_ALLOWLIST`) is
 * written in, and the one `it.each` titles are read in.
 *
 * The normalization is load-bearing, not cosmetic. `node:path.relative` returns
 * BACKSLASHES on Windows, so without it `exceptionFor()` and
 * `INLINE_ALLOWLIST.get()` never match there: ActivityTray's three `!important`
 * guards and StatusBar's two allowlisted inline declarations are all present and
 * correct, and this file failed four times anyway. On Linux CI the separators
 * agree, so it is green there and red on every Windows machine — which, because
 * the pre-push hook runs the full vitest suite, blocked Windows developers from
 * pushing anything at all.
 *
 * Normalizing HERE rather than at each comparison is deliberate: every
 * path-as-key flows through this one function, so there is no second site to
 * forget. The mirror of the `path.basename` gotcha in CLAUDE.md, and the same
 * `.replace(/\\/g, "/")` idiom `testid-coverage`, `css-pipeline-contract` and
 * `ydoc-import-ceiling` already use.
 */
const rel = (f: string) => relative(ROOT, f).replace(/\\/g, "/");

/**
 * See `app-shell-reduce-motion-guards.test.ts` for the three inversions this
 * anchored-and-whole form rules out that a substring or floating-regex form does
 * not (a `no-preference` value, a `not all and (...)` query negation, and an
 * extra restrictive condition in the chain). All three were mutation-proved
 * during #1425 review; the shape is copied here unchanged.
 */
const REDUCE_MOTION_QUERY = /^@media\s*\(\s*prefers-reduced-motion\s*(?::\s*reduce\s*)?\)$/;

/**
 * The chain rule, which is where this file has to be MORE permissive than the
 * App.svelte one — and precisely more permissive, not merely looser.
 *
 * That file requires the guard's at-rule chain to be exactly one reduce-motion
 * query, because a guard nested under an unrelated restrictive query (say
 * `@media (min-width: 900px)`) leaves every other viewport unguarded. But a
 * motion rule can itself live inside a media query — `SettingsModal.svelte`'s
 * `.settings-modal-sidebar` only becomes a slide-in drawer under
 * `@media (max-width: 860px)`, and only declares a `transition` there — and its
 * guard then MUST inherit that same condition. Placed outside it, the guard
 * would fire at every width and kill motion that should still run on wide
 * screens; and the length-1 rule would reject the correct nesting outright.
 *
 * So the requirement is relative rather than absolute: the guard's chain must be
 * the TARGET's chain plus exactly one reduce-motion query, and nothing else.
 * When the target is at the top level this collapses to the length-1 rule, so
 * the three inversions above stay rejected — an extra `min-width` in the guard's
 * chain that the target does not share still fails.
 */
function isReduceMotionGuardOf(guardChain: string[], targetChain: string[]): boolean {
  if (guardChain.length !== targetChain.length + 1) return false;
  const idx = guardChain.findIndex((a) => REDUCE_MOTION_QUERY.test(a));
  if (idx === -1) return false;
  const rest = [...guardChain.slice(0, idx), ...guardChain.slice(idx + 1)];
  return rest.length === targetChain.length && rest.every((a, i) => a === targetChain[i]);
}

/** The `:global` half wins by the body class, not by a query — so it must sit
 * under exactly the conditions its target does, no more and no fewer. */
function sameChain(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((x, i) => x === b[i]);
}

type Decl = { prop: "transition" | "animation"; value: string };

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

/** `!important` is re-serialized back into the value by `cssRulesBySelector`, so
 * strip it before comparing — otherwise the STRONGER guard form stops counting
 * as a guard and starts counting as a motion target of its own. */
function isNone(value: string): boolean {
  return (
    value
      .replace(/\s*!important\s*$/i, "")
      .trim()
      .toLowerCase() === "none"
  );
}

const isImportant = (value: string) => /!important\s*$/i.test(value);

/**
 * One coordinate system for selectors across three authoring surfaces.
 *
 * A `.svelte` file writes the guard as `:global(body.tandem-reduce-motion) .x`,
 * a plain `.css` file and `index.html` write `body.tandem-reduce-motion .x`, and
 * a target that already contains a `:global(...)` (TitleBar's
 * `.brand-btn :global(.brand-mark)`, MarginColumn's
 * `.margin-bubble :global([data-testid^="edit-btn-"])`) forces a DOUBLE-global
 * guard. Unwrapping `:global(...)` collapses all of them onto the same string,
 * so one lookup covers every surface instead of three near-copies that would
 * each need their own mutation proof.
 *
 * Whitespace is collapsed too: `cssRulesBySelector` preserves authored newlines
 * inside a selector list, and a guard wrapped differently from its target is the
 * same selector for matching purposes.
 */
const norm = (selector: string) => neutralizeSvelteGlobal(selector).replace(/\s+/g, " ").trim();

/**
 * The same selector with its `:global(...)` wrappers left INTACT — the second
 * half of the match, and the reason `norm` alone is not enough.
 *
 * `norm` collapses `.margin-bubble :global([data-testid^="edit-btn-"])` and
 * `.margin-bubble [data-testid^="edit-btn-"]` onto one string, which is what
 * lets one lookup serve `.svelte`, plain `.css` and `index.html`. But those two
 * are NOT the same rule in a Svelte component: the second is scope-hashed, so if
 * the inner `:global` was load-bearing — MarginColumn's edit button lives inside
 * the AnnotationCard child component — the hashed guard matches nothing and the
 * motion keeps running. Mutation-proved while writing this file: rewriting that
 * guard's inner half from `:global([data-testid^=…])` to the bare attribute
 * selector left this file fully green AND `svelte-check --fail-on-warnings`
 * silent (the compiler does not report an attribute selector as unused), so
 * nothing in the repo caught it.
 *
 * So the guard is FOUND by normalized selector — permissively, across all three
 * authoring surfaces — and then required to repeat its target's `:global`
 * structure verbatim. The find stays surface-agnostic; the assertion is exact.
 */
const structural = (selector: string) => selector.replace(/\s+/g, " ").trim();

/**
 * Timing tokens that BOTH reduced-motion mechanisms zero, read out of the token
 * files rather than listed here.
 *
 * `morphTiming.css` and `tabDragMotion.css` implement the third sanctioned
 * treatment in motion.md: instead of a per-rule guard, the inherited custom
 * property is set to `0ms` on `<body>`, which reaches scoped and inline
 * declarations a stylesheet rule cannot. A declaration timed ENTIRELY by such
 * tokens is therefore already covered and must not be reported.
 *
 * Derived, and required in both blocks, for two reasons. Adding a token to those
 * files without zeroing it would otherwise silently confer exemption on every
 * declaration using it — the exact failure this file exists to prevent. And
 * zeroing it in only one block is the single-mechanism bug #1530 fixed in five
 * other files; a token zeroed only under `@media` would exempt a declaration
 * that the in-app toggle still cannot reach.
 */
const TOKEN_FILES = [
  join(CLIENT, "panels", "morphTiming.css"),
  join(CLIENT, "tabs", "tabDragMotion.css"),
];

function zeroedTokens(): Set<string> {
  const zeroed = new Set<string>();
  for (const file of TOKEN_FILES) {
    const rules = cssRulesBySelector(styleBlocks(file));
    const perMechanism = (pick: (r: CssRule) => boolean): Set<string> => {
      const names = new Set<string>();
      for (const r of rules.filter(pick)) {
        for (const m of r.body.matchAll(/(?:^|;)\s*(--[\w-]+)\s*:\s*0m?s\b/g)) {
          names.add(m[1]);
        }
      }
      return names;
    };
    const viaMedia = perMechanism(
      (r) => r.atRules.length === 1 && REDUCE_MOTION_QUERY.test(r.atRules[0]),
    );
    const viaClass = perMechanism(
      (r) => r.atRules.length === 0 && r.fullSelectors.some((s) => norm(s) === GLOBAL_TOGGLE),
    );
    for (const name of viaMedia) if (viaClass.has(name)) zeroed.add(name);
  }
  return zeroed;
}
const ZEROED_TOKENS = zeroedTokens();

/** A duration or delay written as a literal, e.g. `160ms` / `0.15s`. */
const LITERAL_TIME = /(?:^|[\s,(])-?\d*\.?\d+m?s(?![\w-])/;
/** Easing tokens carry no duration, so they neither need nor confer zeroing. */
const EASING_TOKEN = /^--tandem-ease-/;

/**
 * True when every timing term in the value is a token both mechanisms zero.
 *
 * The literal check is what makes this narrow enough to be safe. A shorthand
 * MIXING a token term with a literal one — `.tab-add-pill`'s
 * `background 0.15s, …, opacity var(--morph-cascade)` — is only PARTLY covered
 * by token-zeroing, and shipping several of those is a large part of why #1530
 * existed. Any literal time anywhere in the value disqualifies the whole
 * declaration, which is the conservative direction: the worst case is demanding
 * a guard for something already covered, never the reverse.
 */
function tokenDriven(value: string): boolean {
  if (LITERAL_TIME.test(value)) return false;
  const vars = [...value.matchAll(/var\(\s*(--[\w-]+)/g)].map((m) => m[1]);
  if (vars.length === 0) return false;
  return vars.every((name) => ZEROED_TOKENS.has(name) || EASING_TOKEN.test(name));
}

type MotionTarget = {
  file: string;
  /** `norm`-alized — the coordinate system every lookup and EXCEPTIONS entry uses. */
  selector: string;
  /** As authored, `:global(...)` intact — what the guard must repeat verbatim. */
  authored: string;
  prop: "transition" | "animation";
  value: string;
  rule: CssRule;
};

/**
 * The one sanctioned way for a guard's selector to differ from its target's:
 * a SHORTER selector plus `!important`.
 *
 * `ActivityTray.svelte` declares the LED pulse on a four-class severity selector
 * (`.activity-shell.has-error .pill-row .led`) and guards `.pill-row .led`, which
 * loses on specificity — so the guard carries `!important` and wins anyway. Same
 * shape for the toast badge pop, declared on `.toast-row .badge.pop` and guarded
 * on `.toast-row .badge`. Both are deliberate and documented at the guard block
 * itself; the alternative is repeating every severity permutation.
 *
 * An entry alone is not enough: `!important` on the guard's `none` is ASSERTED
 * below, in both halves. Without that, deleting the flag during an unrelated
 * tidy-up would leave the entry looking like sanction for a guard that silently
 * stopped working — the LED is an INFINITE pulse, so that is a live WCAG 2.2.2
 * failure, not a cosmetic one. The source-order check is skipped for these:
 * `!important` beats a same-or-higher-specificity rule from anywhere in the
 * file, so order genuinely is not load-bearing here (it is for every other
 * target, where the guard wins only by coming later at equal specificity).
 */
const IMPORTANT_REASON =
  "guarded by a deliberately shorter selector forced with `!important`, because the " +
  "declaration sits on a higher-specificity state selector — see the guard block's own comment";
const EXCEPTIONS: Array<{ file: string; declared: string; guardedAs: string; reason: string }> = [
  {
    file: "src/client/components/ActivityTray.svelte",
    declared: ".activity-shell.has-warning .pill-row .led",
    guardedAs: ".pill-row .led",
    reason: IMPORTANT_REASON,
  },
  {
    file: "src/client/components/ActivityTray.svelte",
    declared: ".activity-shell.has-error .pill-row .led",
    guardedAs: ".pill-row .led",
    reason: IMPORTANT_REASON,
  },
  {
    file: "src/client/components/ActivityTray.svelte",
    declared: ".toast-row .badge.pop",
    guardedAs: ".toast-row .badge",
    reason: IMPORTANT_REASON,
  },
];

function exceptionFor(target: MotionTarget) {
  return EXCEPTIONS.find((e) => e.file === rel(target.file) && e.declared === target.selector);
}

const RULES_BY_FILE = new Map<string, CssRule[]>(
  FILES.map((f) => [f, cssRulesBySelector(styleBlocks(f))]),
);

const MOTION_TARGETS: MotionTarget[] = FILES.flatMap((file) =>
  (RULES_BY_FILE.get(file) ?? []).flatMap((rule) =>
    motionDecls(rule.body)
      .filter((d) => !isNone(d.value) && !tokenDriven(d.value))
      .flatMap((d) =>
        rule.fullSelectors.map((s) => ({
          file,
          selector: norm(s),
          authored: structural(s),
          prop: d.prop,
          value: d.value,
          rule,
        })),
      ),
  ),
);

function findGuard(
  target: MotionTarget,
  wantSelector: string,
  chainOk: (guardChain: string[]) => boolean,
): CssRule | undefined {
  return (RULES_BY_FILE.get(target.file) ?? []).find(
    (r) =>
      chainOk(r.atRules) &&
      r.fullSelectors.map(norm).includes(wantSelector) &&
      motionDecls(r.body).some((d) => d.prop === target.prop && isNone(d.value)),
  );
}

describe("reduce-motion guard coverage across src/client (#1530)", () => {
  it("App.svelte's own guard test still exists — this file excludes that file and defers to it", () => {
    expect(
      existsSync(APP_SVELTE_TEST),
      "app-shell-reduce-motion-guards.test.ts is gone, so App.svelte — excluded from the scan in " +
        "this file — is now unscanned by anything. Either restore it or drop the App.svelte " +
        "exclusion in `walk()` and port its float-slide EXCEPTIONS (with their markup proofs) here.",
    ).toBe(true);
    expect(existsSync(APP_SVELTE)).toBe(true);
  });

  it("finds motion-bearing declarations to check — a count near zero means the extractor desynced", () => {
    expect(MOTION_TARGETS.length).toBeGreaterThan(60);
  });

  /**
   * Every EXCEPTIONS entry must MATCH a real target. A key that matches nothing
   * is not inert: `exceptionFor()` returns undefined, the entry silently stops
   * applying, and the target is judged under the ordinary rule instead.
   *
   * Today that direction is loud — it is exactly how the Windows separator bug
   * surfaced, as three ActivityTray failures. But the failure mode is an
   * accident of which way this particular exception leans, and the general shape
   * is the "an empty filter result satisfies a zero check" trap: an exception
   * that RELAXES a check would, on the same missed lookup, degrade into a
   * silently stricter pass instead. Asserting the keys resolve is the honest
   * gate either way, and it fails on the lookup rather than on its consequence.
   */
  it.each(
    EXCEPTIONS.map((e) => [`${e.file} — ${e.declared}`, e] as const),
  )("EXCEPTIONS entry %s matches a real motion target", (_name, exception) => {
    expect(
      MOTION_TARGETS.find(
        (t) => rel(t.file) === exception.file && t.selector === norm(exception.declared),
      ),
      `no scanned target matches this EXCEPTIONS entry. Either the rule it excuses is gone — ` +
        "delete the entry — or the key no longer resolves. `file` is repo-relative with " +
        "FORWARD slashes (the `rel()` coordinate system, normalized for Windows) and " +
        "`declared` must equal the target's `norm`-alized selector.",
    ).toBeDefined();
  });

  it("reads timing tokens that both mechanisms zero — an empty set would exempt nothing and over-report", () => {
    expect([...ZEROED_TOKENS].sort()).toEqual([
      "--a30-chrome",
      "--a30-lift",
      "--a30-settle",
      "--a30-shift",
      "--morph-cascade",
      "--morph-p1",
      "--morph-p2",
    ]);
  });

  it.each(
    MOTION_TARGETS.map((t) => [`${rel(t.file)} — ${t.selector} (${t.prop})`, t] as const),
  )("%s is guarded by both mechanisms", (_label, target) => {
    const exception = exceptionFor(target);
    const guardedSelector = exception?.guardedAs ?? target.selector;

    const media = findGuard(target, guardedSelector, (chain) =>
      isReduceMotionGuardOf(chain, target.rule.atRules),
    );
    expect(
      media,
      `no \`@media (prefers-reduced-motion: reduce) { ${guardedSelector} { ${target.prop}: none } }\` ` +
        `rule found in ${rel(target.file)}. Add one directly AFTER the rule it guards — its ` +
        "specificity is identical (matched by resolved selector, and an at-rule adds none), so it " +
        "wins only by source order. If the timing is genuinely JS-computed, use token-zeroing " +
        "(morphTiming.css / tabDragMotion.css) instead; if the guard must use a different " +
        "selector, add an EXCEPTIONS entry and force it with `!important`.",
    ).toBeDefined();

    const wantGlobal = `${GLOBAL_TOGGLE} ${guardedSelector}`;
    const global = findGuard(target, wantGlobal, (chain) => sameChain(chain, target.rule.atRules));
    expect(
      global,
      `no \`${wantGlobal} { ${target.prop}: none }\` rule found in ${rel(target.file)} — Tandem's ` +
        "in-app reduceMotion setting does nothing for this rule without it, so exactly the users " +
        "who never touched their OS setting keep the motion. In a .svelte file write it as " +
        "`:global(body.tandem-reduce-motion) <selector>`; in a plain stylesheet or index.html, " +
        "write it bare.",
    ).toBeDefined();

    if (!media || !global) return;

    // EXCEPTIONS deliberately guard under a DIFFERENT selector, so there is no
    // target structure to repeat — `guardedAs` is itself the authored form, and
    // `!important` (asserted below) is what makes it sound.
    const authoredGuard = exception?.guardedAs ?? target.authored;
    expect(
      media.fullSelectors.map(structural),
      `${rel(target.file)}: the @media guard matched \`${guardedSelector}\` only after ` +
        "`:global(...)` unwrapping — it must repeat its target's selector VERBATIM, `:global` " +
        "wrappers included. In a Svelte component a bare inner selector is scope-hashed and a " +
        "`:global` one is not, so the two match different elements while reading identically here.",
    ).toContain(authoredGuard);
    // Two authorings satisfy the `:global` half in a `.svelte` file, and both are
    // safe for the same reason: neither leaves a part of the selector scoped that
    // the target had global. The split form repeats the target verbatim and adds
    // its own wrapper; the whole-selector form (`:global(body.x .a .b)`, used by
    // ReplyThread and SidePanel) puts EVERYTHING outside the scope hash, so no
    // part can be hashed by accident. A plain stylesheet has only the bare form.
    const acceptableGlobal = target.file.endsWith(".svelte")
      ? [
          `:global(${GLOBAL_TOGGLE}) ${authoredGuard}`,
          `:global(${GLOBAL_TOGGLE} ${norm(authoredGuard)})`,
        ]
      : [`${GLOBAL_TOGGLE} ${authoredGuard}`];
    expect(
      global.fullSelectors.map(structural).some((s) => acceptableGlobal.includes(s)),
      `${rel(target.file)}: the ${GLOBAL_TOGGLE} guard matched \`${guardedSelector}\` only after ` +
        "`:global(...)` unwrapping. Where the target has an inner `:global`, the guard must keep " +
        "that part global too — either as the double-global form " +
        `(\`${acceptableGlobal[0]}\`) or with the whole selector inside one wrapper` +
        (acceptableGlobal[1] ? ` (\`${acceptableGlobal[1]}\`)` : "") +
        ". A bare inner selector is scope-hashed and matches a different element.",
    ).toBe(true);

    if (exception) {
      for (const [half, rule] of [
        ["@media", media],
        [GLOBAL_TOGGLE, global],
      ] as const) {
        const decl = motionDecls(rule.body).find((d) => d.prop === target.prop && isNone(d.value));
        expect(
          decl && isImportant(decl.value),
          `${rel(target.file)}'s ${half} guard for \`${guardedSelector}\` lost its \`!important\`. ` +
            `It guards \`${target.selector}\`, a MORE specific selector, so without the flag the ` +
            "guard silently loses and the motion keeps running. Restore it, or guard the full " +
            "selector and drop the EXCEPTIONS entry.",
        ).toBe(true);
      }
      return;
    }

    expect(
      media.start,
      `${rel(target.file)}: the @media guard for \`${guardedSelector}\` must be declared AFTER the ` +
        "rule it guards — same selector means same specificity, and an at-rule adds none, so it " +
        "wins on source order alone.",
    ).toBeGreaterThan(target.rule.start);
    expect(
      global.start,
      `${rel(target.file)}: the ${GLOBAL_TOGGLE} guard for \`${guardedSelector}\` must be declared ` +
        "after the rule it guards.",
    ).toBeGreaterThan(target.rule.start);
  });
});

describe("reduce-motion guard coverage across src/client (#1530): inline styles are invisible to the scan above", () => {
  /**
   * `styleBlocks()` reads `<style>` blocks only, by contract. A `transition` or
   * `animation` in an inline `style="…"` attribute is therefore structurally
   * outside everything asserted above — it cannot be found, guarded, or counted,
   * and no stylesheet rule can override it without `!important`. That is not
   * hypothetical: `ChatPanel.svelte`'s typing indicator shipped an INFINITE
   * inline `animation` with no guard of any kind (a WCAG 2.2.2 failure), and it
   * was invisible to every check in the repo until this block existed. #1530
   * moved it, and eight others, into stylesheet rules.
   *
   * The brace depth-count is because a `style={...}` value can nest `${...}`
   * interpolations with their own braces; one leading backtick is skipped so the
   * extracted text starts at real CSS (see the App.svelte file's longer note).
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

  const SVELTE_FILES = FILES.filter((f) => f.endsWith(".svelte"));

  /**
   * The two inline motion declarations that stay inline, and why each is safe.
   *
   * Both are `StatusBar.svelte` presence dots whose ANIMATION NAME is chosen in
   * JS per connection/AI state — there is no static declaration to move, and a
   * class per state would just relocate the branch. They are guarded instead by
   * a `!important` rule on `.status-dot` / `.claude-dot`, which is the one thing
   * that can beat an inline declaration. That guard is verified by the main scan
   * above (the dots' classes carry no stylesheet `animation`, so the `!important`
   * rule reads there as a plain `none` and is simply not reported) — so the check
   * here is the narrower one it can make: the allowlisted file really does carry
   * both halves with `!important`.
   *
   * Anything else must move into a stylesheet rule. Token-zeroing is the other
   * sanctioned answer, and it needs no entry here because a token-driven value
   * carries no literal duration for the scan to catch — `TabItem.svelte`'s pill
   * writes one inline `transition` shorthand and every term of it is a
   * `tabDragMotion.css` token for exactly that reason.
   */
  const INLINE_ALLOWLIST = new Map<string, { count: number; guardedBy: string[] }>([
    ["src/client/status/StatusBar.svelte", { count: 2, guardedBy: [".status-dot", ".claude-dot"] }],
  ]);

  /**
   * Same anti-vacuity gate as the EXCEPTIONS one above, for the other
   * path-keyed map in this file. `INLINE_ALLOWLIST.get(name)` falls back to
   * `?? 0`, so a key that resolves to nothing is indistinguishable from "this
   * file is allowed zero" — the allowance just evaporates. Pin that the key
   * names a file actually in the scanned corpus, in the corpus's own
   * coordinate system.
   */
  it.each(
    [...INLINE_ALLOWLIST.keys()].map((name) => [name] as const),
  )("INLINE_ALLOWLIST key %s names a file the inline scan actually visits", (name) => {
    expect(
      SVELTE_FILES.map(rel),
      `\`${name}\` is not among the scanned .svelte files, so its allowance applies to nothing ` +
        "and the file it was written for is being held to zero. Keys are repo-relative with " +
        "FORWARD slashes — see `rel()`.",
    ).toContain(name);
  });

  it("finds inline style attributes to scan — zero means the scanner desynced from the markup", () => {
    const total = SVELTE_FILES.reduce(
      (n, f) => n + inlineStyleValues(readFileSync(f, "utf-8")).length,
      0,
    );
    expect(total).toBeGreaterThan(100);
  });

  it.each(
    SVELTE_FILES.map((f) => [rel(f), f] as const),
  )("%s declares no unallowlisted transition/animation in an inline style attribute", (name, file) => {
    const offenders = inlineStyleValues(readFileSync(file, "utf-8")).filter((v) =>
      /(?:^|[;\s])(?:transition|animation)\s*:/.test(v),
    );
    const allowed = INLINE_ALLOWLIST.get(name)?.count ?? 0;
    expect(
      offenders.length,
      `${name} has ${offenders.length} inline motion declaration(s), ${allowed} allowlisted. An ` +
        "inline `style` is unreachable by every guard in this file — no stylesheet rule can " +
        "override it without `!important`. If the timing is STATIC, move the declaration into a " +
        "stylesheet rule and guard THAT (see ChatPanel's typing dots, #1530); if it is genuinely " +
        "JS-computed, use token-zeroing (morphTiming.css / tabDragMotion.css). Add an " +
        "INLINE_ALLOWLIST entry only with a guard that can actually beat an inline declaration.\n" +
        offenders.map((o) => `  - ${o.replace(/\s+/g, " ").trim().slice(0, 160)}`).join("\n"),
    ).toBe(allowed);
  });

  it.each(
    [...INLINE_ALLOWLIST].map(([name, entry]) => [name, entry] as const),
  )("%s's allowlisted inline motion is guarded by an `!important` rule that can beat it", (name, entry) => {
    const rules = RULES_BY_FILE.get(join(ROOT, name));
    expect(rules, `${name} is not in the scanned corpus`).toBeDefined();
    for (const selector of entry.guardedBy) {
      for (const [half, chainOk] of [
        ["@media", (c: string[]) => c.length === 1 && REDUCE_MOTION_QUERY.test(c[0])],
        [GLOBAL_TOGGLE, (c: string[]) => c.length === 0],
      ] as const) {
        const want = half === "@media" ? selector : `${GLOBAL_TOGGLE} ${selector}`;
        const guard = (rules ?? []).find(
          (r) =>
            chainOk(r.atRules) &&
            r.fullSelectors.map(norm).includes(want) &&
            motionDecls(r.body).some((d) => isNone(d.value) && isImportant(d.value)),
        );
        expect(
          guard,
          `${name}: no \`${want} { animation: none !important }\` rule. The allowlisted inline ` +
            "`animation` on this element can only be overridden with `!important` — without it " +
            "the dot keeps animating under both reduced-motion mechanisms.",
        ).toBeDefined();
      }
    }
  });

  /**
   * The sweep above reads each `style={…}` occurrence's EXPRESSION SOURCE TEXT,
   * which for a template literal IS the CSS but for `style={someIdentifier}` is
   * just a name — and a `transition` the expression builds at runtime lands
   * exactly as unguardable. `src/client/**\/*.ts` is where those strings are
   * built (ProseMirror decorations, layout helpers, the settings cards' shared
   * `cardStyle()`), so it is swept directly, with comments stripped first so
   * prose can neither satisfy nor trip it.
   */
  function tsFiles(dir: string, out: string[] = []): string[] {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, entry.name);
      if (entry.isDirectory()) tsFiles(p, out);
      else if (entry.name.endsWith(".ts")) out.push(p);
    }
    return out;
  }

  it.each(
    tsFiles(CLIENT).map((f) => [rel(f), f] as const),
  )("%s builds no motion declaration into a style string", (name, file) => {
    const src = readFileSync(file, "utf-8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^[ \t]*\/\/.*$/gm, "");
    const offenders = [
      ...src.matchAll(/(?:^|[;\s"'`])((?:transition|animation)\s*:[^;\n`"']*)/g),
    ].map((m) => m[1].trim());
    expect(
      offenders,
      `${name} emits a motion declaration into a string that ends up in an inline \`style\`, ` +
        "where no reduce-motion guard can reach it. Move it into a stylesheet rule and guard " +
        "THAT — `extensions/awareness.ts` did exactly this in #1530, moving the Claude-focus " +
        "paragraph tint into `editor.css`'s `.tandem-claude-focus` — or, if the timing is " +
        "genuinely computed, use token-zeroing.",
    ).toEqual([]);
  });
});
