// @vitest-environment happy-dom

/**
 * Logging-hygiene contract for `createModels` (#659).
 *
 * The Models registry stores API keys in the OS keychain via `POST
 * /api/models/secrets/:ref`. The plaintext travels through `addModel` /
 * `updateModel` as a separate `plaintextApiKey` argument — it must never
 * reach an Error message, console.warn, or any other surface that a
 * future exception handler might log to disk or telemetry.
 *
 * This file pins the invariant: no error produced by the CRUD facade may
 * contain the literal plaintext or endpoint values supplied in the call.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  _resetModelsStoreForTests,
  _settleReconcile,
  createModels,
} from "../../src/client/hooks/useModels.svelte.js";

// Distinctive sentinel values — easy to grep for in error strings.
const LEAKY_KEY = "SECRETSENTINEL_apikey_abcdef1234567890";
const LEAKY_ENDPOINT = "https://SECRETSENTINEL.example/v1";

beforeEach(() => {
  _resetModelsStoreForTests();
  _settleReconcile(); // ungate mutators (no reconcile in these error-path tests)
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(null, { status: 503 })),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("createModels — error messages never leak apiKey or endpoint values", () => {
  it("addModel with bad provider — error stringifies without the plaintext key", async () => {
    const models = createModels();
    let caught: unknown = null;
    try {
      await models.addModel(
        {
          // @ts-expect-error — runtime guard under test.
          provider: "invalid",
          displayName: "x",
          modelId: "x",
          enabled: true,
        },
        LEAKY_KEY,
      );
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(Error);
    const message = (caught as Error).message;
    expect(message).not.toContain(LEAKY_KEY);
    expect((caught as Error).stack ?? "").not.toContain(LEAKY_KEY);
  });

  it("addModel with bad provider — error stringifies without the endpoint", async () => {
    const models = createModels();
    let caught: unknown = null;
    try {
      await models.addModel({
        // @ts-expect-error — runtime guard under test.
        provider: "invalid",
        displayName: "x",
        modelId: "x",
        endpoint: LEAKY_ENDPOINT,
        enabled: true,
      });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).not.toContain(LEAKY_ENDPOINT);
    expect((caught as Error).stack ?? "").not.toContain(LEAKY_ENDPOINT);
  });

  it("updateModel with bad provider — error stringifies without the plaintext", async () => {
    // Keychain secret POST → 204; models registry POST → 200 {etag}. Distinguished
    // by the `/secrets/` path segment.
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (String(url).includes("/secrets/")) return new Response(null, { status: 204 });
        return new Response(JSON.stringify({ etag: "e1" }), { status: 200 });
      }),
    );
    const models = createModels();
    const id = await models.addModel(
      {
        provider: "anthropic",
        displayName: "A",
        modelId: "claude-opus-4-7",
        enabled: true,
      },
      LEAKY_KEY,
    );

    let caught: unknown = null;
    try {
      await models.updateModel(
        id,
        {
          // @ts-expect-error — runtime guard under test.
          provider: "invalid",
        },
        `${LEAKY_KEY}-rotated`,
      );
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).not.toContain(LEAKY_KEY);
    expect((caught as Error).message).not.toContain(`${LEAKY_KEY}-rotated`);
  });

  it("storeSecret 503 error does not include the plaintext", async () => {
    const models = createModels();
    let caught: unknown = null;
    try {
      await models.addModel(
        {
          provider: "anthropic",
          displayName: "A",
          modelId: "claude-opus-4-7",
          enabled: true,
        },
        LEAKY_KEY,
      );
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).not.toContain(LEAKY_KEY);
    expect((caught as Error).stack ?? "").not.toContain(LEAKY_KEY);
  });
});
