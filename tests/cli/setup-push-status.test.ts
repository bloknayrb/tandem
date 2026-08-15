/**
 * `tandem setup`'s push-notification report, rendered (#1390).
 *
 * `tests/plugin-manifest.test.ts` pins the CONTENTS of
 * `CLAUDE_PLUGIN_INSTALL_COMMANDS` against the manifests. Nothing pinned the
 * RENDER — and the render is the whole of #1390, whose defect was precisely
 * that a surface failed to show these commands. A dropped indent, a lost
 * newline, or a `.join("")` that stopped producing one line per command prints
 * silently-wrong setup instructions, and `tandem setup` is the only surface
 * that ever printed them before the wizard did.
 *
 * Asserted on stderr, not stdout: Critical Rule 3 reserves stdout for the MCP
 * wire, and `console.error` is what the whole CLI report already uses.
 */

import { afterEach, describe, expect, it, vi } from "vitest";

import { printPushStatus } from "../../src/cli/setup";
import { CLAUDE_PLUGIN_INSTALL_COMMANDS } from "../../src/shared/constants";

function capture(shimRegisteredFor: string[]): string {
  const spy = vi.spyOn(console, "error").mockImplementation(() => {});
  printPushStatus(shimRegisteredFor);
  return spy.mock.calls.map((args) => args.join(" ")).join("\n");
}

describe("printPushStatus — plugin install commands (#1390)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  for (const registeredFor of [[], ["claude-code"]]) {
    const branch = registeredFor.length > 0 ? "shim registered" : "no shim";

    it(`prints every install command on its own indented line — ${branch}`, () => {
      const out = capture(registeredFor);
      for (const cmd of CLAUDE_PLUGIN_INSTALL_COMMANDS) {
        // The indent is part of the contract: these sit in a block the user
        // reads as a copyable pair, not as prose.
        expect(out).toContain(`    ${cmd}\n`);
      }
    });

    it(`keeps the commands in manifest order — ${branch}`, () => {
      // `marketplace add` before `plugin install`: the second fails outright if
      // the first has not run, so a reorder is a broken instruction rather than
      // a cosmetic one.
      const out = capture(registeredFor);
      const positions = CLAUDE_PLUGIN_INSTALL_COMMANDS.map((cmd) => out.indexOf(cmd));
      expect(positions.every((p) => p >= 0)).toBe(true);
      expect([...positions]).toEqual([...positions].sort((a, b) => a - b));
    });
  }

  it("names the version floor beside the commands", () => {
    // Below 2.1.212 the install succeeds and the monitor never runs, with
    // nothing to say so. The wizard carries the same floor; this is the CLI's
    // half of that claim.
    expect(capture([])).toContain("2.1.212");
  });
});
