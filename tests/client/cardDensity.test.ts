import { describe, expect, it } from "vitest";
import type { MarginMode } from "../../src/client/layout/editor-stage.svelte";
import { cardDensity, type Density } from "../../src/client/panels/cardDensity";

interface Case {
  mode: MarginMode;
  isActive: boolean;
  isEditing: boolean;
  expected: Density;
  why: string;
}

// Equivalence classes over MarginMode × {active,inactive} × {editing,not}. The
// `why` column names the rule each row exercises so a missing class is visible
// (`feedback_iteach_equivalence_classes`). The `crowded` / `isPinned` axes added
// by the vertical-pressure work get their own describe block below, so this
// table keeps documenting the pre-existing rules unchanged.
//
// `author` is intentionally NOT an input. Note the original justification —
// "imports are .docx-only and .docx never enters the narrow/stub continuum" —
// is now only half true: docx resolves to the FULL band, which DOES receive the
// pressure pass, so an imported comment can render `compact`. That is deliberate
// (`compact` keeps the action row, so Promote/Dismiss stays reachable), not an
// oversight; see the crowded block below.
const cases: Case[] = [
  // --- stub band wins over active AND editing (28px track fits only a pip) ---
  { mode: "stub", isActive: false, isEditing: false, expected: "stub", why: "stub inactive → pip" },
  {
    mode: "stub",
    isActive: true,
    isEditing: false,
    expected: "stub",
    why: "stub stays a pip even when active (no in-place expand at 28px)",
  },
  {
    mode: "stub",
    isActive: false,
    isEditing: true,
    expected: "stub",
    why: "stub stays a pip even when editing (edit affordance is hidden in stub)",
  },
  {
    mode: "stub",
    isActive: true,
    isEditing: true,
    expected: "stub",
    why: "stub wins over both overrides",
  },

  // --- narrow band: active/editing expand to full, else a one-line teaser ---
  {
    mode: "narrow",
    isActive: false,
    isEditing: false,
    expected: "clamped",
    why: "narrow inactive → clamped teaser",
  },
  {
    mode: "narrow",
    isActive: true,
    isEditing: false,
    expected: "full",
    why: "active expands narrow → full",
  },
  {
    mode: "narrow",
    isActive: false,
    isEditing: true,
    expected: "full",
    why: "editing expands narrow → full",
  },
  {
    mode: "narrow",
    isActive: true,
    isEditing: true,
    expected: "full",
    why: "narrow active+editing → full",
  },

  // --- full band: always full -------------------------------------------------
  { mode: "full", isActive: false, isEditing: false, expected: "full", why: "full band, inactive" },
  { mode: "full", isActive: true, isEditing: false, expected: "full", why: "full band, active" },
  { mode: "full", isActive: false, isEditing: true, expected: "full", why: "full band, editing" },

  // --- off band: full (column unmounts before this is rendered) --------------
  {
    mode: "off",
    isActive: false,
    isEditing: false,
    expected: "full",
    why: "off band falls through to full",
  },
  {
    mode: "off",
    isActive: true,
    isEditing: true,
    expected: "full",
    why: "off band, overrides irrelevant",
  },
];

describe("cardDensity", () => {
  it.each(cases)("$mode active=$isActive editing=$isEditing → $expected ($why)", ({
    mode,
    isActive,
    isEditing,
    expected,
  }) => {
    expect(cardDensity({ mode, isActive, isEditing })).toBe(expected);
  });

  it("is total over the full input space (no undefined return)", () => {
    const modes: MarginMode[] = ["full", "narrow", "stub", "off"];
    const valid: Density[] = ["full", "compact", "clamped", "stub"];
    for (const mode of modes) {
      for (const isActive of [true, false]) {
        for (const isEditing of [true, false]) {
          for (const crowded of [true, false]) {
            for (const isPinned of [true, false]) {
              expect(valid).toContain(
                cardDensity({ mode, isActive, isEditing, crowded, isPinned }),
              );
            }
          }
        }
      }
    }
  });

  it("omitting crowded/isPinned reproduces the pre-existing verdict exactly", () => {
    // The two new inputs default false, so every call site that predates them —
    // including the whole table above — must be behaviourally untouched.
    for (const c of cases) {
      const withDefaults = cardDensity({
        mode: c.mode,
        isActive: c.isActive,
        isEditing: c.isEditing,
      });
      const explicitFalse = cardDensity({
        mode: c.mode,
        isActive: c.isActive,
        isEditing: c.isEditing,
        crowded: false,
        isPinned: false,
      });
      expect(withDefaults).toBe(c.expected);
      expect(explicitFalse).toBe(c.expected);
    }
  });
});

describe("cardDensity — vertical pressure (crowded)", () => {
  it("crowded at the full band yields compact, which KEEPS the action row", () => {
    // The distinction that justifies a fourth density: `clamped` drops
    // accept/dismiss because a 160px narrow column cannot fit them; a compact
    // card is full-width and has the room, so minimizing never costs an extra
    // click to act.
    //
    // This is also the docx path: `resolveBaseMode` clamps docx to full|off, so
    // an imported Word comment cluster lands here. No carve-out is needed
    // precisely BECAUSE compact keeps Promote/Dismiss reachable.
    expect(cardDensity({ mode: "full", isActive: false, isEditing: false, crowded: true })).toBe(
      "compact",
    );
  });

  it("uncrowded at the full band stays full", () => {
    expect(cardDensity({ mode: "full", isActive: false, isEditing: false, crowded: false })).toBe(
      "full",
    );
  });

  it("active, editing and pinned each beat crowded", () => {
    const base = { mode: "full" as const, crowded: true };
    expect(cardDensity({ ...base, isActive: true, isEditing: false })).toBe("full");
    expect(cardDensity({ ...base, isActive: false, isEditing: true })).toBe("full");
    expect(cardDensity({ ...base, isActive: false, isEditing: false, isPinned: true })).toBe(
      "full",
    );
  });

  it("stub beats crowded and pinned — a pip has no room to expand", () => {
    expect(
      cardDensity({
        mode: "stub",
        isActive: false,
        isEditing: false,
        crowded: true,
        isPinned: true,
      }),
    ).toBe("stub");
  });

  it("narrow ignores crowded — width pressure already minimized the card", () => {
    // A narrow card is a one-line teaser already; there is nothing for vertical
    // pressure to add, and promoting it to `compact` would ADD the action row
    // back into a column too narrow to hold it.
    expect(cardDensity({ mode: "narrow", isActive: false, isEditing: false, crowded: true })).toBe(
      "clamped",
    );
  });

  it("pinning overrides narrow-mode clamping too", () => {
    expect(cardDensity({ mode: "narrow", isActive: false, isEditing: false, isPinned: true })).toBe(
      "full",
    );
  });
});
