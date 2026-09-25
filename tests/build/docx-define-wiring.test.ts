import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { DOCX_ENABLED } from "../../src/shared/constants.js";

/**
 * `.docx` ships dark (ADR-053) only because the server and cli bundles carry the
 * `__DOCX_ENABLED__` define. Without it, `docxEnabled()` falls back to the
 * `TANDEM_DOCX` env var — still off by default, but a user with `TANDEM_DOCX=1` in
 * their environment would get `.docx` back, and only the Tauri sidecar logs a
 * warning. Every release-path unit test models the release by stubbing the env,
 * which exercises the missing-define branch, so none of them would notice the
 * define being dropped. This reads the real config object instead.
 */

type Entry = { outDir?: string; define?: Record<string, string> };
// Imported by URL rather than statically: a static import pulls tsup.config.ts into
// the tests' typecheck program, whose settings it was never written against.
const TSUP_CONFIG_URL = pathToFileURL(join(import.meta.dirname, "..", "..", "tsup.config.ts")).href;
const tsupConfig: unknown = (await import(TSUP_CONFIG_URL)).default;
const entries = (Array.isArray(tsupConfig) ? tsupConfig : [tsupConfig]) as Entry[];
const byOutDir = (outDir: string) => entries.find((e) => e.outDir === outDir);

describe("the .docx define reaches every bundle that reads it (ADR-053)", () => {
  it.each(["dist/server", "dist/cli"])(
    "%s defines __DOCX_ENABLED__ from DOCX_ENABLED",
    (outDir) => {
      const entry = byOutDir(outDir);
      expect(entry, `no tsup entry writes ${outDir}`).toBeDefined();
      // Positive anchor: the entry is the one that carries the license define too,
      // so a lookup that found the wrong object can't pass by accident.
      expect(entry?.define).toHaveProperty("__LICENSE_GATE_ENABLED__");
      expect(entry?.define?.__DOCX_ENABLED__).toBe(JSON.stringify(DOCX_ENABLED));
    },
  );
});
