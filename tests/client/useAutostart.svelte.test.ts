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

import {
  autostartWizardDefault,
  createAutostart,
  readAutostartDecided,
  writeAutostartDecided,
} from "../../src/client/hooks/useAutostart.svelte.js";
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

/**
 * The "has the user chosen?" marker (#1463).
 *
 * The wizard defaults start-at-login ON, and the OS cannot tell it whether a
 * `false` means "never set up" or "deliberately turned off" — both read as
 * `enabled: false`. This marker is the only thing separating a default from an
 * override, so its failure mode is not cosmetic: lose it and re-running setup
 * silently switches autostart back on for someone who turned it off.
 */
describe("autostart decision marker", () => {
  it("reads false before any choice and true after one", async () => {
    localStorage.clear();
    expect(readAutostartDecided()).toBe(false);

    currentInvoke = (async () => ok({ enabled: true })) as InvokeFn;
    let handle!: ReturnType<typeof createAutostart>;
    const cleanup = $effect.root(() => {
      handle = createAutostart(() => true);
    });
    await settle();
    await handle.toggle(true);
    await settle();

    expect(readAutostartDecided()).toBe(true);
    cleanup();
  });

  it("records the choice even when the OS write fails", async () => {
    localStorage.clear();
    currentInvoke = (() => Promise.reject(new Error("plugin-error"))) as InvokeFn;

    let handle!: ReturnType<typeof createAutostart>;
    const cleanup = $effect.root(() => {
      handle = createAutostart(() => true);
    });
    await settle();
    await handle.toggle(true);
    await settle();

    // The user expressed a preference; a failed write is not a licence for the
    // wizard to come back later and decide for them.
    expect(readAutostartDecided()).toBe(true);
    cleanup();
  });

  it("records a deliberate OFF, which is the case the wizard must not override", async () => {
    localStorage.clear();
    currentInvoke = (async () => ok({ enabled: false })) as InvokeFn;

    let handle!: ReturnType<typeof createAutostart>;
    const cleanup = $effect.root(() => {
      handle = createAutostart(() => true);
    });
    await settle();
    await handle.toggle(false);
    await settle();

    expect(readAutostartDecided()).toBe(true);
    cleanup();
  });

  it("degrades to 'not decided' when storage throws, rather than crashing", () => {
    // Spy on the instance, not `Storage.prototype`: this environment exposes the
    // methods as own properties, so a prototype spy silently never binds and the
    // test passes for the wrong reason (it did, on the first cut of this test —
    // reading a value a previous case had left behind).
    localStorage.setItem("tandem:autostart-decided", "true");
    const spy = vi.spyOn(localStorage, "getItem").mockImplementation(() => {
      throw new Error("storage disabled");
    });
    const setSpy = vi.spyOn(localStorage, "setItem").mockImplementation(() => {
      throw new Error("storage disabled");
    });

    expect(readAutostartDecided()).toBe(false);
    expect(() => writeAutostartDecided()).not.toThrow();

    spy.mockRestore();
    setSpy.mockRestore();
  });
});

/**
 * The wizard's default-on decision (#1463).
 *
 * Pure, so the invariant is executable rather than a comment inside a
 * 2000-line modal: the wizard defaults start-at-login ON, and must never
 * override a choice the user already made. The OS cannot distinguish "never
 * set up" from "deliberately turned off", so every case below turns on what
 * `alreadyDecided` carries.
 */
describe("autostartWizardDefault", () => {
  const off = ok({ enabled: false });
  const on = ok({ enabled: true });

  it("enables for a user who has never chosen", () => {
    expect(autostartWizardDefault(off, false)).toEqual({ enable: true, record: false });
  });

  it("does NOT re-enable after a deliberate OFF", () => {
    // The case this whole mechanism exists for: identical OS state to the one
    // above, opposite outcome, and only the marker separates them.
    expect(autostartWizardDefault(off, true)).toEqual({ enable: false, record: false });
  });

  it("records — without writing to the OS — when it is already on", () => {
    // Non-obvious arm. Doing nothing here leaves the question unrecorded, so a
    // user who later removes the registration outside Tandem and re-runs the
    // wizard reads as never-decided and gets it switched back on.
    expect(autostartWizardDefault(on, false)).toEqual({ enable: false, record: true });
  });

  it("stays quiet once already on AND already decided", () => {
    expect(autostartWizardDefault(on, true)).toEqual({ enable: false, record: false });
  });

  it("decides nothing before status has loaded", () => {
    // Recording here would settle the question on a value we do not have.
    expect(autostartWizardDefault(null, false)).toEqual({ enable: false, record: false });
  });

  it("neither enables nor records when there is no tray", () => {
    // Not a declined choice — one we cannot offer. Registering a hidden startup
    // with no tray leaves no way to reach the app, and recording it would
    // permanently suppress the default on a machine that later grows a tray.
    expect(autostartWizardDefault(ok({ trayAvailable: false }), false)).toEqual({
      enable: false,
      record: false,
    });
    expect(autostartWizardDefault(ok({ trayAvailable: false, enabled: true }), false)).toEqual({
      enable: false,
      record: false,
    });
  });

  it("never asks for both at once, in any reachable combination", () => {
    // `record` exists for the arm that does NOT enable; on the enabling arm
    // `toggle()` writes the marker itself, so both together would double-write
    // and, more importantly, would mean two mechanisms owned the same fact.
    for (const status of [null, off, on, ok({ trayAvailable: false })]) {
      for (const decided of [true, false]) {
        const d = autostartWizardDefault(status, decided);
        expect(d.enable && d.record).toBe(false);
      }
    }
  });
});
