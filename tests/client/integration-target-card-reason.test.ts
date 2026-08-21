import { describe, expect, it } from "vitest";

import {
  REASON_POLICY,
  REASON_STATUS_COPY,
  renderValidationReason,
  sanitizeReason,
  statusCopy,
  UNKNOWN_STATUS_COPY,
} from "../../src/client/components/integration-target-card-reason.js";
import type { EntryValidationStatus, McpEntry } from "../../src/shared/integrations/contract.js";

const httpEntry = (url: string): McpEntry => ({ type: "http", url });
const npxEntry = (args: string[]): McpEntry => ({ command: "npx", args });

describe("renderValidationReason — per-status policy (#1422)", () => {
  // THE ISSUE'S HEADLINE CASE. #1422 quotes an interpolating invalid-command
  // reason and says the user "sees a card that declines to connect and gives
  // no reason". The interpolated value is a command path, which is no more
  // sensitive than `install.target.configPath`, already rendered verbatim one
  // line below on the same card. Withholding it is the bug being fixed, so
  // this test is the one that has to stay green.
  it("renders an invalid-command reason in full, including the command it names", () => {
    const result = renderValidationReason(
      {
        status: "invalid-command",
        reason: "command must be a Node-shaped binary or 'npx'; got '\\\\server\\share\\node.exe'",
      },
      { command: "\\\\server\\share\\node.exe" },
    );
    expect(result.diagnostic).toBe(true);
    expect(result.text).toBe(
      "command must be a Node-shaped binary or 'npx'; got '\\\\server\\share\\node.exe'",
    );
    expect(result.text).not.toBe(REASON_STATUS_COPY["invalid-command"]);
  });

  // Same status, the OTHER producer: validateChannelEntry's. The policy is
  // keyed on status, not on which validator produced the string, so this
  // renders in full too — the exact string #1422 quotes in its body.
  it("renders validateChannelEntry's invalid-command reason in full as well", () => {
    const result = renderValidationReason(
      {
        status: "invalid-command",
        reason: "tandem-channel command must be Node-shaped; got '/usr/bin/python'",
      },
      { command: "/usr/bin/python" },
    );
    expect(result).toEqual({
      text: "tandem-channel command must be Node-shaped; got '/usr/bin/python'",
      diagnostic: true,
    });
  });

  it("renders a fixed-literal invalid-shape reason in full", () => {
    expect(
      renderValidationReason(
        { status: "invalid-shape", reason: "stdio entry missing command" },
        {},
      ),
    ).toEqual({
      text: "stdio entry missing command",
      diagnostic: true,
    });
  });

  it("renders the Node-branch invalid-args literal in full (no args payload in it)", () => {
    const result = renderValidationReason(
      { status: "invalid-args", reason: "node-shaped stdio entry must take exactly one .js arg" },
      { command: "/usr/local/bin/node", args: ["a.js", "b.js"] },
    );
    expect(result).toEqual({
      text: "node-shaped stdio entry must take exactly one .js arg",
      diagnostic: true,
    });
  });

  describe("invalid-url — never the raw url", () => {
    // LoopbackUrl.safeParse rejects a non-empty username/password, so "the
    // url embeds a credential" is a reachable way to land on this status.
    it("reduces to scheme + host + port, dropping userinfo, path and query", () => {
      const result = renderValidationReason(
        {
          status: "invalid-url",
          reason:
            "url must be loopback http; got http://user:hunter2@evil.example:8443/mcp?t=sk-live-abc",
        },
        httpEntry("http://user:hunter2@evil.example:8443/mcp?t=sk-live-abc"),
      );
      expect(result).toEqual({
        text: "url must be a loopback http url; got http://evil.example:8443",
        diagnostic: true,
      });
      expect(result.text).not.toContain("hunter2");
      expect(result.text).not.toContain("user");
      expect(result.text).not.toContain("sk-live-abc");
      expect(result.text).not.toContain("/mcp");
    });

    it("keeps the port, which is the whole diagnostic for a wrong-port loopback url", () => {
      const result = renderValidationReason(
        {
          status: "invalid-url",
          reason: "url must be loopback http; got https://127.0.0.1:9999/mcp",
        },
        httpEntry("https://127.0.0.1:9999/mcp"),
      );
      expect(result.text).toBe("url must be a loopback http url; got https://127.0.0.1:9999");
    });

    it("names the scheme alone when the url has no authority", () => {
      const result = renderValidationReason(
        { status: "invalid-url", reason: "url must be loopback http; got file:///etc/passwd" },
        httpEntry("file:///etc/passwd"),
      );
      expect(result.text).toBe("url must be a loopback http url; got file:");
      expect(result.text).not.toContain("passwd");
    });

    it("falls back to status copy when the url cannot be parsed at all", () => {
      const result = renderValidationReason(
        { status: "invalid-url", reason: "url must be loopback http; got ::::not a url::::" },
        httpEntry("::::not a url::::"),
      );
      expect(result).toEqual({ text: REASON_STATUS_COPY["invalid-url"], diagnostic: false });
    });

    it("falls back to status copy when the entry carries no url at all", () => {
      const result = renderValidationReason(
        { status: "invalid-url", reason: "url must be loopback http; got something" },
        {},
      );
      expect(result).toEqual({ text: REASON_STATUS_COPY["invalid-url"], diagnostic: false });
    });
  });

  describe("invalid-args (npx) — count, never the array", () => {
    // The concrete leak: a hand-edited npx entry whose args carry a secret.
    // The producer interpolates JSON.stringify(args) wholesale.
    it("renders the expected tuple and the argument count, not the arguments", () => {
      const result = renderValidationReason(
        {
          status: "invalid-args",
          reason:
            'npx args must be ["-y","tandem-editor","mcp-stdio"]; got ["-y","@acme/mcp","--api-key","sk-live-abc123"]',
        },
        npxEntry(["-y", "@acme/mcp", "--api-key", "sk-live-abc123"]),
      );
      expect(result.diagnostic).toBe(true);
      expect(result.text).toContain('["-y","tandem-editor","mcp-stdio"]');
      expect(result.text).toContain("got 4 arguments");
      expect(result.text).not.toContain("sk-live-abc123");
      expect(result.text).not.toContain("@acme/mcp");
      expect(result.text).not.toContain("--api-key");
    });

    it("singularizes a one-argument count", () => {
      const result = renderValidationReason(
        { status: "invalid-args", reason: 'npx args must be [...]; got ["whatever"]' },
        npxEntry(["whatever"]),
      );
      expect(result.text).toContain("got 1 argument");
      expect(result.text).not.toContain("1 arguments");
      expect(result.text).not.toContain("whatever");
    });

    it("reports zero when the npx entry has no args array", () => {
      const result = renderValidationReason(
        { status: "invalid-args", reason: "npx args must be [...]; got []" },
        { command: "npx" },
      );
      expect(result.text).toContain("got 0 arguments");
    });
  });

  describe("absent, empty and unknown", () => {
    it("falls back to status copy when reason is undefined", () => {
      expect(renderValidationReason({ status: "invalid-shape" }, {})).toEqual({
        text: REASON_STATUS_COPY["invalid-shape"],
        diagnostic: false,
      });
    });

    // `??` alone would not cover this: "" is neither null nor undefined, and
    // rendering it would leave a blank diagnostic row on a locked card.
    it("falls back to status copy when reason is the empty string", () => {
      const result = renderValidationReason({ status: "invalid-command", reason: "" }, {});
      expect(result).toEqual({ text: REASON_STATUS_COPY["invalid-command"], diagnostic: false });
      expect(result.text.length).toBeGreaterThan(0);
    });

    it("falls back to status copy when reason is only control characters", () => {
      const result = renderValidationReason({ status: "invalid-command", reason: "‮‬\x1b" }, {});
      expect(result).toEqual({ text: REASON_STATUS_COPY["invalid-command"], diagnostic: false });
    });

    // FINDING 2 / union drift: EntryValidationStatus is declared twice (server
    // producer + shared contract) with no structural tie. A status added
    // server-side and not mirrored arrives here as a key no Record has, and an
    // unguarded lookup renders the literal text "undefined" on the card.
    it("renders fallback copy, never the string 'undefined', for a status this build has never heard of", () => {
      const future = "invalid-transport" as EntryValidationStatus;
      const result = renderValidationReason(
        { status: future, reason: "transport must be stdio or http; got 'quic'" },
        {},
      );
      expect(result).toEqual({ text: UNKNOWN_STATUS_COPY, diagnostic: false });
      expect(result.text).not.toContain("undefined");
      expect(statusCopy(future)).toBe(UNKNOWN_STATUS_COPY);
    });
  });

  it("every non-valid status has non-empty copy, and the three reduced/withheld ones are distinguishable", () => {
    const statuses = ["invalid-shape", "invalid-url", "invalid-command", "invalid-args"] as const;
    for (const status of statuses) {
      expect(REASON_STATUS_COPY[status].length).toBeGreaterThan(0);
    }
    // invalid-shape keeps the historic generic sentence; the other three must
    // each name their own failed check or the fallback adds no information.
    expect(new Set(statuses.map((s) => REASON_STATUS_COPY[s])).size).toBe(4);
  });

  it("the policy table covers every status in the shared union", () => {
    const statuses: EntryValidationStatus[] = [
      "valid",
      "invalid-shape",
      "invalid-url",
      "invalid-command",
      "invalid-args",
    ];
    expect(Object.keys(REASON_POLICY).sort()).toEqual([...statuses].sort());
    expect(Object.keys(REASON_STATUS_COPY).sort()).toEqual([...statuses].sort());
  });
});

describe("sanitizeReason (#1422)", () => {
  it("passes a reason of exactly 300 chars through unchanged", () => {
    const input = "a".repeat(300);
    const output = sanitizeReason(input);
    expect(output).toBe(input);
    expect(output.endsWith("…")).toBe(false);
    expect(output.length).toBe(300);
  });

  it("clamps a reason of 301 chars to 300 + ellipsis, preserving the first 300 chars", () => {
    const input = "a".repeat(301);
    const output = sanitizeReason(input);
    expect(output.length).toBe(301); // 300 kept chars + 1 ellipsis char
    expect(output.slice(0, 300)).toBe(input.slice(0, 300));
    expect(output.endsWith("…")).toBe(true);
  });

  // The strip is a real behavior independent of the clamp: a SHORT string
  // carrying control/bidi/ANSI characters must come out clean. The fixture
  // embeds a bidi override (U+202E/U+202C, the "Trojan Source" pair) around
  // "js.exe" plus an ANSI OSC "set window title" sequence (ESC ] 0 ; … BEL).
  const dirty = "got '‮js.exe‬\x1b]0;pwn\x07'";

  it("strips every character stripControlChars documents removing", () => {
    const output = sanitizeReason(dirty);
    // biome-ignore lint/suspicious/noControlCharactersInRegex: asserting their absence
    expect(output).not.toMatch(/[‎‏‪-‮⁦-⁩؜\x00-\x08\x0b-\x1f\x7f]/);
  });

  it("strips exactly the flagged characters and nothing else", () => {
    // Only the bidi overrides and the ESC/BEL control bytes are gone; the
    // literal "]0;" from the OSC payload is ordinary printable text.
    expect(sanitizeReason(dirty)).toBe("got 'js.exe]0;pwn'");
  });

  it("clamps on code points, never splitting a surrogate pair", () => {
    const input = `${"x".repeat(299)}\u{1F600}`; // 300 code points, 301 UTF-16 units
    expect(sanitizeReason(input)).toBe(input);
    expect(sanitizeReason(input)).not.toContain("�");

    const over = `${"x".repeat(300)}\u{1F600}`; // 301 code points -> must clamp
    const clamped = sanitizeReason(over);
    expect(clamped).not.toContain("�");
    expect(clamped).toBe(`${"x".repeat(300)}…`);
  });

  // The clamp is load-bearing for the two unbounded inputs the policy renders
  // in full: an invalid-command reason (a command path of any length) and
  // install.errorMessage.
  it("clamps a pathological invalid-command reason rendered under the verbatim policy", () => {
    const reason = `command must be a Node-shaped binary or 'npx'; got '${"/nested".repeat(200)}'`;
    const result = renderValidationReason({ status: "invalid-command", reason }, { command: "x" });
    expect(result.diagnostic).toBe(true);
    expect([...result.text].length).toBe(301);
    expect(result.text.endsWith("…")).toBe(true);
  });
});
