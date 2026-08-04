import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { SKILL_CONTENT } from "../../../src/cli/skill-content.js";
import { PathRejectedError, resolveCliVersion } from "../../../src/server/integrations/apply.js";
import {
  applyCodexConfig,
  CODEX_SKILL_CONTENT,
  detectCodexTargets,
  installCodexSkill,
  type RunCodex,
  readExistingCodexEntry,
} from "../../../src/server/integrations/codex-config.js";
import { DEFAULT_MCP_PORT } from "../../../src/shared/constants.js";
import { withEnvOverride } from "../../helpers/env-override.js";

describe("Codex integration configuration", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "tandem-codex-config-"));
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it("detects an existing CODEX_HOME without executing Codex", () => {
    const codexHome = join(root, "custom-codex");
    mkdirSync(codexHome);
    expect(
      detectCodexTargets({
        homeOverride: root,
        codexHomeOverride: codexHome,
        pathOverride: join(root, "empty"),
      }),
    ).toEqual([{ kind: "codex", label: "Codex", configPath: join(codexHome, "config.toml") }]);
  });

  it("maps Codex's JSON MCP description to the redacted wizard shape", async () => {
    const target = {
      kind: "codex" as const,
      label: "Codex",
      configPath: join(root, "config.toml"),
    };
    const run = vi.fn(async () => ({
      stdout: JSON.stringify({
        name: "tandem",
        transport: {
          type: "stdio",
          command: "npx",
          args: ["-y", "tandem-editor@0.19.0", "mcp-stdio"],
          env: { SECRET: "must-not-leak" },
        },
      }),
      stderr: "",
    }));
    const result = await readExistingCodexEntry(target, run);
    expect(result.tandemEntry).toEqual({
      command: "npx",
      args: ["-y", "tandem-editor@0.19.0", "mcp-stdio"],
    });
    expect(JSON.stringify(result)).not.toContain("must-not-leak");
  });

  it("invokes `codex mcp get tandem --json` with the exact argv shape", async () => {
    const target = {
      kind: "codex" as const,
      label: "Codex",
      configPath: join(root, "config.toml"),
    };
    const run = vi.fn(async () => ({
      stdout: JSON.stringify({ transport: { type: "stdio", command: "npx", args: [] } }),
      stderr: "",
    }));
    await readExistingCodexEntry(target, run);
    expect(run).toHaveBeenCalledTimes(1);
    const [args] = run.mock.calls[0] as [string[], unknown];
    expect(args).toEqual(["mcp", "get", "tandem", "--json"]);
  });

  describe("readExistingCodexEntry — failure classification", () => {
    const target = {
      kind: "codex" as const,
      label: "Codex",
      configPath: "/irrelevant/config.toml",
    };

    it("reports status: ok with no tandemEntry when Codex's own 'no such server' wording is in stderr", async () => {
      // Positive control for the classification below — Codex's actual wording
      // for "not configured" is a SUCCESS-shaped result (the query ran fine,
      // there's just nothing there), not an error.
      const run: RunCodex = vi.fn(async () => {
        throw Object.assign(new Error("Command failed"), {
          code: 1,
          stderr: "Error: no MCP server named 'tandem' was found\n",
        });
      });
      const result = await readExistingCodexEntry(target, run);
      expect(result).toEqual({ target, status: "ok" });
    });

    it("reports status: error for a ranAndFailed error whose stderr does NOT match the 'not configured' wording", async () => {
      // Same shape as the positive control above (a numeric `code`, i.e. the
      // process genuinely ran) but the stderr text doesn't match — this must
      // NOT be silently treated as "nothing configured".
      const run: RunCodex = vi.fn(async () => {
        throw Object.assign(new Error("Command failed"), {
          code: 1,
          stderr: "Error: config.toml is not valid TOML at line 4\n",
        });
      });
      const result = await readExistingCodexEntry(target, run);
      expect(result.status).toBe("error");
      expect(result.errorMessage).toBe("Could not inspect Codex MCP configuration");
    });

    it("reports status: error when the process never ran (non-numeric code, e.g. ENOENT) — even if stray stderr matches the 'not configured' wording", async () => {
      // The stderr here is deliberately crafted to match CODEX_NO_SUCH_SERVER_RE
      // — this isolates the `typeof code === "number"` gate specifically: a
      // spawn failure (ENOENT) must be classified as "error" regardless of
      // what happens to be sitting in stderr, because the process never
      // actually ran the query.
      const run: RunCodex = vi.fn(async () => {
        throw Object.assign(new Error("spawn codex ENOENT"), {
          code: "ENOENT",
          stderr: "no mcp server found\n",
        });
      });
      const result = await readExistingCodexEntry(target, run);
      expect(result.status).toBe("error");
      expect(result.errorMessage).toBe("Could not inspect Codex MCP configuration");
    });

    it("reports status: malformed when --json produces unparseable output", async () => {
      const run: RunCodex = vi.fn(async () => ({ stdout: "not json at all", stderr: "" }));
      const result = await readExistingCodexEntry(target, run);
      expect(result).toEqual({ target, status: "malformed" });
    });
  });
});

describe("applyCodexConfig", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "tandem-codex-apply-"));
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it("calls `codex mcp add` with the exact argv shape on the success path", async () => {
    const target = {
      kind: "codex" as const,
      label: "Codex",
      configPath: join(root, "config.toml"), // does not exist — no backup branch
    };
    const run = vi.fn(async () => ({ stdout: "", stderr: "" }));

    await expect(applyCodexConfig(target, run)).resolves.toBeUndefined();

    expect(run).toHaveBeenCalledTimes(1);
    const [args, options] = run.mock.calls[0] as [string[], { timeout: number; maxBuffer: number }];
    expect(args).toEqual([
      "mcp",
      "add",
      "tandem",
      "--env",
      `TANDEM_URL=http://127.0.0.1:${DEFAULT_MCP_PORT}`,
      "--env",
      "TANDEM_AGENT_PROVIDER=openai",
      "--",
      "npx",
      "-y",
      `tandem-editor@${resolveCliVersion()}`,
      "mcp-stdio",
    ]);
    expect(options.timeout).toBeGreaterThan(0);
    expect(options.maxBuffer).toBeGreaterThan(0);
  });

  it("backs up an existing config.toml (byte-identical) before calling `codex mcp add`", async () => {
    const configPath = join(root, "config.toml");
    const originalContent = '[mcp_servers.tandem]\ncommand = "old"\n';
    writeFileSync(configPath, originalContent, "utf8");
    const target = { kind: "codex" as const, label: "Codex", configPath };
    const run = vi.fn(async () => ({ stdout: "", stderr: "" }));
    const appDataDir = join(root, "appdata");

    await withEnvOverride("TANDEM_APP_DATA_DIR", appDataDir, async () => {
      await applyCodexConfig(target, run);
    });

    expect(run).toHaveBeenCalledTimes(1);
    const backupDirPath = join(appDataDir, ".backups");
    const backups = readdirSync(backupDirPath).filter(
      (f) => f.startsWith("codex-config-") && f.endsWith(".toml"),
    );
    expect(backups).toHaveLength(1);
    expect(readFileSync(join(backupDirPath, backups[0] as string), "utf8")).toBe(originalContent);
  });

  it("rejects a configPath outside the allowed roots with PathRejectedError and never calls run", async () => {
    const target = {
      kind: "codex" as const,
      label: "Codex",
      // Same pattern api-routes.test.ts uses for its PATH_REJECTED coverage —
      // proven safe cross-platform (Windows treats a leading "/" as the
      // current drive's root, still outside homedir()/tmpdir()).
      configPath: "/__tandem-codex-outside-roots__/config.toml",
    };
    const run = vi.fn(async () => ({ stdout: "", stderr: "" }));

    await expect(applyCodexConfig(target, run)).rejects.toBeInstanceOf(PathRejectedError);
    expect(run).not.toHaveBeenCalled();
  });

  it("propagates a `run` failure as-is — applyCodexConfig does not catch or reclassify it", async () => {
    // Paired against the success-path test above: same valid configPath,
    // only the injected `run` outcome differs. Demonstrates applyCodexConfig
    // is a thin pass-through — error classification (PATH_REJECTED vs
    // WRITE_FAILED) is the caller's job (api-routes.ts), not this function's.
    const target = {
      kind: "codex" as const,
      label: "Codex",
      configPath: join(root, "config.toml"),
    };
    const boom = Object.assign(new Error("Command failed"), { code: 1, stderr: "boom" });
    const run = vi.fn(async () => {
      throw boom;
    });

    await expect(applyCodexConfig(target, run)).rejects.toBe(boom);
  });
});

describe("installCodexSkill", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "tandem-codex-skill-"));
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it("writes the bundled skill, stamped with the ownership marker (positive control)", async () => {
    await installCodexSkill({ homeOverride: root });
    const skillPath = join(root, ".agents", "skills", "tandem", "SKILL.md");
    const written = readFileSync(skillPath, "utf8");
    expect(written).toBe(CODEX_SKILL_CONTENT);
    // The skill body must survive the stamping intact — the marker is an
    // addition, not a replacement.
    expect(written).toContain(SKILL_CONTENT.trimEnd());
  });

  it("no-ops when on-disk content is already the stamped skill", async () => {
    const skillPath = join(root, ".agents", "skills", "tandem", "SKILL.md");
    mkdirSync(join(root, ".agents", "skills", "tandem"), { recursive: true });
    writeFileSync(skillPath, CODEX_SKILL_CONTENT, "utf8");
    await expect(installCodexSkill({ homeOverride: root })).resolves.toBeUndefined();
    expect(readFileSync(skillPath, "utf8")).toBe(CODEX_SKILL_CONTENT);
  });

  // The regression this guard's own bug produced: the marker was CHECKED but
  // never WRITTEN, so the first release that changed SKILL.md would refuse to
  // overwrite Tandem's own file and tell the user it was someone else's.
  // Stale-but-stamped content is the shape every post-update install takes.
  it("updates a previously-installed skill when the bundled content changes", async () => {
    const skillPath = join(root, ".agents", "skills", "tandem", "SKILL.md");
    mkdirSync(join(root, ".agents", "skills", "tandem"), { recursive: true });
    // What a prior install of an OLDER bundled skill left behind.
    writeFileSync(
      skillPath,
      `an older skill body

<!-- tandem-owned-skill -->
`,
      "utf8",
    );
    await expect(installCodexSkill({ homeOverride: root })).resolves.toBeUndefined();
    expect(readFileSync(skillPath, "utf8")).toBe(CODEX_SKILL_CONTENT);
  });

  // Transition case: content written by the pre-fix code is unstamped but is
  // byte-for-byte the bundled skill, so it is unmistakably Tandem's.
  it("adopts an unstamped file that is exactly the bundled skill", async () => {
    const skillPath = join(root, ".agents", "skills", "tandem", "SKILL.md");
    mkdirSync(join(root, ".agents", "skills", "tandem"), { recursive: true });
    writeFileSync(skillPath, SKILL_CONTENT, "utf8");
    await expect(installCodexSkill({ homeOverride: root })).resolves.toBeUndefined();
    expect(readFileSync(skillPath, "utf8")).toBe(CODEX_SKILL_CONTENT);
  });

  it("refuses to overwrite a file at the same path that lacks the ownership marker (unrelated user skill)", async () => {
    const skillPath = join(root, ".agents", "skills", "tandem", "SKILL.md");
    mkdirSync(join(root, ".agents", "skills", "tandem"), { recursive: true });
    const foreignContent = "# My own notes\nThis is not a Tandem skill file.\n";
    writeFileSync(skillPath, foreignContent, "utf8");

    await expect(installCodexSkill({ homeOverride: root })).rejects.toThrow(
      /Refusing to overwrite a non-Tandem Codex skill/,
    );
    // The refusal must be effective — the foreign file is left untouched.
    expect(readFileSync(skillPath, "utf8")).toBe(foreignContent);
  });

  it("overwrites a file that DOES carry the ownership marker, even with stale content (positive control for the guard above)", async () => {
    // Paired against the refusal test above: identical setup (same path,
    // content differs from SKILL_CONTENT so the fast-path equality check is
    // bypassed), differing only by the marker's presence. Proves the guard
    // discriminates on the marker, not merely "any non-matching content".
    const skillPath = join(root, ".agents", "skills", "tandem", "SKILL.md");
    mkdirSync(join(root, ".agents", "skills", "tandem"), { recursive: true });
    const staleOwnedContent = "<!-- tandem-owned-skill -->\nan older version of the skill\n";
    writeFileSync(skillPath, staleOwnedContent, "utf8");

    await expect(installCodexSkill({ homeOverride: root })).resolves.toBeUndefined();
    expect(readFileSync(skillPath, "utf8")).toBe(CODEX_SKILL_CONTENT);
  });
});
