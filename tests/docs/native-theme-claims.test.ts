import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

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

const REPO_ROOT = join(import.meta.dirname, "..", "..");
const LIB_RS = join(REPO_ROOT, "src-tauri", "src", "lib.rs");
const CLIENT_HOOK = join(REPO_ROOT, "src", "client", "hooks", "useTauriTheme.svelte.ts");
const SETTINGS = join(REPO_ROOT, "src", "client", "hooks", "useTandemSettings.ts");
const CHANGELOG = join(REPO_ROOT, "CHANGELOG.md");

/** `lib.rs` is ~244 KB and two tests read it; hoisted so it is read once. */
const RUST = readFileSync(LIB_RS, "utf-8");

/**
 * Slice a Rust `fn <name>(…) { … }` body by brace balance. Naive brace
 * counting is fine for the two small, string-literal-free functions this file
 * reads; it is NOT a general Rust parser. `lib.rs` contains dozens of `match`
 * blocks, so scoping to the function is mandatory — an unscoped regex over the
 * whole file would match arms from unrelated code.
 */
function rustFnBody(src: string, name: string): string {
  const start = src.indexOf(`fn ${name}(`);
  expect(start, `lib.rs no longer defines fn ${name}`).toBeGreaterThan(-1);
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

    const handlerStart = RUST.indexOf("tauri::generate_handler![");
    expect(handlerStart, "lib.rs no longer calls tauri::generate_handler!").toBeGreaterThan(-1);
    const handlerList = RUST.slice(handlerStart, RUST.indexOf("]", handlerStart));

    for (const command of invoked) {
      // A defined-but-unregistered command fails at runtime exactly like a
      // typo, so both halves have to hold.
      expect(RUST, `lib.rs has no '#[tauri::command] fn ${command}'`).toMatch(
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
    expect(sig, "lib.rs no longer declares fn set_native_theme(..) -> ..").not.toBeNull();
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
    const struct = RUST.match(/((?:#\[[^\]]*\]\s*)*)struct NativeThemeOutcome\s*\{([\s\S]*?)\n\}/);
    expect(struct, "lib.rs no longer declares struct NativeThemeOutcome").not.toBeNull();
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
});
