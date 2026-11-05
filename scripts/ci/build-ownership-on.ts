/**
 * Build every tsup bundle with multi-session ownership forced ON (#2358, ADR-054).
 *
 * Ownership ships dark: `tsup.config.ts` injects `__OWNERSHIP_ENABLED__` from the
 * `OWNERSHIP_ENABLED` literal, which is `false`, and reads no environment
 * variable for it — so a shell export can never build a half-on bundle. The
 * `ownership-flag-on` CI job still needs a flag-on build to run the E2E suite
 * and the bundle probe against, and this is the only way to get one: load the
 * real config array and hand each block to tsup's `build()` with that one define
 * overridden.
 *
 * Run under tsx (`node node_modules/tsx/dist/cli.mjs scripts/ci/build-ownership-on.ts`),
 * because `tsup.config.ts` is TypeScript. `config: false` on every block is
 * load-bearing: without it tsup loads `tsup.config.ts` itself and merges the
 * options passed here over EVERY block, building the whole array once per call.
 *
 * Fails closed: `planOwnershipBuilds` throws unless the config is an array and
 * the server block (`dist/server`, the bundle `tandem start`, the desktop
 * sidecar and the E2E server all run) carries the define, so a renamed or
 * dropped define cannot build a flag-off bundle while this step reads green. The
 * `Built bundle is ownership-on` probe that runs after it checks the artifact
 * itself. tests/scripts/ownership-flag-on-wiring.test.ts drives the planner.
 */

import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/** The define this script forces on. */
export const OWNERSHIP_DEFINE_KEY = "__OWNERSHIP_ENABLED__";

/** The one bundle that must carry it: what `tandem start` and the sidecar run. */
export const SERVER_OUT_DIR = "dist/server";

type Block = { outDir?: unknown; define?: Record<string, string> } & Record<string, unknown>;

export interface PlannedBuild {
  /** What to pass to tsup's `build()`. */
  options: Block & { config: false };
  /** Whether this block's ownership define was forced to `"true"`. */
  flipped: boolean;
}

/**
 * One planned build per config block, in order. Pure: no tsup, no filesystem.
 *
 * Every block is built (a block without the define is built unchanged, so the
 * job's `dist/` is the whole tree), every block gets `config: false`, and every
 * block that carries the define gets it as `"true"`.
 */
export function planOwnershipBuilds(config: unknown): PlannedBuild[] {
  if (!Array.isArray(config)) {
    throw new Error(
      "tsup.config.ts no longer exports an array of blocks; this script cannot tell " +
        "which bundles carry the ownership define",
    );
  }
  const plan = config.map((raw: unknown, i: number): PlannedBuild => {
    if (raw === null || typeof raw !== "object") {
      throw new Error(`tsup.config.ts block ${i} is not an object`);
    }
    const block = raw as Block;
    const carries = block.define !== undefined && OWNERSHIP_DEFINE_KEY in block.define;
    return {
      options: {
        ...block,
        ...(carries ? { define: { ...block.define, [OWNERSHIP_DEFINE_KEY]: "true" } } : {}),
        config: false,
      },
      flipped: carries,
    };
  });
  const server = plan.find((p) => p.options.outDir === SERVER_OUT_DIR);
  if (!server) {
    throw new Error(`tsup.config.ts has no block writing ${SERVER_OUT_DIR}`);
  }
  if (!server.flipped) {
    throw new Error(
      `the ${SERVER_OUT_DIR} block carries no ${OWNERSHIP_DEFINE_KEY} define, so a ` +
        "flag-on build would silently be flag-off",
    );
  }
  return plan;
}

async function main(): Promise<void> {
  const repoRoot = resolve(fileURLToPath(new URL("../..", import.meta.url)));
  // Entries and outDirs in the config are cwd-relative.
  if (resolve(process.cwd()) !== repoRoot) {
    throw new Error(`run this from the repository root (${repoRoot}), not ${process.cwd()}`);
  }
  const configPath = join(repoRoot, "tsup.config.ts");
  if (!existsSync(configPath)) throw new Error(`no ${configPath}`);
  const config: unknown = (await import(pathToFileURL(configPath).href)).default;
  const plan = planOwnershipBuilds(config);
  const { build } = await import("tsup");
  for (const { options, flipped } of plan) {
    console.error(
      `[build-ownership-on] ${String(options.outDir)}${flipped ? ` (${OWNERSHIP_DEFINE_KEY}: true)` : ""}`,
    );
    // biome-ignore lint/suspicious/noExplicitAny: tsup's Options type is not worth importing here; the block came from its own config file.
    await build(options as any);
  }
  console.error(`[build-ownership-on] built ${plan.length} bundle(s)`);
  // A developer who ran this locally now has a flag-on dist/ — which
  // `npm run dev:tauri` and `tandem start` would then run against real app
  // data. Say so.
  console.error(
    "[build-ownership-on] dist/ is now OWNERSHIP-ON. Run `npm run build` before using it " +
      "for anything but the ownership-flag-on checks.",
  );
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (invokedDirectly) {
  main().catch((err: unknown) => {
    console.error("[build-ownership-on] FAILED:", err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
