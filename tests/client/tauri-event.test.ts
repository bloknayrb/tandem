import { describe, expect, it, vi } from "vitest";
import { listenTauriEvent, type TauriEventModule } from "../../src/client/utils/tauri-event";

function fakeModule() {
  let handler: ((event?: { payload?: unknown }) => void) | null = null;
  const unlisten = vi.fn();
  const module: TauriEventModule = {
    listen: async (_event, h) => {
      handler = h;
      return unlisten;
    },
  };
  return { module, fire: (event?: { payload?: unknown }) => handler?.(event), unlisten };
}

describe("listenTauriEvent", () => {
  it("passes the event payload through, and undefined for a payload-free event (#2360)", async () => {
    const fake = fakeModule();
    const onEvent = vi.fn();
    const cleanup = listenTauriEvent({
      loadEvent: async () => fake.module,
      event: "x",
      onEvent,
    });
    // Let the load → listen → store-unlisten chain settle.
    await new Promise((resolve) => setTimeout(resolve, 0));
    fake.fire({ payload: "comment" });
    fake.fire({ payload: null });
    // A fake (or an older caller) may call the handler with no event at all.
    fake.fire();
    expect(onEvent.mock.calls).toEqual([["comment"], [null], [undefined]]);
    cleanup();
    fake.fire({ payload: "chat" });
    expect(onEvent).toHaveBeenCalledTimes(3);
    expect(fake.unlisten).toHaveBeenCalledOnce();
  });
});
