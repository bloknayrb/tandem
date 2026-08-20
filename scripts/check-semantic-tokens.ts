import { readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const toSlash = (p: string) => p.replace(/\\/g, "/");

const ROOT = join(import.meta.dirname, "..");
const CLIENT_DIR = join(ROOT, "src/client");
const SKIP_FILE_RELS = new Set([
  "src/client/utils/colors.ts",
  "src/client/svelte-harness/Harness.svelte",
  "src/client/svelte-harness/HookDebug.svelte",
]);

const HEX_RE = /#[0-9a-fA-F]{3,8}\b/g;
const RGBA_RE = /\brgba?\s*\(/g;
const BORDER_RADIUS_RE = /\bborder-radius\s*:\s*\d+px\b/g;
const BOX_SHADOW_RE = /\bbox-shadow\s*:\s*[^;]*rgba?\s*\(/g;
const NEUTRAL_RE = /(?:0\s*,\s*0\s*,\s*0|255\s*,\s*255\s*,\s*255)/;
const CSS_KEYWORDS = ["color", "background", "border", "fill", "stroke", "style"];

/**
 * Lengths of a hex body (`#` excluded) that CSS actually accepts as a color:
 * `#rgb`, `#rgba`, `#rrggbb`, `#rrggbbaa`. A 5- or 7-digit run is not a color
 * in any browser, so it is not a token violation either — and it *is* the
 * shape a five-digit issue reference has. `normalizeHexForBlocklist` already
 * treats 5/7 as out of scope; this makes the CSS-keyword pass agree with it.
 */
const VALID_HEX_COLOR_BODY_LENGTHS: ReadonlySet<number> = new Set([3, 4, 6, 8]);

/** A hex body with no `a`-`f` in it at all — the shape of an issue reference. */
const ALL_DECIMAL_DIGITS_RE = /^[0-9]+$/;

/** `ident:` — a CSS/object property colon that would govern a following value. */
const PROPERTY_COLON_RE = /[-a-zA-Z_][-a-zA-Z0-9_]*\s*:/;

/**
 * A bare (unquoted) attribute value: `<svg fill=#333>`.
 *
 * Narrower than a plain `/=\s*$/`, which also matched `const m = "…"` and so
 * made every string literal on an assignment line a color context.
 */
const ATTRIBUTE_ASSIGNMENT_TAIL_RE = /[-a-zA-Z_][-a-zA-Z0-9_]*\s*=\s*$/;

/**
 * What can appear immediately before a string literal that makes the WHOLE
 * literal a CSS value: a `style` attribute, a `.style.*`/`.cssText` assignment,
 * a `setProperty()` value argument, an object-literal property, or a CSS-in-JS
 * tagged template.
 *
 * The object-property arm accepts ANY identifier rather than only CSS-ish ones,
 * matching the declaration walk-back below — restricting it would drop the real
 * color in `<div class="border-box" style="box-shadow: 0 0 1px #333">`.
 */
const STYLE_STRING_GOVERNOR_RE =
  /(?:\bstyle(?::[-a-zA-Z0-9_]+)?\s*=|\.style(?:\.[A-Za-z0-9_$]+)?\s*=|\.setProperty\(\s*(['"`])[^'"`]*\1\s*,|\b(?:css|styled(?:\.[A-Za-z0-9_$]+)?|keyframes|createGlobalStyle))[\s{(]*$/;

/** The identifier of an object-literal / declaration property, if this text ends in one. */
const PROPERTY_NAME_TAIL_RE = /([-a-zA-Z_][-a-zA-Z0-9_]*)\s*:[\s{(]*$/;

/**
 * Words that make a property name a CSS property name.
 *
 * The object-property governor arm used to accept ANY identifier, defended by
 * the claim that narrowing it "would drop the real color in
 * `<div class="border-box" style="box-shadow: 0 0 1px #333">`". Measured, that
 * is false — the `style=` arm already covers that line with the object arm
 * removed. What the loose form actually bought was every `ident: "prose"` in
 * the tree: `src/client` holds 121 `label: "…"` shapes alone, and
 * `label: "Toggle authorship colors (#1364)"` reported as a raw color, which
 * is precisely #1534.
 */
const CSS_PROPERTY_WORDS: ReadonlySet<string> = new Set([
  "accent",
  "background",
  "border",
  "caret",
  "color",
  "decoration",
  "fill",
  "gradient",
  "outline",
  "shadow",
  "stroke",
  "style",
]);

/**
 * Is `name` a CSS property name, in either spelling?
 *
 * Splits camelCase as well as kebab-case, because the same property is written
 * `border-color` in CSS and `borderColor` in a style object, and a rule that
 * handled only one of them would be a silent hole in whichever half it missed.
 * `boxShadow` and `box-shadow` both reduce to `["box", "shadow"]`.
 */
export function isCssPropertyName(name: string): boolean {
  return name
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .toLowerCase()
    .split("-")
    .filter(Boolean)
    .some((part) => CSS_PROPERTY_WORDS.has(part));
}

/**
 * Words that may appear inside a CSS *value*.
 *
 * The discriminator this list encodes: **property names are deliberately
 * absent.** Prose about CSS almost always names the property (`"border shifted
 * 4px"`, `"background transparent"`, `"color hidden"`), while an actual value
 * string never does — so `border`/`background`/`color`/`fill`/`stroke` being
 * missing here is what separates the two, and adding one would re-open #1534.
 * `CSS_KEYWORDS` above is the opposite list for the opposite purpose; they must
 * not be merged.
 */
const CSS_VALUE_WORDS: ReadonlySet<string> = new Set([
  // Units (extracted as a bare word out of `4px`, `2rem`, …).
  "px",
  "em",
  "rem",
  "ex",
  "ch",
  "vh",
  "vw",
  "vmin",
  "vmax",
  "vi",
  "vb",
  "dvh",
  "dvw",
  "svh",
  "svw",
  "lvh",
  "lvw",
  "cqw",
  "cqh",
  "cqi",
  "cqb",
  "pt",
  "pc",
  "in",
  "cm",
  "mm",
  "q",
  "fr",
  "deg",
  "rad",
  "grad",
  "turn",
  "s",
  "ms",
  "hz",
  "khz",
  "dpi",
  "dpcm",
  "dppx",
  "x",
  // Value keywords.
  "auto",
  "none",
  "normal",
  // Border widths. Real values that master caught and a word list must not
  // lose: `"thin solid #333"`, `"medium solid #333"`.
  "thin",
  "medium",
  "thick",
  "wavy",
  "stretch",
  "baseline",
  "initial",
  "inherit",
  "unset",
  "revert",
  "transparent",
  "currentcolor",
  "important",
  "solid",
  "dashed",
  "dotted",
  "double",
  "inset",
  "outset",
  "groove",
  "ridge",
  "hidden",
  "visible",
  "clip",
  "scroll",
  "collapse",
  "separate",
  "repeat",
  "no-repeat",
  "repeat-x",
  "repeat-y",
  "round",
  "space",
  "cover",
  "contain",
  // `fill` is deliberately absent even though `object-fit: fill` is real: it is
  // also one of the six CSS_KEYWORDS the line gate matches on, so admitting it
  // would let `"fill #1364"` read as a value. The cost is a missed
  // `object-fit: fill` value string; the benefit is that the property/value
  // split stays clean, which is what the whole predicate rests on.
  "fit-content",
  "min-content",
  "max-content",
  "center",
  "top",
  "bottom",
  "left",
  "right",
  "start",
  "end",
  "middle",
  "ease",
  "ease-in",
  "ease-out",
  "ease-in-out",
  "linear",
  "step-start",
  "step-end",
  "steps",
  "infinite",
  "alternate",
  "alternate-reverse",
  "forwards",
  "backwards",
  "reverse",
  "paused",
  "running",
  "bold",
  "bolder",
  "lighter",
  "italic",
  "oblique",
  "underline",
  "uppercase",
  "lowercase",
  "capitalize",
  "nowrap",
  "pre",
  "pre-wrap",
  "break-word",
  "border-box",
  "content-box",
  "padding-box",
  // Function names and their bare keyword arguments.
  "url",
  "var",
  "calc",
  "min",
  "max",
  "clamp",
  "env",
  "attr",
  "counter",
  "srgb",
  "oklab",
  "oklch",
  "lab",
  "lch",
  "hwb",
  "hsl",
  "hsla",
  "rgb",
  "rgba",
  "to",
  "from",
  "at",
  "circle",
  "ellipse",
  "closest-side",
  "farthest-corner",
  "shorter",
  "longer",
  "increasing",
  "decreasing",
  "hue",
  // Colors that legitimately sit beside a hex in a value.
  "black",
  "white",
  "red",
  "green",
  "blue",
  "gray",
  "grey",
  "silver",
  "yellow",
  "orange",
  "purple",
  "pink",
  "brown",
  "cyan",
  "magenta",
]);

/**
 * A property colon whose property name is CSS-ish, for use INSIDE a string
 * literal: `` `border: ${w}px solid #333` `` is a declaration someone will
 * assign to `style` a line later, so the hex in it is a real color.
 *
 * Much narrower than `PROPERTY_COLON_RE`, and it has to be. The generic form
 * is safe in raw CSS, where every colon really is a declaration, but inside a
 * string literal it reads ordinary prose punctuation as CSS: `console.warn(
 * "[theme] border mismatch: #1364")` was reported for exactly that reason, and
 * that was the residual the first cut at #1534 accepted rather than fixed.
 * Requiring the name itself to be CSS-ish retires it — `mismatch` is not a
 * property, `border-color` and `boxShadow` are.
 *
 * Residual, accepted and narrowed: a sentence that opens with a real property
 * name and a colon (`"background: still wrong, see #1364"`) still reports.
 * That is the same shape the raw-CSS walk-back accepts, so the two agree.
 */
const LEADING_PROPERTY_COLON_RE = /^\s*([-a-zA-Z_][-a-zA-Z0-9_]*)\s*:/;

/**
 * Does this literal OPEN with a CSS declaration?
 *
 * Anchored at the literal's start, not merely "contains a CSS-ish colon
 * somewhere". Unanchored it read ordinary log punctuation as CSS — measured,
 * `"border ok. shadow: see #1364"` and `"styles: regressed in #1364"` both
 * reported — which is the same substring trap that produced #1534 one level up.
 */
function opensWithCssDeclaration(content: string): boolean {
  const m = LEADING_PROPERTY_COLON_RE.exec(content);
  return m !== null && isCssPropertyName(m[1]);
}

/**
 * Does this string literal's content read as a CSS value rather than as prose?
 *
 * Every alphabetic word in it must be a value word. `"1px solid #333"` passes
 * (`px`, `solid`); `"border shifted 4px #1364"` does not (`border`, `shifted`).
 * A literal with no words at all — `"0 0 0 #333"` — passes vacuously, which is
 * correct: there is no prose in it to mistake for one.
 *
 * Vendor prefixes are stripped so `-webkit-linear-gradient` is judged as
 * `linear-gradient`, and a hyphenated word is accepted if either the whole word
 * or every hyphen-separated part is a value word — which is what lets
 * `linear-gradient`, `repeating-radial-gradient` and `color-mix` through
 * without enumerating the cross product.
 */
/**
 * Word parts that are only ever half of a hyphenated CSS value word, so they
 * would be noise in `CSS_VALUE_WORDS` on their own. Keeping them separate is
 * what lets `linear-gradient`, `repeating-radial-gradient` and `color-mix`
 * through without enumerating the cross product — and, importantly, without
 * `color` or `image` becoming standalone value words, which would re-open
 * #1534 for prose that names those properties.
 */
const CSS_VALUE_WORD_PARTS: ReadonlySet<string> = new Set([
  "color",
  "conic",
  "cross",
  "dark",
  // `drop-shadow(…)`, `blur(…)`, `saturate(…)` — filter functions. `drop` is
  // safe as a part because it is not one of the six line-gate CSS_KEYWORDS.
  "drop",
  "blur",
  "saturate",
  // `drop-shadow`. Safe as a PART: `shadow` alone never passes, and
  // `box-shadow` still fails because `box` is in neither list — so prose that
  // names the property keeps failing while the filter function passes.
  "shadow",
  "fade",
  "gradient",
  "image",
  "light",
  "mix",
  "radial",
  "repeating",
  "set",
]);

export function looksLikeCssValueString(content: string): boolean {
  const words = content.match(/[A-Za-z][A-Za-z-]*/g) ?? [];
  return words.every((word) => {
    const w = word.toLowerCase().replace(/^-?(?:webkit|moz|ms|o)-/, "");
    if (CSS_VALUE_WORDS.has(w)) return true;
    const parts = w.split("-").filter(Boolean);
    if (parts.length < 2) return false;
    return parts.every((part) => CSS_VALUE_WORDS.has(part) || CSS_VALUE_WORD_PARTS.has(part));
  });
}

/**
 * CSS functions whose argument list is a color context.
 *
 * Named explicitly rather than "any identifier before a `(`", because the
 * generic form re-opens #1534: the filed repro sits inside `console.warn(`, and
 * `color-mix(in srgb, #333 50%, white)` shows the hex is not always the first
 * argument, so a rule loose enough to reach it would also reach any prose
 * argument of any call. A closed list gets both sides right.
 */
const CSS_COLOR_FUNCTIONS: ReadonlySet<string> = new Set([
  "color-mix",
  "conic-gradient",
  "hsl",
  "hsla",
  "hwb",
  "lab",
  "lch",
  "light-dark",
  "linear-gradient",
  "oklab",
  "oklch",
  "radial-gradient",
  "repeating-conic-gradient",
  "repeating-linear-gradient",
  "repeating-radial-gradient",
  "rgb",
  "rgba",
  "var",
]);

/** The identifier ending immediately before a `(`, vendor prefix stripped. */
const CALLEE_TAIL_RE = /([A-Za-z][A-Za-z0-9_-]*)$/;

/**
 * Is the hex inside the argument list of a CSS color function that is CLOSED
 * within `region`?
 *
 * Scans for the last still-open `(` before the hex, then checks the identifier
 * in front of it. The closing requirement is what keeps an unbalanced paren in
 * prose from swallowing the rest of the line: `console.warn("border rgba(
 * parse fail #1364")` has an open `rgba(` before the hex, but it never closes
 * inside the string literal, so it is not a call — it is a sentence containing
 * a bracket. A real `linear-gradient(#333, #444)` always closes.
 */
function isInsideCssColorFunction(before: string, after: string): boolean {
  const open: number[] = [];
  for (let i = 0; i < before.length; i++) {
    if (before[i] === "(") open.push(i);
    else if (before[i] === ")") open.pop();
  }
  const innermost = open.pop();
  if (innermost === undefined) return false;
  // The call must close after the hex, inside the same region.
  let depth = 1;
  let closed = false;
  for (const ch of after) {
    if (ch === "(") depth++;
    else if (ch === ")" && --depth === 0) {
      closed = true;
      break;
    }
  }
  if (!closed) return false;
  const callee = CALLEE_TAIL_RE.exec(before.slice(0, innermost));
  if (callee === null) return false;
  return CSS_COLOR_FUNCTIONS.has(callee[1].toLowerCase().replace(/^-?(?:webkit|moz|ms|o)-/, ""));
}

/**
 * A string literal that was still open when a line ended.
 *
 * Only two kinds are carried across lines, and the restriction is the whole
 * safety argument. A **template literal** is the only genuinely multi-line
 * literal in TS/Svelte script. An **attribute value** (`quote` preceded by
 * `=`) is the multi-line form in markup: `src/client/components/
 * CommandPalette.svelte` holds six `style="…"` attributes wrapped across lines.
 *
 * Everything else stops at the newline, because carrying it would be actively
 * harmful: 103 lines in `src/client` end mid-`'` or mid-`"` purely from prose
 * apostrophes and quotes (`AppearanceSettings.svelte`'s "document's"). Carrying
 * those would poison every following line of the file. An attribute quote is
 * preceded by `=`; an apostrophe in prose is preceded by a letter.
 */
interface OpenLiteral {
  quote: string;
  /** Whether the text before the opening quote made it a CSS value. */
  governed: boolean;
  /** The literal's content from previous lines, for the value-word test. */
  priorText: string;
}

/**
 * A literal occupying `[start, end)` on this line — `start < 0` if it opened earlier.
 *
 * `governed` is resolved LAZILY (it is set only for a literal carried in from a
 * previous line, where the text before the opening quote is no longer
 * available). Computing it eagerly for every literal meant running the governor
 * regex tens of thousands of times per scan — measured at a 5x slowdown over
 * the whole of `src/client` — when only the handful of literals that actually
 * contain a hex ever need the answer.
 */
interface LiteralSpan {
  start: number;
  end: number;
  governed?: boolean;
  priorText: string;
}

/** Any quote character — the fast-path guard for `scanStringLiterals`. */
const QUOTE_RE = /["'`]/;

/** Head of a carried literal kept for the value-word and declaration tests. */
const MAX_CARRIED_LITERAL_CHARS = 4096;

/** Does the text before an opening quote make the whole literal a CSS value? */
function isGovernedLiteral(before: string): boolean {
  return STYLE_STRING_GOVERNOR_RE.test(before) || isCssGovernedProperty(before);
}

/** May a literal opened with `quote` here survive to the next line? */
function literalMayContinue(quote: string, before: string): boolean {
  return quote === "`" || /=\s*$/.test(before);
}

/**
 * Every string literal on `line`, plus whatever is still open at its end.
 *
 * A single left-to-right pass with backslash-escape skipping. Only the quote
 * that opened a literal can close it, so an apostrophe inside `"…"` and a `"`
 * inside a template literal are both inert — which is the point. Comments are
 * already masked by `maskComments` before this runs.
 */
export function scanStringLiterals(
  line: string,
  incoming: OpenLiteral | null,
): { spans: LiteralSpan[]; outgoing: OpenLiteral | null } {
  type Frame =
    | { kind: "lit"; quote: string; start: number; governed?: boolean; priorText: string }
    | { kind: "interp"; depth: number };

  const spans: LiteralSpan[] = [];
  const frames: Frame[] = [];
  // Fast path: a line with no quote at all cannot open or close anything, and
  // most lines are that. Skipping the character loop for them is what keeps
  // this scan off the critical path of a whole-tree run.
  if (incoming === null && !QUOTE_RE.test(line)) return { spans, outgoing: null };
  if (incoming) {
    frames.push({
      kind: "lit",
      quote: incoming.quote,
      start: -1,
      governed: incoming.governed,
      priorText: incoming.priorText,
    });
  }

  // `charCodeAt` rather than `line[i]`: indexing allocates a one-character
  // string per character, which over `src/client` is millions of allocations.
  const BACKSLASH = 92;
  const DQUOTE = 34;
  const SQUOTE = 39;
  const BACKTICK = 96;
  const DOLLAR = 36;
  const LBRACE = 123;
  const RBRACE = 125;

  for (let i = 0; i < line.length; i++) {
    const code = line.charCodeAt(i);
    if (code === BACKSLASH) {
      i++;
      continue;
    }
    const top = frames.length === 0 ? undefined : frames[frames.length - 1];

    if (top?.kind === "lit") {
      // `${` inside a template literal re-enters CODE, where a nested literal
      // may legally open. Without this the inner backtick of
      // el.style.cssText = `border: ${d ? `1px solid #333` : `none`}`
      // reads as CLOSING the outer template, and the hex is judged as code.
      if (top.quote === "`" && code === DOLLAR && line.charCodeAt(i + 1) === LBRACE) {
        frames.push({ kind: "interp", depth: 1 });
        i++;
        continue;
      }
      if (line[i] === top.quote) {
        frames.pop();
        spans.push({
          start: top.start,
          end: i,
          governed: top.governed,
          priorText: top.priorText,
        });
      }
      continue;
    }

    if (top?.kind === "interp") {
      if (code === LBRACE) top.depth++;
      else if (code === RBRACE && --top.depth === 0) frames.pop();
    }
    if (code === DQUOTE || code === SQUOTE || code === BACKTICK) {
      frames.push({ kind: "lit", quote: line[i], start: i, priorText: "" });
    }
  }

  // Anything still open reaches the line end.
  for (let f = frames.length - 1; f >= 0; f--) {
    const frame = frames[f];
    if (frame.kind === "lit") {
      spans.push({
        start: frame.start,
        end: line.length,
        governed: frame.governed,
        priorText: frame.priorText,
      });
    }
  }

  // Carry forward only an UNNESTED literal: a line ending mid-interpolation is
  // ambiguous, and guessing there would poison every following line.
  const only = frames.length === 1 ? frames[0] : null;
  if (only?.kind !== "lit") return { spans, outgoing: null };
  const beforeOpen = only.start < 0 ? "" : line.slice(0, only.start);
  if (only.start >= 0 && !literalMayContinue(only.quote, beforeOpen)) {
    return { spans, outgoing: null };
  }
  return {
    spans,
    outgoing: {
      quote: only.quote,
      governed: only.governed ?? isGovernedLiteral(line.slice(0, Math.max(only.start, 0))),
      // Capped: a literal that is never closed would otherwise accumulate the
      // rest of the file, and every hex in it would re-scan the whole thing.
      // The HEAD is what is kept, because `opensWithCssDeclaration` reads the
      // start; a wrapped attribute or template runs to a few lines, not 200.
      priorText: `${only.priorText}${line.slice(only.start + 1)}\n`.slice(
        0,
        MAX_CARRIED_LITERAL_CHARS,
      ),
    },
  };
}

/** Does `before` end in a CSS-ish object/declaration property name and a colon? */
function isCssGovernedProperty(before: string): boolean {
  const m = PROPERTY_NAME_TAIL_RE.exec(before);
  return m !== null && isCssPropertyName(m[1]);
}

/**
 * Is the hex at `index` sitting where a *color value* can sit? (issue #1534)
 *
 * The organising question is **"is this token inside a string literal, and if
 * so, is that literal a CSS value or is it prose?"** — because a line-local
 * "what token precedes the hex" test cannot answer it. That earlier shape was
 * wrong in BOTH directions at once, and the two errors could not be fixed
 * independently: loosening it enough to see the hex in
 * `el.style.boxShadow = "0 0 0 #333"` (a unitless length is still a length)
 * necessarily also made it report `console.log("border shifted 4px #1364")`.
 * Deciding per-LITERAL instead of per-TOKEN resolves both, because a prose
 * string is prose all the way through — including across a line break, which is
 * why `spans` carries a literal's governor and prior text forward.
 *
 * In code (not inside any literal):
 *
 * - **Declaration value** — walking back to the last `;`, `{` or `}`, the
 *   segment contains a property colon. This is the raw-CSS path: `color: #333`,
 *   `.a { box-shadow: 0 0 1px #333 }`, `background: linear-gradient(#333,#444)`.
 * - **Bare attribute** — `<svg fill=#333>`.
 * - **Color-function argument** — inside a `linear-gradient(…)`/`color-mix(…)`
 *   call that closes on the line.
 *
 * Inside a string literal, the literal is judged as a whole:
 *
 * - **Governed** — what precedes the opening quote makes it a CSS value:
 *   `el.style.border = "…"`, `{ borderColor: "…" }`, `<div style="…">`,
 *   `setProperty("--x", "…")`. (No separate `.cssText` arm: the only real
 *   spelling is `el.style.cssText`, which the `.style.*=` arm already covers,
 *   and a branch no fixture can distinguish is a branch that rots.)
 * - **Self-evident** — every word in it is a CSS value word, so it is a CSS
 *   value wherever it was written: `const BORDER = "1px solid #333"`.
 * - **Declaration** — it OPENS with a CSS property colon:
 *   `` const s = `border: ${w}px solid #333` ``.
 * - **Color-function argument** — as above but scoped to the literal, so the
 *   call must also close inside it.
 * - **Whole literal** — the hex IS the entire contents: `color="#333"`,
 *   `["#333", "#000"]`, `ctx.fillStyle = "#333"`. This arm is also the fallback
 *   when the quote scan cannot resolve the literal at all (a regex literal
 *   containing a quote desynchronises it), which is the only case it uniquely
 *   decides.
 *
 * Anything else inside a literal is prose and reports nothing.
 *
 * `spans` comes from `scanStringLiterals` for this line; callers that have no
 * multi-line context (the exported helper's unit tests) may omit it and get
 * line-local behaviour.
 */
export function isColorValuePosition(
  line: string,
  index: number,
  raw: string,
  spans?: LiteralSpan[],
): boolean {
  const before = line.slice(0, index);
  const after = line.slice(index + raw.length);

  // The token is the entire contents of a literal. Checked first because it is
  // the one arm that does not need the literal to be resolvable.
  const quote = before.slice(-1);
  if ((quote === '"' || quote === "'" || quote === "`") && after.startsWith(quote)) return true;

  const resolved = spans ?? scanStringLiterals(line, null).spans;
  // Innermost wins: a nested literal inside `${…}` sits inside its parent's span.
  const span = resolved
    .filter((sp) => sp.start < index && index < sp.end)
    .reduce<LiteralSpan | undefined>(
      (best, sp) => (!best || sp.start > best.start ? sp : best),
      undefined,
    );
  if (span) {
    const contentStart = Math.max(span.start, -1) + 1;
    const content = span.priorText + line.slice(contentStart, span.end);
    if (span.governed ?? isGovernedLiteral(line.slice(0, Math.max(span.start, 0)))) return true;
    if (looksLikeCssValueString(content)) return true;
    if (opensWithCssDeclaration(content)) return true;
    return isInsideCssColorFunction(
      span.priorText + line.slice(contentStart, index),
      line.slice(index + raw.length, span.end),
    );
  }

  if (ATTRIBUTE_ASSIGNMENT_TAIL_RE.test(before)) return true;
  if (isInsideCssColorFunction(before, after)) return true;

  const cut = Math.max(before.lastIndexOf(";"), before.lastIndexOf("{"), before.lastIndexOf("}"));
  return PROPERTY_COLON_RE.test(before.slice(cut + 1));
}

/**
 * Does this hex match read as an issue reference rather than a color? (#1534)
 *
 * `#1364` is a syntactically valid `#RGBA`, so the old scan reported it as a
 * raw color whenever its line happened to contain a CSS keyword — and
 * `forced-colors`, `borderline` and `styles` all contain one, inside string
 * literals included. Past issue #1000 that is the common shape, and roughly 6
 * of 16 leading digits produce a valid hex character.
 *
 * The narrowing is deliberately as small as it can be: it fires ONLY on a body
 * with no `a`-`f` character anywhere AND no color-value position. Any hex
 * carrying a hex letter keeps the previous behavior exactly, and an
 * all-decimal-digit gray (`#333`, `#333333`) is still caught wherever a color
 * can actually appear.
 *
 * Residual, accepted: `console.warn("[theme] border mismatch: #1364")` still
 * reports, because `mismatch:` reads as a property colon. That is why `main()`
 * names the issue-reference possibility in its output.
 */
export function isLikelyIssueReference(
  line: string,
  index: number,
  raw: string,
  spans?: LiteralSpan[],
): boolean {
  if (!ALL_DECIMAL_DIGITS_RE.test(raw.slice(1))) return false;
  return !isColorValuePosition(line, index, raw, spans);
}

/**
 * Bundle-token blocklist (issue #799 / Conflict #6 in the design-system-impl plan).
 *
 * These hex values were lifted from the redesign-bundle assets
 * (docs/design-system-impl/bundle/extracted/*.{css,svelte,html}) and are NOT
 * part of the production-approved `--tandem-*` palette in index.html. They must never
 * appear in src/client because the audit-doc-plus-reviewer-attention pathway
 * is too soft a gate as bundle-explicit ports expand in later phases.
 *
 * Values are normalized: lowercase, 3-char shorthand expanded to 6-char so
 * `#fff` and `#ffffff` compare equal. Pure neutrals (`#000`/`#000000`,
 * `#fff`/`#ffffff`) are intentionally omitted — they are foundational CSS
 * primitives used for masks/gradients, not bundle-origin design tokens.
 * Approved bundle colors (e.g. `#d97757`, `#e89a78`) are also omitted:
 * production already exposes them via `--tandem-author-claude` tokens.
 *
 * Adding a new bundle adoption? First add the hex to index.html's `:root` (or
 * the matching theme block) under a new `--tandem-*` token, then remove it
 * from this set. The CI gate is the contract — do not weaken it by
 * deletion-only.
 */
export const BUNDLE_BLOCKLIST_HEX: ReadonlySet<string> = new Set([
  "#1095d4",
  // Prototype dark-theme stand-in in `D7 - Onboarding Tutorial.html`'s BrandMenu
  // swatch mock. Production has --tandem-swatch-dark for this; cluster 3.11 ports
  // D7, so guard against the literal leaking in. (2026-05-27 refreshed-bundle pass.)
  "#1e1e2e",
  "#222222",
  "#28c840",
  "#29261b",
  "#2a78a4",
  "#2d8a5e",
  "#2a1215",
  "#2a251f",
  "#34c759",
  "#3b7dd8",
  "#5b5bd6",
  "#5b9f4d",
  "#5a4a2a",
  "#5c2b2e",
  "#666666",
  "#7ac8ed",
  "#999999",
  "#b25bd6",
  "#ecece6",
  "#f57018",
  "#aaaaaa",
  "#bbbbbb",
  "#c96442",
  "#cccccc",
  "#dddddd",
  "#e81123",
  "#f0eee9",
  "#f0f0f0",
  "#faf9f5",
  "#febc2e",
  "#fef4a8",
  "#ff5f57",
  "#ff8a80",
]);

/**
 * Normalize a hex string (`#abc`, `#aaBBcc`, `#abcdef12`) to a comparable
 * lowercase 6-char form (`#aabbcc`). 3- and 4-char shorthands expand the rgb
 * component (4-char drops alpha); 8-char `#rrggbbaa` also drops alpha. So a
 * bundle color with an alpha suffix still matches its base entry. Returns
 * `null` for malformed input.
 *
 * Scope: only 3/4/6/8-digit hex bodies are recognized. Tokens with 9+ hex
 * digits (e.g. `#c964421234`) are out of scope and return `null` — they also
 * never reach this function because `HEX_RE`'s trailing `\b` won't match a
 * blocklisted prefix embedded in a longer hex-like token. Such tokens are not
 * valid CSS colors; treating an arbitrary-length hex run as a maskable bundle
 * color would risk flagging unrelated identifiers/hashes.
 */
export function normalizeHexForBlocklist(raw: string): string | null {
  const m = /^#([0-9a-fA-F]{3,8})$/.exec(raw);
  if (!m) return null;
  const body = m[1].toLowerCase();
  if (body.length === 3 || body.length === 4) {
    return `#${body[0]}${body[0]}${body[1]}${body[1]}${body[2]}${body[2]}`;
  }
  if (body.length === 6) return `#${body}`;
  if (body.length === 8) return `#${body.slice(0, 6)}`;
  return null;
}

function hasCssIndicator(line: string): boolean {
  return CSS_KEYWORDS.some((kw) => line.includes(kw));
}

function isNeutralRgba(line: string, matchIndex: number): boolean {
  const parenPos = line.indexOf("(", matchIndex);
  if (parenPos === -1) return false;
  const window = line.slice(parenPos + 1, parenPos + 21);
  return NEUTRAL_RE.test(window);
}

interface CommentState {
  inBlockComment: boolean;
  inHtmlComment: boolean;
}

/**
 * Mask comment regions in a single line while preserving column indices so
 * violation positions stay accurate. Maintains running state across lines for
 * multi-line CSS block comments (`/* ... *\/`) and HTML comments
 * (`<!-- ... -->`). HTML comments are recognized only when `html` is true,
 * which the caller sets for `.html` and `.svelte` files (both use `<!-- -->`
 * markup); for `.ts`/`.js`/`.css` files `<!--` is left as-is.
 *
 * Block comments and HTML comments are masked (replaced with spaces). A leading
 * `//` line comment (after whitespace) masks the remainder of the line, but
 * only when not already inside a block/HTML comment — matching the prior
 * line-start `//` skip behavior without dropping code that precedes a mid-line
 * `/*` opener.
 *
 * Known limitation: this scanner has no string-literal awareness, so a `/*`
 * (or, in `.svelte`/`.html`, a `<!--`) inside a string literal is treated as a
 * comment opener and masks the rest of the literal — a potential false
 * negative. This matches the prior regex-based behavior (which was equally
 * string-unaware) and is an accepted tradeoff for a lint gate; full
 * string-literal parsing is out of scope.
 */
function maskComments(line: string, state: CommentState, html: boolean): string {
  const out: string[] = [];
  let i = 0;
  const n = line.length;

  while (i < n) {
    if (state.inBlockComment) {
      const close = line.indexOf("*/", i);
      if (close === -1) {
        // Rest of line is inside the block comment.
        out.push(" ".repeat(n - i));
        i = n;
      } else {
        out.push(" ".repeat(close + 2 - i));
        i = close + 2;
        state.inBlockComment = false;
      }
      continue;
    }

    if (state.inHtmlComment) {
      const close = line.indexOf("-->", i);
      if (close === -1) {
        out.push(" ".repeat(n - i));
        i = n;
      } else {
        out.push(" ".repeat(close + 3 - i));
        i = close + 3;
        state.inHtmlComment = false;
      }
      continue;
    }

    // Not currently inside a comment: find the next comment opener.
    const blockOpen = line.indexOf("/*", i);
    const htmlOpen = html ? line.indexOf("<!--", i) : -1;
    // A line-comment opener only counts when everything before the `//` (from
    // the absolute start of the line) is whitespace, preserving the original
    // `trimmed.startsWith("//")` skip semantics for indented comments.
    const slashes = line.indexOf("//", i);
    const lineCommentOpen = slashes !== -1 && line.slice(0, slashes).trim() === "" ? slashes : -1;

    const candidates = [blockOpen, htmlOpen, lineCommentOpen].filter((p) => p !== -1);
    if (candidates.length === 0) {
      out.push(line.slice(i));
      break;
    }

    const next = Math.min(...candidates);
    // Emit the visible code before the comment opener.
    out.push(line.slice(i, next));

    if (next === lineCommentOpen) {
      // Mask the rest of the line.
      out.push(" ".repeat(n - next));
      i = n;
    } else if (next === blockOpen && (htmlOpen === -1 || blockOpen <= htmlOpen)) {
      state.inBlockComment = true;
      out.push("  "); // mask the `/*`
      i = next + 2;
    } else {
      state.inHtmlComment = true;
      out.push("    "); // mask the `<!--`
      i = next + 4;
    }
  }

  return out.join("");
}

export function collectFiles(dir: string): string[] {
  const entries = readdirSync(dir, { recursive: true, withFileTypes: true });
  return entries
    .filter((e) => e.isFile() && /\.[tj]sx?$|\.svelte$|\.css$|\.html$/.test(e.name))
    .map((e) => toSlash(join(e.parentPath, e.name)));
}

export function shouldSkipFile(relPath: string): boolean {
  const rel = toSlash(relPath);
  return SKIP_FILE_RELS.has(rel) || /\.(test|spec)\.[tj]sx?$/.test(rel);
}

export function checkContent(content: string, rel: string): string[] {
  const violations: string[] = [];

  const lines = content.split("\n");
  // `.svelte` files use the same `<!-- -->` markup comments as `.html`, and
  // both are in `collectFiles` scope, so they get the same HTML-comment gate.
  const isHtml = rel.endsWith(".html") || rel.endsWith(".svelte");
  const state: CommentState = { inBlockComment: false, inHtmlComment: false };
  // Running string-literal state, so a template literal or a wrapped `style="…"`
  // attribute is still judged as ONE literal on its continuation lines. Without
  // it those lines fall back to the per-token walk-back this design replaced —
  // silently, and in both directions.
  let openLiteral: OpenLiteral | null = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Mask out comment regions (CSS block, HTML, and line-start `//`) while
    // preserving column indices. The masked line is used for BOTH the
    // CSS-keyword indicator checks and the regex passes so commented-out hex
    // and keywords never produce false positives — including comments opened
    // mid-line after live code, and code that follows a mid-line comment close.
    const scanLine = maskComments(line, state, isHtml);
    const literals = scanStringLiterals(scanLine, openLiteral);
    openLiteral = literals.outgoing;

    // Per-line dedupe of hex matches by character index so the bundle-blocklist
    // pass below does not double-report a position the CSS-keyword pass
    // already flagged. Position-keyed (not string-keyed) so multiple distinct
    // occurrences of the same hex on the same line each get reported by
    // whichever pass owns them.
    const reportedHexAtIndex = new Set<number>();

    HEX_RE.lastIndex = 0;
    let hexMatch: RegExpExecArray | null;
    while ((hexMatch = HEX_RE.exec(scanLine)) !== null) {
      if (!hasCssIndicator(scanLine)) continue;
      const raw = hexMatch[0];
      // #1534: the CSS-keyword heuristic is a line-level substring test, so it
      // fires on prose that merely mentions a color. Two narrowings keep it
      // from reporting an issue reference as a color — both scoped to THIS
      // pass; the bundle blocklist below matches on exact value and is
      // deliberately left alone.
      // Both narrowings apply ONLY to an all-decimal-digit body. A hex carrying
      // an `a`-`f` character keeps the previous behaviour exactly, at every
      // length — including a letter-bearing 5/7-digit body, which is not a CSS
      // color but IS the shape of a typo'd one (`#abcdef1`), so it must still
      // report. Gating the length guard on all-digit-ness is what makes the
      // "letters are unaffected" claim in docs/semantic-tokens.md true.
      // Both `continue`s leave `reportedHexAtIndex` unset for this position,
      // deliberately: the skip is a statement about the CSS-KEYWORD pass only.
      // The bundle pass below then still gets its look at the same token, which
      // is what keeps `#222222` in prose a violation (it matches on exact
      // value, which is strong evidence regardless of position).
      const allDigits = ALL_DECIMAL_DIGITS_RE.test(raw.slice(1));
      if (allDigits && !VALID_HEX_COLOR_BODY_LENGTHS.has(raw.length - 1)) continue;
      // Calls the exported predicate rather than re-inlining it: two copies of
      // one rule let an edit to either drift, and the tests pin the helper.
      if (isLikelyIssueReference(scanLine, hexMatch.index, raw, literals.spans)) continue;
      violations.push(`${rel}:${i + 1}: ${raw}`);
      reportedHexAtIndex.add(hexMatch.index);
    }

    // Bundle-blocklist pass: any hex in BUNDLE_BLOCKLIST_HEX is forbidden
    // regardless of CSS-keyword context. Catches bundle-origin drift in
    // string literals, prop defaults, and other non-CSS surfaces that the
    // CSS-keyword heuristic intentionally skips.
    HEX_RE.lastIndex = 0;
    let bundleHexMatch: RegExpExecArray | null;
    while ((bundleHexMatch = HEX_RE.exec(scanLine)) !== null) {
      if (reportedHexAtIndex.has(bundleHexMatch.index)) continue;
      const raw = bundleHexMatch[0];
      const normalized = normalizeHexForBlocklist(raw);
      if (normalized && BUNDLE_BLOCKLIST_HEX.has(normalized)) {
        violations.push(`${rel}:${i + 1}: ${raw} [bundle-blocklist]`);
        reportedHexAtIndex.add(bundleHexMatch.index);
      }
    }

    RGBA_RE.lastIndex = 0;
    let rgbaMatch: RegExpExecArray | null;
    while ((rgbaMatch = RGBA_RE.exec(scanLine)) !== null) {
      if (!isNeutralRgba(scanLine, rgbaMatch.index)) {
        violations.push(`${rel}:${i + 1}: ${rgbaMatch[0]}`);
      }
    }

    BORDER_RADIUS_RE.lastIndex = 0;
    let radiusMatch: RegExpExecArray | null;
    while ((radiusMatch = BORDER_RADIUS_RE.exec(scanLine)) !== null) {
      violations.push(`${rel}:${i + 1}: ${radiusMatch[0]}`);
    }

    if (scanLine.includes("style")) {
      BOX_SHADOW_RE.lastIndex = 0;
      let shadowMatch: RegExpExecArray | null;
      while ((shadowMatch = BOX_SHADOW_RE.exec(scanLine)) !== null) {
        violations.push(`${rel}:${i + 1}: ${shadowMatch[0]}`);
      }
    }
  }

  return violations;
}

export function checkFile(filePath: string, root = ROOT): string[] {
  const rel = toSlash(relative(root, filePath));

  if (shouldSkipFile(rel)) return [];

  const content = readFileSync(filePath, "utf-8");
  return checkContent(content, rel);
}

/**
 * A reported violation whose token is `#` + exactly FOUR decimal digits.
 *
 * Four is the only length where the collision is real: a reported all-digit
 * token of length 3, 6 or 8 (`#000`, `#333333`, `#000000`) is a gray, and
 * telling its author it "may be an issue reference … drop the `#`" is advice
 * that produces `color: 000000`. Five- and seven-digit runs never reach the
 * output at all, so four is what is left.
 */
const REPORTED_ALL_DIGIT_HEX_RE = /:\s*#[0-9]{4}(?![0-9])/;

/**
 * Guidance printed under the violation list (#1534).
 *
 * Two parts. The `Fix:` line is unconditional — until now only the Claude
 * PostToolUse hook printed any remedy, so the pre-commit/lint-staged path (the
 * one #1534 was hit on) reported a violation with no instruction at all.
 *
 * The `Note:` is conditional on a reported token being all decimal digits. The
 * detector no longer reports issue references sitting in prose, but one with a
 * governing colon (`"[theme] border mismatch: #1364"`) still reads as a
 * declaration value and reports. Naming the possibility is what turns "raw hex
 * color violation on a line containing no color" into something actionable —
 * option 3 of the issue, kept alongside the detector narrowing rather than
 * instead of it.
 */
export function buildErrorGuidance(errors: readonly string[]): string {
  let out =
    "Fix: use a semantic var(--tandem-*) token, or import the value from src/client/utils/colors.ts.\n";
  if (errors.some((v) => REPORTED_ALL_DIGIT_HEX_RE.test(v))) {
    out +=
      "Note: a token like `#1364` may be an issue reference rather than a color.\n" +
      '      If so, move the reference into a comment or drop the `#` ("issue 1364").\n';
  }
  return out;
}

export function main(args = process.argv.slice(2)): void {
  const files = args.length > 0 ? args.map((f) => toSlash(resolve(f))) : collectFiles(CLIENT_DIR);
  const allViolations: string[] = [];

  for (const file of files) {
    allViolations.push(...checkFile(file));
  }

  const warnings = allViolations.filter(
    (v) => v.includes("border-radius:") || v.includes("box-shadow:"),
  );
  const errors = allViolations.filter((v) => !warnings.includes(v));

  for (const v of errors) {
    process.stderr.write(`${v}\n`);
  }
  for (const v of warnings) {
    process.stderr.write(`${v} [warn]\n`);
  }

  if (errors.length > 0) {
    process.stderr.write(
      `\ncheck-semantic-tokens: ${errors.length} error(s), ${warnings.length} warning(s) found\n`,
    );
    process.stderr.write(buildErrorGuidance(errors));
    process.exit(1);
  } else if (warnings.length > 0) {
    process.stderr.write(`\ncheck-semantic-tokens: ${warnings.length} warning(s) found\n`);
    process.exit(0);
  } else {
    process.stderr.write("check-semantic-tokens: clean\n");
    process.exit(0);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
