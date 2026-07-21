import { describe, expect, it } from "vitest";
import type { SanitizationEvent } from "../../src/shared/sanitize";
import { sanitizeAnnotation } from "../../src/shared/sanitize";
import type { Annotation } from "../../src/shared/types";

// WS-A2 Phase 0 kill-experiment (b): the `heldInSolo` Solo-hold marker must
// survive `sanitizeAnnotation`. Every Claude-facing read routes through
// sanitize; the field was DORMANT before WS-A2 and the allowlist `base` stripped
// it. If this ever regresses, the client badge and the fail-closed-restart
// tiebreaker (both read `heldInSolo` off the sanitized record) silently see it
// as always-undefined — the hold's badge/restart honesty evaporates.

const baseAnn = {
  id: "held-test",
  author: "user" as const,
  range: { from: 0, to: 5 },
  content: "held comment",
  status: "pending" as const,
  timestamp: 1000,
};

function sanitize(ann: object): Annotation {
  const events: SanitizationEvent[] = [];
  return sanitizeAnnotation(ann as Annotation, (e) => events.push(e));
}

describe("WS-A2: heldInSolo survives sanitizeAnnotation", () => {
  it("preserves heldInSolo:true on a user comment", () => {
    const result = sanitize({ ...baseAnn, type: "comment", heldInSolo: true });
    expect(result.heldInSolo).toBe(true);
  });

  it("preserves heldInSolo:false (an explicit not-held marker is not the same as absent)", () => {
    const result = sanitize({ ...baseAnn, type: "comment", heldInSolo: false });
    expect(result.heldInSolo).toBe(false);
  });

  it("leaves heldInSolo absent when the input has none (no phantom false)", () => {
    const result = sanitize({ ...baseAnn, type: "comment" });
    expect(result.heldInSolo).toBeUndefined();
  });

  it("ignores a non-boolean heldInSolo rather than passing junk through", () => {
    const result = sanitize({ ...baseAnn, type: "comment", heldInSolo: "yes" });
    expect(result.heldInSolo).toBeUndefined();
  });

  it("survives a promoted note→comment (author user, promotedFrom note)", () => {
    // The note→comment promotion path is a held write-site (WS-A2 A-F2); a held
    // promoted comment must keep its marker through sanitize like any other.
    const result = sanitize({
      ...baseAnn,
      type: "comment",
      promotedFrom: "note",
      heldInSolo: true,
    });
    expect(result.heldInSolo).toBe(true);
    expect(result.promotedFrom).toBe("note");
  });
});
