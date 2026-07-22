import { describe, expect, it } from "vitest";
import type { SanitizationEvent } from "../../src/shared/sanitize";
import { sanitizeAnnotation } from "../../src/shared/sanitize";
import type { Annotation } from "../../src/shared/types";

// #1123 M3: the `agentIdentity` byline field must survive `sanitizeAnnotation`.
// sanitize is a strict ALLOWLIST — every Claude-facing annotation read routes
// through it (client yjsSync, server collectAnnotations, addReplyToAnnotation's
// parent read). If the allowlist ever drops the field, the provider byline
// silently no-ops on the client even though the loop stamped it. This is the
// one load-bearing gap two plan reviewers independently flagged.

const baseAnn = {
  id: "ai-test",
  author: "claude" as const,
  range: { from: 0, to: 5 },
  content: "a local-model comment",
  status: "pending" as const,
  timestamp: 1000,
};

const identity = { provider: "local-ollama" as const, displayName: "Qwen 2.5" };

function sanitize(ann: object): Annotation {
  const events: SanitizationEvent[] = [];
  return sanitizeAnnotation(ann as Annotation, (e) => events.push(e));
}

describe("#1123 M3: agentIdentity survives sanitizeAnnotation", () => {
  it("preserves agentIdentity on an agent comment", () => {
    const result = sanitize({ ...baseAnn, type: "comment", agentIdentity: identity });
    expect(result.agentIdentity).toEqual(identity);
  });

  it("leaves agentIdentity absent when the input has none (dark-safe: no phantom)", () => {
    const result = sanitize({ ...baseAnn, type: "comment" });
    expect(result.agentIdentity).toBeUndefined();
  });

  it("survives the suggestion→comment migration (replacement records carry it)", () => {
    // propose_replacement stores a comment with suggestedText; a legacy
    // `suggestion` record takes the early-return migration path, which spreads
    // `base` — the field must ride through that branch too.
    const result = sanitize({
      ...baseAnn,
      type: "suggestion",
      content: JSON.stringify({ newText: "x", reason: "y" }),
      agentIdentity: identity,
    });
    expect(result.type).toBe("comment");
    expect(result.agentIdentity).toEqual(identity);
  });
});
