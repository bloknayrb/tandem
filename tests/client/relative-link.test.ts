/**
 * `resolveRelativeLink` — the segment walk behind clicking a relative link.
 *
 * Extracted from `Editor.svelte` (where it was module-private and untestable)
 * so its fail-closed traversal guards can be pinned. Two things are asserted
 * here and nowhere else: that the #1377 shape (`docs/spec.md`) still resolves,
 * and that a crafted `..` chain cannot walk out to a UNC path and be POSTed to
 * `/api/open`.
 *
 * The reject rows assert the REASON, not just "refused". Mutation testing found
 * the two UNC defenses masking each other — deleting either one alone left the
 * whole suite green, because the survivor still returned a bare `null`. Reasons
 * make each guard individually killable.
 */

import { describe, expect, it } from "vitest";
import {
  type LinkRejectReason,
  resolveRelativeLink,
  SECURITY_REJECT_REASONS,
} from "../../src/client/editor/utils/relative-link";

const WIN = "C:\\Users\\b\\docs\\note.md";
const POSIX = "/home/u/docs/note.md";

/** Asserts a resolution succeeded and returns the path, for readable rows. */
function resolved(href: string, cur: string): string {
  const r = resolveRelativeLink(href, cur);
  if (!r.ok) throw new Error(`expected ${href} to resolve, got reject "${r.reason}"`);
  return r.path;
}

/** Asserts a resolution was refused and returns the reason. */
function rejected(href: string, cur: string): LinkRejectReason {
  const r = resolveRelativeLink(href, cur);
  if (r.ok) throw new Error(`expected ${href} to be refused, got "${r.path}"`);
  return r.reason;
}

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
    // …and so is a query string. Stripping only `#` made the render and click
    // boundaries disagree: `isSchemelessPathHref` renders this href, but
    // `TRAILING_EXT_RE` then saw `.md?x=1` and matched nothing.
    ["docs/spec.md?x=1", "C:\\Users\\b\\docs\\docs\\spec.md", "/home/u/docs/docs/spec.md"],
    ["spec.md?a=1#frag", "C:\\Users\\b\\docs\\spec.md", "/home/u/docs/spec.md"],
  ])("resolves %s on both separators", (href, win, posix) => {
    expect(resolved(href, WIN)).toBe(win);
    expect(resolved(href, POSIX)).toBe(posix);
  });

  it("resolves against the right directory when currentFilePath has MIXED separators", () => {
    // Kills the `split(PATH_SEP_RE)` → `split(sep)` mutation on the dirParts
    // side, which the homogeneous fixtures above cannot: with `split("\\")` the
    // trailing `docs/note.md` stays one segment, `pop()` removes the whole
    // thing, and the href silently resolves one directory too high.
    expect(resolved("spec.md", "C:\\Users\\b\\docs/note.md")).toBe("C:\\Users\\b\\docs\\spec.md");
  });

  it("treats a backslash inside an href as a separator, not a filename character", () => {
    // Fail-CLOSED direction. As one opaque segment, `a\..\..\..\x.md` would sail
    // through the `..` walk and the containment check untouched.
    expect(rejected("a\\..\\..\\..\\..\\..\\x.md", WIN)).toBe("escapes-root");
  });
});

describe("resolveRelativeLink — refusals carry a reason", () => {
  it.each([
    ["report.docx", "unsupported-ext", "a .docx target (not in INTERNAL_LINK_EXTS)"],
    ["paper.pdf", "unsupported-ext", "a non-Tandem format"],
    ["docs/", "unsupported-ext", "a directory with no extension"],
    ["#section", "fragment", "a pure fragment"],
    ["?x=1", "fragment", "a pure query string"],
  ])("refuses %s with reason %s (%s)", (href, reason) => {
    expect(rejected(href, WIN)).toBe(reason);
    expect(rejected(href, POSIX)).toBe(reason);
  });

  it("refuses with `no-directory` when currentFilePath has no separator", () => {
    // Kills deletion of the `dirParts.length === 0` guard: without it, `pop()`
    // leaves an empty array, `dirParts[0]` is undefined, and the containment
    // check refuses for the wrong reason.
    expect(rejected("notes.md", "note.md")).toBe("no-directory");
  });
});

describe("resolveRelativeLink — traversal is fail-closed", () => {
  it("rejects a `..` chain that walks out to a UNC path", () => {
    // Newly reachable through the widened render-time guard (#1377): without
    // the containment check this returns the UNC string
    // `\\evil.com\share\x.md`, which openHref POSTs to /api/open — Tandem's
    // named NTLM-hash-leak vector.
    expect(rejected("a/../../../../..///evil.com/share/x.md", WIN)).toBe("escapes-root");
  });

  it("rejects the PRE-EXISTING variant reachable on master", () => {
    // Tiptap's default URL guard ALLOWS this href today (it starts with `.`,
    // not a letter), so this row fails on master — the hole predates #1377.
    expect(rejected("../../../../..///evil.com/share/x.md", WIN)).toBe("escapes-root");
  });

  it("catches the SAME href on POSIX via the joined-UNC guard, not containment", () => {
    // The two guards are not redundant; they fire on different platforms. Here
    // containment PASSES (`resultParts[0]` and `dirParts[0]` are both `""`) and
    // only the post-join check refuses. Deleting it leaves a live POSIX hole
    // that the Windows rows above would not notice.
    expect(rejected("a/../../../../..///evil.com/share/x.md", POSIX)).toBe("joined-unc");
  });

  it("rejects a containment escape that is NOT UNC-shaped", () => {
    // The converse pin: containment alone must catch this, since the joined
    // result is an ordinary path the UNC check would wave through.
    expect(rejected("../../../../../../etc/passwd.md", POSIX)).toBe("escapes-root");
    expect(rejected("../../../../../../Windows/x.md", WIN)).toBe("escapes-root");
  });

  it("rejects a protocol-relative href", () => {
    // Never reaches here in practice — openHref routes `//` to
    // isSafeExternalHref first — but pinned so the function is correct
    // standalone.
    expect(rejected("//evil.com/x.md", WIN)).toBe("unsafe-prefix");
    expect(rejected("//evil.com/x.md", POSIX)).toBe("unsafe-prefix");
  });

  it("rejects device-namespace hrefs, which DO reach here", () => {
    // Unlike `//`, these are not pre-routed by openHref, so this guard changes
    // their outcome from a collapsed same-machine path to a refusal.
    expect(rejected("\\\\?\\C:\\x.md", WIN)).toBe("unsafe-prefix");
    expect(rejected("\\\\evil.com\\share\\x.md", WIN)).toBe("unsafe-prefix");
  });

  it("does NOT over-reject a backslash form that still resolves same-machine", () => {
    // Non-regression: `/\evil.com/x.md` is allowed by Tiptap's guard today and
    // resolves to a same-machine path that `path.resolve` collapses. The
    // containment check must not turn it into a refusal.
    expect(resolved("/\\evil.com/x.md", WIN)).toBe("C:\\Users\\b\\docs\\\\\\evil.com\\x.md");
  });
});

describe("SECURITY_REJECT_REASONS", () => {
  it("separates hostile hrefs from mistakes", () => {
    // `Editor.svelte` escalates this set to an error-severity notification
    // rather than a warning. A reason added to the union without a decision
    // here would silently default to the mistake treatment.
    expect([...SECURITY_REJECT_REASONS].sort()).toEqual([
      "escapes-root",
      "joined-unc",
      "unsafe-prefix",
    ]);
  });
});
