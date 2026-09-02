# Coverage manifest: tauri

Generated from the agent transcript. Zero model tokens.

## Files touched (97)
- .github/workflows/
- .github/workflows/tauri-release.yml
- <transcript tool result, not kept>
- <transcript tool result, not kept>
- <transcript tool result, not kept>
- docs/428-macos-notarization-runbook.md
- docs/architecture.md
- docs/configuration.md
- docs/data-locations.md
- docs/decisions.md
- docs/gotchas.md
- docs/lessons
- docs/release-smoke-checklist.md
- docs/roadmap.md
- docs/security.md
- docs/troubleshooting.md
- scripts/build-reaper.mjs
- scripts/download-node-sidecar.mjs
- src-tauri/Cargo.lock
- src-tauri/Cargo.toml
- src-tauri/src
- src-tauri/src/
- src-tauri/src/autostart.rs
- src-tauri/src/bounded_command.rs
- src-tauri/src/context_menu.rs
- src-tauri/src/cowork_atomic_json.rs
- src-tauri/src/cowork_commands.rs
- src-tauri/src/cowork_installer.rs
- src-tauri/src/cowork_meta.rs
- src-tauri/src/cowork_workspace_scan.rs
- src-tauri/src/firewall.rs
- src-tauri/src/integrations_probe.rs
- src-tauri/src/keychain.rs
- src-tauri/src/lib.rs
- src-tauri/src/native_theme.rs
- src-tauri/src/open_candidate.rs
- src-tauri/src/pending_update.rs
- src-tauri/src/sentry_reporting.rs
- src-tauri/src/sidecar.rs
- src-tauri/src/sidecar_job.rs
- src-tauri/src/single_flight.rs
- src-tauri/src/startup_rejection.rs
- src-tauri/src/system_paths.rs
- src-tauri/src/token_store.rs
- src-tauri/src/uninstall_scrub.rs
- src-tauri/src/win_app_mode.rs
- src-tauri/tauri
- src-tauri/tests/file_association.rs
- src-tauri/tests/keychain.rs
- src-tauri/tests/prevent_default.rs
- src-tauri/windows/installer-hook.nsi
- src/app.rs
- src/bundle/settings.rs
- src/bundle/windows/nsis/installer.nsi
- src/cli
- src/client
- src/client/hooks/useTauriFileDrop.svelte.ts
- src/client/hooks/useUpdaterBanner.svelte.ts
- src/client/keychain/keychain-backend.ts
- src/client/tauri
- src/client/tauri/autostart-invoke.ts
- src/client/tauri/ui-inspector.ts
- src/client/utils/pending-update-hint.ts
- src/client/utils/startup-rejection.ts
- src/common.rs
- src/lib.rs
- src/linux.rs
- src/macos.rs
- src/main.rs
- src/mock.rs
- src/process/mod.rs
- src/server
- src/server/auth/token-store.ts
- src/server/documents/
- src/server/documents/autosave.ts
- src/server/index.ts
- src/server/integrations/api-routes.ts
- src/server/integrations/keychain.ts
- src/server/launcher/api-routes.ts
- src/server/mcp/api-routes.ts
- src/server/mcp/document-service.ts
- src/server/mcp/routes/
- src/server/mcp/server.ts
- src/server/mcp/tutorial-annotations.ts
- src/server/session
- src/server/session/manager.ts
- src/server/yjs/provider.ts
- src/shared
- src/shared/api-paths.ts
- src/shared/constants.ts
- src/shared/integrations/contract.ts
- src/shared/launcher/contract.ts
- src/updater.rs
- src/windows.rs
- tests/server
- tests/server/launcher/
- tests/server/launcher/api-routes.test.ts

## Commands run (36)
- `cat <scratchpad>/open-issues.txt`
- `find src-tauri -type f -not -path '*/target/*' -not -path '*/gen/*' -not -path '*/icons/*' | sort && echo "---" && find reaper -type f 2>/dev/null | sort && ech`
- `wc -l docs/architecture.md docs/gotchas.md docs/data-locations.md docs/troubleshooting.md docs/428-macos-notarization-runbook.md docs/security.md && grep -n '^#`
- `sed -n 285,383p docs/architecture.md; echo "=========== TAURI LAYER ==========="; sed -n 787,920p docs/architecture.md; echo "=========== FILE MAP TAURI =======`
- `cat docs/gotchas.md`
- `grep -n '^### ' docs/gotchas.md`
- `sed -n 12,25p docs/gotchas.md; echo "=====FILES/SESSIONS====="; sed -n 135,159p docs/gotchas.md; echo "=====WINDOWS====="; sed -n 174,178p docs/gotchas.md`
- `cat docs/data-locations.md; echo "=================== NOTARIZATION ==================="; cat docs/428-macos-notarization-runbook.md`
- `cat docs/troubleshooting.md`
- `cat docs/security.md`
- `cd <repo>/src-tauri && echo "=== tauri.conf.json ===" && cat tauri.conf.json && echo && echo "=== capabilities/default.json ===" && cat capabilities/`
- `echo "=== installer-hook.nsi ===" && cat -n src-tauri/windows/installer-hook.nsi && echo && echo "=== src/client/tauri/autostart-invoke.ts ===" && cat -n src/cl`
- `echo "=== download-node-sidecar.mjs ===" && cat -n scripts/download-node-sidecar.mjs && echo && echo "=== build-reaper.mjs ===" && cat -n scripts/build-reaper.m`
- `cd <repo>/reaper && echo "=== Cargo.toml ===" && cat Cargo.toml && echo "=== .gitignore ===" && cat .gitignore && echo "=== main.rs ===" && cat -n sr`
- `cat -n src-tauri/src/token_store.rs src-tauri/src/keychain.rs && echo "=== INVOKE NAMES IN CLIENT ===" && grep -rn --include='*.ts' --include='*.svelte' -E "inv`
- `cd <repo>/src-tauri && (timeout 600 cargo check --tests 2>&1 | tail -40; echo "EXIT: ${PIPESTATUS[0]}") > <scratchpad-path>`
- `echo "=== TANDEM_DATA_DIR / TANDEM_APP_DATA_DIR in server ===" && grep -rn "TANDEM_DATA_DIR\|TANDEM_APP_DATA_DIR" src/server src/shared src/cli --include='*.ts'`
- `cd <repo>/src-tauri && echo "=== unwrap/expect/panic/unreachable in non-test Rust (approx: excludes lines inside #[cfg(test)] modules by a heuristic)`
- `R=~/.cargo/registry/src/*/; echo "=== tauri-build copy_binaries ===" && grep -n -B3 -A25 "fn copy_binaries" $R/tauri-build-2.6.3/src/lib.rs | head -60; echo; ec`
- `cat -n src-tauri/src/cowork_meta.rs src-tauri/src/sentry_reporting.rs`
- `echo "=== launcher/api-routes.ts start route ===" && grep -n -B5 -A40 "API_LAUNCHER_START" src/server/launcher/api-routes.ts | head -120; echo; echo "=== index.`
- `echo "=== tauri-release.yml (key parts) ===" && grep -n "installMode\|signCommand\|certificate\|Trusted\|windows\|nsis\|TAURI_SIGNING\|APPLE_\|args:\|--target\|`
- `R=$(ls -d ~/.cargo/registry/src/*/ | head -1); echo "=== cargo check log ===" && cat <scratchpad-path>`
- `cat -n src-tauri/src/bounded_command.rs | sed -n 1,320p`
- `cat -n src-tauri/src/single_flight.rs | sed -n 1,140p; echo "=== win_app_mode.rs (non-test) ==="; awk '/#\[cfg\(test\)\]/{exit} {print NR": "$0}' src-tauri/src/`
- `R=$(ls -d ~/.cargo/registry/src/*/ | head -1); echo "=== keyring 3.6.3 features / default store ==="; sed -n '/^\[features\]/,/^\[/p' $R/keyring-3.6.3/Cargo.tom`
- `echo "=== Node token store: env token persistence ==="; grep -n "TANDEM_AUTH_TOKEN\|writeToken\|atomicWrite\|export " src/server/auth/token-store.ts | head -30;`
- `R=$(ls -d ~/.cargo/registry/src/*/ | head -1); echo "=== Node token-store.ts 55-100 ==="; sed -n 55,100p src/server/auth/token-store.ts; echo; echo "=== assertO`
- `echo "=== client keychain-backend.ts ==="; cat -n src/client/keychain/keychain-backend.ts | sed -n 1,170p; echo; echo "=== server keychain module + napi-rs bund`
- `echo "=== session persistence writers ==="; grep -rln "sessions" src/server --include='*.ts' | grep -v test | head; grep -rn "function saveCurrentSession\|funct`
- `echo "=== writeTokenToFile callers ==="; grep -rn "writeTokenToFile(" src/server src/cli src/shared --include='*.ts' | grep -v test; echo; echo "=== client wiza`
- `echo "=== ADR-044/045 Cowork verification claims ==="; grep -n -i "cowork" docs/decisions.md | grep -i "verif\|tested\|measured\|hardware\|end-to-end\|works" | `
- `echo "=== git history: keyring line in Cargo.toml ==="; git log --oneline -S'keyring' -- src-tauri/Cargo.toml | head -5; git log -p --follow -S'keyring' -- src-`
- `echo "=== unwrap/expect/panic in single_flight.rs, win_app_mode.rs, sentry, keychain, token_store, sidecar_job (with line numbers) ==="; grep -n "\.unwrap()\|\.`
- `echo "=== api-paths launcher ==="; grep -n "LAUNCHER" src/shared/api-paths.ts; echo; echo "=== client launcher start/nonce callers (any spelling) ==="; grep -rn`
- `echo "=== index.ts 560-575 ==="; sed -n 560,575p src/server/index.ts; echo "=== index.ts 715-745 ==="; sed -n 715,745p src/server/index.ts; echo; echo "=== laun`

## Probe/executed outputs (3)

### cd <repo>/src-tauri && (timeout 600 cargo check --tests 2>&1 | tail -40; echo "EXIT: ${PIPESTATUS[0]}") > <scratchpad>/car
(output 390 chars)
```
Command running in background with ID: bfzaeyhii. Output is being written to: <scratchpad-path> You will be notified when it completes. To check interim output, use Read on that file path.
Session cwd remains <repo>; directory changes made by the backgrounded command do not apply to subsequent commands.
```

### echo "=== TANDEM_DATA_DIR / TANDEM_APP_DATA_DIR in server ===" && grep -rn "TANDEM_DATA_DIR\|TANDEM_APP_DATA_DIR" src/server src/shared src/cli --include='*.ts' | grep -v test | head -30 && echo && ec
(output 3944 chars)
```
=== TANDEM_DATA_DIR / TANDEM_APP_DATA_DIR in server ===
src/server/index.ts:624:      const sampleBase = process.env.TANDEM_DATA_DIR || projectRoot;
src/server/platform.ts:7: * Resolve the Tandem app-data root directory. `TANDEM_APP_DATA_DIR` overrides
src/server/platform.ts:11:  const envOverride = process.env.TANDEM_APP_DATA_DIR;
src/server/annotations/store.ts:64: * Returns `<app-data>/annotations`. Not memoised — `TANDEM_APP_DATA_DIR` is
src/server/integrations/storage.ts:180: * `TANDEM_APP_DATA_DIR`), ACL inheritance may not restrict access to the
src/server/mcp/server.ts:135: * *resource* dir. But `index.ts` opens `path.join(process.env.TANDEM_DATA_DIR ||
src/server/mcp/server.ts:137: * `TANDEM_DATA_DIR` to the app-data dir and copies `sample/*` into it. So on a
src/server/mcp/server.ts:152:  const dataDir = process.env.TANDEM_DATA_DIR?.trim();
src/server/mcp/routes/diagnostics.ts:96: * `TANDEM_APP_DATA_DIR`, `XDG_DATA_HOME` and `LOCALAPPDATA`, any of which can
src/shared/scrub-text.ts:18: * `$USERPROFILE`, `TANDEM_APP_DATA_DIR`, `XDG_DATA_HOME`, `LOCALAPPDATA`) and so
src/shared/redact-user-paths.ts:11: *     Tandem's app-data dir honours `TANDEM_APP_DATA_DIR`, `XDG_DATA_HOME` and
src/shared/redact-user-paths.ts:116:    { path: env.TANDEM_APP_DATA_DIR ?? "", as: "<app-data>" },
src/cli/doctor.ts:2434:  const override = process.env.TANDEM_APP_DATA_DIR;
src/cli/doctor.ts:2473:  "Windows credential hash. Point TANDEM_APP_DATA_DIR (or your local app-data location) " +

=== saveCurrentSession / autosave interval ===
src/server/index.ts:36:  saveCurrentSession,
src/server/index.ts:220:    await saveCurrentSession();
src/server/mcp/document-service.ts:1520:export async function saveCurrentSession(): Promise<void> {

=== launcher/start route ===
src/server/index.ts
src/server/launcher/initial-reason.ts
src/server/launcher/api-routes.ts
src/server/mcp/server.ts
src/shared/api-paths.ts
src/shared/launcher/contract.ts

=== plugin-fs / plugin-shell usage in client ===
src/client/components/EditorSettings.svelte:109:  let openFn: typeof import("@tauri-apps/plugin-dialog").open;
src/client/components/EditorSettings.svelte:111:    ({ open: openFn } = await import("@tauri-apps/plugin-dialog"));
src/client/components/settings-tabs/SettingsClaudeCodeTab.svelte:206:  let openFn: typeof import("@tauri-apps/plugin-dialog").open;
src/client/components/settings-tabs/SettingsClaudeCodeTab.svelte:208:    ({ open: openFn } = await import("@tauri-apps/plugin-dialog"));
src/client/actions/builtin.svelte.ts:274:    const { save } = await import("@tauri-apps/plugin-dialog");
src/client/utils/browse-file.ts:16:  const { open } = await import("@tauri-apps/plugin-dialog");

119:    "@tauri-apps/api": "^2.11.0",
120:    "@tauri-apps/plugin-dialog": "^2.7.1",

=== refresh_registration callers ===
src-tauri/src/lib.rs:1486:                        autostart::refresh_registration(&refresh_handle);

=== Cargo.lock versions ===
name = "keyring"
version = "3.6.3"
name = "reqwest"
```

### R=$(ls -d ~/.cargo/registry/src/*/ | head -1); echo "=== cargo check log ===" && cat <scratchpad>/cargo-check.log | tail -30; echo; e
(output 2792 chars)
```
=== cargo check log ===
  cargo:rerun-if-env-changed=PKG_CONFIG_PATH
  cargo:rerun-if-env-changed=PKG_CONFIG_LIBDIR_x86_64-unknown-linux-gnu
  cargo:rerun-if-env-changed=PKG_CONFIG_LIBDIR_x86_64_unknown_linux_gnu
  cargo:rerun-if-env-changed=HOST_PKG_CONFIG_LIBDIR
  cargo:rerun-if-env-changed=PKG_CONFIG_LIBDIR
  cargo:rerun-if-env-changed=PKG_CONFIG_SYSROOT_DIR_x86_64-unknown-linux-gnu
  cargo:rerun-if-env-changed=PKG_CONFIG_SYSROOT_DIR_x86_64_unknown_linux_gnu
  cargo:rerun-if-env-changed=HOST_PKG_CONFIG_SYSROOT_DIR
  cargo:rerun-if-env-changed=PKG_CONFIG_SYSROOT_DIR

  --- stderr

  pkg-config exited with status code 1
  > PKG_CONFIG_ALLOW_SYSTEM_CFLAGS=1 pkg-config --libs --cflags gdk-3.0 'gdk-3.0 >= 3.22'

  pkg-config output:
    Package gdk-3.0 was not found in the pkg-config search path.
    Perhaps you should add the directory containing `gdk-3.0.pc'
    to the PKG_CONFIG_PATH environment variable
    Package 'gdk-3.0', required by 'virtual:world', not found
    Package 'gdk-3.0', required by 'virtual:world', not found

  The system library `gdk-3.0` required by crate `gdk-sys` was not found.
  The file `gdk-3.0.pc` needs to be installed and the PKG_CONFIG_PATH environment variable must contain its parent directory.
  The PKG_CONFIG_PATH environment variable is not set.

  HINT: if you have installed the library, try setting PKG_CONFIG_PATH to the directory containing `gdk-3.0.pc`.

warning: build failed, waiting for other jobs to finish...
EXIT: 101

=== tauri-plugin-shell new_sidecar ===
        Self {
            cmd: command,
            raw_out: false,
        }
    }

    pub(crate) fn new_sidecar<S: AsRef<Path>>(program: S) -> crate::Result<Self> {
        Ok(Self::new(relative_command_path(program.as_ref())?))
    }

    /// Appends an argument to the command.
    #[must_use]
    pub fn arg<S: AsRef<OsStr>>(mut self, arg: S) -> Self {
        self.cmd.arg(arg);
        self
    }

    /// Appends arguments to the command.
    #[must_use]
    pub fn args<I, S>(mut self, args: I) -> Self
    where
        I: IntoIterator<Item = S>,
        S: AsRef<OsStr>,
    {
        self.cmd.args(args);
        self
    }

    /// Clears the entire environment map for the child process.
    #[must_use]
    pub fn env_clear(mut self) -> Self {

=== tauri-bundler external binaries handling ===
ls: cannot access '/root/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f//tauri-bundler-*': No such file or directory
grep: /root/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f//tauri-bundler-*/src/bundle/settings.rs: No such file or directory

=== tauri-bundler nsis: deleteAppData / installMode ===
grep: /root/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f//tauri-bundler-*/src/bundle/windows/nsis/installer.nsi: No such file or directory
```
