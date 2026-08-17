import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

/** Every file under `dir`, repo-relative, POSIX separators. */
function walk(dir: string): string[] {
  return readdirSync(path.join(ROOT, dir), { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) =>
      path.relative(ROOT, path.join(entry.parentPath, entry.name)).replace(/\\/g, "/"),
    );
}

/**
 * `.claude/hooks/related-test.sh` maps an edited source file to one suite. For
 * Svelte-5 rune modules (`X.svelte.ts`) `basename … .ts` leaves `X.svelte`, so
 * the first lookup finds `X.svelte.test.ts` and a fallback strips `.svelte` to
 * find `X.test.ts` (#1408).
 *
 * The fallback fires ONLY on an empty first result. The hook documents the
 * consequence: if a module ever grows BOTH suites, the first lookup is
 * non-empty, the fallback never fires, and the plain suite silently never runs
 * — the same silent-zero class #1408 was filed for, one level down. The hook
 * calls that "unreachable today". That is a claim about the state of the tree,
 * and it becomes false the moment someone adds the second file, with nothing
 * else in the repo to notice. This test is the notice.
 *
 * The 5 / 19 / 32 arming counts in the hook and in `.claude/hooks/README.md`
 * are deliberately NOT pinned — they drift with every new module and would
 * generate churn without protecting anything. The collision claim is the
 * durable, load-bearing one.
 */
describe("related-test.sh naming conventions", () => {
  // Scoped per area, exactly as the hook is: it searches `tests/$AREA` derived
  // from `src/$AREA`. A repo-wide basename comparison would be stricter than
  // the code and could fail on an unrelated `tests/server/X.test.ts` sitting
  // beside `tests/client/X.svelte.test.ts`, which the hook never confuses.
  const suitesByArea = new Map<string, Set<string>>();
  for (const file of walk("tests")) {
    const area = file.split("/")[1];
    if (!suitesByArea.has(area)) suitesByArea.set(area, new Set());
    suitesByArea.get(area)?.add(path.basename(file));
  }

  it("no .svelte.ts module has BOTH suite names", () => {
    const collisions = walk("src")
      .filter((f) => f.endsWith(".svelte.ts"))
      .filter((f) => {
        const suites = suitesByArea.get(f.split("/")[1]);
        if (!suites) return false;
        const base = path.basename(f, ".ts"); // "X.svelte"
        return (
          suites.has(`${base}.test.ts`) && suites.has(`${base.slice(0, -".svelte".length)}.test.ts`)
        );
      });

    expect(collisions).toEqual([]);
  });

  it("the hook keeps the fallback that arms plain-named suites", () => {
    // Reverting this line silently un-arms 19 modules — the #1408 regression.
    const hook = readFileSync(path.join(ROOT, ".claude/hooks/related-test.sh"), "utf8");
    expect(hook).toContain('"${BASENAME%.svelte}.test.ts"');
  });
});
