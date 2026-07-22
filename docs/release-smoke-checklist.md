# Per-Release Manual Smoke Checklist

Run this after every tagged release, once `tauri-release.yml` has published
artifacts. It covers the things CI structurally cannot: real installers on
real machines, Gatekeeper/SmartScreen behavior, the updater against the
*previous* shipped version, and OS file associations. Budget ~20 minutes per
platform.

This is the lightweight per-release pass. The deep one-time gates (install
matrix across OS versions, observer soak, accessibility) live in
[roadmap.md → v1.0.0 Exit Criteria](roadmap.md#v100-exit-criteria).

## 0. CI signal (before touching hardware)

- [ ] `tauri-release.yml` — every matrix build green, `release-check` summary green, artifacts + `latest.json` on the GitHub Release.
- [ ] `tauri-webdriver.yml` — the tag-triggered run is green (webview-level key-interception E2E on Windows/WebView2). A failure here doesn't block artifact publishing — it's a signal to investigate **before announcing** the release.
- [ ] macOS arm64 **launch smoke** (the "Smoke-test bundled sidecar" step inside `tauri-release.yml`) green — confirms the bundled `node-sidecar` actually boots and serves `/health` on Apple Silicon. A red here means the app is dead-on-arrival even though signing/notarization passed (e.g. the #983 V8-init SIGTRAP), so it no longer falls to the manual macOS pass below.
- [ ] CHANGELOG section for the version is final (the in-app View Changelog button serves this file).

## 1. Windows (10 22H2 or 11)

- [ ] Download the NSIS installer from the release page (not a local build).
- [ ] SmartScreen: if the warning appears, **More info** shows the verified publisher name — *"Unknown publisher" is a signing failure, stop the release* (see [troubleshooting.md → SmartScreen](troubleshooting.md#windows-smartscreen-warning)).
- [ ] Install → launch. App window appears with titlebar chrome intact.
- [ ] Sidecar healthy: **Settings → About → Copy Diagnostics** — paste shows the new version, `desktop` in the header, and all checks `[ok]` (warnings acceptable, failures are not).
- [ ] File association, cold start: with Tandem closed, double-click a `.md` file — Tandem opens **with that file** (not `welcome.md`).
- [ ] File association, warm start: with Tandem running, double-click another `.md` — it opens as a new tab in the existing window (single-instance).
- [ ] Updater: on a machine/VM with the **previous** version installed, launch and wait for the titlebar update dot → install → app restarts → About shows the new version → open a document and type (sidecar survived the restart).
- [ ] Quit from the tray → Task Manager shows **no orphaned `node-sidecar` process**.
- [ ] Uninstall → reinstall current version still launches (uninstaller didn't strand state that breaks a fresh install).

## 2. macOS (real hardware, Apple Silicon)

This is the platform CI verifies most — `tauri-release.yml` checks codesign +
the notarization ticket + the sidecar JIT entitlement, and now also **boots the
bundled arm64 `node-sidecar` headlessly and waits for `/health`** (so "notarized
but dead-on-arrival", e.g. the #983 V8-init SIGTRAP, fails the build). What only
hardware can still prove is the Gatekeeper UX, the GUI window itself, the updater
against the *previous* version, and the OS-keychain round-trip (#428 closed with
exactly this residual).

- [ ] Download the `.dmg` from the release page **in a browser** (the quarantine attribute is the point — `curl` skips it).
- [ ] Open the dmg → drag to Applications → launch from Applications. **No Gatekeeper dialog at all** — "damaged", "unidentified developer", or needing right-click → Open all mean notarization regressed: stop and check [428-macos-notarization-runbook.md](428-macos-notarization-runbook.md).
- [ ] Sidecar healthy: **Settings → About → Copy Diagnostics** as on Windows.
- [ ] File association, warm start: double-click a `.md` in Finder with Tandem running — opens as a tab.
- [ ] File association, cold start: with Tandem quit, double-click a `.md` — Tandem launches and switches to the file. (Known limitation: `welcome.md` may flash first — that's documented behavior, not a failure.)
- [ ] Updater: previous version → update dot → install → restart → new version, document editable.
- [ ] Quit → Activity Monitor shows no orphaned `node-sidecar`.

## 3. Linux (best effort, any box or VM)

- [ ] AppImage: `chmod +x`, launch, sidecar healthy via Copy Diagnostics.
- [ ] `.deb` and `.rpm`: run `scripts/smoke/linux-package-smoke.sh deb` and `... rpm` (Docker, no VM needed — see [spikes/linux-container-install-smoke.md](spikes/linux-container-install-smoke.md)). It installs the artifact in a clean container and **loads** every shipped binary.

  Installing cleanly is not the bar. #1227 installed with exit 0 on both distros and then failed to launch on a missing `libxdo.so.3` — for nine releases. An undeclared runtime library is invisible to `dpkg`/`rpm` and only shows up when the dynamic loader runs, so the check that matters is `ldd` after a real install, not the installer's exit code.

## 4. npm path (any platform)

- [ ] `npm install -g tandem-editor@<new version>` → `tandem` starts the server (a browser-deprecation notice is expected — the desktop app is the primary form factor); the editor loads at `http://127.0.0.1:3479`.
- [ ] `tandem doctor` — run in a **second terminal while the server from the previous step is still running** (otherwise the ports check adds a third failure). Exits 1 with exactly two `[FAIL]` lines, for `node_modules/` and `.mcp.json` (expected: those check the current working directory, which is never the source repo for a global install). Everything else `[PASS]` or `[WARN]` (warnings acceptable, as in section 1).

## 5. Release-candidate extras (RC tags toward v1.0 only)

The per-release sections above test updating **to** this release from the
previous one. The RC pass also has to prove this release can update **forward**
— the seam users actually hit after launch — and exercise the license gate
before it meets a paying user.

- [ ] **Forward-update**: verify the just-built RC updates to a *next* version.
      Mechanic: the updater's `.sig` signs the artifact bytes and the
      `latest.json` `version` field is independent of the signature — so
      re-serve the **current RC's own signed artifact** under a bumped version
      number in a staged `latest.json`, point the updater endpoint override at
      it, and confirm: update dot appears → install → restart → app healthy.
      (Added 2026-06-11; once the updater authenticates against the
      license-checked endpoint — #1116 L3 — run this against the staging
      endpoint so the entitlement check is in the loop.)
- [ ] **License gate ON** (#1116; Windows + macOS minimum): on a gate-enabled
      build — trial banner appears → simulate trial expiry (clock or test hook)
      → hard gate engages → activate with a **real signed license** (issued by
      the L1 script) → app runs → updater entitlement check succeeds. This is
      the most user-hostile path the product ships; it must not run for the
      first time on launch day.

## Recording the result

Note the outcome (platforms covered, anything skipped, anything found) in a
comment on the release's tracking issue or the release PR. A skipped platform
is fine when stated; an unstated skip reads as "verified" and isn't.
