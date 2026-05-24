# Manual QA — Phase 1 surfaces (sub-PRs 1.1–1.6)

Compare the **running app** against the **bundle kit**, ticking each box as you go.

- **Bundle reference (visuals):** open `docs/design-system-impl/bundle/extracted/Tandem App UI Kit.html` in OpenDesign. It renders every surface with the real fonts. Default theme is **warm** — switch via the brand menu to check light/dark too.
- **Running app:** `npm run dev:standalone` (browser) **and** `cargo tauri dev` (desktop). The Tauri pass matters most — the WebView, decorum titlebar, and window chrome are the things I can't reach with browser automation, so anything Tauri-only is on you.
- **"Don't flag"** items are intentional production choices that differ from the kit. The kit shows the bundle's mock; production deliberately diverges per the locked conflict resolutions. These are **not** regressions.

How to reach each surface in the kit: titlebar / format bar / editor / rails / status are visible at rest · brand menu = click the Tandem logo · command palette = `Ctrl/Cmd+K` · outline rail = click the left peek strip to expand · chat = click the **Chat** tab in the right rail.

---

## 1.1 — TitleBar (brand menu, theme swatches, mode toggle)

- Brand logo: 40×40 hit area, logo scales up on hover, scales down on press (no chip/ring background)
- Brand menu opens on click: Theme row, Settings, Keyboard shortcuts, with `⌘,` / `⌘/` keycaps
- Theme swatches preview each scheme; the **system** swatch shows a live bg/fg diagonal split
- Solo/Tandem toggle: borderless segmented control, active segment legible in **all three themes**
- **Tauri:** window min / max / close controls work; drag-to-move on empty titlebar area; no decorum drag region eats clicks on the brand/tabs/controls
- **Don't flag:** kit has **3** theme swatches (Warm/Light/Dark); production adds a **4th "system"** swatch — intentional. Kit's mode toggle has a visible track; production's is borderless (`fg @ 6%`).

## 1.2 — FormatBar (pill, buttons, authorship toggle, highlight)

- Floating pill: ~26px buttons, pill corners, hover = sunk background, active = accent fill (no border)
- Authorship toggle present on the bar (two-circle icon, blue=user / orange=Claude), `Ctrl+Alt+A` toggles it
- Highlight = split button (swatch + color-picker chevron); color picker round-trips
- Heading dropdown, undo/redo, B/I/S/code, lists, blockquote, link inline-input all work
- **Tauri:** pill is click-through-safe (`-webkit-app-region: no-drag`) — buttons respond, window still drags elsewhere
- **Don't flag:** the kit's FormatBar has **panel-left / panel-right toggle buttons** — production removed these (replaced by edge peek strips + `Alt+Shift+←/→`). The kit's FormatBar has **no authorship toggle**; production moved it here on purpose. The audience-first selection popup is production-only (the kit has no audience awareness).

## 1.3 — Editor body + left outline rail

- H1/H2 render in the serif display face with tightened tracking
- Authorship coloring on paragraphs (blue=user, orange=Claude) when the toggle is on
- Outline rail: "Outline" header label, H1/H2 items, annotation counts, **active-heading tick**
- Active tick **tracks scroll** (doesn't freeze on the first heading); last heading can pin to top (there's trailing scroll room)
- Edge-collapse rail (12px) on both sides, full height, with a centered grip
- **Tauri:** Source Serif 4 / Inter Tight / JetBrains Mono render in the WebView (not system fallbacks)
- **Don't flag:** scroll-spy threshold + the "End of document" trailing pill are production live-smoke fixes the kit doesn't model.

## 1.4 — Peek strips (collapsed rails)

- Collapse a rail → a thin peek strip appears at the edge
- Hover/focus widens the strip to ~28px and reveals a rotated label ("Outline" / "Annotations")
- **Tauri:** hover/focus widen behaves the same in the desktop WebView
- **Don't flag:** the kit shows **peek content previews** (outline ticks / annotation dots) inside the strip — production **defers** these (data plumbing + motion). The right rail keeps the production **segmented-pill** Annotations/Chat toggle, not the kit's underline tabs.

## 1.5 — Annotation cards

- Full-card **background tint** per type: note→amber, suggestion→violet, comment→author-tinted, highlight→its color, imported→neutral
- 6px **authorship dot** in the card header (user=blue / Claude=orange); imported cards keep their byline
- Rounder corners, soft resting shadow that lifts on hover, **pill-shaped** action buttons
- Suggestion diff block renders (serif); private note shows the private pill
- Review target (the focused card) reads as accented
- **Tauri:** card shadows / tints render correctly in the WebView (no banding in dark)
- **Don't flag:** the kit colors the **whole author name**; production uses a **dot + byline** instead. Action button **labels** in the kit ("Send to Claude", etc.) are mock — production labels are authoritative.

## 1.6 — Command palette

- `Ctrl+Shift+P` opens it (note: production is **Ctrl+Shift+P**, the kit demo uses Ctrl/Cmd+K)
- Leading search glyph + trailing **Esc** keycap in the input row
- Footer prefix hints (`#` / `@` / `?` / `>`) as keycaps over a muted bar
- Rounded inset result rows; 640px modal, large corner radius; **blur** behind the overlay
- **Escape dismisses** the palette even when focus isn't inside it
- The overlay **dims the&#x20;****+****&#x20;new-tab button and Solo/Tandem toggle** (they should NOT poke through)
- **Tauri (important):** confirm the overlay dims the titlebar in the **desktop app** — the z-index fix was only verifiable in the browser, and Tauri has the real decorum overlay underneath
- **Don't flag:** the kit shows **per-item icons** and **section headers** ("Actions" / "Documents") — production **skips both** (the action registry is frozen and has no icon field; production routes by prefix, showing one result kind at a time). The kit's placeholder differs from production's prefix-routing placeholder.

---

*Scope: merged surfaces only. Settings (1.7) and StatusBar / NewTabMenu / toasts / selection mini-toolbar / slash menu (1.8–1.12) aren't built yet — comparing them against the kit would just show by-design mismatches.*
