import { mount } from "svelte";
import { initializeStore } from "./hooks/useModels.svelte";
import Root from "./Root.svelte";
import { initCrashReporting } from "./sentry";
import "./actions/scroll-fade.css";

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
