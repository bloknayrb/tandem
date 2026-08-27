/**
 * Tests for the ADR-034 named file-open seam.
 *
 * This file used to assert `openFromDisk === openFileByPath`, and the two
 * siblings of that. Those assertions were true of a re-export and of nothing
 * else: they pass while the seam forwards, and go RED the moment Unit 7a moves
 * the implementation into this module — which is the change they sit in front
 * of. An assertion that fails on the intended refactor and passes on every
 * behavioural break is worse than none.
 *
 * What replaces them:
 *   - **Outcome.** Calling through the seam opens a real document, with the
 *     `source` each entry point is supposed to produce.
 *   - **The redirect invariant.** No module under `src/` may import the disk,
 *     upload or scratchpad entry points from `mcp/file-opener.ts` directly.
 *     That is Unit 6's actual deliverable, and nothing else observes it — a
 *     new route importing `openFileByPath` would work perfectly and quietly
 *     put the seam back to zero production consumers.
 *
 * Broader behaviour of the open pipelines is characterized in
 * `adr-034-open-characterization.test.ts`.
 */

import fs from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../src/server/platform", async (importOriginal) => {
  const original = await importOriginal<typeof import("../../src/server/platform")>();
  const osMod = await import("os");
  const pathMod = await import("path");
  const cryptoMod = await import("crypto");
  const appDataDir = pathMod.join(osMod.tmpdir(), `tandem-seam-${cryptoMod.randomUUID()}`);
  process.env.TANDEM_APP_DATA_DIR = appDataDir;
  return { ...original, SESSION_DIR: pathMod.join(appDataDir, "sessions") };
});

import {
  kindOfOpenResult,
  openFromUpload,
  openScratchpad,
} from "../../src/server/documents/open.js";
import { removeDoc, setActiveDocId } from "../../src/server/documents/registry-testing.js";
import { getOpenDocs } from "../../src/server/mcp/document-service.js";
import type { OpenFileResult } from "../../src/server/mcp/file-opener.js";
import { removeDocument } from "../../src/server/yjs/provider.js";

describe("named entry points (ADR-034 seam)", () => {
  beforeEach(() => {
    for (const id of [...getOpenDocs().keys()]) {
      removeDoc(id);
      removeDocument(id);
    }
    setActiveDocId(null);
  });

  it("openFromUpload opens a tracked document with upload provenance", async () => {
    const result = await openFromUpload("seam.md", "# Seam\n");

    expect(result.source, "provenance drives dirty-mirror and rename affordances").toBe("upload");
    expect(getOpenDocs().get(result.documentId)?.source).toBe("upload");
  });

  it("openScratchpad seeds the buffer it is given", async () => {
    // The header used to say this entry opens "an empty" buffer. It has taken
    // optional content since #979, and a caller trusting the old wording would
    // seed nothing.
    const result = await openScratchpad("# Seeded\n");
    const { extractText } = await import("../../src/server/mcp/document.js");
    const { getOrCreateDocument } = await import("../../src/server/yjs/provider.js");

    expect(extractText(getOrCreateDocument(result.documentId))).toContain("Seeded");
  });
});

describe("the redirect invariant (Unit 6)", () => {
  const ENTRIES = ["openFileByPath", "openFileFromContent", "openScratchpad"];

  it("no module under src/ imports the three entry points from file-opener directly", async () => {
    const srcRoot = path.resolve(fileURLToPath(import.meta.url), "../../../src");
    const seam = path.join(srcRoot, "server", "documents", "open.ts");
    const impl = path.join(srcRoot, "server", "mcp", "file-opener.ts");

    async function walk(dir: string): Promise<string[]> {
      const out: string[] = [];
      for (const e of await fs.readdir(dir, { withFileTypes: true })) {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) out.push(...(await walk(full)));
        else if (/\.(ts|svelte)$/.test(e.name)) out.push(full);
      }
      return out;
    }

    const files = await walk(srcRoot);
    // Positive anchor: an empty or near-empty sweep satisfies "nothing imports
    // it" vacuously, which is how this class of guard usually dies.
    expect(files.length, "control: the sweep found the source tree").toBeGreaterThan(50);
    expect(files, "control: the seam and its implementation are both in scope").toEqual(
      expect.arrayContaining([seam, impl]),
    );

    const offenders: string[] = [];
    for (const file of files) {
      if (file === seam || file === impl) continue;
      const body = await fs.readFile(file, "utf8");
      // Both static and dynamic imports — restore's `await import(...)` in
      // document-service is exactly the shape a redirect could quietly regrow.
      const matches = [
        // Static: `import { x } from ".../file-opener.js"`.
        ...body.matchAll(/import\s*\{([^}]*)\}\s*from\s*["'][^"']*file-opener\.js["']/g),
        // Dynamic: `const { x } = await import(".../file-opener.js")` — the
        // shape restore uses, and exactly the one a redirect could regrow
        // without any static import appearing anywhere.
        ...body.matchAll(
          /(?:const|let|var)\s*\{([^}\n]*)\}\s*=\s*await import\(\s*["'][^"']*file-opener\.js["']\s*\)/g,
        ),
      ];
      for (const m of matches) {
        for (const spec of m[1].split(",")) {
          // Both rename spellings, because they are different syntax for the
          // same evasion: `import { x as y }` uses `as`, and destructuring a
          // dynamic import — `const { x: y } = await import(...)` — uses `:`.
          // Splitting on `as` alone let the second one through.
          const name = spec
            .trim()
            .split(/[\s:]+/)[0]
            ?.trim();
          if (ENTRIES.includes(name)) {
            // Separator-normalized: the same source tree must not report a
            // different offender list on Windows than on CI's Linux runner.
            offenders.push(`${path.relative(srcRoot, file).replace(/\\/g, "/")} → ${name}`);
          }
        }
      }
    }

    expect(
      offenders,
      "these must import from documents/open.js instead — restore is the one sanctioned exception and it imports openFileByPath, so if it appears here the exception needs writing down",
    ).toEqual(["server/mcp/document-service.ts → openFileByPath"]);
  });
});

describe("kindOfOpenResult", () => {
  function baseResult(overrides: Partial<OpenFileResult>): OpenFileResult {
    return {
      documentId: "doc-1",
      filePath: "/tmp/doc-1.md",
      fileName: "doc-1.md",
      format: "md",
      readOnly: false,
      source: "file",
      tokenEstimate: 0,
      pageEstimate: 0,
      restoredFromSession: false,
      alreadyOpen: false,
      forceReloaded: false,
      ...overrides,
    };
  }

  it("returns 'force-reloaded' when forceReloaded is true (highest priority)", () => {
    expect(
      kindOfOpenResult(
        baseResult({ forceReloaded: true, alreadyOpen: true, restoredFromSession: true }),
      ),
    ).toBe("force-reloaded");
  });

  it("returns 'already-open' when alreadyOpen is true but not force-reloaded", () => {
    expect(kindOfOpenResult(baseResult({ alreadyOpen: true, restoredFromSession: true }))).toBe(
      "already-open",
    );
  });

  it("returns 'restored' when only restoredFromSession is true", () => {
    expect(kindOfOpenResult(baseResult({ restoredFromSession: true }))).toBe("restored");
  });

  it("returns 'fresh' when none of the flags are set", () => {
    expect(kindOfOpenResult(baseResult({}))).toBe("fresh");
  });
});
