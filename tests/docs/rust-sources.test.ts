import { describe, expect, it } from "vitest";
import { stripRustComments, stripRustTestModules } from "./rust-sources.js";

/**
 * `stripRustComments` (#1861): a `//`/`/*` inside a Rust string, raw string or
 * char literal must not be read as a real comment. The old regex-based
 * version only ever protected the one shape it special-cased (`://` in a
 * URL), so any other in-literal `//`/`/*` corrupted the literal's closing
 * quote and desynced every downstream brace/terminator scanner — either
 * throwing (`matchRustBrace`/`testItemEnd` run off the end of the input) or,
 * worse, silently dropping everything between the corruption and wherever the
 * scanner accidentally resynced. Test 5 below is the regression itself, in
 * the silent direction, which is the one that shipped live on `master`
 * (`src-tauri/src/autostart.rs`) with no failing test pointing at it.
 */
describe("stripRustComments", () => {
  it("does not treat // inside a plain string literal as a comment", () => {
    const src = 'const V: &str = "http://example.com";\nfn after() {}\n';
    const out = stripRustComments(src);
    expect(out).toContain('"http://example.com"');
    expect(out).toContain("fn after() {}");
  });

  it("does not treat // inside a raw string literal as a comment", () => {
    const src = 'const A: &str = r"a // b";\nconst B: &str = r#"c "// d"#;\nfn after() {}\n';
    const out = stripRustComments(src);
    expect(out).toContain('r"a // b"');
    expect(out).toContain('r#"c "// d"#');
    expect(out).toContain("fn after() {}");
  });

  it("does not treat /* inside a string literal as opening a block comment", () => {
    const src = 'const V: &str = "/* not a comment */ still code";\nfn after() {}\n';
    const out = stripRustComments(src);
    expect(out).toContain('"/* not a comment */ still code"');
    expect(out).toContain("fn after() {}");
  });

  it("still strips real line and block comments", () => {
    const src = "// a line comment\nfn f() {} /* a block\ncomment */ fn g() {}\n";
    const out = stripRustComments(src);
    expect(out).not.toContain("a line comment");
    expect(out).not.toContain("a block");
    expect(out).toContain("fn f() {}");
    expect(out).toContain("fn g() {}");
  });

  it("regression: a // inside a string literal inside a #[cfg(test)] module no longer corrupts the scan (#1861)", () => {
    const src =
      "#[cfg(test)]\nmod tests {\n" +
      '  const V: [&str; 2] = ["//x", "y"];\n' +
      '}\npub const AFTER_FLAG: &str = "value";\nfn after() {}\n';

    // Before the fix, the corrupted quote left `matchRustBrace` desynced and
    // it threw here rather than returning. After the fix, the test module is
    // stripped cleanly and everything declared after it survives.
    const code = stripRustTestModules(stripRustComments(src));
    expect(code).toContain("AFTER_FLAG");
    expect(code).toContain("fn after()");
    expect(code).not.toContain("mod tests");
  });
});
