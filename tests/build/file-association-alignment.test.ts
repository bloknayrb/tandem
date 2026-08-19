/**
 * Alignment pin for the three lists that decide whether a double-clicked file
 * actually opens (#1306).
 *
 * A file association is a promise made by the OS on Tandem's behalf: once
 * `tauri.conf.json` registers an extension, Explorer/Finder offer Tandem as a
 * handler and a double-click launches it. Three independent lists then have to
 * agree, or the app launches and refuses the very file it was launched for:
 *
 *   1. `bundle.fileAssociations[].ext` in `src-tauri/tauri.conf.json` — what the
 *      OS is told Tandem handles.
 *   2. `SUPPORTED_FILE_ASSOC_EXTS` in `src-tauri/src/open_candidate.rs` — the desktop
 *      shell's open-candidate filter (`validate_open_candidate`), applied to
 *      argv on Windows/Linux and to macOS `RunEvent::Opened` URLs alike. The
 *      argv branch gates `TANDEM_OPEN_FILE`; the Opened branch POSTs
 *      `/api/open` directly and never touches that env var.
 *   3. `SUPPORTED_EXTENSIONS` in `src/shared/constants.ts` — the server, which
 *      is the authority; `resolveAndValidatePath` throws UNSUPPORTED_FORMAT.
 *
 * The failure this pins is silent by construction. `maybeOpenStartupFile`
 * deliberately swallows an open failure (a broken `TANDEM_OPEN_FILE` must not
 * abort startup) and falls through to the `welcome.md` fallback — so the user
 * sees Tandem open with the wrong document and no error, and only stderr says
 * why. Nothing else in the tree compares these lists, so drift ships.
 *
 * Direction matters between (1) and the others: registered-but-unsupported is
 * the bug, and `tauri.conf.json` is deliberately narrower than both — `.html`
 * alone is the association, `.htm` is not registered. That asymmetry is a
 * product choice and stays unasserted.
 *
 * Between (2) and (3) the relation is EQUALITY, not subset (#1344). A narrower
 * Rust list reads as harmless defense-in-depth and is not: `SUPPORTED_FILE_ASSOC_EXTS`
 * stopped being an argv-only filter once the macOS Apple Event was routed
 * through it, and "Open With" / a Dock-icon drop deliver any file regardless of
 * what the OS registered. `.htm` was omitted on argv-only reasoning and
 * silently became a refusal of a file the server accepts. Subset would have
 * passed; equality is what catches it.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { SUPPORTED_EXTENSIONS } from "../../src/shared/constants.js";

const repoRoot = path.resolve(__dirname, "../..");

function registeredAssociationExts(): string[] {
  const raw = readFileSync(path.join(repoRoot, "src-tauri/tauri.conf.json"), "utf-8");
  const conf = JSON.parse(raw) as {
    bundle?: { fileAssociations?: Array<{ ext?: string[] }> };
  };
  const assoc = conf.bundle?.fileAssociations ?? [];
  expect(assoc.length).toBeGreaterThan(0); // positive control: we really parsed it
  return [...new Set(assoc.flatMap((a) => a.ext ?? []))].map((e) => e.toLowerCase());
}

function rustAssocExts(): string[] {
  // Moved out of `lib.rs` by #1415 along with the rest of the open-candidate
  // cluster, so `ScreenedOpenPath`'s tuple field has a module boundary to be
  // private to. The move failed both assertions below rather than silently
  // stopping the check, which is exactly what this docblock promises.
  const src = readFileSync(path.join(repoRoot, "src-tauri/src/open_candidate.rs"), "utf-8");
  const m = src.match(/SUPPORTED_FILE_ASSOC_EXTS:\s*&\[&str\]\s*=\s*&\[([^\]]*)\]/);
  expect(m, "SUPPORTED_FILE_ASSOC_EXTS literal not found in open_candidate.rs").toBeTruthy();
  return [...(m as RegExpMatchArray)[1].matchAll(/"([^"]+)"/g)].map((x) => x[1].toLowerCase());
}

describe("OS file associations align with the server's accepted extensions", () => {
  it("every extension tauri.conf.json registers is accepted by the server", () => {
    const registered = registeredAssociationExts();
    const unsupported = registered.filter((ext) => !SUPPORTED_EXTENSIONS.has(`.${ext}`));
    expect(unsupported).toEqual([]);
  });

  it("every extension tauri.conf.json registers passes the Rust shell filter", () => {
    const registered = registeredAssociationExts();
    const rust = new Set(rustAssocExts());
    const rejected = registered.filter((ext) => !rust.has(ext));
    expect(rejected).toEqual([]);
  });

  it("the Rust shell filter accepts exactly what the server accepts", () => {
    // Equality, both directions. Over-permissive would let a doomed HTTP
    // request through (harmless, the server refuses it). UNDER-permissive is
    // the #1344 bug: the shell refuses a file the app can actually open, and
    // the user just lands on welcome.md.
    const rust = rustAssocExts().slice().sort();
    const server = [...SUPPORTED_EXTENSIONS].map((e) => e.replace(/^\./, "")).sort();
    expect(rust).toEqual(server);
  });
});
