// @vitest-environment happy-dom

import { render } from "@testing-library/svelte";
import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import ChatPanel from "../../src/client/panels/ChatPanel.svelte";
import { Y_MAP_CHAT } from "../../src/shared/constants";
import type { ChatMessage } from "../../src/shared/types";

function seedDoc(messages: ChatMessage[]): Y.Doc {
  const doc = new Y.Doc();
  const chat = doc.getMap(Y_MAP_CHAT);
  for (const m of messages) chat.set(m.id, m);
  return doc;
}

function renderChat(ctrlYdoc: Y.Doc) {
  return render(ChatPanel, {
    props: {
      ctrlYdoc,
      editor: null,
      activeDocId: null,
      openDocs: [],
      capturedAnchor: null,
      onCapturedAnchorChange: () => {},
    },
  });
}

function claudeMsg(overrides: Partial<ChatMessage> = {}): ChatMessage {
  return {
    id: "m1",
    author: "claude",
    text: "hello",
    timestamp: 1,
    ...overrides,
  } as ChatMessage;
}

function authorStyle(container: HTMLElement, id: string): string {
  return container.querySelector(`[data-testid='chat-author-${id}']`)?.getAttribute("style") ?? "";
}

describe("ChatPanel per-agent author color (#1123 M4)", () => {
  it("a claude message WITH agentIdentity colors the author with the per-agent token", () => {
    const doc = seedDoc([
      claudeMsg({ agentIdentity: { provider: "local-ollama", displayName: "Qwen 2.5" } }),
    ]);
    const { container } = renderChat(doc);
    const style = authorStyle(container, "m1");
    expect(style).toContain("var(--tandem-agent-local-ollama)");
    // The distinct fallbacks matter: it must NOT collapse to the accent baseline
    // nor to the annotation coral token.
    expect(style).not.toContain("var(--tandem-accent)");
    expect(style).not.toContain("var(--tandem-author-claude)");
  });

  it("a claude message WITHOUT agentIdentity keeps the accent baseline (byte-identical dark)", () => {
    // This is the one wiring site whose dark fallback is `--tandem-accent`, NOT
    // the claude token — a regression that routed it through agentColor's fallback
    // would silently flip the dark chat-author color from indigo to coral.
    const doc = seedDoc([claudeMsg()]);
    const { container } = renderChat(doc);
    const style = authorStyle(container, "m1");
    expect(style).toContain("var(--tandem-accent)");
    expect(style).not.toContain("var(--tandem-author-claude)");
    expect(style).not.toContain("var(--tandem-agent-");
  });

  it("a user message uses the muted token, unaffected by identity wiring", () => {
    const doc = seedDoc([claudeMsg({ id: "u1", author: "user", text: "hi" })]);
    const { container } = renderChat(doc);
    expect(authorStyle(container, "u1")).toContain("var(--tandem-fg-muted)");
  });
});
