// @vitest-environment happy-dom

import { render } from "@testing-library/svelte";
import { tick } from "svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mocks must be declared before importing the component under test.
vi.mock("@client/cowork/cowork-helpers.js", () => ({
  isTauriRuntime: () => true,
}));
vi.mock("@client/cowork/cowork-helpers", () => ({
  isTauriRuntime: () => true,
}));

let resolveOnResized: ((unlisten: () => void) => void) | null = null;
let unlistenResizeSpy = vi.fn();
let unlistenMoveSpy = vi.fn();

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({
    isMaximized: vi.fn().mockResolvedValue(false),
    onResized: vi.fn(
      () =>
        new Promise<() => void>((resolve) => {
          resolveOnResized = (unlisten) => resolve(unlisten);
        }),
    ),
    onMoved: vi.fn(() => Promise.resolve(unlistenMoveSpy)),
  }),
}));

// Import after mocks.
const { default: TitleBar } = await import("../../src/client/shell/TitleBar.svelte");

async function flush() {
  for (let i = 0; i < 10; i++) {
    await Promise.resolve();
    await tick();
  }
}

describe("TitleBar async listener cleanup", () => {
  beforeEach(() => {
    resolveOnResized = null;
    unlistenResizeSpy = vi.fn();
    unlistenMoveSpy = vi.fn();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("unlistens onResized when component unmounts before the promise resolves", async () => {
    const { unmount } = render(TitleBar, { props: {} });

    // Yield enough microtasks for onMount's two dynamic imports and the
    // setup_overlay_titlebar + isMaximized awaits to settle, leaving us
    // paused on the hung onResized await.
    await flush();
    expect(resolveOnResized).not.toBeNull();

    // Destroy the component while onMount is still mid-await.
    unmount();
    await flush();

    // Resolve the hung onResized promise. The post-await branch in
    // onMount must detect !mounted and self-clean by calling unlisten.
    resolveOnResized?.(unlistenResizeSpy);
    await flush();

    expect(unlistenResizeSpy).toHaveBeenCalledTimes(1);
  });
});
