/**
 * The listen/cancel dance every Tauri event listener in the client repeats.
 *
 * `@tauri-apps/api/event` is dynamically imported (the client also runs in a
 * plain browser, where the module must never load), so wiring a listener is
 * always a promise chain whose unlisten handle can arrive *after* the component
 * has been destroyed. Getting that wrong leaks a listener across a hot reload.
 * One implementation, so the three call sites cannot disagree about it.
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
