# Native context menus ignore an explicit in-app theme override

**Issues:** #992 **Decision needed:** Do we accept `set_theme`'s blast radius — it also restyles native file dialogs and the title bar — in exchange for menus that match a non-system theme? Yes or no?

## What these are

Filed 2026-06-03, `enhancement` + `needs-design-decision`. The #923 menus are real OS menus, so they style off the *window* appearance, not Tandem's CSS.

Verified today:
- Theme flow is one-directional OS → app. `get_app_theme` is the only theme command registered (`src-tauri/src/lib.rs:1493`, impl at `:2666`); the client bridge reads it (`src/client/hooks/useTauriTheme.svelte.ts:49, 81`).
- **`set_theme` appears nowhere in `src-tauri/src/`** (grepped `set_theme|Flags::` across all 14 `.rs` files — only `prevent_default_flags` at `lib.rs:2687` matched). There is no `theme` key pushed to the window.
- Tauri is `2.11.1` (`src-tauri/Cargo.toml:39`), so `WebviewWindow::set_theme` is available.

So the diagnosis in the body is correct and still current: the menu mismatches **only** when the user overrides theme away from the OS (OS light + app dark), and `warm` has no native analog.

## Why they stalled

The body already contains the answer *and* the objection, and the objection is the harder one: `set_theme` is a whole-window switch, not a menu switch. It changes native file dialogs and the title bar too. That is a product decision, not an engineering one — which is exactly why it sat.

## Options

1. **`set_theme` on explicit preference only** (leave `"system"` untouched to avoid the `get_app_theme` read-back loop; map `warm → light`). ~40 lines: one Rust command + one effect in `useTheme.svelte.ts`. Cost: file dialogs and title bar follow the app theme, permanently and app-wide.
2. **Same, but scoped to dark-family only** — push `set_theme` when the app is dark and the OS is light, leave every other combination alone. Smaller blast radius, more conditionals, and `warm` still never matches.
3. **Close as won't-fix.** Most native apps behave this way; the body says so itself.

## Recommendation

**Option 1, and the plan's "most shippable" call holds for #992 — with one caveat.** The code is small and the blast radius is arguably an *improvement*: a dark-themed app opening a blazing-white file dialog is the worse of the two bugs. The caveat: the body's Windows warning is real and unverified. Windows popup-menu dark mode in muda lags, so the likely outcome is "macOS/Linux match, Windows title bar darkens but the popup may not". Verify on the Windows dev box **before** writing the changelog line, or you ship a claim the platform doesn't honour.

Answer this alongside #994/#997 — all three are #923 follow-ups; see `brief-994.md`.

## If yes / If no

**Yes:** one `set_window_theme` command, one client effect, plus explicit sign-off that native file dialogs now follow the app theme. Verify on Windows first; record whichever way it lands rather than assuming.
**No:** close #992 with the reasoning in its own body — this is normal native-app behaviour, and pretending otherwise costs a permanent app-wide side effect.
