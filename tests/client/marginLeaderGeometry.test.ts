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
  // Geometry: leader runs from the editor's text edge (startX, startY) to the
  // bubble column's near edge (endX, endY). Both control points sit SETTLE_K
  // (0.62) of the horizontal span dx = endX − startX inward, sharing the
  // endpoint Y — the symmetric "settle" lay-in (C4 #798). Side-agnostic: dx's
  // sign mirrors the curve, so the two cases below are exact horizontal mirrors.
  const baseRight: LeaderEndpoints = {
    startX: 0,
    startY: 100,
    endX: 24,
    endY: 130,
  };
  const baseLeft: LeaderEndpoints = {
    startX: 24,
    startY: 100,
    endX: 0,
    endY: 130,
  };

  it("right-side control points sit 0.62·dx inward from each endpoint (dx > 0)", () => {
    const d = bezierLeaderPath(baseRight);
    // dx=24; cp1.x = 0 + 24·0.62 = 14.88→14.9, cp2.x = 24 − 14.88 = 9.12→9.1.
    // cp1 > cp2 (control points cross — the intended k>0.5 settle shape).
    expect(d).toBe("M 0.0,100.0 C 14.9,100.0 9.1,130.0 24.0,130.0");
  });

  it("left-side is the exact horizontal mirror (dx < 0)", () => {
    const d = bezierLeaderPath(baseLeft);
    // dx=−24; cp1.x = 24 + (−24)·0.62 = 9.12→9.1, cp2.x = 0 − (−24)·0.62 = 14.88→14.9.
    expect(d).toBe("M 24.0,100.0 C 9.1,100.0 14.9,130.0 0.0,130.0");
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
    });
    const clean = bezierLeaderPath(baseRight);
    expect(jittery).toBe(clean);
  });
});
