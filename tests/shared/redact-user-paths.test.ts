import { describe, expect, it } from "vitest";
import { diagnosticsRedactRoots, redactUserPaths } from "../../src/shared/redact-user-paths.js";

/**
 * This runs over text that is about to be pasted into a public GitHub issue, so
 * the interesting cases are the ones where a naive prefix swap either misses a
 * username or corrupts an unrelated path.
 */

const HOME = { path: "/home/bryan", as: "~" };

describe("redactUserPaths", () => {
  it("collapses a known root", () => {
    expect(redactUserPaths("/home/bryan/.local/share/tandem", [HOME])).toBe(
      "~/.local/share/tandem",
    );
  });

  it("does not swallow a path that merely starts with the root string", () => {
    // The classic: home `/root` vs an unrelated `/rootfs`.
    expect(redactUserPaths("/rootfs/mount", [{ path: "/root", as: "~" }])).toBe("/rootfs/mount");
    expect(redactUserPaths("/root/x", [{ path: "/root", as: "~" }])).toBe("~/x");
  });

  it("redacts an app-data root that lives outside home", () => {
    const roots = [HOME, { path: "/srv/exports/bryan/tandem", as: "<app-data>" }];
    expect(redactUserPaths("/srv/exports/bryan/tandem/annotations", roots)).toBe(
      "<app-data>/annotations",
    );
  });

  it("prefers the home-relative form when the app-data root is nested under home", () => {
    // `~/.local/share/tandem` is both safe and more useful than an opaque
    // placeholder, so the nested root is skipped.
    const roots = [HOME, { path: "/home/bryan/.local/share", as: "<app-data>" }];
    expect(redactUserPaths("/home/bryan/.local/share/tandem", roots)).toBe("~/.local/share/tandem");
  });

  it("catches a user directory belonging to nobody we were told about", () => {
    // Reaches the report inside a raw fs error, where no prefix list applies.
    expect(
      redactUserPaths(
        "EACCES: permission denied, scandir '/home/someoneelse/.local/share/tandem'",
        [HOME],
      ),
    ).toBe("EACCES: permission denied, scandir '/home/[user]/.local/share/tandem'");
  });

  it.each([
    [
      "/Users/alice/Library/Application Support/tandem",
      "/Users/[user]/Library/Application Support/tandem",
    ],
    ["C:\\Users\\alice\\AppData\\Local\\tandem", "C:\\Users\\[user]\\AppData\\Local\\tandem"],
  ])("collapses the generic user segment in %s", (input, expected) => {
    expect(redactUserPaths(input, [])).toBe(expected);
  });

  it.each([
    [""],
    ["/"],
    ["C:\\"],
    ["C:"],
  ])("ignores the degenerate root %p rather than corrupting every path", (path) => {
    const input = "/home/bryan/x and C:\\Windows\\y";
    // Only the generic second pass should apply.
    expect(redactUserPaths(input, [{ path, as: "~" }])).toBe("/home/[user]/x and C:\\Windows\\y");
  });

  it("replaces every occurrence, not just the first", () => {
    expect(redactUserPaths("/home/bryan/a then /home/bryan/b", [HOME])).toBe("~/a then ~/b");
  });

  it("leaves text with no user paths untouched", () => {
    const msg = "Hocuspocus :3478 and MCP :3479 are listening";
    expect(redactUserPaths(msg, [HOME])).toBe(msg);
  });
});

describe("diagnosticsRedactRoots", () => {
  it("covers every source resolveAppDataDir() consults, plus both spellings of home", () => {
    const roots = diagnosticsRedactRoots("/home/bryan", {
      HOME: "/home/bryan",
      USERPROFILE: "C:\\Users\\bryan",
      TANDEM_APP_DATA_DIR: "/srv/tandem",
      XDG_DATA_HOME: "/mnt/data",
      LOCALAPPDATA: "C:\\Data",
    } as NodeJS.ProcessEnv);

    expect(roots.filter((r) => r.as === "~").map((r) => r.path)).toEqual([
      "/home/bryan",
      "/home/bryan",
      "C:\\Users\\bryan",
    ]);
    expect(roots.filter((r) => r.as === "<app-data>").map((r) => r.path)).toEqual([
      "/srv/tandem",
      "/mnt/data",
      "C:\\Data",
    ]);
  });

  it("tolerates an environment where none of the overrides are set", () => {
    const roots = diagnosticsRedactRoots("/home/bryan", {} as NodeJS.ProcessEnv);
    expect(redactUserPaths("/home/bryan/x", roots)).toBe("~/x");
  });

  it("still redacts when os.homedir() and $HOME disagree", () => {
    // Happens under sudo, or a launcher that overrides the environment. A pass
    // keyed on only one of them would miss paths built from the other.
    const roots = diagnosticsRedactRoots("/root", { HOME: "/home/bryan" } as NodeJS.ProcessEnv);
    expect(redactUserPaths("/root/a and /home/bryan/b", roots)).toBe("~/a and ~/b");
  });
});
