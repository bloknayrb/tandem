// @vitest-environment happy-dom

import { render } from "@testing-library/svelte";
import { tick } from "svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../src/client/cowork/cowork-helpers.js", () => ({
  isTauriRuntime: vi.fn(() => false),
}));

const mockWin = {
  isMaximized: vi.fn().mockResolvedValue(false),
  onResized: vi.fn().mockResolvedValue(vi.fn()),
  onMoved: vi.fn().mockResolvedValue(vi.fn()),
  minimize: vi.fn().mockResolvedValue(undefined),
  toggleMaximize: vi.fn().mockResolvedValue(undefined),
  close: vi.fn().mockResolvedValue(undefined),
};

vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: vi.fn(() => mockWin),
}));

import { getCurrentWindow } from "@tauri-apps/api/window";
import * as coworkHelpers from "../../src/client/cowork/cowork-helpers.js";
import TitleBar from "../../src/client/shell/TitleBar.svelte";

beforeEach(() => {
  vi.clearAllMocks();
  mockWin.isMaximized.mockResolvedValue(false);
  mockWin.onResized.mockResolvedValue(vi.fn());
  mockWin.onMoved.mockResolvedValue(vi.fn());
  vi.mocked(getCurrentWindow).mockReturnValue(
    mockWin as Parameters<typeof getCurrentWindow>[never],
  );
});

afterEach(() => {
  vi.mocked(coworkHelpers.isTauriRuntime).mockReturnValue(false);
});

describe("TitleBar", () => {
  it("renders nothing in browser mode", () => {
    vi.mocked(coworkHelpers.isTauriRuntime).mockReturnValue(false);
    const { container } = render(TitleBar, { props: { title: "test.md" } });
    expect(container.querySelector(".title-bar")).toBeNull();
    expect(container.querySelectorAll("button")).toHaveLength(0);
  });

  it("renders title bar with three controls in Tauri mode", async () => {
    vi.mocked(coworkHelpers.isTauriRuntime).mockReturnValue(true);
    const { container } = render(TitleBar, { props: { title: "test.md" } });
    await tick();

    const btns = container.querySelectorAll("button");
    expect(btns).toHaveLength(3);
    expect(btns[0].getAttribute("aria-label")).toBe("Minimize");
    expect(btns[1].getAttribute("aria-label")).toBe("Maximize");
    expect(btns[2].getAttribute("aria-label")).toBe("Close");
  });

  it("displays provided title in Tauri mode", async () => {
    vi.mocked(coworkHelpers.isTauriRuntime).mockReturnValue(true);
    const { container } = render(TitleBar, { props: { title: "my-doc.md" } });
    await tick();

    expect(container.querySelector(".title-bar-title")?.textContent).toBe("my-doc.md");
  });

  it("falls back to 'Tandem' when no title provided", async () => {
    vi.mocked(coworkHelpers.isTauriRuntime).mockReturnValue(true);
    const { container } = render(TitleBar);
    await tick();

    expect(container.querySelector(".title-bar-title")?.textContent).toBe("Tandem");
  });

  it("minimize button calls window.minimize()", async () => {
    vi.mocked(coworkHelpers.isTauriRuntime).mockReturnValue(true);
    const { container } = render(TitleBar, { props: { title: "test.md" } });
    await tick();

    const minimizeBtn = container.querySelector<HTMLButtonElement>("[aria-label='Minimize']");
    minimizeBtn?.click();
    await tick();

    expect(mockWin.minimize).toHaveBeenCalledOnce();
  });

  it("close button calls window.close()", async () => {
    vi.mocked(coworkHelpers.isTauriRuntime).mockReturnValue(true);
    const { container } = render(TitleBar, { props: { title: "test.md" } });
    await tick();

    const closeBtn = container.querySelector<HTMLButtonElement>("[aria-label='Close']");
    closeBtn?.click();
    await tick();

    expect(mockWin.close).toHaveBeenCalledOnce();
  });

  it("maximize button calls window.toggleMaximize()", async () => {
    vi.mocked(coworkHelpers.isTauriRuntime).mockReturnValue(true);
    const { container } = render(TitleBar, { props: { title: "test.md" } });
    await tick();

    const maximizeBtn = container.querySelector<HTMLButtonElement>("[aria-label='Maximize']");
    maximizeBtn?.click();
    await tick();

    expect(mockWin.toggleMaximize).toHaveBeenCalledOnce();
  });

  it("shows Restore label when isMaximized is true", async () => {
    vi.mocked(coworkHelpers.isTauriRuntime).mockReturnValue(true);
    mockWin.isMaximized.mockResolvedValue(true);
    const { container } = render(TitleBar, { props: { title: "test.md" } });
    // Wait for onMount async to complete
    await new Promise((r) => setTimeout(r, 0));
    await tick();

    expect(container.querySelector("[aria-label='Restore']")).toBeTruthy();
  });
});
