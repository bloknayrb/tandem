import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildMcpEntries, STDIO_ENTRY_ENV_KEYS } from "../../src/server/integrations/apply.js";
import { validateTandemEntry } from "../../src/server/integrations/existing-config.js";
import {
  buildNpxStdioArgs,
  isCanonicalNpxStdioArgs,
} from "../../src/shared/integrations/npx-entry-spec.js";

/**
 * The three-way agreement between the writer, the validator and the boot sweep.
 *
 * Extracting the tuple into a shared leaf prevents TEXTUAL drift — three copies
 * of an array literal cannot silently diverge once there is one. It does nothing
 * about SEMANTIC drift, where the writer starts emitting a shape the readers no
 * longer recognise. That is what this file pins.
 *
 * **It is also the convergence rule's tracked criterion.** The boot sweep's
 * npx-convergence carries no sunset date, on the grounds that it is a permanent
 * rule rather than a migration — and that claim rests on a premise living in
 * code: `buildStdioTandemEntry` still emits this tuple as its fallback floor
 * today. If that ever stops being true, the rule becomes a migration with an end
 * date, and the first test below fails. A date in a comment would not have
 * noticed.
 */
describe("npx entry spec — writer, validator and sweep agree", () => {
  /**
   * The fallback tuple, obtained from the real writer rather than restated.
   *
   * Forced by pointing `stdioBridgePath` at a file that does not exist, which is
   * the same condition a desktop install without a bundled bridge hits.
   */
  const fallbackEntry = () =>
    buildMcpEntries("/fake/channel/index.js", {
      targetKind: "claude-desktop",
      stdioBridgePath: join("/definitely", "not", "here", "index.js"),
    }).tandem;

  it("still emits the bare-npx floor — the premise the no-sunset decision rests on", () => {
    const entry = fallbackEntry();
    expect(entry.command).toBe("npx");
    expect(Array.isArray(entry.args)).toBe(true);
  });

  it("emits a tuple the validator accepts", () => {
    // If this fails the wizard would flag Tandem's own freshly written entry as
    // `invalid-args` and pre-select `apply: "skip"` on it.
    expect(validateTandemEntry(fallbackEntry()).status).toBe("valid");
  });

  it("emits a tuple the sweep's predicate matches", () => {
    // If this fails the convergence rule silently stops recognising the exact
    // shape it exists to repair.
    expect(isCanonicalNpxStdioArgs(fallbackEntry().args)).toBe(true);
  });
});

describe("isCanonicalNpxStdioArgs", () => {
  it("accepts the unpinned spec and any exact pin, old or new", () => {
    // Version-agnostic ON PURPOSE. The pin records the writer's default at the
    // time of writing, not user intent — so treating an old pin as a reason to
    // refuse would decline precisely the entries an older Tandem wrote, which
    // are the ones most likely to be broken.
    for (const spec of ["tandem-editor", "tandem-editor@0.14.3", "tandem-editor@1.0.0-rc.1"]) {
      expect(isCanonicalNpxStdioArgs(buildNpxStdioArgs(spec))).toBe(true);
    }
  });

  it.each([
    ["a dist-tag", ["-y", "tandem-editor@latest", "mcp-stdio"]],
    ["a lookalike package", ["-y", "tandem-editor-evil", "mcp-stdio"]],
    ["a scoped lookalike", ["-y", "@evil/tandem-editor", "mcp-stdio"]],
    ["an extra flag", ["-y", "--silent", "tandem-editor", "mcp-stdio"]],
    ["a missing -y", ["tandem-editor", "mcp-stdio"]],
    ["the plugin's channel tuple", ["-y", "tandem-editor@0.22.1", "channel"]],
    ["a non-string spec", ["-y", 42, "mcp-stdio"]],
    ["not an array", "-y tandem-editor mcp-stdio"],
    ["nothing", undefined],
  ])("rejects %s", (_label, args) => {
    expect(isCanonicalNpxStdioArgs(args)).toBe(false);
  });

  it("matches by index, not by searching a joined string", () => {
    // A `join(" ").includes("mcp-stdio")` formulation would pass this. The arity
    // and index checks are what make the plugin's 3-arg `channel` tuple and a
    // flag-carrying hand-edit fail.
    expect(isCanonicalNpxStdioArgs(["mcp-stdio", "tandem-editor", "-y"])).toBe(false);
  });
});

describe("STDIO_ENTRY_ENV_KEYS", () => {
  it("is exactly what the writer emits — the link a shared constant cannot enforce", () => {
    // The boot sweep refuses to converge an entry carrying any other key, so if
    // the writer grows a third one this set must grow with it. Otherwise the gate
    // silently starts declining entries Tandem itself wrote.
    const entry = buildMcpEntries("/fake/channel/index.js", {
      targetKind: "claude-desktop",
      token: "t".repeat(43),
    }).tandem;

    expect(Object.keys(entry.env ?? {}).sort()).toEqual(Object.values(STDIO_ENTRY_ENV_KEYS).sort());
  });
});
