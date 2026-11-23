// @vitest-environment happy-dom

/**
 * Settings → Notifications → Sound (#2168): the chosen sound's description,
 * and the "couldn't load" line a failed preview shows. Only the newest
 * preview's outcome may set or clear that line, because an older preview can
 * resolve later than a newer one (it waited on a slower load).
 */

import { cleanup, fireEvent, render } from "@testing-library/svelte";
import { tick } from "svelte";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadSettings } from "../../src/client/hooks/useTandemSettings";
import type { ChimeStatus } from "../../src/client/notifications/chimes";

const pending: Array<(status: ChimeStatus) => void> = [];
const previewChime = vi.fn(
  () =>
    new Promise<ChimeStatus>((resolve) => {
      pending.push(resolve);
    }),
);
vi.mock(import("../../src/client/notifications/chimes"), async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/client/notifications/chimes")>();
  return { ...actual, previewChime, playChime: vi.fn() };
});

const SettingsNotificationsTab = (
  await import("../../src/client/components/settings-tabs/SettingsNotificationsTab.svelte")
).default;

const ERROR = "Couldn't load this sound.";

function mount() {
  const settings = loadSettings();
  return render(SettingsNotificationsTab, {
    props: {
      open: true,
      settings,
      onUpdate: vi.fn(),
      connected: true,
      reconnectAttempts: 0,
      readOnly: false,
      notify: vi.fn(),
    },
  });
}

async function settle(index: number, status: ChimeStatus): Promise<void> {
  pending[index](status);
  await Promise.resolve();
  await tick();
}

const errorLine = (c: HTMLElement) => c.querySelector("[data-testid='notifications-sound-error']");
/** The screen-reader copy, kept mounted so its text change is announced. */
const announced = (c: HTMLElement) =>
  [...c.querySelectorAll("[role='status']")].some((n) => n.textContent?.includes(ERROR));
const previewButton = (c: HTMLElement) =>
  c.querySelector("[data-testid='notifications-sound-preview']") as HTMLButtonElement;

afterEach(() => {
  cleanup();
  pending.length = 0;
  previewChime.mockClear();
});

describe("SettingsNotificationsTab — sound", () => {
  it("describes the chosen sound under the list", () => {
    const { container } = mount();
    expect(container.querySelector("[data-testid='notifications-sound-hint']")?.textContent).toBe(
      "Vibraphone with a marimba an octave below",
    );
  });

  it("a failed preview shows the error line and announces it", async () => {
    const { container } = mount();
    await fireEvent.click(previewButton(container));
    expect(errorLine(container)).toBeNull();
    await settle(0, "failed");
    expect(errorLine(container)?.textContent).toBe(ERROR);
    expect(errorLine(container)?.getAttribute("aria-hidden")).toBe("true");
    expect(announced(container)).toBe(true);
  });

  it("a timed-out preview shows the error line too", async () => {
    const { container } = mount();
    await fireEvent.click(previewButton(container));
    await settle(0, "timeout");
    expect(errorLine(container)).not.toBeNull();
  });

  it("an older preview that fails after a newer one played does not show the error", async () => {
    const { container } = mount();
    await fireEvent.click(previewButton(container));
    await fireEvent.click(previewButton(container));
    await settle(1, "played");
    await settle(0, "failed");
    expect(errorLine(container)).toBeNull();
    expect(announced(container)).toBe(false);
  });

  it("choosing another sound clears the error", async () => {
    const { container } = mount();
    await fireEvent.click(previewButton(container));
    await settle(0, "failed");
    expect(errorLine(container)).not.toBeNull();
    const select = container.querySelector(
      "[data-testid='notifications-sound-select']",
    ) as HTMLSelectElement;
    select.value = "none";
    await fireEvent.change(select);
    expect(errorLine(container)).toBeNull();
    expect(previewChime).toHaveBeenLastCalledWith("none", 60);
    await settle(1, "skipped");
    expect(errorLine(container)).toBeNull();
  });
});
