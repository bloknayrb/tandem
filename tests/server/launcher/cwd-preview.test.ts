/**
 * Coverage for the working-directory drift preview (#1282).
 *
 * Two halves, tested against a real filesystem rather than mocks:
 *
 *   - the pure label helpers, which the CLIENT cannot compute and therefore
 *     cannot cross-check;
 *   - the verdict itself, whose entire job is to answer "no" in every case where
 *     nudging would be wrong. The interesting assertions here are all negatives,
 *     and each one corresponds to a way this feature could become a permanent
 *     amber pill nobody can turn off.
 *
 * `homeOverride` + `platform` are the two seams that let this run identically on
 * a Linux CI host and a Windows laptop. Without the platform seam the win32
 * case-fold — the branch that matters on Tandem's primary desktop platform —
 * would be exercised nowhere but a maintainer's machine.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  distinguishingLabel,
  previewCwdDrift,
  tildeAbbreviate,
} from "../../../src/server/launcher/cwd-preview.js";
import {
  resolveRouteCwd,
  resolveRouteCwdAsync,
  resolveSafeCwd,
  resolveSafeCwdAsync,
  samePath,
} from "../../../src/server/launcher/supervisor.js";

let home: string;
let projA: string;
let projB: string;
let sharedSrcA: string;
let sharedSrcB: string;
let bundled: string;
let outside: string;

beforeAll(() => {
  // `realpath` the root: on macOS `os.tmpdir()` is a symlink to /private/var,
  // and every path this module returns is realpath'd, so an un-resolved home
  // would make `tildeAbbreviate` silently stop matching.
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "cwd-preview-")));
  home = path.join(root, "home");
  projA = path.join(home, "projects", "alpha");
  projB = path.join(home, "projects", "beta");
  sharedSrcA = path.join(projA, "src");
  sharedSrcB = path.join(projB, "src");
  bundled = path.join(home, "AppData", "Local", "Tandem", "sample");
  outside = path.join(root, "elsewhere");
  for (const d of [sharedSrcA, sharedSrcB, bundled, outside]) {
    fs.mkdirSync(d, { recursive: true });
  }
});

afterAll(() => {
  fs.rmSync(path.dirname(home), { recursive: true, force: true });
});

describe("distinguishingLabel", () => {
  it("stops at the first segment that differs", () => {
    expect(distinguishingLabel("/home/u/notes", "/home/u/alpha", "linux")).toBe("notes");
  });

  it("walks up until the paths actually diverge", () => {
    // The case `basename` gets wrong: two `src` directories in two projects.
    // A basename label would name both folders "src", which is not a shorter
    // answer — it is the wrong one.
    expect(distinguishingLabel("/home/u/alpha/src", "/home/u/beta/src", "linux")).toBe(
      path.join("alpha", "src"),
    );
  });

  it("distinguishes two worktrees of one repository", () => {
    expect(
      distinguishingLabel("/home/u/wt/feature/tandem", "/home/u/wt/main/tandem", "linux"),
    ).toBe(path.join("feature", "tandem"));
  });

  it("elides once the divergence is deeper than the cap", () => {
    const a = "/home/u/a/one/two/three/four";
    const b = "/home/u/b/one/two/three/four";
    const label = distinguishingLabel(a, b, "linux");
    expect(label.startsWith("…")).toBe(true);
    expect(label.endsWith(path.join("two", "three", "four"))).toBe(true);
  });

  it("falls back to the last segment when one path is a suffix of the other", () => {
    expect(distinguishingLabel("/home/u/alpha", "/alpha", "linux")).toBe("alpha");
  });

  it("folds case on win32 and not elsewhere", () => {
    // Same directory, differently cased. On Windows these must be treated as
    // equal — so the divergence is found one level up, not at the leaf.
    expect(distinguishingLabel("C:\\U\\Alpha\\Src", "C:\\U\\beta\\src", "win32")).toBe(
      path.join("Alpha", "Src"),
    );
    expect(distinguishingLabel("/u/alpha/Src", "/u/beta/src", "linux")).toBe("Src");
  });

  it("splits on both separators regardless of host platform", () => {
    // A Windows path reaching a Linux CI host: splitting on `path.sep` alone
    // would yield one enormous segment and a useless label.
    expect(distinguishingLabel("C:\\u\\alpha", "C:\\u\\beta", "linux")).toBe("alpha");
  });
});

describe("tildeAbbreviate", () => {
  it("replaces the home prefix", () => {
    expect(tildeAbbreviate("/home/u/projects/alpha", "/home/u", "linux")).toBe(
      `~${path.sep}${path.join("projects", "alpha")}`,
    );
  });

  it("renders home itself as ~ rather than exposing the account name", () => {
    expect(tildeAbbreviate("/home/rebecca", "/home/rebecca", "linux")).toBe("~");
  });

  it("leaves a path outside home alone", () => {
    expect(tildeAbbreviate("/opt/thing", "/home/u", "linux")).toBe("/opt/thing");
  });

  it("does not treat a sibling with a shared prefix as inside home", () => {
    // `/home/user2` starts with the string `/home/user` but is not under it.
    expect(tildeAbbreviate("/home/user2/x", "/home/user", "linux")).toBe("/home/user2/x");
  });
});

describe("previewCwdDrift", () => {
  const base = (over: Partial<Parameters<typeof previewCwdDrift>[0]> = {}) => ({
    candidate: projA,
    claudeCwd: projB,
    bundledDocDirs: [] as readonly string[],
    homeOverride: home,
    ...over,
  });

  it("reports drift between two real, home-confined folders", async () => {
    const out = await previewCwdDrift(base());
    expect(out.drifted).toBe(true);
    if (!out.drifted) return;
    expect(out.suggestedCwd).toBe(`~${path.sep}${path.join("projects", "alpha")}`);
    expect(out.claudeCwd).toBe(`~${path.sep}${path.join("projects", "beta")}`);
    expect(out.label).toBe("alpha");
    expect(out.claudeLabel).toBe("beta");
  });

  it("says nothing when the launcher is not running", async () => {
    // The manually-launched-Claude case (#1054). Silence is correct here: the
    // only action the nudge offers would spawn a SECOND agent.
    expect(await previewCwdDrift(base({ claudeCwd: null }))).toEqual({ drifted: false });
  });

  it("says nothing when Claude is already in the target folder", async () => {
    expect(await previewCwdDrift(base({ claudeCwd: projA }))).toEqual({ drifted: false });
  });

  it("says nothing for a folder outside the user's home directory", async () => {
    expect(await previewCwdDrift(base({ candidate: outside }))).toEqual({ drifted: false });
  });

  it("says nothing for a relative path", async () => {
    expect(await previewCwdDrift(base({ candidate: "projects/alpha" }))).toEqual({
      drifted: false,
    });
  });

  it("says nothing for a folder that does not exist", async () => {
    expect(await previewCwdDrift(base({ candidate: path.join(home, "gone") }))).toEqual({
      drifted: false,
    });
  });

  it("says nothing when the candidate is a file rather than a directory", async () => {
    const file = path.join(projA, "README.md");
    fs.writeFileSync(file, "# hi\n");
    expect(await previewCwdDrift(base({ candidate: file }))).toEqual({ drifted: false });
  });

  it("says nothing for Tandem's own bundled document folders", async () => {
    // Without this the two states EVERY desktop user passes through — first run
    // (welcome.md) and every upgrade (CHANGELOG.md) — would each open with a
    // suggestion to move Claude inside Tandem's install directory. On Windows
    // those live under %LOCALAPPDATA%, i.e. inside home, so they pass every
    // other check here.
    expect(await previewCwdDrift(base({ candidate: bundled, bundledDocDirs: [bundled] }))).toEqual({
      drifted: false,
    });
    // ...but a DIFFERENT folder is still reported, i.e. the exclusion is exact.
    // In a development checkout the bundled dir resolves to the repository root;
    // suppressing that whole tree would silence the nudge for anyone using
    // Tandem to work on Tandem.
    const out = await previewCwdDrift(base({ candidate: projA, bundledDocDirs: [bundled] }));
    expect(out.drifted).toBe(true);
  });

  it("normalizes Claude's side too, so a symlinked home is not a permanent nudge", async () => {
    // `resolveCwd`'s default branch can return an un-realpath'd `os.homedir()`
    // while the candidate is always realpath'd. Where home contains a symlink
    // the two differ as strings for ONE directory — which would render a
    // permanent pill pointing at the folder Claude is already sitting in.
    const link = path.join(home, "alpha-link");
    try {
      fs.symlinkSync(projA, link, "junction");
    } catch {
      return; // unprivileged Windows without Developer Mode — skip
    }
    expect(await previewCwdDrift(base({ candidate: projA, claudeCwd: link }))).toEqual({
      drifted: false,
    });
  });

  it("still compares when Claude's folder has been deleted underneath it", async () => {
    // A cwd that no longer resolves is a real problem, not a reason to go quiet.
    const gone = path.join(home, "deleted-under-claude");
    expect((await previewCwdDrift(base({ claudeCwd: gone }))).drifted).toBe(true);
  });

  it("folds case only on win32 when comparing an unresolvable folder", async () => {
    // Case folding only has anything to bite on when a side does NOT resolve:
    // when it does, `realpath` returns the on-disk casing and both sides already
    // agree. So this exercises the raw-string fallback. `alpha` differs from
    // `ALPHA` by case alone; on Windows they name one folder, on POSIX two.
    const unresolvable = path.join(home, "ghost", "ALPHA");
    const candidateSibling = path.join(home, "ghost", "alpha");
    fs.mkdirSync(candidateSibling, { recursive: true });
    const resolved = fs.realpathSync(candidateSibling);
    expect(
      await previewCwdDrift(
        base({ candidate: resolved, claudeCwd: unresolvable, platform: "win32" }),
      ),
    ).toEqual(
      // On a Windows host `realpath` normalizes `ALPHA` to the real casing and
      // the fallback never runs, so both platforms agree it is the same folder.
      { drifted: false },
    );
    const posix = await previewCwdDrift(
      base({ candidate: resolved, claudeCwd: unresolvable, platform: "linux" }),
    );
    // On a POSIX host the ghost path really is a different directory.
    expect(posix.drifted).toBe(process.platform !== "win32");
  });

  it("labels sibling `src` folders distinguishably", async () => {
    const out = await previewCwdDrift(base({ candidate: sharedSrcA, claudeCwd: sharedSrcB }));
    expect(out.drifted).toBe(true);
    if (!out.drifted) return;
    expect(out.label).toBe(path.join("alpha", "src"));
    expect(out.claudeLabel).toBe(path.join("beta", "src"));
  });

  it("never leaks the raw home path into the response", async () => {
    const out = await previewCwdDrift(base());
    expect(out.drifted).toBe(true);
    if (!out.drifted) return;
    for (const field of [out.suggestedCwd, out.claudeCwd, out.label, out.claudeLabel]) {
      expect(field).not.toContain(home);
    }
  });
});

describe("sync/async resolver equivalence", () => {
  /**
   * The async resolvers exist because the preview runs at tab-switch frequency
   * and `statSync` on a disconnected mapped drive blocks the whole event loop.
   * Two resolvers that could disagree about which paths are acceptable is the
   * split-predicate defect this feature was filed for, so the pair is pinned
   * here rather than trusted to stay in step.
   */
  it("agrees on every case, safe variant", async () => {
    const cases = [
      () => projA,
      () => path.join(home, "nope"),
      () => "relative/path",
      () => "",
      () => path.join(projA, "README.md"),
      () => outside,
      () => "\\\\server\\share",
      () => "\\\\?\\C:\\Windows",
    ];
    for (const mk of cases) {
      const c = mk();
      expect(await resolveSafeCwdAsync(c)).toBe(resolveSafeCwd(c));
    }
  });

  it("agrees on every case, home-confined variant", async () => {
    for (const c of [projA, outside, path.join(home, "nope"), home]) {
      expect(await resolveRouteCwdAsync(c, { homeOverride: home })).toBe(
        resolveRouteCwd(c, { homeOverride: home }),
      );
    }
  });
});

describe("samePath", () => {
  it("folds case on win32 only", () => {
    expect(samePath("C:\\A", "c:\\a", "win32")).toBe(true);
    expect(samePath("/A", "/a", "linux")).toBe(false);
    expect(samePath("/a", "/a", "linux")).toBe(true);
  });

  it("does not treat a parent as equal to its child", () => {
    expect(samePath("/home/u", "/home/u/x", "linux")).toBe(false);
  });
});
