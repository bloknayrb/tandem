import { useEffect } from "react";
import type { ThemePreference } from "./useTandemSettings";

export type ResolvedTheme = "light" | "dark";

export function systemTheme(): ResolvedTheme {
  try {
    if (typeof window === "undefined") return "light";
    return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  } catch {
    return "light";
  }
}

export function resolveTheme(pref: ThemePreference): ResolvedTheme {
  return pref === "system" ? systemTheme() : pref;
}

/**
 * Apply the resolved theme to <html data-theme="…"> and, when the user's
 * preference is "system", re-apply on OS-level changes. Scoped to <html>
 * (not <body>) so CSS-custom-property overrides cascade into portals and
 * popovers rendered outside the React root.
 */
export function useTheme(pref: ThemePreference): void {
  useEffect(() => {
    const root = document.documentElement;
    root.setAttribute("data-theme", resolveTheme(pref));

    if (pref !== "system") {
      return () => root.removeAttribute("data-theme");
    }

    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = () => root.setAttribute("data-theme", systemTheme());
    mq.addEventListener("change", onChange);
    return () => {
      mq.removeEventListener("change", onChange);
      root.removeAttribute("data-theme");
    };
  }, [pref]);
}
