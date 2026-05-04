/**
 * Verifies that the real package version is baked into the server bundle by tsup.
 *
 * Requires `npm run build` (or `npm run build:server`) to have been run first.
 * If dist/server/index.js does not exist the test suite is skipped — this is
 * expected in CI runs that only run unit tests without a prior build step.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const repoRoot = join(__dirname, "../..");

const pkg = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8")) as { version: string };

const bundlePath = join(repoRoot, "dist/server/index.js");

describe.skipIf(!existsSync(bundlePath))("version baked into server bundle", () => {
  it("dist/server/index.js contains the literal version string", () => {
    const bundle = readFileSync(bundlePath, "utf8");
    // tsup inlines __APP_VERSION__ as a JSON-stringified string literal,
    // e.g. "0.10.0" — verify the exact version appears in the bundle.
    expect(bundle).toContain(JSON.stringify(pkg.version));
  });

  it("dist/server/index.js does not contain the unknown fallback as APP_VERSION", () => {
    const bundle = readFileSync(bundlePath, "utf8");
    // The fallback string should not appear as the assigned value — it may
    // appear as a string literal in source comments but not as the live value.
    // We look for the assignment pattern that would indicate the define failed.
    expect(bundle).not.toMatch(/APP_VERSION\s*=\s*["']0\.0\.0-unknown["']/);
  });
});
