# Plan: Uninstall scrub extension + docs sweep (audit item 6)

Agent feedback incorporated — adversarial review (1 Critical, 4 Important, 2
Minor) applied below: MCP-config removal now reuses `detectTargets()` +
`applyConfig`'s removal machinery instead of `rewriteJson` (which lacks the
0o600/ACL, symlink, size-cap, and BOM guards `applyConfig` carries for exactly
these files); the wrong "MSIX enumerated by the Cowork walk" premise is
dropped; `rewriteJson`'s parse-error log line is redacted; per-step isolation
keeps the firewall step alive; skill-dir guard allowlists our own atomic-write
temps.

Last item of the "solid and usable for anybody" audit plan (Tier 3.8 + scope
notes). One PR off master.

## Problem

1. **Orphan MCP entries survive uninstall on every platform.** The wizard /
   `tandem setup --apply` writes `mcpServers.tandem` (and optionally
   `tandem-channel`) into `~/.claude.json` and the per-platform Claude Desktop
   config. The NSIS uninstall hook (`runUninstallScrub`) only removes Cowork
   plugin entries + firewall rules — it never touches `~/.claude.json` or
   `claude_desktop_config.json`. macOS/Linux/npm have no scrub at all. After
   uninstall, every Claude Code session on that machine retries a dead MCP
   server forever. `docs/roadmap.md` lists "no orphan `.claude.json` entries"
   as a v1.0 exit criterion.
2. **No data-locations / manual-cleanup doc.** State lives in ≥8 places
   (sessions, annotations, doc-backups, integrations.json, keychain, logs,
   `~/.claude.json`, desktop configs); none of it is enumerated anywhere a
   user can find.
3. **Troubleshooting gap**: "MCP shows connected but tools don't work" — the
   most confusing failure shape (config entry resolves, server absent/stale)
   has no FAQ.
4. **README**: never states the audience constraint plainly (needs Claude
   Code or another MCP client + a paid Claude plan; without one, Tandem is a
   plain markdown editor — ADR-038 by design). One sentence near the top.

## Changes

### 1. Extend `uninstall-scrub.ts` to MCP config entries (all platforms)

New step in `runUninstallScrub()` after the Cowork walk, before firewall.
**Reuse, don't copy** (review findings 1/3/4/7): enumerate targets with
`detectTargets()` from `integrations/apply.ts` (already covers `~/.claude.json`,
the three per-OS Claude Desktop configs, AND the Windows MSIX package path —
which the Cowork walk does NOT visit; it walks only
`local-agent-mode-sessions/`, a sibling of the MSIX config), and remove
entries via `applyConfig`'s existing `ops.remove: ["tandem", "tandem-channel"]`
machinery, which already carries everything the rewrite of a secrets file
needs: `assertPathSafe` symlink rejection, 5 MiB cap, BOM strip, atomic write
with `chmod 0o600` / `setRestrictiveAcl`, and preserves unrelated keys.

- Widen `ApplyOps` so a pure-removal call is expressible (today
  `McpEntries.tandem` is non-optional) — removal-only must not write a new
  `tandem` entry as a side effect, must not create a config file that doesn't
  exist, and must skip the backup/skill-install side paths if those are
  coupled in (verify while implementing).
- Key-by-name removal only (`tandem`, `tandem-channel`): these keys are owned
  by `buildMcpEntries` on every path; do not pattern-match values. Top-level
  `mcpServers` only — per-project `projects.*.mcpServers` / trust state in
  `~/.claude.json` is Claude Code's own, never Tandem-written.
- Remove the bundled skill dir `~/.claude/skills/tandem/` (written by
  `installSkill`): only if every file inside is allowlisted — `SKILL.md` plus
  our own orphaned atomic-write temps (`.tandem-setup-*.tmp` pattern from
  `atomicWrite`) — otherwise leave it and log. Note: if the npm install
  survives and is used again, `refreshSkillIfStale` recreates the skill at
  next start; correct behavior.
- **Per-step isolation** (review finding 5): each target wrapped in its own
  try/catch (warn, count, continue) so a throw can never skip the firewall
  step. Restructure the current non-win32 early return: Cowork walk +
  firewall stay win32-gated; the MCP scrub + skill dir run on every platform.
- Unparseable JSON = skip-and-continue, and the log line carries the path +
  "invalid JSON" ONLY — never the parse-error message (`~/.claude.json` and
  the Cowork files hold bearer tokens; V8 SyntaxError messages embed source
  snippets). This also means **fixing the existing `rewriteJson` warn line**,
  which interpolates `err.message` today (uninstall-scrub.ts:206).
- Exit contract unchanged: 0 on clean-or-not-installed; real I/O failure → 1
  (NSIS only logs it; manual runs get a truthful signal).

**Out of scope, deliberately:** deleting app data (sessions, annotations,
doc-backups, keychain). The scrub removes *references to a binary that no
longer exists*; user data stays unless the user deletes it (documented in the
new data-locations page). Keychain entries are inert without integrations.json
and removing them from a CLI invoked mid-uninstall risks OS keychain prompts.

### 2. Make the scrub reachable on macOS/Linux/npm

- Document `--uninstall-scrub` in `tandem --help` (today it's hidden).
- No npm `preuninstall` hook (unreliable, runs on upgrade too) and no
  macOS/Linux bundle hooks exist in Tauri's config — instead the data-locations
  doc tells users to run `tandem --uninstall-scrub` *before* removing the app
  / `npm uninstall -g`, with manual key-removal instructions as the fallback
  for after-the-fact cleanup.

### 3. `docs/data-locations.md` (new)

Per-OS table of every state location: app data (`sessions/`, `annotations/`,
`doc-backups/`, `integrations.json`, `tandem_backups/`, `.broken-backups/`,
`last-seen-version`), logs (tauri-plugin-log dir, Windows uninstall.log),
keychain services (`tandem-integrations`, `tandem-models`), MCP config files
written outside app data (`~/.claude.json`, desktop configs, `~/.claude/skills/tandem/`),
browser localStorage keys. Plus: what `--uninstall-scrub` removes vs what it
leaves, and manual full-cleanup steps per OS. Linked from README + troubleshooting.

### 4. Troubleshooting FAQ

New section after "Claude Code says 'MCP failed to connect'": **"MCP shows
connected but Tandem tools fail"** — causes in likelihood order: server not
actually running (connection state is cached; tool call is the first real
round-trip), stale URL/port in `~/.claude.json` after a port change, rotated
token with an old `Authorization` header, orphan entry after uninstall/
reinstall. Fixes: `tandem doctor` / Copy Diagnostics, `/mcp` reconnect,
re-run the wizard or `tandem setup --apply`, link to data-locations for
manual entry surgery.

### 5. README freshness + audience sentence

- One plain sentence near the top: Tandem's AI side requires an MCP client —
  Claude Code by default — and a Claude subscription; without one it's a
  local markdown editor.
- One line on English-only UI (i18n absent, fine for v1.0).
- Quick stale-claims pass (explore agent found the top sections current;
  verify links + the "Who Tandem is for" section against shipped state).

## Tests

- Unit tests for the new scrub steps mirroring the existing
  `uninstall-scrub.test.ts` style: removes both keys from `~/.claude.json`
  fixture; preserves unrelated `mcpServers.*` and top-level keys; missing
  file no-op (and removal-only never CREATES the file); missing key no-op;
  malformed JSON skip-and-continue (and the log line contains no parse
  detail — assert on both the new path and the fixed `rewriteJson` line);
  a later step still runs after an earlier step throws (per-step isolation);
  skill-dir removal guard (unexpected file → leave intact; `SKILL.md` +
  orphaned `.tandem-setup-*.tmp` → removed); pure-removal `ApplyOps` widening
  (type-level + runtime: no `tandem` entry written back).
- `npm run typecheck` + full `npm test`. No client changes → no E2E.
- Manual: run `--uninstall-scrub` on this machine against a backed-up
  `~/.claude.json` copy in a temp HOME (never the real one mid-session).

## Verification of premises (done)

- Scrub today = Cowork plugin files + firewall only (`uninstall-scrub.ts:96-307`).
- `buildMcpEntries` always uses keys `tandem` / `tandem-channel` (`apply.ts:205-242`).
- No macOS/Linux uninstall hook exists (`tauri.conf.json` bundle section).
- Roadmap v1.0 exit criterion includes no-orphan-entries.
