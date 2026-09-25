// @vitest-environment happy-dom

/**
 * The server replays its startup notices (src/server/startup-notices.ts) to every
 * notify-stream connection, and EventSource reconnects on its own. A replayed
 * notice keeps its id; the client must ingest it once, not re-toast and bump the
 * tray count on each reconnect. A live push with a fresh id under the same
 * dedupKey must still coalesce as before, so the guard is keyed on id only.
 */

import { render } from "@testing-library/svelte";
import { tick } from "svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { NotificationsState } from "../../src/client/hooks/useNotifications.svelte";
import NotificationsHarness from "../../src/client/svelte-harness/NotificationsHarness.svelte";
import type { TandemNotification } from "../../src/shared/types.js";

class FakeEventSource {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSED = 2;
  static instances: FakeEventSource[] = [];
  readyState = FakeEventSource.OPEN;
  url: string;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  onopen: ((event: Event) => void) | null = null;
  constructor(url: string) {
    this.url = url;
    FakeEventSource.instances.push(this);
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

const STARTUP_NOTICE: TandemNotification = {
  id: "startup-1",
  type: "documents-not-reopened",
  severity: "warning",
  message:
    "Word documents aren't supported in this version of Tandem, so 1 document wasn't reopened: a.docx.",
  dedupKey: "docx-not-reopened",
  timestamp: Date.now(),
};

function deliver(n: TandemNotification) {
  const es = FakeEventSource.instances.at(-1);
  expect(es?.onmessage, "the hook never attached to the stream").toBeTypeOf("function");
  es?.onmessage?.({ data: JSON.stringify(n) } as MessageEvent);
}

async function mount(props: { persist?: boolean; storageKey?: string } = {}) {
  let state: NotificationsState | null = null;
  const view = render(NotificationsHarness, {
    props: {
      ...props,
      onReady: (s: NotificationsState) => {
        state = s;
      },
    },
  });
  await tick();
  expect(state).not.toBeNull();
  return { api: state as unknown as NotificationsState, view };
}

describe("startup notice replay on reconnect", () => {
  beforeEach(() => {
    FakeEventSource.instances = [];
    vi.stubGlobal("EventSource", FakeEventSource);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    localStorage.clear();
  });

  it("ingests a replayed notice once, and a fresh id on the same dedupKey still counts", async () => {
    const { api } = await mount();

    deliver(STARTUP_NOTICE);
    deliver(STARTUP_NOTICE);
    deliver(STARTUP_NOTICE);
    await tick();
    expect(api.toasts).toHaveLength(1);
    expect(api.toasts[0].count).toBe(1);
    expect(api.activity).toHaveLength(1);
    expect(api.activity[0].count).toBe(1);

    // Negative control: the guard is on id, not dedupKey.
    deliver({ ...STARTUP_NOTICE, id: "live-2" });
    await tick();
    expect(api.activity[0].count).toBe(2);
  });

  it("does not re-add a notice the persisted tray already holds after a reload", async () => {
    const storageKey = "tandem-test-notification-replay";
    const first = await mount({ persist: true, storageKey });
    deliver(STARTUP_NOTICE);
    await tick();
    expect(first.api.activity).toHaveLength(1);
    first.view.unmount(); // flushes the debounced save

    const second = await mount({ persist: true, storageKey });
    expect(second.api.activity).toHaveLength(1);
    deliver(STARTUP_NOTICE);
    await tick();
    expect(second.api.toasts).toHaveLength(0);
    expect(second.api.activity[0].count).toBe(1);
  });
});
