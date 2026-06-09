import { mount } from "svelte";
import Root from "./Root.svelte";
import { initCrashReporting } from "./sentry";
import "./actions/scroll-fade.css";

// Crash reporting (#921) — opt-in, off by default. Self-gates on the Tauri
// WebView + an operator-configured DSN; a no-op in plain-browser builds and
// when telemetry is disabled. Fire-and-forget so it never delays first paint.
void initCrashReporting();

mount(Root, { target: document.getElementById("root")! });
