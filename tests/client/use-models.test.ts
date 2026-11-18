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
 *  (Dark, `BYO_MODELS_ENABLED=false` → `loadFromServer` does no fetch, is in
 *  `use-models-dark.test.ts`.)
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  _resetModelsStoreForTests,
  _settleReconcile,
  createModels,
  getModelsSnapshot,
} from "../../src/client/hooks/useModels.svelte.js";
import { API_MODELS } from "../../src/shared/models/contract.js";

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
    expect((id as string).length).toBeGreaterThan(0);
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

    await models.updateModel(id as string, { displayName: "GPT-4o Renamed" });
    const afterUpdate = models.models;
    expect(afterUpdate).not.toBe(afterAdd);

    await models.toggleEnabled(id as string);
    const afterToggle = models.models;
    expect(afterToggle).not.toBe(afterUpdate);

    await models.deleteModel(id as string);
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

    await models.updateModel(idA as string, { displayName: "Patched A" });
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

    await models.updateModel(id as string, {}, "second-secret");
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

    await models.toggleEnabled(idA as string);
    expect(models.models.find((m) => m.id === idA)?.enabled).toBe(false);
    expect(models.models.find((m) => m.id === idB)?.enabled).toBe(false);

    await models.toggleEnabled(idB as string);
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

    await models.deleteModel(idA as string);
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

    // updateModel on an unknown id short-circuits to `false` (nothing committed);
    // toggle/delete stay void no-ops. None throws.
    await expect(models.updateModel("nonexistent", { displayName: "X" })).resolves.toBe(false);
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
    await models.updateModel(idA as string, { displayName: "Should roll back" });
    expect(models.models[0].displayName).toBe("Keep"); // reverted
    expect(models.saveError).not.toBeNull();
  });

  it("serializes overlapping mutations — a failing write cannot clobber a concurrent committed one", async () => {
    const models = createModels();
    const idA = await models.addModel({
      provider: "anthropic",
      displayName: "A",
      modelId: "claude-opus-4-7",
      enabled: true,
    });
    const idB = await models.addModel({
      provider: "anthropic",
      displayName: "B",
      modelId: "claude-opus-4-7",
      enabled: true,
    });

    let releaseAPost!: (res: Response) => void;
    const aPostGate = new Promise<Response>((resolve) => {
      releaseAPost = resolve;
    });
    let postCallCount = 0;

    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: { method?: string }) => {
        const method = (init?.method ?? "GET").toUpperCase();
        if (String(url).includes("/secrets/")) return new Response(null, { status: 204 });
        if (method === "POST") {
          postCallCount++;
          if (postCallCount === 1) return aPostGate; // A's write — held pending
          return new Response(JSON.stringify({ etag: `etag-${postCallCount}` }), { status: 200 });
        }
        return new Response(JSON.stringify({ file: serverFile, etag: "e" }), { status: 200 });
      }),
    );

    const aPromise = models.toggleEnabled(idA as string); // starts; its POST is held pending
    const bPromise = models.toggleEnabled(idB as string); // must queue behind A, not interleave

    // Flush all pending microtasks. If overlapping writes were NOT serialized,
    // B's optimistic apply() would already be visible here (it's synchronous
    // and doesn't depend on A). Proves B's turn hasn't started yet.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(postCallCount).toBe(1); // only A's write has reached the network
    expect(models.models.find((m) => m.id === idB)!.enabled).toBe(true); // B still queued

    // Fail A's write.
    releaseAPost(new Response("nope", { status: 500 }));
    await aPromise;
    expect(models.models.find((m) => m.id === idA)!.enabled).toBe(true); // A rolled back to its OWN prior value

    // B now runs its full cycle and commits — untouched by A's rollback.
    await bPromise;
    expect(postCallCount).toBe(2);
    expect(models.models.find((m) => m.id === idB)!.enabled).toBe(false); // B's toggle committed
    expect(models.models.find((m) => m.id === idA)!.enabled).toBe(true); // still correct after B settles
  });
});

describe("models store — snapshot", () => {
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
    await models.updateModel(id as string, {}, "new-secret");

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
    await models.deleteModel(id as string);

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
    await models.updateModel(id as string, {}, "new-secret");

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
    await models.deleteModel(id as string);

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
    await models.updateModel(id as string, {}, "new-secret");

    const newRef = rec.stored()[0];
    expect(newRef).not.toBe(oldRef);
    expect(models.models.length).toBe(0); // adopted the entry-less server state
    expect(rec.deleted()).toContain(newRef); // committed-but-not-landed → new ref cleaned up
  });
});

describe("models store — M2b outcome returns + clearError", () => {
  it("addModel returns the id on commit and null on a rolled-back write", async () => {
    // Commit: default stub 200s → a string id.
    const models = createModels();
    const okId = await models.addModel({
      provider: "openai",
      displayName: "G",
      modelId: "gpt-4o",
      enabled: true,
    });
    expect(typeof okId).toBe("string");

    // Rollback: every models POST 500s → null (the entry didn't land).
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: { method?: string }) => {
        const method = (init?.method ?? "GET").toUpperCase();
        if (String(url).includes("/secrets/")) return new Response(null, { status: 204 });
        if (method === "POST") return new Response("nope", { status: 500 });
        return new Response(JSON.stringify({ file: serverFile, etag: "e" }), { status: 200 });
      }),
    );
    const nullId = await models.addModel({
      provider: "openai",
      displayName: "H",
      modelId: "gpt-4o",
      enabled: true,
    });
    expect(nullId).toBeNull();
  });

  it("updateModel and setDefault return true on commit, false on a rolled-back write", async () => {
    const models = createModels();
    const id = await models.addModel({
      provider: "anthropic",
      displayName: "A",
      modelId: "claude-opus-4-7",
      enabled: true,
    });

    expect(await models.updateModel(id as string, { displayName: "A2" })).toBe(true);
    expect(await models.setDefault(id)).toBe(true);

    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: { method?: string }) => {
        const method = (init?.method ?? "GET").toUpperCase();
        if (String(url).includes("/secrets/")) return new Response(null, { status: 204 });
        if (method === "POST") return new Response("nope", { status: 500 });
        return new Response(JSON.stringify({ file: serverFile, etag: "e" }), { status: 200 });
      }),
    );
    expect(await models.updateModel(id as string, { displayName: "A3" })).toBe(false);
    expect(await models.setDefault(null)).toBe(false);
  });

  it("clearError() clears a sticky saveError without a write", async () => {
    const models = createModels();
    const id = await models.addModel({
      provider: "anthropic",
      displayName: "A",
      modelId: "claude-opus-4-7",
      enabled: true,
    });
    // Force a rollback to set saveError.
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: { method?: string }) => {
        const method = (init?.method ?? "GET").toUpperCase();
        if (String(url).includes("/secrets/")) return new Response(null, { status: 204 });
        if (method === "POST") return new Response("nope", { status: 500 });
        return new Response(JSON.stringify({ file: serverFile, etag: "e" }), { status: 200 });
      }),
    );
    await models.setDefault(id);
    expect(models.saveError).not.toBeNull();

    models.clearError();
    expect(models.saveError).toBeNull();
  });
});

// #1123 R1.4 (LM Studio and "another local server", 2026-11-15): a first save
// of either new provider is a first local model, so part B's first-local toast
// fires for it as for Ollama (the toast's own store listens on this signal).
describe("models store — the new local providers count as local", () => {
  for (const provider of ["local-lmstudio", "local-other"] as const) {
    it(`${provider}: the first save signals firstLocal, a second does not`, async () => {
      const { onModelsWriteCommitted } = await import(
        "../../src/client/models/models-write-signal.js"
      );
      const seen: boolean[] = [];
      const off = onModelsWriteCommitted((info) => seen.push(info.firstLocal));
      try {
        const models = createModels();
        const entry = {
          provider,
          displayName: "Mine",
          modelId: "m",
          endpoint: "http://127.0.0.1:1234",
          enabled: true,
        };
        expect(await models.addModel(entry)).not.toBeNull();
        expect(await models.addModel(entry)).not.toBeNull();
        expect(seen).toEqual([true, false]);
      } finally {
        off();
      }
    });
  }
});

// #1123, the automatic default, client half (Label decision L6 of 2026-11-17,
// Default decisions DD1 to DD4 of 2026-11-18). Inside the `apply` of every
// models write, after the write's own change, the shared `autoDefaultFor` rule
// runs on the state that run produced: with no default at all (null, or naming
// no entry) and exactly one enabled local entry, that entry becomes the
// default in the same write, and the POST carries `autoDefaultId`. A default
// that names an entry is never changed; `setDefault` is outside the rule.
describe("models store — the automatic default (rows as data)", () => {
  type Ids = Record<string, string>;
  type Body = {
    file: {
      models: { id: string; provider: string; enabled: boolean; displayName: string }[];
      defaultModelId: string | null;
    };
    autoDefaultId?: string;
  };
  type Models = ReturnType<typeof createModels>;
  type Row = {
    row: string;
    name: string;
    /** Ordinary writes, then `setDefault(...)` (outside the rule). */
    seed: (m: Models, ids: Ids) => Promise<void>;
    /** The default the seed must leave, asserted before the write. */
    seeded: (ids: Ids) => string | null;
    /** A server file the 409 reload returns (rows 9a to 9e). */
    server?: (ids: Ids) => { models: unknown[]; defaultModelId: string | null };
    /** Status of each models POST the write makes (default: 200). */
    statuses?: number[];
    write: (m: Models, ids: Ids) => Promise<void>;
    expected: (ids: Ids) => string | null;
    /** The rule marked in the run whose POST is checked. */
    marked: boolean;
    /** Models POSTs the write makes (rows 1 to 8: one; 9a to 9f: two). */
    posts?: number;
    /** 9f: every POST of the write carries the marker. */
    everyPostMarked?: boolean;
    /** 9a, 9b, 9e: the first (pre-409) POST carried this marker, the re-run's none. */
    firstMarked?: (ids: Ids) => string;
    /** The ids the last POST must list, in order (rows that add or reload). */
    posted?: (ids: Ids) => string[];
    /** An edited entry's fields as the last POST must carry them. */
    edited?: (ids: Ids) => { id: string; fields: Record<string, unknown> };
  };

  const local = (name: string, enabled = true) => ({
    provider: "local-ollama" as const,
    displayName: name,
    modelId: `m-${name}`,
    endpoint: "http://127.0.0.1:11434",
    enabled,
  });
  const cloud = (name: string, enabled = true) => ({
    provider: "anthropic" as const,
    displayName: name,
    modelId: "claude-opus-4-7",
    enabled,
  });
  const srvLocal = (id: string, enabled = true) => ({ id, ...local(id, enabled) });
  const srvCloud = (id: string) => ({ id, ...cloud(id) });

  /** Add and record the id (asserting the add committed). */
  async function add(m: Models, ids: Ids, key: string, entry: Parameters<Models["addModel"]>[0]) {
    const id = await m.addModel(entry);
    expect(id).not.toBeNull();
    ids[key] = id as string;
  }

  /** Models POST bodies only (a keyed add also POSTs to `/secrets/`). */
  let bodies: Body[] = [];
  let statuses: number[] = [];
  function ruleFetch() {
    return vi.fn(async (url: string, init?: { method?: string; body?: string }) => {
      const u = String(url);
      const method = (init?.method ?? "GET").toUpperCase();
      if (u.includes("/secrets/")) {
        return new Response(method === "DELETE" ? '{"existed":true}' : null, {
          status: method === "DELETE" ? 200 : 204,
        });
      }
      if (method === "POST" && u.endsWith(API_MODELS)) {
        bodies.push(JSON.parse(init?.body as string) as Body);
        const status = statuses.length > 0 ? (statuses.shift() as number) : 200;
        if (status === 200) {
          return new Response(JSON.stringify({ etag: `etag-${++etagSeq}` }), { status: 200 });
        }
        const code =
          status === 409 ? "MODELS_STALE" : status === 429 ? "MODELS_BUSY" : "MODELS_WRITE_FAILED";
        return new Response(JSON.stringify({ code, etag: "srv-cur" }), { status });
      }
      return new Response(JSON.stringify({ file: serverFile, etag: "srv-cur" }), { status: 200 });
    });
  }

  beforeEach(() => {
    bodies = [];
    statuses = [];
    vi.stubGlobal("fetch", ruleFetch());
  });

  const seedLocalA = async (m: Models, ids: Ids) => add(m, ids, "A", local("A"));
  /** One enabled local A with no default (A is marked on its add, then cleared by hand). */
  const seedLocalAUnmarked = async (m: Models, ids: Ids) => {
    await seedLocalA(m, ids);
    await m.setDefault(null);
  };

  const ROWS: Row[] = [
    {
      row: "1",
      name: "no enabled local, no default; add an enabled local → the new entry (L6)",
      seed: async () => {},
      seeded: () => null,
      write: (m, ids) => add(m, ids, "N", local("N")),
      expected: (ids) => ids.N,
      posted: (ids) => [ids.N],
      marked: true,
    },
    {
      row: "1a",
      name: "cloud default; add an enabled local → cloud default kept (DD1)",
      seed: async (m, ids) => {
        // Keyed: its `/secrets/` POST is not a models POST.
        ids.C = (await m.addModel(cloud("C"), "sk-test-DO-NOT-USE")) as string;
        expect(ids.C).toBeTruthy();
        await m.setDefault(ids.C);
      },
      seeded: (ids) => ids.C,
      write: (m, ids) => add(m, ids, "N", local("N")),
      expected: (ids) => ids.C,
      marked: false,
    },
    {
      row: "1b",
      name: "switched-off local default; add an enabled local → unchanged (DD1)",
      seed: async (m, ids) => {
        await add(m, ids, "D", local("D", false));
        await m.setDefault(ids.D);
      },
      seeded: (ids) => ids.D,
      write: (m, ids) => add(m, ids, "N", local("N")),
      expected: (ids) => ids.D,
      marked: false,
    },
    {
      row: "1c",
      name: "an enabled cloud entry, no default; add an enabled local → the new entry",
      seed: async (m, ids) => add(m, ids, "C", cloud("C")),
      seeded: () => null,
      write: (m, ids) => add(m, ids, "N", local("N")),
      expected: (ids) => ids.N,
      posted: (ids) => [ids.C, ids.N],
      marked: true,
    },
    {
      row: "1d",
      name: 'one enabled local A, default "ghost"; rename A → A (dangling is none)',
      seed: async (m, ids) => {
        await seedLocalA(m, ids);
        await m.setDefault("ghost");
      },
      seeded: () => "ghost",
      write: async (m, ids) => {
        await m.updateModel(ids.A, { displayName: "A renamed" });
      },
      expected: (ids) => ids.A,
      edited: (ids) => ({ id: ids.A, fields: { displayName: "A renamed" } }),
      marked: true,
    },
    {
      row: "2",
      name: "one enabled local, the default; add a second enabled local → unchanged",
      seed: seedLocalA,
      seeded: (ids) => ids.A,
      write: (m, ids) => add(m, ids, "B", local("B")),
      expected: (ids) => ids.A,
      marked: false,
    },
    {
      row: "2a",
      name: "one enabled local A, no default; add a second enabled local → none (Ruling 1)",
      seed: seedLocalAUnmarked,
      seeded: () => null,
      write: (m, ids) => add(m, ids, "B", local("B")),
      expected: () => null,
      marked: false,
    },
    {
      row: "2b",
      name: "one enabled local A, no default; rename A → A (DD2)",
      seed: seedLocalAUnmarked,
      seeded: () => null,
      write: async (m, ids) => {
        await m.updateModel(ids.A, { displayName: "A renamed" });
      },
      expected: (ids) => ids.A,
      edited: (ids) => ({ id: ids.A, fields: { displayName: "A renamed" } }),
      marked: true,
    },
    {
      row: "2b",
      name: "one enabled local A, no default; rename another entry → A (DD2)",
      seed: async (m, ids) => {
        await seedLocalA(m, ids);
        await add(m, ids, "C", cloud("C"));
        await m.setDefault(null);
      },
      seeded: () => null,
      write: async (m, ids) => {
        await m.updateModel(ids.C, { displayName: "C renamed" });
      },
      expected: (ids) => ids.A,
      edited: (ids) => ({ id: ids.C, fields: { displayName: "C renamed" } }),
      marked: true,
    },
    {
      row: "2c",
      name: "one enabled local A, no default; add a switched-off local → A (DD2)",
      seed: seedLocalAUnmarked,
      seeded: () => null,
      write: (m, ids) => add(m, ids, "D", local("D", false)),
      expected: (ids) => ids.A,
      posted: (ids) => [ids.A, ids.D],
      marked: true,
    },
    {
      row: "2d",
      name: "one enabled local A, no default; add a cloud entry → A (DD2)",
      seed: seedLocalAUnmarked,
      seeded: () => null,
      write: (m, ids) => add(m, ids, "C", cloud("C")),
      expected: (ids) => ids.A,
      posted: (ids) => [ids.A, ids.C],
      marked: true,
    },
    {
      row: "2e",
      name: "one enabled local A, no default; toggle A off → none",
      seed: seedLocalAUnmarked,
      seeded: () => null,
      write: (m, ids) => m.toggleEnabled(ids.A),
      expected: () => null,
      marked: false,
    },
    {
      row: "2e",
      name: "one enabled local A, no default; edit A to disabled → none",
      seed: seedLocalAUnmarked,
      seeded: () => null,
      write: async (m, ids) => {
        await m.updateModel(ids.A, { enabled: false });
      },
      expected: () => null,
      edited: (ids) => ({ id: ids.A, fields: { enabled: false } }),
      marked: false,
    },
    {
      row: "2e",
      name: "one enabled local A, no default; delete A → none",
      seed: seedLocalAUnmarked,
      seeded: () => null,
      write: (m, ids) => m.deleteModel(ids.A),
      expected: () => null,
      marked: false,
    },
    {
      row: "2f",
      name: "A made the default by setDefault(A); rename A → unchanged, no marker",
      seed: async (m, ids) => {
        await seedLocalAUnmarked(m, ids);
        await m.setDefault(ids.A);
      },
      seeded: (ids) => ids.A,
      write: async (m, ids) => {
        await m.updateModel(ids.A, { displayName: "A renamed" });
      },
      expected: (ids) => ids.A,
      edited: (ids) => ({ id: ids.A, fields: { displayName: "A renamed" } }),
      marked: false,
    },
    {
      row: "2f",
      name: "A made the default by setDefault(A); add a cloud entry → unchanged, no marker",
      seed: async (m, ids) => {
        await seedLocalAUnmarked(m, ids);
        await m.setDefault(ids.A);
      },
      seeded: (ids) => ids.A,
      write: (m, ids) => add(m, ids, "C", cloud("C")),
      expected: (ids) => ids.A,
      marked: false,
    },
    {
      row: "3",
      name: "no enabled local, no default; add a switched-off local → none",
      seed: async () => {},
      seeded: () => null,
      write: (m, ids) => add(m, ids, "D", local("D", false)),
      expected: () => null,
      marked: false,
    },
    {
      row: "4",
      name: "no enabled local, no default; turn on a switched-off local by toggle → it (DD3)",
      seed: async (m, ids) => add(m, ids, "D", local("D", false)),
      seeded: () => null,
      write: (m, ids) => m.toggleEnabled(ids.D),
      expected: (ids) => ids.D,
      marked: true,
    },
    {
      row: "4",
      name: "no enabled local, no default; turn on a switched-off local by edit → it (DD3)",
      seed: async (m, ids) => add(m, ids, "D", local("D", false)),
      seeded: () => null,
      write: async (m, ids) => {
        await m.updateModel(ids.D, { enabled: true });
      },
      expected: (ids) => ids.D,
      edited: (ids) => ({ id: ids.D, fields: { enabled: true } }),
      marked: true,
    },
    {
      row: "4a",
      name: "another enabled local, the default; turn on a switched-off local → unchanged",
      seed: async (m, ids) => {
        await seedLocalA(m, ids);
        await add(m, ids, "D", local("D", false));
      },
      seeded: (ids) => ids.A,
      write: (m, ids) => m.toggleEnabled(ids.D),
      expected: (ids) => ids.A,
      marked: false,
    },
    {
      row: "4b",
      name: "cloud default; turn on a switched-off local → unchanged (DD1)",
      seed: async (m, ids) => {
        await add(m, ids, "C", cloud("C"));
        await m.setDefault(ids.C);
        await add(m, ids, "D", local("D", false));
      },
      seeded: (ids) => ids.C,
      write: (m, ids) => m.toggleEnabled(ids.D),
      expected: (ids) => ids.C,
      marked: false,
    },
    {
      row: "4b",
      name: "switched-off local default; turn on a different switched-off local → unchanged (DD1)",
      seed: async (m, ids) => {
        await add(m, ids, "D1", local("D1", false));
        await m.setDefault(ids.D1);
        await add(m, ids, "D2", local("D2", false));
      },
      seeded: (ids) => ids.D1,
      write: (m, ids) => m.toggleEnabled(ids.D2),
      expected: (ids) => ids.D1,
      marked: false,
    },
    {
      row: "4c",
      name: "no default, a cloud entry; edit it to a local provider, enabled → it",
      seed: async (m, ids) => add(m, ids, "C", cloud("C")),
      seeded: () => null,
      write: async (m, ids) => {
        await m.updateModel(ids.C, {
          provider: "local-ollama",
          endpoint: "http://127.0.0.1:11434",
          enabled: true,
        });
      },
      expected: (ids) => ids.C,
      edited: (ids) => ({
        id: ids.C,
        fields: { provider: "local-ollama", endpoint: "http://127.0.0.1:11434", enabled: true },
      }),
      marked: true,
    },
    {
      row: "4d",
      name: "one enabled local A, no default; edit A to a cloud provider → none",
      seed: seedLocalAUnmarked,
      seeded: () => null,
      write: async (m, ids) => {
        await m.updateModel(ids.A, { provider: "anthropic" });
      },
      expected: () => null,
      edited: (ids) => ({ id: ids.A, fields: { provider: "anthropic" } }),
      marked: false,
    },
    {
      row: "5",
      name: "default and one other enabled local; delete the default → the other (DD2)",
      seed: async (m, ids) => {
        await seedLocalA(m, ids);
        await add(m, ids, "B", local("B"));
      },
      seeded: (ids) => ids.A,
      write: (m, ids) => m.deleteModel(ids.A),
      expected: (ids) => ids.B,
      marked: true,
    },
    {
      row: "5a",
      name: "cloud default, one enabled local; delete the default → the local one",
      seed: async (m, ids) => {
        await add(m, ids, "C", cloud("C"));
        await m.setDefault(ids.C);
        await add(m, ids, "A", local("A"));
      },
      seeded: (ids) => ids.C,
      write: (m, ids) => m.deleteModel(ids.C),
      expected: (ids) => ids.A,
      marked: true,
    },
    {
      row: "5a",
      name: "switched-off default, one enabled local; delete the default → the local one",
      seed: async (m, ids) => {
        await add(m, ids, "D", local("D", false));
        await m.setDefault(ids.D);
        await add(m, ids, "A", local("A"));
      },
      seeded: (ids) => ids.D,
      write: (m, ids) => m.deleteModel(ids.D),
      expected: (ids) => ids.A,
      marked: true,
    },
    {
      row: "6",
      name: "default and two other enabled locals; delete the default → none (Accepted)",
      seed: async (m, ids) => {
        await seedLocalA(m, ids);
        await add(m, ids, "B", local("B"));
        await add(m, ids, "E", local("E"));
      },
      seeded: (ids) => ids.A,
      write: (m, ids) => m.deleteModel(ids.A),
      expected: () => null,
      marked: false,
    },
    ...(
      [
        ["delete one", (m: Models, ids: Ids) => m.deleteModel(ids.A)],
        ["toggle one off", (m: Models, ids: Ids) => m.toggleEnabled(ids.A)],
        [
          "edit one to disabled",
          async (m: Models, ids: Ids) => {
            await m.updateModel(ids.A, { enabled: false });
          },
        ],
      ] as const
    ).map(
      ([what, write]): Row => ({
        row: "6a",
        name: `two enabled locals, no default; ${what} → the other (DD2)`,
        seed: async (m, ids) => {
          await seedLocalA(m, ids);
          await add(m, ids, "B", local("B"));
          await m.setDefault(null);
        },
        seeded: () => null,
        write,
        expected: (ids) => ids.B,
        marked: true,
      }),
    ),
    {
      row: "6b",
      name: "cloud default, two enabled locals; delete one local → cloud default (DD1)",
      seed: async (m, ids) => {
        await add(m, ids, "C", cloud("C"));
        await m.setDefault(ids.C);
        await add(m, ids, "A", local("A"));
        await add(m, ids, "B", local("B"));
      },
      seeded: (ids) => ids.C,
      write: (m, ids) => m.deleteModel(ids.A),
      expected: (ids) => ids.C,
      marked: false,
    },
    {
      row: "6c",
      name: "three enabled locals, no default; delete one → none (Accepted)",
      seed: async (m, ids) => {
        await seedLocalA(m, ids);
        await add(m, ids, "B", local("B"));
        await add(m, ids, "E", local("E"));
        await m.setDefault(null);
      },
      seeded: () => null,
      write: (m, ids) => m.deleteModel(ids.A),
      expected: () => null,
      marked: false,
    },
    {
      row: "6d",
      name: "two enabled locals, no default; edit one to a cloud provider → the other",
      seed: async (m, ids) => {
        await seedLocalA(m, ids);
        await add(m, ids, "B", local("B"));
        await m.setDefault(null);
      },
      seeded: () => null,
      write: async (m, ids) => {
        await m.updateModel(ids.A, { provider: "anthropic" });
      },
      expected: (ids) => ids.B,
      edited: (ids) => ({ id: ids.A, fields: { provider: "anthropic" } }),
      marked: true,
    },
    {
      row: "7",
      name: "default and one other enabled local; switch the default off by toggle → kept (DD1, CD-8)",
      seed: async (m, ids) => {
        await seedLocalA(m, ids);
        await add(m, ids, "B", local("B"));
      },
      seeded: (ids) => ids.A,
      write: (m, ids) => m.toggleEnabled(ids.A),
      expected: (ids) => ids.A,
      marked: false,
    },
    {
      row: "7",
      name: "default and one other enabled local; switch the default off by edit → kept (DD1, CD-8)",
      seed: async (m, ids) => {
        await seedLocalA(m, ids);
        await add(m, ids, "B", local("B"));
      },
      seeded: (ids) => ids.A,
      write: async (m, ids) => {
        await m.updateModel(ids.A, { enabled: false });
      },
      expected: (ids) => ids.A,
      edited: (ids) => ({ id: ids.A, fields: { enabled: false } }),
      marked: false,
    },
    {
      row: "8",
      name: "cloud default and one enabled local; add a second enabled local → cloud default (DD1)",
      seed: async (m, ids) => {
        await add(m, ids, "C", cloud("C"));
        await m.setDefault(ids.C);
        await add(m, ids, "A", local("A"));
      },
      seeded: (ids) => ids.C,
      write: (m, ids) => add(m, ids, "B", local("B")),
      expected: (ids) => ids.C,
      marked: false,
    },
    {
      row: "9a",
      name: "409: the server gained an enabled local default → the other window's default, no marker",
      seed: async () => {},
      seeded: () => null,
      server: () => ({ models: [srvLocal("X")], defaultModelId: "X" }),
      statuses: [409, 200],
      write: (m, ids) => add(m, ids, "N", local("N")),
      expected: () => "X",
      posted: (ids) => ["X", ids.N],
      firstMarked: (ids) => ids.N,
      marked: false,
      posts: 2,
    },
    {
      row: "9b",
      name: "409: the server gained an enabled local, no default → none (two enabled), no marker",
      seed: async () => {},
      seeded: () => null,
      server: () => ({ models: [srvLocal("X")], defaultModelId: null }),
      statuses: [409, 200],
      write: (m, ids) => add(m, ids, "N", local("N")),
      expected: () => null,
      posted: (ids) => ["X", ids.N],
      firstMarked: (ids) => ids.N,
      marked: false,
      posts: 2,
    },
    {
      row: "9c",
      name: "409: the server deleted the mirror's default → the new entry, marked",
      seed: seedLocalA,
      seeded: (ids) => ids.A,
      server: () => ({ models: [], defaultModelId: null }),
      statuses: [409, 200],
      write: (m, ids) => add(m, ids, "N", local("N")),
      expected: (ids) => ids.N,
      posted: (ids) => [ids.N],
      marked: true,
      posts: 2,
    },
    {
      row: "9d",
      name: "409: delete the default while the server gained a third enabled local → none",
      seed: async (m, ids) => {
        await seedLocalA(m, ids);
        await add(m, ids, "B", local("B"));
      },
      seeded: (ids) => ids.A,
      server: (ids) => ({
        models: [srvLocal(ids.A), srvLocal(ids.B), srvLocal("E")],
        defaultModelId: ids.A,
      }),
      statuses: [409, 200],
      write: (m, ids) => m.deleteModel(ids.A),
      expected: () => null,
      posted: (ids) => [ids.B, "E"],
      marked: false,
      posts: 2,
    },
    {
      row: "9e",
      name: "409: the server set a cloud default → cloud default, no marker",
      seed: async () => {},
      seeded: () => null,
      server: () => ({ models: [srvCloud("C")], defaultModelId: "C" }),
      statuses: [409, 200],
      write: (m, ids) => add(m, ids, "N", local("N")),
      expected: () => "C",
      posted: (ids) => ["C", ids.N],
      firstMarked: (ids) => ids.N,
      marked: false,
      posts: 2,
    },
    {
      row: "9f",
      name: "429 then 200: delete the default → B, and both POSTs carry the marker",
      seed: async (m, ids) => {
        await seedLocalA(m, ids);
        await add(m, ids, "B", local("B"));
      },
      seeded: (ids) => ids.A,
      statuses: [429, 200],
      write: (m, ids) => m.deleteModel(ids.A),
      expected: (ids) => ids.B,
      marked: true,
      posts: 2,
      everyPostMarked: true,
    },
  ];

  for (const r of ROWS) {
    it(`row ${r.row}: ${r.name}`, async () => {
      const m = createModels();
      const ids: Ids = {};
      await r.seed(m, ids);
      expect(m.defaultModelId).toBe(r.seeded(ids));
      expect(m.saveError).toBeNull();
      if (r.server) serverFile = { schemaVersion: 1, ...r.server(ids) };
      statuses = [...(r.statuses ?? [])];
      const before = bodies.length;

      await r.write(m, ids);

      const posted = bodies.slice(before);
      expect(posted.length).toBe(r.posts ?? 1);
      expect(m.saveError).toBeNull();
      const expected = r.expected(ids);
      expect(m.defaultModelId).toBe(expected);
      const last = posted[posted.length - 1];
      expect(last.file.defaultModelId).toBe(expected);
      // The POSTed list is the store's list (adds and edits included).
      expect(last.file.models.map((e) => [e.id, e.provider, e.enabled, e.displayName])).toEqual(
        m.models.map((e) => [e.id, e.provider, e.enabled, e.displayName]),
      );
      if (r.marked) {
        expect(last.autoDefaultId).toBe(expected);
      } else {
        expect("autoDefaultId" in last).toBe(false);
      }
      if (r.everyPostMarked) {
        for (const b of posted) expect(b.autoDefaultId).toBe(expected);
      }
      if (r.firstMarked) expect(posted[0].autoDefaultId).toBe(r.firstMarked(ids));
      if (r.posted) expect(last.file.models.map((e) => e.id)).toEqual(r.posted(ids));
      if (r.edited) {
        const { id, fields } = r.edited(ids);
        expect(last.file.models.find((e) => e.id === id)).toMatchObject(fields);
      }
    });
  }

  it("setDefault never sends the marker: marked add, then setDefault(null), then setDefault(A)", async () => {
    const m = createModels();
    const ids: Ids = {};
    await add(m, ids, "A", local("A"));
    expect(bodies[bodies.length - 1].autoDefaultId).toBe(ids.A);

    await m.setDefault(null);
    expect(m.defaultModelId).toBeNull();
    expect(bodies[bodies.length - 1].file.defaultModelId).toBeNull();
    expect("autoDefaultId" in bodies[bodies.length - 1]).toBe(false);

    await m.setDefault(ids.A);
    expect(bodies.length).toBe(3);
    expect(m.defaultModelId).toBe(ids.A);
    expect(bodies[2].file.defaultModelId).toBe(ids.A);
    expect("autoDefaultId" in bodies[2]).toBe(false);
  });

  it("a rolled-back marked write restores no default, and the next write (one that marks nothing) posts no marker", async () => {
    const m = createModels();
    const ids: Ids = {};
    statuses = [500];
    expect(await m.addModel(local("A"))).toBeNull();
    expect(bodies[0].autoDefaultId).toBeDefined(); // the failed POST was marked
    expect(m.models).toEqual([]);
    expect(m.defaultModelId).toBeNull();

    await add(m, ids, "C", cloud("C"));
    expect(bodies.length).toBe(2);
    expect("autoDefaultId" in bodies[1]).toBe(false);
    expect(bodies[1].file.defaultModelId).toBeNull();
  });

  it("the default is set in the write's own apply, before the POST is gated (not at POST time)", async () => {
    _resetModelsStoreForTests(); // the reconcile gate left pending
    const m = createModels();
    const p = m.addModel(local("N"));
    for (let i = 0; i < 10; i++) await Promise.resolve();
    expect(m.models).toHaveLength(1);
    const n = m.models[0].id;
    expect(m.defaultModelId).toBe(n); // optimistic, inside apply
    expect(bodies).toHaveLength(0); // nothing posted yet
    _settleReconcile();
    expect(await p).toBe(n);
    expect(bodies).toHaveLength(1);
    expect(bodies[0].autoDefaultId).toBe(n);
  });

  // Review round 1 (#2462): the rule is decided at each write's queue turn,
  // never when the mutator is called. Calls that are not awaited queue behind
  // one another; a decision taken at call time would act on stale state.
  it("an un-awaited setDefault(cloud) then an add of a local: the cloud default stays, the add's POST has no marker", async () => {
    const m = createModels();
    const ids: Ids = {};
    await add(m, ids, "C", cloud("C"));
    const before = bodies.length;
    const pDefault = m.setDefault(ids.C);
    const pAdd = m.addModel(local("N"));
    expect(await pDefault).toBe(true);
    const n = await pAdd;
    expect(n).not.toBeNull();
    const posted = bodies.slice(before);
    expect(posted).toHaveLength(2);
    expect(posted[1].file.defaultModelId).toBe(ids.C);
    expect("autoDefaultId" in posted[1]).toBe(false);
    expect(m.defaultModelId).toBe(ids.C);
  });

  it("two un-awaited adds of enabled locals: the first is marked, the second is not, no default replaced", async () => {
    const m = createModels();
    const p1 = m.addModel(local("A"));
    const p2 = m.addModel(local("B"));
    const a = await p1;
    const b = await p2;
    expect(a).not.toBeNull();
    expect(b).not.toBeNull();
    expect(bodies).toHaveLength(2);
    expect(bodies[0].autoDefaultId).toBe(a);
    expect(bodies[0].file.defaultModelId).toBe(a);
    expect("autoDefaultId" in bodies[1]).toBe(false);
    expect(bodies[1].file.defaultModelId).toBe(a);
    expect(m.defaultModelId).toBe(a);
  });

  // Every local provider counts, through the one shared rule.
  for (const provider of ["local-llamacpp", "local-lmstudio", "local-other"] as const) {
    it(`row 1 with ${provider}: the new entry is marked`, async () => {
      const m = createModels();
      const id = await m.addModel({ ...local("N"), provider });
      expect(id).not.toBeNull();
      expect(bodies).toHaveLength(1);
      expect(bodies[0].autoDefaultId).toBe(id);
      expect(m.defaultModelId).toBe(id);
    });
  }

  it("the store imports the shared rule and defines no copy of its own", async () => {
    const { readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const src = readFileSync(
      join(__dirname, "../../src/client/hooks/useModels.svelte.ts"),
      "utf8",
    ).replace(/\r\n/g, "\n");
    expect(src).toContain('import { autoDefaultFor } from "../../shared/models/auto-default.js";');
    expect(src).not.toMatch(/function\s+autoDefaultFor\b|autoDefaultFor\s*=/);
    expect([...src.matchAll(/\bautoDefaultFor\s*\(/g)]).toHaveLength(1);
    // Nothing else in the store decides "the one enabled local entry" itself.
    expect(src).not.toMatch(
      /isLocalProvider\([^)]*\)\s*&&\s*\w+\.enabled|enabled\s*&&\s*isLocalProvider/,
    );
  });
});
