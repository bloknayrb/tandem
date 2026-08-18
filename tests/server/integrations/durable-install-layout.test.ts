import { describe, expect, it } from "vitest";
import { isDurableInstallLayout } from "../../../src/server/integrations/apply.js";

/**
 * The gate that makes reversing `41a893a4` defensible, tested directly.
 *
 * Every case in `npx-convergence.test.ts` goes through the `durable` seam, which
 * is what makes those tests writable at all — but it also means none of them
 * exercises this predicate. An earlier draft shipped with exactly that blind
 * spot, and it was wrong in both directions at once: its `/node_modules/`
 * allowlist ADMITTED the npx cache (which lives under one), and its
 * `.app/Contents/` clause left the Windows and Linux desktop installs with no
 * matching pattern at all, so the whole feature was silently macOS-only.
 *
 * `sep`-agnostic fixtures throughout: a Windows-shaped path is read on Linux in
 * CI and vice versa.
 */
describe("isDurableInstallLayout", () => {
  const noGit = () => false;
  const sidecar = { TANDEM_TAURI_SIDECAR: "1" } as NodeJS.ProcessEnv;
  const notSidecar = {} as NodeJS.ProcessEnv;

  describe("durable", () => {
    it("accepts an npm-global install", () => {
      expect(
        isDurableInstallLayout(
          "/usr/local/lib/node_modules/tandem-editor/dist/stdio-bridge/index.js",
          notSidecar,
          noGit,
        ),
      ).toBe(true);
    });

    it.each([
      [
        "macOS app bundle",
        "/Applications/Tandem.app/Contents/Resources/dist/stdio-bridge/index.js",
      ],
      [
        "Windows install dir",
        "C:\\Users\\me\\AppData\\Local\\tandem\\dist\\stdio-bridge\\index.js",
      ],
      ["Linux install dir", "/usr/lib/tandem/dist/stdio-bridge/index.js"],
    ])("accepts a desktop sidecar on %s", (_label, path) => {
      // Recognised by PROVENANCE, not by naming an install directory — which is
      // the only way one rule covers three platforms whose resource dirs have
      // nothing in common.
      expect(isDurableInstallLayout(path, sidecar, noGit)).toBe(true);
    });
  });

  describe("refuses", () => {
    it.each([
      ["the npm npx cache", "/home/me/.npm/_npx/a1b2/node_modules/tandem-editor/dist/x/index.js"],
      ["a pnpm dlx cache", "/home/me/.local/share/pnpm/dlx/9f/node_modules/tandem-editor/d/i.js"],
      ["a bun cache", "/home/me/.bun/install/cache/tandem-editor/dist/stdio-bridge/index.js"],
    ])("%s, even though it sits under node_modules", (_label, path) => {
      // The failure the previous draft had. These are pruned on a schedule, so a
      // path recorded here has a death date — and every one of them contains
      // `/node_modules/`, so the allowlist alone would wave them through.
      expect(isDurableInstallLayout(path, notSidecar, noGit)).toBe(false);
    });

    it("a macOS App Translocation mount", () => {
      expect(
        isDurableInstallLayout(
          "/private/var/folders/x/AppTranslocation/UUID/d/Tandem.app/Contents/Resources/i.js",
          sidecar,
          noGit,
        ),
      ).toBe(false);
    });

    it("a sidecar running out of a dev checkout", () => {
      // `cargo tauri dev` sets TANDEM_TAURI_SIDECAR too and resolves the bridge
      // inside the checkout, so the env var alone cannot separate an installed
      // bundle from a developer run.
      const inCheckout = () => true;
      expect(
        isDurableInstallLayout(
          "/home/me/src/tandem/dist/stdio-bridge/index.js",
          sidecar,
          inCheckout,
        ),
      ).toBe(false);
    });

    it("a git WORKTREE, where .git is a file rather than a directory", () => {
      // This repo uses worktrees. An `isDirectory` test would call one durable.
      const gitFile = (p: string) => p.endsWith(".git");
      expect(
        isDurableInstallLayout("/home/me/wt/feature/dist/stdio-bridge/index.js", sidecar, gitFile),
      ).toBe(false);
    });

    it("an unrecognised layout, because the gate fails CLOSED", () => {
      // Declining costs the user nothing they do not already have; converging
      // onto an ephemeral path writes the unrecoverable failure mode. So every
      // layout nobody has thought about lands here.
      expect(
        isDurableInstallLayout("/tmp/unpacked/dist/stdio-bridge/index.js", notSidecar, noGit),
      ).toBe(false);
    });
  });

  it("finds .git at any ancestor, not just the immediate parent", () => {
    // Separator-normalized: `join` is win32-flavoured when the suite runs on
    // Windows, so a POSIX-literal comparison would never match and the test
    // would pass for the wrong reason.
    const onlyRepoRoot = (p: string) => p.replace(/\\/g, "/") === "/home/me/src/tandem/.git";
    expect(
      isDurableInstallLayout(
        "/home/me/src/tandem/dist/stdio-bridge/index.js",
        sidecar,
        onlyRepoRoot,
      ),
    ).toBe(false);
  });

  it("terminates at the filesystem root when nothing matches", () => {
    // The ancestor walk must stop; a `dirname` fixpoint is the only terminator.
    expect(isDurableInstallLayout("/index.js", sidecar, noGit)).toBe(true);
  });
});
