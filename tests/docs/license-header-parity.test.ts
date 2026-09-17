/**
 * The licensed updater's request header is spelled in TWO languages, in two
 * build graphs, and nothing compared them (#1825, Infra bullet 2).
 *
 * Rust writes it: `src-tauri/src/lib.rs`, in `build_updater`'s `Licensed` arm,
 * as a string literal handed to `updater_builder().header(…, lid)`.
 * TypeScript reads it: `infra/license-update-worker/src/worker.ts`, as the
 * exported `LICENSE_HEADER`.
 *
 * If they drift, every licensed update check silently becomes `no-header` — an
 * ordinary unlicensed client as far as the Worker can tell, served a 204, and
 * the desktop app reports "You're up to date" forever while starved. That is
 * the exact dead state #1786 exists to detect, arriving through a rename rather
 * than through a lost KV entry — and #1786's alert does NOT cover it, because
 * `no-header` is deliberately non-alertable (it is most of the traffic).
 *
 * Neither half can see the other: a Cargo build and a Cloudflare bundle share
 * no type, no constant and no test run. This file is the comparison.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { LICENSE_HEADER } from "../../infra/license-update-worker/src/worker.js";

const RUST_FILE = "src-tauri/src/lib.rs";

/**
 * Every `.header("<literal>", lid)` call in `lib.rs`.
 *
 * VALUE-AGNOSTIC on purpose: the pattern carries no expected string, so both
 * drift directions (edit the Rust literal, or edit `LICENSE_HEADER`) fail on
 * the comparison below with a message naming the two values, rather than one of
 * them failing inside the locator with "no match" and reading like a broken
 * test.
 *
 * Anchored on the SECOND argument, `lid`, which is what makes the match
 * unambiguous without scoping to a function: `lib.rs`'s other `.header("…")`
 * calls pass a bearer token or `LOOPBACK_ORIGIN`, never `lid`.
 */
const HEADER_WITH_LID = /\.header\(\s*"([^"]+)"\s*,\s*lid\s*\)/g;

/** The WORKING TREE, not `git show HEAD:…` — an uncommitted rename must go red
 *  here rather than at whatever point it reaches CI. */
function rustSource(): string {
  return readFileSync(path.resolve(__dirname, "../..", RUST_FILE), "utf8");
}

describe("X-Tandem-License-Id is spelled the same in Rust and in the Worker (#1825)", () => {
  const matches = [...rustSource().matchAll(HEADER_WITH_LID)].map((m) => m[1]);

  it("the Rust side still writes a license header at all", () => {
    // The positive control. Without it a pattern that stops matching — a
    // refactor moving or reshaping the call — passes by finding nothing, and a
    // zero-match walk is indistinguishable from a clean one.
    expect(
      matches.length,
      `${RUST_FILE} contains no \`.header("…", lid)\` call. Either the licensed updater ` +
        "stopped sending the header (in which case every licensed check is now `no-header` " +
        "and silently unserved), or the call was reshaped and this pin needs its pattern " +
        "updated — it is not passing.",
    ).toBeGreaterThan(0);
  });

  it("every Rust literal matches the Worker's LICENSE_HEADER", () => {
    // Compared CASE-SENSITIVELY. HTTP header names are case-insensitive on the
    // wire, so this pins the source convention rather than a protocol
    // requirement — do not "fix" it to `toLowerCase()`, which would delete the
    // drift signal without changing what either side sends.
    for (const literal of matches) {
      expect(
        literal,
        `${RUST_FILE} sends "${literal}" but the update Worker reads ` +
          `"${LICENSE_HEADER}". A mismatch makes every licensed update check look like an ` +
          "unlicensed one to the Worker: 204, no manifest, and the app says \"You're up to " +
          'date" forever. `no-header` is deliberately non-alertable, so nothing else catches ' +
          "this.",
      ).toBe(LICENSE_HEADER);
    }
  });
});
