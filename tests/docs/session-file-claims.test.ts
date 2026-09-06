import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CTRL_ROOM, SUPPORTED_EXTENSIONS } from "../../src/shared/constants.js";

/**
 * #1782: `docs/troubleshooting.md` and `docs/configuration.md` named a
 * cross-document session file `CTRL_ROOM.json` — `CTRL_ROOM` is a Y.Doc room
 * name, not a file name, and the session manager writes the raw (unencoded)
 * string, producing `__tandem_ctrl__.json` on disk. Derive the true name from
 * the constant so a future `CTRL_ROOM` rename fails this test instead of
 * drifting the docs silently again.
 */

const REPO_ROOT = join(import.meta.dirname, "..", "..");

const CLAIMING_FILES = ["docs/troubleshooting.md", "docs/configuration.md"];

function read(rel: string): string {
  return readFileSync(join(REPO_ROOT, rel), "utf-8");
}

describe("session/config file-name claims (#1782)", () => {
  it("the raw CTRL_ROOM shape needs no encoding (sanity check)", () => {
    const raw = `${CTRL_ROOM}.json`;
    expect(raw).toBe(`${encodeURIComponent(CTRL_ROOM)}.json`);
  });

  it.each(CLAIMING_FILES)("%s names the real on-disk ctrl-room session file", (rel) => {
    const doc = read(rel);
    const raw = `${CTRL_ROOM}.json`;
    expect(doc, `${rel} does not contain "${raw}"`).toContain(raw);
  });

  it.each(CLAIMING_FILES)("%s does not still name the wrong CTRL_ROOM.json", (rel) => {
    const doc = read(rel);
    expect(doc).not.toContain("CTRL_ROOM.json");
  });

  it("docs/troubleshooting.md lists every SUPPORTED_EXTENSIONS member as a backticked token", () => {
    const doc = read("docs/troubleshooting.md");
    const line = /^Tandem opens.*$/m.exec(doc)?.[0];
    expect(line, "docs/troubleshooting.md has no 'Tandem opens ...' line").toBeDefined();

    for (const ext of SUPPORTED_EXTENSIONS) {
      expect(line, `expected the backticked token \`${ext}\` in: ${line}`).toContain(`\`${ext}\``);
    }
  });

  it.each(
    CLAIMING_FILES,
  )("%s states the full quarantine-rename shape, not the bare suffix", (rel) => {
    const doc = read(rel);
    expect(doc, `${rel} does not contain the full quarantine shape`).toContain(
      ".json.corrupt.<timestamp>",
    );
    expect(doc, `${rel} still contains the bare .corrupt.json shape`).not.toContain(
      "`.corrupt.json`",
    );
  });
});
