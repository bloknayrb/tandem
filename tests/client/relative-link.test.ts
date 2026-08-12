/**
 * `resolveRelativeLink` — the segment walk behind clicking a relative link.
 *
 * Extracted from `Editor.svelte` (where it was module-private and untestable)
 * so its fail-closed traversal guards can be pinned. Two things are asserted
 * here and nowhere else: that the #1377 shape (`docs/spec.md`) still resolves,
 * and that a crafted `..` chain cannot walk out to a UNC path and be POSTed to
 * `/api/open`.
 */

import { describe, expect, it } from "vitest";
import { resolveRelativeLink } from "../../src/client/editor/utils/relative-link";

const WIN = "C:\\Users\\b\\docs\\note.md";
const POSIX = "/home/u/docs/note.md";

describe("resolveRelativeLink — happy paths", () => {
  it.each([
    ["notes.md", "C:\\Users\\b\\docs\\notes.md", "/home/u/docs/notes.md"],
    // The #1377 shape: a BARE nested path. The whole point of widening the
    // render-time guard is that this href now reaches a click at all.
    ["docs/spec.md", "C:\\Users\\b\\docs\\docs\\spec.md", "/home/u/docs/docs/spec.md"],
    ["./notes.md", "C:\\Users\\b\\docs\\notes.md", "/home/u/docs/notes.md"],
    ["../spec.md", "C:\\Users\\b\\spec.md", "/home/u/spec.md"],
    // The fragment is stripped before resolution — no cross-file anchors.
    ["subdir/file.md#frag", "C:\\Users\\b\\docs\\subdir\\file.md", "/home/u/docs/subdir/file.md"],
  ])("resolves %s on both separators", (href, win, posix) => {
    expect(resolveRelativeLink(href, WIN)).toBe(win);
    expect(resolveRelativeLink(href, POSIX)).toBe(posix);
  });

  it("returns null for a .docx target (not in INTERNAL_LINK_EXTS)", () => {
    expect(resolveRelativeLink("report.docx", WIN)).toBeNull();
    expect(resolveRelativeLink("report.docx", POSIX)).toBeNull();
  });

  it("returns null for a pure fragment", () => {
    expect(resolveRelativeLink("#section", WIN)).toBeNull();
    expect(resolveRelativeLink("#section", POSIX)).toBeNull();
  });

  it("returns null when currentFilePath has no directory to resolve against", () => {
    expect(resolveRelativeLink("notes.md", "note.md")).toBeNull();
  });
});

describe("resolveRelativeLink — traversal is fail-closed", () => {
  it("rejects a `..` chain that walks out to a UNC path", () => {
    // Newly reachable through the widened render-time guard (#1377): without
    // the containment check this returns the UNC string
    // `\\evil.com\share\x.md`, which openHref POSTs to /api/open — Tandem's
    // named NTLM-hash-leak vector.
    expect(resolveRelativeLink("a/../../../../..///evil.com/share/x.md", WIN)).toBeNull();
  });

  it("rejects the PRE-EXISTING variant reachable on master", () => {
    // Tiptap's default URL guard ALLOWS this href today (it starts with `.`,
    // not a letter), so this row fails on master — the hole predates #1377.
    expect(resolveRelativeLink("../../../../..///evil.com/share/x.md", WIN)).toBeNull();
  });

  it("rejects a traversal escaping above the POSIX root", () => {
    expect(resolveRelativeLink("../../../../../../etc/passwd.md", POSIX)).toBeNull();
  });

  it("rejects a protocol-relative href", () => {
    // Never reaches here in practice — openHref routes `//` to
    // isSafeExternalHref first — but pinned so the function is correct
    // standalone.
    expect(resolveRelativeLink("//evil.com/x.md", WIN)).toBeNull();
    expect(resolveRelativeLink("//evil.com/x.md", POSIX)).toBeNull();
  });

  it("does NOT over-reject a backslash form that still resolves same-machine", () => {
    // Non-regression: `/\evil.com/x.md` is allowed by Tiptap's guard today and
    // resolves to a same-machine path that `path.resolve` collapses. The
    // containment check must not turn it into a null.
    expect(resolveRelativeLink("/\\evil.com/x.md", WIN)).toBe(
      "C:\\Users\\b\\docs\\\\\\evil.com\\x.md",
    );
  });
});
