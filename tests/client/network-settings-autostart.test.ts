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
 *
 * The status lives in a `$state` cell rather than a module `let` — the first
 * version of this file used a `let` and it made a test pass that could not
 * fail. See `../helpers/autostart-status-cell.svelte`.
 */

import { cleanup, render, waitFor } from "@testing-library/svelte";
import { tick } from "svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { TandemSettings } from "../../src/client/hooks/useTandemSettings.svelte";
import { autostartStatusCell } from "../helpers/autostart-status-cell.svelte";

let toggleError: string | null = null;

/**
 * The OS write. Default: it fails to commit — the write is refused or
 * virtualized away, so `status` is left exactly as it was. That is the shape
 * `resyncCheckbox` exists for, and making it the default keeps each test's
 * setup to the ONE thing it varies.
 */
const toggle = vi.fn(async (_next: boolean) => {});

vi.mock("../../src/client/hooks/useAutostart.svelte.js", () => ({
  createAutostart: () => ({
    get status() {
      return autostartStatusCell.value;
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

/** Move the box the way a user does: mutate `.checked`, then fire `change`. */
async function clickToggle(box: HTMLInputElement, checked: boolean): Promise<void> {
  box.checked = checked;
  box.dispatchEvent(new Event("change", { bubbles: true }));
  await tick();
}

// FILE scope. `autostartStatusCell` is module state, and without an explicit
// `cleanup()` Testing Library's auto-cleanup never registers here (it hooks
// `afterEach` only under `globals: true`, which this project does not set), so
// mounts would otherwise accumulate across the file.
beforeEach(() => {
  autostartStatusCell.reset();
  toggleError = null;
  toggle.mockReset();
  toggle.mockImplementation(async () => {});
});

afterEach(() => {
  cleanup();
});

describe("NetworkSettings — start-at-login toggle", () => {
  it("follows the OS when the status changes with no click at all", async () => {
    // The binding must be live. Every other test here reads `box.checked` after
    // a click, and a click sets `.checked` by itself — so if the mocked status
    // were inert (a plain module `let`, which is what this file used to do)
    // those assertions would pass with the production resync deleted. This is
    // the one test that can only pass if Svelte's own write is running, and it
    // is the reason the others mean anything. The real hook does exactly this
    // on a Settings reopen.
    const { box } = mount();
    await tick();
    expect(box.checked).toBe(false);

    autostartStatusCell.patch({ enabled: true });

    await waitFor(() => expect(box.checked).toBe(true), { interval: 5 });
  });

  it("puts the box back when the OS did not take the write", async () => {
    const { box } = mount();
    await tick();
    expect(box.checked).toBe(false);

    await clickToggle(box, true);

    expect(toggle).toHaveBeenCalledWith(true);
    // `enabled` never moved, so the expression re-computes to `false` — the
    // value Svelte last wrote — and the DOM write is skipped. Without an
    // explicit resync the box stays checked over a login item that does not
    // exist.
    await waitFor(() => expect(box.checked).toBe(false), { interval: 5 });
  });

  it("puts the box back when un-checking fails too", async () => {
    // The disable half, which on Cowork was the one that produced an
    // unrecoverable control.
    autostartStatusCell.patch({ enabled: true });
    const { box } = mount();
    await tick();
    expect(box.checked).toBe(true);

    await clickToggle(box, false);

    expect(toggle).toHaveBeenCalledWith(false);
    await waitFor(() => expect(box.checked).toBe(true), { interval: 5 });
  });

  it("leaves the box on when the OS confirms the write", async () => {
    const { box } = mount();
    await tick();

    // Deferred rather than resolving inline: with a mock that settles in the
    // same microtask, dropping the `await` in `toggleAutostart` still passes.
    // The gap is what makes the resync's ORDERING observable.
    let release!: () => void;
    const committed = new Promise<void>((r) => {
      release = r;
    });
    toggle.mockImplementationOnce(async () => {
      await committed;
      autostartStatusCell.patch({ enabled: true });
    });

    await clickToggle(box, true);
    // Ordering, not timing: while the write is still in flight the resync must
    // not have run. Drop the `await` in `toggleAutostart` and it runs here
    // instead, reading the PRE-write status and snapping the box back to
    // `false` under the user before the commit lands. The deferred promise is
    // what makes that deterministic rather than a race.
    expect(box.checked).toBe(true);

    release();

    await waitFor(() => expect(box.checked).toBe(true), { interval: 5 });
    // And it stays on: the resync must not read the pre-write status and undo
    // a commit that succeeded.
    await tick();
    expect(box.checked).toBe(true);
  });
});
