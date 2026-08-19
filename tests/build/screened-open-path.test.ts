/**
 * Source pins for the `ScreenedOpenPath` newtype (#1415) — and an honest
 * statement of what they are and are not.
 *
 * **The guarantee itself is a compile error, not an assertion in this file.**
 * `ScreenedOpenPath`'s tuple field is private to `src-tauri/src/open_candidate.rs`,
 * so no other module in the crate — `lib.rs` included, all ~6,900 lines and
 * eight `#[cfg(test)]` submodules of it — can wrap an unscreened path. rustc
 * enforces that on every build, on every CI leg. Two `compile_fail` doctests on
 * the type cover the same boundary as seen from OUTSIDE the crate (that is all
 * a doctest can reach; `trybuild` would be no different, since it also compiles
 * its cases as separate crates linking `app_lib`).
 *
 * **Those doctests prove "does not compile", not "fails with this error."** The
 * error code written after `compile_fail` is unenforced on stable rustc — only a
 * nightly toolchain checks it — so retagging a block `compile_fail,E0308`
 * changes nothing about whether it passes. What keeps each block honest is
 * therefore not its code but its surface area: neither resolves any name beyond
 * `ScreenedOpenPath` and `PathBuf`, so the private-item access is the only thing
 * in them that can fail.
 *
 * What is left over — and what this file is for — is regression pressure on the
 * arrangement that makes rustc's enforcement possible:
 *
 *   1. The field must stay private, and the type must stay in its own module.
 *   2. `open_candidate.rs` must build a `ScreenedOpenPath` exactly ONCE, inside
 *      `validate_open_candidate`. Any module declared inside that file is a
 *      DESCENDANT of `open_candidate` and can write
 *      `ScreenedOpenPath(PathBuf::from("anything"))` — strictly more power than
 *      the named `for_test` constructor this design rejected. Counting the
 *      constructions catches such a fabricator however its `cfg` or its module
 *      is spelled; an earlier version of this pin grepped for `#[cfg(test)]` and
 *      `mod …tests {`, and `#[cfg(any(test, feature = "x"))] mod fixtures { … }`
 *      walked past both. The legitimate unit tests live in `lib.rs`, a sibling,
 *      which can call `validate_open_candidate` (a real screening) but cannot
 *      fabricate.
 *   3. Nothing outside `open_candidate.rs` may name the tuple constructor.
 *   4. The carriers between the screener and the POST must keep the newtype.
 *   5. The order inside `validate_open_candidate` must stay safe — see the
 *      dedicated docblock below, which states that pin's limits.
 */

import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const repoRoot = path.resolve(__dirname, "../..");
const rustSrc = path.join(repoRoot, "src-tauri/src");

const OPEN_CANDIDATE = readFileSync(path.join(rustSrc, "open_candidate.rs"), "utf-8");
const LIB = readFileSync(path.join(rustSrc, "lib.rs"), "utf-8");

/** Strip `//`-style line comments (doc comments included) so a pin matches code. */
function stripLineComments(src: string): string {
  return src
    .split("\n")
    .map((line) => line.replace(/\/\/.*$/, ""))
    .join("\n");
}

/** The body of a `fn name(` — brace-matched from its opening `{`, comments stripped. */
function fnBody(src: string, name: string): string {
  const at = src.indexOf(`fn ${name}(`);
  expect(at, `fn ${name} not found`).toBeGreaterThan(-1);
  const open = src.indexOf("{", at);
  expect(open, `fn ${name} has no body`).toBeGreaterThan(-1);
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}") {
      depth--;
      if (depth === 0) return stripLineComments(src.slice(open, i + 1));
    }
  }
  throw new Error(`unbalanced braces in fn ${name}`);
}

describe("ScreenedOpenPath keeps its constructor private", () => {
  it("declares the newtype with a non-`pub` tuple field", () => {
    const m = OPEN_CANDIDATE.match(/pub struct ScreenedOpenPath\(([^)]*)\)\s*;/);
    expect(m, "pub struct ScreenedOpenPath(..) not found in open_candidate.rs").toBeTruthy();
    const field = (m as RegExpMatchArray)[1];
    expect(field).toMatch(/PathBuf/);
    // `pub`, `pub(crate)` or `pub(super)` on the field would hand every module
    // in the crate the ability to fabricate one, which is the whole invariant.
    expect(field, "the tuple field must stay private to `open_candidate`").not.toMatch(/\bpub\b/);
  });

  it("keeps both `compile_fail` doctests, and resolves nothing in them but the type", () => {
    // E0603 = private tuple-struct constructor; E0616 = private field. The codes
    // are DOCUMENTATION, not an assertion: on stable rustc the code after
    // `compile_fail` is parsed and then ignored (only nightly enforces it), so a
    // block proves "does not compile" and never "fails with this error".
    // Verified by mutation — retagging a block `compile_fail,E0308` still gives
    // `3 passed; 0 failed` under `cargo test --doc`.
    expect(OPEN_CANDIDATE).toContain("```compile_fail,E0603");
    expect(OPEN_CANDIDATE).toContain("```compile_fail,E0616");

    // Since the code cannot be asserted, the surface area is what is left to
    // pin: a block that calls a helper can start failing on an unresolved name
    // (E0425) after a rename and still report `compile fail … ok`, silently
    // ceasing to test the privacy it claims to.
    const blocks = [...OPEN_CANDIDATE.matchAll(/```compile_fail[^\n]*\n([\s\S]*?)\/\/\/ ```/g)]
      .map((m) => m[1].replace(/^\s*\/\/\/ ?/gm, ""))
      .map((b) => b.trim());
    expect(blocks, "expected exactly the two compile_fail blocks").toHaveLength(2);
    for (const block of blocks) {
      expect(
        block,
        "a compile_fail block must not call a helper — a rename would redden it " +
          "for the wrong reason while still reporting a pass",
      ).not.toMatch(/extract_file_arg|validate_open_candidate|classify_opened_url/);
      // Every path it names is either the type or std's PathBuf.
      for (const ident of block.matchAll(/\bapp_lib::(\w+)/g)) {
        expect(ident[1]).toBe("ScreenedOpenPath");
      }
    }
  });

  it("builds a ScreenedOpenPath exactly once, inside validate_open_candidate", () => {
    // This — not a grep for `#[cfg(test)]` — is what stops a fabricator inside
    // `open_candidate.rs`. A descendant module can name the private tuple
    // constructor no matter how its `cfg` is spelled
    // (`#[cfg(any(test, feature = "x"))] mod fixtures { … }` matches neither
    // `#[cfg(test)]` nor `mod …tests {`), so count the constructions instead.
    const code = stripLineComments(OPEN_CANDIDATE);
    const constructions = [...code.matchAll(/ScreenedOpenPath\s*\(/g)].filter(
      // The declaration `pub struct ScreenedOpenPath(PathBuf);` is not one.
      (m) => !/\bstruct\s+$/.test(code.slice(0, m.index)),
    );
    expect(
      constructions.length,
      "open_candidate.rs must construct ScreenedOpenPath exactly once — the " +
        "`Ok(ScreenedOpenPath(absolute))` at the end of validate_open_candidate",
    ).toBe(1);

    const screener = fnBody(OPEN_CANDIDATE, "validate_open_candidate");
    expect(
      [...screener.matchAll(/ScreenedOpenPath\s*\(/g)].length,
      "the one construction must sit inside validate_open_candidate",
    ).toBe(1);
  });

  it("names the tuple constructor nowhere but `open_candidate.rs`", () => {
    const offenders: string[] = [];
    const scanned: string[] = [];
    let sawTheTypeName = false;
    let sawOpenCandidate = false;
    for (const dir of ["src-tauri/src", "src-tauri/tests"]) {
      const abs = path.join(repoRoot, dir);
      for (const entry of readdirSync(abs, { recursive: true, withFileTypes: true })) {
        if (!entry.isFile() || !entry.name.endsWith(".rs")) continue;
        const rel = path.join(dir, entry.name);
        const body = stripLineComments(
          readFileSync(path.join(entry.parentPath ?? abs, entry.name), "utf-8"),
        );
        scanned.push(rel);
        if (body.includes("ScreenedOpenPath")) sawTheTypeName = true;
        if (entry.name === "open_candidate.rs") {
          // Not skipped silently: its one sanctioned construction is counted and
          // located by the test above. Skipping it here without that was how a
          // `mod fixtures` fabricator could be added with the suite still green.
          sawOpenCandidate = true;
          continue;
        }
        // A construction or a field read. Type positions (`Vec<ScreenedOpenPath>`,
        // `Option<ScreenedOpenPath>`) carry no `(`, so they do not match.
        if (/ScreenedOpenPath\s*\(/.test(body)) offenders.push(rel);
      }
    }
    // Positive controls. Without these an empty walk — a renamed directory, a
    // `readdirSync` option that stops recursing — passes the real assertion
    // vacuously, which is the failure mode a grep-based pin dies of.
    expect(scanned.length, "the .rs walk found nothing").toBeGreaterThan(10);
    expect(scanned).toContain("src-tauri/src/lib.rs");
    expect(sawOpenCandidate, "the walk never reached open_candidate.rs").toBe(true);
    expect(sawTheTypeName, "no scanned file mentions ScreenedOpenPath at all").toBe(true);
    expect(offenders).toEqual([]);
  });
});

describe("the carriers between the screener and POST /api/open keep the newtype", () => {
  const carriers: Array<[string, RegExp]> = [
    ["PendingOpens", /struct PendingOpens\(Mutex<Vec<ScreenedOpenPath>>\);/],
    [
      "promote_healthy_and_drain",
      /fn promote_healthy_and_drain\([^)]*\)\s*->\s*Vec<ScreenedOpenPath>/,
    ],
    [
      "try_queue_or_post",
      /fn try_queue_or_post\(\s*state: &PendingOpens,\s*path: ScreenedOpenPath,\s*\)\s*->\s*Result<\(\), ScreenedOpenPath>/,
    ],
    ["post_drained_paths", /fn post_drained_paths\(\s*paths: Vec<ScreenedOpenPath>,/],
    ["cold_start_file", /cold_start_file: Option<ScreenedOpenPath>/],
  ];

  for (const [name, re] of carriers) {
    it(`${name} carries ScreenedOpenPath, not a bare PathBuf`, () => {
      expect(LIB).toMatch(re);
    });
  }

  it("re-exports the type at the crate root for `tests/file_association.rs`", () => {
    expect(LIB).toMatch(/pub use open_candidate::\{[^}]*ScreenedOpenPath[^}]*\}/s);
  });
});

/**
 * CLAUDE.md ("OS file-association cold start") states two SEMANTIC rules:
 * refuse UNC **before any filesystem call**, and scan for the NTFS ADS colon on
 * the **resolved absolute** path. This block is the closest a source pin gets,
 * and its limits are worth stating rather than implying:
 *
 *  - It is a DENY-LIST of the filesystem-touching call shapes known today
 *    (`is_file`, `is_dir`, `is_symlink`, `exists`, `try_exists`, `metadata`,
 *    `symlink_metadata`, `canonicalize`, `read_dir`, `read_link`, `File::open`,
 *    and anything reached through an `fs::` path). `is_dir` and `is_symlink` are
 *    in that list because they are `is_file`'s neighbours on `Path`, they stat
 *    exactly as it does, and "reject a folder with a clearer message" is the
 *    most plausible future edit to this function. A future syscall spelled some
 *    other way still walks past — a platform extension trait
 *    (`std::os::unix::fs::MetadataExt`, `OpenOptionsExt`), or a helper in
 *    another module that stats on the caller's behalf. An allow-list would be
 *    stricter but would fail on every innocuous edit, and a pin nobody can keep
 *    green gets deleted.
 *  - It pins ORDER inside one function. It cannot see a filesystem call added
 *    to a CALLER before the screener runs.
 *  - The ADS assertions check that the scan reads the parameter named
 *    `absolute` and that `extract_file_arg` joins against `cwd` before handing
 *    it over. That is the `f:ADS.md` bypass (a relative candidate whose colon
 *    sits at index 1 of the *candidate* but not of the resolved path). It is
 *    still a check on names, not on values.
 *
 * `tests/shared/unc-check-duplication.test.ts` records what happens when a pin
 * like this is mistaken for a semantic one: the `lib.rs` UNC predicate left its
 * detector's allowlist not because the duplicate went away but because its
 * spelling changed. Read this as pressure against a careless reorder, not as a
 * proof of the invariant.
 */
describe("validate_open_candidate keeps its load-bearing check order", () => {
  const body = fnBody(OPEN_CANDIDATE, "validate_open_candidate");
  // Anchored on the REFUSAL (`if is_unc_or_network_path(…) { return Err(…) }`),
  // not on the first mention of the predicate: the fn's opening `debug_assert!`
  // also calls it, and keying off that occurrence would put the anchor at the
  // top of the body and make every ordering assertion below pass trivially.
  const uncAt = body.indexOf("if is_unc_or_network_path(");

  it("refuses UNC paths inside the shared screener", () => {
    expect(uncAt, "the UNC refusal is gone from the shared screener").toBeGreaterThan(-1);
    expect(body).toMatch(
      /if is_unc_or_network_path\(&absolute\.to_string_lossy\(\)\)\s*\{\s*return Err\(/,
    );
  });

  const FILESYSTEM_CALLS = [
    ".is_file(",
    // `is_file`'s neighbours on `Path`. Each stats, so each performs the SMB
    // handshake on `\\host\share\x` exactly as `is_file()` does.
    ".is_dir(",
    ".is_symlink(",
    ".exists(",
    ".try_exists(",
    ".metadata(",
    ".symlink_metadata(",
    ".canonicalize(",
    "canonicalize(",
    "read_dir(",
    "read_link(",
    "File::open(",
    // Covers both `std::fs::metadata(…)` and the `use std::fs;` alias form
    // `fs::metadata(…)`, which the fully-qualified spelling alone missed.
    "fs::",
  ];

  for (const call of FILESYSTEM_CALLS) {
    it(`performs no \`${call}\` before the UNC refusal`, () => {
      const at = body.indexOf(call);
      if (at === -1) return; // absent entirely is the safest possible state
      expect(
        at,
        `\`${call}\` runs before is_unc_or_network_path — on \\\\host\\share that performs the ` +
          "SMB handshake the UNC check exists to prevent",
      ).toBeGreaterThan(uncAt);
    });
  }

  it("runs the Windows ADS scan before the UNC refusal", () => {
    const adsAt = body.indexOf('#[cfg(target_os = "windows")]');
    expect(adsAt, "the ADS scan block is gone").toBeGreaterThan(-1);
    expect(adsAt).toBeLessThan(uncAt);
  });

  it("scans the resolved absolute path for the ADS colon, not a raw candidate", () => {
    // The parameter is named `absolute` precisely because scanning the un-joined
    // candidate let a relative `f:ADS.md` through (colon at index 1 of the
    // candidate). Both halves of that fix are pinned: the scan reads `absolute`…
    expect(body).toMatch(/let absolute_str = absolute\.to_string_lossy\(\);/);
    expect(body).toMatch(/absolute_str\.as_bytes\(\)/);
    expect(body).toMatch(/\*b == b':' && i != 1/);
    // …and the argv producer joins against cwd before calling the screener.
    const extract = fnBody(OPEN_CANDIDATE, "extract_file_arg");
    expect(extract).toMatch(/cwd\.join\(p\)/);
    expect(extract).toMatch(/validate_open_candidate\(absolute\)/);
  });

  it("checks the extension allowlist and is_file after the UNC refusal", () => {
    const extAt = body.indexOf("SUPPORTED_FILE_ASSOC_EXTS.contains");
    const fileAt = body.indexOf(".is_file()");
    expect(extAt).toBeGreaterThan(uncAt);
    expect(fileAt).toBeGreaterThan(uncAt);
  });
});
