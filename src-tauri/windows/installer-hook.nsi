; Tandem NSIS installer hook — invoked by Tauri v2's nsis bundler.
;
; Per security invariant §10 (ADR reference in docs/plans/...):
;   The uninstall scrub runs INSIDE the already-signed `tandem.exe` binary,
;   NOT from a separate `uninstall_scrub.exe`. This prevents binary-planting
;   attacks where an attacker drops a same-named exe on a PATH search path
;   before uninstall triggers.
;
; The `--uninstall-scrub` subcommand:
;   - Walks every Cowork workspace and removes the Tandem plugin entry.
;   - Deletes the Tandem Cowork firewall rules (allow + deny).
;   - Logs to %LOCALAPPDATA%\tandem\Logs\uninstall.log.
;   - Exits 0 on clean-or-not-installed, non-zero only on unrecoverable error.
;
; NSIS logs but does NOT abort uninstall if the scrub returns non-zero —
; removing Tandem itself must always succeed even if workspace scrub partially
; fails (the user can re-scrub manually).

!macro NSIS_HOOK_PREUNINSTALL
    DetailPrint "Running Tandem Cowork uninstall scrub..."
    ExecWait '"$INSTDIR\tandem.exe" --uninstall-scrub' $0
    DetailPrint "Cowork scrub exited with code $0"
!macroend
