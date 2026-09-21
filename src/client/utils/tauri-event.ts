/**
 * The listen/cancel dance for a PAYLOAD-FREE Tauri event listener.
 *
 * `@tauri-apps/api/event` is dynamically imported (the client also runs in a
 * plain browser, where the module must never load), so wiring a listener is
 * always a promise chain whose unlisten handle can arrive *after* the component
 * has been destroyed. Getting that wrong leaks a listener across a hot reload.
 *
 * **This is not yet the one implementation, and a fix applied here does not
 * reach the rest.** Exactly two sites route through it — `src/client/App.svelte`
 * (`sidecar-restart-failed`) and `src/client/utils/sidecar-restart-toast.ts`
 * (`sidecar-restarted`), the #1959 pair it was extracted from. Hand-rolled
 * chains against the same dynamic import still live in
 * `src/client/App.svelte` (`open-integration-wizard`),
 * `src/client/tabs/DocumentTabs.svelte`,
 * `src/client/editor/context-menu/install.ts`,
 * `src/client/panels/annotation-context-menu-host.ts`,
 * `src/client/hooks/useUpdaterChannel.svelte.ts`,
 * `src/client/hooks/usePendingUpdateBanner.svelte.ts`,
 * `src/client/utils/pending-update-hint.ts` and
 * `src/client/utils/startup-rejection.ts`. Several carry a payload, a refcount
 * or a token discriminator this signature does not model, so migrating them is
 * a change with its own review, not a rename. Until one of them moves, do not
 * read a guard added below as covering it — in particular the `cancelled`
 * re-check inside the handler is local to this file.
 *
 * That enumeration is pinned by `tests/docs/tauri-event-helper-claims.test.ts`,
 * which sweeps `src/client` for the dynamic import and fails closed on a site
 * this list does not name.
 */

export interface TauriEventModule {
  listen: (event: string, handler: () => void) => Promise<() => void>;
}

export interface ListenTauriEventDeps {
  /** Usually `() => import("@tauri-apps/api/event")`. */
  loadEvent: () => Promise<TauriEventModule>;
  /** The event name to listen for. */
  event: string;
  /** Called for each occurrence, unless cleanup has already run. */
  onEvent: () => void;
  /** Injected for tests; defaults to `console.warn`. */
  warn?: (message: string, err: unknown) => void;
}

/** Wire a payload-free Tauri event listener and return its cleanup function. */
export function listenTauriEvent(deps: ListenTauriEventDeps): () => void {
  const warn = deps.warn ?? ((message: string, err: unknown) => console.warn(message, err));
  let cancelled = false;
  let unlisten: (() => void) | null = null;

  deps
    .loadEvent()
    .then(({ listen }) =>
      listen(deps.event, () => {
        if (!cancelled) deps.onEvent();
      }),
    )
    .then((un) => {
      if (cancelled) un();
      else unlisten = un;
    })
    .catch((err) => {
      warn(`[App] Failed to wire ${deps.event} listener:`, err);
    });

  return () => {
    cancelled = true;
    unlisten?.();
    unlisten = null;
  };
}
