import { mount } from "svelte";
import { installGlobalContextMenuPolicy } from "./context-menu-policy";
import { initializeStore } from "./hooks/useModels.svelte";
import Root from "./Root.svelte";
import { initCrashReporting } from "./sentry";
import "./actions/scroll-fade.css";

// Global context-menu allowlist (#994) — installed once, for the app's
// lifetime, before mount. Suppresses the WebView's default menu everywhere
// except the allowlisted surfaces; see context-menu-policy.ts.
installGlobalContextMenuPolicy();

// Crash reporting (#921) — opt-in, off by default. Self-gates on the Tauri
// WebView + an operator-configured DSN; a no-op in plain-browser builds and
// when telemetry is disabled. Fire-and-forget so it never delays first paint.
void initCrashReporting();

// Models registry (#1123 M2): reconcile localStorage → the server authority once,
// settle the CRUD gate, then load the store. Un-gated reconcile runs while dark
// exactly like the M1a seeder (R2-A); the load is `BYO_MODELS_ENABLED`-gated so a
// dark boot fetches nothing. Fire-and-forget: only a cheap localStorage check
// runs synchronously; the network round-trips never block first paint.
void initializeStore();

mount(Root, { target: document.getElementById("root")! });

// UI element inspector bridge — dev builds only, and only inside the Tauri
// WebView. `import.meta.env.DEV` is what keeps the two `@tauri-ui-inspector/*`
// devDependencies out of the production bundle: the module's own imports are
// dynamic, so Vite drops this whole branch (and them) from a `npm run build`.
// Fire-and-forget, after mount — the picker attaches to live DOM, and nothing
// about it should delay first paint. See ./tauri/ui-inspector.ts.
if (import.meta.env.DEV) {
  void import("./tauri/ui-inspector").then(({ installUiInspector }) => installUiInspector());
}
