---
id: concept-file-watcher
type: concept
name: File watcher
last_verified: 2026-05-18
sources:
  - src/server/file-io/
  - docs/decisions.md#adr-034-file-open-pipeline-with-named-entry-points-and-shared-core
---

# File watcher

`fs.watch` on every open file; external edits trigger `reloadFromDisk` which replaces Y.Doc content under the `withReload` origin wrapper.

**Suppression at arrival, not delivery.** `suppressNextChange()` is consumed in the `fs.watch` callback (event arrival), not inside the debounce timer (event delivery). Consuming at delivery creates a race: an *external* edit arriving within the debounce window would consume the suppression token meant for the server's own write.

**Reload distinguishes from file-sync echoes.** A user editing the file in another editor → `reloadFromDisk` uses `withReload` (channel skips, durable-sync **persists** the re-anchored relRanges). A server-side save echoed back through the watcher → `withFileSync` (everything skips). See `concept-origin-contract`.

After `reloadFromDisk` swaps Y.Doc content, dead `Y.RelativePosition` anchors must be **stripped, not preserved** — `refreshRange` re-anchors annotations from the cached flat offset and deletes the stale `relRange` field.

Read-only documents (e.g., `CHANGELOG.md` opened by "View Changelog") bypass the 60s autosave timer to prevent round-tripping through `remark-stringify` and rewriting the file with escape noise (lesson #69, issue #605).
