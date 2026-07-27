; Tandem NSIS installer hook — invoked by Tauri v2's nsis bundler.
;
; Per security invariant §10 (ADR reference in docs/plans/...):
;   The uninstall scrub runs INSIDE the already-signed `tandem.exe` binary,
;   NOT from a separate `uninstall_scrub.exe`. This prevents binary-planting
;   attacks where an attacker drops a same-named exe on a PATH search path
;   before uninstall triggers.
;
; The `--uninstall-scrub` subcommand (src-tauri/src/uninstall_scrub.rs):
;   - Walks every Cowork workspace and removes the Tandem plugin entry.
;   - Deletes the Tandem Cowork firewall rules (allow + deny).
;   - Removes the start-at-login registration (HKCU Run + StartupApproved).
;   - Exits 0 on clean-or-not-installed; each step is independently
;     best-effort so a partial failure never blocks removing Tandem.
;
; MCP config entries in ~/.claude.json and the bundled skill directory are NOT
; touched here — those belong to the npm CLI's `tandem --uninstall-scrub`
; (src/cli/uninstall-scrub.ts), whose bundle is not among the Tauri resources.
;
; NSIS logs but does NOT abort uninstall if the scrub returns non-zero —
; removing Tandem itself must always succeed even if workspace scrub partially
; fails (the user can re-scrub manually).

; Kill the sidecar before file replacement — Tauri's CheckIfAppIsRunning
; (which runs immediately after this hook) handles the main binary with a
; user-facing dialog, but does not know about the sidecar.
!macro NSIS_HOOK_PREINSTALL
    nsis_tauri_utils::KillProcessCurrentUser "node-sidecar.exe"
    Pop $R0
    Sleep 2000
!macroend

; The `$UpdateMode <> 1` guard is NOT optional (#1236).
;
; Tauri's NSIS template runs the OLD uninstaller when installing over an
; existing version (`PageLeaveReinstall` executes the stored UninstallString
; with `/UPDATE` appended), and it inserts this hook UNCONDITIONALLY at the top
; of `Section Uninstall` — before any $UpdateMode check of its own. Without the
; guard, every routine upgrade would run the full scrub: the user's Cowork
; registrations, firewall rules, and start-at-login preference would all be
; wiped on each release. Cowork self-heals within five minutes and firewall
; rules are re-added on demand, but the autostart preference would silently
; vanish every time the app updated itself.
;
; `$UpdateMode` IS populated here: the template's `un.onInit` parses `/UPDATE`
; from the command line and `FunctionEnd`s immediately before `Section
; Uninstall`, so the variable is set by the time this macro expands.
;
; `${MAINBINARYNAME}` rather than a hardcoded name: with no `mainBinaryName` in
; tauri.conf.json and no `[[bin]]` section, Tauri names the binary after the
; Cargo package (`tandem-desktop`), not `tandem`. The previous hardcoded
; `tandem.exe` matched no file on disk, which is one of two reasons this scrub
; has never actually run (the other being that nothing in the Rust binary
; parsed `--uninstall-scrub` until #1236).
!macro NSIS_HOOK_PREUNINSTALL
    ${If} $UpdateMode <> 1
        DetailPrint "Running Tandem uninstall scrub..."
        ExecWait '"$INSTDIR\${MAINBINARYNAME}.exe" --uninstall-scrub' $0
        DetailPrint "Uninstall scrub exited with code $0"
    ${Else}
        DetailPrint "Update in progress — skipping Tandem uninstall scrub"
    ${EndIf}
!macroend
