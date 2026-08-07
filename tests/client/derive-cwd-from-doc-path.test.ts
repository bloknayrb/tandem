// @vitest-environment happy-dom

/**
 * `deriveCwdFromDocPath` is the single derivation shared by the relaunch action
 * and the #1282 drift preview — the one place that decides which folder either
 * of them is talking about. It is pinned here rather than only through its
 * callers because the drift work deliberately removed the redundant
 * `isUploadPath` screen that used to sit in front of it in `App.svelte`: a
 * second copy of a predicate, inside the one feature whose thesis is that the
 * query side owns no predicate of its own. That is only safe while this
 * function really does reject non-filesystem URIs.
 */

import { describe, expect, it } from "vitest";

import { deriveCwdFromDocPath } from "../../src/client/actions/builtin.svelte.js";

const WINDOWS_DOC = ["C:", "Users", "u", "projects", "alpha", "README.md"].join("\\");
const WINDOWS_DIR = ["C:", "Users", "u", "projects", "alpha"].join("\\");

describe("deriveCwdFromDocPath", () => {
  it("returns the containing folder for a POSIX path", () => {
    expect(deriveCwdFromDocPath("/home/u/projects/alpha/README.md")).toBe("/home/u/projects/alpha");
  });

  it("returns the containing folder for a Windows path", () => {
    expect(deriveCwdFromDocPath(WINDOWS_DOC)).toBe(WINDOWS_DIR);
  });

  it("rejects upload:// scratchpad URIs", () => {
    expect(deriveCwdFromDocPath("upload://abc123/notes.md")).toBeNull();
  });

  it("rejects every other non-filesystem URI scheme", () => {
    for (const p of ["https://example.com/a.md", "file:///home/u/a.md", "scratchpad://x/y.md"]) {
      expect(deriveCwdFromDocPath(p), p).toBeNull();
    }
  });

  it("returns null with no document open", () => {
    expect(deriveCwdFromDocPath(null)).toBeNull();
    expect(deriveCwdFromDocPath("")).toBeNull();
  });

  it("returns null for a bare filename with no folder", () => {
    expect(deriveCwdFromDocPath("README.md")).toBeNull();
  });
});
