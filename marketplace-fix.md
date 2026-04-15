# Fix plugin marketplace validation errors

## Context

The `.claude-plugin/marketplace.json` currently declares `"source": {"source": "npm", "package": "tandem-editor"}`. The npm package `tandem-editor@0.5.0` does not include `.claude-plugin/` in its `files` array, so when Claude Desktop's plugin loader fetches the npm package and looks for `.claude-plugin/plugin.json` inside it, validation fails ("Some plugins in this marketplace have validation errors").

Additionally, `.claude-plugin/plugin.json` declares a `monitors` block that references `${CLAUDE_PLUGIN_ROOT}/dist/monitor/index.js`. `dist/` is gitignored, so even switching to a github source would produce a clone that is missing the monitor binary at runtime.

Goal: get the plugin to a state that validates and installs cleanly when a user runs `claude plugin marketplace add bloknayrb/tandem` followed by `claude plugin install tandem@tandem-editor`. This is Probe 6 of the Cowork MCP bridge plan (`docs/superpowers/plans/2026-04-14-cowork-mcp-bridge.md`). The monitor functionality is intentionally deferred — if this probe succeeds, we fall back to `tandem_checkInbox` polling, which is correct behavior.

## Changes required

### 1. `.claude-plugin/marketplace.json`

Replace the npm source with a github source pointing at this repo. After the edit the plugin entry should read:

```json
{
  "name": "tandem",
  "source": {
    "source": "github",
    "repo": "bloknayrb/tandem"
  },
  "description": "Edit and iterate on documents with Claude — no copy-paste, real-time push via plugin monitor"
}
```

Leave the top-level `name`, `owner`, and `metadata` fields unchanged.

### 2. `.claude-plugin/plugin.json`

Remove the entire `monitors` array. The resulting manifest should retain only `name`, `version`, `description`, `author`, `repository`, `license`, `keywords`, and `mcpServers`. Do not change `mcpServers` — it remains:

```json
"mcpServers": {
  "tandem": { "type": "http", "url": "http://localhost:3479/mcp" }
}
```

Do not bump the `version` field as part of this change. (Note: `plugin.json` currently declares `0.5.1` while `package.json` is on a later release; that mismatch predates this fix and is a separate cleanup.)

## Validation

Before committing, run:

```bash
claude plugin validate .
```

It should pass with no errors. If `claude plugin validate` is unavailable, at minimum confirm both JSON files parse:

```bash
node -e 'JSON.parse(require("fs").readFileSync(".claude-plugin/marketplace.json","utf-8"))'
node -e 'JSON.parse(require("fs").readFileSync(".claude-plugin/plugin.json","utf-8"))'
```

## Commit

Follow the repo's conventional-commit style (look at recent `git log --oneline -10` for scope conventions). Suggested message:

```
fix(plugin): switch marketplace to github source, drop unshipped monitors

The npm-sourced marketplace entry fails validation because
tandem-editor@0.5.0 excludes .claude-plugin/ from its published files.
Switch to a github source so the repo's plugin.json is authoritative.

Drop the monitors block from plugin.json: it references
dist/monitor/index.js, which is gitignored and therefore absent from the
cloned plugin install. Real-time push via the monitor is deferred — the
HTTP MCP entry alone is enough to probe whether Claude Desktop's plugin
loader surfaces the server to Cowork.

Refs: docs/superpowers/plans/2026-04-14-cowork-mcp-bridge.md (Probe 6)
```

Do not open a PR yet. Push the commit directly to `master` (or to a probe branch of your choice) so the marketplace retry in Claude Desktop picks it up immediately.

## Out of scope for this change

- Committing `dist/monitor/` to restore monitor support (deferred per plan)
- Fixing the npm publish `files` array to include `.claude-plugin/` (deferred; github source bypasses the need)
- Reconciling the `plugin.json` version vs. `package.json` version (separate cleanup)
- Any changes to `src/cli/setup.ts` or the broader MCP bridge plan — that work only starts once Probe 1 confirms stdio bridges into Cowork

## After the commit lands

1. Claude Desktop → Plugins → find the failed `tandem` marketplace entry → click **Retry**.
2. If sync succeeds, install the plugin from the marketplace.
3. Fully restart Claude Desktop: `taskkill /F /IM Claude.exe` then relaunch from the Start menu (watch for the tray icon — without a full restart, plugin changes don't load).
4. Make sure the tandem server is running on the host (`tandem` in a terminal, or the Tauri app launched).
5. In Cowork, ask: *"list every MCP tool whose name starts with tandem_"*.
6. Report the outcome:
   - Tools appear → Probe 6 passes, document the install flow, close out the bridge plan as docs-only.
   - Tools absent → plugin install worked but Cowork doesn't honor HTTP MCP entries from plugins either. Move on to Probe 1 (stdio echo server) per the plan.
