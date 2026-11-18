/**
 * Mounts for every surface that names an AI (#1123's agent-labels brief, its
 * Facts table), each returning the label text it renders. Shared by
 * `agent-label-surfaces-lit.test.ts` and `agent-label-surfaces-dark.test.ts`;
 * each of those files forces `BYO_MODELS_ENABLED` with a file-level `vi.mock`,
 * which also applies to the components imported here.
 *
 * Auto-cleanup never registers in this repo's client project, so every mount
 * unmounts itself before returning, and queries are scoped to its container.
 * The editor's aria-label is not here: it needs the ProseMirror mocks of the
 * decoration harness, so it lives in the `agent-label-decoration-*` files.
 */

import { fireEvent, render } from "@testing-library/svelte";
import { tick } from "svelte";
import { expect, vi } from "vitest";
import * as Y from "yjs";
import AnnotationCard from "../../src/client/panels/AnnotationCard.svelte";
import AnnotationCardActions from "../../src/client/panels/AnnotationCardActions.svelte";
import AnnotationCardHeader from "../../src/client/panels/AnnotationCardHeader.svelte";
import BatchPromoteBar from "../../src/client/panels/BatchPromoteBar.svelte";
import ChatPanel from "../../src/client/panels/ChatPanel.svelte";
import ReplyThread from "../../src/client/panels/ReplyThread.svelte";
import SidePanel from "../../src/client/panels/SidePanel.svelte";
import type { UseAnnotationReviewReturn } from "../../src/client/panels/useAnnotationReview.svelte";
import StatusBar from "../../src/client/status/StatusBar.svelte";
import type {
  AgentIdentity,
  Annotation,
  AnnotationReply,
  ChatMessage,
} from "../../src/shared/types";

const squash = (s: string | null | undefined) => (s ?? "").replace(/\s+/g, " ").trim();

/** `discloseUnfold` drives `element.animate()`, which happy-dom lacks (as reply-thread.test.ts). */
export function stubAnimate(): void {
  (Element.prototype as unknown as { animate: () => unknown }).animate = () => ({
    cancel() {},
    currentTime: 0,
    playState: "finished",
    effect: null,
    onfinish: null,
  });
}

export function agentAnnotation(id: string, agentIdentity?: AgentIdentity): Annotation {
  return {
    id,
    type: "comment",
    author: "claude",
    audience: "outbound",
    status: "pending",
    content: `Body ${id}`,
    range: { from: 0, to: 1 },
    timestamp: 0,
    ...(agentIdentity ? { agentIdentity } : {}),
  } as Annotation;
}

/** Chat byline of one agent row (`chat-author-<id>`), as chat-panel-local.test.ts mounts it. */
export async function chatByline(agentIdentity?: AgentIdentity): Promise<string> {
  const row: ChatMessage = {
    id: "r1",
    author: "claude",
    text: "a reply",
    timestamp: 1_800_000_000_000,
    read: true,
    ...(agentIdentity ? { agentIdentity } : {}),
  };
  const r = render(ChatPanel, {
    props: {
      messages: [row],
      editor: null,
      activeDocId: null,
      openDocs: [{ id: "d1", fileName: "notes.md" }],
      capturedAnchor: null,
      onCapturedAnchorChange: () => {},
      onSend: () => true,
      onClear: async () => {},
      onExport: async () => {},
      onInsert: () => false,
      canInsert: true,
      tandemClaudeControl: null,
      onStartClaude: () => {},
      onTurnOffClaude: () => {},
      tandemClaudeResume: null,
      onResumeRemedy: () => {},
      tandemClaudeGreetingLate: null,
      onGreetingAction: () => {},
      claudeCodeOfferEligible: false,
      onClaudeCodeOfferSetup: () => {},
      onClaudeCodeOfferDismiss: () => {},
      aiDisabled: false,
      localPickup: null,
      localPeriod: false,
      noticeAnnouncement: "",
    },
  });
  await tick();
  const el = r.container.querySelector("[data-testid='chat-author-r1']");
  expect(el, "the chat byline rendered").not.toBeNull();
  const text = squash(el?.textContent);
  r.unmount();
  return text;
}

/** Reply byline: ReplyThread renders CommentThread once expanded (reply-thread.test.ts). */
export async function replyByline(agentIdentity?: AgentIdentity): Promise<string> {
  stubAnimate();
  const reply: AnnotationReply = {
    id: "reply-1",
    annotationId: "a1",
    author: "claude",
    text: "Existing reply",
    timestamp: 0,
    ...(agentIdentity ? { agentIdentity } : {}),
  };
  const r = render(ReplyThread, {
    props: {
      aiDisabled: false,
      annotation: agentAnnotation("a1"),
      replies: [reply],
      isPending: false,
      isEditing: false,
    },
  });
  await fireEvent.click(r.container.querySelector("[data-testid='reply-toggle-a1']") as Element);
  const el = r.container.querySelector(".ct-author.is-claude");
  expect(el, "the reply byline rendered").not.toBeNull();
  const text = squash(el?.textContent);
  r.unmount();
  return text;
}

/** Card author label alone (annotation-card-header.test.ts's `authorLabelText`). */
export function cardAuthor(agentIdentity?: AgentIdentity): string {
  const r = render(AnnotationCardHeader, {
    props: {
      annotation: agentAnnotation("a1", agentIdentity),
      isPending: true,
      isEditing: false,
      canEdit: false,
      onEnterEdit: () => {},
    },
  });
  const span = r.container.querySelector(".ach-author")?.cloneNode(true) as HTMLElement | undefined;
  expect(span, "the card author rendered").toBeTruthy();
  span?.querySelector(".ach-time")?.remove();
  const text = squash(span?.textContent);
  r.unmount();
  return text;
}

/** The card's "working" indicator (AnnotationCard with `claudeTyping`). */
export function cardWorking(): { ariaLabel: string; title: string } {
  const r = render(AnnotationCard, {
    props: { aiDisabled: false, annotation: agentAnnotation("a1"), claudeTyping: true },
  });
  const el = r.container.querySelector("[data-testid='claude-typing-indicator-a1']");
  expect(el, "the working indicator rendered").not.toBeNull();
  const out = {
    ariaLabel: el?.getAttribute("aria-label") ?? "",
    title: el?.getAttribute("title") ?? "",
  };
  r.unmount();
  return out;
}

/** The status bar's working pill, whole text (StatusBar.svelte.test.ts's positive control). */
export function statusPill(): string {
  const r = render(StatusBar, {
    props: {
      connected: true,
      connectionStatus: "connected" as const,
      reconnectAttempts: 0,
      disconnectedSince: null,
      claudeStatus: "reviewing…",
      claudeActive: true,
      claudeWorkingTool: "tandem_edit",
      aiLiveIndicator: "connected" as const,
      aiLauncherAttached: false,
      aiLocalChat: null,
      aiLauncherRestarting: false,
      aiLauncherStarting: false,
      aiLauncherStandby: null,
      aiLauncherStandbyRecent: false,
      onStartClaude: () => {},
      aiSessionCount: null,
      aiNotice: null,
      onOpenLicenseSettings: () => {},
      aiState: "ready" as const,
      soloMode: false,
    },
  });
  const el = r.container.querySelector("[data-testid='claude-working-indicator']");
  expect(el, "the working pill rendered").not.toBeNull();
  const text = squash(el?.textContent);
  r.unmount();
  return text;
}

/** The card's "Send to …" button (ai-off-controls.test.ts's mount). */
export function cardSendTo(): string {
  const r = render(AnnotationCardActions, {
    props: {
      annotationId: "n1",
      annotationType: "note",
      isPending: true,
      isEditing: false,
      onSendToClaude: vi.fn(),
      aiDisabled: false,
    },
  });
  const el = r.container.querySelector("[data-testid='send-to-claude-btn-n1']");
  expect(el, "the card's Send to rendered").not.toBeNull();
  const text = squash(el?.textContent);
  r.unmount();
  return text;
}

/** The batch bar's two strings: "Send {n} to …" (request) and "Send to …" (commit). */
export function batchSendTo(): { request: string; commit: string } {
  const mount = (promoteConfirm: boolean, testId: string) => {
    const r = render(BatchPromoteBar, {
      props: {
        selectedCount: 2,
        promoteConfirm,
        onPromote: vi.fn(),
        onConfirmPromote: vi.fn(),
        onCancelPromote: vi.fn(),
        onClear: vi.fn(),
        reduceMotion: true,
        aiDisabled: false,
      },
    });
    const el = r.container.querySelector(`[data-testid='${testId}']`);
    expect(el, `${testId} rendered`).not.toBeNull();
    const text = squash(el?.textContent);
    r.unmount();
    return text;
  };
  return {
    request: mount(false, "batch-promote-confirm"),
    commit: mount(true, "batch-promote-commit"),
  };
}

function makeReview(): UseAnnotationReviewReturn {
  return {
    resolveAnnotation: vi.fn(),
    acceptReplySuggestion: vi.fn(),
    undoResolveAnnotation: vi.fn(() => false),
    handleAccept: vi.fn(),
    handleDismiss: vi.fn(),
    scrollToAnnotation: vi.fn(),
    getRecentlyResolved: () => new Set<string>(),
    forgetResolved: vi.fn(),
    getReviewIndex: () => 0,
    getReviewTargets: () => [],
    isTargetLost: () => false,
  };
}

/**
 * The comment filter (side-panel-filter-bar.test.ts's mount), with one Claude
 * comment and one local-model comment. Returns the agent chip's accessible
 * name, the `filter-bar-toggle` text once that chip is selected (the summary
 * renders only then), and which annotation cards are still listed.
 */
export async function commentFilter(): Promise<{
  chipName: string;
  summary: string;
  listed: string[];
}> {
  stubAnimate();
  const annotations = [
    agentAnnotation("claude-1"),
    agentAnnotation("local-1", { provider: "local-ollama", displayName: "My Llama" }),
  ];
  const r = render(SidePanel, {
    props: {
      annotations,
      editor: null,
      ydoc: new Y.Doc(),
      documentId: "doc-a",
      activeAnnotationId: null,
      onActiveAnnotationChange: vi.fn(),
      review: makeReview(),
    },
  });
  const toggle = r.container.querySelector<HTMLButtonElement>("[data-testid='filter-bar-toggle']");
  expect(toggle, "filter-bar-toggle rendered").not.toBeNull();
  await fireEvent.click(toggle as HTMLButtonElement);
  await tick();
  const chip = r.container.querySelector<HTMLElement>("[data-testid='filter-author-claude']");
  expect(chip, "the agent chip rendered").not.toBeNull();
  const chipName = chip?.getAttribute("aria-label") ?? "";
  await fireEvent.click(chip as HTMLElement);
  await tick();
  expect(chip?.getAttribute("aria-checked"), "sanity: the agent chip is selected").toBe("true");
  const summary = squash(toggle?.textContent);
  const listed = annotations
    .map((a) => a.id)
    .filter((id) => r.container.querySelector(`[data-testid='annotation-card-${id}']`) !== null);
  r.unmount();
  return { chipName, summary, listed };
}
