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
  /** The file verbatim. Read this when a claim is about attributes or prose. */
  text: string;
  /**
   * `text` with comments and `#[cfg(test)]` modules removed.
   *
   * Read this when a claim is about what the crate actually *does*. The two are
   * not interchangeable: matching a construct against `text` cannot tell code
   * from a commented-out example or a test-module fake, and that is not
   * hypothetical — see `rustSourceDefining`.
   */
  code: string;
}

/** Every Rust source file, **derived from disk rather than named here**. */
export function rustSources(): RustSource[] {
  const found = readdirSync(RUST_SRC, { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile() && e.name.endsWith(".rs"))
    .map((e) => {
      const abs = join(e.parentPath, e.name);
      const text = readFileSync(abs, "utf8");
      return {
        rel: abs.slice(REPO_ROOT.length + 1).replace(/\\/g, "/"),
        text,
        code: stripRustTestModules(stripRustComments(text)),
      };
    });
  if (found.length === 0) {
    throw new Error(`no .rs files under ${RUST_SRC} — the walk is broken, not the crate`);
  }
  return found;
}

/**
 * The one Rust source file whose **code** matches `pattern`, asserted unique.
 *
 * This is what lets a text guard follow a construct across the Unit 11 split
 * without either naming its file (which the split invalidates) or scanning a
 * concatenation of every file (where a first-hit `.match()` can silently return
 * the wrong module's occurrence — the "found the wrong thing" direction, which
 * is worse than finding nothing because it still reports a pass).
 *
 * **It matches `code`, not `text`, and that is load-bearing.** Review
 * constructed the defeat: a block comment in an unrelated module holding a
 * syntactically exact `#[tauri::command] fn set_native_theme(…)` was enough to
 * make this resolve to that module, and a second commented-out command was
 * enough to make the caller's own positive control pass while it did. A
 * `#[cfg(test)]` mock of the same shape defeats it identically. Stripping both
 * before the scan is what closes it; the callers' assertions then run against
 * `text` as before, because those claims genuinely are about attributes.
 *
 * Both failure directions are loud: zero matches names the pattern, and two or
 * more names the files, rather than picking one.
 */
export function rustSourceDefining(pattern: RegExp, what: string): RustSource {
  const hits = rustSources().filter((f) => pattern.test(f.code));
  expect(
    hits.map((f) => f.rel),
    `expected exactly one Rust source under src-tauri/src to define ${what}`,
  ).toHaveLength(1);
  return hits[0];
}

/** Drop `/* … *\/` and `// …` comments, leaving `://` in paths alone. */
export function stripRustComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

/**
 * Drop `#[cfg(test)] mod ... { ... }` blocks.
 *
 * **A test satisfied a production-routing claim**, which is why this exists:
 * `pending_update_tests` calls `surface_pending_update_hint_with(CODE_…)`, so
 * rewriting the real call site to pass a literal instead left
 * `startup-open-failure-wiring-claims.test.ts` green. Found by mutation, not by
 * reading.
 *
 * Brace-counted rather than regex-bounded, and "strips test modules without
 * eating production code" in that file is the control on it: a stripper that
 * removed too much would make every assertion built on it pass by finding
 * nothing.
 *
 * **Braces are counted outside string and char literals**, because a naive
 * counter is defeated by text this already scans: `pending_update.rs`'s test
 * module contains `b"{ not json"`, an unbalanced brace in a byte-string
 * literal. A counter that sees it never reaches depth 0 and runs off the end of
 * the input — today indistinguishable from a correct match only because that
 * test module is the last thing in the file. The next item appended after it
 * would vanish from the scan silently. Found by review, not by reading. Hence
 * both halves: literals are skipped, and an unbalanced block **throws** rather
 * than truncating, because a stripper that fails loud cannot hollow the scan it
 * feeds.
 */
export function stripRustTestModules(src: string): string {
  let out = "";
  let i = 0;
  for (;;) {
    const at = src.indexOf("#[cfg(test)]", i);
    if (at === -1) return out + src.slice(i);
    const open = src.indexOf("{", at);
    if (open === -1) return out + src.slice(i);
    out += src.slice(i, at);
    i = matchRustBrace(src, open) + 1;
  }
}

/** Index of the `}` closing the `{` at `open`. Throws if the block never closes. */
function matchRustBrace(src: string, open: number): number {
  let depth = 0;
  let j = open;
  while (j < src.length) {
    const c = src[j];
    if (c === '"' || c === "'") {
      const after = skipRustLiteral(src, j);
      if (after > j) {
        j = after;
        continue;
      }
    }
    if (c === "{") depth++;
    else if (c === "}" && --depth === 0) return j;
    j++;
  }
  throw new Error(
    "unbalanced `#[cfg(test)]` block: the brace scanner ran off the end of the " +
      "input. Truncating here would silently drop every Rust item after it from " +
      "the scan, so this fails instead.",
  );
}

/**
 * Index just past the string or char literal starting at `i`, or `i` if what is
 * there is not a literal (a lifetime `'a`, most commonly).
 *
 * Comments are already gone — `stripRustComments` runs first — so only literals
 * can hide a brace.
 */
function skipRustLiteral(src: string, i: number): number {
  if (src[i] === "'") {
    // `'\n'` / `'{'` are literals; `'a` is a lifetime and must not be skipped.
    if (src[i + 1] === "\\") {
      const end = src.indexOf("'", i + 2);
      return end === -1 ? i : end + 1;
    }
    return src[i + 2] === "'" ? i + 3 : i;
  }
  // Raw-ness is decided by looking back over `#`s to an `r` (`r"`, `r#"`, `br#"`).
  let k = i - 1;
  let hashes = 0;
  while (src[k] === "#") {
    hashes++;
    k--;
  }
  if (src[k] === "r") {
    const terminator = `"${"#".repeat(hashes)}`;
    const end = src.indexOf(terminator, i + 1);
    return end === -1 ? i : end + terminator.length;
  }
  for (let j = i + 1; j < src.length; j++) {
    if (src[j] === "\\") j++;
    else if (src[j] === '"') return j + 1;
  }
  return i;
}
