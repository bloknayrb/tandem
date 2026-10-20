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
    // The saved setup (#2198) is read with detection and again before a save;
    // a test that does not care gets an empty file, as on a first run.
    if (!match && method === "GET" && /\/api\/integrations$/.test(url)) {
      return new Response(
        JSON.stringify({ schemaVersion: INTEGRATIONS_SCHEMA_VERSION, integrations: [] }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
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
      fetchFn: (async (input: RequestInfo | URL) => {
        // begin() also reads the saved setup (#2198); gate on detection only.
        if (!String(input).endsWith("/existing")) {
          return new Response(
            JSON.stringify({ schemaVersion: INTEGRATIONS_SCHEMA_VERSION, integrations: [] }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        }
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

  it("a network failure (TypeError) surfaces a friendly 'server unreachable' message", async () => {
    // Real fetch rejects with a TypeError on network failure; a plain Error
    // would hit the generic error path instead, so reject with a TypeError.
    const fetchFn = (() =>
      Promise.reject(new TypeError("Failed to fetch"))) as unknown as typeof fetch;
    const wizard = createIntegrationWizard({ fetchFn });

    await wizard.begin();
    flushSync();
    expect(wizard.detecting).toBe(false);
    expect(wizard.step).toBe("error");
    expect(wizard.errorMessage).toMatch(/Could not reach the Tandem server/);
  });

  it("a WKWebView 'Load failed' network error also gets the friendly message", async () => {
    // Tauri's macOS WebView is WKWebView, which throws `TypeError: Load failed`
    // (no "fetch" substring) on network failure. Guards against a future edit
    // narrowing the discriminant back to /fetch/i and regressing macOS desktop.
    const fetchFn = (() => Promise.reject(new TypeError("Load failed"))) as unknown as typeof fetch;
    const wizard = createIntegrationWizard({ fetchFn });

    await wizard.begin();
    flushSync();
    expect(wizard.step).toBe("error");
    expect(wizard.errorMessage).toMatch(/Could not reach the Tandem server/);
  });

  it("a structural TypeError surfaces its real message, not 'server unreachable'", async () => {
    // A programming TypeError (not a network failure) must NOT be mislabeled as
    // "server unreachable" — it should fall through to its real text.
    const fetchFn = (() =>
      Promise.reject(new TypeError("x is not a function"))) as unknown as typeof fetch;
    const wizard = createIntegrationWizard({ fetchFn });

    await wizard.begin();
    flushSync();
    expect(wizard.step).toBe("error");
    expect(wizard.errorMessage).toBe("x is not a function");
    expect(wizard.errorMessage).not.toMatch(/Could not reach the Tandem server/);
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

  it("submitSecret(): a backend error best-effort deletes the orphan ref (F2)", async () => {
    // If the keychain write returns an error AFTER possibly storing the secret,
    // the ref is never stamped on the picked entry — so nothing downstream
    // could ever clean it up. submitSecret best-effort deletes the freshly
    // generated ref to undo a partial write.
    let deletes = 0;
    const wizard = createIntegrationWizard({
      fetchFn: makeFetchStub([
        {
          method: "POST",
          urlMatch: /\/api\/integrations\/secrets\//,
          handler: () => ({ status: 500, body: { error: "INTERNAL", message: "boom" } }),
        },
        {
          method: "DELETE",
          urlMatch: /\/api\/integrations\/secrets\//,
          handler: () => {
            deletes++;
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
    await wizard.submitSecret(wizard.picked[0]!, "shhh");
    flushSync();
    expect(wizard.picked[0]?.config.tokenSecretRef).toBeUndefined();
    expect(wizard.picked[0]?.hasStoredSecret).not.toBe(true);
    expect(deletes).toBe(1);
    expect(wizard.errorMessage).toContain("Could not store secret");
  });

  it("cleanupUnsavedSecrets(): deletes unsaved refs at step=connect (F1)", async () => {
    let deletes = 0;
    const wizard = createIntegrationWizard({
      fetchFn: makeFetchStub([
        {
          method: "POST",
          urlMatch: /\/api\/integrations\/secrets\//,
          handler: () => ({ status: 204, body: null }),
        },
        {
          method: "DELETE",
          urlMatch: /\/api\/integrations\/secrets\//,
          handler: () => {
            deletes++;
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
    await wizard.submitSecret(wizard.picked[0]!, "shhh");
    flushSync();
    expect(wizard.picked[0]?.config.tokenSecretRef).toMatch(/^cc-1-/);
    expect(wizard.step).toBe("connect");
    // Dismiss before save (still at "connect") → the orphan ref is deleted.
    await wizard.cleanupUnsavedSecrets();
    expect(deletes).toBe(1);
  });

  it("cleanupUnsavedSecrets(): is a no-op once persisted (step=done), protecting live refs (F1)", async () => {
    // After a successful save the refs are file-referenced and LIVE; deleting
    // them would re-introduce the SECRET_MISSING orphan that 498b7bb fixed.
    // The step!=="connect" guard must skip cleanup entirely here.
    let deletes = 0;
    const wizard = createIntegrationWizard({
      fetchFn: makeFetchStub([
        {
          method: "POST",
          urlMatch: /\/api\/integrations\/secrets\//,
          handler: () => ({ status: 204, body: null }),
        },
        {
          method: "DELETE",
          urlMatch: /\/api\/integrations\/secrets\//,
          handler: () => {
            deletes++;
            return { status: 204, body: null };
          },
        },
        {
          method: "POST",
          urlMatch: /\/api\/integrations$/,
          handler: () => ({
            status: 200,
            body: { ok: true, ids: ["cc-1"], confirmationNonce: "n1" },
          }),
        },
        {
          method: "POST",
          urlMatch: /\/api\/integrations\/apply$/,
          handler: () => ({
            status: 200,
            body: { results: [{ id: "cc-1", status: "applied" }], nextNonce: "n2" },
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
    await wizard.save();
    flushSync();
    expect(wizard.step).toBe("done");
    await wizard.cleanupUnsavedSecrets();
    expect(deletes).toBe(0); // guard skipped cleanup — live refs preserved
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

  it.each([
    ["a valid value", "starting", "starting"],
    ["an unknown value", "definitely-started", null],
    ["no field (older server)", undefined, null],
  ])("save(): tandemClaude from the apply response — %s (#2197)", async (_l, value, want) => {
    const wizard = createIntegrationWizard({
      fetchFn: makeFetchStub([
        {
          method: "POST",
          urlMatch: /\/api\/integrations$/,
          handler: () => ({
            status: 200,
            body: { ok: true, ids: ["cc-1"], confirmationNonce: "n1" },
          }),
        },
        {
          method: "POST",
          urlMatch: /\/api\/integrations\/apply$/,
          handler: () => ({
            status: 200,
            body: {
              results: [{ id: "cc-1", status: "applied" }],
              nextNonce: "n2",
              ...(value === undefined ? {} : { tandemClaude: value }),
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
    expect(wizard.tandemClaude).toBe(want);
  });

  // --- channelRegistered (WS-B push-vs-polling readout) ---------------------

  /** Persist + apply stubs shared by the channelRegistered cases (claude-code,
   *  HTTP). The GET /existing handler is supplied per-case to model the
   *  post-apply on-disk state. */
  function pushModeStubs(existingHandler: () => { status: number; body: unknown }) {
    return makeFetchStub([
      {
        method: "POST",
        urlMatch: /\/api\/integrations$/,
        handler: () => ({
          status: 200,
          body: { ok: true, ids: ["cc-1"], confirmationNonce: "n1" },
        }),
      },
      {
        method: "POST",
        urlMatch: /\/api\/integrations\/apply$/,
        handler: () => ({
          status: 200,
          body: { results: [{ id: "cc-1", status: "applied" }], nextNonce: "n2" },
        }),
      },
      { method: "GET", urlMatch: /\/api\/integrations\/existing$/, handler: existingHandler },
    ]);
  }

  const ccPick = {
    id: "cc-1",
    config: {
      kind: "claude-code" as const,
      id: "cc-1",
      label: "Claude Code",
      configPath: "/x",
      transport: "http" as const,
      url: "http://127.0.0.1:3479",
    },
    hasStoredSecret: false,
    keychainUnavailable: false,
  };

  /** Let the fire-and-forget post-apply `/existing` re-read resolve. */
  async function settlePostApply(): Promise<void> {
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));
    flushSync();
  }

  it("save(): channelRegistered=true when a claude-code target has a valid channel entry post-apply", async () => {
    const wizard = createIntegrationWizard({
      fetchFn: pushModeStubs(() => ({
        status: 200,
        body: {
          installs: [
            {
              target: { kind: "claude-code", label: "Claude Code", configPath: "/x" },
              status: "ok",
              channelEntry: { command: "node", args: ["/abs/dist/channel/index.js"] },
              channelValidation: { status: "valid" },
            },
          ],
        },
      })),
    });
    wizard.setPicked([ccPick]);
    flushSync();
    await wizard.save();
    await settlePostApply();
    expect(wizard.channelRegistered).toBe(true);
  });

  it("save(): channelRegistered=false when the channel entry did not land (polling mode)", async () => {
    const wizard = createIntegrationWizard({
      fetchFn: pushModeStubs(() => ({
        status: 200,
        body: {
          installs: [
            {
              // Push registration skipped (e.g. no dist/channel on disk) — the
              // tandem entry exists but there is NO channel entry.
              target: { kind: "claude-code", label: "Claude Code", configPath: "/x" },
              status: "ok",
              tandemEntry: { type: "http", url: "http://127.0.0.1:3479/mcp" },
              tandemValidation: { status: "valid" },
            },
          ],
        },
      })),
    });
    wizard.setPicked([ccPick]);
    flushSync();
    await wizard.save();
    await settlePostApply();
    expect(wizard.channelRegistered).toBe(false);
  });

  it("save(): channelRegistered stays null when the post-apply re-read fails (never a wrong label)", async () => {
    const wizard = createIntegrationWizard({
      fetchFn: pushModeStubs(() => ({ status: 500, body: { error: "boom" } })),
    });
    wizard.setPicked([ccPick]);
    flushSync();
    await wizard.save();
    await settlePostApply();
    expect(wizard.channelRegistered).toBeNull();
  });

  it("save(): channelRegistered=false when a channel entry landed but failed validation (not push)", async () => {
    // A tampered/stale shim entry can sit on disk while validation rejects it.
    // Presence alone must NOT read as push — the status must be "valid".
    const wizard = createIntegrationWizard({
      fetchFn: pushModeStubs(() => ({
        status: 200,
        body: {
          installs: [
            {
              target: { kind: "claude-code", label: "Claude Code", configPath: "/x" },
              status: "ok",
              channelEntry: { command: "node", args: ["/abs/dist/channel/index.js"] },
              channelValidation: { status: "invalid-args" },
            },
          ],
        },
      })),
    });
    wizard.setPicked([ccPick]);
    flushSync();
    await wizard.save();
    await settlePostApply();
    expect(wizard.channelRegistered).toBe(false);
  });

  it("save(): a post-apply re-read resolving after reset() does not write a stale label", async () => {
    // The close/reopen race: reset() moves step off "done" while the /existing
    // re-read is still in flight. The `step !== "done"` guard must drop the late
    // write — otherwise a valid channel entry would set channelRegistered=true
    // onto a wizard the user has already dismissed.
    let releaseExisting: (() => void) | undefined;
    const existingGate = new Promise<void>((r) => {
      releaseExisting = r;
    });
    const json = (body: unknown, status = 200) =>
      new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
      });
    const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      const method = init?.method ?? "GET";
      if (method === "POST" && /\/api\/integrations$/.test(url)) {
        return json({ ok: true, ids: ["cc-1"], confirmationNonce: "n1" });
      }
      if (method === "POST" && /\/api\/integrations\/apply$/.test(url)) {
        return json({ results: [{ id: "cc-1", status: "applied" }], nextNonce: "n2" });
      }
      if (method === "GET" && /\/api\/integrations\/existing$/.test(url)) {
        await existingGate;
        return json({
          installs: [
            {
              target: { kind: "claude-code", label: "Claude Code", configPath: "/x" },
              status: "ok",
              channelEntry: { command: "node", args: ["/abs/dist/channel/index.js"] },
              channelValidation: { status: "valid" },
            },
          ],
        });
      }
      return json({ error: "no-stub-match", url }, 500);
    }) as unknown as typeof fetch;

    const wizard = createIntegrationWizard({ fetchFn });
    wizard.setPicked([ccPick]);
    flushSync();
    await wizard.save();
    // Re-read is gated in-flight; the user closes/reopens before it resolves.
    wizard.reset();
    flushSync();
    releaseExisting?.();
    await settlePostApply();
    expect(wizard.channelRegistered).toBeNull();
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
        if (/\/api\/integrations$/.test(url) && (init?.method ?? "GET") === "GET") {
          // The saved setup, re-read before the save (#2198): empty.
          return new Response(
            JSON.stringify({ schemaVersion: INTEGRATIONS_SCHEMA_VERSION, integrations: [] }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
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
    expect(wizard.channelRegistered).toBeNull();
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

describe("createIntegrationWizard — the saved setup (#2198)", () => {
  const savedRecord = {
    kind: "claude-code" as const,
    id: "cc-saved",
    label: "Claude Code",
    configPath: "/home/u/.claude.json",
    transport: "http" as const,
    url: "http://127.0.0.1:3479/mcp",
    tokenSecretRef: "cc-saved-ref",
    workingDirectory: "/home/u/projects/novel",
    apply: "create" as const,
  };
  const otherMcp = {
    kind: "other-mcp" as const,
    id: "other-1",
    label: "Something else",
    transport: "http" as const,
    url: "http://127.0.0.1:9000/mcp",
    apply: "skip" as const,
  };
  const install = {
    target: { kind: "claude-code", label: "Claude Code", configPath: "/home/u/.claude.json" },
    status: "ok",
    tandemEntry: { type: "http", url: "http://127.0.0.1:3479/mcp" },
    tandemValidation: { status: "valid" },
  };

  /** A server holding `savedRecord` + `otherMcp`; records every request. */
  function server(opts: { persistStatus?: number } = {}) {
    const calls: Array<{ method: string; url: string; body: unknown }> = [];
    const deletedRefs: string[] = [];
    const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      const body = init?.body ? JSON.parse(init.body as string) : undefined;
      calls.push({ method, url, body });
      const json = (status: number, b: unknown) =>
        new Response(JSON.stringify(b), {
          status,
          headers: { "content-type": "application/json" },
        });
      if (method === "DELETE") {
        const m = url.match(/\/secrets\/([^/?]+)/);
        if (m) deletedRefs.push(decodeURIComponent(m[1] ?? ""));
        return json(200, { existed: true });
      }
      if (url.endsWith("/existing")) return json(200, { installs: [install] });
      if (url.endsWith("/api/integrations") && method === "GET") {
        return json(200, {
          schemaVersion: INTEGRATIONS_SCHEMA_VERSION,
          integrations: [otherMcp, savedRecord],
          defaultIntegrationId: "cc-saved",
        });
      }
      if (url.endsWith("/api/integrations") && method === "POST") {
        if (opts.persistStatus && opts.persistStatus !== 200) {
          return json(opts.persistStatus, { message: "nope" });
        }
        return json(200, { ok: true, ids: ["other-1", "cc-saved"], confirmationNonce: "n1" });
      }
      if (url.endsWith("/apply")) {
        return json(200, {
          results: [{ id: "cc-saved", status: "applied" }],
          nextNonce: "n2",
        });
      }
      if (url.endsWith("/secrets/new")) return json(200, { ok: true });
      if (url.endsWith("/walkthrough-confirm")) {
        return body && (body as { serverVersion?: string }).serverVersion === "1.0.0"
          ? json(200, { ok: true })
          : json(409, { message: "Tandem was updated since this window opened." });
      }
      return json(200, {});
    }) as unknown as typeof fetch;
    const keychainBackend = {
      set: async () => ({ status: "ok" as const }),
      delete: async (ref: string) => {
        deletedRefs.push(ref);
      },
    } as never;
    return { fetchFn, keychainBackend, calls, deletedRefs };
  }

  it("pre-fills the card from the saved record: its id, token and working directory", async () => {
    const s = server();
    const wizard = createIntegrationWizard({
      fetchFn: s.fetchFn,
      keychainBackend: s.keychainBackend,
    });
    await wizard.begin();
    flushSync();
    expect(wizard.picked).toHaveLength(1);
    expect(wizard.picked[0]).toMatchObject({
      id: "cc-saved",
      fromRecord: true,
      hasStoredSecret: true,
      config: { tokenSecretRef: "cc-saved-ref", workingDirectory: "/home/u/projects/novel" },
    });
    expect(wizard.hasSetupToKeep).toBe(true);
  });

  it("closing (Keep, Not now, Esc) never deletes the saved token", async () => {
    const s = server();
    const wizard = createIntegrationWizard({
      fetchFn: s.fetchFn,
      keychainBackend: s.keychainBackend,
    });
    await wizard.begin();
    await wizard.cleanupUnsavedSecrets();
    expect(s.deletedRefs).toEqual([]);
  });

  it("unchecking the card never deletes the saved token, and re-checking rebuilds it from the record", async () => {
    const s = server();
    const wizard = createIntegrationWizard({
      fetchFn: s.fetchFn,
      keychainBackend: s.keychainBackend,
    });
    await wizard.begin();
    wizard.setPicked([]);
    expect(s.deletedRefs).toEqual([]);
    const again = wizard.pickedForInstall(install as never);
    expect(again).toMatchObject({ id: "cc-saved", config: { tokenSecretRef: "cc-saved-ref" } });
  });

  it("a failed persist cleans up only a token entered this session", async () => {
    const s = server({ persistStatus: 500 });
    const wizard = createIntegrationWizard({
      fetchFn: s.fetchFn,
      keychainBackend: s.keychainBackend,
    });
    await wizard.begin();
    const card = wizard.picked[0];
    if (!card) throw new Error("no card");
    await wizard.submitSecret(card, "fresh-token");
    flushSync();
    const freshRef = wizard.picked[0]?.config.tokenSecretRef;
    expect(freshRef).not.toBe("cc-saved-ref");
    await wizard.save();
    expect(s.deletedRefs).toEqual([freshRef]);
  });

  it("a replaced token's saved ref is deleted only after the new file is persisted", async () => {
    const s = server();
    const order: string[] = [];
    const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).endsWith("/api/integrations") && init?.method === "POST") {
        order.push("persist");
      }
      return s.fetchFn(input, init);
    }) as unknown as typeof fetch;
    const keychainBackend = {
      set: async () => ({ status: "ok" as const }),
      delete: async (ref: string) => {
        order.push(`delete ${ref}`);
      },
    } as never;
    const wizard = createIntegrationWizard({ fetchFn, keychainBackend });
    await wizard.begin();
    const card = wizard.picked[0];
    if (!card) throw new Error("no card");
    await wizard.submitSecret(card, "fresh-token");
    flushSync();
    await wizard.save();
    expect(order).toEqual(["persist", "delete cc-saved-ref"]);
  });

  it("save keeps what it does not own and applies only the picked card", async () => {
    const s = server();
    const wizard = createIntegrationWizard({
      fetchFn: s.fetchFn,
      keychainBackend: s.keychainBackend,
    });
    await wizard.begin();
    await wizard.save();
    flushSync();
    expect(wizard.step).toBe("done");
    const persist = s.calls.find((c) => c.method === "POST" && c.url.endsWith("/api/integrations"));
    expect(persist?.body).toMatchObject({
      integrations: [otherMcp, { id: "cc-saved", workingDirectory: "/home/u/projects/novel" }],
      defaultIntegrationId: "cc-saved",
    });
    const apply = s.calls.find((c) => c.url.endsWith("/apply"));
    expect((apply?.body as { ids: string[] }).ids).toEqual(["cc-saved"]);
    // The saved setup is re-read before the save, not reused from begin().
    expect(
      s.calls.filter((c) => c.method === "GET" && c.url.endsWith("/api/integrations")),
    ).toHaveLength(2);
  });

  it("a saved setup that cannot be read stops the wizard rather than saving without it", async () => {
    const wizard = createIntegrationWizard({
      fetchFn: makeFetchStub([
        {
          method: "GET",
          urlMatch: /\/api\/integrations\/existing$/,
          handler: () => ({ status: 200, body: { installs: [install] } }),
        },
        {
          method: "GET",
          urlMatch: /\/api\/integrations$/,
          handler: () => ({ status: 500, body: { message: "disk on fire" } }),
        },
      ]),
    });
    await wizard.begin();
    flushSync();
    expect(wizard.step).toBe("error");
  });

  it("Keep posts the version the walkthrough was shown for; a refusal is shown, not swallowed", async () => {
    const s = server();
    const wizard = createIntegrationWizard({
      fetchFn: s.fetchFn,
      keychainBackend: s.keychainBackend,
    });
    expect(await wizard.keepSetup("1.0.0")).toBe(true);
    expect(s.calls.at(-1)).toMatchObject({ method: "POST", body: { serverVersion: "1.0.0" } });
    expect(await wizard.keepSetup("0.9.0")).toBe(false);
    flushSync();
    expect(wizard.keepError).toMatch(/updated since this window opened/);
  });

  it("a record removed while the wizard was open stops the save instead of re-adding it", async () => {
    const s = server();
    let gets = 0;
    const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).endsWith("/api/integrations") && (init?.method ?? "GET") === "GET") {
        gets += 1;
        if (gets > 1) {
          return new Response(
            JSON.stringify({ schemaVersion: INTEGRATIONS_SCHEMA_VERSION, integrations: [] }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        }
      }
      return s.fetchFn(input, init);
    }) as unknown as typeof fetch;
    const wizard = createIntegrationWizard({ fetchFn, keychainBackend: s.keychainBackend });
    await wizard.begin();
    await wizard.save();
    flushSync();
    expect(wizard.step).toBe("error");
    expect(wizard.errorMessage).toMatch(/changed while this window was open/);
    expect(s.calls.some((c) => c.method === "POST" && c.url.endsWith("/api/integrations"))).toBe(
      false,
    );
    expect(s.deletedRefs).toEqual([]);
  });

  it("Keep that finds the walkthrough already done (another tab) counts as done", async () => {
    const wizard = createIntegrationWizard({
      fetchFn: makeFetchStub([
        {
          method: "POST",
          urlMatch: /\/walkthrough-confirm$/,
          handler: () => ({
            status: 409,
            body: { code: "WALKTHROUGH_NOT_PENDING", message: "There is no setup walkthrough." },
          }),
        },
      ]),
    });
    expect(await wizard.keepSetup("1.0.0")).toBe(true);
    flushSync();
    expect(wizard.keepError).toBeNull();
  });

  it("two installs whose paths differ only by case do not share one record's card (or id)", async () => {
    const twin = (configPath: string) => ({
      target: { kind: "claude-code", label: "Claude Code", configPath },
      status: "ok",
      tandemEntry: { type: "http", url: "http://127.0.0.1:3479/mcp" },
      tandemValidation: { status: "valid" },
    });
    const wizard = createIntegrationWizard({
      fetchFn: makeFetchStub([
        {
          method: "GET",
          urlMatch: /\/api\/integrations\/existing$/,
          handler: () => ({
            status: 200,
            body: { installs: [twin("/home/u/.claude.json"), twin("/home/U/.claude.json")] },
          }),
        },
        {
          method: "GET",
          urlMatch: /\/api\/integrations$/,
          handler: () => ({
            status: 200,
            body: { schemaVersion: INTEGRATIONS_SCHEMA_VERSION, integrations: [savedRecord] },
          }),
        },
      ]),
    });
    await wizard.begin();
    flushSync();
    const ids = wizard.picked.map((p) => p.id);
    expect(ids).toHaveLength(2);
    expect(new Set(ids).size).toBe(2);
    expect(ids).toContain("cc-saved");
  });
});

describe("createIntegrationWizard — refreshDetected (#2199)", () => {
  const desktop: ExistingMcpInstall = {
    target: { kind: "claude-desktop", label: "Claude Desktop", configPath: "/d/config.json" },
    status: "ok",
  };
  const code: ExistingMcpInstall = {
    target: { kind: "claude-code", label: "Claude Code", configPath: "/h/.claude.json" },
    status: "missing",
  };

  /** Detection answers `before` once, then `after` on every later read. */
  function wizardDetecting(before: ExistingMcpInstall[], after: ExistingMcpInstall[]) {
    let reads = 0;
    return createIntegrationWizard({
      fetchFn: makeFetchStub([
        {
          method: "GET",
          urlMatch: /\/api\/integrations\/existing$/,
          handler: () => ({ status: 200, body: { installs: reads++ === 0 ? before : after } }),
        },
      ]),
    });
  }

  it("ticks the newly detected Claude Code card and keeps the user's own choices", async () => {
    const wizard = wizardDetecting([desktop], [desktop, code]);
    await wizard.begin();
    // The user unticked Desktop: that choice survives the re-read.
    wizard.setPicked([]);
    const fresh = await wizard.refreshDetected({ pickNewOfKind: "claude-code" });
    flushSync();
    expect(fresh.map((i) => i.target.kind)).toEqual(["claude-code"]);
    expect(wizard.existing).toHaveLength(2);
    expect(wizard.picked.map((p) => p.config.kind)).toEqual(["claude-code"]);
  });

  it("ticks only the asked-for kind — a new Desktop install arriving alongside stays unticked", async () => {
    const desktop2: ExistingMcpInstall = {
      target: {
        kind: "claude-desktop",
        label: "Claude Desktop (Store)",
        configPath: "/d2/config.json",
      },
      status: "ok",
    };
    const wizard = wizardDetecting([desktop], [desktop, desktop2, code]);
    await wizard.begin();
    wizard.setPicked([]);
    await wizard.refreshDetected({ pickNewOfKind: "claude-code" });
    expect(wizard.picked.map((p) => p.config.kind)).toEqual(["claude-code"]);
  });

  it("without pickNewOfKind it ticks nothing", async () => {
    const wizard = wizardDetecting([desktop], [desktop, code]);
    await wizard.begin();
    const before = wizard.picked.map((p) => p.id);
    await wizard.refreshDetected();
    expect(wizard.picked.map((p) => p.id)).toEqual(before);
  });

  it("a card the user already had is not 'new' — an unticked one stays unticked", async () => {
    const wizard = wizardDetecting([desktop, code], [desktop, code]);
    await wizard.begin();
    wizard.setPicked(wizard.picked.filter((p) => p.config.kind !== "claude-code"));
    const fresh = await wizard.refreshDetected({ pickNewOfKind: "claude-code" });
    expect(fresh).toEqual([]);
    expect(wizard.picked.some((p) => p.config.kind === "claude-code")).toBe(false);
  });

  it("a read that lands after reset() changes nothing", async () => {
    const wizard = wizardDetecting([desktop], [desktop, code]);
    await wizard.begin();
    const pending = wizard.refreshDetected({ pickNewOfKind: "claude-code" });
    wizard.reset();
    expect(await pending).toEqual([]);
    expect(wizard.existing).toEqual([]);
    expect(wizard.picked).toEqual([]);
  });
});
