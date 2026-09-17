/**
 * Tests for findChangelogPath().
 *
 * Packaged Tauri verification is manual — integration test requires an actual build.
 */

import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
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
    // A fresh empty tree, not a hard-coded /tmp path whose ancestors are
    // whatever happens to be on the machine. Every directory `findRepoFile` can
    // reach from here is inside it: the two fast probes are `../..` and `..`,
    // and the fallback walk is capped at 5 ancestors — from `a/b/c/d/e/f` that
    // is `b` at the furthest, still below the root. Keep the leaf >= 3 levels
    // down or the walk escapes into the real filesystem.
    //
    // Asserted unconditionally. An "undefined OR outside the tree" hedge has no
    // failing branch — a constant returned by an implementation that ignores
    // `startDir` satisfies it, and that is the one regression this title names.
    const root = mkdtempSync(join(tmpdir(), "tandem-changelog-"));
    const leaf = join(root, "a/b/c/d/e/f");
    mkdirSync(leaf, { recursive: true });
    try {
      expect(findChangelogPath(leaf)).toBeUndefined();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
