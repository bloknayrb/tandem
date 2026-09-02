# Upgrade / migration path — coverage manifest

## 1. On-disk state migrations
- src/server/session/** (session file read/write, version fields)
- src/shared/annotations* / sanitizeAnnotation, legacy envelope shapes
- .annotations.md / .annotations.json sidecar export/import
- src/client/hooks/useTandemSettings.ts + any server settings store
- backups dir, recents, trial/license files (src/server/license/)
- downgrade: newer file read by older code

## 2. First run after upgrade
- "last seen version" mechanism (CHANGELOG.md read-only open)
- Tauri sidecar path vs npm path
- missing CHANGELOG in bundle; unwritable app data dir

## 3. #1118 post-update banner
- detection of "just updated", false positives, fresh install, downgrade

## 4. Plugin / skill / integration refresh
- src/cli/apply.ts, setup command, pinned plugin versions
- skills/tandem/SKILL.md frontmatter version compare
- MCP server entries in Claude Code / Desktop / Cowork configs
- older tandem binary clobbering a newer skill

## 5. Tauri updater
- src-tauri/src/lib.rs check_for_update / install_update
- src-tauri/tauri.conf.json updater section
- .github/workflows/tauri-release.yml latest.json
- sidecar replacement, relaunch, LAUNCHER_DEFERRED

## 6. Cross-version compatibility
- old stdio bridge vs new server (already ledgered — new aspects only)
- new desktop app vs old npm server on ports / vice versa (generationId)
- old skill vs new tools (30 active + 3 deprecated stubs)
- Y.Doc / session file format across Yjs versions

## 7. Uninstall / rollback
- documented downgrade path, state survival
