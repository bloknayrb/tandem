# Changelog Tab on Update

## Context

When users update Tandem via npm, they have no way to see what changed. GitHub release notes exist but users who install via npm never visit them. The changelog should surface inside Tandem itself — after an update, the server opens `CHANGELOG.md` as the active tab on first startup.

## Design

### Version tracking

Store `lastSeenVersion` in the env-paths data directory (`paths.data` from `src/server/platform.ts` — resolves to `%LOCALAPPDATA%\tandem\Data\` on Windows, `~/.local/share/tandem/` on Linux, `~/Library/Application Support/tandem/` on macOS). The file is a plain text file containing just the version string (e.g., `0.2.7`), trimmed on read.

Export from `platform.ts`:
```typescript
export const LAST_SEEN_VERSION_FILE = path.join(paths.data, "last-seen-version");
```

### Startup check

**Scope: HTTP mode only.** Stdio mode has no browser — changelog tab would be invisible. Consistent with `sample/welcome.md` which is also HTTP-only.

**Placement:** In the HTTP branch of `src/server/index.ts`, after Hocuspocus starts and before the `sample/welcome.md` auto-open block. This keeps all auto-open logic in one place and follows the established pattern.

Logic:

1. Read `LAST_SEEN_VERSION_FILE` and `.trim()` the content.
2. **If the file does not exist** (first install): write `APP_VERSION` to the file and skip the changelog open. New users get the welcome tutorial, not the changelog.
3. **If the file exists but content differs from `APP_VERSION`** (upgrade or downgrade): resolve `CHANGELOG.md` path relative to the package root (same pattern as `sample/welcome.md` — `path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../CHANGELOG.md")`), call `openFileByPath(changelogPath)` (which sets it as the active tab via `setActiveDocId` internally), then write `APP_VERSION` to the file.
4. **If the file exists and content matches** (normal startup): do nothing.

Before writing the version file, ensure the data directory exists: `await fs.mkdir(path.dirname(LAST_SEEN_VERSION_FILE), { recursive: true })`.

If any step fails (file missing, write error), log and continue — this is a nice-to-have, never a blocker.

### Interaction with sample/welcome.md

On first install, the changelog is skipped (step 2 above), so `getOpenDocs().size` remains 0 and the welcome tutorial opens normally.

On upgrade with empty session, the changelog opens first, making `getOpenDocs().size === 1`, which suppresses the welcome tutorial. This is correct — an upgrading user doesn't need the tutorial.

On upgrade with restored session, the changelog opens on top of existing tabs as the active document. The restored session's active doc is intentionally overridden.

Downgrades (e.g., installing v0.2.6 after running v0.2.7) trigger one changelog show, which is acceptable — same UX as a normal upgrade.

### File publishing

Add `CHANGELOG.md` to the `files` array in `package.json` so it's included in the npm tarball.

### Changelog maintenance

CHANGELOG.md already exists and follows Keep a Changelog format. It needs entries for versions 0.2.4 through 0.2.7. Going forward, each version bump should include a changelog entry.

### What doesn't change

- Session restore works as before
- No postinstall script — this all happens server-side at startup
- Stdio mode is unaffected

## Files to modify

| File | Change |
|------|--------|
| `package.json` | Add `CHANGELOG.md` to `files` array |
| `src/server/platform.ts` | Export `LAST_SEEN_VERSION_FILE` constant |
| `src/server/index.ts` | Add version check + changelog open in HTTP branch, before welcome.md block |
| `CHANGELOG.md` | Add missing version entries (0.2.4–0.2.7) |

## Verification

1. Delete `%LOCALAPPDATA%\tandem\Data\last-seen-version` (or equivalent)
2. Run `npm run dev:standalone`
3. Confirm `last-seen-version` file is created with current version, and welcome.md opens (not changelog)
4. Edit `last-seen-version` to an older version (e.g., `0.2.6`), restart
5. Confirm CHANGELOG.md opens as the active tab
6. Restart again — confirm CHANGELOG.md does NOT open (version matches)
7. Run `npm pack` and verify CHANGELOG.md is in the tarball
