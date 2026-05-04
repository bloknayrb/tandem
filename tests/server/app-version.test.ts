/**
 * Tests that APP_VERSION resolves to the real package version at runtime.
 *
 * Vitest runs .ts files directly via tsx (no tsup), so __APP_VERSION__ is
 * not defined — this exercises the createRequire fallback path in server.ts.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { APP_VERSION } from "../../src/server/mcp/server.js";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const pkg = JSON.parse(readFileSync(join(__dirname, "../../package.json"), "utf8")) as {
  version: string;
};

describe("APP_VERSION", () => {
  it("matches the version in package.json", () => {
    expect(APP_VERSION).toBe(pkg.version);
  });

  it("is not the unknown fallback", () => {
    expect(APP_VERSION).not.toBe("0.0.0-unknown");
  });
});
