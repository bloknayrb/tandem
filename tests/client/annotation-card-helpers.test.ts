import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { formatRelativeTime } from "../../src/client/panels/annotation-card-helpers";

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
