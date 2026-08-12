import { isTauriRuntime } from "@client/cowork/cowork-helpers.js";
import type { SystemLightVariant, ThemePreference } from "./useTandemSettings.js";
import { initTauriTheme, setNativeTheme, tauriTheme } from "./useTauriTheme.svelte.js";
import type { ResolvedTheme } from "./useTheme.js";

export type { ResolvedTheme } from "./useTheme.js";

/**
 * Returns the current resolved system theme.
 *
 * In Tauri, reads `tauriTheme.current` (updated live via onThemeChanged +
 * polling) so that OS app-mode flips reach the DOM without restart. Falls back
 * to the startup seed (`__TANDEM_INITIAL_THEME__`) if the bridge hasn't
 * initialized yet. In browser mode, falls back to matchMedia.
 *
 * `lightVariant` (#993) selects which light-family theme a LIGHT OS appearance
 * resolves to: the neutral `"light"` (default) or the paper-tone `"warm"`. The
 * dark branch is unaffected — a dark OS appearance always resolves to `"dark"`.
 */
export function systemTheme(lightVariant: SystemLightVariant = "light"): ResolvedTheme {
  const lightResolved: ResolvedTheme = lightVariant === "warm" ? "warm" : "light";
  try {
    if (typeof window === "undefined") return lightResolved;
    if (isTauriRuntime()) {
      // tauriTheme.current reflects live AppsUseLightTheme updates. Falls back
      // to the startup seed set by the Rust eval before Svelte mounts (#535).
      //
      // This read is ALSO the reactive subscription that makes `createTheme`'s
      // effect re-run on an OS theme flip -- it is the only one, and it is
      // invisible from the effect site. Do not hoist it behind the `seed`
      // check, memoize it, or wrap it in `untrack`: any of those severs the
      // subscription and `data-theme` silently stops following the OS under
      // `pref === "system"`. Pinned by the OS-flip case in
      // `tests/client/useTheme-native-push.svelte.test.ts`.
      const live = tauriTheme.current;
      if (live === "dark") return "dark";
      if (live === "light") return lightResolved;
      const seed = window.__TANDEM_INITIAL_THEME__;
      if (seed === "dark") return "dark";
      if (seed === "light") return lightResolved;
    }
    return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : lightResolved;
  } catch (err) {
    console.warn("[Tandem] Theme detection failed, defaulting to light:", err);
    return lightResolved;
  }
}

export function resolveTheme(
  pref: ThemePreference,
  lightVariant: SystemLightVariant = "light",
): ResolvedTheme {
  return pref === "system" ? systemTheme(lightVariant) : pref;
}

/**
 * Update <meta name="theme-color"> to match the resolved theme. Called by
 * applyTheme() so the browser chrome (mobile address bar, PWA title bar)
 * stays in sync with the app surface color whenever the theme changes.
 *
 * Colors are hardcoded hex approximations of --tandem-bg so the meta tag
 * is set synchronously before the next paint without a getComputedStyle
 * round-trip. Must match the light/dark/warm --tandem-bg values in index.html:
 *   light: oklch(0.985 0.004 80)  ≈ #fafaf9
 *   dark:  oklch(0.18 0.012 270)  ≈ #1c1c24
 *   warm:  oklch(0.945 0.012 70)  ≈ #f1ead9
 */
function syncThemeColorMeta(resolved: ResolvedTheme): void {
  try {
    const meta = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]');
    if (meta) {
      meta.content = resolved === "dark" ? "#1c1c24" : resolved === "warm" ? "#f1ead9" : "#fafaf9";
    }
  } catch {
    // Guard against SSR or DOM-less test environments where document may throw.
  }
}

/**
 * Apply the resolved theme to <html data-theme="…"> and, when the user's
 * preference is "system", subscribe to OS-level changes. Returns a cleanup
 * that removes the attribute and (for "system" in browser mode) the matchMedia
 * listener.
 *
 * In Tauri, OS theme changes are handled by useTauriTheme.svelte.ts which
 * triggers a reactive re-run of this function. The matchMedia subscription
 * is skipped to prevent a race where matchMedia overwrites the Tauri value.
 *
 * `lightVariant` (#993) is forwarded to `systemTheme()` so that both the
 * initial resolve AND the matchMedia `onChange` re-resolve honor the user's
 * "system light → warm" choice. Ignored unless `pref === "system"`.
 */
export function applyTheme(
  pref: ThemePreference,
  lightVariant: SystemLightVariant = "light",
): () => void {
  const root = document.documentElement;
  const resolved = resolveTheme(pref, lightVariant);
  root.setAttribute("data-theme", resolved);
  syncThemeColorMeta(resolved);

  if (pref !== "system") {
    return () => root.removeAttribute("data-theme");
  }

  if (isTauriRuntime()) {
    return () => root.removeAttribute("data-theme");
  }

  const mq = window.matchMedia("(prefers-color-scheme: dark)");
  const onChange = () => {
    const next = systemTheme(lightVariant);
    root.setAttribute("data-theme", next);
    syncThemeColorMeta(next);
  };
  mq.addEventListener("change", onChange);
  return () => {
    mq.removeEventListener("change", onChange);
    root.removeAttribute("data-theme");
  };
}

/**
 * Svelte 5 port of `useTheme`.
 *
 * Initializes the Tauri theme bridge (get_app_theme + onThemeChanged) so that
 * OS app-mode changes are tracked reactively. In browser mode, the matchMedia
 * subscription inside applyTheme handles OS changes instead.
 *
 * A single effect both pushes the raw, unresolved preference to the native
 * window (#992 -- `setNativeTheme`: process app mode on Windows,
 * `NSApp.appearance` on macOS, no-op on Linux; Rust owns resolving `"warm"`
 * to a native theme and `"system"` to "no override") and applies the
 * resolved theme to the DOM (`applyTheme`). One effect rather than two, so
 * correctness does not depend on Svelte flushing siblings in declaration
 * order. This is safe because `setNativeTheme` dedupes internally on
 * `lastPush.pref` (useTauriTheme.svelte.ts), so a `lightVariant`-only rerun
 * calls it with the same `pref` and no-ops.
 *
 * That dedupe is also the LOOP BREAKER: a release round trip writes
 * `osTheme` back through `tauriTheme.current`, which re-runs this effect. It
 * terminates only because the second `setNativeTheme` call short-circuits.
 * Do not "simplify" the `lastPush` latch away.
 *
 * Accepts getters for `pref` and `lightVariant` so callers with `$state`
 * values propagate reactively. `lightVariant` (#993) controls which
 * light-family theme a LIGHT OS appearance resolves to under `pref="system"`;
 * defaults to `"light"` when no getter is supplied (preserves prior behavior).
 */
export function createTheme(
  getPref: () => ThemePreference,
  getLightVariant: () => SystemLightVariant = () => "light",
): void {
  // Initialize the Tauri theme bridge once — no-op in browser mode
  initTauriTheme();

  $effect(() => {
    const pref = getPref();
    const lightVariant = getLightVariant();

    // Push the raw, unresolved preference to the native window (#992).
    // Deduped internally, so this is a no-op on lightVariant-only reruns.
    setNativeTheme(pref);

    // NOTE: there is deliberately no bare `void tauriTheme.current;` here.
    // The subscription to OS flips already exists inside `applyTheme` ->
    // `resolveTheme` -> `systemTheme`, which reads `tauriTheme.current`
    // synchronously in the `pref === "system"` case -- the only case where
    // an OS flip can change the resolved output. A bare read here would
    // additionally subscribe the effect under an EXPLICIT pref, re-running
    // it (and re-writing `data-theme`) on OS flips that cannot affect the
    // result. Measured before removal: the DOM still follows an OS flip
    // without it. See the comment on that read in `systemTheme`.

    // Do NOT "fix" staleness by writing `setTauriTheme(...)` (or
    // `tauriTheme.current = ...`) synchronously from inside this effect
    // body. Effect bodies run inside an active Svelte reaction, and a
    // synchronous `$state` write from within one throws
    // `state_unsafe_mutation` -- in production too, not just dev (see
    // CLAUDE.md). All native read-backs are written through the async
    // `acceptReadback` gate in useTauriTheme.svelte.ts instead.

    return applyTheme(pref, lightVariant);
  });
}
