import { readdirSync, readFileSync, statSync } from "fs";
import { extname, join, relative, resolve } from "path";
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
 * **Four surfaces, because three of them exist to cover the first one's blind
 * spots.** Two review rounds defeated earlier drafts four times — a write idiom
 * the regex did not know, a file outside the scan roots, a `.mts` file inside
 * one, and a `.mjs` file anywhere at all, which was invisible to every surface
 * at once because this file's own extension list gated the repo-wide walk too.
 * Each is closed below. The pattern is worth naming: every defeat was a scope
 * that looked total and was not.
 *
 * 1. **The writer set** (`WRITER_SITES`), scoped to `src/server/integrations/`
 *    and `src/cli/`. Derivation is by CALL-SITE COUNT, not by function name: a
 *    seventh `atomicWrite` inside `apply.ts` is a new writer and must fail,
 *    while a name-keyed check would see the same key and pass. `DURABLE_WRITE`
 *    covers plain `writeFile` as well as the atomic idioms — a bare
 *    `writeFile(configPath, …)` is a perfectly good unsynchronized writer, and
 *    a scan that knows only `atomicWrite`/`rename` cannot see one.
 * 2. **The extension sweep.** `sourceFiles` filters by a pinned extension
 *    list, so a source file using an unlisted extension inside a scanned
 *    directory was invisible to (1) — see the sweep's own test below for the
 *    concrete failure mode. It asserts that every extension actually present
 *    in the scan roots is either scanned or explicitly ignored, so a new file
 *    type cannot appear unnoticed. Same failure this repo hit in `typecheck:tests`.
 * 3. **The resource surfaces**, scoped to ALL of `src/`:
 *    - `CONFIG_API_REFERENCES` — every module reaching the config-mutation API
 *      or the config-path producers (the two ways to get one — see `CONFIG_API`
 *      below). (1) is directory-scoped by design, so a writer placed anywhere
 *      else in `src/` was invisible to it. Rather than pin every durable write
 *      in the repo (a list that churns with unrelated work and would be
 *      rubber-stamped), this pins who can reach the *resource* instead.
 *    - `DURABLE_WRITER_FILES` — every file in `src/` that durably writes at
 *      all, **and how many times**. This said the opposite until 2026-08-28:
 *      only the file set was pinned, on the reasoning that counts outside the
 *      scan roots would churn on unrelated work and get rubber-stamped.
 *
 *      That reasoning is not wrong, and the cost is accepted rather than
 *      denied — an unrelated PR adding a durable write to one of these files
 *      now has to update a number. What changed is the discovery of what
 *      presence-only cannot see: review of ADR-034 Unit 7c pointed out that a
 *      write ADDED to a file already on the list is invisible, because the file
 *      was always there. A refactor that moves a module is precisely where such
 *      a write can ride along, and "this move is a rename, not a change of set"
 *      was a claim no test in this repo could check. The churn is the price of
 *      that check, and the failure message names the two distinct causes so the
 *      update is a decision rather than a rubber stamp.
 *    - `TOKEN_FILE_REFERENCES` — the load-bearing invariant behind the
 *      acceptance: the server's accepted-token source is written independently
 *      of every config writer, which is what keeps a lost update from
 *      resurrecting a *live* credential rather than merely stranding a dead
 *      one. `token-store.ts` lives outside both directories in (1), so a
 *      directory-scoped check would be blind to this **by construction**.
 *
 * Derivation, not description: seeding any of these from `docs/security.md`
 * would only confirm the docs against themselves. See the header of
 * `tests/docs/loopback-gate-claims.test.ts` for the same rule.
 *
 * **Known limit, stated rather than papered over.** `stripComments` truncates a
 * line containing a regex literal with an unescaped `//` not preceded by `:`
 * (e.g. `/a\/\/b/`). No such literal exists in the scanned files today. If one
 * appears, the effect is an under-count — a false negative, not a false alarm —
 * so it fails toward hiding a writer. Prefer a character class over `//` in a
 * regex literal in these files.
 *
 * **What still gets through, stated rather than implied.** A durable write that
 * names none of the `DURABLE_WRITE` idioms — a raw `fd` from a native module, a
 * child process invoked to write the file — is invisible here. The idiom list has
 * already had to be widened twice, so treat it as a floor, not a proof.
 */

const ROOT = resolve(__dirname, "../..");

/** Scan roots for the writer set. Pinned so a silent narrowing fails. */
const SCAN_ROOTS = ["src/server/integrations", "src/cli"] as const;

/**
 * Source extensions the scan reads. `.svelte.ts` is covered by `.ts`.
 *
 * The JS family is here because a `.mjs` writer placed anywhere under `src/`
 * was once invisible to ALL FOUR surfaces at once — wrong directory for the
 * writer set, and filtered out of the repo-wide walk by this very list. Nothing
 * about these checks needs a TypeScript parse; they read source as text.
 */
const SCANNED_EXTENSIONS = [
  ".ts",
  ".mts",
  ".cts",
  ".tsx",
  ".svelte",
  ".js",
  ".mjs",
  ".cjs",
  ".jsx",
] as const;

/** Extensions that may appear under `src/` without being source. */
const IGNORED_EXTENSIONS = [".md", ".css"] as const;

/**
 * Durable-write idioms. All are needed and none subsumes the others:
 * `apply.ts` commits through a module-private `atomicWrite` helper,
 * `uninstall-scrub.ts` hand-rolls tmp-then-`rename`, and a plain `writeFile`
 * straight onto the destination is the simplest writer of the three. The `open`
 * forms are here because a file-handle write (`(await fs.promises.open(p,
 * "w")).write(…)`) reaches disk without naming any of the others; matching the
 * open rather than the write avoids the 60-odd `process.stdout.write` calls that
 * a bare `.write(` would drag in.
 */
const DURABLE_WRITE =
  /\b(atomicWrite\w*|rename|renameSync|writeFile|writeFileSync|appendFile|appendFileSync|copyFile|copyFileSync|cp|cpSync|createWriteStream)\s*\(|\b(?:fs|promises)\.open\s*\(|\bopenSync\s*\(/g;

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
    sites: 10,
    disposition: "covered",
    why:
      "Six `atomicWrite` calls, plus the helper's own tmp `writeFile`, `rename` " +
      "and two-call EXDEV `copyFile` fallback. Four of the six write the Claude " +
      "config (applyConfig, removeConfigEntries, refreshMcpEntryBinary, " +
      "refreshAllMcpEntryBinaries); two write ~/.claude/skills/tandem/SKILL.md " +
      "(installSkill, refreshExistingSkillIfStale), harmless today only because " +
      "both write identical content.",
  },
  "src/server/integrations/install-claude-cli.ts": {
    sites: 2,
    disposition: "out-of-scope",
    why:
      "Writes a launcher script to a fresh path, never a shared config file. No " +
      "read-modify-write cycle, so no lost update is possible.",
  },
  "src/server/integrations/storage.ts": {
    sites: 8,
    disposition: "out-of-scope",
    why:
      "Five write/rename/copy sites plus three `fs.promises.open` file-handle opens. " +
      "atomicWriteConfigFile writes integrations.json, not the Claude config. Same " +
      "read-modify-write shape, different target, and the RMW lives in its callers " +
      "rather than here. Not covered by #1599; if it acquires a Claude-config " +
      "caller, that is a new finding.",
  },
  "src/cli/rotate-token.ts": {
    sites: 4,
    disposition: "out-of-scope",
    why:
      "Writes the auth token FILE (write plus restore-on-failure), never a config " +
      "file. This separation is the invariant the acceptance rests on — see " +
      "TOKEN_FILE_REFERENCES below.",
  },
  "src/cli/uninstall-scrub.ts": {
    sites: 2,
    disposition: "out-of-scope",
    why:
      "rewriteJson mutates the three Cowork workspace JSON files, which the Rust " +
      "side mutates under a real cross-process lockfile (with_locked_json). Tracked " +
      "separately as #1600 and deliberately NOT part of this acceptance: it is " +
      "strictly worse, being the one place a lock exists and a writer does not take it.",
  },
};

/**
 * A durable write to the Claude config needs a config path, and there are two
 * sources: `apply.ts`'s own mutation API, or the path producers in
 * `client-config-paths.ts`. Pinning who reaches either is what bounds the
 * writer set repo-wide without pinning every unrelated `writeFile` in `src/`.
 */
const CONFIG_API =
  /\b(applyConfig|applyConfigWithToken|removeConfigEntries|readConfigForMutation|refreshMcpEntryBinary|refreshAllMcpEntryBinaries|detectTargets|claudeCodeConfigPath|claudeDesktopConfigPath|claudeDesktopConfigTarget)\b/;

const CONFIG_API_REFERENCES = [
  "src/cli/doctor.ts",
  "src/cli/rotate-token.ts",
  "src/cli/setup.ts",
  "src/cli/uninstall-scrub.ts",
  "src/server/index.ts",
  "src/server/integrations/api-routes.ts",
  "src/server/integrations/apply.ts",
  "src/server/integrations/existing-config.ts",
  "src/shared/integrations/client-config-paths.ts",
] as const;

/**
 * Every file under `src/` that performs a durable write, by any idiom, keyed
 * `file` -> call count.
 *
 * **Pinned by COUNT, not merely as a set.** It was a bare array, and review of
 * ADR-034 Unit 7c found what that could not see: a durable write ADDED to a
 * file already on the list is invisible, because presence never changed. The
 * per-file counts in `WRITER_SITES` above are the enforcement mechanism inside
 * `SCAN_ROOTS`, and everything outside them had presence only — so "this move
 * is a rename, not a change of set" was a sentence no test could check. It can
 * now: move a file, keep its count, and this stays green; smuggle a write in
 * with the move and it does not.
 *
 * Most entries have nothing to do with the #1599 acceptance and never will.
 * The questions this asks are "is this writer new?" and "did an existing one
 * grow?" — a new FILE means a config writer could have arrived outside
 * `SCAN_ROOTS`; a bumped COUNT means an existing file gained a write. Either
 * one needs a deliberate answer, and if it writes a Claude config file, a
 * deliberate widening in `docs/security.md`'s accepted entry.
 */
const DURABLE_WRITER_FILES: Record<string, number> = {
  "src/cli/rotate-token.ts": 4,
  "src/cli/uninstall-scrub.ts": 2,
  "src/client/tabs/TabItem.svelte": 1,
  "src/server/annotations/store.ts": 5,
  "src/server/auth/token-store.ts": 3,
  "src/server/file-io/doc-backup.ts": 2,
  "src/server/file-io/index.ts": 3,
  "src/server/integrations/apply.ts": 10,
  "src/server/integrations/install-claude-cli.ts": 2,
  "src/server/integrations/storage.ts": 8,
  "src/server/launcher/supervisor.ts": 1,
  "src/server/license/license-state.ts": 2,
  "src/server/mcp/annotations.ts": 1,
  "src/server/mcp/convert.ts": 1,
  "src/server/mcp/document-service.ts": 4,
  "src/server/mcp/document.ts": 1,
  "src/server/mcp/docx-apply.ts": 4,
  "src/server/mcp/file-opener.ts": 2,
  "src/server/models/store.ts": 1,
  "src/server/session/manager.ts": 2,
  "src/server/version-check.ts": 1,
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
    // Skip dot-directories: `src/client/.claude/.workflow-state/` is gitignored
    // tooling state, and sweeping it would report its own scratch files.
    if (entry.startsWith(".")) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else out.push(relative(ROOT, full).replace(/\\/g, "/"));
  }
  return out;
}

function sourceFiles(root: string): string[] {
  return walk(join(ROOT, root))
    .filter((f) => SCANNED_EXTENSIONS.some((e) => f.endsWith(e)) && !f.includes(".test."))
    .sort();
}

function codeMatches(repoPath: string, pattern: RegExp): boolean {
  return pattern.test(stripComments(readFileSync(join(ROOT, repoPath), "utf-8")));
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
    for (const file of sourceFiles(root)) {
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

  it("scans every file type present anywhere under src/", () => {
    // `"x.mts".endsWith(".ts")` is false, so a file with an unlisted extension
    // is read by nothing. Sweeping the extensions actually on disk turns that
    // from a silent blind spot into a failure.
    //
    // The sweep covers ALL of `src/`, not just SCAN_ROOTS. Scoping it to the
    // scan roots left the rest of the tree open: a `.mjs` writer under, say,
    // `src/server/` was outside the writer set's directories AND filtered out
    // of the repo-wide walk, so no surface could see it.
    const present = new Set(walk(join(ROOT, "src")).map((f) => extname(f).toLowerCase()));
    const known: string[] = [...SCANNED_EXTENSIONS, ...IGNORED_EXTENSIONS];
    const unswept = [...present].filter((e) => e !== "" && !known.includes(e));
    expect(
      unswept,
      `file types under src/ that nothing reads: ${unswept}. Add them to ` +
        `SCANNED_EXTENSIONS, or to IGNORED_EXTENSIONS if they cannot hold code.`,
    ).toEqual([]);
    expect(present.has(".ts"), "src/ holds no .ts at all — the walk is broken").toBe(true);
  });

  it("keeps the scan roots pinned — narrowing them would hide writers", () => {
    expect([...SCAN_ROOTS]).toEqual(["src/server/integrations", "src/cli"]);
  });
});

describe("resource surfaces (repo-wide, because the writer scan is directory-scoped)", () => {
  const all = sourceFiles("src");

  it("scans all of src/, not just the writer-set roots", () => {
    // Both invariants below depend on seeing files the SCAN_ROOTS walk cannot:
    // `token-store.ts` for the token half, and anywhere at all for the config
    // half. A directory-scoped check could not see either break.
    expect(
      all.length,
      "the src/ walk is not wider than the scan roots — it has been narrowed",
    ).toBeGreaterThan(SCAN_ROOTS.flatMap((r) => sourceFiles(r)).length);
  });

  it("pins every module that can reach a Claude config path", () => {
    const derived = all.filter((f) => codeMatches(f, CONFIG_API)).sort();
    expect(
      derived,
      `a module gained (or lost) access to the config-mutation API or the config-path ` +
        `producers. A new one can write the config from OUTSIDE the scan roots, where ` +
        `the writer set above cannot see it — classify it here and, if it writes, in ` +
        `docs/security.md's accepted entry.`,
    ).toEqual([...CONFIG_API_REFERENCES].sort());
  });

  it("pins every file in src/ that durably writes, and how many times, so a writer cannot hide outside the scan roots", () => {
    const derived: Record<string, number> = {};
    for (const f of all.sort()) {
      const n = durableWriteSites(f);
      if (n > 0) derived[f] = n;
    }
    expect(
      derived,
      `the durable-writer census changed. A NEW FILE means a writer appeared outside ` +
        `SCAN_ROOTS, where the writer set above cannot see it. A CHANGED COUNT means an ` +
        `existing file gained or lost a durable write \u2014 which is what a move can ` +
        `smuggle, since the file's presence never changes. Either way: if it writes a ` +
        `Claude config file, widen the accepted scope in docs/security.md deliberately. ` +
        `If it writes something else, update the number here.`,
    ).toEqual(DURABLE_WRITER_FILES);
  });

  it("pins exactly which modules reach the auth-token file", () => {
    const derived = all.filter((f) => codeMatches(f, TOKEN_FILE_API)).sort();
    expect(derived).toEqual([...TOKEN_FILE_REFERENCES].sort());
    expect(derived).toContain("src/server/auth/token-store.ts");
  });

  it("no config writer touches the auth-token file", () => {
    const offenders = all
      .filter((f) => codeMatches(f, TOKEN_FILE_API))
      .filter(
        (f) =>
          WRITER_SITES[f]?.disposition === "covered" || f.startsWith("src/server/integrations/"),
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
