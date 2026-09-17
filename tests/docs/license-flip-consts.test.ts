import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { REPO_ROOT, rustSourceDefining, rustSources } from "./rust-sources.js";

/**
 * **The link between the two consts that flip at v1.0** (#1785).
 *
 * Two flags arm the licensing system, in two languages, and until this file
 * nothing connected them: `LICENSE_GATE_ENABLED` in `tsup.config.ts` (the run
 * gate) and `LICENSE_UPDATE_ENDPOINT` in the Tauri crate (the update window).
 * Flipping the first alone arms the gate and leaves the update window inert —
 * `resolve_update_route` returns `Public` on its first line while the endpoint
 * is empty, and `Public` is the public manifest from `tauri.conf.json`.
 *
 * So this asserts the BICONDITIONAL — gate dark ⟺ endpoint empty — in both
 * directions. `check` is a required status check on `master`, so flipping
 * either const alone turns the merge red. That is the whole of "impossible or
 * loud"; nothing here flips anything.
 *
 * It also carries two count asserts on the route shape. They are the cheapest
 * available pin on the half of #1785 that `cargo test` cannot reach:
 * `build_updater` needs an `AppHandle` no test can construct, so a lazy
 * `UpdateRoute::NoUpdates(_) => app.updater()` — the filed bug, unchanged —
 * would pass every cargo case and the whole TS suite, and the PR would land as
 * a no-op that reads as done.
 *
 * Mutation-checked by hand (restore from a file copy, never `git checkout`):
 * flip either literal ⇒ red; rename either const ⇒ red (not quietly skipped);
 * paste a commented-out `const LICENSE_UPDATE_ENDPOINT: &str = "https://x";`
 * above the live one ⇒ stays GREEN; paste a commented-out
 * `const LICENSE_GATE_ENABLED = false;` above a flipped-to-`true` live one ⇒
 * red (the tsup half is comment-stripped for the same reason the Rust half
 * reads `.code`); add a second `app.updater()` ⇒ red; add an
 * `Ok(UpdateOutcome::Withheld(_)) => show_up_to_date_dialog(app)` arm ⇒ red;
 * add a second `show_update_window_ended_dialog(app)` call anywhere ⇒ red;
 * delete the one in `check_for_update`'s `Ok(None)` arm ⇒ red.
 */

const TSUP_CONFIG = join(REPO_ROOT, "tsup.config.ts");

/**
 * The crate walked ONCE for this file — each `rustSources()` call re-reads and
 * re-strips every `.rs` file, and this file otherwise wanted four walks.
 */
const RUST_SOURCES = rustSources();
/** Every Rust file's comment- and test-stripped code, concatenated. */
const ALL_RUST_CODE = RUST_SOURCES.map((f) => f.code).join("\n");

/**
 * `src` with `//` line comments removed. `://` in a URL is left alone — the same
 * rule `stripRustComments` uses, because TypeScript's line-comment syntax is
 * Rust's.
 *
 * **Block comments are deliberately NOT stripped here, and reusing
 * `stripRustComments` for this was a real bug**, not a style preference: its
 * `/\/\*[\s\S]*?\*\//` rule treats the glob in `tsup.config.ts`'s own
 * `src/server/license/*` comment as an opening `/*` and eats everything through
 * the next `*` + `/` in the file — including the declaration this reads. It
 * returned zero matches. The block-comment case is covered instead by the
 * line-start anchor and the exactly-one count below.
 */
function stripLineComments(src: string): string {
  return src.replace(/(^|[^:])\/\/.*$/gm, "$1");
}

/**
 * The `false` / `true` literal `tsup.config.ts` declares the run gate with.
 *
 * **A commented-out copy must not be able to answer this**, which is the same
 * defence the Rust half carries by reading `.code` and never `.text`. Without
 * it, writing ``// Was `const LICENSE_GATE_ENABLED = false;` until v1.0.`` above
 * the live `= true` — a natural thing to write at the flip, and the exact
 * spelling the docs repeat everywhere — makes a first-match read report "false"
 * while the gate is armed. With the endpoint still empty, the biconditional then
 * passes on a HALF-FLIP: #1785 itself, and the one failure this file exists to
 * catch. The vacuity is one-directional — the opposite mistake fails RED — so it
 * lands squarely on the case that matters.
 *
 * Two things close it together, because either alone leaves a gap:
 * - `//` comments are stripped, so a commented-out duplicate on its own line is
 *   simply not there.
 * - The match is **anchored to the start of a line** and must occur **exactly
 *   once**. An indented or `*`-prefixed copy inside a block comment does not
 *   match at all; an unindented one inside a block comment makes the count 2 and
 *   turns this red rather than shadowing the live declaration.
 *
 * Zero matches is red too (a rename or reshape disarms the pin rather than
 * passing it), which is why the count is asserted rather than the first hit
 * read defensively.
 */
function readGateLiteral(): string {
  const src = stripLineComments(readFileSync(TSUP_CONFIG, "utf8"));
  const matches = [...src.matchAll(/^const\s+LICENSE_GATE_ENABLED\s*=\s*(true|false)\s*;/gm)];
  expect(
    matches.length,
    "tsup.config.ts must declare LICENSE_GATE_ENABLED as exactly one top-level boolean " +
      `literal — found ${matches.length}. Zero means the pin is disarmed, not passing; two ` +
      "or more means a first-match read could pick a commented-out copy instead of the live one.",
  ).toBe(1);
  return matches[0][1];
}

/** The string literal the Rust crate declares the update endpoint with. */
function readEndpointLiteral(): string {
  // Resolve the FILE through `rustSourceDefining` rather than reading `lib.rs`
  // at a hardcoded path: that helper exists because a hardcoded scope already
  // failed silently here once (a const extracted into `pending_update.rs` left
  // the scan and the check went quiet), and `lib.rs` is mid-split into six
  // modules. Both failure directions are loud — zero matches and two-or-more
  // both throw rather than picking one.
  const source = rustSourceDefining(
    /const\s+LICENSE_UPDATE_ENDPOINT\s*:\s*&'?\w*\s*str\s*=/,
    "LICENSE_UPDATE_ENDPOINT",
  );
  // The helper's required positive control: a walk that silently returns
  // nothing satisfies every assertion built on it.
  expect(
    RUST_SOURCES.map((f) => f.rel),
    "the Rust walk no longer sees the file defining LICENSE_UPDATE_ENDPOINT",
  ).toContain(source.rel);

  // `.code`, NEVER `.text`. `rustSourceDefining` picks the FILE by matching
  // `code` (comments and `#[cfg(test)]` bodies stripped) but hands back both.
  // A first-hit match against `text` prefers a commented-out
  // `const LICENSE_UPDATE_ENDPOINT: &str = "https://…";` sitting above the live
  // one — the exact defeat the helper's own docblock records review having
  // constructed. At flip time that reads "endpoint still empty" while the real
  // const is set, and the biconditional passes on a HALF-FLIP: the single
  // failure this file exists to catch.
  const match = /const\s+LICENSE_UPDATE_ENDPOINT\s*:\s*&'?\w*\s*str\s*=\s*"([^"]*)"\s*;/.exec(
    source.code,
  );
  expect(
    match,
    `${source.rel} no longer declares LICENSE_UPDATE_ENDPOINT as a plain string literal — ` +
      "the pin is disarmed, not passing",
  ).not.toBeNull();
  return (match as RegExpExecArray)[1];
}

function countOccurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

/**
 * All whitespace removed, so the counts below pin a CALL rather than a
 * formatting choice.
 *
 * `cargo fmt` is not clean on this crate (220 files differ) and is not in any
 * gate, so it can be run at any time — and running it splits
 * `app.updater().map_err(…)` onto `app\n.updater()`, which takes a literal
 * `"app.updater()"` count to **zero**. That disarms the pin with no behaviour
 * change and no failing test: exactly the shape of failure these counts exist
 * to catch. Collapsing first also means the pins survive a line-length change
 * in any of the three call sites.
 *
 * The definitions stay distinguishable through the collapse, which is what
 * makes the counts discriminating: `show_up_to_date_dialog(app:&tauri…` does not
 * contain `show_up_to_date_dialog(app)`.
 */
const COMPACT_RUST_CODE = ALL_RUST_CODE.replace(/\s+/g, "");

describe("the two consts that flip at v1.0 (#1785)", () => {
  it("gate dark ⟺ update endpoint empty, in both directions", () => {
    const gateEnabled = readGateLiteral() === "true";
    const endpointEmpty = readEndpointLiteral() === "";

    expect(
      gateEnabled,
      "LICENSE_GATE_ENABLED and LICENSE_UPDATE_ENDPOINT must flip in the SAME commit " +
        "(docs/licensing-operations.md §4). " +
        (gateEnabled
          ? "The run gate is ARMED while the Tauri crate's LICENSE_UPDATE_ENDPOINT is still " +
            "empty — resolve_update_route returns Public on its first line, so every licensed " +
            "device gets the PUBLIC manifest from tauri.conf.json and the update window gates " +
            "nobody."
          : "LICENSE_UPDATE_ENDPOINT is set while LICENSE_GATE_ENABLED is still false in " +
            "tsup.config.ts — the sidecar reports gate_active: false, so update_route answers " +
            "Public anyway and the endpoint is dead configuration."),
    ).toBe(!endpointEmpty);
  });
});

describe("the flip checklist points at symbols, not line numbers (#1785)", () => {
  /**
   * `docs/licensing-explained.md` is the doc CLAUDE.md says to "start there" for
   * the flip, and its banner already carried a line number that had gone stale:
   * `src-tauri/src/lib.rs:171` names `LICENSE_STATUS_URL`, not
   * `LICENSE_UPDATE_ENDPOINT` (:178). Following it repoints the updater's
   * loopback probe, after which `update_route` answers `status-unavailable` for
   * every device — licensed, trial and restricted — with a `log::warn!` as the
   * only signal.
   *
   * So the banner names consts and functions, which grep finds, rather than
   * `lib.rs:<n>`, which drifts on any edit to a file mid-split into six modules
   * and drifts *silently*. This asserts that, rather than asserting a number
   * that would itself need maintaining.
   */
  it("names both consts and cites no lib.rs line number", () => {
    const doc = readFileSync(join(REPO_ROOT, "docs", "licensing-explained.md"), "utf8");
    expect(doc).toContain("LICENSE_GATE_ENABLED");
    expect(doc).toContain("LICENSE_UPDATE_ENDPOINT");
    const lineRefs = doc.match(/lib\.rs:\d[\d-]*/g) ?? [];
    expect(
      lineRefs,
      "the flip checklist must cite symbol names, not lib.rs line numbers — a stale one " +
        "sent an operator to LICENSE_STATUS_URL, one const above the target",
    ).toEqual([]);
  });
});

/**
 * `build_updater`'s body, comment-stripped and whitespace-collapsed.
 *
 * **Scoped to the function on purpose.** The first draft of the runbook pin
 * below searched the WHOLE crate, and the stale claim it was written to catch
 * — "`build_updater` returns `Ok(None)`" — passed it, because `Ok(None)` is a
 * real arm of `updater.check()` thirty lines further down. A claim about one
 * function has to be read against that function.
 *
 * Brace-matched from the signature rather than regexed: the body's only braces
 * inside a string are `format!`'s balanced `{e}`, so the count is sound, and a
 * `cargo fmt` reflow cannot move the end.
 */
function compactBuildUpdaterBody(): string {
  const source = rustSourceDefining(/async\s+fn\s+build_updater\s*\(/, "build_updater");
  const start = source.code.search(/async\s+fn\s+build_updater\s*\(/);
  const open = source.code.indexOf("{", start);
  expect(open, `${source.rel} defines build_updater with no body`).toBeGreaterThan(-1);
  let depth = 0;
  for (let i = open; i < source.code.length; i++) {
    if (source.code[i] === "{") depth++;
    else if (source.code[i] === "}" && --depth === 0) {
      return source.code.slice(open, i + 1).replace(/\s+/g, "");
    }
  }
  throw new Error(`unbalanced braces reading build_updater out of ${source.rel}`);
}

describe("the flip-day runbook describes the updater arm the crate has (#1785)", () => {
  /**
   * `docs/licensing-operations.md` is the RUNBOOK — the file an operator works
   * from on flip day — and **nothing read it.** Its §8 withheld row still
   * described the shape this work replaced: "`build_updater` returns `Ok(None)`
   * … a manual check shows an honest placeholder line". The branch returns
   * `Ok(UpdateOutcome::Withheld(reason))` and fires a native dialog. An operator
   * verifying the no-manifest arm would grep `Ok(None)`, find nothing, and
   * either call the fix absent or go verify some other surface.
   *
   * So the row's two load-bearing nouns are pinned against the crate rather
   * than proofread: the return shape it names must be a construct the Rust code
   * actually contains, and the surfacing it promises must be a function the
   * crate defines. Both fail on a zero match — a reworded row that drops the
   * claim disarms the pin rather than passing it, which is the same rule the
   * const literals above are read under.
   */
  const OPS_DOC = readFileSync(join(REPO_ROOT, "docs", "licensing-operations.md"), "utf8");

  it("the return shape §8 tells you to expect is one build_updater returns", () => {
    const claim = /`build_updater`\s+returns\s+`([^`]+)`/.exec(OPS_DOC);
    expect(
      claim,
      "docs/licensing-operations.md §8 no longer states what build_updater returns on the " +
        "no-manifest arm — the pin is disarmed, not passing",
    ).not.toBeNull();
    const shape = (claim as RegExpExecArray)[1].replace(/\s+/g, "");
    expect(
      compactBuildUpdaterBody().includes(shape),
      `§8 tells an operator build_updater returns ${shape}, which appears nowhere in that ` +
        "function. A runbook that names a shape grep cannot find in the arm it describes reads " +
        "as a missing fix.",
    ).toBe(true);
  });

  it("the surfacing §8 promises is a function the crate defines", () => {
    expect(
      OPS_DOC,
      "§8's withheld row must name the dialog the withheld arm actually shows — the earlier " +
        '"an honest placeholder line" named no surface at all',
    ).toContain("show_update_withheld_dialog");
    expect(
      COMPACT_RUST_CODE,
      "the runbook names a dialog function the crate does not define",
    ).toContain("fnshow_update_withheld_dialog(");
  });
});

describe("the update route shape #1785 fixes (#1785)", () => {
  // `app.updater()` is the PUBLIC manifest. It belongs to `build_updater`'s
  // `Public` arm alone. A lazy `NoUpdates(_) => app.updater().map_err(…)` —
  // i.e. the filed bug, unchanged — makes this 2 and passes every cargo case.
  it("app.updater() appears exactly once in the crate", () => {
    expect(
      countOccurrences(COMPACT_RUST_CODE, "app.updater()"),
      "app.updater() serves the PUBLIC manifest and belongs to build_updater's Public arm " +
        "only. A second occurrence means some other route — most likely NoUpdates — is " +
        "falling back to public builds, which is #1785 itself.",
    ).toBe(1);
  });

  // Spelled `(app)`, not a bare `show_up_to_date_dialog(`, because the
  // DEFINITION reads `fn show_up_to_date_dialog(app: &tauri::AppHandle)` and
  // would satisfy the looser spelling, making the count non-discriminating.
  // The withheld state must reach the SCREEN from both boundaries, not just the
  // log. `install_update`'s `Err("UPDATE_WITHHELD")` reaches only
  // `useUpdaterBanner.svelte.ts`'s catch, which `console.warn`s and re-arms the
  // CTA — no dialog, no toast, no banner text — so "Restart to install"
  // produced nothing at all on screen. Rust owns the dialog on both.
  it("show_update_withheld_dialog is called from both withheld boundaries", () => {
    const calls =
      countOccurrences(COMPACT_RUST_CODE, "show_update_withheld_dialog(app,reason)") +
      countOccurrences(COMPACT_RUST_CODE, "show_update_withheld_dialog(&app,reason)");
    expect(
      calls,
      "the withheld dialog belongs to BOTH check_for_update's manual path and " +
        "install_update's banner-CTA path. One call means the other boundary is a silent " +
        "no-op on screen — the failure perform_install explicitly refuses.",
    ).toBe(2);
  });

  it("show_up_to_date_dialog(app) is called exactly once", () => {
    expect(
      countOccurrences(COMPACT_RUST_CODE, "show_up_to_date_dialog(app)"),
      '"You\'re running the latest version" is the exact lie #1786 exists to detect. It may ' +
        "be shown only for a real Ok(None) from updater.check() — never on the withheld-manifest " +
        "arm, which serves no manifest and never calls check() at all.",
    ).toBe(1);
  });

  /**
   * The ended-window arm has to reach the SCREEN, and nothing else can see that
   * (#1819). `check_for_update` needs an `AppHandle` no `cargo test` can build,
   * and on a dark build `resolve_update_route` returns `(Public, false)` before
   * probing, so the branch is unreachable by hand too — an implementation that
   * defines `window_ended_copy` and `local_window_ended`, tests both, threads
   * the flag through `UpdateOutcome::Serve` and never touches the `Ok(None)` arm
   * compiles with at most a `dead_code` warning and passes every other check.
   *
   * Discriminating for the same reason its neighbour above is: `rust-sources.ts`
   * strips comments and `#[cfg(test)]`, and after `\s+` collapse neither the
   * definition (`fnshow_update_window_ended_dialog(app:&tauri::AppHandle)`) nor
   * the `attach_main_window_or_warn(app,builder,"show_update_window_ended_dialog")`
   * wiring line contains the searched `(app)` spelling. Only the real call site
   * can satisfy it, so the lazy implementation reads 0.
   *
   * What it still cannot see is which side of the `if/else` each dialog sits on
   * — that stays a hand-check on the diff.
   */
  it("show_update_window_ended_dialog(app) is called exactly once", () => {
    expect(
      countOccurrences(COMPACT_RUST_CODE, "show_update_window_ended_dialog(app)"),
      "a licensed device whose LOCAL update window has ended must be told so on the manual " +
        "check, not told it is up to date. Zero means the branch never left " +
        "resolve_update_route's log::warn! — the no-op PR that reads as done.",
    ).toBe(1);
  });
});
