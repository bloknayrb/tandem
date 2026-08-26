/**
 * UI element inspector bridge (dev-only).
 *
 * Installs `@tauri-ui-inspector/inspector` so `ui-inspector pick` (and
 * Ctrl+Shift+C / Cmd+Shift+C) can turn a clicked element into a durable
 * `@ui_<ULID>` reference — DOM + ARIA metadata, ranked locators, the Svelte
 * source location, and a native window/element screenshot. The reference is
 * what an agent resolves later; see `.claude/skills/ui-inspector/SKILL.md`.
 *
 * THREE gates have to agree before this does anything, and each covers a case
 * the others do not:
 *
 *  1. `import.meta.env.DEV` at the CALL SITE in main.ts. This is what keeps the
 *     two `@tauri-ui-inspector/*` packages out of the production bundle at all:
 *     they are devDependencies, and `scripts/build-client.mjs` must never need
 *     to resolve them. The import below is dynamic so Vite drops the whole
 *     branch — a static top-level import would pull the packages into the
 *     production graph even behind a `false` guard.
 *  2. `isTauriRuntime()` here. The bridge talks Tauri IPC; the npm global
 *     install serves this same client into a plain browser, where every call
 *     would reject. `npm run dev:client` on :5173 is that case too.
 *  3. The Rust `ui-inspector` cargo feature. Without it the plugin is not in
 *     the binary and the `ui-inspector:default` capability is never granted, so
 *     the bridge's IPC is refused by the ACL.
 *
 * Gate 3 is the one that fails asymmetrically: a `cargo tauri dev` WITHOUT
 * `--features ui-inspector` still runs gates 1 and 2, so the bridge installs
 * and then every capture is rejected. That is why the failure path below logs
 * the flag rather than staying silent — the CLI's only symptom is a timeout,
 * which reads identically to "the app isn't running".
 */
import { isTauriRuntime } from "../cowork/cowork-helpers";

/**
 * Install the inspector bridge. Returns a disposer, or `undefined` when a gate
 * declined — callers fire-and-forget, so a no-op result is the normal outcome
 * in a browser build.
 *
 * Never throws: this is developer tooling loaded during app boot, and a broken
 * inspector must not be able to take down first paint.
 */
export async function installUiInspector(): Promise<(() => void) | undefined> {
  if (!isTauriRuntime()) return undefined;

  try {
    const [{ installInspectorBridge }, { svelteAdapter }] = await Promise.all([
      import("@tauri-ui-inspector/inspector"),
      import("@tauri-ui-inspector/adapter-svelte"),
    ]);

    return await installInspectorBridge({
      // Maps the picked element back to its .svelte file:line:col. Only works
      // through the Vite dev server — production compilation strips the Svelte
      // dev metadata the adapter reads, and it then returns undefined while
      // locators and screenshots keep working.
      adapters: [svelteAdapter()],
      // Tandem documents are the user's own prose, and this store is written to
      // disk unencrypted. Text is redacted out of the JSON record; the
      // screenshots still show whatever was on screen, which no setting can
      // change — treat `.ui-inspector/` as sensitive regardless.
      redactText: true,
      captureFormValues: false,
      onSelect(reference) {
        console.info(`[ui-inspector] created @${reference.id}`);
      },
    });
  } catch (error) {
    // Overwhelmingly gate 3: the bridge installed but the ACL has no
    // `ui-inspector:default` grant because the cargo feature is off.
    console.warn(
      "[ui-inspector] bridge unavailable — rebuild with `cargo tauri dev --features ui-inspector`",
      error,
    );
    return undefined;
  }
}
