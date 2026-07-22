// @vitest-environment happy-dom

import { render } from "@testing-library/svelte";
import { describe, expect, it } from "vitest";
import PeekStrip from "../../src/client/panels/PeekStrip.svelte";
import type { Annotation } from "../../src/shared/types";

function makeAnnotation(overrides: Partial<Annotation> = {}): Annotation {
  return {
    id: "a1",
    type: "comment",
    author: "claude",
    status: "pending",
    content: "body",
    range: { from: 0, to: 1 },
    timestamp: 0,
    ...overrides,
  } as Annotation;
}

function renderStrip(annotations: Annotation[]) {
  return render(PeekStrip, {
    props: {
      side: "right" as const,
      onActivate: () => {},
      collapsed: true,
      kind: "annotations" as const,
      annotations,
    },
  });
}

function dotStyle(container: HTMLElement, id: string): string | null {
  return container.querySelector(`[data-testid='peek-dot-${id}']`)?.getAttribute("style") ?? null;
}

describe("PeekStrip per-agent dot color (#1123 M4)", () => {
  it("a claude comment WITH agentIdentity tints the dot with the per-agent token", () => {
    const { container } = renderStrip([
      makeAnnotation({ agentIdentity: { provider: "local-ollama", displayName: "Qwen" } }),
    ]);
    expect(dotStyle(container, "a1")).toContain("background: var(--tandem-agent-local-ollama);");
  });

  it("a claude comment WITHOUT agentIdentity adds no inline style (byte-identical dark)", () => {
    // No inline style ⇒ the `.peek-dot.claude` CSS class's --tandem-author-claude
    // renders exactly as before M4.
    const { container } = renderStrip([makeAnnotation()]);
    expect(dotStyle(container, "a1")).toBeNull();
  });

  it("a suggestion dot (comment + suggestedText) never takes the agent tint", () => {
    // dotClass → "suggest" (violet, author-agnostic by design), so even with an
    // agentIdentity present the per-agent tint must not apply.
    const { container } = renderStrip([
      makeAnnotation({
        suggestedText: "x",
        agentIdentity: { provider: "local-ollama", displayName: "Qwen" },
      }),
    ]);
    expect(dotStyle(container, "a1")).toBeNull();
  });

  it("a highlight dot never takes the agent tint", () => {
    const { container } = renderStrip([makeAnnotation({ type: "highlight", author: "user" })]);
    expect(dotStyle(container, "a1")).toBeNull();
  });
});
