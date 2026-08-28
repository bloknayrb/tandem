/**
 * Source-text pins for the #1371 fix, which no compiler on any CI leg can check.
 *
 * The freeze this issue reports comes from *how* the command is declared, not
 * from anything a type says. Every one of these properties reverts cleanly:
 *
 *  - dropping `async` / `spawn_blocking` compiles fine and puts the blocking
 *    process wait back on the main thread (or, worse, on a tokio worker);
 *  - dropping the in-flight guard compiles fine and restores the process pileup
 *    that moving off the main thread creates, because the main thread WAS the
 *    serialization;
 *  - swapping `output_with_timeout` back for `.output()` compiles fine on every
 *    platform *including* CI's windows-latest leg, so without the assertion
 *    below the timeout half of this fix has no automated coverage anywhere.
 *
 * Lives in `tests/build/` (the node project): it reads files as text and needs
 * no svelte plugin. Precedent for the style: `subnet-reason-alignment.test.ts`
 * and `tests/docs/loopback-gate-claims.test.ts`.
 *
 * Known weakness, stated rather than hidden: these are regexes over source, so
 * a sufficiently different reformatting defeats them. Every assertion is a
 * POSITIVE match, so a regex that stops matching fails rather than passes.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { rustSourceDefining } from "../docs/rust-sources.js";

const repoRoot = path.resolve(__dirname, "../..");

function read(rel: string): string {
  return readFileSync(path.join(repoRoot, rel), "utf8");
}

/**
 * The module holding the Cowork commands, **found by construct, not named**.
 *
 * This read `src-tauri/src/lib.rs` by path until Unit 11d moved the commands
 * into `cowork_commands.rs`. A hardcoded path is the shape that goes quiet
 * rather than red across the Unit 11 split — every `indexOf`/`matchAll` below
 * would simply find nothing, and only their explicit not-found assertions stand
 * between that and a silent pass. `firewall.rs`, `single_flight.rs` and
 * `uninstall_scrub.rs` are still read by name below because nothing is moving
 * them and their claims are about those modules specifically.
 *
 * The visibility is left open in the pattern: Unit 11d widened the commands to
 * `pub(crate)` so `generate_handler!` in `lib.rs` can still name them.
 */
const COWORK_COMMANDS = rustSourceDefining(
  /#\[tauri::command\]\s*(?:pub(?:\(crate\))?\s+)?async fn cowork_detect_vethernet_subnet\s*\(/,
  "cowork_detect_vethernet_subnet",
);

/**
 * The source of a Rust fn: from its signature to its brace-balanced end.
 *
 * Balanced rather than "the next line starting with `}`", because
 * `detect_vethernet_subnet` embeds a PowerShell script in an `r#"…"#` raw string
 * whose own closing brace sits at column zero. Raw strings, ordinary strings and
 * line comments are all skipped so a brace inside them cannot end the scan.
 *
 * **Callers reading a module found by `rustSourceDefining` must pass `.code`,
 * never `.text`.** The comment-skipping above happens inside the brace scan,
 * i.e. AFTER the `indexOf` that picks which occurrence to scan — so a comment
 * containing the signature wins outright. Review ran it: three `//!` lines
 * naming `` fn cowork_toggle_integration( `` were enough to make the enable-path
 * budget pin below pass with the defect it exists to catch in place, and
 * `cowork_commands.rs` already carries a doc comment naming that function one
 * `(` short of tripping it. The `firewall.rs` / `single_flight.rs` callers pass
 * raw text because those files are read by name and carry no such prose.
 */
function rustFnBody(src: string, signature: string): string {
  const start = src.indexOf(signature);
  expect(start, `\`${signature}\` not found — the declaration's shape changed`).toBeGreaterThan(-1);
  return rustFnBodyAt(src, start, signature);
}

/**
 * The same scan, from a known offset rather than a text key.
 *
 * Needed wherever the caller already has the declaration's position and there
 * is more than one of them: keying by text re-finds the FIRST occurrence every
 * time, so N arms of the same function all resolve to arm one. That was true of
 * `detect_subnet_advisory_blocking` below, whose two arms were being located by
 * a 40-character source slice — identical for both — so the non-Windows arm was
 * never actually scanned and the `.some(...)` over them was a `.some` over one.
 */
function rustFnBodyAt(src: string, start: number, label: string): string {
  let i = src.indexOf("{", start);
  expect(i, `no opening brace after \`${label}\``).toBeGreaterThan(-1);

  let depth = 0;
  while (i < src.length) {
    if (src.startsWith("//", i)) {
      i = src.indexOf("\n", i);
      if (i === -1) break;
      continue;
    }
    const raw = /^r(#*)"/.exec(src.slice(i, i + 8));
    if (raw) {
      const close = `"${raw[1]}`;
      const end = src.indexOf(close, i + raw[0].length);
      i = end === -1 ? src.length : end + close.length;
      continue;
    }
    const ch = src[i];
    if (ch === '"') {
      i += 1;
      while (i < src.length && src[i] !== '"') i += src[i] === "\\" ? 2 : 1;
      i += 1;
      continue;
    }
    if (ch === "{") depth += 1;
    if (ch === "}") {
      depth -= 1;
      if (depth === 0) return src.slice(start, i + 1);
    }
    i += 1;
  }
  throw new Error(`unbalanced braces while scanning \`${label}\``);
}

describe("the Cowork subnet probe stays off the main thread (#1371)", () => {
  const lib = COWORK_COMMANDS.code;

  it("scans a real Rust module, found by search rather than named here", () => {
    // The control on the locator. Renaming the module must stay GREEN — that is
    // what finding it by construct buys. What must not stay green is the module
    // ceasing to hold the other two subjects: `cowork_toggle_integration` and
    // `detect_subnet_advisory_blocking` are read out of THIS file by the budget
    // pins below, so a future unit that splits them apart has to re-point them
    // rather than discover it through a thrown brace-scanner error.
    for (const sig of ["fn cowork_toggle_integration(", "fn detect_subnet_advisory_blocking("]) {
      expect(
        COWORK_COMMANDS.code,
        `${sig} is no longer in the module located by cowork_detect_vethernet_subnet — ` +
          "the budget pins below read it from there",
      ).toContain(sig);
    }
  });

  it("declares the command as a single ungated `async fn`", () => {
    const decls = [
      ...lib.matchAll(/^(?:pub(?:\(crate\))?\s+)?async fn cowork_detect_vethernet_subnet\(/gm),
    ];
    expect(
      decls.length,
      "expected exactly one `async fn cowork_detect_vethernet_subnet`. Zero means it reverted to a sync command, which Tauri dispatches inline on the main thread; two means it was re-split into cfg-gated arms, which puts the fix back where no non-Windows build type-checks it",
    ).toBe(1);

    // The cfg split belongs on the blocking BODY, never on the command.
    //
    // Scanned back to the nearest NON-BLANK line rather than over a fixed
    // window. Review defeated the fixed 4-line version by exploiting the fact
    // that Rust permits blank lines between an attribute and its item: gate the
    // real command, push it four blank lines down, and add a SYNC
    // `#[cfg(not(target_os = "windows"))]` arm, and the `async` count stays 1
    // while the window sees only whitespace. That is precisely the re-split the
    // failure message above claims to catch, and off Windows the command would
    // be dispatched inline on the main thread again.
    const preceding = lib
      .slice(0, decls[0].index ?? 0)
      .split("\n")
      .filter((line) => line.trim() !== "");
    expect(
      preceding.slice(-3).join("\n"),
      "the command itself must not be cfg-gated — only `detect_subnet_advisory_blocking` is",
    ).not.toMatch(/#\[cfg\(\s*(not\()?target_os/);
  });

  it("runs the blocking work on the blocking pool, behind the in-flight guard", () => {
    const body = rustFnBody(lib, "async fn cowork_detect_vethernet_subnet(");

    // Not interchangeable with `#[tauri::command(async)]` on a sync fn:
    // `body_async` calls the sync fn inside the future and hands it to
    // `async_runtime::spawn`, i.e. tokio's WORKER pool.
    expect(
      body,
      "the probe must go through `spawn_blocking`, not run directly inside the future",
    ).toContain("spawn_blocking");

    expect(
      body,
      "the in-flight guard is what replaces the serialization the main thread used to provide for free",
    ).toContain("SUBNET_PROBE_FLIGHT");
  });
});

describe("the in-flight guard stays a guard and not a cache (#1371)", () => {
  const singleFlight = read("src-tauri/src/single_flight.rs");

  it("clears the registration BEFORE publishing the result", () => {
    // Order-only, and invisible from inside the module: publish-then-clear leaves
    // every `single_flight` unit test green while opening a real window. The
    // leader publishes at T and clears at T+e; a caller enlisting inside
    // (T, T+e) finds the finished slot still registered, becomes a follower, and
    // is handed the completed flight's answer. A cached answer served after the
    // flight ended is exactly what `cowork-invoke.ts` forbids — "the VM can stop
    // between the two" — so the guard would silently start lying about a machine
    // whose Cowork session had since started or stopped.
    const drop = rustFnBody(singleFlight, "fn drop(&mut self) {");

    const clear = drop.indexOf("*current = None");
    const publish = drop.indexOf("Publication::Value");
    const notify = drop.indexOf("notify_all");

    expect(clear, "the registration clear (`*current = None`) is gone").toBeGreaterThan(-1);
    expect(publish, "the publish (`Publication::Value`) is gone").toBeGreaterThan(-1);
    expect(notify, "the wake (`notify_all`) is gone").toBeGreaterThan(-1);

    expect(clear, "the registration must be cleared before the result is published").toBeLessThan(
      publish,
    );
    expect(clear, "the registration must be cleared before followers are woken").toBeLessThan(
      notify,
    );
  });
});

describe("every external process on the Cowork firewall path is bounded (#1371)", () => {
  const firewall = read("src-tauri/src/firewall.rs");

  it.each([
    ["pub fn detect_vethernet_subnet(", "the PowerShell adapter query"],
    ["fn run_netsh(", "netsh rule add/delete"],
    ["pub fn scan_orphan_rules(", "the orphan-rule scan"],
  ])("%s uses output_with_timeout and never a bare .output()", (signature, what) => {
    const body = rustFnBody(firewall, signature);
    expect(body, `${what} must be deadline-bounded`).toContain("output_with_timeout");
    expect(
      body,
      `${what} still calls \`.output()\`, which blocks with no deadline — the exact shape #1371 reports`,
    ).not.toMatch(/\.output\(\)/);
  });

  // The spawn-time counterpart to the deadline pins above, and it needs to be a
  // TEXT pin for a reason worth stating: the live tests in `firewall.rs` that
  // actually run netsh and powershell pass just as happily against
  // `Command::new("netsh")`, because netsh and powershell are on PATH on every
  // developer machine and every CI runner. They prove the resolver points at a
  // real binary; only this pin proves the code uses it. `firewall.rs` is
  // `#![cfg(target_os = "windows")]` and is not even lexed on the Linux legs,
  // which is why this file's invariants are pinned as source text.
  it.each([
    ["pub fn detect_vethernet_subnet(", "the PowerShell adapter query"],
    ["fn run_netsh(", "netsh rule add/delete"],
    ["pub fn scan_orphan_rules(", "the orphan-rule scan"],
  ])("%s spawns an anchored path, never a bare program name", (signature, what) => {
    const body = rustFnBody(firewall, signature);
    expect(
      body,
      `${what} passes a string literal to Command::new — Rust resolves a bare name itself, ` +
        `searching the (user-writable) application directory ahead of System32`,
    ).not.toMatch(/Command::new\(\s*"/);
  });

  it("resolves every firewall program through system_paths, and never by bare name", () => {
    // Comments are stripped first: both files explain the hazard by quoting the
    // very shape being banned (`Command::new("netsh")`), so a raw scan reports
    // the documentation as the violation.
    const withoutComments = (src: string) => src.replace(/^\s*(\/\/.*|\/\/\/.*|\/\/!.*)$/gm, "");

    // File-wide rather than per-body: `run_netsh` and `scan_orphan_rules` reach
    // the resolver through `netsh_path()`, so a body-scoped pin alone would go
    // green if that helper were rewritten to hand back a bare name.
    expect(firewall).toContain("crate::system_paths::");
    expect(
      withoutComments(firewall),
      "a bare program name anywhere in firewall.rs defeats the anchoring",
    ).not.toMatch(/Command::new\(\s*"/);

    // The uninstall scrub is the same class and the same commit: it runs inside
    // the signed binary specifically so no planted executable runs at uninstall.
    const scrub = read("src-tauri/src/uninstall_scrub.rs");
    expect(scrub).toContain("crate::system_paths::");
    expect(
      withoutComments(scrub),
      "the scrub spawns a bare program name, which is what running inside the signed binary exists to prevent",
    ).not.toMatch(/Command::new\(\s*"/);
  });

  it("keeps the two subnet budgets separate and different", () => {
    // The asymmetry is deliberate: on the advisory path a timeout costs a
    // re-check, so it fails fast; on the Enable path a FALSE timeout aborts an
    // enable that would have succeeded, so it is generous. Collapsing them back
    // to one constant erases that.
    const advisory = /SUBNET_PROBE_TIMEOUT_ADVISORY: Duration = Duration::from_secs\((\d+)\)/.exec(
      firewall,
    );
    const enable = /SUBNET_PROBE_TIMEOUT_ENABLE: Duration = Duration::from_secs\((\d+)\)/.exec(
      firewall,
    );
    expect(advisory, "SUBNET_PROBE_TIMEOUT_ADVISORY not found").not.toBeNull();
    expect(enable, "SUBNET_PROBE_TIMEOUT_ENABLE not found").not.toBeNull();
    expect(
      Number(enable?.[1]),
      "the Enable budget must stay strictly more generous than the advisory one",
    ).toBeGreaterThan(Number(advisory?.[1]));
  });

  it("passes the generous budget on the enable path and the fast one on the probe", () => {
    const lib = COWORK_COMMANDS.code;
    const toggle = rustFnBody(lib, "fn cowork_toggle_integration(");
    expect(
      toggle,
      "the enable path must use the generous budget — a false timeout here aborts a real enable",
    ).toContain("SUBNET_PROBE_TIMEOUT_ENABLE");

    // Two arms share this name (Windows and stub); only the Windows one probes,
    // so assert the advisory constant appears in at least one of them.
    //
    // Located by OFFSET, not by a text key. The previous form built a key by
    // slicing 40 characters from each match — identical for both arms — and fed
    // it to an `indexOf`, so both entries resolved to arm one and the `.some`
    // below was a `.some` over a single body twice.
    const advisoryArms = [...lib.matchAll(/fn detect_subnet_advisory_blocking\(/g)].map((m) =>
      rustFnBodyAt(lib, m.index ?? 0, "detect_subnet_advisory_blocking"),
    );
    expect(
      advisoryArms.length,
      "expected both arms of detect_subnet_advisory_blocking — the Windows probe and its stub",
    ).toBe(2);
    expect(
      advisoryArms.some((arm) => arm.includes("SUBNET_PROBE_TIMEOUT_ADVISORY")),
      "the advisory probe must use the fast budget — timing out there costs only a re-check",
    ).toBe(true);
  });
});
