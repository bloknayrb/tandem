import { describe, expect, it } from "vitest";
import type { ClientLogEntry } from "../../src/client/utils/client-log";
import type { DiagnosticsPayload } from "../../src/client/utils/diagnostics";
import {
  BUG_REPORT_BODY_HEADING,
  buildBugReportUrl,
  formatDiagnostics,
  MAX_ISSUE_URL_LENGTH,
} from "../../src/client/utils/diagnostics";
import { TANDEM_ISSUES_NEW_URL } from "../../src/shared/constants";

/**
 * Unit tests for the Report-a-bug href builder. The link's whole error strategy
 * is "fall back to the bare issue URL", so most of these assert that a bad
 * input degrades to a working link rather than throwing or producing a URL
 * GitHub will reject.
 */

function bodyOf(url: string): string {
  const body = new URL(url).searchParams.get("body");
  expect(body).not.toBeNull();
  return body as string;
}

describe("buildBugReportUrl", () => {
  it.each([
    [undefined],
    [null],
    [""],
    ["   \n\t  "],
  ])("returns the bare issue URL for %p", (input) => {
    expect(buildBugReportUrl(input)).toBe(TANDEM_ISSUES_NEW_URL);
  });

  it("prefills two blank lines, the heading, then the fenced report", () => {
    const url = buildBugReportUrl("Tandem v1.2.3 (http)\nwin32/x64");
    expect(bodyOf(url)).toBe(
      `\n\n${BUG_REPORT_BODY_HEADING}\n\n~~~\nTandem v1.2.3 (http)\nwin32/x64\n~~~`,
    );
  });

  it("starts the body with blank lines so the user has somewhere to type", () => {
    expect(bodyOf(buildBugReportUrl("x"))).toMatch(/^\n\n\S/);
  });

  it("fences with tildes, since doctor fix strings contain backticks", () => {
    // e.g. doctor.ts's "run via `npx`" — a ``` fence would not be escape-safe.
    const body = bodyOf(buildBugReportUrl("[warn] mcp — run via `npx` instead"));
    expect(body).toContain("~~~\n[warn] mcp — run via `npx` instead\n~~~");
    expect(body).not.toContain("```");
  });

  it("lengthens the fence so report content cannot break out of it", () => {
    // Not hypothetical: doctor.ts:1520 interpolates raw `store.lock` bytes into
    // a message, and stripControlChars deliberately preserves newlines. A lock
    // file containing a `~~~` line would otherwise close the fence early and
    // let the rest render as markdown in a public issue.
    const hostile = 'lock has unparseable content: "\n~~~\n<img src=x>"';
    const body = bodyOf(buildBugReportUrl(hostile));
    const fence = body.split("\n").find((l) => /^~+$/.test(l)) as string;

    expect(fence.length).toBeGreaterThan(3);
    // Exactly one opening and one closing fence of that length.
    expect(body.split("\n").filter((l) => l === fence)).toHaveLength(2);
    // And the hostile run is strictly shorter, so it cannot close them.
    expect(body).toContain("~~~\n<img src=x>");
  });

  it("keeps the default fence when the report contains no tildes", () => {
    expect(bodyOf(buildBugReportUrl("plain report"))).toContain("~~~\nplain report\n~~~");
  });

  it("points at the same repo as the bare URL", () => {
    expect(buildBugReportUrl("x").startsWith(`${TANDEM_ISSUES_NEW_URL}?`)).toBe(true);
  });

  describe("truncation", () => {
    // Em dashes encode to 9 chars each and newlines to 3, so this is far longer
    // encoded than it looks — which is exactly the bug the cap has to survive.
    const huge = [
      "Tandem v1.2.3 (http)",
      "win32/x64, Node v22.0.0",
      "OS: Windows 11 Pro (10.0.26100)",
      ...Array.from({ length: 400 }, (_, i) => `[ok]   check-${i} — everything is fine here`),
    ].join("\n");

    it("keeps the final URL within the cap", () => {
      const url = buildBugReportUrl(huge);
      expect(url.length).toBeGreaterThan(0);
      expect(url.length).toBeLessThanOrEqual(MAX_ISSUE_URL_LENGTH);
    });

    it("measures the encoded length, not the raw character count", () => {
      // A raw-length cap would have kept ~6000 chars of source, which encodes to
      // well over the limit. Assert the retained source is meaningfully shorter.
      const body = bodyOf(buildBugReportUrl(huge));
      expect(body.length).toBeLessThan(MAX_ISSUE_URL_LENGTH);
    });

    it("keeps the header lines and marks the cut", () => {
      const body = bodyOf(buildBugReportUrl(huge));
      expect(body).toContain(BUG_REPORT_BODY_HEADING);
      expect(body).toContain("Tandem v1.2.3 (http)");
      expect(body).toContain("OS: Windows 11 Pro (10.0.26100)");
      expect(body).toContain("truncated");
      expect(body.trimEnd().endsWith("~~~")).toBe(true);
    });

    it("drops lines from the tail, not the head", () => {
      const body = bodyOf(buildBugReportUrl(huge));
      expect(body).toContain("check-0");
      expect(body).not.toContain("check-399");
    });

    it("falls back to the bare URL when not even one line fits", () => {
      expect(buildBugReportUrl("x".repeat(MAX_ISSUE_URL_LENGTH * 2))).toBe(TANDEM_ISSUES_NEW_URL);
    });
  });

  it("returns the bare URL rather than throwing on a lone surrogate", () => {
    // encodeURIComponent throws URIError here. Doctor messages interpolate
    // OS-supplied strings, so this is reachable, and an uncaught throw inside
    // the prefetch continuation would kill the feature silently.
    const url = buildBugReportUrl(`Tandem v1.2.3\nbroken: \uD800`);
    expect(url).toBe(TANDEM_ISSUES_NEW_URL);
  });

  it("always produces a parseable URL", () => {
    for (const input of ["short", "a\nb\nc", "with spaces & ampersands ?=#", "…unicode…"]) {
      expect(() => new URL(buildBugReportUrl(input))).not.toThrow();
    }
  });
});

// ---------------------------------------------------------------------------
// Composition with `formatDiagnostics` — placement of the client-log section
// ---------------------------------------------------------------------------

/**
 * These tests deliberately compose the REAL formatter rather than hand-building
 * a report string. `buildBugReportUrl` takes an opaque string and is unchanged
 * by #1439, so a hand-built input can only restate the truncation test above:
 * it passes identically whether the client-log section is rendered above the
 * check list or appended after it. Only the round-trip discriminates the two,
 * and the placement is the thing worth pinning — appended at the tail, the
 * section is the first thing truncation drops, so the fix would work for Copy
 * Diagnostics and silently not work for Report a bug.
 */
function bigPayload(checkCount: number): DiagnosticsPayload {
  return {
    report: {
      ok: true,
      crashed: false,
      failures: 0,
      warnings: 0,
      summary: "All checks passed. Tandem is ready.",
      error: null,
      results: Array.from({ length: checkCount }, (_, i) => ({
        check: `check-${i}`,
        status: "pass" as const,
        message: `probe ${i} completed and everything looked entirely normal here`,
      })),
    },
    version: "1.2.3",
    transport: "http",
    platform: "darwin",
    arch: "arm64",
    nodeVersion: "v22.0.0",
    tauriSidecar: true,
  };
}

function logEntries(): ClientLogEntry[] {
  return [
    {
      at: 1,
      firstAt: 1,
      level: "warn",
      scope: "wizard",
      event: "e0",
      detail: "OLDEST_MARKER",
      count: 1,
    },
    ...Array.from({ length: 4 }, (_, i) => ({
      at: 2 + i,
      firstAt: 2 + i,
      level: "warn" as const,
      scope: "wizard",
      event: `e${i + 1}`,
      detail: `FILLER_MARKER_${i}`,
      count: 1,
    })),
    {
      at: 9,
      firstAt: 8,
      level: "error",
      scope: "cowork",
      event: "e5",
      detail: "NEWEST_MARKER",
      count: 2,
    },
  ];
}

describe("buildBugReportUrl composed with formatDiagnostics", () => {
  it("keeps the newest client warning and drops check lines when over the cap", () => {
    const text = formatDiagnostics(bigPayload(60), { clientLog: logEntries() });
    // Precondition: the report really is too big, or this proves nothing.
    // The encoded body alone already exceeds the cap, so the full URL must.
    expect(encodeURIComponent(text).length).toBeGreaterThan(MAX_ISSUE_URL_LENGTH);

    const url = buildBugReportUrl(text);
    const body = bodyOf(url);

    expect(url.length).toBeLessThanOrEqual(MAX_ISSUE_URL_LENGTH);
    // (a) the highest-value header survives, as it always has
    expect(body).toContain("Tandem v1.2.3 (http, desktop)");
    // (b) the newest warning survives — this is what head placement buys
    expect(body).toContain("NEWEST_MARKER");
    // (c) the tail of the check list is what got dropped instead
    expect(body).not.toContain("check-59");
    expect(body).toContain("truncated");
  });

  it("still carries a usable check list when the buffer is full", () => {
    // The complement: the budget in `formatDiagnostics` is what stops the
    // section from evicting the entire doctor report ahead of itself.
    const clientLog = Array.from({ length: 20 }, (_, i) => ({
      at: i,
      firstAt: i,
      level: "warn" as const,
      scope: "wizard",
      event: `event-${i}`,
      detail: "D".repeat(160),
      count: 1,
    }));
    const body = bodyOf(buildBugReportUrl(formatDiagnostics(bigPayload(60), { clientLog })));

    expect(body).toContain("check-0");
    expect(body).toContain("check-5");
    // The char budget binds before the line budget at this detail length —
    // either way the section announces what it withheld.
    expect(body).toMatch(/\(showing [1-6] of 20\)/);
  });

  it("leaves the URL unchanged when the client log is empty", () => {
    const payload = bigPayload(3);
    expect(buildBugReportUrl(formatDiagnostics(payload, { clientLog: [] }))).toBe(
      buildBugReportUrl(formatDiagnostics(payload)),
    );
  });
});
