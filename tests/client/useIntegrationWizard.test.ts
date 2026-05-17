// @vitest-environment happy-dom
import { flushSync } from "svelte";
import { describe, expect, it } from "vitest";

import { createIntegrationWizard } from "../../src/client/hooks/useIntegrationWizard.svelte.js";
import {
  ERROR_CODE_KEYCHAIN_UNAVAILABLE,
  INTEGRATIONS_SCHEMA_VERSION,
} from "../../src/shared/integrations/contract.js";

/**
 * Build a `fetch` stub that dispatches by URL+method. Each handler returns
 * `{ status, body }`; the stub wraps it in a `Response`.
 */
function makeFetchStub(
  handlers: Array<{
    method: string;
    urlMatch: RegExp;
    handler: (body: unknown) => { status: number; body: unknown };
  }>,
): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(init.body as string) : undefined;
    const match = handlers.find((h) => h.method === method && h.urlMatch.test(url));
    if (!match) {
      return new Response(JSON.stringify({ error: "no-stub-match", url }), {
        status: 500,
        headers: { "content-type": "application/json" },
      });
    }
    const { status, body: respBody } = match.handler(body);
    return new Response(JSON.stringify(respBody), {
      status,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
}

describe("createIntegrationWizard", () => {
  it("begin() fetches existing entries and lands on step=detect", async () => {
    const wizard = createIntegrationWizard({
      fetchFn: makeFetchStub([
        {
          method: "GET",
          urlMatch: /\/api\/integrations\/existing$/,
          handler: () => ({
            status: 200,
            body: {
              installs: [
                {
                  target: { kind: "claude-code", label: "Claude Code", configPath: "/x" },
                  status: "ok",
                  tandemEntry: { type: "http", url: "http://127.0.0.1:3479/mcp" },
                },
              ],
            },
          }),
        },
      ]),
    });
    await wizard.begin();
    flushSync();
    expect(wizard.step).toBe("detect");
    expect(wizard.existing).toHaveLength(1);
    expect(wizard.errorMessage).toBeNull();
  });

  it("begin() surfaces errors via step=error", async () => {
    const wizard = createIntegrationWizard({
      fetchFn: makeFetchStub([
        {
          method: "GET",
          urlMatch: /\/api\/integrations\/existing$/,
          handler: () => ({ status: 500, body: { error: "boom" } }),
        },
      ]),
    });
    await wizard.begin();
    flushSync();
    expect(wizard.step).toBe("error");
    expect(wizard.errorMessage).toMatch(/HTTP 500/);
  });

  it("submitSecret(): stores secret and stamps tokenSecretRef on the picked config", async () => {
    const wizard = createIntegrationWizard({
      fetchFn: makeFetchStub([
        {
          method: "POST",
          urlMatch: /\/api\/integrations\/secrets\//,
          handler: () => ({ status: 204, body: null }),
        },
      ]),
    });
    wizard.setPicked([
      {
        id: "cc-1",
        config: {
          kind: "claude-code",
          id: "cc-1",
          label: "Claude Code",
          configPath: "/x",
          transport: "http",
          url: "http://127.0.0.1:3479",
        },
        hasStoredSecret: false,
        keychainUnavailable: false,
      },
    ]);
    flushSync();
    await wizard.submitSecret(wizard.picked[0]!, "shhh");
    flushSync();
    expect(wizard.picked[0]?.hasStoredSecret).toBe(true);
    expect(wizard.picked[0]?.config.tokenSecretRef).toMatch(/^cc-1-/);
    expect(wizard.keychainUnavailable).toBe(false);
  });

  it("submitSecret(): 503 KEYCHAIN_UNAVAILABLE flips wizard into fallback mode", async () => {
    const wizard = createIntegrationWizard({
      fetchFn: makeFetchStub([
        {
          method: "POST",
          urlMatch: /\/api\/integrations\/secrets\//,
          handler: () => ({
            status: 503,
            body: { error: "SERVICE_UNAVAILABLE", code: ERROR_CODE_KEYCHAIN_UNAVAILABLE },
          }),
        },
      ]),
    });
    wizard.setPicked([
      {
        id: "cc-1",
        config: {
          kind: "claude-code",
          id: "cc-1",
          label: "Claude Code",
          configPath: "/x",
          transport: "http",
          url: "http://127.0.0.1:3479",
        },
        hasStoredSecret: false,
        keychainUnavailable: false,
      },
    ]);
    flushSync();
    await wizard.submitSecret(wizard.picked[0]!, "shhh");
    flushSync();
    expect(wizard.keychainUnavailable).toBe(true);
    expect(wizard.picked[0]?.keychainUnavailable).toBe(true);
    expect(wizard.picked[0]?.hasStoredSecret).toBe(false);
    expect(wizard.picked[0]?.config.tokenSecretRef).toBeUndefined();
    // Wizard does NOT enter step=error — fallback is a non-fatal branch.
    expect(wizard.step).not.toBe("error");
  });

  it("save(): POSTs the integrations file and lands on step=done", async () => {
    let savedBody: unknown = null;
    const wizard = createIntegrationWizard({
      fetchFn: makeFetchStub([
        {
          method: "POST",
          urlMatch: /\/api\/integrations$/,
          handler: (body) => {
            savedBody = body;
            return { status: 204, body: null };
          },
        },
      ]),
    });
    wizard.setPicked([
      {
        id: "cc-1",
        config: {
          kind: "claude-code",
          id: "cc-1",
          label: "Claude Code",
          configPath: "/x",
          transport: "http",
          url: "http://127.0.0.1:3479",
        },
        hasStoredSecret: false,
        keychainUnavailable: false,
      },
    ]);
    flushSync();
    await wizard.save();
    flushSync();
    expect(wizard.step).toBe("done");
    expect((savedBody as { schemaVersion: number }).schemaVersion).toBe(
      INTEGRATIONS_SCHEMA_VERSION,
    );
  });

  it("save(): 400 surfaces server error message into step=error", async () => {
    const wizard = createIntegrationWizard({
      fetchFn: makeFetchStub([
        {
          method: "POST",
          urlMatch: /\/api\/integrations$/,
          handler: () => ({
            status: 400,
            body: { error: "BAD_REQUEST", message: "schemaVersion: invalid_type" },
          }),
        },
      ]),
    });
    wizard.setPicked([]);
    flushSync();
    await wizard.save();
    flushSync();
    expect(wizard.step).toBe("error");
    expect(wizard.errorMessage).toMatch(/schemaVersion/);
  });

  it("save(): failure cleans up secrets already stored via DELETE", async () => {
    const deleted: string[] = [];
    const wizard = createIntegrationWizard({
      fetchFn: (async (input, init) => {
        const url = typeof input === "string" ? input : input.toString();
        if ((init?.method ?? "GET") === "DELETE") {
          const match = url.match(/\/secrets\/([^/?]+)/);
          if (match) deleted.push(decodeURIComponent(match[1]));
          return new Response(JSON.stringify({ existed: true }), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        }
        // POST /api/integrations fails — wizard should rollback via DELETE.
        return new Response(JSON.stringify({ error: "INTERNAL" }), {
          status: 500,
          headers: { "content-type": "application/json" },
        });
      }) as unknown as typeof fetch,
    });
    // Hand-craft a picked entry as if submitSecret had already stamped the ref.
    wizard.setPicked([
      {
        id: "cc-1",
        config: {
          kind: "claude-code",
          id: "cc-1",
          label: "Claude Code",
          configPath: "/x",
          transport: "http",
          url: "http://127.0.0.1:3479",
          tokenSecretRef: "cc-1-abc",
        },
        hasStoredSecret: true,
        keychainUnavailable: false,
      },
    ]);
    flushSync();
    await wizard.save();
    flushSync();
    expect(wizard.step).toBe("error");
    expect(deleted).toEqual(["cc-1-abc"]);
  });

  it("reset(): returns to step=detect and clears state", async () => {
    const wizard = createIntegrationWizard({
      fetchFn: makeFetchStub([
        {
          method: "GET",
          urlMatch: /existing$/,
          handler: () => ({ status: 200, body: { installs: [] } }),
        },
      ]),
    });
    await wizard.begin();
    wizard.advanceToPick();
    wizard.advanceToSecrets();
    wizard.advanceToReview();
    flushSync();
    expect(wizard.step).toBe("review");
    wizard.reset();
    flushSync();
    expect(wizard.step).toBe("detect");
    expect(wizard.existing).toEqual([]);
    expect(wizard.picked).toEqual([]);
  });
});
