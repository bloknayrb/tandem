// @vitest-environment happy-dom

/**
 * ChatPanel's wiring of the pickup row: the reactive clock, the 1 s tick and the
 * auto-scroll guard. `chat-pickup.test.ts` covers the pure derivation; these pin
 * the three effects that feed it, which a pure test cannot reach.
 */
import { render } from "@testing-library/svelte";
import { tick } from "svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import ChatPanel from "../../src/client/panels/ChatPanel.svelte";
import { PICKUP_MAX_AGE_MS } from "../../src/client/panels/chat-pickup";
import type { ChatMessage } from "../../src/shared/types";

const T0 = 1_800_000_000_000;

function user(id: string, at: number, read = false): ChatMessage {
  return { id, author: "user", text: id, timestamp: at, read };
}

function claude(id: string, at: number, extra: Partial<ChatMessage> = {}): ChatMessage {
  return { id, author: "claude", text: id, timestamp: at, read: true, ...extra };
}

/** `visible: "omit"` leaves the prop out entirely — passing `undefined` through a
 * defaulted parameter would silently turn into the default. */
function renderChat(messages: ChatMessage[], visible: boolean | "omit" = true) {
  return render(ChatPanel, {
    props: {
      messages,
      ...(visible === "omit" ? {} : { visible }),
      editor: null,
      activeDocId: null,
      openDocs: [],
      capturedAnchor: null,
      onCapturedAnchorChange: () => {},
      onSend: () => true,
      onClear: async () => {},
      onExport: async () => {},
      onInsert: () => false,
    },
  });
}

function row(container: HTMLElement): HTMLElement | null {
  return container.querySelector("[data-testid='chat-pickup-status']");
}

let scrollSpy: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"] });
  vi.setSystemTime(T0);
  scrollSpy = vi.fn();
  Element.prototype.scrollIntoView = scrollSpy as unknown as Element["scrollIntoView"];
});

afterEach(() => {
  vi.useRealTimers();
});

describe("ChatPanel pickup row — clock", () => {
  it("counts the wait up while visible, then retires the row at the age cap", async () => {
    const { container } = renderChat([user("a", T0)]);
    expect(row(container)?.textContent).toContain("waiting for your AI to pick it up");

    await vi.advanceTimersByTimeAsync(11_000);
    expect(row(container)?.textContent).toContain("· 11 s");

    await vi.advanceTimersByTimeAsync(PICKUP_MAX_AGE_MS);
    expect(row(container)).toBeNull();
  });

  it("does not tick while the panel is hidden", async () => {
    const { container } = renderChat([user("a", T0)], false);
    await vi.advanceTimersByTimeAsync(11_000);
    expect(row(container)?.textContent).not.toContain("11 s");
  });

  it("ticks when visible is never passed (an always-shown mount)", async () => {
    const { container } = renderChat([user("a", T0)], "omit");
    await vi.advanceTimersByTimeAsync(11_000);
    expect(row(container)?.textContent).toContain("· 11 s");
  });

  it("never shows a row for an old unread message arriving while the tick is stopped", async () => {
    // The tick is off with no row, so `now` is the mount time. A message from long
    // after mount but past the cap by the real clock must still read as old.
    const { container, rerender } = renderChat([], true);
    vi.setSystemTime(T0 + 3 * PICKUP_MAX_AGE_MS);
    await rerender({ messages: [user("old", T0 + PICKUP_MAX_AGE_MS)] });
    await tick();
    expect(row(container)).toBeNull();
  });
});

describe("ChatPanel pickup row — auto-scroll", () => {
  // Mounted without `visible`, so the separate scroll-on-show effect stays out of
  // it: `rerender` re-applies props, which re-fires that effect and would scroll
  // regardless of the guard under test.
  it("scrolls when the result clears the row in the same update that adds it", async () => {
    const ack = claude("ack", T0 + 1, { replyTo: "a", inProgress: true });
    const { container, rerender } = renderChat([user("a", T0, true), ack], "omit");
    expect(row(container)?.getAttribute("data-pickup")).toBe("working");
    scrollSpy.mockClear();

    await rerender({
      messages: [user("a", T0, true), ack, claude("res", T0 + 2, { replyTo: "a" })],
    });
    await tick();
    expect(row(container)).toBeNull();
    expect(scrollSpy).toHaveBeenCalled();
  });

  it("does not scroll when the row going away is the only change", async () => {
    const { container } = renderChat([user("a", T0, true)], "omit");
    expect(row(container)?.getAttribute("data-pickup")).toBe("received");
    scrollSpy.mockClear();

    await vi.advanceTimersByTimeAsync(PICKUP_MAX_AGE_MS + 1_000);
    expect(row(container)).toBeNull();
    expect(scrollSpy).not.toHaveBeenCalled();
  });

  it("scrolls when the row changes state", async () => {
    const { rerender } = renderChat([user("a", T0)], "omit");
    scrollSpy.mockClear();
    await rerender({ messages: [user("a", T0, true)] });
    await tick();
    expect(scrollSpy).toHaveBeenCalled();
  });
});
