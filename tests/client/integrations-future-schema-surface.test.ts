// @vitest-environment happy-dom

/**
 * #1792 item 2, client half. The server's 409 for a downgraded
 * `integrations.json` carries an actionable `message`; both surfaces used to
 * render only `res.status`, so a wire-only fix would have changed nothing the
 * user sees.
 */

import { render, waitFor } from "@testing-library/svelte";
import { flushSync } from "svelte";
import { afterEach, describe, expect, it, vi } from "vitest";
import SettingsClaudeCodeTab from "../../src/client/components/settings-tabs/SettingsClaudeCodeTab.svelte";
import { createIntegrationWizard } from "../../src/client/hooks/useIntegrationWizard.svelte.js";
import type { TandemSettings } from "../../src/client/hooks/useTandemSettings.svelte";

const FUTURE_MESSAGE =
  "integrations.json was written by a newer Tandem (schemaVersion 9; this build supports 3). Update Tandem, or remove the integrations file.";

function makeProps() {
  return {
    open: true,
    settings: {
      selectionDwellMs: 1000,
      selectionToolbar: true,
      marginView: false,
    } as TandemSettings,
    onUpdate: vi.fn(),
    connected: true,
    reconnectAttempts: 0,
    readOnly: false,
    notify: vi.fn(),
  };
}

const byTestId = (container: HTMLElement, id: string) =>
  container.querySelector<HTMLElement>(`[data-testid='${id}']`);

function stubFetch(status: number, body: unknown | "unparseable") {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue({
      ok: false,
      status,
      json: async () => {
        if (body === "unparseable") throw new SyntaxError("Unexpected token");
        return body;
      },
    }),
  );
}

function wizardFetch(status: number, body: unknown | "unparseable"): typeof fetch {
  return (async () =>
    ({
      ok: false,
      status,
      json: async () => {
        if (body === "unparseable") throw new SyntaxError("Unexpected token");
        return body;
      },
    }) as unknown as Response) as unknown as typeof fetch;
}

describe("SettingsClaudeCodeTab — future-schema integrations error", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("renders the server's message, naming both schema numbers", async () => {
    stubFetch(409, { message: FUTURE_MESSAGE });
    const { container } = render(SettingsClaudeCodeTab, { props: makeProps() });

    await waitFor(() => {
      const banner = byTestId(container, "settings-modal-working-directory-load-error");
      expect(banner?.textContent ?? "").toContain("schemaVersion 9");
    });
    const text = byTestId(container, "settings-modal-working-directory-load-error")?.textContent;
    expect(text).toContain("supports 3");
    expect(text).not.toContain("HTTP 409");
  });

  it("falls back to the status line when the body carries no message", async () => {
    stubFetch(409, { error: "CONFLICT" });
    const { container } = render(SettingsClaudeCodeTab, { props: makeProps() });
    await waitFor(() => {
      expect(
        byTestId(container, "settings-modal-working-directory-load-error")?.textContent ?? "",
      ).toContain("HTTP 409");
    });
  });

  it("falls back to the status line when the body will not parse", async () => {
    stubFetch(409, "unparseable");
    const { container } = render(SettingsClaudeCodeTab, { props: makeProps() });
    await waitFor(() => {
      expect(
        byTestId(container, "settings-modal-working-directory-load-error")?.textContent ?? "",
      ).toContain("HTTP 409");
    });
  });
});

describe("useIntegrationWizard — future-schema integrations error", () => {
  it("renders the server's message, naming both schema numbers", async () => {
    const wizard = createIntegrationWizard({
      fetchFn: wizardFetch(409, { message: FUTURE_MESSAGE }),
    });
    await wizard.begin();
    flushSync();
    expect(wizard.step).toBe("error");
    expect(wizard.errorMessage).toContain("schemaVersion 9");
    expect(wizard.errorMessage).toContain("supports 3");
  });

  it("falls back to the status line when the body carries no message", async () => {
    const wizard = createIntegrationWizard({ fetchFn: wizardFetch(409, { error: "CONFLICT" }) });
    await wizard.begin();
    flushSync();
    expect(wizard.errorMessage).toMatch(/HTTP 409/);
  });

  it("falls back to the status line when the body will not parse", async () => {
    const wizard = createIntegrationWizard({ fetchFn: wizardFetch(409, "unparseable") });
    await wizard.begin();
    flushSync();
    expect(wizard.errorMessage).toMatch(/HTTP 409/);
  });
});
