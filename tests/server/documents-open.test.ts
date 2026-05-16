/**
 * Tests for the ADR-034 named file-open seam.
 *
 * Part 1/N is an additive re-export module. The behaviour assertions
 * here cover:
 *   - `openFromDisk` / `openFromUpload` / `openScratchpad` reference the
 *     same callable identities as the underlying file-opener exports.
 *   - `kindOfOpenResult` correctly tags every `OpenFileResult` shape.
 *
 * Behaviour-level tests of the open-pipelines themselves live in
 * `file-opener-*.test.ts`; this file only covers the seam.
 */

import { describe, expect, it } from "vitest";
import {
  kindOfOpenResult,
  openFromDisk,
  openFromUpload,
  openScratchpad,
} from "../../src/server/documents/open.js";
import {
  openScratchpad as fileOpenerScratchpad,
  type OpenFileResult,
  openFileByPath,
  openFileFromContent,
} from "../../src/server/mcp/file-opener.js";

describe("named entry points (ADR-034 seam)", () => {
  it("openFromDisk === openFileByPath", () => {
    expect(openFromDisk).toBe(openFileByPath);
  });

  it("openFromUpload === openFileFromContent", () => {
    expect(openFromUpload).toBe(openFileFromContent);
  });

  it("openScratchpad re-export matches the file-opener export", () => {
    expect(openScratchpad).toBe(fileOpenerScratchpad);
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
