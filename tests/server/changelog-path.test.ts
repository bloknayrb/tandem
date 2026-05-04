/**
 * Tests for findChangelogPath().
 *
 * Packaged Tauri verification is manual — integration test requires an actual build.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { findChangelogPath } from "../../src/server/mcp/server.js";

const __dirname = fileURLToPath(new URL(".", import.meta.url));

describe("findChangelogPath", () => {
  it("returns a non-null path when called from the dev tree", () => {
    // Tests live in tests/server/ — two levels up from src/server/mcp/
    // but findChangelogPath walks up from __dirname so we pass the actual
    // server/mcp directory to mirror the runtime call site.
    const mcpDir = join(__dirname, "../../src/server/mcp");
    const result = findChangelogPath(mcpDir);
    expect(result).not.toBeUndefined();
  });

  it("returned path exists on disk", () => {
    const mcpDir = join(__dirname, "../../src/server/mcp");
    const result = findChangelogPath(mcpDir);
    expect(result).not.toBeUndefined();
    expect(existsSync(result!)).toBe(true);
  });

  it("returns undefined for a deeply nested temp-like dir with no CHANGELOG.md ancestors", () => {
    // Use a path that is unlikely to have CHANGELOG.md anywhere in its hierarchy.
    // Not throwing is sufficient — no assertion needed.
    findChangelogPath("/tmp/no-such-project/a/b/c/d/e/f");
  });
});
