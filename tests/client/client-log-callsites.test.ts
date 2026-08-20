import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The call-site contract for the client log (#1439).
 *
 * `logClientWarning`/`logClientError` feed a report a user pastes into a public
 * GitHub issue, and `buildBugReportUrl` prefills that body — so the user's
 * review step is an opt-out. The privacy control is the API's shape: `scope` and
 * `event` are STATIC LITERALS, so there is nothing to interpolate a document
 * title, a file path, or user input into. TypeScript cannot express
 * "literal only", so it is pinned here.
 *
 * This matters most for the follow-up that migrates the other ~147
 * `console.warn`/`console.error` sites: several of them today do exactly what
 * this forbids (`Editor.svelte` interpolates `resolved.path` into a template
 * literal), and a mechanical sweep would carry that straight into an issue body.
 *
 * ## What this scan does NOT establish
 *
 * It constrains the SHAPE of what a call site may pass, never the CONTENT. A
 * bare identifier is still a value someone chose, and `describeCause`'s string
 * branch captures a `string` cause verbatim — scrubbed and capped, but
 * `redactPaths` collapses the username segment only, so a path cause still names
 * the document. So this makes the follow-up sweep MECHANICAL, not SAFE: it
 * catches the interpolation shapes and leaves a human to judge the values. It
 * is a lower bound on review, not a substitute for it.
 *
 * ## Why the shape of this test is what it is
 *
 * A plain "find the calls and check them" scan fails GREEN, which is the
 * `audit:origins` failure mode CLAUDE.md Critical Rule 2 records. Four ways it
 * can silently pass, and the answer to each:
 *
 *  1. `biome.json` sets `lineWidth: 100`, so a deeply-indented call wraps across
 *     lines. A pattern that cannot parse it simply matches nothing and the
 *     iteration body never runs → the COUNT INVARIANT below (loose occurrences
 *     must EQUAL strict matches) turns "cannot parse" into a failure.
 *  2. `import { logClientWarning as warn }` defeats a callee-name key — plausible,
 *     since `annotation-actions.ts` already binds a local `warn`. → alias check.
 *  3. A one-line forwarding wrapper elsewhere means no scanned file ever contains
 *     a violating literal. → re-export check.
 *  4. Renaming the recorders would leave this asserting nothing. → floor.
 */

const ROOT = join(import.meta.dirname, "..", "..");
const SRC = join(ROOT, "src");
const CLIENT_ROOT = join(SRC, "client");
const MODULE = join(CLIENT_ROOT, "utils", "client-log.ts");
// `.svelte` is not optional: one of the two call sites lives in
// `IntegrationWizardModal.svelte`. (Precedent: `testid-coverage.test.ts`.)
const EXT = [".ts", ".svelte"];

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (EXT.some((e) => full.endsWith(e)) && !full.endsWith(".d.ts")) out.push(full);
  }
  return out;
}

/** Any mention of a recorder call, however it is formatted. */
const LOOSE = /\blogClient(?:Warning|Error)\s*\(/g;

/**
 * A COMPLIANT call. `\s*` throughout (not `.`), so a biome-wrapped multi-line
 * call still matches; the third argument may only be a BARE IDENTIFIER, which
 * rejects a string literal, a template literal, a concatenation, a call such as
 * `String(err)` — and a member expression. Argument three is where untrusted
 * text would actually enter.
 *
 * Member expressions used to be allowed, and that made this scan pass exactly
 * the shape the module doc above cites as the reason the sweep is unsafe:
 * `logClientWarning("editor", "link refused", resolved.path)` scanned clean
 * while landing a document filename in a public issue body. A bare identifier is
 * not a guarantee — see "What this scan does NOT establish" — but reaching INTO
 * an object for a field is the one shape that is nearly always a deliberate
 * detail grab, so it is worth failing. Both current call sites pass a bare
 * `err`; a compliant biome-wrapped call still matches.
 */
const STRICT =
  /\blogClient(?:Warning|Error)\s*\(\s*"[^"\\]*"\s*,\s*"[^"\\]*"\s*(?:,\s*[A-Za-z_$][\w$]*\s*)?,?\s*\)/g;

const files = walk(CLIENT_ROOT).filter((f) => f !== MODULE);

function countOf(text: string, pattern: RegExp): number {
  return text.match(new RegExp(pattern.source, "g"))?.length ?? 0;
}

describe("client-log call sites", () => {
  const callSites = files
    .map((file) => ({ file, text: readFileSync(file, "utf8") }))
    // Never `LOOSE.test(text)`: a /g regex carries `lastIndex` between calls.
    .filter(({ text }) => countOf(text, LOOSE) > 0);

  it("finds the call sites at all", () => {
    // A floor, so a rename or a deletion cannot leave this suite asserting
    // nothing at all while still reporting green.
    const total = callSites.reduce((n, { text }) => n + countOf(text, LOOSE), 0);
    expect(total).toBeGreaterThanOrEqual(2);
  });

  it("passes only string literals for scope and event, and no literal cause", () => {
    const offenders = callSites
      .filter(({ text }) => countOf(text, LOOSE) !== countOf(text, STRICT))
      .map(({ file }) => relative(ROOT, file));
    // A call this cannot parse counts as a violation, never as a skip: an
    // unparseable call site and a compliant one must not look the same.
    expect(offenders).toEqual([]);
  });

  it("imports the recorders under their own names", () => {
    const aliased: string[] = [];
    for (const { file, text } of callSites) {
      for (const match of text.matchAll(/import\s*\{([^}]*)\}\s*from\s*"[^"]*client-log[^"]*"/g)) {
        if (/\bas\b/.test(match[1])) aliased.push(relative(ROOT, file));
      }
    }
    expect(aliased).toEqual([]);
  });

  it("is not re-exported, so no wrapper can hide a call site from this scan", () => {
    const reexports = walk(SRC)
      .filter(
        (file) =>
          /export\s*(?:type\s*)?\{[^}]*logClient(?:Warning|Error)[^}]*\}/.test(
            readFileSync(file, "utf8"),
          ) || /export\s*\*\s*from\s*"[^"]*client-log/.test(readFileSync(file, "utf8")),
      )
      .map((file) => relative(ROOT, file));
    expect(reexports).toEqual([]);
  });
});
