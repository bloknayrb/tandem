import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Tripwires for the three cross-boundary claims #992 rev2 introduced, none of
 * which any compiler or type-checker can see.
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

describe("native theme (#992 rev2) cross-boundary claims", () => {
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
    expect(
      invoked,
      "useTauriTheme.svelte.ts no longer contains any invoke() call",
    ).not.toHaveLength(0);

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

    // The invisible-hedge pattern this PR removed must not come back: an HTML
    // comment renders nowhere, including the in-app View Changelog surface.
    expect(entry, "caveats belong in the prose, not an HTML comment").not.toMatch(/<!--/);
  });
});
