// @vitest-environment happy-dom

/**
 * Regression test for #631 / PR #664: confirms that `notifications.push`
 * collapses repeated `sidecar-restart-failed` events via `dedupKey` (not via `id`).
 *
 * The dedup contract lives in `createNotifications.ingest`:
 *   - If incoming has a `dedupKey` matching an existing toast, replace the
 *     existing toast in place and bump `count`. Different `id` values on the
 *     incoming notifications must NOT defeat dedup.
 *   - If incoming has no `dedupKey` or a `dedupKey` not matching any visible
 *     toast, append a new toast.
 */

import { render } from "@testing-library/svelte";
import { tick } from "svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { NotificationsState } from "../../src/client/hooks/useNotifications.svelte";
import NotificationsHarness from "../../src/client/svelte-harness/NotificationsHarness.svelte";
import type { TandemNotification } from "../../src/shared/types.js";

// Minimal EventSource stub: happy-dom does not implement EventSource, and we
// don't want the hook to attempt a real network connection during the test.
class FakeEventSource {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSED = 2;
  readyState = FakeEventSource.OPEN;
  url: string;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  onopen: ((event: Event) => void) | null = null;
  constructor(url: string) {
    this.url = url;
  }
  close() {
    this.readyState = FakeEventSource.CLOSED;
  }
  addEventListener() {}
  removeEventListener() {}
  dispatchEvent() {
    return true;
  }
}

function makeNotification(overrides: Partial<TandemNotification> = {}): TandemNotification {
  return {
    id: "id-default",
    type: "general-error",
    severity: "error",
    message: "Sidecar failed to restart — see logs",
    timestamp: Date.now(),
    ...overrides,
  };
}

describe("createNotifications dedup", () => {
  let state: NotificationsState | null = null;

  beforeEach(() => {
    vi.stubGlobal("EventSource", FakeEventSource);
    state = null;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    state = null;
  });

  it("collapses 5 rapid sidecar-restart-failed pushes with same dedupKey but different ids into one toast", async () => {
    const { container } = render(NotificationsHarness, {
      props: {
        onReady: (s: NotificationsState) => {
          state = s;
        },
      },
    });
    await tick();
    expect(state).not.toBeNull();
    const api = state as NotificationsState;

    for (let i = 0; i < 5; i++) {
      api.push(
        makeNotification({
          id: `sidecar-restart-failed-${i}`,
          dedupKey: "sidecar-restart-failed",
        }),
      );
    }
    await tick();

    const toasts = container.querySelectorAll("[data-testid='toast']");
    expect(toasts).toHaveLength(1);
    // The visible toast should record that it was hit 5 times.
    expect(toasts[0].getAttribute("data-count")).toBe("5");
    expect(toasts[0].getAttribute("data-dedup-key")).toBe("sidecar-restart-failed");

    // The hook's `toasts` getter agrees with the rendered DOM.
    expect(api.toasts).toHaveLength(1);
    expect(api.toasts[0].count).toBe(5);
    expect(api.toasts[0].dedupKey).toBe("sidecar-restart-failed");
  });

  it("does not dedup notifications with different dedupKey values", async () => {
    const { container } = render(NotificationsHarness, {
      props: {
        onReady: (s: NotificationsState) => {
          state = s;
        },
      },
    });
    await tick();
    const api = state as NotificationsState;

    api.push(makeNotification({ id: "a-1", dedupKey: "key-a", message: "First (key-a)" }));
    api.push(makeNotification({ id: "b-1", dedupKey: "key-b", message: "Second (key-b)" }));
    api.push(makeNotification({ id: "c-1", dedupKey: "key-c", message: "Third (key-c)" }));
    await tick();

    const toasts = container.querySelectorAll("[data-testid='toast']");
    expect(toasts).toHaveLength(3);
    const dedupKeys = Array.from(toasts).map((t) => t.getAttribute("data-dedup-key"));
    expect(dedupKeys).toEqual(["key-a", "key-b", "key-c"]);
    for (const t of toasts) {
      expect(t.getAttribute("data-count")).toBe("1");
    }
  });
});
