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

/** Build a Windows-shaped path without writing backslash escapes inline. */
const BACKSLASH = String.fromCharCode(92);
const WIN = (parts: string[]): string => parts.join(BACKSLASH);

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
    expect(distinguishingLabel("/home/u/alpha/src", "/home/u/beta/src", "linux")).toBe("alpha/src");
  });

  it("distinguishes two worktrees of one repository", () => {
    expect(
      distinguishingLabel("/home/u/wt/feature/tandem", "/home/u/wt/main/tandem", "linux"),
    ).toBe("feature/tandem");
  });

  it("elides the MIDDLE, keeping the segment that actually differs", () => {
    // Eliding the front would return the last three segments — which are
    // identical in both paths by definition, so both folders would come back
    // named the same thing. That is the exact failure this function exists to
    // prevent, reintroduced by its own fallback.
    const a = "/home/u/alpha/one/two/three/four";
    const b = "/home/u/beta/one/two/three/four";
    const la = distinguishingLabel(a, b, "linux");
    const lb = distinguishingLabel(b, a, "linux");
    expect(la).toBe("alpha/…/four");
    expect(lb).toBe("beta/…/four");
    expect(la).not.toBe(lb);
  });

  it("falls back to the last segment when one path is a suffix of the other", () => {
    expect(distinguishingLabel("/home/u/alpha", "/alpha", "linux")).toBe("alpha");
  });

  it("folds case on win32 and not elsewhere", () => {
    // Same directory, differently cased. On Windows these must be treated as
    // equal — so the divergence is found one level up, not at the leaf.
    expect(
      distinguishingLabel(
        WIN(["C:", "U", "Alpha", "Src"]),
        WIN(["C:", "U", "beta", "src"]),
        "win32",
      ),
    ).toBe(WIN(["Alpha", "Src"]));
    expect(distinguishingLabel("/u/alpha/Src", "/u/beta/src", "linux")).toBe("Src");
  });

  it("splits on both separators regardless of host platform", () => {
    // A Windows path reaching a Linux CI host: splitting on `path.sep` alone
    // would yield one enormous segment and a useless label.
    expect(distinguishingLabel(WIN(["C:", "u", "alpha"]), WIN(["C:", "u", "beta"]), "linux")).toBe(
      "alpha",
    );
  });

  it("joins with the SEAM's separator, not the host's", () => {
    // Every other expectation in this block is built with `path.join`, i.e. with
    // the same host primitive the implementation uses — so on a Linux CI host an
    // implementation that hardcoded "/" would satisfy all of them. These two pin
    // the separator against the platform argument instead.
    expect(
      distinguishingLabel(
        WIN(["C:", "u", "alpha", "src"]),
        WIN(["C:", "u", "beta", "src"]),
        "win32",
      ),
    ).toBe(WIN(["alpha", "src"]));
    expect(distinguishingLabel("/u/alpha/src", "/u/beta/src", "linux")).toBe("alpha/src");
  });
});

describe("tildeAbbreviate", () => {
  it("replaces the home prefix", () => {
    expect(tildeAbbreviate("/home/u/projects/alpha", "/home/u", "linux")).toBe("~/projects/alpha");
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

  it("works on Windows-shaped paths, on any host", () => {
    // This is the function whose stated job is keeping a real full name out of
    // screenshots on the one platform where the account name usually IS the
    // person's full name — so it has to be exercised with a Windows path, and a
    // platform enum alone could not do that while `path.relative` came from the
    // host.
    const winHome = WIN(["C:", "Users", "Ada Lovelace"]);
    expect(tildeAbbreviate(WIN([winHome, "projects"]), winHome, "win32")).toBe(
      WIN(["~", "projects"]),
    );
    expect(tildeAbbreviate(winHome, winHome, "win32")).toBe("~");
    // Case-insensitively the same directory on Windows.
    expect(tildeAbbreviate(winHome.toUpperCase(), winHome, "win32")).toBe("~");
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

  it("never leaks the account name when Claude is in home — the DEFAULT case", async () => {
    // The launcher's fallback cwd IS home (`resolveCwd` → `homeCwd()`, taken
    // whenever no `workingDirectory` is configured), so this is what a fresh
    // install with any document open produces. Labels used to be computed from
    // the RAW paths, and `distinguishingLabel` of a home path against a subfolder
    // returns home's basename — which on every platform is the account name. The
    // pill read "Claude in bryan.kolbeck". The full-path assertion above did not
    // catch it, because only the basename escaped.
    //
    // The fixture's home basename is literally "home", so assert on a directory
    // named like a real account instead.
    const account = path.join(path.dirname(home), "ada.lovelace");
    const project = path.join(account, "projects", "api");
    fs.mkdirSync(project, { recursive: true });
    const out = await previewCwdDrift({
      candidate: project,
      claudeCwd: account,
      bundledDocDirs: [],
      homeOverride: account,
    });
    expect(out.drifted).toBe(true);
    if (!out.drifted) return;
    expect(out.claudeLabel).toBe("~");
    for (const field of [out.suggestedCwd, out.claudeCwd, out.label, out.claudeLabel]) {
      expect(field, field).not.toContain("ada.lovelace");
    }
  });

  it("keeps sibling folders distinguishable after abbreviation", async () => {
    // The fix for the leak above rewrites the label inputs, so pin that it did
    // not flatten the case the labels exist for.
    const out = await previewCwdDrift(base({ candidate: sharedSrcA, claudeCwd: sharedSrcB }));
    expect(out.drifted).toBe(true);
    if (!out.drifted) return;
    expect(out.label).not.toBe(out.claudeLabel);
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
