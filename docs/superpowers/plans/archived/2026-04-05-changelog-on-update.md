# Changelog Tab on Update — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Open CHANGELOG.md as the active tab when Tandem detects a version upgrade on startup.

**Architecture:** A `last-seen-version` file in the platform data directory tracks the last version the user ran. On HTTP-mode startup, after Hocuspocus is up, compare the stored version to `APP_VERSION`. On first install (no file), write the version and skip. On upgrade (file differs), open CHANGELOG.md and update the file.

**Tech Stack:** Node.js fs, env-paths (already used), existing `openFileByPath`

**Spec:** `docs/superpowers/specs/2026-04-05-changelog-on-update-design.md`

---

### File Map

| File | Action | Responsibility |
|------|--------|---------------|
| `src/server/platform.ts` | Modify | Export `LAST_SEEN_VERSION_FILE` constant |
| `src/server/index.ts` | Modify | Version check + changelog open in HTTP branch |
| `package.json` | Modify | Add `CHANGELOG.md` to `files` array |
| `CHANGELOG.md` | Modify | Add missing version entries |
| `tests/server/changelog-on-update.test.ts` | Create | Test version check logic |

---

### Task 1: Export version file path from platform.ts

**Files:**
- Modify: `src/server/platform.ts:9`

- [ ] **Step 1: Add the constant**

After the existing `SESSION_DIR` export (line 9), add:

```typescript
/** Path to the file tracking the last version the user ran. */
export const LAST_SEEN_VERSION_FILE = path.join(paths.data, "last-seen-version");
```

- [ ] **Step 2: Verify typecheck**

Run: `npm run typecheck`
Expected: Clean (no errors)

- [ ] **Step 3: Commit**

```bash
git add src/server/platform.ts
git commit -m "feat(server): export LAST_SEEN_VERSION_FILE from platform.ts"
```

---

### Task 2: Write the version check helper (TDD)

**Files:**
- Create: `tests/server/changelog-on-update.test.ts`
- Create: `src/server/version-check.ts`

- [ ] **Step 1: Write failing tests**

```typescript
import { describe, it, expect, afterEach } from "vitest";
import fs from "fs/promises";
import path from "path";
import os from "os";

// The function under test — will be created in step 3
import { checkVersionChange } from "../../src/server/version-check.js";

let tmpDir: string | null = null;

async function makeTmpDir(): Promise<string> {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "tandem-ver-test-"));
  return tmpDir;
}

afterEach(async () => {
  if (tmpDir) {
    await fs.rm(tmpDir, { recursive: true, force: true });
    tmpDir = null;
  }
});

describe("checkVersionChange", () => {
  it("returns 'first-install' and writes version when file does not exist", async () => {
    const dir = await makeTmpDir();
    const versionFile = path.join(dir, "last-seen-version");

    const result = await checkVersionChange("0.2.7", versionFile);

    expect(result).toBe("first-install");
    const written = await fs.readFile(versionFile, "utf-8");
    expect(written.trim()).toBe("0.2.7");
  });

  it("returns 'upgraded' and writes version when file has older version", async () => {
    const dir = await makeTmpDir();
    const versionFile = path.join(dir, "last-seen-version");
    await fs.writeFile(versionFile, "0.2.6");

    const result = await checkVersionChange("0.2.7", versionFile);

    expect(result).toBe("upgraded");
    const written = await fs.readFile(versionFile, "utf-8");
    expect(written.trim()).toBe("0.2.7");
  });

  it("returns 'current' when file matches version", async () => {
    const dir = await makeTmpDir();
    const versionFile = path.join(dir, "last-seen-version");
    await fs.writeFile(versionFile, "0.2.7");

    const result = await checkVersionChange("0.2.7", versionFile);

    expect(result).toBe("current");
  });

  it("trims whitespace from stored version before comparing", async () => {
    const dir = await makeTmpDir();
    const versionFile = path.join(dir, "last-seen-version");
    await fs.writeFile(versionFile, "0.2.7\n");

    const result = await checkVersionChange("0.2.7", versionFile);

    expect(result).toBe("current");
  });

  it("creates parent directory if it does not exist", async () => {
    const dir = await makeTmpDir();
    const nested = path.join(dir, "nested", "deep");
    const versionFile = path.join(nested, "last-seen-version");

    const result = await checkVersionChange("0.2.7", versionFile);

    expect(result).toBe("first-install");
    const written = await fs.readFile(versionFile, "utf-8");
    expect(written.trim()).toBe("0.2.7");
  });

  it("returns 'upgraded' on downgrade (treats any mismatch as upgrade)", async () => {
    const dir = await makeTmpDir();
    const versionFile = path.join(dir, "last-seen-version");
    await fs.writeFile(versionFile, "0.2.8");

    const result = await checkVersionChange("0.2.7", versionFile);

    expect(result).toBe("upgraded");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/server/changelog-on-update.test.ts`
Expected: FAIL — cannot resolve `../../src/server/version-check.js`

- [ ] **Step 3: Write the implementation**

Create `src/server/version-check.ts`:

```typescript
import fs from "fs/promises";
import path from "path";

export type VersionCheckResult = "first-install" | "upgraded" | "current";

/**
 * Compare the running version against the stored last-seen version.
 * Returns the transition type so the caller can decide what to do.
 * Always writes the current version on first-install or upgrade.
 */
export async function checkVersionChange(
  currentVersion: string,
  versionFilePath: string,
): Promise<VersionCheckResult> {
  let storedVersion: string | null = null;
  try {
    storedVersion = (await fs.readFile(versionFilePath, "utf-8")).trim();
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      console.error("[Tandem] Failed to read last-seen-version:", err);
    }
    // ENOENT = first install, anything else = treat as first install too
  }

  const result: VersionCheckResult =
    storedVersion === null ? "first-install" : storedVersion === currentVersion ? "current" : "upgraded";

  if (result !== "current") {
    await fs.mkdir(path.dirname(versionFilePath), { recursive: true });
    await fs.writeFile(versionFilePath, currentVersion, "utf-8");
  }

  return result;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/server/changelog-on-update.test.ts`
Expected: 6 tests PASS

- [ ] **Step 5: Run typecheck**

Run: `npm run typecheck`
Expected: Clean

- [ ] **Step 6: Commit**

```bash
git add src/server/version-check.ts tests/server/changelog-on-update.test.ts
git commit -m "feat(server): add checkVersionChange helper with tests"
```

---

### Task 3: Wire up changelog open in startup

**Files:**
- Modify: `src/server/index.ts:178-198`

- [ ] **Step 1: Add imports**

At the top of `src/server/index.ts`, add to the existing imports:

```typescript
import { LAST_SEEN_VERSION_FILE } from "./platform.js";
import { checkVersionChange } from "./version-check.js";
```

(`fs` is already imported as `fs/promises` elsewhere — check. If not, add `import fs from "fs/promises";`. Actually, `index.ts` doesn't import fs. But we don't need it — `checkVersionChange` handles all file I/O internally.)

- [ ] **Step 2: Add version check after Hocuspocus starts, before welcome.md block**

Insert between `httpServer = srv;` (line 178) and the `// Auto-open sample/welcome.md` block (line 180):

```typescript
    // Open CHANGELOG.md as active tab on first startup after an update
    try {
      const versionStatus = await checkVersionChange(APP_VERSION, LAST_SEEN_VERSION_FILE);
      if (versionStatus === "upgraded") {
        const changelogPath = path.resolve(
          path.dirname(fileURLToPath(import.meta.url)),
          "../../CHANGELOG.md",
        );
        await openFileByPath(changelogPath);
        console.error(`[Tandem] Opened CHANGELOG.md (upgraded to v${APP_VERSION})`);
      }
    } catch (err) {
      console.error("[Tandem] Version check / changelog open failed (non-fatal):", err);
    }
```

- [ ] **Step 3: Run typecheck**

Run: `npm run typecheck`
Expected: Clean

- [ ] **Step 4: Run all tests**

Run: `npm test`
Expected: All pass (the new code only runs during real server startup, not in unit tests)

- [ ] **Step 5: Commit**

```bash
git add src/server/index.ts
git commit -m "feat(server): open CHANGELOG.md on version upgrade"
```

---

### Task 4: Add CHANGELOG.md to npm package and update entries

**Files:**
- Modify: `package.json:18-21`
- Modify: `CHANGELOG.md`

- [ ] **Step 1: Add CHANGELOG.md to files array**

In `package.json`, change:
```json
"files": [
  "dist/",
  "sample/"
],
```
to:
```json
"files": [
  "dist/",
  "sample/",
  "CHANGELOG.md"
],
```

- [ ] **Step 2: Update CHANGELOG.md with missing entries**

Add entries for versions 0.2.4 through 0.2.7 at the top (after the header, before existing entries):

```markdown
## [0.2.7] - 2026-04-05

### Fixed

- Force-reload (`tandem_open` with `force: true`) now clears Y.Doc in-place instead of destroying the Hocuspocus room — sidebar, observers, and connections survive
- TOCTOU fix: session deletion moved after successful reload transaction
- Observer ownership table corrected in architecture docs

### Added

- 4 new tests for force-reload (annotation clearing, awareness clearing, .txt reload, metadata)
- Changelog opens as active tab on first startup after an npm update

## [0.2.6] - 2026-04-05

### Fixed

- Demo script rewritten to be self-referential for recording
- Observer ownership documentation added to architecture.md

## [0.2.5] - 2026-04-05

### Fixed

- `tandem setup` Claude Code MCP config path updated

## [0.2.4] - 2026-04-05

### Fixed

- Security audit findings (DNS rebinding, CORS, input validation)
```

- [ ] **Step 3: Verify CHANGELOG.md is in the tarball**

Run: `npm pack --dry-run 2>&1 | grep CHANGELOG`
Expected: Output includes `CHANGELOG.md`

- [ ] **Step 4: Commit**

```bash
git add package.json CHANGELOG.md
git commit -m "chore: add CHANGELOG.md to npm package with missing version entries"
```

---

### Task 5: Manual verification

- [ ] **Step 1: Delete the version file if it exists**

```bash
rm -f "$LOCALAPPDATA/tandem/Data/last-seen-version"
```

- [ ] **Step 2: Start the server**

Run: `npm run dev:standalone`
Expected: Welcome.md opens (first install path). Check that `%LOCALAPPDATA%\tandem\Data\last-seen-version` now contains `0.2.7`.

- [ ] **Step 3: Simulate an upgrade**

Edit `last-seen-version` to contain `0.2.6`. Restart the server.
Expected: CHANGELOG.md opens as the active tab. Console shows `[Tandem] Opened CHANGELOG.md (upgraded to v0.2.7)`.

- [ ] **Step 4: Restart again**

Expected: CHANGELOG.md does NOT open. Normal startup with restored session.

- [ ] **Step 5: Run full test suite**

Run: `npm test`
Expected: All tests pass.
