/**
 * #1988: the desktop sidecar's stdout/stderr pipes break when the Tauri shell
 * dies. Unhandled, the EPIPE looped through `handleFatalError` at 100% CPU on
 * the very SIGTERM the Linux parent-death signal sends (measured; see
 * `src/server/sidecar-pipe-guard.ts`). These pin the guard and its wiring.
 */
import { EventEmitter } from "node:events";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { installSidecarPipeGuard } from "../../src/server/sidecar-pipe-guard.js";

function errno(code: string): NodeJS.ErrnoException {
  return Object.assign(new Error(code), { code });
}

describe("installSidecarPipeGuard", () => {
  it("handles every error on both streams, so none becomes an uncaughtException", () => {
    const out = new EventEmitter();
    const err = new EventEmitter();
    installSidecarPipeGuard([out, err], () => {});
    // An EventEmitter with no 'error' listener throws on emit; these must not.
    expect(() => out.emit("error", errno("EPIPE"))).not.toThrow();
    expect(() => err.emit("error", errno("EIO"))).not.toThrow();
    expect(() => err.emit("error", new Error("no code"))).not.toThrow();
  });

  it("calls onShellGone once, on the first EPIPE from either stream", () => {
    const out = new EventEmitter();
    const err = new EventEmitter();
    const gone = vi.fn();
    installSidecarPipeGuard([out, err], gone);
    err.emit("error", errno("EIO"));
    expect(gone).not.toHaveBeenCalled();
    err.emit("error", errno("EPIPE"));
    out.emit("error", errno("EPIPE"));
    err.emit("error", errno("EPIPE"));
    expect(gone).toHaveBeenCalledTimes(1);
  });
});

describe("index.ts wires the guard for the sidecar only (#1988)", () => {
  const INDEX = fs.readFileSync(
    path.join(import.meta.dirname, "../../src/server/index.ts"),
    "utf8",
  );

  it("installs it on stdout and stderr under isTauriSidecar(), shutting down on EPIPE", () => {
    const at = INDEX.indexOf("installSidecarPipeGuard([process.stdout, process.stderr]");
    expect(at).toBeGreaterThan(-1);
    const before = INDEX.slice(Math.max(0, at - 200), at);
    expect(before).toMatch(/if \(isTauriSidecar\(\)\) \{\s*$/);
    expect(INDEX.slice(at, at + 200)).toMatch(/void shutdown\(/);
  });

  it("arms no stdin listener outside stdio mode: the shell's stdin pipe is not a lifeline", () => {
    // The sidecar's stdin is a pipe the shell holds; an EOF handler armed in
    // HTTP mode would make an unrelated stdin close stop the desktop server.
    const listeners = [...INDEX.matchAll(/process\.stdin\.on\(/g)].map((m) => m.index ?? 0);
    expect(listeners).toHaveLength(1);
    const guard = INDEX.lastIndexOf('if (transportMode === "stdio") {', listeners[0]);
    expect(guard).toBeGreaterThan(-1);
    expect(listeners[0] - guard).toBeLessThan(80);
  });
});
