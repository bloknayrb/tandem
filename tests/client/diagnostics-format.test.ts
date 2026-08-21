import { describe, expect, it } from "vitest";
import type { ClientLogEntry } from "../../src/client/utils/client-log";
import type { DiagnosticsPayload } from "../../src/client/utils/diagnostics";
import {
  CLIENT_LOG_HEADING,
  formatDiagnostics,
  formatMemoryMb,
  MAX_CLIENT_LOG_CHARS,
  MAX_CLIENT_LOG_LINES,
  stripControlChars,
  summarizeUserAgent,
} from "../../src/client/utils/diagnostics";

/**
 * Unit tests for the pure clipboard formatter behind the About tab's
 * "Copy diagnostics" button (extract-over-mount: the button is thin glue,
 * the formatter carries the behavior).
 *
 * NOTE: `makePayload()` deliberately carries NONE of the optional host fields
 * (osRelease, osVersion, cpuModel, cpuCount, memory). Every assertion below
 * therefore doubles as the graceful-degradation contract: a payload from an
 * older server, or from a host where the `os.*` reads failed, must format
 * exactly as it did before those fields existed. Supply the host fields
 * per-case via `overrides` — never by widening these defaults.
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
      { check: "node-version", status: "pass", message: "Node.js v22.13.0 (>= 22.12.0 required)" },
      { check: "ports", status: "warn", message: "Partial: port up/down" },
      { check: "health", status: "fail", message: "Server not responding" },
    ];
    const lines = formatDiagnostics(payload).split("\n");
    const checkLines = lines.filter((l) => /^\[(ok|warn|fail)\]/.test(l));
    expect(checkLines).toEqual([
      "[ok]   node-version — Node.js v22.13.0 (>= 22.12.0 required)",
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

  it("emits no host lines when the payload carries none (degradation contract)", () => {
    // The whole point: an old server sends only the original seven fields.
    const lines = formatDiagnostics(makePayload()).split("\n");
    expect(lines[0]).toBe("Tandem v1.2.3 (http)");
    expect(lines[1]).toBe("win32/x64, Node v22.0.0");
    // Third line is the blank separator before the check list — nothing between.
    expect(lines[2]).toBe("");
  });
});

describe("formatDiagnostics — host information", () => {
  const allHostFields: Partial<DiagnosticsPayload> = {
    osRelease: "10.0.26100",
    osVersion: "Windows 11 Pro",
    cpuModel: "AMD Ryzen 7 5800X 8-Core Processor",
    cpuCount: 16,
    totalMemoryMb: 32768,
    freeMemoryMb: 6247,
  };

  function hostLines(overrides: Partial<DiagnosticsPayload>, browser?: string): string[] {
    const text = formatDiagnostics(makePayload(overrides), browser ? { browser } : undefined);
    // Everything between the fixed line 2 and the blank separator.
    return text.split("\n").slice(2, text.split("\n").indexOf(""));
  }

  it("renders OS, hardware, and browser lines when everything is present", () => {
    expect(hostLines(allHostFields, "Chrome 141")).toEqual([
      "OS: Windows 11 Pro (10.0.26100)",
      "CPU: AMD Ryzen 7 5800X 8-Core Processor x16, RAM: 32.0 GB total, 6.1 GB free",
      "Browser: Chrome 141",
    ]);
  });

  it("keeps the first two lines untouched when host fields are present", () => {
    const lines = formatDiagnostics(makePayload(allHostFields)).split("\n");
    expect(lines[0]).toBe("Tandem v1.2.3 (http)");
    expect(lines[1]).toBe("win32/x64, Node v22.0.0");
  });

  it.each([
    [{ osVersion: "Windows 11 Pro" }, "OS: Windows 11 Pro"],
    [{ osRelease: "10.0.26100" }, "OS: 10.0.26100"],
    [{ cpuModel: "Apple M2 Pro" }, "CPU: Apple M2 Pro"],
    [{ cpuCount: 12 }, "CPU: x12"],
    [{ totalMemoryMb: 16384 }, "RAM: 16.0 GB total"],
    [{ freeMemoryMb: 2048 }, "RAM: 2.0 GB free"],
  ])("renders %o as a single line", (overrides, expected) => {
    expect(hostLines(overrides)).toEqual([expected]);
  });

  it("combines CPU and RAM onto one line", () => {
    expect(hostLines({ cpuCount: 4, totalMemoryMb: 8192 })).toEqual(["CPU: x4, RAM: 8.0 GB total"]);
  });

  it("omits the browser line when the summary is empty or absent", () => {
    expect(hostLines({ cpuCount: 4 }, "")).toEqual(["CPU: x4"]);
    expect(hostLines({ cpuCount: 4 })).toEqual(["CPU: x4"]);
  });

  it("strips control characters from every OS-supplied string", () => {
    // All three come from the host and all three reach a terminal paste and a
    // public issue body — osRelease is not exempt.
    const lines = hostLines({
      osVersion: "Windows\x1b[31m 11",
      osRelease: "10.0\x1b]0;spoofed\x07.26100",
      cpuModel: "Fake\x07 CPU",
    });
    expect(lines).toEqual(["OS: Windows[31m 11 (10.0]0;spoofed.26100)", "CPU: Fake CPU"]);
    // biome-ignore lint/suspicious/noControlCharactersInRegex: asserting their absence
    expect(lines.join("\n")).not.toMatch(/[\x00-\x08\x0b-\x1f\x7f]/);
  });

  it("collapses whitespace-only host strings rather than printing empty labels", () => {
    expect(hostLines({ osVersion: "   ", cpuModel: "  " })).toEqual([]);
  });
});

describe("formatMemoryMb", () => {
  it.each([
    [32768, "32.0 GB"],
    [12288, "12.0 GB"],
    [6247, "6.1 GB"],
    [1024, "1.0 GB"],
    [512, "512 MB"],
  ])("formats %i MiB as %s", (mb, expected) => {
    expect(formatMemoryMb(mb)).toBe(expected);
  });
});

describe("summarizeUserAgent", () => {
  it.each([
    [
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36",
      "Chrome 141",
    ],
    [
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.2 Safari/605.1.15",
      "Safari 18",
    ],
    ["Mozilla/5.0 (X11; Linux x86_64; rv:133.0) Gecko/20100101 Firefox/133.0", "Firefox 133"],
  ])("summarizes %s", (ua, expected) => {
    expect(summarizeUserAgent(ua)).toBe(expected);
  });

  it("prefers the specific engine over the ones its UA impersonates", () => {
    // Edge's UA contains "Chrome", which contains "Safari". Order matters.
    expect(
      summarizeUserAgent(
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36 Edg/141.0.0.0",
      ),
    ).toBe("Edge 141");
    expect(
      summarizeUserAgent(
        "Mozilla/5.0 (Windows NT 10.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36 OPR/125.0.0.0",
      ),
    ).toBe("Opera 125");
  });

  it("recognizes HeadlessChrome, which has no word boundary before 'Chrome'", () => {
    expect(
      summarizeUserAgent(
        "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/141.0.0.0 Safari/537.36",
      ),
    ).toBe("HeadlessChrome 141");
  });

  it("falls back to WebKit for the macOS desktop WebView", () => {
    // The Tauri build is the primary distribution, and macOS WKWebView sends no
    // Chrome/, no Edg/, and often no "Version/… Safari/" token. Without the
    // AppleWebKit fallback the Browser line vanishes for exactly the users
    // whose engine version a bug report most needs.
    expect(
      summarizeUserAgent(
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko)",
      ),
    ).toBe("WebKit 605");
  });

  it("still prefers a named browser over the WebKit fallback", () => {
    expect(
      summarizeUserAgent(
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36",
      ),
    ).toBe("Chrome 141");
  });

  it("returns an empty string for an unrecognized agent, which drops the line", () => {
    expect(summarizeUserAgent("")).toBe("");
    expect(summarizeUserAgent("SomeCrawler/1.0")).toBe("");
  });
});

describe("stripControlChars", () => {
  // #1422 widened this from ASCII control chars only to also strip Unicode
  // bidi/format-override characters (U+200E/F, U+202A-E, U+2066-9, U+061C —
  // "Trojan Source"-style characters that visually reorder text without
  // being `<`/`>`/`&`), since `IntegrationTargetCard.svelte` reuses this
  // function on config-file-derived text where that threat is real. The
  // module's other tests (above) only ever exercised the pre-existing
  // ASCII-control-char half — this pins the widened half directly, so a
  // regression there can't hide behind the doctor-report tests still
  // passing.
  it("strips every character in the added bidi/format range", () => {
    const dirty = "a‎b‏c‪‫‬‭‮d⁦⁧⁨⁩e؜f";
    expect(stripControlChars(dirty)).toBe("abcdef");
  });

  it("strips a real bidi-override + ANSI OSC payload, keeping ordinary text", () => {
    const dirty = "got '‮js.exe‬\x1b]0;pwn\x07'";
    expect(stripControlChars(dirty)).toBe("got 'js.exe]0;pwn'");
  });

  it("leaves ordinary Unicode text (accents, CJK, emoji) untouched", () => {
    const clean = "café 日本語 🎉";
    expect(stripControlChars(clean)).toBe(clean);
  });
});

// ---------------------------------------------------------------------------
// Client-log section (#1439)
// ---------------------------------------------------------------------------

function entry(overrides: Partial<ClientLogEntry> = {}): ClientLogEntry {
  return {
    at: 1.5,
    firstAt: 1.5,
    level: "warn",
    scope: "wizard",
    event: "clipboard write failed",
    detail: "NotAllowedError: Write permission denied",
    count: 1,
    ...overrides,
  };
}

describe("formatDiagnostics — client log", () => {
  it("renders nothing at all when there is no client log", () => {
    // The degradation contract: a report with no client warnings is
    // byte-identical to one produced before this section existed.
    const baseline = formatDiagnostics(makePayload());
    expect(formatDiagnostics(makePayload(), {})).toBe(baseline);
    expect(formatDiagnostics(makePayload(), { clientLog: [] })).toBe(baseline);
    expect(baseline).not.toContain("Recent client warnings");
  });

  it("sits between the host block and the checks, with its own separator", () => {
    // `hostLines()` above slices to the FIRST blank line and asserts with
    // toEqual, so the host block must still end there.
    const payload = makePayload();
    payload.report.results = [{ check: "ports", status: "pass", message: "3478/3479 free" }];
    const lines = formatDiagnostics(payload, {
      browser: "Chrome 141",
      clientLog: [entry()],
    }).split("\n");

    expect(lines[2]).toBe("Browser: Chrome 141");
    expect(lines[3]).toBe("");
    expect(lines[4]).toBe(CLIENT_LOG_HEADING);
    expect(lines[5]).toBe(
      "[warn] +1.5s wizard: clipboard write failed — NotAllowedError: Write permission denied",
    );
    expect(lines[6]).toBe("");
    expect(lines[7]).toBe("[ok]   ports — 3478/3479 free");
  });

  it("renders newest first, so tail truncation drops the oldest", () => {
    const text = formatDiagnostics(makePayload(), {
      clientLog: [
        entry({ event: "oldest", at: 1 }),
        entry({ event: "middle", at: 2 }),
        entry({ event: "newest", at: 3, firstAt: 0.4, level: "error", count: 3 }),
      ],
    });
    const rendered = text
      .split("\n")
      .filter((l) => l.startsWith("[warn] +") || l.startsWith("[error] +"));
    expect(rendered[0]).toContain("newest");
    // The first-seen stamp rides with the count: `at` is the newest occurrence,
    // so `(x3)` alone cannot say whether they were a burst or spread out.
    expect(rendered[0]).toContain("(x3, first +0.4s)");
    expect(rendered[0].startsWith("[error]")).toBe(true);
    expect(rendered[2]).toContain("oldest");
  });

  it("omits the detail separator when there is no cause", () => {
    const text = formatDiagnostics(makePayload(), { clientLog: [entry({ detail: "" })] });
    expect(text).toContain("[warn] +1.5s wizard: clipboard write failed\n");
  });

  it("budgets the section so a full buffer cannot evict the doctor report", () => {
    // Truncation drops from the tail and this section sits above the checks, so
    // an unbudgeted section eats the entire check list before losing one entry.
    const clientLog = Array.from({ length: 19 }, (_, i) =>
      entry({ event: `event ${i}`, at: i, detail: "D".repeat(160) }),
    );
    const lines = formatDiagnostics(makePayload(), { clientLog }).split("\n");
    const section = lines.slice(lines.indexOf(CLIENT_LOG_HEADING) + 1, lines.indexOf("", 4));
    const body = section.filter((l) => !l.startsWith("(showing"));

    expect(body.length).toBeLessThanOrEqual(MAX_CLIENT_LOG_LINES);
    expect(body.join("\n").length).toBeLessThanOrEqual(MAX_CLIENT_LOG_CHARS);
    expect(section.at(-1)).toBe(`(showing ${body.length} of 19)`);
    // Newest survive the budget; the oldest are the ones withheld.
    expect(body[0]).toContain("event 18");
    expect(lines.join("\n")).not.toContain("event 0 ");
  });

  it("honours per-call budget overrides", () => {
    const clientLog = [entry({ event: "a" }), entry({ event: "b" }), entry({ event: "c" })];
    const text = formatDiagnostics(makePayload(), { clientLog }, { maxClientLogLines: 1 });
    expect(text).toContain("(showing 1 of 3)");
    expect(text).not.toContain(": a ");
  });

  it("emits at least one entry even when a single line blows the char budget", () => {
    const text = formatDiagnostics(
      makePayload(),
      { clientLog: [entry({ detail: "D".repeat(160) })] },
      { maxClientLogChars: 10 },
    );
    expect(text).toContain("[warn] +1.5s wizard: clipboard write failed — DDD");
  });

  it("strips control characters from a rendered entry", () => {
    // Defense in depth: `detail` is already scrubbed on the way into the ring
    // buffer, but every other line of this report goes through the same strip
    // that the check lines do.
    const esc = String.fromCharCode(27);
    const text = formatDiagnostics(makePayload(), {
      clientLog: [entry({ detail: `Error: ${esc}[31mred${esc}[0m` })],
    });
    expect(text).toContain("Error: [31mred[0m");
    expect(text).not.toContain(esc);
  });
});
