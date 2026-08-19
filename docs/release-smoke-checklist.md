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
- [ ] `verify-release-manifest` green **before** publishing the draft. The workflow creates the draft once and verifies the manifest against it; publishing ahead of this check is what the gate exists to prevent. See [`.claude/skills/release/SKILL.md`](../.claude/skills/release/SKILL.md).
- [x] `tauri-webdriver.yml` — **not applicable: disabled 2026-08-08.** Its tag trigger was removed because the job fails on every run for a cause that has resisted diagnosis (`DevToolsActivePort file doesn't exist`, with driver and runtime at an exact version match and the app provably alive in the same run — so the version-mismatch hypothesis is refuted, and there is no knob left to turn). See [#1197](https://github.com/bloknayrb/tandem/issues/1197). **This leaves packaged-desktop key interception unverified by CI** — the Playwright suite drives a real browser, not the Tauri WebView, so nothing else covers it. That gap is deliberate and is scheduled for review on 2026-11-01 in [#1345](https://github.com/bloknayrb/tandem/issues/1345). Ticking this box means "confirmed still disabled", not "confirmed passing" — if the workflow has been re-enabled, restore the original wording and check its run.
- [ ] macOS arm64 **launch smoke** (the "Smoke-test bundled sidecar" step inside `tauri-release.yml`) green — confirms the bundled `node-sidecar` actually boots and serves `/health` on Apple Silicon. A red here means the app is dead-on-arrival even though signing/notarization passed (e.g. the #983 V8-init SIGTRAP), so it no longer falls to the manual macOS pass below.
- [ ] CHANGELOG section for the version is final (the in-app View Changelog button serves this file).

## 1. Windows (10 22H2 or 11)

- [ ] Download the NSIS installer from the release page (not a local build).
- [ ] SmartScreen: if the warning appears, **More info** shows the verified publisher name — *"Unknown publisher" is a signing failure, stop the release* (see [troubleshooting.md → SmartScreen](troubleshooting.md#windows-smartscreen-warning)).
- [ ] Install → launch. App window appears with titlebar chrome intact.
- [ ] Sidecar healthy: **Settings → About → Copy Diagnostics** — paste shows the new version, `desktop` in the header, and all checks `[ok]` (warnings acceptable, failures are not).
- [ ] File association, cold start: with Tandem closed, double-click a `.md` file — Tandem opens **with that file** (not `welcome.md`).
- [ ] File association, warm start: with Tandem running, double-click another `.md` — it opens as a new tab in the existing window (single-instance).
- [ ] Updater: on a machine/VM with the **previous** version installed, launch and wait for the titlebar update dot → install → app restarts → About shows the new version → open a document and type (sidecar survived the restart). **And no "Tandem may not have finished updating" banner appears** — that banner firing after a *successful* update is #1118's false-positive mode, and it would reach every user at once.
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
- [ ] Updater: previous version → update dot → install → restart → new version, document editable, **and no "Tandem may not have finished updating" banner** (#1118's false-positive mode).
- [ ] Quit → Activity Monitor shows no orphaned `node-sidecar`.

## 3. Linux (best effort, any box or VM)

- [ ] AppImage: `chmod +x`, launch, sidecar healthy via Copy Diagnostics.
- [x] `.deb` and `.rpm` — **automated.** `tauri-release.yml`'s "Verify Linux packages install and load" step runs `scripts/smoke/linux-package-smoke.sh` against the freshly built artifacts in `ubuntu:22.04` and `fedora:44` containers, on every tag. Nothing to do by hand; read the step's output. A `::warning::` about an ENVIRONMENT fault means the mirror was unreachable and the package was **not** evaluated — re-run before trusting the build.

  To run it yourself earlier (e.g. against a local `cargo tauri build`), see [spikes/linux-container-install-smoke.md](spikes/linux-container-install-smoke.md). Docker, no VM.

  Installing cleanly is not the bar. #1227 installed with exit 0 on both distros and then failed to launch on a missing `libxdo.so.3` — for nine releases, behind a fully green matrix. An undeclared runtime library is invisible to `dpkg`/`rpm` and only shows up when the dynamic loader runs, so the check that matters is `ldd` after a real install, not the installer's exit code.

## 4. npm path (any platform)

- [ ] `npm install -g tandem-editor@<new version>` → `tandem` starts the server (it prints the editor URL first, then a note that the desktop app is the primary form factor — that note is a *recommendation*, not a deprecation notice, and the comment above that string in `src/cli/start.ts` records why it is deliberately not phrased as one; the browser UI is **kept** — decided 2026-08-18 in #1467, with the reasoning recorded in `docs/roadmap.md` under #477); the editor loads at `http://127.0.0.1:3479`.
- [ ] `tandem doctor` — run in a **second terminal while the server from the previous step is still running** (otherwise the ports check fails). Exits **0** with **no** `[FAIL]` lines. The two that used to be expected here — `node_modules/` and `.mcp.json` — both check the current working directory, which is never the source repo for a global install, and both now report as skipped instead. A `[FAIL]` on either is a regression, not the baseline. Everything else `[PASS]` or `[WARN]` (warnings acceptable, as in section 1).

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

## What the v0.23.0 run settled

v0.23.0 (2026-08-18). §1 and §4 executed on Windows 11 Pro (26200); §0 and §3 are
automated and were green; **§2 macOS was skipped — no Apple Silicon hardware.** What
that skip leaves unverified is narrow and worth naming, because CI now covers most of
it: codesign, the notarization ticket and the arm64 sidecar boot smoke all passed in
`tauri-release.yml`, so what nobody checked is the Gatekeeper UX, the GUI window
itself, the updater from the previous version, and the keychain round-trip.

§1 passed on every item except two that were not run and are recorded as deliberate
skips: the **fresh NSIS install from the release page** (the machine updated in place
instead) and **uninstall → reinstall** (destructive to a working install). The updater
was exercised the way the v0.22.1 run established — a real v0.22.1 baseline already
installed, updated via the in-app prompt. SmartScreen did not appear at all. File
association passed cold and warm.

Three things this run established:

- **`tandem doctor` from a global install now exits 0 outside the checkout**, and that
  is the new baseline rather than a change to note once. `node-modules` and `mcp-json`
  report as skip-shaped **passes**; a `[FAIL]` on either is a regression. The instruction that stood
  here before #1470 told the operator to expect two failing rows and tick the box, which
  would now train them straight past a real fault. Measured here: 16 PASS, 6 WARN, 0 FAIL, exit 0.
- **§4 cannot run while the desktop app is running, and the failure is quiet.** Both
  bind 3478/3479 and contend on the annotation-store lock; the npm server retries for
  30s and gives up rather than displacing the app. Correct behaviour, but it means §4
  has to be run with Tandem quit — and killing the `tandem` wrapper does **not** kill
  the node child it spawned, which will then take the ports the moment the app releases
  them. Confirm with `Get-Process node-sidecar` and `Get-NetTCPConnection -LocalPort
  3478,3479 -State Listen` before and after.
- **The orphan check has a positive identity, not just a name.** The sidecar is
  `node-sidecar` (Tauri `externalBin`), distinct from the several `node.exe` under
  `C:\Program Files\nodejs` that Claude Code and MCP servers keep alive regardless.
  Checking the two commands above is more reliable than reading the Task Manager list.

## What the v0.22.1 run settled

v0.22.1 (2026-08-13) was the first cut with §1 executed end to end; results are on
PR #1430. Four things it established that no prior cut had, kept here because each
one changes how a future run should be done:

- **Test the updater against a real previous-version baseline**, not against the
  diff. The v0.22.1 run installed 0.22.1 → verified → reinstalled 0.22.0 from its
  own release → published → updated. That costs one extra install and forfeits
  nothing. Arguing the upgrade path from the diff is not the same check.
- **Open and inspect the signed installer.** This is the only check that covers
  `dist/stdio-bridge/` — new in v0.22.1, and its absence degrades silently to bare
  `npx` behind a `log::warn!`, which is the exact bug that release fixed.
- **An upgrade does not repair an already-broken Claude Desktop entry — true as of
  v0.22.1, since superseded.** The boot sweep repaired stale *absolute* paths and
  deliberately skipped bare `npx`, because Tandem emits that as a considered
  fallback; affected users had to re-run `tandem setup --apply`. The sweep now
  converges a bare-`npx` **Claude Desktop** entry onto the absolute pair, gated on
  a recognised `env` and a durable bridge path, so from the next release this
  finding no longer holds for that target. It still holds everywhere else — the
  entry in `~/.claude.json`, and any entry whose `env` Tandem did not write.
- **A Windows matrix leg failing inside Azure Trusted Signing is a re-run, not a
  burned tag.** The discriminator is whether the *same commit* passes on retry.
