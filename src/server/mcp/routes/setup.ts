import type { Request, Response } from "express";
import {
  applyConfig,
  applyOpsForCli,
  buildMcpEntries,
  type DetectedTarget,
  detectTargets,
  installSkill,
  shouldRegisterChannelShim,
} from "../../integrations/apply.js";
import type { Handler } from "./_shared.js";
import { isValidChannelPath, isValidNodeBinary } from "./_shared.js";

interface SetupResult {
  status: number;
  body: {
    error?: string;
    message?: string;
    data?: {
      targets: DetectedTarget[];
      configured: string[];
      errors: string[];
      skillInstalled: boolean;
    };
  };
}

export async function runSetupHandler(
  input: Record<string, unknown>,
  homeOverride?: string,
  token?: string,
): Promise<SetupResult> {
  const { nodeBinary, channelPath } = input;

  if (!nodeBinary || typeof nodeBinary !== "string") {
    return { status: 400, body: { error: "BAD_REQUEST", message: "nodeBinary is required" } };
  }
  if (!channelPath || typeof channelPath !== "string") {
    return { status: 400, body: { error: "BAD_REQUEST", message: "channelPath is required" } };
  }
  if (!isValidNodeBinary(nodeBinary)) {
    return {
      status: 400,
      body: { error: "BAD_REQUEST", message: "nodeBinary must be a node binary" },
    };
  }
  if (!isValidChannelPath(channelPath)) {
    return {
      status: 400,
      body: {
        error: "BAD_REQUEST",
        message: "channelPath must be a .js file without path traversal",
      },
    };
  }

  const targets = detectTargets({ homeOverride });

  const configured: string[] = [];
  const errors: string[] = [];

  for (const target of targets) {
    // Default-on for Claude Code (the channel shim is its push transport,
    // #985). `channelPath` is the Tauri-resolved bundled artifact and has
    // already passed shape validation above; `shouldRegisterChannelShim`
    // adds the existence check and the claude-desktop exclusion. A valid-
    // shape-but-missing file degrades to "tandem HTTP entry only" rather
    // than registering a broken MCP server.
    const withChannelShim = shouldRegisterChannelShim(target.kind, channelPath);
    const entries = buildMcpEntries(channelPath, {
      withChannelShim,
      nodeBinary,
      token,
      targetKind: target.kind,
    });
    try {
      await applyConfig(target.configPath, applyOpsForCli(entries, { withChannelShim }));
      configured.push(target.label);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      errors.push(`${target.label}: ${msg}`);
      console.error(`[Setup] target=${target.label} failed:`, err);
    }
  }

  let skillInstalled = false;
  try {
    await installSkill({ homeOverride });
    skillInstalled = true;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    errors.push(`Skill install: ${msg}`);
    console.error("[Setup] skill install failed:", err);
  }

  // HTTP status reflects outcome:
  //   200 — every attempt succeeded (at least one configured target + skill installed)
  //   207 — partial failure (some targets configured or skill installed, but not all)
  //   500 — total failure (no targets configured AND skill install failed)
  const totalFailed = configured.length === 0 && !skillInstalled;
  const anyFailed = errors.length > 0;
  let status: number = 200;
  if (totalFailed) status = 500;
  else if (anyFailed) status = 207;

  return {
    status,
    body: { data: { targets, configured, errors, skillInstalled } },
  };
}

export function makeSetupHandler(opts: { token?: string }): Handler {
  return async (req: Request, res: Response) => {
    try {
      const result = await runSetupHandler(
        (req.body ?? {}) as Record<string, unknown>,
        undefined,
        opts.token,
      );
      res.status(result.status).json(result.body);
    } catch (err: unknown) {
      console.error("[Tandem] Setup handler threw:", err);
      res.status(500).json({
        error: "INTERNAL",
        message: err instanceof Error ? err.message : String(err),
      });
    }
  };
}
