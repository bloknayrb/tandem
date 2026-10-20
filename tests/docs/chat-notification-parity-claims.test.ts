import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  INVISIBLE_FORMAT_RANGES,
  NOTIFICATION_BODY_MAX_CHARS,
  NOTIFICATION_TITLE_MAX_CHARS,
  TEST_NOTIFICATION_TEXT,
} from "../../src/client/notifications/notification-text";
import { matchRustBrace, REPO_ROOT, rustSourceDefining } from "./rust-sources.js";

/**
 * Pins `src/client/notifications/notification-text.ts` to the Rust it mirrors
 * in `src-tauri/src/notifications.rs` (#2168).
 *
 * The desktop path cleans notification text twice, once on each side, and the
 * browser path only once, in TypeScript. If the two drift, nothing else fails:
 * the desktop still looks right (Rust has the final say), and the browser
 * quietly shows a character Rust would have dropped, or a longer title. Every
 * value here is DERIVED FROM THE RUST SOURCE, never from a list kept in this
 * file, so the test compares the two sides rather than the client against
 * itself.
 *
 * **The `matches!` parse fails closed.** A parser that collects the
 * `'\u{X}'..='\u{Y}'` arms it recognises and ignores the rest would stay green
 * when someone adds an arm in another spelling (`'\x7F'`, a named constant, a
 * guard). So after removing every recognised token, `|` and whitespace, the
 * body must be empty: an arm this parser does not understand is a failure, not
 * a skip.
 *
 * Same idiom as `startup-open-failure-wiring-claims.test.ts`: located by
 * construct through `rustSourceDefining`, read from `code` (comments and test
 * modules stripped), bodies bounded with `matchRustBrace`.
 */

/** The `{ … }` body of `fn <name>(`, from the one Rust file that defines it. */
function rustFnBody(name: string): string {
  const sig = new RegExp(`fn ${name}\\s*\\(`);
  const src = rustSourceDefining(sig, name).code;
  const from = src.search(sig);
  const open = src.indexOf("{", from);
  return src.slice(open, matchRustBrace(src, open) + 1);
}

/** The value of `const <name>: <type> = <value>;`, from the one file that defines it. */
function rustConstValue(name: string): string {
  const decl = new RegExp(`const ${name}\\s*:[^=]*=\\s*([^;]+);`, "g");
  const matches = Array.from(rustSourceDefining(decl, name).code.matchAll(decl));
  // Exactly one: a second, cfg-gated definition would be a per-platform value
  // this test could otherwise compare only the first of.
  expect(matches.length, `const ${name} must be defined exactly once`).toBe(1);
  return (matches[0]?.[1] ?? "").trim();
}

/** A plain Rust string literal with no escapes. Anything else fails rather than guessing. */
function rustPlainString(literal: string, what: string): string {
  const m = literal.match(/^"([^"\\]*)"$/);
  expect(m, `${what} is not a plain, escape-free string literal: ${literal}`).not.toBeNull();
  return m?.[1] ?? "";
}

function stripTsComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

const CHAR = String.raw`'\\u\{([0-9A-Fa-f]{1,6})\}'`;
const ARM = new RegExp(`${CHAR}(?:\\s*\\.\\.=\\s*${CHAR})?`, "g");

describe("notification text: TypeScript mirrors Rust (#2168)", () => {
  it("INVISIBLE_FORMAT_RANGES matches is_invisible_format arm for arm", () => {
    const body = rustFnBody("is_invisible_format");
    const m = body.match(/^\{\s*matches!\s*\(\s*c\s*,([\s\S]*)\)\s*\}$/);
    expect(m, "is_invisible_format is no longer a single `matches!(c, …)`").not.toBeNull();
    const arms = m?.[1] ?? "";

    const ranges = Array.from(arms.matchAll(ARM), (a) => {
      const lo = Number.parseInt(a[1], 16);
      return [lo, a[2] === undefined ? lo : Number.parseInt(a[2], 16)];
    });
    // Fail closed: anything left over is an arm this parser cannot read.
    const residue = arms.replace(ARM, "").replace(/[|\s]/g, "");
    expect(
      residue,
      "is_invisible_format has an arm in a spelling this test does not parse. Extend the " +
        "parser (and INVISIBLE_FORMAT_RANGES) rather than letting it pass unread.",
    ).toBe("");
    expect(ranges.length, "positive control: the parse found no arms").toBeGreaterThan(0);
    expect(ranges).toEqual(INVISIBLE_FORMAT_RANGES.map(([lo, hi]) => [lo, hi]));
  });

  it("is_line_breaking is still exactly Cc plus U+2028 and U+2029", () => {
    // The TS side hand-codes Cc as U+0000–U+001F and U+007F–U+009F, which is
    // what `char::is_control` tests. Exact match, so a new term on the Rust
    // side fails here until the TS side gets it too.
    const body = rustFnBody("is_line_breaking").replace(/\s+/g, " ");
    expect(body).toBe(String.raw`{ c.is_control() || c == '\u{2028}' || c == '\u{2029}' }`);
  });

  it("clean() itself is unchanged, and applies the two caps", () => {
    // The parts above pin what clean() calls; this pins clean() itself, so a
    // new filter, normalisation or ellipsis added straight into it fails here
    // until cleanNotificationText gets it too. And it pins the two call sites,
    // so the caps compared below are the ones the desktop actually applies.
    const body = rustFnBody("clean").replace(/\s+/g, " ");
    expect(body).toBe(
      "{ let flattened: String = text .chars() .filter(|c| !is_invisible_format(*c)) " +
        ".map(|c| if is_line_breaking(c) { ' ' } else { c }) .collect(); " +
        "let trimmed = flattened.trim(); if trimmed.chars().count() <= max { " +
        "return trimmed.to_owned(); } " +
        "let mut out: String = trimmed.chars().take(max.saturating_sub(1)).collect(); " +
        "out.truncate(out.trim_end().len()); out.push('…'); out }",
    );
    const code = rustSourceDefining(/fn clean\s*\(/, "clean").code;
    expect(code).toContain("clean(title, MAX_TITLE_CHARS)");
    expect(code).toContain("clean(body, MAX_BODY_CHARS)");
  });

  it("the caps match MAX_TITLE_CHARS / MAX_BODY_CHARS", () => {
    expect(Number(rustConstValue("MAX_TITLE_CHARS"))).toBe(NOTIFICATION_TITLE_MAX_CHARS);
    expect(Number(rustConstValue("MAX_BODY_CHARS"))).toBe(NOTIFICATION_BODY_MAX_CHARS);
  });

  it("the test notification text matches TEST_TITLE / TEST_BODY", () => {
    expect({
      title: rustPlainString(rustConstValue("TEST_TITLE"), "TEST_TITLE"),
      body: rustPlainString(rustConstValue("TEST_BODY"), "TEST_BODY"),
    }).toEqual(TEST_NOTIFICATION_TEXT);
  });

  it("backend.ts posts TEST_NOTIFICATION_TEXT rather than its own copy", () => {
    const code = stripTsComments(
      readFileSync(join(REPO_ROOT, "src", "client", "notifications", "backend.ts"), "utf8"),
    );
    expect(code).toContain("TEST_NOTIFICATION_TEXT");
    expect(code, "backend.ts holds the test body as a literal again").not.toContain(
      TEST_NOTIFICATION_TEXT.body,
    );
  });
});
