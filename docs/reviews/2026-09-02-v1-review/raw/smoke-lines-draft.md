# Hardware-gated verification lines (draft for docs/release-smoke-checklist.md — NOT yet applied to the repo)
Each line: platform | what to do | pass criterion | ledger ref

- Windows | Auto-update from the previous release via the in-app updater (silent NSIS path) | after restart: HKCU\...\Run\Tandem still present if start-at-login was on; Cowork registrations and firewall rule intact | P lead (silent install may skip /UPDATE ⇒ full scrub)
- Windows | Same run | #1118 "you were just updated" hint shows exactly once, then never again | Status §1 (two releases unrun)
- Windows | Same run, with a .docx open and unsaved edits at update time | sidecar shut down gracefully (no "still locked"/"still responding" warning in tandem.log) and the doc restored on relaunch | P lead lib.rs:2372-2392
- macOS | Open a .md, save it once in Tandem, then edit it in another editor | external-edit banner appears (Node fs.watch inode behaviour applies to macOS too) | D High file-watcher.ts:64-69 (Linux confirmed, macOS unrun)
- macOS | Quit from the menu with an unsaved .docx | prompt or autosave, sidecar exits cleanly (no orphan on ports 3478/3479 after quit) | T High hard-kill + #800 orphan lead
- macOS/Linux | Kill the Tauri process with SIGKILL while the sidecar is up | sidecar exits within 30 s; ports freed | server-runtime lead (Unix orphan reaper never landed)
- macOS/Linux | Marketplace plugin install on a fresh profile, then `/tandem` | monitor arms (wake line appears on first annotation) | S lead U3
- Any desktop | Sign in to Cowork, restart the app | still signed in (keychain persistence; currently mock backend ⇒ expected FAIL until fixed) | T High keyring no backend
- Any desktop | Set a provider API key in Settings, restart | key persists | same
- Ubuntu 20.04 / Debian 11 | Launch the AppImage/deb | starts (README floor claims glibc 2.31) | N lead R-1
- Windows + desktop running | `npm i -g tandem-editor@<same>` then `tandem` | must NOT kill the desktop app's server | M High freePort after lock
