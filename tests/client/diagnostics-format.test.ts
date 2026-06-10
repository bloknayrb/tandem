import { describe, expect, it } from "vitest";
import type { DiagnosticsPayload } from "../../src/client/utils/diagnostics";
import { formatDiagnostics } from "../../src/client/utils/diagnostics";

/**
 * Unit tests for the pure clipboard formatter behind the About tab's
 * "Copy diagnostics" button (extract-over-mount: the button is thin glue,
 * the formatter carries the behavior).
 */

function makePayload(overrides: Partial<DiagnosticsPayload> = {}): DiagnosticsPayload {
  return {
    report: {
      ok: true,
      crashed: false,
      failures: 0,
      warnings: 0,
      summary: "All checks passed. Tandem is ready.",
      error: null,
      results: [],
    },
    version: "1.2.3",
    transport: "http",
    platform: "win32",
    arch: "x64",
    nodeVersion: "v22.0.0",
    tauriSidecar: false,
    ...overrides,
  };
}

describe("formatDiagnostics", () => {
  it("renders the header with version, transport, platform, and Node", () => {
    const text = formatDiagnostics(makePayload());
    const [line1, line2] = text.split("\n");
    expect(line1).toBe("Tandem v1.2.3 (http)");
    expect(line2).toBe("win32/x64, Node v22.0.0");
  });

  it("marks the desktop runtime in the header", () => {
    const text = formatDiagnostics(makePayload({ tauriSidecar: true }));
    expect(text.split("\n")[0]).toBe("Tandem v1.2.3 (http, desktop)");
  });

  it("renders one tagged line per check, preserving report order", () => {
    const payload = makePayload();
    payload.report.results = [
      { check: "node-version", status: "pass", message: "Node.js v22.0.0 (>= 22 required)" },
      { check: "ports", status: "warn", message: "Partial: port up/down" },
      { check: "health", status: "fail", message: "Server not responding" },
    ];
    const lines = formatDiagnostics(payload).split("\n");
    const checkLines = lines.filter((l) => /^\[(ok|warn|fail)\]/.test(l));
    expect(checkLines).toEqual([
      "[ok]   node-version — Node.js v22.0.0 (>= 22 required)",
      "[warn] ports — Partial: port up/down",
      "[fail] health — Server not responding",
    ]);
  });

  it("adds a fix line for non-pass results that carry one", () => {
    const payload = makePayload();
    payload.report.results = [
      { check: "health", status: "fail", message: "down", fix: "npm run dev:standalone" },
      // A pass result's fix (none in practice) must NOT be rendered.
      { check: "node-version", status: "pass", message: "fine", fix: "should not appear" },
    ];
    const text = formatDiagnostics(payload);
    expect(text).toContain("fix: npm run dev:standalone");
    expect(text).not.toContain("should not appear");
  });

  it("ends with the report summary", () => {
    const payload = makePayload();
    payload.report.summary = "2 issue(s) found.";
    const lines = formatDiagnostics(payload).split("\n");
    expect(lines[lines.length - 1]).toBe("2 issue(s) found.");
  });

  it("strips control characters from messages (terminal-escape hardening)", () => {
    // A few doctor messages interpolate raw file content (e.g. unparseable
    // store.lock bytes); the clipboard text gets pasted into terminals.
    const payload = makePayload();
    payload.report.results = [
      {
        check: "annotation-store",
        status: "warn",
        message: 'lock has unparseable content: "\x1b]0;spoofed\x07\x1b[31mboo"',
        fix: "delete \x1b[2Jit",
      },
    ];
    const text = formatDiagnostics(payload);
    expect(text).toContain('lock has unparseable content: "]0;spoofed[31mboo"');
    expect(text).toContain("fix: delete [2Jit");
    // biome-ignore lint/suspicious/noControlCharactersInRegex: asserting their absence
    expect(text).not.toMatch(/[\x00-\x08\x0b-\x1f\x7f]/);
  });
});
