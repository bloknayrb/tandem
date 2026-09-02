import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  formatRelativeTime,
  getAuthorLabel,
  getCardTint,
  getDisplayAuthor,
  presentsAsImport,
} from "../../src/client/panels/annotation-card-helpers";
import type { Annotation } from "../../src/shared/types";

describe("getCardTint (author is the tint axis)", () => {
  // A `Record` over the union, NOT a hand-written array. An array annotated
  // `Annotation["author"][]` is not required to be complete, so the previous
  // form's claim to be "exhaustive over the union" was false: add a fourth
  // author role and the array silently keeps three entries, `getCardTint`'s
  // final branch returns the USER tint, and the suite stays green — the exact
  // fall-through this is supposed to prevent. A `Record` keyed on the union
  // fails to compile until the new role is listed.
  //
  // Values are spelled out rather than interpolated from the key for the same
  // reason the mapping exists: `var(--tandem-author-${author}-bg)` would be
  // satisfied by any implementation that interpolates, including one naming a
  // token that does not exist. `card-tint-tokens.test.ts` closes the other half
  // by checking these strings resolve against index.html.
  const EXPECTED: Record<Annotation["author"], string> = {
    user: "var(--tandem-author-user-bg)",
    claude: "var(--tandem-author-claude-bg)",
    import: "var(--tandem-author-import-bg)",
  };

  it.each(Object.entries(EXPECTED))("maps %s to %s", (author, token) => {
    expect(getCardTint(author as Annotation["author"])).toBe(token);
  });

  it("gives every author a DISTINCT token", () => {
    expect(new Set(Object.values(EXPECTED)).size).toBe(Object.keys(EXPECTED).length);
  });

  // The `import` branch is the reason this function was extracted from
  // AnnotationCard.svelte at all. `annotation-lifecycle.spec.ts` pins user vs
  // claude against a real stylesheet, but rendering an imported card needs a
  // `.docx` import, so without this assertion that branch is covered nowhere:
  // deleting it would fall through to the user tint, and an imported Word
  // comment would render as though the user had written it.
  it("does not let an import fall through to the user tint", () => {
    expect(getCardTint("import")).not.toBe(getCardTint("user"));
  });
});

// #1123 M3: the agent byline prefers the specific authoring model's
// `agentIdentity.displayName`, then the active-model family label, then a
// neutral fallback. While BYO models are dark, agentIdentity is always absent,
// so the label must be byte-identical to the pre-M3 (family-or-fallback) form.
describe("getAuthorLabel — agent byline (#1123 M3)", () => {
  const identity = { provider: "local-ollama" as const, displayName: "Qwen 2.5" };

  it("prefers agentIdentity.displayName over the family label for a claude author", () => {
    expect(getAuthorLabel("claude", "Claude", identity)).toBe("Qwen 2.5");
  });

  it("falls back to the family label when agentIdentity is absent (dark / real Claude)", () => {
    expect(getAuthorLabel("claude", "Claude")).toBe("Claude");
    expect(getAuthorLabel("claude", "Claude", undefined)).toBe("Claude");
  });

  it("falls back to 'Assistant' when neither identity nor family is given", () => {
    expect(getAuthorLabel("claude")).toBe("Assistant");
  });

  it("ignores agentIdentity for non-agent authors (roles, not the agent)", () => {
    expect(getAuthorLabel("user", "Claude", identity)).toBe("You");
    expect(getAuthorLabel("import", "Claude", identity)).toBe("Imported");
  });
});

// `formatRelativeTime` reads `Date.now()`, so freeze the clock and express each
// case as an offset from "now". The two branch boundaries (minute→hour at 60min,
// hour→date at 24h) are the off-by-one-prone edges: the function floors a
// millisecond delta, so a `<`-vs-`<=` flip or a `60_000`-vs-`3_600_000` divisor
// typo would still render *a* string (just the wrong one) and slip past
// typecheck + E2E. Shared by AnnotationCardHeader + CommentThread, so a
// regression here corrupts two surfaces at once.
describe("formatRelativeTime", () => {
  const NOW = new Date("2026-06-18T12:00:00.000Z").getTime();
  const MIN = 60_000;
  const HR = 3_600_000;
  const ago = (ms: number) => formatRelativeTime(NOW - ms);

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns 'just now' for anything under a minute", () => {
    expect(ago(0)).toBe("just now");
    expect(ago(30 * 1000)).toBe("just now");
    expect(ago(59 * 1000)).toBe("just now"); // sub-1-min floor
  });

  it("returns whole minutes from 1m up to (but not including) 60m", () => {
    expect(ago(MIN)).toBe("1m ago"); // the under-a-minute → minutes boundary
    expect(ago(5 * MIN)).toBe("5m ago");
    expect(ago(59 * MIN)).toBe("59m ago"); // last minute before the hour rollover
  });

  it("rolls over to hours at exactly 60 minutes", () => {
    expect(ago(60 * MIN)).toBe("1h ago"); // minute→hour boundary
    expect(ago(23 * HR)).toBe("23h ago"); // last hour before the date rollover
  });

  it("falls back to the locale date at 24 hours and beyond", () => {
    // Locale-dependent output — compare against the same formatter rather than a
    // hardcoded string so the test is stable across machines/locales.
    const dayAgo = NOW - 24 * HR;
    expect(formatRelativeTime(dayAgo)).toBe(new Date(dayAgo).toLocaleDateString());
    const tenDaysAgo = NOW - 10 * 24 * HR;
    expect(formatRelativeTime(tenDaysAgo)).toBe(new Date(tenDaysAgo).toLocaleDateString());
  });

  it("treats a future timestamp (clock skew) as 'just now'", () => {
    // diffMin goes negative → < 1 → "just now"; documents the contract so a
    // future-dated annotation never renders a nonsensical "-3m ago".
    expect(formatRelativeTime(NOW + 5 * MIN)).toBe("just now");
  });
});

describe("getDisplayAuthor / presentsAsImport (#1714)", () => {
  // The split this fix introduces: `author` is the STORAGE role and decides
  // what the user may DO with a record; the display author decides what the
  // user is TOLD about it. They diverge for exactly one record shape — a note
  // or comment imported from a `.docx` and then promoted, which
  // `promotedAnnotation` rewrites to `author: "user"` while carrying the
  // reviewer's name through in `importSource`.
  const base = (over: Partial<Annotation> = {}): Annotation =>
    ({
      id: "a1",
      type: "comment",
      author: "user",
      status: "pending",
      content: "Body",
      range: { from: 0, to: 1 },
      timestamp: 0,
      ...over,
    }) as Annotation;

  it("a promoted import presents as an import despite author 'user'", () => {
    const ann = base({ importSource: { author: "Dana Reviewer", file: "draft.docx" } });
    expect(presentsAsImport(ann)).toBe(true);
    expect(getDisplayAuthor(ann)).toBe("import");
  });

  it("a genuine import with no author name still presents as an import", () => {
    // Provenance is checked first, but `author` is the fallback — a Word comment
    // whose author string is missing has no byline and is still not the user's.
    // Keying ONLY on provenance would send this record to the ordinary comment
    // card and give it the You dot, which is the same bug with a different
    // input.
    const ann = base({ author: "import" });
    expect(presentsAsImport(ann)).toBe(true);
    expect(getDisplayAuthor(ann)).toBe("import");
  });

  it("does not treat a blank or whitespace-only provenance author as a byline", () => {
    for (const author of ["", "   "]) {
      const ann = base({ importSource: { author, file: "draft.docx" } });
      expect(presentsAsImport(ann), `author ${JSON.stringify(author)}`).toBe(false);
      expect(getDisplayAuthor(ann)).toBe("user");
    }
  });

  it("leaves user and claude alone", () => {
    expect(getDisplayAuthor(base())).toBe("user");
    expect(getDisplayAuthor(base({ author: "claude" }))).toBe("claude");
    expect(presentsAsImport(base({ author: "claude" }))).toBe(false);
  });

  it("feeds the label and the tint, so both follow provenance", () => {
    // The two helpers this is threaded into. Asserted here as well as in the
    // component spec because the component can only see the header — the tint
    // is applied in `AnnotationCard` and the leader colour in `MarginColumn`,
    // and all three read the same accessor.
    const ann = base({ importSource: { author: "Dana Reviewer", file: "draft.docx" } });
    expect(getAuthorLabel(getDisplayAuthor(ann))).toBe("Imported");
    expect(getCardTint(getDisplayAuthor(ann))).toBe("var(--tandem-author-import-bg)");
  });
});
