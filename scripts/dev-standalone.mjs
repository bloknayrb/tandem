#!/usr/bin/env node

import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";

const DEFAULT_MCP_PORT = 3479;
const DEFAULT_READY_TIMEOUT_MS = 60_000;
const DEFAULT_PROBE_TIMEOUT_MS = 2_000;
const DEFAULT_POLL_INTERVAL_MS = 500;
const CHILD_TERMINATION_TIMEOUT_MS = 5_000;

function binCommand(command) {
  return process.platform === "win32" ? `${command}.cmd` : command;
}

function resolveStandaloneUrl(env = process.env) {
  const raw = env.TANDEM_URL ?? `http://localhost:${env.TANDEM_MCP_PORT ?? DEFAULT_MCP_PORT}`;
  return raw.replace(/\/$/, "");
}

function spawnChild(command, args, options = {}) {
  if (process.platform === "win32") {
    const comspec = process.env.ComSpec || "cmd.exe";
    return spawn(comspec, ["/d", "/s", "/c", command, ...args], {
      cwd: process.cwd(),
      env: process.env,
      stdio: "inherit",
      shell: false,
      ...options,
    });
  }

  return spawn(command, args, {
    cwd: process.cwd(),
    env: process.env,
    stdio: "inherit",
    shell: false,
    ...options,
  });
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchJsonWithTimeout(url, timeoutMs, fetchImpl = fetch) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetchImpl(url, { signal: controller.signal });
    const body = await res.text();
    return { res, body };
  } finally {
    clearTimeout(timer);
  }
}

async function probeHealth(baseUrl, fetchImpl = fetch) {
  const { res, body } = await fetchJsonWithTimeout(
    `${baseUrl}/health`,
    DEFAULT_PROBE_TIMEOUT_MS,
    fetchImpl,
  );
  if (!res.ok) {
    throw new Error(`/health returned HTTP ${res.status}`);
  }

  let parsed;
  try {
    parsed = JSON.parse(body);
  } catch {
    throw new Error("/health did not return valid JSON");
  }

  if (parsed?.status !== "ok") {
    throw new Error(`/health returned unexpected status ${JSON.stringify(parsed?.status)}`);
  }
}

async function probeEvents(baseUrl, fetchImpl = fetch) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DEFAULT_PROBE_TIMEOUT_MS);

  try {
    const res = await fetchImpl(`${baseUrl}/api/events`, {
      headers: { Accept: "text/event-stream" },
      signal: controller.signal,
    });
    if (!res.ok) {
      throw new Error(`/api/events returned HTTP ${res.status}`);
    }

    const contentType = res.headers.get("content-type") || "";
    if (!contentType.includes("text/event-stream")) {
      throw new Error(`/api/events returned content-type ${contentType || "<missing>"}`);
    }

    await res.body?.cancel().catch(() => {});
  } finally {
    clearTimeout(timer);
  }
}

export async function waitForBackendReady(
  baseUrl,
  { fetchImpl = fetch, timeoutMs = DEFAULT_READY_TIMEOUT_MS } = {},
) {
  const deadline = Date.now() + timeoutMs;
  let lastError;

  while (Date.now() < deadline) {
    try {
      await probeHealth(baseUrl, fetchImpl);
      await probeEvents(baseUrl, fetchImpl);
      return;
    } catch (err) {
      lastError = err;
      await delay(DEFAULT_POLL_INTERVAL_MS);
    }
  }

  throw new Error(
    `Timed out waiting for Tandem backend at ${baseUrl} (${lastError instanceof Error ? lastError.message : (lastError ?? "unknown error")})`,
  );
}

function killChild(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  try {
    child.kill();
  } catch {
    // Best effort.
  }
}

function shutdownChildren(children) {
  for (const child of children) {
    killChild(child);
  }

  return delay(CHILD_TERMINATION_TIMEOUT_MS).then(() => {
    for (const child of children) {
      killChild(child);
    }
  });
}

function attachUnexpectedExit(child, label, children, shutdownState) {
  child.once("exit", (code, signal) => {
    if (shutdownState.stopping) return;
    shutdownState.stopping = true;
    const detail = signal ? `signal ${signal}` : `exit code ${code ?? 1}`;
    console.error(`[standalone] ${label} exited unexpectedly (${detail})`);
    void shutdownChildren(children).finally(() => {
      process.exit(code ?? 1);
    });
  });
}

export async function launchStandalone({
  env = process.env,
  fetchImpl = fetch,
  spawnImpl = spawnChild,
  waitForBackendReadyImpl = waitForBackendReady,
  installSignalHandlers = false,
  timeoutMs = DEFAULT_READY_TIMEOUT_MS,
} = {}) {
  const baseUrl = resolveStandaloneUrl(env);
  const shutdownState = { stopping: false };
  const children = [];

  const client = spawnImpl(binCommand("vite"), [], { env, cwd: process.cwd() });
  const server = spawnImpl(binCommand("tsx"), ["watch", "src/server/index.ts"], {
    env,
    cwd: process.cwd(),
  });
  children.push(client, server);

  attachUnexpectedExit(client, "client", children, shutdownState);
  attachUnexpectedExit(server, "server", children, shutdownState);

  if (installSignalHandlers) {
    const handleSignal = (signal) => {
      if (shutdownState.stopping) return;
      shutdownState.stopping = true;
      console.error(`[standalone] ${signal} received; shutting down`);
      void shutdownChildren(children).finally(() => {
        process.exit(0);
      });
    };
    process.once("SIGINT", () => handleSignal("SIGINT"));
    process.once("SIGTERM", () => handleSignal("SIGTERM"));
  }

  console.error(`[standalone] Waiting for Tandem backend at ${baseUrl}...`);
  await waitForBackendReadyImpl(baseUrl, { fetchImpl, timeoutMs });

  if (shutdownState.stopping) {
    throw new Error("Standalone startup aborted while waiting for backend readiness");
  }

  console.error(`[standalone] Backend ready at ${baseUrl}; starting monitor`);
  const monitorEnv = { ...env, TANDEM_URL: baseUrl };
  const monitor = spawnImpl(binCommand("tsx"), ["src/monitor/index.ts"], {
    env: monitorEnv,
    cwd: process.cwd(),
  });
  children.push(monitor);
  attachUnexpectedExit(monitor, "monitor", children, shutdownState);

  return { baseUrl, client, server, monitor };
}

export async function main() {
  try {
    await launchStandalone({ installSignalHandlers: true });
  } catch (err) {
    console.error(
      `[standalone] Startup failed: ${err instanceof Error ? err.message : String(err)}`,
    );
    process.exit(1);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
