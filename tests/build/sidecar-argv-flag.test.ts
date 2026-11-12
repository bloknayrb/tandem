/**
 * Source pin: every place the desktop shell starts the Node sidecar passes
 * `--tauri-sidecar` (#2404, review of PR #2413).
 *
 * The server decides that it is the desktop app's sidecar from its own argv
 * (`isTauriSidecar` in `src/server/platform.ts`) — never from the inherited
 * `TANDEM_TAURI_SIDECAR` variable. Since #2404 that decision also says whether
 * the desktop window's origins are Tandem's own window for the two
 * local-model settings routes and for the notification stream. A spawn site
 * that dropped the flag would fail CLOSED and quietly: the desktop window
 * refused, the bare "only Tandem's own window" sentence shown inside the
 * desktop app, and the one-time model reconcile retrying at every start. No
 * Rust test would notice, so this reads the source.
 *
 * What it pins:
 *  1. the Rust literal is the same string as the server's constant;
 *  2. the set of `.sidecar(...)` constructions in `src-tauri/src` is exactly
 *     the known one — a NEW construction fails here until it is listed, so it
 *     cannot ship without someone deciding whether it needs the flag;
 *  3. each construction of the Node sidecar that is spawned carries the flag
 *     (the non-Linux direct spawn, the Linux direct spawn, and the Linux
 *     trampoline's argument vector);
 *  4. the reaper's trampoline hands its arguments to the program unchanged, so
 *     the flag given to the reaper is the flag Node receives.
 */

import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { TAURI_SIDECAR_ARGV_FLAG } from "../../src/server/platform.js";

const repoRoot = path.resolve(__dirname, "../..");
const read = (rel: string): string => readFileSync(path.join(repoRoot, rel), "utf8");

/** Rust source with `//` comments (and doc comments) removed, so prose that
 *  mentions the flag or a call cannot satisfy or trip a pin. */
function code(rel: string): string {
  return read(rel)
    .split("\n")
    .map((line) => line.replace(/^(\s*)\/\/.*$/, "$1").replace(/\s\/\/\s.*$/, ""))
    .join("\n");
}

const SIDECAR_RS = "src-tauri/src/sidecar.rs";
const ANCHOR_RS = "src-tauri/src/sidecar_anchor.rs";
const FLAG_LITERAL = `"${TAURI_SIDECAR_ARGV_FLAG}"`;

describe("the desktop shell starts its sidecar with the flag the server reads (#2404)", () => {
  it("the flag is the string the server's constant holds", () => {
    expect(TAURI_SIDECAR_ARGV_FLAG).toBe("--tauri-sidecar");
  });

  it("the `.sidecar(...)` constructions in src-tauri/src are exactly the known set", () => {
    const dir = path.join(repoRoot, "src-tauri/src");
    const found: string[] = [];
    for (const name of readdirSync(dir)
      .filter((n) => n.endsWith(".rs"))
      .sort()) {
      const src = code(`src-tauri/src/${name}`);
      for (const m of src.matchAll(/\.sidecar\(\s*([A-Za-z0-9_:"-]+)\s*\)/g)) {
        found.push(`${name}: ${m[1]}`);
      }
    }
    // Two constructions of the Node sidecar (the Linux closure and the
    // non-Linux spawn) and two of the reaper (path resolution, the
    // trampoline). A new one must be added here on purpose — and, if it
    // starts Node, to the flag pins below.
    expect(found).toEqual([
      "sidecar.rs: SIDECAR_BIN_NAME",
      "sidecar.rs: sidecar_anchor::REAPER_BIN_NAME",
      "sidecar.rs: sidecar_anchor::REAPER_BIN_NAME",
      "sidecar.rs: SIDECAR_BIN_NAME",
    ]);
  });

  it("the non-Linux spawn passes the flag after the server entry point", () => {
    const src = code(SIDECAR_RS);
    expect(src).toMatch(
      /\.sidecar\(SIDECAR_BIN_NAME\)\s*\.map_err\([^;]*?\)\?\s*\.args\(\[\s*server_js_str\.as_str\(\),\s*"--tauri-sidecar"\s*\]\)/,
    );
  });

  it("the Linux direct spawn passes the flag, and is the only use of that construction that is spawned", () => {
    const src = code(SIDECAR_RS);
    expect(src).toMatch(
      /let direct = sidecar\(\)\?\.args\(\[\s*server_js,\s*"--tauri-sidecar"\s*\]\);/,
    );
    // The closure is called exactly twice: once to build `direct`, once only
    // to read the resolved program path for the trampoline.
    const calls = [...src.matchAll(/\bsidecar\(\)\?/g)].length;
    expect(calls).toBe(2);
    expect(src).toMatch(/std::process::Command::from\(sidecar\(\)\?\)\s*\.get_program\(\)/);
  });

  it("every `.args([...])` given to a Node sidecar construction in sidecar.rs carries the flag", () => {
    const src = code(SIDECAR_RS);
    const withFlag = [...src.matchAll(/\.args\(\[[^\]]*\]\)/g)].filter((m) =>
      m[0].includes(FLAG_LITERAL),
    );
    // Exactly the two direct spawns above; the trampoline goes through
    // `pdeathsig_exec_args`.
    expect(withFlag).toHaveLength(2);
  });

  it("the Linux trampoline's argument vector ends with the flag, and the trampoline uses it", () => {
    const anchor = code(ANCHOR_RS);
    const body =
      /pub\(crate\) fn pdeathsig_exec_args\([^)]*\)\s*->\s*Vec<OsString>\s*\{([\s\S]*?)\n\}/.exec(
        anchor,
      )?.[1];
    expect(body, "pdeathsig_exec_args not found").toBeDefined();
    const items = [
      ...(body as string).matchAll(
        /OsString::from\(([^)]*(?:\([^)]*\))?[^)]*)\)|node\.to_owned\(\)/g,
      ),
    ].map((m) => m[0]);
    expect(items.at(-1)).toBe(`OsString::from(${FLAG_LITERAL})`);
    // …after the server entry point, which comes after the Node path.
    expect(items.at(-2)).toBe("OsString::from(server_js)");
    expect(items.at(-3)).toBe("node.to_owned()");

    const sidecar = code(SIDECAR_RS);
    expect(sidecar).toMatch(
      /\.sidecar\(sidecar_anchor::REAPER_BIN_NAME\)\s*\.map_err\([^;]*?\)\?\s*\.args\(sidecar_anchor::pdeathsig_exec_args\(/,
    );
  });

  it("the reaper's trampoline forwards its arguments to the program unchanged", () => {
    // main.rs: `--exec-with-pdeathsig <parent_pid> <program> [args...]` hands
    // everything after the program to the Linux exec, untouched.
    const main = code("reaper/src/main.rs");
    expect(main).toMatch(/exec_with_pdeathsig\(&args\[2\.\.\]\)/);
    expect(main).toMatch(
      /linux::exec_with_pdeathsig\(parent_pid,\s*&rest\[1\],\s*&rest\[2\.\.\]\)/,
    );
    // linux.rs: argv = the program, then each argument as given.
    const linux = code("reaper/src/linux.rs");
    const fn =
      /pub fn exec_with_pdeathsig\(parent_pid: u32, program: &str, args: &\[String\]\) -> i32 \{([\s\S]*?)libc::prctl/.exec(
        linux,
      )?.[1];
    expect(fn, "exec_with_pdeathsig not found").toBeDefined();
    expect(fn).toMatch(
      /argv\.push\(program_c\.clone\(\)\);\s*for arg in args \{\s*match CString::new\(arg\.as_str\(\)\) \{\s*Ok\(c\) => argv\.push\(c\),/,
    );
  });
});
