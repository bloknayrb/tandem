/**
 * Route-level tests for POST /api/store/reclaim-lock (#1077).
 *
 * Exercises the mutating-route origin gate (assertOriginAllowlisted), the
 * success path (reclaim → re-persist open docs → broadcast cleared flag),
 * the no-op path (store already writable), and the structured 409 failure
 * the banner surfaces inline.
 */
import express, { type Express } from "express";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { API_STORE_RECLAIM_LOCK } from "../../src/shared/api-paths.js";
import { TAURI_HOSTNAME } from "../../src/shared/constants.js";

const reclaimStoreLock = vi.fn();
const isStoreReadOnly = vi.fn(() => false);
const persistSnapshot = vi.fn();
const getAllFileSyncContexts = vi.fn(() => [] as unknown[]);
const broadcastStoreReadOnly = vi.fn();

vi.mock("../../src/server/annotations/store.js", () => ({
  reclaimStoreLock: () => reclaimStoreLock(),
  isStoreReadOnly: () => isStoreReadOnly(),
}));

vi.mock("../../src/server/annotations/sync.js", () => ({
  persistSnapshot: (...args: unknown[]) => persistSnapshot(...args),
}));

vi.mock("../../src/server/events/file-sync-registry.js", () => ({
  getAllFileSyncContexts: () => getAllFileSyncContexts(),
}));

vi.mock("../../src/server/mcp/document-service.js", () => ({
  broadcastStoreReadOnly: (v: boolean) => broadcastStoreReadOnly(v),
}));

import { handleStoreReclaimLock } from "../../src/server/mcp/routes/store-reclaim.js";

function buildApp(): Express {
  const app = express();
  app.use(express.json());
  app.post(API_STORE_RECLAIM_LOCK, handleStoreReclaimLock);
  return app;
}

async function request(
  app: Express,
  extraHeaders?: Record<string, string>,
): Promise<{ status: number; body: unknown }> {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, "127.0.0.1", async () => {
      const address = server.address();
      if (typeof address !== "object" || address === null) {
        server.close();
        reject(new Error("no address"));
        return;
      }
      try {
        const res = await fetch(`http://127.0.0.1:${address.port}${API_STORE_RECLAIM_LOCK}`, {
          method: "POST",
          headers: { Origin: `http://${TAURI_HOSTNAME}`, ...(extraHeaders ?? {}) },
        });
        const payload = await res.json().catch(() => null);
        resolve({ status: res.status, body: payload });
      } catch (err) {
        reject(err);
      } finally {
        server.close();
      }
    });
  });
}

describe("POST /api/store/reclaim-lock (#1077)", () => {
  beforeEach(() => {
    reclaimStoreLock.mockReset();
    isStoreReadOnly.mockReset().mockReturnValue(false);
    persistSnapshot.mockReset().mockResolvedValue(undefined);
    getAllFileSyncContexts.mockReset().mockReturnValue([]);
    broadcastStoreReadOnly.mockReset();
  });

  it("rejects a non-allowlisted Origin with 403 before touching the lock", async () => {
    const res = await request(buildApp(), { Origin: "https://evil.example" });
    expect(res.status).toBe(403);
    expect(reclaimStoreLock).not.toHaveBeenCalled();
    expect(broadcastStoreReadOnly).not.toHaveBeenCalled();
  });

  it("on successful reclaim: re-persists every wired doc and broadcasts the cleared flag", async () => {
    reclaimStoreLock.mockResolvedValue({ ok: true, reclaimed: true });
    const ctxA = { store: { a: 1 }, ydoc: { d: 1 }, docHash: "hashA", meta: { filePath: "/a.md" } };
    const ctxB = { store: { b: 2 }, ydoc: { d: 2 }, docHash: "hashB", meta: { filePath: "/b.md" } };
    getAllFileSyncContexts.mockReturnValue([ctxA, ctxB]);

    const res = await request(buildApp());
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ data: { reclaimed: true } });
    expect(persistSnapshot).toHaveBeenCalledTimes(2);
    expect(persistSnapshot).toHaveBeenCalledWith(ctxA.store, ctxA.ydoc, "hashA", "/a.md");
    expect(persistSnapshot).toHaveBeenCalledWith(ctxB.store, ctxB.ydoc, "hashB", "/b.md");
    expect(broadcastStoreReadOnly).toHaveBeenCalledWith(false);
  });

  it("a failing per-doc persist does not fail the reclaim", async () => {
    reclaimStoreLock.mockResolvedValue({ ok: true, reclaimed: true });
    getAllFileSyncContexts.mockReturnValue([
      { store: {}, ydoc: {}, docHash: "hashA", meta: { filePath: "/a.md" } },
    ]);
    persistSnapshot.mockRejectedValue(new Error("disk full"));

    const res = await request(buildApp());
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ data: { reclaimed: true } });
    expect(broadcastStoreReadOnly).toHaveBeenCalledWith(false);
  });

  it("no-op when already writable: 200 without re-persisting", async () => {
    reclaimStoreLock.mockResolvedValue({ ok: true, reclaimed: false });

    const res = await request(buildApp());
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ data: { reclaimed: false } });
    expect(persistSnapshot).not.toHaveBeenCalled();
    expect(broadcastStoreReadOnly).toHaveBeenCalledWith(false);
  });

  it("returns 409 LOCK_HELD with the user-facing message when the lock is genuinely held", async () => {
    reclaimStoreLock.mockResolvedValue({
      ok: false,
      message: 'The lock is held by a running process ("node", PID 1234) …',
    });

    const res = await request(buildApp());
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ error: "LOCK_HELD" });
    expect((res.body as { message: string }).message).toContain("PID 1234");
    expect(persistSnapshot).not.toHaveBeenCalled();
    expect(broadcastStoreReadOnly).not.toHaveBeenCalled();
  });
});
