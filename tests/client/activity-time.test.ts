import { describe, expect, it } from "vitest";
import { relativeTime } from "../../src/client/components/activityCenter.js";

describe("relativeTime", () => {
  const now = 1_000_000_000_000;

  it.each([
    { ago: 0, label: "now", why: "zero delta" },
    { ago: 4_000, label: "now", why: "under the 5s 'now' threshold" },
    { ago: 5_000, label: "5s", why: "at the seconds boundary" },
    { ago: 59_000, label: "59s", why: "just under a minute" },
    { ago: 60_000, label: "1m", why: "rolls to minutes" },
    { ago: 90_000, label: "1m", why: "floors mid-minute — 90s is '1m', not '2m'" },
    { ago: 59 * 60_000, label: "59m", why: "just under an hour" },
    { ago: 60 * 60_000, label: "1h", why: "rolls to hours" },
    { ago: 90 * 60_000, label: "1h", why: "floors mid-hour — 90m is '1h', not '2h'" },
    { ago: 23 * 60 * 60_000, label: "23h", why: "just under a day" },
    { ago: 24 * 60 * 60_000, label: "1d", why: "rolls to days" },
    { ago: 3 * 24 * 60 * 60_000, label: "3d", why: "multi-day persisted event" },
  ])("$ago ms ago → $label ($why)", ({ ago, label }) => {
    expect(relativeTime(now - ago, now)).toBe(label);
  });

  it("clamps future timestamps to 'now' (clock skew across reload)", () => {
    expect(relativeTime(now + 10_000, now)).toBe("now");
  });
});
