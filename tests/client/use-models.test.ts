// @vitest-environment happy-dom

/**
 * Unit tests for the server-authoritative Models store (#1123 M2).
 *
 * The store rewrote `createModels` from a settings-localStorage facade into a
 * module-level `$state` singleton loaded from `GET /api/models` and written
 * through on every CRUD op with optimistic-then-reconcile against a content-hash
 * ETag. Pinned invariants:
 *   1. Every mutation produces a NEW `models` array reference (immutable update;
 *      Svelte 5 `$state` identity reactivity).
 *   2. CRUD lifecycle (add → update → toggle → delete) round-trips through the
 *      store `$state` and POSTs the projected registry to the server.
 *   3. `add` resolves with the generated id; a later `update` finds it.
 *   4. Plaintext API keys POST to the keychain endpoint; only the opaque
 *      `apiKeyRef` lands on the entry.
 *   5. `defaultModelId` lifecycle: `setDefault` writes through; `deleteModel`
 *      clears it when the deleted id matches.
 *   6. The optimistic `$state` write lands BEFORE the POST resolves.
 *   7. A stale (409) write reloads server state, re-applies the intent, retries;
 *      a persistent 409 adopts the server (no lingering divergence).
 *   8. A non-409 failure rolls back to the pre-mutation snapshot.
 *   9. `getModelsSnapshot()` reflects the live `$state` synchronously.
 *  10. Dark (`BYO_MODELS_ENABLED=false`) → `loadFromServer` does no fetch.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  _resetModelsStoreForTests,
  _settleReconcile,
  createModels,
  getModelsSnapshot,
  loadFromServer,
} from "../../src/client/hooks/useModels.svelte.js";

/**
 * Default fetch stub: keychain secret POST → 204 / DELETE → 200; models registry
 * POST → 200 `{etag}` (monotonic); GET → the current server file. Distinguished
 * by the `/secrets/` path segment. `serverFile` lets a test seed the GET reload.
 */
let etagSeq = 0;
let serverFile: { schemaVersion: 1; models: unknown[]; defaultModelId: string | null } = {
  schemaVersion: 1,
  models: [],
  defaultModelId: null,
};

function stubFetch() {
  return vi.fn(async (url: string, init?: { method?: string }) => {
    const u = String(url);
    const method = (init?.method ?? "GET").toUpperCase();
    if (u.includes("/secrets/")) {
      return new Response(method === "DELETE" ? '{"existed":true}' : null, {
        status: method === "DELETE" ? 200 : 204,
      });
    }
    if (method === "POST") {
      return new Response(JSON.stringify({ etag: `etag-${++etagSeq}` }), { status: 200 });
    }
    return new Response(JSON.stringify({ file: serverFile, etag: `etag-${++etagSeq}` }), {
      status: 200,
    });
  });
}

beforeEach(() => {
  etagSeq = 0;
  serverFile = { schemaVersion: 1, models: [], defaultModelId: null };
  _resetModelsStoreForTests();
  _settleReconcile(); // ungate mutators — the reconcile-gate race is tested elsewhere
  vi.stubGlobal("fetch", stubFetch());
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("models store — CRUD", () => {
  it("addModel resolves with a generated id and appends with provided fields", async () => {
    const models = createModels();
    const id = await models.addModel(
      { provider: "anthropic", displayName: "Opus", modelId: "claude-opus-4-7", enabled: true },
      "sk-test-DO-NOT-USE-anthropic",
    );

    expect(typeof id).toBe("string");
    expect(id.length).toBeGreaterThan(0);
    expect(models.models.length).toBe(1);
    expect(models.models[0]).toMatchObject({
      id,
      provider: "anthropic",
      displayName: "Opus",
      modelId: "claude-opus-4-7",
      enabled: true,
    });
    // Plaintext NEVER appears on the entry; only the opaque ref does.
    expect(typeof models.models[0].apiKeyRef).toBe("string");
    expect(models.models[0].apiKeyRef!.length).toBeGreaterThan(0);
    // @ts-expect-error — `apiKey` is gone from the type; assert at runtime too.
    expect(models.models[0].apiKey).toBeUndefined();
  });

  it("every mutation produces a fresh models-array reference (immutable update)", async () => {
    const models = createModels();
    const before = models.models;
    const id = await models.addModel({
      provider: "openai",
      displayName: "GPT-4o",
      modelId: "gpt-4o",
      enabled: true,
    });
    const afterAdd = models.models;
    expect(afterAdd).not.toBe(before);

    await models.updateModel(id, { displayName: "GPT-4o Renamed" });
    const afterUpdate = models.models;
    expect(afterUpdate).not.toBe(afterAdd);

    await models.toggleEnabled(id);
    const afterToggle = models.models;
    expect(afterToggle).not.toBe(afterUpdate);

    await models.deleteModel(id);
    expect(models.models).not.toBe(afterToggle);
  });

  it("updateModel only patches the targeted entry and preserves order", async () => {
    const models = createModels();
    const idA = await models.addModel({
      provider: "anthropic",
      displayName: "A",
      modelId: "claude-opus-4-7",
      enabled: true,
    });
    const idB = await models.addModel({
      provider: "openai",
      displayName: "B",
      modelId: "gpt-4o",
      enabled: false,
    });

    await models.updateModel(idA, { displayName: "Patched A" });
    expect(models.models.length).toBe(2);
    expect(models.models[0]).toMatchObject({ id: idA, displayName: "Patched A" });
    expect(models.models[1]).toMatchObject({ id: idB, displayName: "B" });
  });

  it("updateModel with a fresh plaintext key replaces the existing ref", async () => {
    const models = createModels();
    const id = await models.addModel(
      { provider: "anthropic", displayName: "A", modelId: "claude-opus-4-7", enabled: true },
      "first-secret",
    );
    const refBefore = models.models[0].apiKeyRef;
    expect(refBefore).toBeDefined();

    await models.updateModel(id, {}, "second-secret");
    const refAfter = models.models[0].apiKeyRef;
    expect(refAfter).toBeDefined();
    expect(refAfter).not.toBe(refBefore);
  });

  it("toggleEnabled flips the boolean for the targeted entry only", async () => {
    const models = createModels();
    const idA = await models.addModel({
      provider: "anthropic",
      displayName: "A",
      modelId: "claude-opus-4-7",
      enabled: true,
    });
    const idB = await models.addModel({
      provider: "openai",
      displayName: "B",
      modelId: "gpt-4o",
      enabled: false,
    });

    await models.toggleEnabled(idA);
    expect(models.models.find((m) => m.id === idA)?.enabled).toBe(false);
    expect(models.models.find((m) => m.id === idB)?.enabled).toBe(false);

    await models.toggleEnabled(idB);
    expect(models.models.find((m) => m.id === idB)?.enabled).toBe(true);
  });

  it("deleteModel removes the targeted entry and clears defaultModelId when matched", async () => {
    const models = createModels();
    const idA = await models.addModel({
      provider: "anthropic",
      displayName: "A",
      modelId: "claude-opus-4-7",
      enabled: true,
    });
    const idB = await models.addModel({
      provider: "openai",
      displayName: "B",
      modelId: "gpt-4o",
      enabled: true,
    });
    await models.setDefault(idA);
    expect(models.defaultModelId).toBe(idA);

    await models.deleteModel(idA);
    expect(models.models.length).toBe(1);
    expect(models.models[0].id).toBe(idB);
    expect(models.defaultModelId).toBeNull(); // cleared — deleted id matched

    // Deleting an unrelated entry does NOT clear an unrelated default.
    await models.setDefault(idB);
    await models.deleteModel("unknown-id");
    expect(models.defaultModelId).toBe(idB);
  });

  it("update/toggle/delete on an unknown id is a no-op (no exception)", async () => {
    const models = createModels();
    await models.addModel({
      provider: "anthropic",
      displayName: "A",
      modelId: "claude-opus-4-7",
      enabled: true,
    });

    await expect(models.updateModel("nonexistent", { displayName: "X" })).resolves.toBeUndefined();
    await expect(models.toggleEnabled("nonexistent")).resolves.toBeUndefined();
    await expect(models.deleteModel("nonexistent")).resolves.toBeUndefined();
    expect(models.models.length).toBe(1);
  });

  it("rejects invalid provider in addModel and updateModel", async () => {
    const models = createModels();
    await expect(
      // @ts-expect-error — exercising the runtime guard against caller bugs.
      models.addModel({ provider: "fake-provider", displayName: "X", modelId: "x", enabled: true }),
    ).rejects.toThrow();

    const id = await models.addModel({
      provider: "anthropic",
      displayName: "A",
      modelId: "claude-opus-4-7",
      enabled: true,
    });
    await expect(
      // @ts-expect-error — exercising the runtime guard.
      models.updateModel(id, { provider: "fake-provider" }),
    ).rejects.toThrow();
  });
});

describe("models store — defaults", () => {
  it("setDefault writes through to defaultModelId", async () => {
    const models = createModels();
    const id = await models.addModel({
      provider: "anthropic",
      displayName: "A",
      modelId: "claude-opus-4-7",
      enabled: true,
    });

    expect(models.defaultModelId).toBeNull();
    await models.setDefault(id);
    expect(models.defaultModelId).toBe(id);

    await models.setDefault(null);
    expect(models.defaultModelId).toBeNull();
  });
});

describe("models store — write-through semantics", () => {
  it("reflects the optimistic $state write before the POST resolves", async () => {
    // Gate the models POST on a manually-released promise so we can observe the
    // store state while the request is still in flight.
    let releasePost: () => void = () => {};
    const postGate = new Promise<void>((r) => {
      releasePost = r;
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: { method?: string }) => {
        const method = (init?.method ?? "GET").toUpperCase();
        if (String(url).includes("/secrets/")) return new Response(null, { status: 204 });
        if (method === "POST") {
          await postGate;
          return new Response(JSON.stringify({ etag: "e1" }), { status: 200 });
        }
        return new Response(JSON.stringify({ file: serverFile, etag: "e0" }), { status: 200 });
      }),
    );
    const models = createModels();
    const p = models.addModel({
      provider: "anthropic",
      displayName: "Optimistic",
      modelId: "claude-opus-4-7",
      enabled: true,
    });
    // Let the synchronous optimistic write + the reconcile-gate microtask flush.
    await Promise.resolve();
    expect(models.models.length).toBe(1); // visible before the POST resolves
    releasePost();
    await p;
    expect(models.models.length).toBe(1);
  });

  it("adopts the server ETag on a 200 write (subsequent write carries it as ifMatch)", async () => {
    const bodies: unknown[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: { method?: string; body?: string }) => {
        const method = (init?.method ?? "GET").toUpperCase();
        if (String(url).includes("/secrets/")) return new Response(null, { status: 204 });
        if (method === "POST") {
          bodies.push(JSON.parse(init!.body as string));
          return new Response(JSON.stringify({ etag: `srv-${bodies.length}` }), { status: 200 });
        }
        return new Response(JSON.stringify({ file: serverFile, etag: "srv-0" }), { status: 200 });
      }),
    );
    const models = createModels();
    const id = await models.addModel({
      provider: "anthropic",
      displayName: "A",
      modelId: "claude-opus-4-7",
      enabled: true,
    });
    await models.setDefault(id);
    // The second POST must echo the etag the first POST returned.
    expect((bodies[1] as { ifMatch: string }).ifMatch).toBe("srv-1");
  });

  it("a stale 409 reloads server state, re-applies the intent, and retries", async () => {
    // Seed the server with an entry the reload will surface. The first POST 409s
    // (stale), the reload returns that entry, the re-applied setDefault re-POSTs
    // and the retry 200s.
    serverFile = {
      schemaVersion: 1,
      models: [
        {
          id: "srv-entry",
          provider: "anthropic",
          displayName: "Server",
          modelId: "claude-opus-4-7",
          enabled: true,
        },
      ],
      defaultModelId: null,
    };
    let postCount = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: { method?: string }) => {
        const method = (init?.method ?? "GET").toUpperCase();
        if (String(url).includes("/secrets/")) return new Response(null, { status: 204 });
        if (method === "POST") {
          postCount++;
          if (postCount === 1) {
            return new Response(JSON.stringify({ code: "MODELS_STALE", etag: "srv-current" }), {
              status: 409,
            });
          }
          return new Response(JSON.stringify({ etag: "srv-after" }), { status: 200 });
        }
        return new Response(JSON.stringify({ file: serverFile, etag: "srv-current" }), {
          status: 200,
        });
      }),
    );
    const models = createModels();
    await models.setDefault("srv-entry");

    expect(postCount).toBe(2); // initial + retry after reload
    expect(models.models.map((m) => m.id)).toEqual(["srv-entry"]); // adopted server state
    expect(models.defaultModelId).toBe("srv-entry"); // intent re-applied
    expect(models.saveError).toBeNull();
  });

  it("rolls back to the pre-mutation snapshot on a non-409 failure", async () => {
    const models = createModels();
    const idA = await models.addModel({
      provider: "anthropic",
      displayName: "Keep",
      modelId: "claude-opus-4-7",
      enabled: true,
    });
    // Now fail every models POST with a 500.
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: { method?: string }) => {
        const method = (init?.method ?? "GET").toUpperCase();
        if (String(url).includes("/secrets/")) return new Response(null, { status: 204 });
        if (method === "POST") return new Response("nope", { status: 500 });
        return new Response(JSON.stringify({ file: serverFile, etag: "e" }), { status: 200 });
      }),
    );
    await models.updateModel(idA, { displayName: "Should roll back" });
    expect(models.models[0].displayName).toBe("Keep"); // reverted
    expect(models.saveError).not.toBeNull();
  });
});

describe("models store — snapshot + dark gate", () => {
  it("getModelsSnapshot reflects live $state synchronously", async () => {
    const models = createModels();
    expect(getModelsSnapshot()).toEqual({ models: [], defaultModelId: null });
    const id = await models.addModel({
      provider: "gemini",
      displayName: "G",
      modelId: "gemini-2.0",
      enabled: true,
    });
    await models.setDefault(id);
    const snap = getModelsSnapshot();
    expect(snap.models.map((m) => m.id)).toEqual([id]);
    expect(snap.defaultModelId).toBe(id);
  });

  it("loadFromServer does NO fetch while dark (BYO_MODELS_ENABLED=false)", async () => {
    const fetchMock = stubFetch();
    vi.stubGlobal("fetch", fetchMock);
    await loadFromServer();
    // Dark build: the flag is a literal const false, so the load short-circuits.
    expect(fetchMock).not.toHaveBeenCalled();
    expect(getModelsSnapshot().models).toEqual([]);
  });
});

describe("models store — legacy keys (vestigial)", () => {
  it("hasLegacyKeys is false and migrateLegacyKeys is a no-op (server never carries _legacyApiKey)", async () => {
    const models = createModels();
    expect(models.hasLegacyKeys).toBe(false);
    expect(await models.migrateLegacyKeys()).toEqual({ migrated: 0, failed: 0 });
  });
});

describe("models store — keychain ordering on failed writes (terminal-only delete)", () => {
  /**
   * Records every keychain secret op so a test can assert WHICH refs were stored
   * vs deleted. `failModelsPost` flips the models registry POST to a 500 so the
   * write-through rolls back — the case where an eager old-ref delete would strand
   * the reverted entry against a missing secret (security review Q4b).
   */
  type SecretOp = { method: "POST" | "DELETE"; ref: string };
  function recordingFetch(failModelsPost: boolean) {
    const ops: SecretOp[] = [];
    const fn = vi.fn(async (url: string, init?: { method?: string }) => {
      const u = String(url);
      const method = (init?.method ?? "GET").toUpperCase();
      const secretMatch = u.match(/\/secrets\/([^/?#]+)/);
      if (secretMatch) {
        ops.push({ method: method as "POST" | "DELETE", ref: secretMatch[1] });
        return new Response(method === "DELETE" ? '{"existed":true}' : null, {
          status: method === "DELETE" ? 200 : 204,
        });
      }
      if (method === "POST") {
        if (failModelsPost) return new Response("nope", { status: 500 });
        return new Response(JSON.stringify({ etag: `etag-${++etagSeq}` }), { status: 200 });
      }
      return new Response(JSON.stringify({ file: serverFile, etag: "e" }), { status: 200 });
    });
    return { fn, ops, stored: () => ops.filter((o) => o.method === "POST").map((o) => o.ref) };
  }

  it("addModel deletes the just-minted ref when the write rolls back (no orphan)", async () => {
    const rec = recordingFetch(true);
    vi.stubGlobal("fetch", rec.fn);
    const models = createModels();
    await models.addModel(
      { provider: "anthropic", displayName: "A", modelId: "claude-opus-4-7", enabled: true },
      "secret",
    );
    const minted = rec.stored();
    expect(minted.length).toBe(1);
    // The orphaned ref is best-effort-deleted; the entry did not land.
    expect(rec.ops).toContainEqual({ method: "DELETE", ref: minted[0] });
    expect(models.models.length).toBe(0);
  });

  it("updateModel key-rotation rollback keeps the OLD ref and deletes the NEW ref", async () => {
    // First add succeeds so the entry has an old ref.
    vi.stubGlobal("fetch", stubFetch());
    const models = createModels();
    const id = await models.addModel(
      { provider: "anthropic", displayName: "A", modelId: "claude-opus-4-7", enabled: true },
      "old-secret",
    );
    const oldRef = models.models[0].apiKeyRef!;
    expect(oldRef).toBeDefined();

    // Now rotate the key while the registry POST fails terminally.
    const rec = recordingFetch(true);
    vi.stubGlobal("fetch", rec.fn);
    await models.updateModel(id, {}, "new-secret");

    const newRef = rec.stored()[0]; // the only SET during the rotation
    expect(newRef).not.toBe(oldRef);
    // New ref deleted (its write didn't land); OLD ref preserved (entry reverted to it).
    expect(rec.ops).toContainEqual({ method: "DELETE", ref: newRef });
    expect(rec.ops).not.toContainEqual({ method: "DELETE", ref: oldRef });
    expect(models.models[0].apiKeyRef).toBe(oldRef); // rolled back to the still-backed ref
  });

  it("deleteModel rollback keeps the ref (does not delete a secret for a still-live entry)", async () => {
    vi.stubGlobal("fetch", stubFetch());
    const models = createModels();
    const id = await models.addModel(
      { provider: "anthropic", displayName: "A", modelId: "claude-opus-4-7", enabled: true },
      "secret",
    );
    const ref = models.models[0].apiKeyRef!;

    const rec = recordingFetch(true);
    vi.stubGlobal("fetch", rec.fn);
    await models.deleteModel(id);

    // The delete rolled back → the entry is still live, so its secret must remain.
    expect(rec.ops).not.toContainEqual({ method: "DELETE", ref });
    expect(models.models.map((m) => m.id)).toEqual([id]);
  });

  it("updateModel COMMITTED rotation deletes the OLD ref and keeps the NEW ref", async () => {
    // Add succeeds (old ref minted); rotate the key with an all-200 stub so the
    // rotation commits and the new ref is live → the old ref must be cleaned up.
    vi.stubGlobal("fetch", stubFetch());
    const models = createModels();
    const id = await models.addModel(
      { provider: "anthropic", displayName: "A", modelId: "claude-opus-4-7", enabled: true },
      "old-secret",
    );
    const oldRef = models.models[0].apiKeyRef!;

    const rec = recordingFetch(false); // committed
    vi.stubGlobal("fetch", rec.fn);
    await models.updateModel(id, {}, "new-secret");

    const newRef = rec.stored()[0];
    expect(newRef).not.toBe(oldRef);
    expect(models.models[0].apiKeyRef).toBe(newRef); // new ref is live on the entry
    expect(rec.ops).toContainEqual({ method: "DELETE", ref: oldRef }); // old cleaned up
    expect(rec.ops).not.toContainEqual({ method: "DELETE", ref: newRef }); // new kept
  });

  it("deleteModel COMMITTED drops the entry's ref", async () => {
    vi.stubGlobal("fetch", stubFetch());
    const models = createModels();
    const id = await models.addModel(
      { provider: "anthropic", displayName: "A", modelId: "claude-opus-4-7", enabled: true },
      "secret",
    );
    const ref = models.models[0].apiKeyRef!;

    const rec = recordingFetch(false); // committed
    vi.stubGlobal("fetch", rec.fn);
    await models.deleteModel(id);

    expect(models.models.length).toBe(0);
    expect(rec.ops).toContainEqual({ method: "DELETE", ref }); // committed delete cleans the secret
  });
});

describe("models store — concurrency (busy retry, persistent stale, adopt-orphan)", () => {
  type SecretOp = { method: "POST" | "DELETE"; ref: string };

  /**
   * Recording fetch driven by a per-POST status sequence (last entry repeats).
   * 200 → `{etag}`; 409 → `MODELS_STALE`; 429 → `MODELS_BUSY`; else generic fail.
   * GETs return `serverFile` (a test can reseed it to model a concurrent delete).
   */
  function seqFetch(postStatuses: number[]) {
    const ops: SecretOp[] = [];
    let postN = 0;
    const fn = vi.fn(async (url: string, init?: { method?: string }) => {
      const u = String(url);
      const method = (init?.method ?? "GET").toUpperCase();
      const secret = u.match(/\/secrets\/([^/?#]+)/);
      if (secret) {
        ops.push({ method: method as "POST" | "DELETE", ref: secret[1] });
        return new Response(method === "DELETE" ? '{"existed":true}' : null, {
          status: method === "DELETE" ? 200 : 204,
        });
      }
      if (method === "POST") {
        const status = postStatuses[Math.min(postN, postStatuses.length - 1)];
        postN++;
        if (status === 200) {
          return new Response(JSON.stringify({ etag: `etag-${++etagSeq}` }), { status: 200 });
        }
        const code =
          status === 409 ? "MODELS_STALE" : status === 429 ? "MODELS_BUSY" : "MODELS_WRITE_FAILED";
        return new Response(JSON.stringify({ code, etag: "srv-cur" }), { status });
      }
      return new Response(JSON.stringify({ file: serverFile, etag: "srv-cur" }), { status: 200 });
    });
    return {
      fn,
      ops,
      stored: () => ops.filter((o) => o.method === "POST").map((o) => o.ref),
      deleted: () => ops.filter((o) => o.method === "DELETE").map((o) => o.ref),
      postCount: () => postN,
    };
  }

  it("a 429 MODELS_BUSY is transient — re-POSTs and commits (not treated as data loss)", async () => {
    const rec = seqFetch([429, 200]); // busy once, then wins
    vi.stubGlobal("fetch", rec.fn);
    const models = createModels();
    const id = await models.addModel({
      provider: "openai",
      displayName: "G",
      modelId: "gpt-4o",
      enabled: true,
    });

    expect(rec.postCount()).toBe(2); // retried through the busy
    expect(models.models.map((m) => m.id)).toEqual([id]); // committed, not rolled back
    expect(models.saveError).toBeNull();
  });

  it("a sustained 429 (retries exhausted) rolls back with a 'busy, try again' message", async () => {
    const rec = seqFetch([429]); // busy forever
    vi.stubGlobal("fetch", rec.fn);
    const models = createModels();
    await models.addModel({
      provider: "openai",
      displayName: "G",
      modelId: "gpt-4o",
      enabled: true,
    });

    expect(rec.postCount()).toBe(3); // BUSY_RETRY_LIMIT attempts
    expect(models.models.length).toBe(0); // rolled back — the edit did not land
    expect(models.saveError).toMatch(/busy/i);
  });

  it("a PERSISTENT 409 adopts the server state and surfaces a reconcile message", async () => {
    // The server already holds an entry the reload surfaces; BOTH the initial POST
    // and the post-reload retry 409, so the write can't land → adopt, don't diverge.
    serverFile = {
      schemaVersion: 1,
      models: [
        {
          id: "srv-entry",
          provider: "anthropic",
          displayName: "Server",
          modelId: "claude-opus-4-7",
          enabled: true,
        },
      ],
      defaultModelId: null,
    };
    const rec = seqFetch([409, 409]); // stale on both attempts
    vi.stubGlobal("fetch", rec.fn);
    const models = createModels();
    await models.setDefault("srv-entry");

    expect(rec.postCount()).toBe(2);
    expect(models.models.map((m) => m.id)).toEqual(["srv-entry"]); // adopted server
    expect(models.defaultModelId).toBeNull(); // optimistic setDefault NOT left standing
    expect(models.saveError).toMatch(/changed elsewhere/i);
  });

  it("addModel under a persistent 409 (reconcile-adopt) deletes the minted ref (no orphan)", async () => {
    // The user's add never lands (both POSTs 409, server has no such entry) → the
    // minted secret backs nothing and must be cleaned up — the adopt-orphan the
    // outcome-keyed cleanup was designed to catch.
    serverFile = { schemaVersion: 1, models: [], defaultModelId: null };
    const rec = seqFetch([409, 409]);
    vi.stubGlobal("fetch", rec.fn);
    const models = createModels();
    await models.addModel(
      { provider: "anthropic", displayName: "A", modelId: "claude-opus-4-7", enabled: true },
      "secret",
    );

    const minted = rec.stored();
    expect(minted.length).toBe(1);
    expect(rec.deleted()).toContain(minted[0]); // adopt-orphan cleaned up
    expect(models.models.length).toBe(0); // adopted the (empty) server state
  });

  it("updateModel that COMMITS but whose entry vanished server-side deletes the NEW ref (no orphan)", async () => {
    // Add locally, then rotate the key. The first POST 409s; the reload returns a
    // server file WITHOUT the entry (a concurrent delete), so the re-applied update
    // is a no-op and the retry 200s "committed" — but the new ref now backs nothing.
    vi.stubGlobal("fetch", stubFetch());
    const models = createModels();
    const id = await models.addModel(
      { provider: "anthropic", displayName: "A", modelId: "claude-opus-4-7", enabled: true },
      "old-secret",
    );
    const oldRef = models.models[0].apiKeyRef!;

    serverFile = { schemaVersion: 1, models: [], defaultModelId: null }; // entry deleted elsewhere
    const rec = seqFetch([409, 200]); // stale, reload (empty), retry commits
    vi.stubGlobal("fetch", rec.fn);
    await models.updateModel(id, {}, "new-secret");

    const newRef = rec.stored()[0];
    expect(newRef).not.toBe(oldRef);
    expect(models.models.length).toBe(0); // adopted the entry-less server state
    expect(rec.deleted()).toContain(newRef); // committed-but-not-landed → new ref cleaned up
  });
});
