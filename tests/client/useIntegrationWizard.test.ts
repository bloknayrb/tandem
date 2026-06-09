// @vitest-environment happy-dom
import { flushSync } from "svelte";
import { describe, expect, it } from "vitest";

import {
  createIntegrationWizard,
  isSelectable,
} from "../../src/client/hooks/useIntegrationWizard.svelte.js";
import type { ExistingMcpInstall } from "../../src/shared/integrations/contract.js";
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
  it("begin() fetches existing entries, preselects, and lands on step=connect", async () => {
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
                  tandemValidation: { status: "valid" },
                },
              ],
            },
          }),
        },
      ]),
    });
    await wizard.begin();
    flushSync();
    expect(wizard.step).toBe("connect");
    expect(wizard.detecting).toBe(false);
    expect(wizard.existing).toHaveLength(1);
    // Selectable installs are preselected by begin() — no separate pick step.
    expect(wizard.picked).toHaveLength(1);
    expect(wizard.picked[0]?.config.kind).toBe("claude-code");
    expect(wizard.errorMessage).toBeNull();
  });

  it("begin() exposes detecting=true while the fetch is in flight", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const wizard = createIntegrationWizard({
      fetchFn: (async () => {
        await gate;
        return new Response(JSON.stringify({ installs: [] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }) as unknown as typeof fetch,
    });
    const pending = wizard.begin();
    flushSync();
    expect(wizard.detecting).toBe(true);
    release();
    await pending;
    flushSync();
    expect(wizard.detecting).toBe(false);
  });

  it("begin() superseded by a newer begin() does not clear the newer run's detecting", async () => {
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let call = 0;
    const wizard = createIntegrationWizard({
      fetchFn: (async () => {
        call += 1;
        if (call === 1)
          await firstGate; // first begin() stalls
        else await new Promise(() => {}); // second begin() never resolves
        return new Response(JSON.stringify({ installs: [] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }) as unknown as typeof fetch,
    });
    const first = wizard.begin();
    void wizard.begin(); // supersedes — its fetch never resolves
    flushSync();
    expect(wizard.detecting).toBe(true);
    releaseFirst();
    await first; // stale generation finishes…
    flushSync();
    // …and must NOT clear the in-flight newer generation's loading state.
    expect(wizard.detecting).toBe(true);
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

  it("save(): POSTs persist then apply and lands on step=done", async () => {
    let savedBody: unknown = null;
    let applyBody: unknown = null;
    const wizard = createIntegrationWizard({
      fetchFn: makeFetchStub([
        {
          // POST /api/integrations now returns { ids, confirmationNonce } so
          // the wizard can immediately chain into apply without a separate
          // round-trip to GET /first-run-needed.
          method: "POST",
          urlMatch: /\/api\/integrations$/,
          handler: (body) => {
            savedBody = body;
            return {
              status: 200,
              body: { ok: true, ids: ["cc-1"], confirmationNonce: "nonce-1" },
            };
          },
        },
        {
          method: "POST",
          urlMatch: /\/api\/integrations\/apply$/,
          handler: (body) => {
            applyBody = body;
            return {
              status: 200,
              body: {
                results: [{ id: "cc-1", status: "applied" }],
                nextNonce: "nonce-2",
              },
            };
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
    // Wizard chained persist → apply using the nonce from the persist response.
    expect(applyBody).toEqual({ ids: ["cc-1"], confirmationNonce: "nonce-1" });
    // Per-integration apply results flow through `applyResults`.
    expect(wizard.applyResults).toEqual([{ id: "cc-1", status: "applied" }]);
  });

  it("save(): pre-sets apply:'skip' on picks whose existing entry failed validation", async () => {
    // The hand-edited / tampered case: existing tandem entry on disk has
    // a non-loopback URL, so server-side validation marked it invalid-url.
    // The wizard must NOT overwrite it with a fresh canonical entry — the
    // user picked the row deliberately and the safer default is to leave
    // it alone (apply: "skip") rather than silently erase customizations.
    let savedBody: unknown = null;
    let applyBody: unknown = null;
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
                  tandemEntry: { type: "http", url: "http://evil.com:3479/mcp" },
                  tandemValidation: { status: "invalid-url", reason: "non-loopback" },
                },
              ],
            },
          }),
        },
        {
          method: "POST",
          urlMatch: /\/api\/integrations$/,
          handler: (body) => {
            savedBody = body;
            return {
              status: 200,
              body: { ok: true, ids: ["cc-1"], confirmationNonce: "nonce-1" },
            };
          },
        },
        {
          method: "POST",
          urlMatch: /\/api\/integrations\/apply$/,
          handler: (body) => {
            applyBody = body;
            return {
              status: 200,
              body: { results: [{ id: "cc-1", status: "skipped" }], nextNonce: "nonce-2" },
            };
          },
        },
      ]),
    });
    await wizard.begin();
    flushSync();
    wizard.setPicked([
      {
        id: "cc-1",
        config: {
          kind: "claude-code",
          id: "cc-1",
          label: "Claude Code",
          // configPath MATCHES the existing install — that's the join key
          // for finding the validation result.
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
    const persisted = savedBody as { integrations: Array<{ id: string; apply: string }> };
    expect(persisted.integrations[0].apply).toBe("skip");
    // applyResults reflects the skip outcome end-to-end.
    expect(wizard.applyResults).toEqual([{ id: "cc-1", status: "skipped" }]);
    // The applyBody still has the persisted id — the apply route iterates
    // and observes the `skip` intent, not the wizard.
    expect((applyBody as { ids: string[] }).ids).toEqual(["cc-1"]);
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

  it("setPicked(): unchecking a card with a stored token deletes its keychain ref", async () => {
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
        return new Response("{}", {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }) as unknown as typeof fetch,
    });
    // Entry as if submitSecret had already stamped the ref.
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
    // Unchecking the card drops it from the selection — the stored ref must
    // not be left orphaned in the keychain (store-then-unpick is reachable
    // only in the single-screen redesign).
    wizard.setPicked([]);
    flushSync();
    // Cleanup is fire-and-forget — let the microtask settle before asserting.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(deleted).toEqual(["cc-1-abc"]);
  });

  it("save(): a per-integration apply error lands on done and surfaces via applyResults", async () => {
    const wizard = createIntegrationWizard({
      fetchFn: makeFetchStub([
        {
          method: "POST",
          urlMatch: /\/api\/integrations$/,
          handler: () => ({
            status: 200,
            body: { ok: true, ids: ["cc-1"], confirmationNonce: "nonce-1" },
          }),
        },
        {
          method: "POST",
          urlMatch: /\/api\/integrations\/apply$/,
          handler: () => ({
            status: 200,
            body: {
              results: [{ id: "cc-1", status: "error", code: "WRITE_FAILED" }],
              nextNonce: "nonce-2",
            },
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
    await wizard.save();
    flushSync();
    // A per-item apply error is NOT a save failure — the apply HTTP call
    // succeeded, so the wizard lands on `done` and surfaces the per-item error
    // through applyResults (the modal renders the "Partly connected" title +
    // the retry affordance from this).
    expect(wizard.step).toBe("done");
    expect(wizard.applyResults).toEqual([{ id: "cc-1", status: "error", code: "WRITE_FAILED" }]);
  });

  it("save(): a throw after persist succeeds does NOT delete the persisted secrets", async () => {
    const deleted: string[] = [];
    const wizard = createIntegrationWizard({
      fetchFn: (async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === "string" ? input : input.toString();
        if ((init?.method ?? "GET") === "DELETE") {
          const match = url.match(/\/secrets\/([^/?]+)/);
          if (match) deleted.push(decodeURIComponent(match[1]));
          return new Response(JSON.stringify({ existed: true }), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        }
        if (/\/api\/integrations$/.test(url)) {
          // Persist succeeds — the file is durably written referencing cc-1-abc.
          return new Response(
            JSON.stringify({ ok: true, ids: ["cc-1"], confirmationNonce: "n1" }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        }
        if (/\/api\/integrations\/apply$/.test(url)) {
          // Network drop between persist and a confirmed apply.
          throw new TypeError("Failed to fetch");
        }
        return new Response("{}", {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }) as unknown as typeof fetch,
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
          tokenSecretRef: "cc-1-abc",
        },
        hasStoredSecret: true,
        keychainUnavailable: false,
      },
    ]);
    flushSync();
    await wizard.save();
    flushSync();
    // The throw lands in the catch, but persist already wrote the file
    // referencing cc-1-abc — deleting the secret would dangle the persisted
    // config (and Claude's, if apply ran), surfacing as SECRET_MISSING later.
    expect(wizard.step).toBe("error");
    expect(deleted).toEqual([]);
  });

  it("reset(): returns to step=connect and clears state", async () => {
    const wizard = createIntegrationWizard({
      fetchFn: makeFetchStub([
        {
          method: "GET",
          urlMatch: /existing$/,
          handler: () => ({
            status: 200,
            body: {
              installs: [
                {
                  target: { kind: "claude-code", label: "Claude Code", configPath: "/x" },
                  status: "ok",
                },
              ],
            },
          }),
        },
      ]),
    });
    await wizard.begin();
    flushSync();
    // Dirty the state begin() produced (preselection + existing).
    expect(wizard.existing).toHaveLength(1);
    expect(wizard.picked).toHaveLength(1);
    wizard.reset();
    flushSync();
    expect(wizard.step).toBe("connect");
    expect(wizard.detecting).toBe(false);
    expect(wizard.existing).toEqual([]);
    expect(wizard.picked).toEqual([]);
    expect(wizard.errorMessage).toBeNull();
  });

  describe("isSelectable", () => {
    const base = (over: Partial<ExistingMcpInstall>): ExistingMcpInstall => ({
      target: { kind: "claude-code", label: "Claude Code", configPath: "/x" },
      status: "ok",
      ...over,
    });

    const cases: Array<[string, ExistingMcpInstall, boolean]> = [
      ["ok, no existing entry", base({}), true],
      ["missing config file (will be created)", base({ status: "missing" }), true],
      ["malformed config file", base({ status: "malformed" }), false],
      ["read error", base({ status: "error", errorMessage: "EACCES" }), false],
      [
        "existing entry with valid validation (refresh case)",
        base({
          tandemEntry: { type: "http", url: "http://127.0.0.1:3479/mcp" },
          tandemValidation: { status: "valid" },
        }),
        true,
      ],
      [
        // The lockstep case with save(): status=ok but the on-disk entry is
        // hand-edited — card shows "we won't touch it", so it must NOT be
        // preselected even though the file itself read fine.
        "ok status but invalid existing entry",
        base({
          tandemEntry: { type: "http", url: "http://evil.com/mcp" },
          tandemValidation: { status: "invalid-url", reason: "non-loopback" },
        }),
        false,
      ],
    ];
    it.each(cases)("%s → %s", (_name, install, expected) => {
      expect(isSelectable(install)).toBe(expected);
    });
  });
});
