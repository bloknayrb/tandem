// @vitest-environment happy-dom

import { cleanup, render } from "@testing-library/svelte";
import { afterEach, describe, expect, it } from "vitest";

import IntegrationTargetCard from "../../src/client/components/IntegrationTargetCard.svelte";
import { REASON_STATUS_COPY } from "../../src/client/components/integration-target-card-reason.js";
import type { ExistingMcpInstall } from "../../src/shared/integrations/contract.js";

afterEach(() => cleanup());

// Mirrors the `base()` fixture helper in useIntegrationWizard.test.ts.
const base = (over: Partial<ExistingMcpInstall>): ExistingMcpInstall => ({
  target: { kind: "claude-code", label: "Claude Code", configPath: "/x/.claude.json" },
  status: "ok",
  ...over,
});

const noop = () => {};

function renderCard(install: ExistingMcpInstall): HTMLElement {
  return render(IntegrationTargetCard, { props: { install, selected: false, onToggle: noop } })
    .container;
}

function statusText(container: HTMLElement): string {
  return container.querySelector(".itc-status")?.textContent ?? "";
}

function statusHasDiagnosticClass(container: HTMLElement): boolean {
  return (
    container.querySelector(".itc-status")?.classList.contains("itc-status-diagnostic") ?? false
  );
}

describe("IntegrationTargetCard status line (#1422)", () => {
  // THE ISSUE'S HEADLINE CASE, end to end through the rendered DOM: a
  // non-Node-shaped `command` used to render "Has a custom setup — we won't
  // touch it" and nothing else.
  it("renders an invalid-command reason in full, with the diagnostic styling class", () => {
    const container = renderCard(
      base({
        tandemEntry: { command: "/usr/bin/python", args: ["server.py"] },
        tandemValidation: {
          status: "invalid-command",
          reason: "command must be a Node-shaped binary or 'npx'; got '/usr/bin/python'",
        },
      }),
    );

    expect(statusText(container)).toBe(
      "command must be a Node-shaped binary or 'npx'; got '/usr/bin/python'",
    );
    expect(statusText(container)).not.toBe(REASON_STATUS_COPY["invalid-command"]);
    expect(statusHasDiagnosticClass(container)).toBe(true);
  });

  it("renders a fixed-literal invalid-shape reason in full", () => {
    const container = renderCard(
      base({
        tandemEntry: { type: "http" },
        tandemValidation: { status: "invalid-shape", reason: "HTTP entry missing url" },
      }),
    );

    expect(statusText(container)).toBe("HTTP entry missing url");
    expect(statusHasDiagnosticClass(container)).toBe(true);
  });

  // invalid-url is the one status whose interpolated value can be a
  // credential: LoopbackUrl rejects a non-empty username/password, so a
  // userinfo URL is a reachable way to land here.
  it("reduces an invalid-url reason to scheme + host + port, dropping the credential", () => {
    const container = renderCard(
      base({
        tandemEntry: { type: "http", url: "http://user:hunter2@evil.example:8443/mcp" },
        tandemValidation: {
          status: "invalid-url",
          reason: "url must be loopback http; got http://user:hunter2@evil.example:8443/mcp",
        },
      }),
    );

    expect(statusText(container)).toBe(
      "url must be a loopback http url; got http://evil.example:8443",
    );
    expect(statusText(container)).not.toContain("hunter2");
    expect(statusHasDiagnosticClass(container)).toBe(true);
  });

  // The npx producer interpolates JSON.stringify(args) wholesale.
  it("reduces an npx invalid-args reason to the expected tuple plus a count", () => {
    const container = renderCard(
      base({
        tandemEntry: { command: "npx", args: ["-y", "@acme/mcp", "--api-key", "sk-live-abc123"] },
        tandemValidation: {
          status: "invalid-args",
          reason:
            'npx args must be ["-y","tandem-editor","mcp-stdio"]; got ["-y","@acme/mcp","--api-key","sk-live-abc123"]',
        },
      }),
    );

    expect(statusText(container)).toContain('["-y","tandem-editor","mcp-stdio"]');
    expect(statusText(container)).toContain("got 4 arguments");
    expect(statusText(container)).not.toContain("sk-live-abc123");
    expect(statusHasDiagnosticClass(container)).toBe(true);
  });

  // Same status, the other producer: a Node-shaped command with the wrong arg
  // count. Its reason is a fixed literal and renders in full — which is why
  // the args policy keys on the entry's command, not on the status alone.
  it("renders the Node-branch invalid-args literal in full", () => {
    const container = renderCard(
      base({
        tandemEntry: { command: "/usr/local/bin/node", args: ["a.js", "b.js"] },
        tandemValidation: {
          status: "invalid-args",
          reason: "node-shaped stdio entry must take exactly one .js arg",
        },
      }),
    );

    expect(statusText(container)).toBe("node-shaped stdio entry must take exactly one .js arg");
    expect(statusHasDiagnosticClass(container)).toBe(true);
  });

  it("falls back to status copy when reason is absent", () => {
    const container = renderCard(
      base({
        tandemEntry: { type: "http", url: "http://127.0.0.1:3479/mcp" },
        tandemValidation: { status: "invalid-shape" },
      }),
    );

    expect(statusText(container)).toBe("Has a custom setup — we won't touch it");
    expect(statusHasDiagnosticClass(container)).toBe(false);
  });

  it("falls back to status copy, not a blank row, when reason is the empty string", () => {
    const container = renderCard(
      base({
        tandemEntry: { type: "http", url: "http://127.0.0.1:3479/mcp" },
        tandemValidation: { status: "invalid-args", reason: "" },
      }),
    );

    expect(statusText(container).length).toBeGreaterThan(0);
    expect(statusText(container)).toBe(REASON_STATUS_COPY["invalid-args"]);
    expect(statusHasDiagnosticClass(container)).toBe(false);
  });

  // FINDING 2: a status the shared union has never heard of must not render
  // the literal text "undefined" through the Record lookup.
  it("renders fallback copy, never 'undefined', for an unknown status", () => {
    const container = renderCard(
      base({
        tandemEntry: { type: "http", url: "http://127.0.0.1:3479/mcp" },
        // biome-ignore lint/suspicious/noExplicitAny: simulating server-side union drift
        tandemValidation: { status: "invalid-transport" as any, reason: "transport 'quic'" },
      }),
    );

    expect(statusText(container)).toBe("Has a custom setup — we won't touch it");
    expect(statusText(container)).not.toContain("undefined");
    expect(statusHasDiagnosticClass(container)).toBe(false);
  });

  // `errorMessage` is a raw readFile failure: path-bearing, unbounded, behind
  // no policy. Same sanitize floor, and the same wrap treatment — it is the
  // longest string this card can render.
  it("clamps, strips and wraps a pathological errorMessage", () => {
    const container = renderCard(
      base({
        status: "error",
        errorMessage: `EACCES: permission denied, open '/x'${"\x1b[31m".repeat(80)}`,
      }),
    );

    const text = statusText(container);
    expect(text.startsWith("Couldn't check this one — EACCES")).toBe(true);
    // biome-ignore lint/suspicious/noControlCharactersInRegex: asserting their absence
    expect(text).not.toMatch(/[\x00-\x08\x0b-\x1f\x7f]/);
    expect(text.length).toBeLessThanOrEqual("Couldn't check this one — ".length + 301);
    expect(statusHasDiagnosticClass(container)).toBe(true);
  });

  it("gives the no-errorMessage error branch no diagnostic treatment", () => {
    const container = renderCard(base({ status: "error" }));
    expect(statusText(container)).toBe("Couldn't check this one");
    expect(statusHasDiagnosticClass(container)).toBe(false);
  });

  // The card reads tandemValidation only. channelValidation rides the same
  // object and is reported by the Done step's aggregate push line instead;
  // pinned so "surface it here too" is a deliberate change, not a drive-by.
  it("ignores channelValidation, including a failing one", () => {
    const container = renderCard(
      base({
        tandemEntry: { type: "http", url: "http://127.0.0.1:3479/mcp" },
        tandemValidation: { status: "valid" },
        channelEntry: { command: "/usr/bin/python", args: ["shim.js"] },
        channelValidation: {
          status: "invalid-command",
          reason: "tandem-channel command must be Node-shaped; got '/usr/bin/python'",
        },
      }),
    );

    expect(statusText(container)).toBe("Already connected — we'll refresh it");
    expect(statusText(container)).not.toContain("tandem-channel");
  });

  it("regression: still shows 'Already connected' when the entry is valid", () => {
    const container = renderCard(
      base({
        tandemEntry: { type: "http", url: "http://127.0.0.1:3479/mcp" },
        tandemValidation: { status: "valid" },
      }),
    );

    expect(statusText(container)).toBe("Already connected — we'll refresh it");
    expect(statusHasDiagnosticClass(container)).toBe(false);
  });

  it("regression: still shows the missing-file copy when there is no entry", () => {
    const container = renderCard(base({ status: "missing" }));
    expect(statusText(container)).toBe("Ready to connect (settings file will be created)");
  });
});
