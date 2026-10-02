/**
 * Cowork setup ships dark (ADR-055) — the Rust half of the gate, pinned as text.
 *
 * WHY A TEXT TEST. Every command here is `#[cfg(target_os = "windows")]`, and
 * no cargo test calls a `#[tauri::command]`: the Rust tests exercise inner
 * helpers (`heal_pass_inner`, `enable_persist_outcome`, the installer's own
 * functions). So a `refuse_if_dark()?` deleted from one command, or a new
 * command added without one, leaves `cargo test` green on all three legs. The
 * pure half (`refuse_if(false)` is an `Err`) is covered in Rust; that a command
 * actually CALLS the gate is only visible here.
 *
 * WHAT IS PINNED, and the defeat each part exists for:
 *   - the two literals agree — a half-flip lights the UI over commands that
 *     refuse, or the reverse;
 *   - one row per `#[tauri::command]`, failing closed on a command with no row —
 *     a twelfth command arriving ungated;
 *   - where the gate sits in each gated arm — `cowork_toggle_integration` is
 *     the one command whose gate must NOT open the arm, because the same
 *     command is the disable path, and disable only removes;
 *   - the gate's own body — `|| cfg!(debug_assertions)` or an env read would
 *     leave both literals `false` and every row satisfied;
 *   - every reference to the gate and the literal, counted — a refusal added
 *     somewhere no row looks, or a second gate under another name;
 *   - the heal pass and its spawn sit under the const — the pass is not a
 *     command, runs with no UI, and writes the auth token into Claude
 *     Desktop's files;
 *   - a census of who calls a write primitive or writes meta — a new caller
 *     is the write path no command row can see.
 *
 * WHAT IT CANNOT SEE. These are shape checks. Nothing here invokes a command
 * and observes a refusal, and a write reached by a route the scanners do not
 * model (a primitive passed as a function value, a new primitive) is outside
 * them. They narrow what a careless edit can do; they are not a proof.
 *
 * All extraction runs on `code` (comments and `#[cfg(test)]` modules stripped):
 * two doc comments in the module name `cowork_toggle_integration(`, and a
 * first-hit match over `text` would land on prose.
 */

import { describe, expect, it } from "vitest";
import { COWORK_ENABLED } from "../../src/shared/constants.js";
import { matchRustBrace, rustSources } from "../docs/rust-sources.js";

const GATE_CALL = "refuse_if_dark()?;";

/** One walk of the crate for the whole file; `rustSources()` re-reads and re-strips on every call. */
const SOURCES = rustSources();

/** The module holding the literal, found by the construct rather than named. */
const COMMANDS = (() => {
  const hits = SOURCES.filter((f) => /\bconst COWORK_ENABLED\s*:\s*bool\s*=/.test(f.code));
  if (hits.length !== 1) {
    throw new Error(
      `expected exactly one Rust source to define COWORK_ENABLED, found ${hits.length}: ${hits.map((f) => f.rel).join(", ")}`,
    );
  }
  return hits[0];
})();

/**
 * Where a command is declared. `g` so the same shape enumerates them all.
 * Tolerates arguments on the attribute (`#[tauri::command(rename_all = …)]`)
 * and further attributes before the `fn`: either one, on a bare-attribute
 * matcher, lets a new command arrive with no row.
 */
const commandDecl = (name = String.raw`(\w+)`) =>
  new RegExp(
    String.raw`#\[tauri::command(?:\([^\]]*\))?\]\s*(?:#\[[^\]]*\]\s*)*(?:pub(?:\(crate\))?\s+)?(?:async\s+)?fn\s+${name}\s*\(`,
    "g",
  );

type Row = { gate: "arm-start" | "enable-branch"; why: string } | { gate: "none"; why: string };

/**
 * One row per command. `arm-start`: the gate is the first statement of the
 * Windows arm, after any leading `use` items. `enable-branch`: `if enabled {`
 * is itself the arm's first statement, after the same leading `use` items,
 * so nothing runs ahead of the branch,
 * and the gate is the first statement inside it. That is stricter than the
 * property needs (a hoisted read would be harmless) and deliberately so: an
 * edit that puts anything on the shared path should be looked at.
 */
const TABLE: Record<string, Row> = {
  cowork_toggle_integration: {
    gate: "enable-branch",
    why: "enable writes workspaces, meta and a firewall rule; disable only removes, so it is not refused",
  },
  cowork_rescan: {
    gate: "arm-start",
    why: "force-reinstalls into every workspace and writes meta when meta says enabled",
  },
  cowork_apply_token: { gate: "arm-start", why: "rewrites the token in every workspace" },
  cowork_install_into_workspace: { gate: "arm-start", why: "writes one workspace's entries" },
  cowork_set_lan_ip_override: {
    gate: "arm-start",
    why: "writes meta unconditionally, then re-walks workspaces when enabled",
  },
  cowork_retry_admin_elevation: {
    gate: "none",
    why: "delegates to cowork_toggle_integration(true) and nothing else (cowork-retry-delegates.test.ts), so the enable branch refuses for it",
  },
  cowork_uninstall_from_workspace: { gate: "none", why: "removal only" },
  cowork_scan_workspaces: {
    gate: "none",
    why: "read-only scan; mutates only the in-process handle snapshot",
  },
  cowork_get_status: { gate: "none", why: "read-only" },
  cowork_get_meta: { gate: "none", why: "read-only" },
  cowork_detect_vethernet_subnet: { gate: "none", why: "read-only advisory probe" },
};

function commandNames(code: string): string[] {
  return [...new Set([...code.matchAll(commandDecl())].map((m) => m[1]))].sort();
}

/** Body of the block whose `{` is the first one at or after `from`, braces excluded. */
function blockAfter(code: string, from: number): string {
  const open = code.indexOf("{", from);
  expect(open, "no opening brace found").toBeGreaterThan(-1);
  return code.slice(open + 1, matchRustBrace(code, open));
}

/**
 * The Windows arm of a cfg-split command. Anchored on the attribute pair, as
 * `cowork-retry-delegates.test.ts` is: the non-Windows stub has the same name
 * and would otherwise be a candidate.
 */
function windowsArm(code: string, name: string): string {
  const m = new RegExp(
    `#\\[cfg\\(target_os = "windows"\\)\\]\\s*#\\[tauri::command\\]\\s*(?:pub(?:\\(crate\\))?\\s+)?fn ${name}\\s*\\(`,
  ).exec(code);
  expect(m, `${name}: Windows arm not found — attribute order or signature changed`).not.toBeNull();
  return blockAfter(code, m?.index ?? 0);
}

/** First statement of a block, skipping blank lines and leading `use` items. */
function firstStatement(body: string): string {
  let rest = body.trimStart();
  for (;;) {
    const use = /^use\s[^;]*;/.exec(rest);
    if (!use) break;
    rest = rest.slice(use[0].length).trimStart();
  }
  return rest;
}

describe("Cowork ships dark (ADR-055): the Rust gate", () => {
  it("the TypeScript and Rust literals agree", () => {
    const m = /\bconst COWORK_ENABLED\s*:\s*bool\s*=\s*(true|false)\s*;/.exec(COMMANDS.code);
    expect(m, "Rust COWORK_ENABLED is no longer a bare bool literal").not.toBeNull();
    expect(m?.[1]).toBe(String(COWORK_ENABLED));
  });

  it("the Rust literal has one definition, with no attribute on it", () => {
    // A `#[cfg(debug_assertions)]` / `#[cfg(not(…))]` pair of definitions
    // lights release builds while the first match still reads `false`, and
    // `cargo test` runs the debug one.
    const defs = SOURCES.flatMap((f) => [...f.code.matchAll(/\bconst COWORK_ENABLED\b/g)]);
    expect(defs).toHaveLength(1);
    expect(COMMANDS.code).not.toMatch(
      /#\[[^\]]*\]\s*(?:pub(?:\([^)]*\))?\s+)?const COWORK_ENABLED\b/,
    );
  });

  it("every reference to the gate and the literal is accounted for", () => {
    // Counted by identifier across the crate, not by the spelling of one call.
    // A refusal BUILT FROM THE GATE'S PARTS and added to a removal path (the
    // toggle's disable branch, a helper an ungated command goes through, a
    // second gate under another name) adds a reference, and shows here. A
    // refusal written from scratch, with its own `Err`, uses none of these
    // names (unless it reads the literal) and is not caught by this. The
    // toggle's row below forbids anything ahead of `if enabled`; a refusal
    // inside the disable branch itself, or inside an ungated command, written
    // without these names is caught by nothing here.
    const gated = Object.values(TABLE).filter((row) => row.gate !== "none");
    const refs = (id: string) =>
      SOURCES.reduce((n, f) => n + [...f.code.matchAll(new RegExp(`\\b${id}\\b`, "g"))].length, 0);
    expect({
      refuse_if_dark: refs("refuse_if_dark"),
      refuse_if: refs("refuse_if"),
      COWORK_DARK_ERR: refs("COWORK_DARK_ERR"),
      COWORK_ENABLED: refs("COWORK_ENABLED"),
    }).toEqual({
      refuse_if_dark: gated.length + 1, // one call per gated row, and the definition
      refuse_if: 2, // the definition, and the call inside `refuse_if_dark`
      COWORK_DARK_ERR: 2, // the definition, and `refuse_if`'s `Err`
      COWORK_ENABLED: 4, // the definition, `refuse_if_dark`, the heal pass, the heal spawn
    });
  });

  it("every #[tauri::command] in the module has a row, and every row a command", () => {
    expect(commandNames(COMMANDS.code)).toEqual(Object.keys(TABLE).sort());
  });

  for (const [name, row] of Object.entries(TABLE)) {
    if (row.gate === "arm-start") {
      it(`${name} opens its Windows arm with the gate`, () => {
        expect(firstStatement(windowsArm(COMMANDS.code, name)).startsWith(GATE_CALL)).toBe(true);
      });
    } else if (row.gate === "enable-branch") {
      it(`${name} gates the enable branch and nothing before it`, () => {
        const arm = windowsArm(COMMANDS.code, name);
        // Nothing at all runs ahead of the branch: after the leading `use`
        // items, `if enabled {` is the first statement. Anything there runs
        // for disable too, whether it refuses (by any spelling) or writes.
        expect(
          firstStatement(arm).startsWith("if enabled {"),
          "a statement ahead of `if enabled` runs on the disable path as well",
        ).toBe(true);
        const branch = arm.indexOf("if enabled {");
        expect(firstStatement(blockAfter(arm, branch)).startsWith(GATE_CALL)).toBe(true);
      });
    } else {
      it(`${name} is ungated, as its row says`, () => {
        const at = commandDecl(name).exec(COMMANDS.code);
        expect(at, `${name}: declaration not found`).not.toBeNull();
        expect(blockAfter(COMMANDS.code, at?.index ?? 0)).not.toContain("refuse_if_dark");
      });
    }
  }

  it("the gate reads the literal and nothing else", () => {
    const squash = (s: string) => s.replace(/\s+/g, " ").trim();
    const body = (fn: string) => {
      const at = new RegExp(`\\bfn ${fn}\\s*\\(`).exec(COMMANDS.code);
      expect(at, `${fn} not found`).not.toBeNull();
      return squash(blockAfter(COMMANDS.code, at?.index ?? 0));
    };
    expect(body("refuse_if_dark")).toBe("refuse_if(COWORK_ENABLED)");
    // Both arms of `refuse_if` are covered in Rust; here only that it consults
    // nothing but its argument.
    expect(body("refuse_if")).not.toMatch(/cfg!|env|debug_assertions|COWORK_ENABLED/);
  });

  it("the heal pass returns before doing anything while dark", () => {
    // Gated in the function as well as at its spawn: the spawn guard is one
    // caller, and a second caller anywhere in the crate would otherwise write
    // the token into every workspace with both literals false.
    const at = /\bfn cowork_heal_pass\s*\(/.exec(COMMANDS.code);
    expect(at, "cowork_heal_pass not found").not.toBeNull();
    const first = firstStatement(blockAfter(COMMANDS.code, at?.index ?? 0)).replace(/\s+/g, " ");
    expect(first.startsWith("if !COWORK_ENABLED { return Ok(0); }")).toBe(true);
  });

  it("the heal task is spawned only under the literal", () => {
    const lib = SOURCES.find((f) => f.rel === "src-tauri/src/lib.rs");
    expect(lib, "lib.rs not found").toBeDefined();
    const code = lib?.code ?? "";
    const calls = [...code.matchAll(/cowork_commands::cowork_heal_pass\b/g)];
    expect(calls, "expected exactly one heal-pass spawn site").toHaveLength(1);
    const guard = code.indexOf("if cowork_commands::COWORK_ENABLED {");
    expect(guard, "the heal spawn's guard is gone").toBeGreaterThan(-1);
    const open = code.indexOf("{", guard);
    const call = calls[0]?.index ?? -1;
    expect(call > open && call < matchRustBrace(code, open)).toBe(true);
  });
});

/**
 * The functions that write into a Cowork workspace or add a firewall rule.
 * The census is over calling FUNCTIONS, so a second call inside an
 * already-listed function is not a new row, and a new function is.
 * `add_cowork_deny_rule` has no caller today; it is listed so its first one
 * shows up here.
 */
const WRITE_PRIMITIVES = [
  "install_tandem_plugin_into_workspace",
  "apply_token_to_all_workspaces",
  "reconcile_stale_workspace_tokens",
  "add_cowork_allow_rule",
  "add_cowork_deny_rule",
];

/** `enabled: true` is itself a write that matters: it is what a heal pass acts on. */
const META_WRITE = String.raw`cowork_meta::(?:update|save)`;

const ALLOWED_CALLERS: Record<string, string> = {
  "cowork_commands.rs::cowork_toggle_integration": "gated on its enable branch",
  "cowork_commands.rs::cowork_rescan": "gated at arm start",
  "cowork_commands.rs::cowork_apply_token": "gated at arm start",
  "cowork_commands.rs::cowork_install_into_workspace": "gated at arm start",
  "cowork_commands.rs::cowork_set_lan_ip_override": "gated at arm start",
  "cowork_commands.rs::cowork_heal_pass": "not a command; returns before doing anything while dark",
};

/** Outermost functions in `code`, with their bodies. */
function topLevelFns(code: string): { name: string; body: string }[] {
  const out: { name: string; body: string }[] = [];
  let covered = 0;
  for (const m of code.matchAll(/\bfn\s+(\w+)\s*(?:<[^>(]*>)?\s*\(/g)) {
    const at = m.index ?? 0;
    if (at < covered) continue;
    const open = code.indexOf("{", at);
    if (open === -1) continue;
    const close = matchRustBrace(code, open);
    out.push({ name: m[1], body: code.slice(open + 1, close) });
    covered = close;
  }
  return out;
}

describe("Cowork ships dark (ADR-055): who can write into a workspace", () => {
  it("only the listed functions call a write primitive", () => {
    const called = new RegExp(String.raw`\b(?:${WRITE_PRIMITIVES.join("|")}|${META_WRITE})\s*\(`);
    const callers = SOURCES.flatMap((f) =>
      topLevelFns(f.code)
        .filter((fn) => called.test(fn.body))
        .map((fn) => `${f.rel.replace("src-tauri/src/", "")}::${fn.name}`),
    );
    expect(
      callers.length,
      "the census found no caller at all — the scan is broken",
    ).toBeGreaterThan(0);
    expect([...new Set(callers)].sort()).toEqual(Object.keys(ALLOWED_CALLERS).sort());
  });

  it("no write primitive is imported under another name", () => {
    // The census matches calls by name, so `use … as install` hides one, and
    // so does `use cowork_meta::update;` followed by a bare `update(…)`.
    const aliased = new RegExp(
      String.raw`\b(?:${WRITE_PRIMITIVES.join("|")})\s+as\s+\w+|\buse\s[^;]*cowork_meta::(?:\{[^}]*\b(?:update|save)\b|(?:update|save)\b)`,
    );
    expect(SOURCES.filter((f) => aliased.test(f.code)).map((f) => f.rel)).toEqual([]);
  });

  it("the uninstall scrub deletes cowork-meta.json", () => {
    // Nothing else pins the call: without it `enabled: true` outlives an
    // uninstall, and the scrub's own tests do not look.
    const scrub = SOURCES.find((f) => f.rel === "src-tauri/src/uninstall_scrub.rs");
    const at = /\bfn run_uninstall_scrub\s*\(/.exec(scrub?.code ?? "");
    expect(at, "run_uninstall_scrub not found").not.toBeNull();
    expect(blockAfter(scrub?.code ?? "", at?.index ?? 0)).toContain(
      "cowork_meta::remove_meta_file()",
    );
  });
});
