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
// (`feedback_iteach_equivalence_classes`). `author` is intentionally NOT an
// input — imports are .docx-only and .docx never enters the narrow/stub
// continuum (legacy full|off path), so the plan [F4] import carve-out is
// unreachable; see the stub-geometry note in cardDensity.ts.
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
    const valid: Density[] = ["full", "clamped", "stub"];
    for (const mode of modes) {
      for (const isActive of [true, false]) {
        for (const isEditing of [true, false]) {
          expect(valid).toContain(cardDensity({ mode, isActive, isEditing }));
        }
      }
    }
  });
});
