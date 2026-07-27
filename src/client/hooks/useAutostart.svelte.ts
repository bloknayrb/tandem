import {
  type AutostartStatus,
  autostartErrorMessage,
  autostartGetStatus,
  autostartSetEnabled,
  type InvokeFn,
  loadInvoke,
} from "../tauri/autostart-invoke.js";

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

  let invokeRef: InvokeFn | null = null;
  let loadedOnce = false;

  function applyResult(next: AutostartStatus): void {
    status = next;
    error = next.error ? autostartErrorMessage(next.error) : null;
  }

  async function getInvoke(): Promise<InvokeFn> {
    invokeRef ??= await loadInvoke();
    return invokeRef;
  }

  async function load(): Promise<void> {
    loading = true;
    try {
      applyResult(await autostartGetStatus(await getInvoke()));
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

  $effect(() => {
    if (!getActive()) return;
    if (loadedOnce) return;
    loadedOnce = true;
    void load();
  });

  const toggle = async (next: boolean): Promise<void> => {
    loading = true;
    error = null;
    try {
      // The result carries the OS's read-back value, not `next` — so a write
      // that was virtualized away or blocked leaves the toggle where it was
      // and reports `readback-mismatch` instead of lying.
      applyResult(await autostartSetEnabled(await getInvoke(), next));
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
