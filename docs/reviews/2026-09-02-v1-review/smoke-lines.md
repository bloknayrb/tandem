# Hardware-gated checks

Drafted for `docs/release-smoke-checklist.md` and **merged there on 2026-09-15**. Run and edit the
checklist, not this file; the table stays as the review's record. Each line gives the platform, what
to do, the pass criterion, and the issue or lead it settles. The first three were on the next-minor
[release gate](release-gate.md). Where each line went:

- **Rows 1 and 3:** §1's updater row, as two added paragraphs. Row 3's `Pre-install:` literal is
  now pinned against the checklist, not this file.
- **Row 2:** already covered by §1's updater row (no banner after a successful update), which ran
  on 2026-09-09 (#1596).
- **Row 4:** §2. **Row 5:** already in §2 before the merge.
- **Rows 6 and 7:** §2 and §3. Row 6 now records survival instead of failing on it, because the
  reaper it assumed does not exist on macOS or Linux (#1988). The relaunch is its pass.
- **Row 8:** §1 and §2, as a check of the credential store itself. "Still signed in" cannot see
  the keychain, because the auth token also falls back to a file. #1761 closed on 2026-09-09, so
  the "Expected to FAIL" note below is obsolete.
- **Row 9: not merged.** A provider API key is set in the Settings **Models** tab, which is
  filtered out while `BYO_MODELS_ENABLED` is false. It joins the checklist with that flip (#1123).
- **Row 10:** §3. **Row 11:** §4, now expecting #1758's named refusal. **Row 12:** §1.

| Platform | Do | Pass when | Settles |
|---|---|---|---|
| Windows | Auto-update from the previous release through the in-app updater (the silent NSIS path). | After restart, `HKCU\…\Run\Tandem` is still present if start-at-login was on; Cowork registrations and the firewall rule are intact; app data under `%APPDATA%` untouched. | Upgrade-path lead: a silent install may skip `PageLeaveReinstall`, so no `/UPDATE` flag and a full uninstall scrub on every auto-update. Would be High and contradicts `data-locations.md:89-93`. |
| Windows | Same run. | The #1118 "you were just updated" hint shows exactly once, then never again. | Smoke checklist §1, two releases unrun. |
| Windows | Same run, with a `.docx` open and unsaved edits at update time. | `tandem.log` contains `Pre-install: graceful sidecar shutdown complete` (and no "still locked" / "still responding" line) and the document is restored on relaunch. **Grep that literal, not the phrase.** Every other line on this path is `info!` and the release floor is `Warn`, and on Windows there is no `Exit: sidecar shutdown complete` verdict line either — `download_and_install` ends in `std::process::exit(0)`, so `RunEvent::Exit` never fires. `respawn_guard_lines_are_warns_and_match_the_smoke_checklist` in `src-tauri/src/sidecar.rs` is what keeps this string and `lib.rs` agreeing. | #1762 (exe-unlock wait is dead code); `lib.rs:2372-2392` tolerance. |
| macOS | Open a `.md`, save it once in Tandem, then edit it in another editor. | The external-edit banner appears. | #1749 (`fs.watch` inode behaviour; Linux confirmed, APFS unrun). |
| macOS | Quit from the menu with an unsaved `.docx`. | Prompt or autosave; the sidecar exits cleanly; no orphan on 3478/3479 after quit. | #1756; the Unix orphan-reaper lead (#800 never landed). |
| macOS, Linux | `kill -9` the Tauri process while the sidecar is up. | The sidecar exits within 30 s and the ports are freed. | Same orphan lead. |
| macOS, Linux | Marketplace plugin install on a fresh profile, then type `/tandem`. | The monitor arms: a wake line appears on the first annotation. | Skill/plugin lead U3 (arming measured on Windows only). |
| Any desktop | Sign in to Cowork, restart the app. | Still signed in. **Expected to FAIL until #1761 is fixed** (the keychain is a mock). | #1761. |
| Any desktop | Set a provider API key in Settings, restart. | The key persists. Same expectation as above. | #1761. |
| Ubuntu 20.04 or Debian 11 | Launch the AppImage or `.deb`. | It starts. | README:51 claims a glibc 2.31 floor while CI builds on ubuntu-22.04 with webkit2gtk-4.1 (docs lead R-1). |
| Windows, desktop running | `npm i -g tandem-editor@<same version>` then run `tandem`. | The desktop app's server must **not** be killed. | #1758. |
| Cowork VM | With only the firewall rule the app adds, open the Cowork tab and connect. | :3479 reachable from the VM through `host.docker.internal`. | [Decision E](decisions.md). |
