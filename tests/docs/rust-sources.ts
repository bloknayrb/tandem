import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { expect } from "vitest";

/**
 * Shared scan of the Tauri crate's Rust sources, for the doc-tests that read
 * Rust as **text** to pin claims no compiler can see.
 *
 * It lived inside `startup-open-failure-wiring-claims.test.ts` until Unit 11c
 * needed the same walk. The reason it exists at all is recorded there and is
 * worth keeping in front of the next caller: that file used to read `lib.rs`
 * alone, which was correct only while everything it scanned lived in `lib.rs`,
 * and stopped being correct the moment Unit 11a extracted a constant into
 * `pending_update.rs`. The constant simply left the scan and the check went
 * quiet. `lib.rs` is mid-way through being split into six modules, so any
 * hardcoded scope here has a known expiry date.
 *
 * **Every caller owes this walk a positive control**, because a walk that
 * silently returns nothing satisfies every assertion built on it. `rustSources`
 * throws on an empty result, but that is a floor, not a control: assert the
 * specific files your claims live in are in the set.
 */
export const REPO_ROOT = join(import.meta.dirname, "..", "..");
export const RUST_SRC = join(REPO_ROOT, "src-tauri", "src");

export interface RustSource {
  /** Repo-relative, forward-slashed, so assertions read the same on Windows. */
  rel: string;
  text: string;
}

/** Every Rust source file, **derived from disk rather than named here**. */
export function rustSources(): RustSource[] {
  const found = readdirSync(RUST_SRC, { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile() && e.name.endsWith(".rs"))
    .map((e) => {
      const abs = join(e.parentPath, e.name);
      return {
        rel: abs.slice(REPO_ROOT.length + 1).replace(/\\/g, "/"),
        text: readFileSync(abs, "utf8"),
      };
    });
  if (found.length === 0) {
    throw new Error(`no .rs files under ${RUST_SRC} — the walk is broken, not the crate`);
  }
  return found;
}

/**
 * The one Rust source file whose text matches `pattern`, asserted **unique**.
 *
 * This is what lets a text guard follow a construct across the Unit 11 split
 * without either naming its file (which the split invalidates) or scanning a
 * concatenation of every file (where a first-hit `.match()` can silently return
 * the wrong module's occurrence — the "found the wrong thing" direction, which
 * is worse than finding nothing because it still reports a pass).
 *
 * Both failure directions are loud: zero matches names the pattern, and two or
 * more names the files, rather than picking one.
 */
export function rustSourceDefining(pattern: RegExp, what: string): RustSource {
  const hits = rustSources().filter((f) => pattern.test(f.text));
  expect(
    hits.map((f) => f.rel),
    `expected exactly one Rust source under src-tauri/src to define ${what}`,
  ).toHaveLength(1);
  return hits[0];
}
