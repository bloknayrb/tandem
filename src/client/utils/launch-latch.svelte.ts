/**
 * A flag that holds until the next server launch (#2198, #2199): the
 * auto-opened wizard closed this launch, the chat panel's Claude Code offer
 * dismissed with Not now.
 *
 * Keyed on the server's per-process `launchId` and kept in localStorage, so
 * "next launch" means a server start in the browser distribution too (a tab
 * reloaded after a restart gets it back) and every tab agrees. Two fallbacks,
 * each for one failure:
 *   - a server too old to send a `launchId`: this page's memory is the launch;
 *   - localStorage unavailable (it throws in a storage-disabled browser): the
 *     in-memory copy, set before the write, holds it for this page.
 */
export interface LaunchLatch {
  /** Set during the current launch. Reactive. */
  readonly active: boolean;
  /** Set it for the current launch. */
  mark(): void;
  /** Feed a `storage` event: another tab's mark reaches this one. */
  onStorage(ev: StorageEvent): void;
}

export function createLaunchLatch(key: string, launchId: () => string | null): LaunchLatch {
  let stored = $state<string | null>(read(key));
  let thisPage = $state(false);
  return {
    get active() {
      const id = launchId();
      return thisPage || (id !== null && stored === id);
    },
    mark() {
      const id = launchId();
      if (id === null) {
        thisPage = true;
        return;
      }
      stored = id;
      try {
        localStorage.setItem(key, id);
      } catch {
        // Storage unavailable — the in-memory copy above holds it for this page.
      }
    },
    onStorage(ev) {
      if (ev.key === key) stored = ev.newValue;
    },
  };
}

function read(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}
