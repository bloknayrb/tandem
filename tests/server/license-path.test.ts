/**
 * findLicensePath(): the desktop bundle ships the licence as LICENSE.txt
 * (tauri.conf.json `bundle.resources`, because /api/open refuses an
 * extensionless file), while a dev checkout and the npm package carry the bare
 * LICENSE. The `.txt` copy must win where both could be found, or the bundle
 * would report the one name Settings cannot open.
 *
 * The temp trees mirror the real layouts: the server runs from
 * `<root>/dist/server/` (npm and bundle) and the file sits at `<root>`, which
 * findRepoFile's `../..` probe reaches.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { findLicensePath } from "../../src/server/mcp/server.js";

let root: string | undefined;

function makeTree(files: string[]): string {
  root = mkdtempSync(join(tmpdir(), "tandem-license-path-"));
  const serverDir = join(root, "dist", "server");
  mkdirSync(serverDir, { recursive: true });
  for (const f of files) writeFileSync(join(root, f), "Business Source License 1.1\n");
  return serverDir;
}

afterEach(() => {
  if (root) rmSync(root, { recursive: true, force: true });
  root = undefined;
});

describe("findLicensePath", () => {
  it("finds the bundle's LICENSE.txt", () => {
    const serverDir = makeTree(["LICENSE.txt"]);
    expect(findLicensePath(serverDir)).toBe(join(root as string, "LICENSE.txt"));
  });

  it("finds the bare LICENSE of a dev or npm tree", () => {
    const serverDir = makeTree(["LICENSE"]);
    expect(findLicensePath(serverDir)).toBe(join(root as string, "LICENSE"));
  });

  it("prefers LICENSE.txt when both exist", () => {
    const serverDir = makeTree(["LICENSE", "LICENSE.txt"]);
    expect(findLicensePath(serverDir)).toBe(join(root as string, "LICENSE.txt"));
  });

  it("ignores an ancestor project's LICENSE.txt in favour of the package's own LICENSE", () => {
    // An npm install as a project dependency:
    // <project>/node_modules/tandem-editor/dist/server. The project root has
    // package.json + LICENSE.txt, which findRepoFile's ancestor walk accepts.
    // The package's own LICENSE must win.
    root = mkdtempSync(join(tmpdir(), "tandem-license-path-"));
    const pkgRoot = join(root, "node_modules", "tandem-editor");
    const serverDir = join(pkgRoot, "dist", "server");
    mkdirSync(serverDir, { recursive: true });
    writeFileSync(join(root, "package.json"), "{}\n");
    writeFileSync(join(root, "LICENSE.txt"), "the user's own project licence\n");
    writeFileSync(join(pkgRoot, "package.json"), "{}\n");
    writeFileSync(join(pkgRoot, "LICENSE"), "Business Source License 1.1\n");
    expect(findLicensePath(serverDir)).toBe(join(pkgRoot, "LICENSE"));
  });

  it("returns undefined when neither exists", () => {
    // Leaf kept >= 3 levels below the temp root so findRepoFile's capped walk
    // cannot escape into the real filesystem (see changelog-path.test.ts).
    const serverDir = makeTree([]);
    const leaf = join(serverDir, "a", "b", "c", "d");
    mkdirSync(leaf, { recursive: true });
    expect(findLicensePath(leaf)).toBeUndefined();
  });
});
