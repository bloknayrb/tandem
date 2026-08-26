import { readdirSync, readFileSync, statSync } from "fs";
import { join, relative, resolve } from "path";
import { describe, expect, it } from "vitest";

/**
 * Pins the scope of the config-mutation race accepted in
 * `docs/security.md#accepted-bounded--decided-not-fixed` (issue #1599).
 *
 * An accepted risk whose scope can widen silently is indistinguishable from
 * having missed the problem. The acceptance covers a specific set of
 * unsynchronized durable writers; this test derives that set **from source**
 * and fails when a site appears that nobody classified, so a new writer cannot
 * join the accepted set unnoticed.
 *
 * Two halves, and the second is not optional:
 *
 * 1. **The writer set** (`WRITER_SITES`), scoped to `src/server/integrations/`
 *    and `src/cli/`. Derivation is by CALL-SITE COUNT, not by function name: a
 *    seventh `atomicWrite` inside `apply.ts` is a new writer and must fail,
 *    while a name-keyed check would see the same key and pass.
 * 2. **The token-file separation invariant** (`TOKEN_FILE_REFERENCES`), scoped
 *    to ALL of `src/`. This is the load-bearing fact behind the acceptance: the
 *    server's accepted-token source is written independently of every config
 *    writer, which is what keeps a lost update from resurrecting a *live*
 *    credential rather than merely stranding a dead one. `token-store.ts` lives
 *    outside both directories in (1), so a directory-scoped check would be
 *    blind to the invariant it depends on **by construction**. Scanning all of
 *    `src/` is the whole point; do not narrow it to match (1).
 *
 * Derivation, not description: seeding either list from `docs/security.md`
 * would only confirm the docs against themselves. See the header of
 * `tests/docs/loopback-gate-claims.test.ts` for the same rule.
 */

const ROOT = resolve(__dirname, "../..");

/** Scan roots for the writer set. Pinned so a silent narrowing fails. */
const SCAN_ROOTS = ["src/server/integrations", "src/cli"] as const;

/**
 * Durable-write idioms. Both are needed and neither subsumes the other:
 * `apply.ts` commits through a module-private `atomicWrite` helper, while
 * `uninstall-scrub.ts` hand-rolls tmp-then-`rename` and would be invisible to a
 * helper-name-only scan.
 */
const DURABLE_WRITE = /\b(atomicWrite\w*|rename|renameSync)\s*\(/g;

/**
 * Every durable-write call site in the scan roots, keyed `file` -> total count,
 * with the disposition that classifies it. `covered` means the acceptance in
 * #1599 extends to this file's races; `out-of-scope` means the site writes
 * something the acceptance does not reach, and says what instead.
 *
 * Counts are the enforcement mechanism. When one legitimately changes, change
 * it here **and** say why in `docs/security.md`'s accepted entry — a count
 * bumped in isolation silently widens an accepted risk.
 */
const WRITER_SITES: Record<
  string,
  { sites: number; disposition: "covered" | "out-of-scope"; why: string }
> = {
  "src/server/integrations/apply.ts": {
    sites: 7,
    disposition: "covered",
    why:
      "Six `atomicWrite` calls plus the `rename` inside the helper itself. Four " +
      "write the Claude config (applyConfig, removeConfigEntries, " +
      "refreshMcpEntryBinary, refreshAllMcpEntryBinaries); two write " +
      "~/.claude/skills/tandem/SKILL.md (installSkill, refreshExistingSkillIfStale), " +
      "harmless today only because both write identical content.",
  },
  "src/server/integrations/storage.ts": {
    sites: 2,
    disposition: "out-of-scope",
    why:
      "atomicWriteConfigFile writes integrations.json, not the Claude config. Same " +
      "read-modify-write shape, different target, and the RMW lives in its callers " +
      "rather than here. Not covered by #1599; if it acquires a Claude-config " +
      "caller, that is a new finding.",
  },
  "src/cli/rotate-token.ts": {
    sites: 2,
    disposition: "out-of-scope",
    why:
      "Writes the auth token FILE (write plus restore-on-failure), never a config " +
      "file. This separation is the invariant the acceptance rests on — see " +
      "TOKEN_FILE_REFERENCES below.",
  },
  "src/cli/uninstall-scrub.ts": {
    sites: 1,
    disposition: "out-of-scope",
    why:
      "rewriteJson mutates the three Cowork workspace JSON files, which the Rust " +
      "side mutates under a real cross-process lockfile (with_locked_json). Tracked " +
      "separately as #1600 and deliberately NOT part of this acceptance: it is " +
      "strictly worse, being the one place a lock exists and a writer does not take it.",
  },
};

/**
 * Every file under `src/` whose EXECUTABLE code reaches the auth-token file
 * module. Not one of them may be a config writer.
 */
const TOKEN_FILE_REFERENCES = [
  "src/cli/rotate-token.ts",
  "src/server/auth/token-store.ts",
  "src/server/index.ts",
  "src/server/mcp/routes/info.ts",
  "src/server/mcp/routes/rotate-token.ts",
  "src/server/mcp/server.ts",
  "src/shared/auth/token-file.ts",
  "src/shared/constants.ts",
] as const;

const TOKEN_FILE_API = /\b(getTokenFilePath|writeTokenToFile|readTokenFromFile|TOKEN_FILE_NAME)\b/;

/** Shared with `tests/docs/loopback-gate-claims.test.ts`. */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

function sourceFiles(root: string, exts: string[]): string[] {
  return walk(join(ROOT, root))
    .filter((f) => exts.some((e) => f.endsWith(e)) && !f.includes(".test."))
    .map((f) => relative(ROOT, f).replace(/\\/g, "/"))
    .sort();
}

/**
 * Count durable-write CALLS, excluding declarations: `async function
 * atomicWrite(` is where the idiom is defined, not a site that races.
 */
function durableWriteSites(repoPath: string): number {
  const src = stripComments(readFileSync(join(ROOT, repoPath), "utf-8")).replace(
    /\bfunction\s+\w+\s*\(/g,
    "function __decl__(",
  );
  return [...src.matchAll(DURABLE_WRITE)].length;
}

describe("config-writer set (#1599 accepted risk)", () => {
  const derived = new Map<string, number>();
  for (const root of SCAN_ROOTS) {
    for (const file of sourceFiles(root, [".ts"])) {
      const n = durableWriteSites(file);
      if (n > 0) derived.set(file, n);
    }
  }

  it("derives a non-empty writer set — an empty scan would satisfy every check below", () => {
    // The zero-of-zero guard. Every assertion in this describe is a comparison
    // against `derived`; if the walk broke, or the scan roots were renamed, all
    // of them would pass against nothing.
    expect(derived.size).toBeGreaterThan(0);
    expect([...derived.values()].reduce((a, b) => a + b, 0)).toBeGreaterThan(0);
  });

  it("classifies every durable writer, with no stale entries", () => {
    const unclassified = [...derived.keys()].filter((f) => !(f in WRITER_SITES));
    const stale = Object.keys(WRITER_SITES).filter((f) => !derived.has(f));
    expect(
      unclassified,
      `durable writers with no disposition — a new one silently joins the accepted ` +
        `risk in docs/security.md unless classified here: ${unclassified}`,
    ).toEqual([]);
    expect(stale, `classified but no longer a durable writer (stale entry): ${stale}`).toEqual([]);
  });

  it("pins each writer's call-site count so a NEW writer in an existing file fails", () => {
    for (const [file, { sites }] of Object.entries(WRITER_SITES)) {
      expect(
        derived.get(file),
        `${file} changed its durable-write count. If that is a new writer, widen ` +
          `the accepted scope in docs/security.md deliberately; do not just bump ` +
          `this number.`,
      ).toBe(sites);
    }
  });

  it("keeps the scan roots pinned — narrowing them would hide writers", () => {
    expect([...SCAN_ROOTS]).toEqual(["src/server/integrations", "src/cli"]);
  });
});

describe("token-file separation (the invariant #1599's bound rests on)", () => {
  const all = sourceFiles("src", [".ts", ".svelte"]);
  const inCode = all.filter((f) =>
    TOKEN_FILE_API.test(stripComments(readFileSync(join(ROOT, f), "utf-8"))),
  );

  it("scans all of src/, not just the writer-set roots", () => {
    // `src/server/auth/token-store.ts` is the other half of the token-file
    // writer pair and lives outside both SCAN_ROOTS. A directory-scoped check
    // could not see this invariant break.
    expect(all.length).toBeGreaterThan(SCAN_ROOTS.length);
    expect(inCode).toContain("src/server/auth/token-store.ts");
  });

  it("pins exactly which modules reach the auth-token file", () => {
    expect(inCode.sort()).toEqual([...TOKEN_FILE_REFERENCES].sort());
  });

  it("no config writer touches the auth-token file", () => {
    const offenders = inCode.filter(
      (f) => WRITER_SITES[f]?.disposition === "covered" || f.startsWith("src/server/integrations/"),
    );
    expect(
      offenders,
      `a config writer now reaches the auth-token file: ${offenders}. This VOIDS the ` +
        `acceptance recorded in docs/security.md — a lost update could then resurrect ` +
        `a live credential, not merely strand a dead one. Reopen #1599.`,
    ).toEqual([]);
  });

  it("strips comments before deciding, because a mention is not a reference", () => {
    // Positive control: today `src/server/integrations/storage.ts` names
    // `writeTokenToFile` in a docblock. Without stripping, the check above
    // would report a config writer as an offender and this guard would be
    // read as broken rather than as biting.
    const mentionOnly = "/** Mirrors writeTokenToFile in token-store.ts. */\nexport const x = 1;\n";
    expect(TOKEN_FILE_API.test(mentionOnly)).toBe(true);
    expect(TOKEN_FILE_API.test(stripComments(mentionOnly))).toBe(false);
  });
});
