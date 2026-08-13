// @vitest-environment happy-dom

/**
 * The start-at-login checkbox, actually rendered.
 *
 * `useAutostart.svelte.test.ts` covers the hook — that a virtualized or blocked
 * write leaves `status.enabled` where it was and reports why. What it cannot
 * cover is the consequence at the DOM: `checked={autostartStatus.enabled}` is
 * one-way, and Svelte skips the write whenever the expression re-computes to
 * the value it last wrote. So the honest status the hook works hard to produce
 * is exactly the case where the CONTROL lies — the box keeps the position the
 * user's click gave it, over a setting that never moved, with only an error
 * line beneath it to disagree.
 *
 * This is the same defect measured on Cowork's two toggles (#1375); the third
 * instance lived here and was found by reviewing that fix. See
 * `src/client/utils/checkbox-sync.ts`.
 */

import { render, waitFor } from "@testing-library/svelte";
import { tick } from "svelte";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { TandemSettings } from "../../src/client/hooks/useTandemSettings.svelte";
import type { AutostartStatus } from "../../src/client/tauri/autostart-invoke";

/** What the OS reports. Mutated per-test; the mocked hook reads it live. */
let osStatus: AutostartStatus = { enabled: false, trayAvailable: true, error: null };
let toggleError: string | null = null;

const toggle = vi.fn(async (_next: boolean) => {
  // The shape that matters: a write the OS refused or virtualized away leaves
  // `status` untouched. `next` is deliberately ignored.
});

vi.mock("../../src/client/hooks/useAutostart.svelte.js", () => ({
  createAutostart: () => ({
    get status() {
      return osStatus;
    },
    get error() {
      return toggleError;
    },
    loading: false,
    toggle,
  }),
}));

vi.mock("../../src/client/cowork/cowork-helpers.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/client/cowork/cowork-helpers")>()),
  isTauriRuntime: () => true,
}));

vi.mock("../../src/client/hooks/useAppInfo.svelte.js", () => ({
  createAppInfo: () => ({ info: null, loading: false, error: null }),
}));

import NetworkSettings from "../../src/client/components/NetworkSettings.svelte";

function mount() {
  const { container } = render(NetworkSettings, {
    props: {
      open: true,
      settings: {
        degradedBannerDelayMs: 30000,
        sidecarRetryStrategy: "exponential",
      } as TandemSettings,
      onUpdate: vi.fn(),
      connected: true,
      reconnectAttempts: 0,
      readOnly: false,
      notify: vi.fn(),
    },
  });
  const box = container.querySelector<HTMLInputElement>(
    "[data-testid='network-autostart-toggle']",
  ) as HTMLInputElement;
  return { container, box };
}

async function clickToggle(box: HTMLInputElement, checked: boolean): Promise<void> {
  box.checked = checked;
  box.dispatchEvent(new Event("change", { bubbles: true }));
  await tick();
}

describe("NetworkSettings — start-at-login toggle", () => {
  beforeEach(() => {
    osStatus = { enabled: false, trayAvailable: true, error: null };
    toggleError = null;
    toggle.mockClear();
  });

  it("puts the box back when the OS did not take the write", async () => {
    const { box } = mount();
    await tick();
    expect(box.checked).toBe(false);

    await clickToggle(box, true);

    expect(toggle).toHaveBeenCalledWith(true);
    // `osStatus.enabled` never moved, so the expression re-computes to `false`
    // — the value Svelte last wrote — and the DOM write is skipped. Without an
    // explicit resync the box stays checked over a login item that does not
    // exist.
    await waitFor(() => expect(box.checked).toBe(false), { interval: 5 });
  });

  it("leaves the box on when the OS confirms the write", async () => {
    const { box } = mount();
    await tick();

    toggle.mockImplementationOnce(async () => {
      osStatus = { ...osStatus, enabled: true };
    });
    await clickToggle(box, true);

    await waitFor(() => expect(box.checked).toBe(true), { interval: 5 });
  });

  it("puts the box back when un-checking fails too", async () => {
    // The disable half, which on Cowork was the one that produced an
    // unrecoverable control.
    osStatus = { enabled: true, trayAvailable: true, error: null };
    const { box } = mount();
    await tick();
    expect(box.checked).toBe(true);

    await clickToggle(box, false);

    expect(toggle).toHaveBeenCalledWith(false);
    await waitFor(() => expect(box.checked).toBe(true), { interval: 5 });
  });
});
