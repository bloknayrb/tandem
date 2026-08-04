import { describe, expect, it } from "vitest";

import type { IntegrationConfig } from "../../src/shared/integrations/contract.js";
import {
  isLaunchablePrimary,
  isLaunchablePrimaryKind,
  LAUNCHABLE_PRIMARY_KINDS,
} from "../../src/shared/integrations/launchable-primary.js";

/**
 * This predicate is consumed by five call sites across server and client that
 * previously hand-rolled three different shapes. The tests pin BOTH halves of
 * its contract: the runtime answer, and the type-level narrowing (the
 * launcher call sites read `workingDirectory` off the narrowed result without
 * a cast, so a regression there is a compile error, not a test failure —
 * hence the deliberate compile-time assertions below).
 */

const claudeCode: IntegrationConfig = {
  kind: "claude-code",
  id: "cc",
  label: "Claude Code",
  configPath: "/home/u/.claude.json",
  transport: "http",
  url: "http://127.0.0.1:3479/mcp",
};

const codex: IntegrationConfig = {
  kind: "codex",
  id: "cx",
  label: "Codex",
  configPath: "/home/u/.codex/config.toml",
  transport: "stdio",
};

const claudeDesktop: IntegrationConfig = {
  kind: "claude-desktop",
  id: "cd",
  label: "Claude Desktop",
  configPath: "/home/u/claude_desktop_config.json",
  transport: "stdio",
};

const otherMcp: IntegrationConfig = {
  kind: "other-mcp",
  id: "om",
  label: "Cursor",
  transport: "stdio",
};

describe("isLaunchablePrimary", () => {
  it("accepts claude-code and codex", () => {
    expect(isLaunchablePrimary(claudeCode)).toBe(true);
    expect(isLaunchablePrimary(codex)).toBe(true);
  });

  it("rejects kinds Tandem configures but cannot launch", () => {
    expect(isLaunchablePrimary(claudeDesktop)).toBe(false);
    expect(isLaunchablePrimary(otherMcp)).toBe(false);
  });

  it("rejects a launchable kind whose apply intent is skip", () => {
    expect(isLaunchablePrimary({ ...claudeCode, apply: "skip" })).toBe(false);
    expect(isLaunchablePrimary({ ...codex, apply: "skip" })).toBe(false);
  });

  it("accepts create / update apply intents", () => {
    expect(isLaunchablePrimary({ ...claudeCode, apply: "create" })).toBe(true);
    expect(isLaunchablePrimary({ ...codex, apply: "update" })).toBe(true);
  });

  it("answers false for null/undefined so callers need no pre-guard", () => {
    expect(isLaunchablePrimary(undefined)).toBe(false);
    expect(isLaunchablePrimary(null)).toBe(false);
  });

  it("works on a loosely-typed GET /api/integrations body", () => {
    // The SettingsClaudeCodeTab shape: every field `string | undefined`.
    const parsed: { id?: string; kind?: string; apply?: string }[] = [
      { id: "a", kind: "claude-desktop" },
      { id: "b", kind: "codex", apply: "skip" },
      { id: "c", kind: "claude-code" },
    ];
    expect(parsed.filter(isLaunchablePrimary).map((i) => i.id)).toEqual(["c"]);
  });

  it("narrows to the launchable variants (compile-time contract)", () => {
    const entries: IntegrationConfig[] = [claudeCode, codex, claudeDesktop, otherMcp];
    const found = entries.find(isLaunchablePrimary);
    if (found) {
      // Both launchable variants carry `workingDirectory`; neither of the
      // rejected variants does. This line only compiles if the predicate
      // narrowed the union — that is the assertion.
      const dir: string | undefined = found.workingDirectory;
      expect(dir).toBeUndefined();
      expect(found.kind).toBe("claude-code");
    }
    expect(found).toBeDefined();
  });
});

describe("isLaunchablePrimaryKind", () => {
  it("matches exactly the exported kind list", () => {
    expect([...LAUNCHABLE_PRIMARY_KINDS]).toEqual(["claude-code", "codex"]);
    for (const kind of LAUNCHABLE_PRIMARY_KINDS) {
      expect(isLaunchablePrimaryKind(kind)).toBe(true);
    }
  });

  it("rejects other kinds and nullish input", () => {
    expect(isLaunchablePrimaryKind("claude-desktop")).toBe(false);
    expect(isLaunchablePrimaryKind("other-mcp")).toBe(false);
    expect(isLaunchablePrimaryKind(undefined)).toBe(false);
    expect(isLaunchablePrimaryKind(null)).toBe(false);
  });
});
