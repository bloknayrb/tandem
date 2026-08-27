import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { REPO_ROOT, rustSourceDefining, rustSources } from "./rust-sources.js";

/**
 * Tripwires for the cross-boundary claims #992 introduced, none of which any
 * compiler or type-checker can see.
 *
 *  1. **The command name.** `set_native_theme` is a bare string on the client
 *     (`invoke("set_native_theme", …)`) and an identifier in Rust
 *     (`#[tauri::command] fn set_native_theme` + the `invoke_handler!` list).
 *     A mismatch is swallowed at runtime by the push's `.catch(console.warn)`
 *     — the native theme silently stops following the app and nothing fails.
 *     `npm run typecheck` cannot see it either: `tsconfig` covers `src/` only,
 *     and Rust is a different language. This is the highest-value guard here,
 *     because the rename happened in this PR and the two halves were written
 *     by different hands.
 *
 *  2. **The preference enum.** `ThemePreference` lives in TypeScript and is
 *     re-matched by `resolve_theme_pref` in Rust, so "warm is a light-family
 *     theme" is knowledge held on both sides of the IPC boundary. That
 *     duplication was accepted deliberately (moving resolution across the wire
 *     trades one duplication for another); pinning it is the price. A TS member
 *     with no explicit Rust arm falls into `Unrecognized` — it still degrades
 *     to "follow the OS", but silently drifts and logs on every push.
 *
 *  3. **The CHANGELOG's platform scope.** The entry this PR rewrites previously
 *     claimed native menus follow the in-app theme on "Windows, macOS, or
 *     Linux". Windows was inert and Linux was never attempted. That is the same
 *     failure class `wake-availability-claims.test.ts` and
 *     `monitor-arming-claims.test.ts` exist to catch — a shipped document
 *     asserting unverified platform behaviour — and this entry has already
 *     drifted once.
 *
 * Every extraction below asserts it actually found something before asserting
 * anything about the result. A regex that silently matches nothing would make
 * the whole file pass forever, which is the specific way this repo's tripwires
 * have failed before.
 */

const LIB_RS = join(REPO_ROOT, "src-tauri", "src", "lib.rs");
const CLIENT_HOOK = join(REPO_ROOT, "src", "client", "hooks", "useTauriTheme.svelte.ts");
const SETTINGS = join(REPO_ROOT, "src", "client", "hooks", "useTandemSettings.ts");
const CHANGELOG = join(REPO_ROOT, "CHANGELOG.md");

/**
 * The Rust module that defines this feature, **found rather than named**.
 *
 * Every claim below except the `generate_handler!` one used to be read out of
 * `lib.rs`, which was true until Unit 11c extracted the whole cluster into
 * `native_theme.rs` and eight of the ten specs here went red at once. That is
 * the file working — each extraction asserts it found something before
 * asserting anything about the result — but re-pointing the constant at
 * `native_theme.rs` would only re-arm the same breakage for whichever unit moves
 * it next.
 *
 * So the module is located by a construct that IS the feature. `rustSourceDefining`
 * asserts exactly one file matches, which matters more than it looks: a
 * concatenate-everything corpus would let the several first-hit `.match()` calls
 * below silently return a different module's occurrence, and "found the wrong
 * thing" still reports a pass. Both directions are loud here — zero matches names
 * the pattern, two or more names the files.
 *
 * `LIB` stays separate because `generate_handler!` genuinely does live in
 * `lib.rs`, and scoping that lookup to the crate root is the point of it.
 */
const NATIVE_THEME = rustSourceDefining(
  // The visibility group is spelled the same way in all five patterns in this
  // file that have to tolerate one, so "we widened these to `pub(crate)`" reads
  // as one change rather than two idioms a reader has to compare.
  /#\[tauri::command\]\s*(?:pub(?:\(crate\))?\s+)?fn set_native_theme\s*\(/,
  "the #[tauri::command] fn set_native_theme",
);
const RUST = NATIVE_THEME.text;
const LIB = readFileSync(LIB_RS, "utf-8");

/**
 * Slice a Rust `fn <name>(…) { … }` body by brace balance. Naive brace
 * counting is fine for the two small, string-literal-free functions this file
 * reads; it is NOT a general Rust parser. `lib.rs` contains dozens of `match`
 * blocks, so scoping to the function is mandatory — an unscoped regex over the
 * whole file would match arms from unrelated code.
 */
function rustFnBody(src: string, name: string): string {
  const start = src.indexOf(`fn ${name}(`);
  expect(start, `${NATIVE_THEME.rel} no longer defines fn ${name}`).toBeGreaterThan(-1);
  const open = src.indexOf("{", start);
  expect(open, `fn ${name} has no body`).toBeGreaterThan(-1);
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}" && --depth === 0) return src.slice(open, i + 1);
  }
  throw new Error(`unbalanced braces in fn ${name}`);
}

describe("native theme (#992) cross-boundary claims", () => {
  it("every Tauri command this hook invokes is defined and registered in Rust", () => {
    const client = readFileSync(CLIENT_HOOK, "utf-8");

    // Derive the names from the CLIENT so a rename on either side is caught,
    // and check ALL of them rather than singling one out. An earlier draft
    // picked the push command with `name.includes("theme") && name !==
    // "get_app_theme"`, a heuristic that would silently select the wrong
    // command as soon as a third theme command appeared — failing in the
    // "found the wrong thing" direction this file exists to rule out.
    const invoked = [
      ...new Set([...client.matchAll(/\binvoke(?:<[^>]*>)?\(\s*"([a-z_]+)"/g)].map((m) => m[1])),
    ];
    // Name the commands we care about explicitly. A non-empty floor is NOT a
    // substitute: hoisting the command to `const PUSH_CMD = "set_native_theme"`
    // and calling `invoke(PUSH_CMD, …)` — an ordinary refactor — drops it from
    // this extraction entirely, and the floor still passed on the remaining
    // `invoke<string>("get_app_theme")` literal. Measured; this file's own
    // header calls that the highest-value guard here, and it was off.
    for (const required of ["set_native_theme", "get_app_theme"]) {
      expect(
        invoked,
        `${required} is no longer invoked as a string literal in useTauriTheme.svelte.ts — ` +
          "if it moved to a constant, this extraction stopped covering it",
      ).toContain(required);
    }

    const handlerStart = LIB.indexOf("tauri::generate_handler![");
    expect(handlerStart, "lib.rs no longer calls tauri::generate_handler!").toBeGreaterThan(-1);
    const handlerList = LIB.slice(handlerStart, LIB.indexOf("]", handlerStart));

    for (const command of invoked) {
      // A defined-but-unregistered command fails at runtime exactly like a
      // typo, so both halves have to hold.
      expect(RUST, `${NATIVE_THEME.rel} has no '#[tauri::command] fn ${command}'`).toMatch(
        new RegExp(`#\\[tauri::command\\][\\s\\S]{0,200}?\\bfn ${command}\\s*\\(`),
      );
      expect(handlerList, `${command} is not registered in generate_handler!`).toContain(command);
    }
  });

  it("the set_native_theme argument name matches the Rust parameter", () => {
    // `invoke("set_native_theme", { theme: pref })` on one side,
    // `fn set_native_theme(window, theme: String)` on the other. Rename either
    // and Tauri's argument deserialization fails at runtime — where the push's
    // `.catch(console.warn)` swallows it, in a release build with no reachable
    // console. Measured: renaming the Rust parameter to `pref` passed all
    // three tests in this file.
    const client = readFileSync(CLIENT_HOOK, "utf-8");
    const call = client.match(/invoke(?:<[^>]*>)?\(\s*"set_native_theme"\s*,\s*\{([^}]*)\}/);
    expect(call, "no invoke('set_native_theme', { … }) call found").not.toBeNull();
    const argKeys = [...(call?.[1] ?? "").matchAll(/(\w+)\s*:/g)].map((m) => m[1]);
    expect(argKeys.length, "extracted no argument keys — the parser broke").toBeGreaterThan(0);

    const sig = RUST.match(/fn set_native_theme\(([\s\S]*?)\)\s*->/);
    expect(
      sig,
      `${NATIVE_THEME.rel} no longer declares fn set_native_theme(..) -> ..`,
    ).not.toBeNull();
    // Only a name at the start of a parameter, followed by a SINGLE colon —
    // otherwise `window: tauri::WebviewWindow` also yields "tauri" from the
    // path separator. Then drop the injected `window`, which Tauri supplies
    // and which is not part of the JS payload.
    const rustParams = [...(sig?.[1] ?? "").matchAll(/(?:^|,)\s*(\w+)\s*:(?!:)/g)]
      .map((m) => m[1])
      .filter((n) => n !== "window");
    expect(rustParams.length, "extracted no Rust parameters — the parser broke").toBeGreaterThan(0);

    expect([...argKeys].sort()).toEqual([...rustParams].sort());
  });

  it("NativeThemeOutcome is serialized camelCase, matching the keys the client reads", () => {
    // The nastiest silent failure in this feature. Drop
    // `#[serde(rename_all = "camelCase")]` and Rust sends `override_active` /
    // `os_theme` while the client reads `outcome.overrideActive` — `undefined`,
    // which is falsy, so the macOS override gate is off FOREVER and `osTheme`
    // never writes through. The promise still resolves, so nothing logs and
    // nothing throws. Measured: removing the attribute passed everything.
    const struct = RUST.match(
      /((?:#\[[^\]]*\]\s*)*)(?:pub(?:\(crate\))?\s+)?struct NativeThemeOutcome\s*\{([\s\S]*?)\n\}/,
    );
    expect(
      struct,
      `${NATIVE_THEME.rel} no longer declares struct NativeThemeOutcome`,
    ).not.toBeNull();
    expect(struct?.[1] ?? "", "NativeThemeOutcome lost its camelCase serde rename").toMatch(
      /rename_all\s*=\s*"camelCase"/,
    );

    const rustFields = [...(struct?.[2] ?? "").matchAll(/^\s*(?:pub\s+)?(\w+)\s*:/gm)].map(
      (m) => m[1],
    );
    expect(rustFields.length, "extracted no struct fields — the parser broke").toBeGreaterThan(1);
    const camel = rustFields.map((f) => f.replace(/_(\w)/g, (_m, c: string) => c.toUpperCase()));

    // Every serialized key must be one the client actually reads, so a field
    // rename on either side is caught rather than silently read as undefined.
    const client = readFileSync(CLIENT_HOOK, "utf-8");
    for (const key of camel) {
      expect(client, `the client never reads outcome.${key}`).toContain(key);
    }
  });

  it("resolve_theme_pref's explicit arms cover exactly the ThemePreference union", () => {
    const body = rustFnBody(RUST, "resolve_theme_pref");

    // Only the left-hand side of each arm, and only up to the catch-all: the
    // right-hand sides name enum variants, not preferences. Or-patterns
    // ("light" | "warm" => …) must be split, or a regex anchored on `=>`
    // captures just the last alternative and reports a misleading "Rust is
    // missing light".
    const arms = body
      .slice(0, body.includes("_ =>") ? body.indexOf("_ =>") : undefined)
      .split("\n")
      .flatMap((line) => {
        const lhs = line.split("=>")[0];
        return line.includes("=>") ? [...lhs.matchAll(/"([a-z]+)"/g)].map((m) => m[1]) : [];
      });

    // Sanity: without this, a regex that matched nothing would leave the
    // comparison below asserting [] against [] on some future refactor.
    expect(arms.length, "extracted no match arms — the parser broke").toBeGreaterThan(2);
    expect(body, "resolve_theme_pref no longer has a catch-all arm").toContain("_ =>");

    const settings = readFileSync(SETTINGS, "utf-8");
    const union = settings.match(/export type ThemePreference\s*=\s*([^;]+);/);
    expect(union, "useTandemSettings.ts no longer declares ThemePreference").not.toBeNull();
    const members = [...(union?.[1] ?? "").matchAll(/"([a-z]+)"/g)].map((m) => m[1]);
    expect(members.length, "extracted no union members — the parser broke").toBeGreaterThan(2);

    expect([...arms].sort()).toEqual([...members].sort());
  });

  it("the CHANGELOG entry for #992 does not over-claim its platform scope", () => {
    const doc = readFileSync(CHANGELOG, "utf-8");

    // Scope to the entry. A file-wide search would pass on any other bullet
    // that happens to mention Windows.
    const start = doc.indexOf("Native right-click menus");
    expect(start, "CHANGELOG no longer contains the #992 entry").toBeGreaterThan(-1);
    const entry = doc.slice(start, doc.indexOf("\n\n", start));
    expect(entry, "the #992 entry must cite the issue").toContain("#992");

    // Linux is NOT delivered (#1363), and silence about that is the failure
    // mode — a reader on Linux would otherwise assume the feature applies to
    // them. Asserted UNCONDITIONALLY: an earlier draft wrapped this in
    // `if (/\bLinux\b/.test(entry))`, which meant deleting the Linux sentence
    // made the guard pass rather than fail — the exact vacuity this file's
    // header claims to prevent.
    expect(entry, "the entry must address Linux, which does not get this feature").toMatch(
      /\bLinux\b/,
    );
    expect(entry, "the entry mentions Linux without pointing at #1363").toContain("#1363");
    expect(entry, "the entry must say Linux is unchanged, not supported").toMatch(
      /nothing changes|not attempted|unchanged/i,
    );

    // High Contrast deliberately wins on Windows; a reader who is told menus
    // follow the app theme, full stop, will file the guard as a bug.
    expect(entry, "the entry must state the High Contrast carve-out").toMatch(/High Contrast/i);

    // "warm" resolves to a LIGHT native surface on BOTH platforms in scope:
    // resolve_theme_pref maps `"light" | "warm" => Light` host-agnostically,
    // and the Windows arm folds every non-Dark theme into ForceLight. So a
    // user in warm gets a light menu — measured by hand on Windows 11 against
    // c929cde, and reported as surprising, which is why it is pinned here.
    // The window is deliberate: a bare /light/ over the whole entry would be
    // satisfied vacuously by "a light Windows" or "a one-way trip to light
    // mode", both of which already appear and neither of which says anything
    // about warm. The claim only holds if the two sit together.
    const warmAt = entry.toLowerCase().indexOf("warm");
    expect(warmAt, "the entry never mentions warm, whose menu is not warm").toBeGreaterThan(-1);
    expect(
      entry.slice(warmAt, warmAt + 200),
      "the entry names warm without saying its native menu renders light",
    ).toMatch(/light/i);

    // The invisible-hedge pattern this PR removed must not come back: an HTML
    // comment renders nowhere, including the in-app View Changelog surface.
    expect(entry, "caveats belong in the prose, not an HTML comment").not.toMatch(/<!--/);
  });

  // ------------------------------------------------------------------------
  // #1368 — the `applied` discriminant and the structured error code. Both are
  // strings on the wire, compared with `===` on the client, so every one of these
  // failures is silent: nothing throws, nothing logs, the comparison is just never
  // true again and the feature quietly does nothing.
  // ------------------------------------------------------------------------

  /** serde's `rename_all = "kebab-case"` applied to a Rust variant identifier. */
  function kebab(variant: string): string {
    return variant
      .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
      .replace(/([A-Z])([A-Z][a-z])/g, "$1-$2")
      .toLowerCase();
  }

  /**
   * Variant identifiers of a fieldless Rust enum, skipping doc comments.
   *
   * Deliberately NOT anchored on the attribute list, unlike the three `rename_all`
   * checks: those must prove the attrs sit on the item, this only needs the block.
   * A `pub(crate) enum` matches either way.
   */
  function rustEnumVariants(name: string): string[] {
    const block = RUST.match(new RegExp(`enum ${name}\\s*\\{([\\s\\S]*?)\\n\\}`));
    expect(block, `${NATIVE_THEME.rel} no longer declares enum ${name}`).not.toBeNull();
    return [...(block?.[1] ?? "").matchAll(/^\s*([A-Z]\w*)\s*,/gm)].map((m) => m[1]);
  }

  /** String literals of a TS union alias in the client hook. */
  function clientUnionMembers(source: string, name: string): string[] {
    const union = source.match(new RegExp(`type ${name}\\s*=([^;]+);`));
    expect(union, `the client no longer declares type ${name}`).not.toBeNull();
    return [...(union?.[1] ?? "").matchAll(/"([a-z-]+)"/g)].map((m) => m[1]);
  }

  it("AppliedNativeTheme's Rust variants and the client's union are the same set", () => {
    // Measured: adding a sixth Rust variant and forgetting the client is invisible —
    // the payload arrives, matches no branch, and the feature silently narrows.
    const variants = rustEnumVariants("AppliedNativeTheme");
    expect(
      variants.length,
      "extracted no AppliedNativeTheme variants — the parser broke",
    ).toBeGreaterThan(4);

    const attrs = RUST.match(
      /((?:#\[[^\]]*\]\s*)*)(?:pub(?:\(crate\))?\s+)?enum AppliedNativeTheme\s*\{/,
    );
    expect(attrs?.[1] ?? "", "AppliedNativeTheme lost its kebab-case serde rename").toMatch(
      /rename_all\s*=\s*"kebab-case"/,
    );

    const client = readFileSync(CLIENT_HOOK, "utf-8");
    const members = clientUnionMembers(client, "AppliedNativeTheme");
    expect([...members].sort()).toEqual([...variants.map(kebab)].sort());
  });

  it("the client READS outcome.applied, not merely the word 'applied'", () => {
    // The camelCase test above walks the struct's fields and asserts the client
    // "contains" each one. For `applied` that is vacuous: the word already appears in
    // two comments in this hook, so that test passes even if nothing ever reads the
    // field. Measured before writing this.
    const client = readFileSync(CLIENT_HOOK, "utf-8");
    expect(client, "nothing in the client reads outcome.applied").toMatch(/outcome\.applied/);
  });

  it("NativeThemeErrorCode's Rust variants and the client's union are the same set", () => {
    const variants = rustEnumVariants("NativeThemeErrorCode");
    expect(
      variants.length,
      "extracted no NativeThemeErrorCode variants — the parser broke",
    ).toBeGreaterThan(2);

    const enumAttrs = RUST.match(
      /((?:#\[[^\]]*\]\s*)*)(?:pub(?:\(crate\))?\s+)?enum NativeThemeErrorCode\s*\{/,
    );
    expect(enumAttrs?.[1] ?? "", "NativeThemeErrorCode lost its kebab-case serde rename").toMatch(
      /rename_all\s*=\s*"kebab-case"/,
    );

    // The rename on the STRUCT governs FIELD names, where kebab-case would be wrong
    // for any future multi-word field (`retryAfterMs` -> `retry-after-ms`), and where
    // camelCase matches what every other payload in this feature uses.
    const structAttrs = RUST.match(
      /((?:#\[[^\]]*\]\s*)*)(?:pub(?:\(crate\))?\s+)?struct NativeThemeError\s*\{/,
    );
    expect(
      structAttrs,
      `${NATIVE_THEME.rel} no longer declares struct NativeThemeError`,
    ).not.toBeNull();
    expect(structAttrs?.[1] ?? "", "NativeThemeError must serialize its FIELDS camelCase").toMatch(
      /rename_all\s*=\s*"camelCase"/,
    );

    const client = readFileSync(CLIENT_HOOK, "utf-8");
    const members = clientUnionMembers(client, "NativeThemeErrorCode");
    expect([...members].sort()).toEqual([...variants.map(kebab)].sort());
  });

  it("both apply_app_mode definitions have the same signature", () => {
    // The single break on this feature that NO compiler available to this repo's
    // developers can see: `apply_app_mode` is `#[cfg(target_os = "windows")]` with a
    // `#[cfg(not(...))]` stub, and cfg-stripping runs before name resolution, so a
    // Linux or macOS `cargo check` never parses the Windows body at all. Changing one
    // signature and not the other compiles clean here and fails only on CI's
    // windows-latest leg.
    //
    // The extraction is `[\s\S]`-based rather than line-oriented on purpose: rustfmt
    // wraps one definition across four lines and leaves the other on one, so a
    // `.*`-based regex finds a SINGLE match and "all extracted types are equal"
    // passes trivially on a one-element array — and a later reflow drops it to zero
    // matches, still passing.
    const defs = [
      ...RUST.matchAll(
        /#\[cfg\(([^\]]*)\)\]\s*\nfn apply_app_mode\(([\s\S]*?)\)\s*->\s*([^{]+)\{/g,
      ),
    ];
    expect(defs, "expected exactly two cfg-gated apply_app_mode definitions").toHaveLength(2);

    const cfgs = defs.map((d) => d[1].replace(/\s+/g, " ").trim()).sort();
    expect(cfgs, "the two definitions must be the windows/not-windows pair").toEqual([
      'not(target_os = "windows")',
      'target_os = "windows"',
    ]);

    // Parameters as well as the return type. Comparing only the return type let
    // `mode: AppMode` -> `mode: u32` on ONE definition pass — precisely the break this
    // test's own comment claims to catch. The `_`-stripping normalises the deliberate
    // `window`/`_window` and `mode`/`_mode` difference between the real body and the
    // never-called stub; nothing else in either parameter list starts with `_`.
    const params = defs.map((d) =>
      d[2]
        .replace(/\b_(\w)/g, "$1")
        .replace(/\s+/g, " ")
        .trim(),
    );
    expect(params[0], "the two apply_app_mode definitions disagree on their parameters").toBe(
      params[1],
    );

    const returns = defs.map((d) => d[3].replace(/\s+/g, " ").trim());
    expect(returns[0], "the two apply_app_mode definitions disagree on their return type").toBe(
      returns[1],
    );
  });

  it("applied_native_theme stays exhaustive: every variant, no wildcard, no guard", () => {
    // This function's arm SHAPE is the whole payoff of moving `AppModeOutcome` out of
    // the Windows-gated module: with no wildcard and no guard, adding a variant is a
    // compile error on every host rather than a silent gap on all but one. Both
    // natural "simplifications" pass every behavioural test in lib.rs while destroying
    // that guarantee, so they are pinned here instead.
    const body = rustFnBody(RUST, "applied_native_theme");
    // Comments are stripped first: the body carries a comment containing the word
    // "if", and a naive guard check would fight the very shape this test requires.
    const code = body.replace(/\/\/[^\n]*/g, "");

    const variants = rustEnumVariants("AppModeOutcome");
    expect(
      variants.length,
      "extracted no AppModeOutcome variants — the parser broke",
    ).toBeGreaterThan(4);
    for (const variant of variants) {
      expect(code, `applied_native_theme no longer matches AppModeOutcome::${variant}`).toContain(
        `AppModeOutcome::${variant}`,
      );
    }

    // Catches a bare `_ =>` AND a `Some(_) =>`: the optional `\)?` is what reaches
    // across the single closing paren of the latter. Without it this assertion was
    // INERT for the `Some(_)` form — the mutation still went red, but through the
    // containment loop above, not through here. It still does NOT match the legitimate
    // `SetWindowTheme(Some(_)) =>`, where the `_` is followed by TWO closing parens.
    //
    // Worth having even though the enumeration above overlaps it: a `Some(_) =>` added
    // ALONGSIDE the full enumeration draws only an `unreachable_patterns` warning from
    // rustc, so nothing else here would notice it.
    expect(code, "a wildcard arm would swallow a new variant silently").not.toMatch(
      /[\s(|]_\s*\)?\s*=>/,
    );

    // A match GUARD stops rustc counting the arm toward exhaustiveness and forces a
    // catch-all — the same loss by another route. An `if` in an arm BODY is fine and
    // is where the High-Contrast disambiguation has to live, so the test is "an `if`
    // ahead of a `=>` on the same line", not "an `if` anywhere".
    expect(code, "a match guard would force a catch-all arm").not.toMatch(/^[^\n]*\bif\b[^\n]*=>/m);
  });

  it("scans a real Rust module, found by search rather than named here", () => {
    // The control on the location step. Every spec above reads `NATIVE_THEME.text`,
    // so a walk that returned nothing, or a `rustSourceDefining` that resolved to
    // some unrelated file, would change what each of them is really asserting
    // without changing whether they pass. Assert the walk is populated, that the
    // module it found is a distinct file from `lib.rs` (which is the whole point
    // after Unit 11c), and that the two commands the client invokes are BOTH in
    // the file it found -- not merely somewhere under src-tauri/src.
    //
    // What this deliberately does NOT assert is the module's FILENAME. Renaming
    // `native_theme.rs` leaves this file green, and that is the intended answer,
    // not a hole: a rename breaks none of the claims here, the code is still
    // read, and a guard that fails on a harmless rename is noise its next reader
    // learns to route around. Measured -- the rename was run as a mutation
    // alongside the six that must go red, and it is the only one that stays
    // green on purpose.
    const rel = rustSources().map((f) => f.rel);
    expect(rel.length, "the Rust source walk found almost nothing").toBeGreaterThan(10);
    expect(rel).toContain("src-tauri/src/lib.rs");
    expect(rel, "the located module must be one of the files the walk returned").toContain(
      NATIVE_THEME.rel,
    );
    expect(
      NATIVE_THEME.rel,
      "the native-theme cluster was extracted out of lib.rs in Unit 11c; if this " +
        "resolves back to lib.rs the search matched the wrong construct",
    ).not.toBe("src-tauri/src/lib.rs");
    for (const command of ["get_app_theme", "set_native_theme"]) {
      expect(RUST, `${command} is not defined in ${NATIVE_THEME.rel}`).toContain(`fn ${command}(`);
    }
  });
});
