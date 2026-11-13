import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  installLogRedaction,
  REDACTED_OWNER_HANDLE,
  redactOwnerHandles,
} from "../../src/server/log-redact.js";
import { LOG_FIELD_MAX, sanitizeForLog } from "../../src/server/log-sanitize.js";

/**
 * The log sink's owner-handle redaction (#2358 PR 3a, R5.2, R5.3; Rulings D6
 * and L): unconditional, unguarded, and applied to the formatted line.
 */

const HANDLE = `th_${"Qw3_-z".repeat(5)}Ab`;

describe("redactOwnerHandles (R5.2)", () => {
  it("redacts a bare handle", () => {
    expect(HANDLE).toHaveLength(35);
    expect(redactOwnerHandles(`x ${HANDLE} y`)).toBe(`x ${REDACTED_OWNER_HANDLE} y`);
  });

  it("redacts a handle after a newline sanitizeForLog stripped", () => {
    const out = redactOwnerHandles(sanitizeForLog(`line\n${HANDLE}`));
    expect(out).not.toContain(HANDLE);
    expect(out).toBe(`line${REDACTED_OWNER_HANDLE}`);
  });

  it("redacts a handle after a JSON-escaped \\n", () => {
    const line = JSON.stringify({ text: `a\n${HANDLE}` });
    expect(line).toContain("\\n");
    expect(redactOwnerHandles(line)).not.toContain(HANDLE);
  });

  it("redacts a handle followed by a stripped newline and a letter (no guard after, Ruling L)", () => {
    const out = redactOwnerHandles(sanitizeForLog(`${HANDLE}\nNext`));
    expect(out).toBe(`${REDACTED_OWNER_HANDLE}Next`);
  });

  it("redacts a partial handle at the end of a field clamped by LOG_FIELD_MAX", () => {
    const field = `${"x".repeat(LOG_FIELD_MAX - 20)}${HANDLE}`;
    const clamped = sanitizeForLog(field);
    expect(clamped.endsWith("\u2026")).toBe(true);
    expect(clamped).toContain(HANDLE.slice(0, 20));
    const out = redactOwnerHandles(clamped);
    expect(out).not.toContain(HANDLE.slice(0, 19));
    expect(out.endsWith(`${REDACTED_OWNER_HANDLE}\u2026`)).toBe(true);
  });

  it("over-redacts a longer run that starts like a handle (accepted)", () => {
    expect(redactOwnerHandles(`${HANDLE}MORE`)).toBe(`${REDACTED_OWNER_HANDLE}MORE`);
  });

  it("leaves a snake_case word with th_ and fewer than 16 characters after it untouched", () => {
    const line = "[Tandem] width_px=12 depth_first both_sides";
    expect(redactOwnerHandles(line)).toBe(line);
    const clamped = sanitizeForLog(`${"y".repeat(LOG_FIELD_MAX - 10)}path_segment_ok`);
    expect(redactOwnerHandles(clamped)).toBe(clamped);
  });

  it("returns a line with no th_ byte-identical (the dark requirement)", () => {
    const line = "[Tandem] MCP session established: abc — 2 live \u2026 ✓";
    expect(redactOwnerHandles(line)).toBe(line);
  });
});

describe("installLogRedaction (R5.3)", () => {
  function captured() {
    const lines: string[] = [];
    const target = {} as Pick<
      Console,
      "log" | "info" | "warn" | "error" | "debug" | "trace" | "dir"
    >;
    installLogRedaction(target, (line) => lines.push(line));
    return { target, lines };
  }

  it("redacts a handle inside an Error (message and stack) and inside an inspected object", () => {
    const { target, lines } = captured();
    target.error("failed:", new Error(`boom ${HANDLE}`));
    target.warn({ deep: { headers: { "x-tandem-owner-handle": HANDLE } } });
    target.dir({ nested: [HANDLE] });
    target.debug("%s", HANDLE);
    target.trace(`t ${HANDLE}`);
    target.log("%o", { h: HANDLE });
    target.info(HANDLE);
    expect(lines).toHaveLength(7);
    for (const line of lines) expect(line).not.toContain(HANDLE);
    expect(lines[0]).toContain(`boom ${REDACTED_OWNER_HANDLE}`);
  });

  it("formats like util.format and leaves a line without th_ unchanged", () => {
    const { target, lines } = captured();
    target.error("a %s b %d", "x", 3, { k: 1 });
    expect(lines).toEqual(["a x b 3 { k: 1 }"]);
  });

  it("drops a line the production renderer suppresses", () => {
    const lines: string[] = [];
    const target = {} as Pick<
      Console,
      "log" | "info" | "warn" | "error" | "debug" | "trace" | "dir"
    >;
    installLogRedaction(
      target,
      (l) => lines.push(l),
      (args) => (args[0] === "drop" ? null : String(args[0])),
    );
    target.error("drop");
    target.error(HANDLE);
    expect(lines).toEqual([REDACTED_OWNER_HANDLE]);
  });
});

describe("index.ts installs it on both console shapes (source pin)", () => {
  const src = readFileSync(path.resolve(__dirname, "../../src/server/index.ts"), "utf8");
  it("the production shape and the plain shape both call the installer", () => {
    expect(src).toMatch(/installLogRedaction\(console, writeLogLine, formatLogLine\);/);
    expect(src).toMatch(/installLogRedaction\(console, writeLogLine\);/);
    // A closed stderr stays a lost line, as under Node's own console (no EPIPE crash).
    expect(src).toMatch(
      /process\.stderr\.on\("error", \(\) => \{\}\);\s*installLogRedaction\(console, writeLogLine\);/,
    );
    expect(src).toMatch(/function writeLogLine\(line: string\): void \{\s*try \{/);
    expect(src).not.toMatch(/console\.log = console\.error/);
  });

  it("the supervisor is handed the bound MCP address (Ruling D14)", () => {
    expect(src).toMatch(/getBoundMcpAddress: \(\) => \{\s*const addr = httpServer\?\.address\(\);/);
  });
});

describe("Sentry's scrub carries the handle pattern (R5.4)", () => {
  it("redacts a handle in any text field it scrubs", async () => {
    const { scrub } = await import("../../src/server/sentry.js");
    expect(scrub(`fatal: header ${HANDLE} leaked`)).toBe(
      `fatal: header ${REDACTED_OWNER_HANDLE} leaked`,
    );
  });
});
