/**
 * Coverage for `createAutostart` and the start-at-login invoke wrappers (#1236).
 *
 * The contract that matters here is honesty: the toggle must reflect what the
 * OS actually holds, never what the user asked for. A silently-virtualized
 * write (MSIX/Store packages can't write HKCU Run conventionally) or a blocked
 * one has to leave the switch where it was and say so.
 */

import { flushSync } from "svelte";
import { describe, expect, it, vi } from "vitest";

import { createAutostart } from "../../src/client/hooks/useAutostart.svelte.js";
import {
  type AutostartStatus,
  autostartErrorMessage,
  autostartGetStatus,
  autostartSetEnabled,
  type InvokeFn,
} from "../../src/client/tauri/autostart-invoke.js";

vi.mock("../../src/client/cowork/cowork-invoke", async () => {
  const actual = await vi.importActual<typeof import("../../src/client/cowork/cowork-invoke")>(
    "../../src/client/cowork/cowork-invoke",
  );
  return { ...actual, loadInvoke: async () => currentInvoke };
});

/** Swapped per-test; the mocked `loadInvoke` closes over this. */
let currentInvoke: InvokeFn = () => Promise.reject(new Error("no stub"));

function ok(overrides: Partial<AutostartStatus> = {}): AutostartStatus {
  return { enabled: false, trayAvailable: true, error: null, ...overrides };
}

/** Drain the microtask queue so the hook's async load/toggle settles. */
async function settle(): Promise<void> {
  for (let i = 0; i < 8; i++) await Promise.resolve();
  flushSync();
}

describe("autostart invoke wrappers", () => {
  it("calls the app-defined commands, not the plugin's JS API", async () => {
    const calls: Array<[string, Record<string, unknown> | undefined]> = [];
    const invoke = (async (cmd: string, args?: Record<string, unknown>) => {
      calls.push([cmd, args]);
      return ok();
    }) as InvokeFn;

    await autostartGetStatus(invoke);
    await autostartSetEnabled(invoke, true);

    expect(calls).toEqual([
      ["autostart_get_status", undefined],
      ["autostart_set_enabled", { enabled: true }],
    ]);
    // If these were the plugin's own commands the capability grant would be
    // required; assert we never reach for them.
    expect(calls.map(([c]) => c)).not.toContain("plugin:autostart|enable");
  });

  it("maps every redacted code to a message that leaks no path", () => {
    for (const code of ["io-error", "readback-mismatch", "plugin-error"] as const) {
      const msg = autostartErrorMessage(code);
      expect(msg.length).toBeGreaterThan(0);
      expect(msg).not.toMatch(/[/\\]/);
    }
  });
});

describe("createAutostart", () => {
  it("loads OS state once the panel opens, and not before", async () => {
    let loads = 0;
    currentInvoke = (async (cmd: string) => {
      if (cmd === "autostart_get_status") loads += 1;
      return ok({ enabled: true });
    }) as InvokeFn;

    let active = $state(false);
    const cleanup = $effect.root(() => {
      const a = createAutostart(() => active);
      flushSync();
      expect(loads).toBe(0);
      expect(a.status).toBeNull();

      active = true;
      flushSync();
      return a;
    });
    await settle();
    expect(loads).toBe(1);
    cleanup();
  });

  it("reports the read-back value, not the requested one", async () => {
    // The OS refused the write: `enabled` comes back false even though `true`
    // was requested. The toggle must not show `true`.
    currentInvoke = (async (cmd: string) => {
      if (cmd === "autostart_set_enabled") {
        return ok({ enabled: false, error: "readback-mismatch" });
      }
      return ok();
    }) as InvokeFn;

    let handle!: ReturnType<typeof createAutostart>;
    const cleanup = $effect.root(() => {
      handle = createAutostart(() => true);
    });
    await settle();

    await handle.toggle(true);
    await settle();

    expect(handle.status?.enabled).toBe(false);
    expect(handle.error).toBe(autostartErrorMessage("readback-mismatch"));
    cleanup();
  });

  it("surfaces a successful enable with no error", async () => {
    currentInvoke = (async (cmd: string) =>
      cmd === "autostart_set_enabled" ? ok({ enabled: true }) : ok()) as InvokeFn;

    let handle!: ReturnType<typeof createAutostart>;
    const cleanup = $effect.root(() => {
      handle = createAutostart(() => true);
    });
    await settle();

    await handle.toggle(true);
    await settle();

    expect(handle.status?.enabled).toBe(true);
    expect(handle.error).toBeNull();
    cleanup();
  });

  it("leaves status null when the command is unreachable", async () => {
    // Non-Tauri build, or a shell predating the command. The caller renders
    // nothing rather than a control that cannot work.
    currentInvoke = (() => Promise.reject(new Error("Tauri runtime not available"))) as InvokeFn;

    let handle!: ReturnType<typeof createAutostart>;
    const cleanup = $effect.root(() => {
      handle = createAutostart(() => true);
    });
    await settle();

    expect(handle.status).toBeNull();
    expect(handle.error).toBeNull();
    expect(handle.loading).toBe(false);
    cleanup();
  });

  it("passes the tray-unavailable signal through so the UI can disable itself", async () => {
    currentInvoke = (async () => ok({ trayAvailable: false })) as InvokeFn;

    let handle!: ReturnType<typeof createAutostart>;
    const cleanup = $effect.root(() => {
      handle = createAutostart(() => true);
    });
    await settle();

    expect(handle.status?.trayAvailable).toBe(false);
    cleanup();
  });
});
