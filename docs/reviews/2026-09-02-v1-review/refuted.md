# Claims that did not hold

Each was raised by a reviewer or an earlier pass and checked before filing. None was filed. A
future session that rediscovers one of these should re-check the cited line before reopening it;
the line numbers are as of `3fb6408`.

| Claim | Raised by | Why it does not hold | Checked by |
|---|---|---|---|
| The E2E MCP helper swallows `isError`, making every E2E precondition unfalsifiable. | tests reviewer | `tests/e2e/helpers.ts:70-74` throws on `result.isError`. | orchestrator, `sed` |
| Session-key path traversal through `sessions/delete`. | security reviewer | The key is `encodeURIComponent(path)` (`src/server/session/manager.ts:29-30`); no separator survives. | orchestrator, `sed` |
| The client settings merge is `__proto__`-pollutable. | security reviewer | `useTandemSettings.ts:658-700` is `JSON.parse` plus object spread; no deep merge, no assignment by key. | orchestrator, `sed` |
| README names the wrong Settings tab for Cowork. | docs reviewer | `README.md:191` says "Settings → AI Assistant"; `SettingsModal.svelte:151-153` labels `SettingsClaudeCodeTab` "AI Assistant" and that tab mounts `CoworkSettings` at `:472-481`. | Sonnet B, then orchestrator |
| Static file traversal serves real files. | security reviewer | Every traversal-shaped path returns the SPA `index.html` byte-identical (`server.ts:824-834`), live-probed on 4918/4919. Residue: phantom 200s for status-only scanners (Low, in #1822). | Opus F, live |
| `welcome.md` promises heading collapse that does not exist. | docs reviewer | `src/client/editor/extensions/heading-collapse.ts` exists and is tested; it is only absent from the Outline panel. | Sonnet B |
| Escaped `\|` in table cells breaks the round-trip. | server-data reviewer | Round-trips (`experiments/e3-table.ts`, `ul3.ts`); only the delimiter row changes cosmetically. Side note in #1823: an unescaped `\|` inside a code span splits cells. | Opus E, then orchestrator |
| A hard break inside a heading miscounts offsets. | crdt reviewer | One flat character, rendered as a space by `document-model.ts:311`; the guard is live (`experiments/e4-heading.ts`). A setext-heading hard break is lost on save (Low, #1823). | Opus E, then orchestrator |
| `w:tab` shifts Word comment offsets. | server-data reviewer | Tabs count correctly (`experiments/e1-docx.ts` case 2c). The real drift is empty paragraphs (+1) and page breaks (−1), filed as #1754. | orchestrator, re-run |

## Leads closed as fine (no finding)

- The file-deleted-while-open toast exists (`builtin.svelte.ts:453,536`).
- The DocumentHealth panel is reachable only from the dev harness; its "No analysis available."
  copy is dead UI, not a user-facing gap.
- `fs:default` in the Tauri capabilities has no scope entries; `$APPLOG` is not referenced.
- Uninstall keeps app data and logs, and the docs say so.
- The plugin's unconditional `tandem-channel` entry is a recorded decision (`docs/decisions.md:378`,
  verdict KEEP, 2026-08-08); the inert-consumer rationale is merely unreconciled in
  `architecture.md` (Low).
- `run_acceptance_tests.py` fails non-zero on zero-collected and on all-skipped.
- `linux-runtime-deps` `isEnabled` is true for the checked-in `Cargo.toml`, so its positive
  assertions run.
- The undo manager uses y-prosemirror defaults (`trackedOrigins = ySyncPluginKey`,
  `captureTimeout` 500 ms), so remote changes are excluded from undo.
- `#1656` appears already fixed (`awareness.ts:632` has the note gate); close it with a pin.
- `linkOnPaste` default is true; the panel divider has full keyboard support; the uninstall log path
  in the docs is exact; the licensing `reason` enum matches the worker 5/5.
- `#1320`'s simple-request CSRF fix is live: a `text/plain` POST to `/api/save` with no Origin is
  refused 403; `Origin: http://localhost:5173` is also refused, deliberately (#1307), and no doc
  tells a user to open `localhost:5173`.

## Downgraded, not refuted

- `activity.cursor` "documented as flat": no doc states a coordinate system for `cursor`, so #1776
  is a doc omission plus a naming trap, not a contradiction. The bug (PM position published where
  flat offsets are expected) stands.
- The tests reviewer's premise that `architecture.md` cites the wrong watcher module was wrong;
  `architecture.md` cites `file-watcher.ts` correctly. CLAUDE.md is the one that names only
  `documents/watcher.ts` (in #1821).
