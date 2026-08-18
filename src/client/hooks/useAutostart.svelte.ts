import {
  type AutostartStatus,
  autostartErrorMessage,
  autostartGetStatus,
  autostartSetEnabled,
  loadInvoke,
} from "../tauri/autostart-invoke.js";

const AUTOSTART_DECIDED_KEY = "tandem:autostart-decided";

/**
 * Has the user already expressed a preference about start-at-login?
 *
 * Needed because the OS cannot answer it. `autostartGetStatus` reports
 * `enabled: false` identically for "never set up" and "deliberately turned
 * off", and the wizard's default-on behaviour (#1463) must act on the first
 * but never on the second — re-enabling something the user switched off is
 * exactly the override this flag exists to prevent.
 *
 * This is NOT the mirrored boolean the module comment below forbids. It never
 * says whether autostart is on; it records only that Tandem has asked or been
 * told once, which is monotonic and cannot drift when the registration is
 * changed outside Tandem. The OS remains the sole authority on the state
 * itself.
 *
 * localStorage, matching `cowork-helpers.ts`'s skip flag, with try/catch
 * because a storage-disabled context throws. Failure is read as "not decided",
 * so the worst case is one extra default-on — the pre-v1 behaviour — rather
 * than a crash or a silently skipped setup step.
 */
export function readAutostartDecided(): boolean {
  try {
    return localStorage.getItem(AUTOSTART_DECIDED_KEY) === "true";
  } catch {
    return false;
  }
}

export function writeAutostartDecided(): void {
  try {
    localStorage.setItem(AUTOSTART_DECIDED_KEY, "true");
  } catch {
    // Storage unavailable — the wizard may default it on once more next time.
  }
}

export interface AutostartState {
  /** Live OS state. `null` until the first load resolves. */
  readonly status: AutostartStatus | null;
  readonly loading: boolean;
  /** Human-readable message derived from the redacted error code. */
  readonly error: string | null;
  toggle: (next: boolean) => Promise<void>;
}

/**
 * Start-at-login state for the Settings → Network toggle (#1236).
 *
 * Deliberately NOT backed by `tandem:settings`. The registration is an OS
 * artifact the user can change outside Tandem — Task Manager → Startup, System
 * Settings → Login Items, `~/.config/autostart` — so a mirrored boolean in the
 * settings schema would silently drift from reality and there would be no
 * moment at which to reconcile it. Reading the OS on every Settings open is
 * cheap and always right.
 *
 * Consequence, and it is intentional: `CURRENT_SCHEMA_VERSION` does not move,
 * there is no migration, and `TandemSettings` gains no field. Don't "fix" that.
 *
 * Loads lazily, gated on a getter so `open` propagates reactively (same shape
 * as `createAppInfo(() => open)` in NetworkSettings).
 */
export function createAutostart(getActive: () => boolean): AutostartState {
  let status = $state<AutostartStatus | null>(null);
  let loading = $state(false);
  let error = $state<string | null>(null);

  function applyResult(next: AutostartStatus): void {
    status = next;
    error = next.error ? autostartErrorMessage(next.error) : null;
  }

  async function load(): Promise<void> {
    loading = true;
    try {
      // `loadInvoke` is a dynamic `import()`, so the ESM module cache already
      // makes every call after the first a resolved-module lookup — memoizing
      // it here would save nothing.
      applyResult(await autostartGetStatus(await loadInvoke()));
    } catch {
      // A rejected invoke means the command isn't reachable (non-Tauri build,
      // or a shell that predates the command). Leave `status` null so the
      // caller renders nothing rather than a control that can't work.
      status = null;
      error = null;
    } finally {
      loading = false;
    }
  }

  // No once-guard: `NetworkSettings` is mounted under `{#if open}` + `{#key
  // activeTab.id}`, so this hook is constructed fresh per Settings open and
  // `getActive()` stays true for the component's whole life — the body can only
  // run once as written. A latch would be dead today AND would break the
  // documented contract ("read the OS on every Settings open") if the modal ever
  // became persistently mounted.
  $effect(() => {
    if (getActive()) void load();
  });

  const toggle = async (next: boolean): Promise<void> => {
    loading = true;
    error = null;
    // Recorded before the write, and regardless of whether it succeeds: the
    // user has expressed a preference either way, and a failed write is not a
    // licence for the wizard to come back and decide for them later.
    writeAutostartDecided();
    try {
      // The result carries the OS's read-back value, not `next` — so a write
      // that was virtualized away or blocked reports `readback-mismatch`
      // instead of lying about the STATUS.
      //
      // It does not, on its own, put the checkbox back: `status.enabled` is
      // unchanged, so the one-way `checked=` expression re-computes to the
      // value Svelte last wrote and the DOM write is skipped, leaving the box
      // where the user clicked. `NetworkSettings.svelte` calls `resyncCheckbox`
      // after this for that reason. (An earlier version of this comment claimed
      // the toggle stayed put by itself. It does not.)
      applyResult(await autostartSetEnabled(await loadInvoke(), next));
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    } finally {
      loading = false;
    }
  };

  return {
    get status() {
      return status;
    },
    get loading() {
      return loading;
    },
    get error() {
      return error;
    },
    toggle,
  };
}
