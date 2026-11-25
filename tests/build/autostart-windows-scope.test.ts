/**
 * Regression pin (#2160): Windows start-at-login is registered per user, never
 * machine-wide.
 *
 * `tauri-plugin-autostart` 2.7 moves to `auto-launch` 0.6, whose Windows
 * `enable()` writes the machine-wide `HKLM\...\Run` value from any elevated
 * launch, with no knob on the plugin to stop it. Tandem installs per user into
 * `%LOCALAPPDATA%`, so such a value would make every user of the machine run,
 * at logon, an executable only the installing user can write. The fix keeps the
 * plugin out of the Windows build entirely and writes an HKCU-only registration
 * itself (`src-tauri/src/autostart_win.rs`).
 *
 * The load-bearing half is the Cargo `cfg`: with the crate absent from the
 * Windows graph, any Windows use of it fails to compile on the Windows
 * `rust-test` leg. Each check here pins one input of that arrangement whose
 * loss would be silent on the ubuntu leg, where the Windows code is never
 * compiled. None of it proves what a real Windows machine does; the release
 * smoke checklist's start-at-login steps do that.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const repoRoot = join(__dirname, "../..");
const read = (rel: string) => readFileSync(join(repoRoot, rel), "utf8");

const cargoToml = read("src-tauri/Cargo.toml");
const libRs = read("src-tauri/src/lib.rs");
const autostartRs = read("src-tauri/src/autostart.rs");
const autostartWinRs = read("src-tauri/src/autostart_win.rs");
const scrubRs = read("src-tauri/src/uninstall_scrub.rs");

/** Strip `//` comments so prose that names a symbol cannot satisfy or trip a check. */
const code = (src: string) =>
  src
    .split("\n")
    .map((l) => l.replace(/\/\/.*$/, ""))
    .join("\n");

/** The `[...]` header of the TOML section a line sits in. */
function sectionOf(toml: string, predicate: (line: string) => boolean): string | undefined {
  let header: string | undefined;
  for (const line of toml.split("\n")) {
    const t = line.trim();
    if (t.startsWith("[")) header = t;
    if (predicate(t)) return header;
  }
  return undefined;
}

describe("Windows start-at-login stays per-user (#2160)", () => {
  it("tauri-plugin-autostart is not a Windows dependency", () => {
    const declarations = cargoToml
      .split("\n")
      .filter((l) => l.trim().startsWith("tauri-plugin-autostart"));
    expect(declarations, "declared exactly once").toHaveLength(1);

    const header = sectionOf(cargoToml, (t) => t.startsWith("tauri-plugin-autostart"));
    expect(header, "declared inside a target-specific section").toBeDefined();
    // A plain `[dependencies]` or the old `not(any(android, ios))` section would
    // compile it into the Windows build again.
    expect(header).toMatch(
      /^\[target\.'cfg\(not\(any\([^)]*target_os = "windows"[^)]*\)\)\)'\.dependencies\]$/,
    );
  });

  it("the plugin is registered only off Windows", () => {
    const src = code(libRs);
    const at = src.indexOf(".plugin(tauri_plugin_autostart::init(");
    expect(at, "registration site not found in lib.rs").toBeGreaterThan(-1);
    const needle = "tauri_plugin_autostart::init(";
    expect(src.indexOf(needle, src.indexOf(needle, at) + 1), "registered once").toBe(-1);
    const before = src.slice(Math.max(0, at - 200), at);
    expect(before).toMatch(/#\[cfg\(not\(target_os = "windows"\)\)\]\s*\{\s*builder = builder$/);
  });

  it("autostart.rs reaches the plugin only from its non-Windows backend", () => {
    const src = code(autostartRs);
    const uses = [...src.matchAll(/tauri_plugin_autostart::/g)].map((m) => m.index ?? -1);
    expect(uses.length).toBeGreaterThan(0);
    for (const at of uses) {
      // Every use sits after a `#[cfg(not(target_os = "windows"))]` with no
      // Windows `cfg` between them, or inside a test gated the same way.
      const preceding = src.slice(0, at);
      const lastNotWin = preceding.lastIndexOf('#[cfg(not(target_os = "windows"))]');
      const lastWin = preceding.lastIndexOf('#[cfg(target_os = "windows")]');
      expect(lastNotWin, `use at offset ${at} has no non-Windows cfg above it`).toBeGreaterThan(-1);
      expect(lastNotWin).toBeGreaterThan(lastWin);
    }
  });

  it("the Windows backend opens HKEY_CURRENT_USER and never HKEY_LOCAL_MACHINE", () => {
    const src = code(autostartWinRs);
    expect(src).not.toMatch(/HKEY_LOCAL_MACHINE|HKLM/);
    const opens = [...src.matchAll(/Reg(?:Open|Create)KeyExW\(\s*([A-Za-z_]+)/g)].map((m) => m[1]);
    expect(opens.length).toBeGreaterThan(0);
    for (const hive of opens) expect(hive).toBe("HKEY_CURRENT_USER");
  });

  it("the uninstall scrub deletes the values the backend writes, in HKCU", () => {
    const src = code(scrubRs);
    expect(src).toContain('format!(r"HKCU\\{WIN_RUN_SUBKEY}")');
    expect(src).toContain('format!(r"HKCU\\{WIN_STARTUP_APPROVED_SUBKEY}")');
    expect(code(autostartWinRs)).toMatch(/run_subkey: WIN_RUN_SUBKEY/);
    expect(code(autostartWinRs)).toMatch(/approved_subkey: WIN_STARTUP_APPROVED_SUBKEY/);
    expect(code(autostartWinRs)).toMatch(/value_name: AUTOSTART_APP_NAME/);
  });
});
