import { describe, expect, it } from "vitest";
import {
  bezierLeaderPath,
  type LeaderEndpoints,
  leaderColorForAuthor,
} from "../../src/client/panels/marginLeaderGeometry";

describe("leaderColorForAuthor", () => {
  // Equivalence classes cover every value of Annotation["author"]. The
  // assertNever branch is unreachable under TS; coverage proof is that all
  // three cases below resolve to distinct CSS variables.
  it.each([
    {
      author: "claude" as const,
      expected: "var(--tandem-author-claude)",
      why: "Claude-authored comment / suggestion → claude tone",
    },
    {
      author: "user" as const,
      expected: "var(--tandem-author-user)",
      why: "user-authored note / highlight → user tone",
    },
    {
      author: "import" as const,
      expected: "var(--tandem-fg-subtle)",
      why: ".docx Word-comment-derived → neutral subtle tone, distinct from Claude",
    },
  ])("maps $author → $expected ($why)", ({ author, expected }) => {
    expect(leaderColorForAuthor(author)).toBe(expected);
  });
});

describe("bezierLeaderPath", () => {
  // Geometry: leader runs from the editor's text edge (startX, startY) to
  // the bubble column's near edge (endX, endY). Control points sit 10px / 8px
  // INWARD from each endpoint along the X axis. "Inward" flips with side.
  const baseRight: LeaderEndpoints = {
    startX: 0,
    startY: 100,
    endX: 24,
    endY: 130,
    side: "right",
  };
  const baseLeft: LeaderEndpoints = {
    startX: 24,
    startY: 100,
    endX: 0,
    endY: 130,
    side: "left",
  };

  it("right-side control points are +10 inward from startX and −8 inward from endX", () => {
    const d = bezierLeaderPath(baseRight);
    // M 0,100 C 10,100 16,130 24,130 — cp1.x = startX + 10, cp2.x = endX − 8
    expect(d).toBe("M 0.0,100.0 C 10.0,100.0 16.0,130.0 24.0,130.0");
  });

  it("left-side control points mirror the sign (cp1.x < startX, cp2.x > endX)", () => {
    const d = bezierLeaderPath(baseLeft);
    // M 24,100 C 14,100 8,130 0,130 — cp1.x = startX − 10, cp2.x = endX + 8
    expect(d).toBe("M 24.0,100.0 C 14.0,100.0 8.0,130.0 0.0,130.0");
  });

  it.each([
    {
      dy: 0,
      why: "ΔY = 0 (bubble at exactly the anchor height): horizontal sweep, no collision push",
    },
    { dy: 200, why: "large +ΔY (collision pushed bubble far below anchor): tall sweep" },
    { dy: -50, why: "negative ΔY (collision pushed bubble above anchor — rare but possible)" },
  ])("produces a valid M..C path for ΔY=$dy ($why)", ({ dy }) => {
    const d = bezierLeaderPath({ ...baseRight, endY: baseRight.startY + dy });
    expect(d).toMatch(
      /^M \d+\.\d+,\d+\.\d+ C \d+\.\d+,\d+\.\d+ \d+\.\d+,-?\d+\.\d+ \d+\.\d+,-?\d+\.\d+$/,
    );
  });

  it("rounds float-jittery inputs to 1dp (stable snapshots)", () => {
    const jittery = bezierLeaderPath({
      startX: 0.001,
      startY: 100.0001,
      endX: 24.0001,
      endY: 130.0001,
      side: "right",
    });
    const clean = bezierLeaderPath(baseRight);
    expect(jittery).toBe(clean);
  });
});
