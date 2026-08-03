import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { get as httpsGet } from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import type { CodexCliPresence } from "../../shared/integrations/contract.js";
import { detectCodexCli } from "../../shared/integrations/detect-codex-cli.js";
import { assertNoBroadAce, setRestrictiveAcl } from "./acl-win.js";
import { UnsupportedPlatformError } from "./install-claude-cli.js";

const execFileAsync = promisify(execFile);
const MAX_BYTES = 10 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 30_000;
const EXEC_TIMEOUT_MS = 180_000;
const URL_WIN = "https://chatgpt.com/codex/install.ps1";
const URL_POSIX = "https://chatgpt.com/codex/install.sh";

function allowedHost(host: string): boolean {
  return host === "chatgpt.com" || host === "openai.com";
}

function sanitize(value: string): string {
  return value
    .replace(
      // biome-ignore lint/suspicious/noControlCharactersInRegex: terminal escape sanitization
      /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-_]/g,
      "",
    )
    .replace(
      // biome-ignore lint/suspicious/noControlCharactersInRegex: control-byte sanitization
      /[\x00-\x08\x0b\x0c\x0e-\x1f]/g,
      "",
    );
}

export class CodexInstallError extends Error {
  constructor(
    readonly exitCode: number | null,
    readonly stderrTail: string,
  ) {
    super(`Codex installer failed (exit ${exitCode ?? "null"})`);
    this.name = "CodexInstallError";
  }
}

export async function fetchCodexInstaller(url: string, redirects = 3): Promise<string> {
  const parsed = new URL(url);
  if (parsed.protocol !== "https:" || !allowedHost(parsed.hostname)) {
    throw new Error("Codex installer redirect left the OpenAI HTTPS allowlist");
  }
  return new Promise((resolve, reject) => {
    const req = httpsGet(`https://${parsed.host}${parsed.pathname}${parsed.search}`, (res) => {
      const status = res.statusCode ?? 0;
      if (status >= 300 && status < 400) {
        res.resume();
        if (!res.headers.location || redirects <= 0) {
          reject(new Error("Codex installer redirect was invalid"));
          return;
        }
        fetchCodexInstaller(new URL(res.headers.location, url).toString(), redirects - 1).then(
          resolve,
          reject,
        );
        return;
      }
      if (status !== 200) {
        res.resume();
        reject(new Error(`Codex installer returned HTTP ${status}`));
        return;
      }
      const chunks: Buffer[] = [];
      let bytes = 0;
      res.on("data", (chunk: Buffer) => {
        bytes += chunk.length;
        if (bytes > MAX_BYTES) {
          req.destroy(new Error("Codex installer exceeded size limit"));
          return;
        }
        chunks.push(chunk);
      });
      res.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
      res.on("error", reject);
    });
    req.on("error", reject);
    req.setTimeout(FETCH_TIMEOUT_MS, () =>
      req.destroy(new Error("Codex installer fetch timed out")),
    );
  });
}

export interface InstallCodexDeps {
  detect?: typeof detectCodexCli;
  fetchScript?: (url: string) => Promise<string>;
  run?: typeof execFileAsync;
  setAcl?: typeof setRestrictiveAcl;
  assertAcl?: typeof assertNoBroadAce;
}

export async function installCodexCli(deps: InstallCodexDeps = {}): Promise<CodexCliPresence> {
  const platform = process.platform;
  if (platform !== "win32" && platform !== "darwin" && platform !== "linux") {
    throw new UnsupportedPlatformError(platform);
  }
  const detect = deps.detect ?? detectCodexCli;
  const current = detect();
  if (current !== "NOT_INSTALLED") return current;

  const isWin = platform === "win32";
  let script: string;
  try {
    script = await (deps.fetchScript ?? fetchCodexInstaller)(isWin ? URL_WIN : URL_POSIX);
  } catch (err) {
    throw new CodexInstallError(
      null,
      sanitize(err instanceof Error ? err.message : String(err)).slice(-500),
    );
  }

  const dir = await mkdtemp(join(tmpdir(), "tandem-codex-install-"));
  try {
    const scriptPath = join(dir, isWin ? "install.ps1" : "install.sh");
    if (isWin) {
      await (deps.setAcl ?? setRestrictiveAcl)(dir);
      await (deps.assertAcl ?? assertNoBroadAce)(dir);
      await writeFile(scriptPath, script, "utf8");
      await (deps.assertAcl ?? assertNoBroadAce)(scriptPath);
    } else {
      await writeFile(scriptPath, script, { encoding: "utf8", mode: 0o600 });
    }
    const env: NodeJS.ProcessEnv = { CODEX_NON_INTERACTIVE: "1" };
    for (const key of ["PATH", "HOME", "USERPROFILE", "LOCALAPPDATA", "SystemRoot"] as const) {
      if (process.env[key] !== undefined) env[key] = process.env[key];
    }
    const command = isWin ? "pwsh.exe" : "/bin/sh";
    const args = isWin
      ? ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", scriptPath]
      : [scriptPath];
    try {
      await (deps.run ?? execFileAsync)(command, args, {
        env,
        timeout: EXEC_TIMEOUT_MS,
        maxBuffer: MAX_BYTES,
        windowsHide: true,
      });
    } catch (err) {
      const e = err as NodeJS.ErrnoException & { stderr?: unknown; code?: unknown };
      const stderr = typeof e.stderr === "string" ? e.stderr : (e.message ?? String(err));
      throw new CodexInstallError(
        typeof e.code === "number" ? e.code : null,
        sanitize(stderr.split(dir).join("<tmp>")).slice(-500),
      );
    }
    return detect();
  } finally {
    await rm(dir, { recursive: true, force: true }).catch((err) => {
      console.error("[Tandem] Codex installer temp cleanup failed:", err);
    });
  }
}
