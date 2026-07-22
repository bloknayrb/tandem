import { mount } from "svelte";
import { migrateModelsRegistryOnce } from "./actions/migrate-models-registry";
import Root from "./Root.svelte";
import { initCrashReporting } from "./sentry";
import "./actions/scroll-fade.css";

// Crash reporting (#921) — opt-in, off by default. Self-gates on the Tauri
// WebView + an operator-configured DSN; a no-op in plain-browser builds and
// when telemetry is disabled. Fire-and-forget so it never delays first paint.
void initCrashReporting();

// One-time Models-registry relocation to the server (#1123 M1a). No-ops for
// users with no configured models (the dark common case) and after it has run
// once. Fire-and-forget: only a cheap localStorage check runs synchronously;
// the network POST is deferred and never blocks first paint.
void migrateModelsRegistryOnce();

mount(Root, { target: document.getElementById("root")! });
