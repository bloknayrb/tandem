#!/usr/bin/env node
/**
 * Reproducible generator for the v1.0 performance-gate fixture.
 *
 * The gate (docs/roadmap.md §"Performance gate") calls for "a ~50-page markdown
 * document produced by a checked-in generator script". This is that script.
 *
 * ## What "~50 pages" means here
 *
 * Markdown has no pages, so the scale axis is defined once, here, and must not
 * drift silently: **450 words/page x 50 pages = ~22,500 words**. That matches
 * the "Documents over ~50 pages may be slow to render" entry in the roadmap's
 * Known Limitations, which is the claim this gate exists to verify.
 *
 * ## Why it is not 22,500 words of lorem
 *
 * Flat prose would exercise almost none of the pipeline whose cost we are
 * measuring. The document carries headings (outline panel + heading-collapse),
 * FLAT bullet and ordered lists, tables, fenced code, inline marks (bold,
 * italic, inline code) and internal links, because those are the node and mark
 * types the decoration pipeline actually walks.
 *
 * Read that list as exhaustive, not as a claim of coverage — see "Deliberately
 * excluded" below for what it does NOT contain.
 *
 * ## Why it emits annotations too
 *
 * This is the part that is easy to get wrong. Scroll cost in Tandem is dominated
 * by the margin pipeline: `marginPressure.resolveCrowding` simulates the entire
 * card stack from raw anchor tops plus the annotation model, feeding an elastic
 * column. A long document scrolled with zero annotations does not exercise that
 * at all -- a pass would be no evidence, and a failure would not localize. So
 * the generator emits a companion `*.annotations.json` seed describing where
 * annotations should be created, which the harness applies before measuring.
 *
 * ## Determinism
 *
 * Seeded PRNG, no Math.random(). The roadmap says to "note the seed", which only
 * means anything if the seed reproduces the document byte-for-byte. Re-running
 * with the same seed rewrites identical content.
 *
 * ## Deliberately excluded
 *
 * Inline images (#153). An image-heavy document measures image decode, not the
 * editor. Whether image density degrades scroll is a real question and a
 * separate fixture -- not this one.
 *
 * NESTED lists, blockquotes, task lists, footnotes and reference links (#981).
 * None of these are emitted. Adding them is a fixture-DESIGN change, not a
 * tweak: it moves the document the recorded numbers are compared against, and
 * it interacts with the single-line paragraph filter below (multi-line blocks
 * are excluded from seed candidates for a reason found by running the gate).
 * Worth its own PR; until then nobody should read coverage into this fixture
 * that it does not have.
 *
 * ONE annotation shape. Every seed becomes a pending `comment` authored by
 * Claude, so the load is homogeneous: one type, one author, one status. All of
 * them are RIGHT-margin annotations, which means the left margin track
 * presence-collapses to `off` and exactly one of the two tracks is measured.
 *
 * Usage:
 *   node scripts/fixtures/make-perf-doc.mjs [--seed N] [--words N]
 *                                           [--annotations N] [--out PATH]
 */
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..", "..");

/** The scale definition. Changing either number changes what the gate measures. */
const WORDS_PER_PAGE = 450;
const TARGET_PAGES = 50;
const DEFAULT_WORDS = WORDS_PER_PAGE * TARGET_PAGES; // 22,500

/**
 * Annotation count for the margin-pressure load. Chosen to be a heavy-but-real
 * review pass rather than a stress test: roughly one per page.
 */
const DEFAULT_ANNOTATIONS = 50;

const DEFAULT_SEED = 20260805;
const DEFAULT_OUT = path.join(REPO_ROOT, "tests", "perf", ".generated", "perf-50-page.md");

/** mulberry32 -- small, fast, and stable across Node versions. */
function makeRng(seed) {
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const WORDS = `document editor annotation margin anchor offset range paragraph heading
   revision comment suggestion draft section clause outline collaboration
   markdown structure content review pipeline coordinate position boundary
   context selection reference threshold behaviour constraint invariant
   sequence provenance narrative emphasis interval fragment lattice cadence
   register premise artifact tolerance signal residue interface manuscript`
  .split(/\s+/)
  .filter(Boolean);

function pick(rng, arr) {
  return arr[Math.floor(rng() * arr.length)];
}

function sentence(rng, minWords = 8, maxWords = 22) {
  const n = minWords + Math.floor(rng() * (maxWords - minWords));
  const words = [];
  for (let i = 0; i < n; i++) {
    let w = pick(rng, WORDS);
    // Inline marks, sparsely -- enough to exercise the mark pipeline without
    // making the prose unreadable if a human ever opens the fixture.
    const roll = rng();
    if (roll < 0.02) w = `**${w}**`;
    else if (roll < 0.04) w = `*${w}*`;
    else if (roll < 0.05) w = `\`${w}\``;
    words.push(w);
  }
  const s = words.join(" ");
  return s.charAt(0).toUpperCase() + s.slice(1) + ".";
}

function paragraph(rng) {
  const n = 3 + Math.floor(rng() * 4);
  return Array.from({ length: n }, () => sentence(rng)).join(" ");
}

function bulletList(rng) {
  const n = 3 + Math.floor(rng() * 4);
  return Array.from({ length: n }, () => `- ${sentence(rng, 5, 14)}`).join("\n");
}

function orderedList(rng) {
  const n = 3 + Math.floor(rng() * 3);
  return Array.from({ length: n }, (_, i) => `${i + 1}. ${sentence(rng, 5, 14)}`).join("\n");
}

function table(rng) {
  const rows = 3 + Math.floor(rng() * 3);
  const head = "| Field | Behaviour | Notes |\n| --- | --- | --- |";
  const body = Array.from(
    { length: rows },
    () => `| ${pick(rng, WORDS)} | ${sentence(rng, 3, 7)} | ${pick(rng, WORDS)} |`,
  ).join("\n");
  return `${head}\n${body}`;
}

function codeBlock(rng) {
  const lines = 3 + Math.floor(rng() * 5);
  const body = Array.from(
    { length: lines },
    () => `  const ${pick(rng, WORDS)} = ${Math.floor(rng() * 1000)};`,
  ).join("\n");
  return "```ts\n" + body + "\n```";
}

function countWords(text) {
  return text.split(/\s+/).filter(Boolean).length;
}

function parseArgs(argv) {
  const out = {
    seed: DEFAULT_SEED,
    words: DEFAULT_WORDS,
    annotations: DEFAULT_ANNOTATIONS,
    out: DEFAULT_OUT,
  };
  for (let i = 0; i < argv.length; i++) {
    const [flag, inlineValue] = argv[i].split("=");
    const value = inlineValue ?? argv[++i];
    if (flag === "--seed") out.seed = Number(value);
    else if (flag === "--words") out.words = Number(value);
    else if (flag === "--annotations") out.annotations = Number(value);
    else if (flag === "--out") out.out = path.resolve(value);
    else throw new Error(`Unknown argument: ${argv[i]}`);
  }
  for (const key of ["seed", "words", "annotations"]) {
    if (!Number.isFinite(out[key])) throw new Error(`--${key} must be a number`);
  }
  // The annotation seed path is derived by REPLACING a `.md` suffix. With any
  // other extension that replace is a no-op and the second write silently
  // overwrites the markdown with JSON.
  if (!out.out.endsWith(".md")) {
    throw new Error(
      `--out must end in .md — the annotation seed path is derived by replacing that suffix ` +
        `(got ${out.out})`,
    );
  }
  return out;
}

function build({ seed, words: targetWords, annotations: annotationCount }) {
  const rng = makeRng(seed);
  const blocks = [`# Performance Fixture`, ""];
  blocks.push(
    `Generated by \`scripts/fixtures/make-perf-doc.mjs\` (seed ${seed}). ` +
      `Do not edit by hand -- regenerate.`,
    "",
  );

  let words = countWords(blocks.join(" "));
  let sectionIndex = 0;
  // A section is ~2 pages, so an h2 lands roughly every 900 words.
  const headingIds = [];

  while (words < targetWords) {
    sectionIndex++;
    const title = `Section ${sectionIndex} — ${pick(rng, WORDS)} ${pick(rng, WORDS)}`;
    headingIds.push(title);
    blocks.push(`## ${title}`, "");
    words += countWords(title);

    const subsections = 2 + Math.floor(rng() * 2);
    for (let s = 0; s < subsections && words < targetWords; s++) {
      const sub = `### ${pick(rng, WORDS)} ${pick(rng, WORDS)}`;
      blocks.push(sub, "");
      words += countWords(sub);

      const paras = 2 + Math.floor(rng() * 3);
      for (let p = 0; p < paras && words < targetWords; p++) {
        const para = paragraph(rng);
        blocks.push(para, "");
        words += countWords(para);
      }

      // Structural variety, rotated so every type recurs throughout the doc
      // rather than clustering at the top.
      const roll = rng();
      let extra = null;
      if (roll < 0.3) extra = bulletList(rng);
      else if (roll < 0.5) extra = orderedList(rng);
      else if (roll < 0.62) extra = table(rng);
      else if (roll < 0.74) extra = codeBlock(rng);

      if (extra) {
        blocks.push(extra, "");
        words += countWords(extra);
      }

      // Internal links, pointing at already-emitted headings so they resolve.
      if (headingIds.length > 1 && rng() < 0.25) {
        const target = pick(rng, headingIds);
        const anchor = target
          .toLowerCase()
          .replace(/[^\w\s-]/g, "")
          .trim()
          .replace(/\s+/g, "-");
        const link = `See [${target}](#${anchor}) for the surrounding argument.`;
        blocks.push(link, "");
        words += countWords(link);
      }
    }
  }

  const markdown = blocks.join("\n") + "\n";

  // --- Annotation seed -----------------------------------------------------
  // Emitted as quote targets rather than offsets. Offsets would bind the seed
  // to this exact byte layout and to one coordinate system; a quote is resolved
  // by the harness through the normal anchoring path, which is also the path
  // whose cost we want in the measurement.
  /**
   * Strip inline markdown syntax to the text the EDITOR will hold.
   *
   * This is load-bearing, not cosmetic. Quotes sliced straight out of the
   * markdown source can contain `**`, `*` and backticks, which are marks in the
   * Y.Doc rather than characters -- `getElementText()` never returns them. A
   * quote carrying one is unresolvable, and the failure would not surface until
   * the harness ran and silently anchored fewer annotations than the margin
   * load depends on.
   */
  const toPlainText = (md) =>
    md
      .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1") // links -> label
      .replace(/\*\*([^*]+)\*\*/g, "$1")
      .replace(/\*([^*]+)\*/g, "$1")
      .replace(/`([^`]+)`/g, "$1")
      .replace(/\s+/g, " ")
      .trim();

  const paragraphs = markdown
    .split("\n\n")
    .map((b) => b.trim())
    .filter(
      (b) =>
        b &&
        !b.startsWith("#") &&
        !b.startsWith("|") &&
        !b.startsWith("```") &&
        // The generator's own preamble is boilerplate, not body prose.
        !b.startsWith("Generated by") &&
        // Single-line blocks ONLY -- i.e. real paragraphs, never lists.
        // `getElementText()` separates nested block children (list items,
        // paragraphs inside list items) with "\n", while the plain-text
        // flattening below turns that same newline into a space. A quote
        // spanning two list items therefore exists in the seed but never in
        // the document, and anchors nowhere. Found by running the gate: 6 of
        // 50 seeds silently failed to anchor.
        !b.includes("\n"),
    )
    .map(toPlainText);

  // Uniqueness must be checked against the WHOLE document, not just the body
  // paragraphs annotations are drawn from: the editor's text content includes
  // headings, tables and code blocks, so a quote that is unique among
  // paragraphs can still collide with text in one of those and anchor
  // ambiguously.
  const plainDoc = toPlainText(markdown);
  const occurrences = (haystack, needle) => haystack.split(needle).length - 1;

  const quotes = [];
  const seen = new Set();
  // Spread annotations evenly across the document so the margin stack is loaded
  // along its whole length, not bunched where the first ones happened to land.
  for (let i = 0; i < annotationCount && paragraphs.length > 0; i++) {
    const idx = Math.floor((i / annotationCount) * paragraphs.length);
    // Walk forward from the ideal slot if that paragraph yields an unusable
    // quote (too short, or a duplicate of one already claimed). Dropping the
    // slot instead would silently under-fill the margin load the whole gate
    // depends on, and would do it differently for every seed.
    let quote = null;
    for (let probe = 0; probe < paragraphs.length; probe++) {
      const para = paragraphs[(idx + probe) % paragraphs.length];
      // A distinctive middle slice: long enough to be unique, short enough that
      // a single annotation does not span the whole paragraph.
      const start = Math.floor(para.length * 0.25);
      const candidate = para.slice(start, start + 40).trim();
      if (candidate.length < 12 || seen.has(candidate)) continue;
      // Must occur exactly once in the whole document, or the anchor is
      // ambiguous and which range gets annotated is arbitrary.
      if (occurrences(plainDoc, candidate) !== 1) continue;
      quote = candidate;
      break;
    }
    if (!quote) break; // document genuinely has no unclaimed targets left
    seen.add(quote);
    quotes.push(quote);
  }

  // Emit in ascending DOCUMENT-POSITION order, and make that a real invariant
  // rather than an accident of the seed.
  //
  // The probe above wraps modulo `paragraphs.length`, so a late slot whose
  // ideal paragraph (and every paragraph after it) is unusable can wrap around
  // to the front of the document — which would make the emission order
  // non-monotonic for some seeds. The harness treats the LAST seed as the
  // DEEPEST target (it measures create/accept there, because anchoring cost
  // scales with position), so sorting here is what lets it do that safely.
  // Sorting also keeps the numbering in `text` monotonic with position, which
  // is why the label is assigned after the sort, not before.
  const seeds = quotes
    .map((quote) => ({ quote, at: plainDoc.indexOf(quote) }))
    .sort((a, b) => a.at - b.at)
    .map(({ quote }, i) => ({ quote, text: `Perf fixture annotation ${i + 1}.` }));

  return { markdown, seeds, sections: sectionIndex, words: countWords(markdown) };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const { markdown, seeds, sections, words } = build(args);

  await mkdir(path.dirname(args.out), { recursive: true });
  await writeFile(args.out, markdown, "utf8");

  const seedPath = args.out.replace(/\.md$/, ".annotations.json");
  // `requested` travels with the seed so the harness can pin the load it is
  // measuring against, rather than inferring it from however many seeds a
  // hand-run generator happened to emit.
  await writeFile(
    seedPath,
    JSON.stringify({ seed: args.seed, requested: args.annotations, annotations: seeds }, null, 2) +
      "\n",
    "utf8",
  );

  const pages = (words / WORDS_PER_PAGE).toFixed(1);
  console.log(`perf fixture written: ${args.out}`);
  console.log(`  seed          ${args.seed}`);
  console.log(`  words         ${words} (~${pages} pages at ${WORDS_PER_PAGE} w/page)`);
  console.log(`  sections      ${sections}`);
  console.log(`  annotations   ${seeds.length} -> ${seedPath}`);

  // A short fixture is a FAILURE, not a warning. The margin load is the whole
  // premise of the gate; a run against 37 annotations is not a run against 50,
  // and a warning on stdout is not something a harness can act on. Exiting
  // non-zero propagates through globalSetup's `execFileSync`.
  if (seeds.length < args.annotations) {
    console.error(
      `  ERROR: requested ${args.annotations} annotations, emitted ${seeds.length}. ` +
        `Duplicate or too-short quote targets were skipped — the document is too small ` +
        `or too repetitive to carry the requested load.`,
    );
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
