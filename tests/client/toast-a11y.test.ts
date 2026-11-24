// @vitest-environment happy-dom

/**
 * #2489 — toasts lost keyboard focus when a focused one closed, and a new
 * toast's `role="status"`/`"alert"` sat on the card its `{#each}` inserted
 * together with its text, the shape #1431 documents as commonly announced by
 * nothing.
 *
 * What these tests do NOT prove: no screen reader runs here, so the announcer
 * cases pin the structural precondition (a region mounted empty BEFORE its
 * text, then filled in place), as `live-regions.test.ts` does. Focus is real
 * DOM focus in happy-dom.
 */

import { cleanup, render } from "@testing-library/svelte";
import { tick } from "svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import ToastContainer from "../../src/client/components/ToastContainer.svelte";
import {
  toastAnnouncementText,
  toastFocusTarget,
  toastKey,
} from "../../src/client/components/toast-focus";
import type {
  NotificationsState,
  Toast,
  ToastAnnouncement,
} from "../../src/client/hooks/useNotifications.svelte";
import NotificationsHarness from "../../src/client/svelte-harness/NotificationsHarness.svelte";
import type { TandemNotification } from "../../src/shared/types.js";

afterEach(() => {
  cleanup();
  document.body.innerHTML = "";
});

function toast(id: string, overrides: Partial<Toast> = {}): Toast {
  return {
    id,
    type: "general-error",
    severity: "info",
    message: `message ${id}`,
    timestamp: 1,
    count: 1,
    ...overrides,
  };
}

const none: ToastAnnouncement = { polite: null, assertive: null };

function q(testid: string): HTMLElement | null {
  return document.querySelector<HTMLElement>(`[data-testid='${testid}']`);
}

function mount(toasts: Toast[], announced: ToastAnnouncement = none) {
  return render(ToastContainer, { props: { toasts, announced, onDismiss: vi.fn() } });
}

// ─────────────────────────────────────────────────────────────────────────────
// Announcements
// ─────────────────────────────────────────────────────────────────────────────

describe("toast announcers", () => {
  it("are mounted empty with fixed politeness before any toast exists", () => {
    mount([]);
    const polite = q("toast-announcer-polite");
    const assertive = q("toast-announcer-assertive");
    expect(polite?.getAttribute("role")).toBe("status");
    expect(polite?.getAttribute("aria-live")).toBe("polite");
    expect(assertive?.getAttribute("role")).toBe("alert");
    expect(assertive?.getAttribute("aria-live")).toBe("assertive");
    expect(polite?.textContent).toBe("");
    expect(assertive?.textContent).toBe("");
    expect(q("toast-container")).toBeNull();
  });

  it("fill the same nodes when a toast arrives, and the card carries no live role", async () => {
    const { rerender } = mount([]);
    const polite = q("toast-announcer-polite");
    const assertive = q("toast-announcer-assertive");

    await rerender({
      toasts: [toast("a"), toast("b", { severity: "error", message: "it broke" })],
      announced: { polite: "a", assertive: "b" },
    });

    expect(q("toast-announcer-polite")).toBe(polite);
    expect(q("toast-announcer-assertive")).toBe(assertive);
    expect(polite?.textContent).toBe("message a");
    expect(assertive?.textContent).toBe("it broke");
    for (const id of ["a", "b"]) {
      const card = q(`toast-${id}`);
      expect(card).toBeTruthy();
      expect(card?.getAttribute("role")).toBeNull();
      expect(card?.getAttribute("aria-live")).toBeNull();
    }
  });

  it("empty, rather than falling back to an older toast, when the announced toast goes", async () => {
    const { rerender } = mount([toast("old"), toast("new")], { polite: "new", assertive: null });
    expect(q("toast-announcer-polite")?.textContent).toBe("message new");
    await rerender({ toasts: [toast("old")], announced: { polite: "new", assertive: null } });
    expect(q("toast-announcer-polite")?.textContent).toBe("");
  });

  it("write to the region for a new toast whose sentence matches the one already there", async () => {
    const { rerender } = mount([toast("a", { message: "Saved." })], {
      polite: "a",
      assertive: null,
    });
    const polite = q("toast-announcer-polite") as HTMLElement;
    const mutations: MutationRecord[] = [];
    const observer = new MutationObserver((m) => mutations.push(...m));
    observer.observe(polite, { subtree: true, childList: true, characterData: true });
    await rerender({
      toasts: [toast("a", { message: "Saved." }), toast("b", { message: "Saved." })],
      announced: { polite: "b", assertive: null },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    observer.disconnect();
    expect(q("toast-announcer-polite")).toBe(polite);
    expect(polite.textContent).toBe("Saved.");
    expect(mutations.length).toBeGreaterThan(0);
  });

  // The E2E specs select a card's severity and the cards themselves by these
  // two attributes (`ALERT_TOAST_CARDS` in tests/e2e/helpers.ts, and
  // settings-modal.spec.ts). They are not `data-testid`s, so the selector
  // snapshot cannot see them; a rename must fail here rather than leave
  // `expectOnlyAllowanceNotices` silently matching nothing.
  it("cards carry the data-toast-severity and data-toast-key the E2E specs select on", () => {
    mount([toast("a"), toast("b", { severity: "warning", dedupKey: "d" })]);
    expect(q("toast-a")?.dataset.toastSeverity).toBe("info");
    expect(q("toast-b")?.dataset.toastSeverity).toBe("warning");
    expect(q("toast-a")?.dataset.toastKey).toBe("i:a");
    expect(q("toast-b")?.dataset.toastKey).toBe("k:d");
  });

  it("buttons are described by the toast's message", () => {
    mount([toast("a", { action: { label: "Do it", onClick: () => {} } })]);
    const msg = q("toast-a")?.querySelector(".msg");
    const id = msg?.getAttribute("id");
    expect(id).toBeTruthy();
    expect(q("toast-action-a")?.getAttribute("aria-describedby")).toBe(id);
    expect(q("toast-dismiss-a")?.getAttribute("aria-describedby")).toBe(id);
  });
});

describe("toastAnnouncementText", () => {
  it("speaks the count on a repeat so the sentence changes", () => {
    expect(toastAnnouncementText([toast("a", { count: 1 })], "a")).toBe("message a");
    expect(toastAnnouncementText([toast("a", { count: 3 })], "a")).toBe("message a (3 times)");
  });

  it("is empty for null or a missing id", () => {
    expect(toastAnnouncementText([toast("a")], null)).toBe("");
    expect(toastAnnouncementText([toast("a")], "gone")).toBe("");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The store's announced ids
// ─────────────────────────────────────────────────────────────────────────────

class FakeEventSource {
  static readonly CLOSED = 2;
  readyState = 1;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  close() {}
}

function note(overrides: Partial<TandemNotification>): TandemNotification {
  return {
    id: "n",
    type: "general-error",
    severity: "info",
    message: "m",
    timestamp: Date.now(),
    ...overrides,
  };
}

async function mountStore(): Promise<NotificationsState> {
  let state: NotificationsState | null = null;
  render(NotificationsHarness, { props: { onReady: (s: NotificationsState) => (state = s) } });
  await tick();
  if (!state) throw new Error("harness did not call onReady");
  return state;
}

describe("useNotifications — announced", () => {
  beforeEach(() => vi.stubGlobal("EventSource", FakeEventSource));
  afterEach(() => vi.unstubAllGlobals());

  it("names the last push per politeness, and a coalescing re-push's new id", async () => {
    const api = await mountStore();
    expect(api.announced).toEqual({ polite: null, assertive: null });
    api.push(note({ id: "i1", severity: "info" }));
    api.push(note({ id: "w1", severity: "warning", dedupKey: "k" }));
    expect(api.announced).toEqual({ polite: "i1", assertive: "w1" });
    api.push(note({ id: "w2", severity: "warning", dedupKey: "k" }));
    expect(api.announced).toEqual({ polite: "i1", assertive: "w2" });
    expect(api.toasts.find((t) => t.id === "w2")?.count).toBe(2);
  });

  it("moves a re-push that keeps its id but changes severity out of the other announcer", async () => {
    const api = await mountStore();
    api.push(note({ id: "x", severity: "info", dedupKey: "k" }));
    expect(api.announced).toEqual({ polite: "x", assertive: null });
    api.push(note({ id: "x", severity: "error", dedupKey: "k" }));
    expect(api.announced).toEqual({ polite: null, assertive: "x" });
  });

  it("is not written by a dismissal", async () => {
    const api = await mountStore();
    api.push(note({ id: "i1", severity: "info" }));
    api.dismiss("i1");
    expect(api.announced.polite).toBe("i1");
    expect(api.toasts).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Focus
// ─────────────────────────────────────────────────────────────────────────────

describe("toast focus on close", () => {
  let outside: HTMLButtonElement;

  beforeEach(() => {
    outside = document.createElement("button");
    outside.textContent = "outside";
    document.body.appendChild(outside);
  });

  /** Focus `el` as a keyboard user arriving from `from` would. */
  function focusFrom(el: HTMLElement, from: HTMLElement | null) {
    el.focus();
    el.dispatchEvent(new FocusEvent("focusin", { bubbles: true, relatedTarget: from }));
  }

  it("moves to the next card's Dismiss when the focused card is dismissed", async () => {
    const { rerender } = mount([toast("a"), toast("b"), toast("c")]);
    focusFrom(q("toast-dismiss-a") as HTMLElement, outside);
    await rerender({ toasts: [toast("b"), toast("c")], announced: none });
    expect(document.activeElement).toBe(q("toast-dismiss-b"));
  });

  it("moves to the previous card when the focused card was the last", async () => {
    const { rerender } = mount([toast("a"), toast("b")]);
    focusFrom(q("toast-dismiss-b") as HTMLElement, outside);
    await rerender({ toasts: [toast("a")], announced: none });
    expect(document.activeElement).toBe(q("toast-dismiss-a"));
  });

  it("lands on a surviving card's Dismiss, never its action, so a repeated Enter cannot run it", async () => {
    const { rerender } = mount([
      toast("a"),
      toast("b", { action: { label: "Go", onClick: () => {} } }),
    ]);
    focusFrom(q("toast-dismiss-a") as HTMLElement, outside);
    await rerender({
      toasts: [toast("b", { action: { label: "Go", onClick: () => {} } })],
      announced: none,
    });
    expect(document.activeElement).toBe(q("toast-dismiss-b"));
  });

  it("returns to where focus came from when the last toast closes", async () => {
    const { rerender } = mount([toast("a")]);
    focusFrom(q("toast-dismiss-a") as HTMLElement, outside);
    await rerender({ toasts: [], announced: none });
    expect(q("toast-container")).toBeNull();
    expect(document.activeElement).toBe(outside);
  });

  it("skips a return target that has left the document", async () => {
    const { rerender } = mount([toast("a")]);
    focusFrom(q("toast-dismiss-a") as HTMLElement, outside);
    outside.remove();
    await rerender({ toasts: [], announced: none });
    expect(document.activeElement).not.toBe(outside);
  });

  it("does not record a move between cards as the return target", async () => {
    const { rerender } = mount([toast("a"), toast("b")]);
    focusFrom(q("toast-dismiss-a") as HTMLElement, outside);
    focusFrom(q("toast-dismiss-b") as HTMLElement, q("toast-dismiss-a"));
    await rerender({ toasts: [], announced: none });
    expect(document.activeElement).toBe(outside);
  });

  it("leaves focus alone when the removed card did not hold it", async () => {
    const { rerender } = mount([toast("a"), toast("b")]);
    focusFrom(q("toast-dismiss-b") as HTMLElement, outside);
    await rerender({ toasts: [toast("b")], announced: none });
    expect(document.activeElement).toBe(q("toast-dismiss-b"));
  });

  it("never pulls focus out of something focused elsewhere (a dialog the press opened)", async () => {
    const { rerender } = mount([toast("a")]);
    focusFrom(q("toast-dismiss-a") as HTMLElement, outside);
    const dialogInput = document.createElement("input");
    document.body.appendChild(dialogInput);
    dialogInput.focus();
    await rerender({ toasts: [], announced: none });
    expect(document.activeElement).toBe(dialogInput);
  });

  it("keeps the card and its focus across a coalescing re-push that changes the id", async () => {
    const { rerender } = mount([toast("a1", { dedupKey: "same" })]);
    const card = q("toast-a1");
    focusFrom(q("toast-dismiss-a1") as HTMLElement, outside);
    await rerender({ toasts: [toast("a2", { dedupKey: "same", count: 2 })], announced: none });
    expect(q("toast-a2")).toBe(card);
    expect(document.activeElement).toBe(q("toast-dismiss-a2"));
  });

  it("a real press of the action button moves focus on", async () => {
    const dismiss = vi.fn();
    const action = { label: "Go", onClick: vi.fn() };
    const { rerender } = render(ToastContainer, {
      props: { toasts: [toast("a", { action }), toast("b")], announced: none, onDismiss: dismiss },
    });
    focusFrom(q("toast-action-a") as HTMLElement, outside);
    q("toast-action-a")?.click();
    expect(action.onClick).toHaveBeenCalledOnce();
    expect(dismiss).toHaveBeenCalledWith("a");
    await rerender({ toasts: [toast("b")], announced: none, onDismiss: dismiss });
    expect(document.activeElement).toBe(q("toast-dismiss-b"));
  });
});

describe("toastKey", () => {
  it("keys on the dedupKey when there is one, never colliding with an id", () => {
    expect(toastKey({ id: "x", dedupKey: "x" })).not.toBe(toastKey({ id: "x" }));
    expect(toastKey({ id: "1", dedupKey: "k" })).toBe(toastKey({ id: "2", dedupKey: "k" }));
  });

  it("toastFocusTarget is null when nothing in the stack is focused", () => {
    expect(toastFocusTarget(null, new Set(), null)).toBeNull();
    expect(toastFocusTarget(document.body, new Set(), null)).toBeNull();
  });
});
