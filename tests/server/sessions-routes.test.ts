/**
 * Route-level tests for the persisted-session management routes (#103):
 * `GET /api/sessions`, `POST /api/sessions/delete`, `POST /api/sessions/clear`.
 *
 * Exercises the read-only list happy path and the mutating-route origin gate
 * (`assertOriginAllowlisted`) — a non-allowlisted Origin must be rejected with
 * 403 before any state change.
 */
import express, { type Express } from "express";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  API_SESSIONS,
  API_SESSIONS_CLEAR,
  API_SESSIONS_DELETE,
} from "../../src/shared/api-paths.js";
import { TAURI_HOSTNAME } from "../../src/shared/constants.js";

const listSessionsMetadata = vi.fn();
const deleteSession = vi.fn();
const clearAllSessions = vi.fn();
const isStoreReadOnly = vi.fn(() => false);
const isLoopbackMock = vi.fn(() => true);

vi.mock("../../src/server/session/manager.js", () => ({
  listSessionsMetadata: () => listSessionsMetadata(),
  deleteSession: (p: string) => deleteSession(p),
  clearAllSessions: () => clearAllSessions(),
}));

vi.mock("../../src/server/annotations/store.js", () => ({
  isStoreReadOnly: () => isStoreReadOnly(),
}));

// Allow tests to simulate non-loopback callers for path-stripping coverage.
vi.mock("../../src/server/auth/middleware.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../../src/server/auth/middleware.js")>();
  return { ...original, isLoopback: (...args: unknown[]) => isLoopbackMock(...args) };
});

import {
  handleClearSessions,
  handleDeleteSession,
  handleListSessions,
} from "../../src/server/mcp/routes/sessions.js";

function buildApp(): Express {
  const app = express();
  app.use(express.json());
  app.get(API_SESSIONS, handleListSessions);
  app.post(API_SESSIONS_DELETE, handleDeleteSession);
  app.post(API_SESSIONS_CLEAR, handleClearSessions);
  return app;
}

async function request(
  app: Express,
  method: "GET" | "POST",
  url: string,
  body?: unknown,
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
        const headers: Record<string, string> = {
          Origin: `http://${TAURI_HOSTNAME}`,
          ...(body !== undefined ? { "content-type": "application/json" } : {}),
          ...(extraHeaders ?? {}),
        };
        const res = await fetch(`http://127.0.0.1:${address.port}${url}`, {
          method,
          headers,
          body: body !== undefined ? JSON.stringify(body) : undefined,
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

describe("session management routes (#103)", () => {
  beforeEach(() => {
    listSessionsMetadata.mockReset();
    deleteSession.mockReset();
    clearAllSessions.mockReset();
    isStoreReadOnly.mockReset();
    isStoreReadOnly.mockReturnValue(false);
    isLoopbackMock.mockReset();
    isLoopbackMock.mockReturnValue(true);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("GET /api/sessions returns the session list", async () => {
    listSessionsMetadata.mockResolvedValue([
      { filePath: "/tmp/a.md", lastAccessed: 100, annotationCount: 2 },
    ]);
    const res = await request(buildApp(), "GET", API_SESSIONS);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      data: { sessions: [{ filePath: "/tmp/a.md", lastAccessed: 100, annotationCount: 2 }] },
    });
  });

  it("POST /api/sessions/delete deletes a session by path", async () => {
    deleteSession.mockResolvedValue(undefined);
    const res = await request(buildApp(), "POST", API_SESSIONS_DELETE, { filePath: "/tmp/a.md" });
    expect(res.status).toBe(200);
    expect(deleteSession).toHaveBeenCalledWith("/tmp/a.md");
  });

  it("POST /api/sessions/delete rejects a missing filePath", async () => {
    const res = await request(buildApp(), "POST", API_SESSIONS_DELETE, {});
    expect(res.status).toBe(400);
    expect(deleteSession).not.toHaveBeenCalled();
  });

  it("POST /api/sessions/delete rejects a non-allowlisted Origin before mutating", async () => {
    const res = await request(
      buildApp(),
      "POST",
      API_SESSIONS_DELETE,
      { filePath: "/tmp/a.md" },
      {
        Origin: "http://attacker.example",
      },
    );
    expect(res.status).toBe(403);
    expect(deleteSession).not.toHaveBeenCalled();
  });

  it("POST /api/sessions/clear clears all sessions", async () => {
    clearAllSessions.mockResolvedValue(3);
    const res = await request(buildApp(), "POST", API_SESSIONS_CLEAR, {});
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ data: { cleared: 3 } });
    expect(clearAllSessions).toHaveBeenCalled();
  });

  it("POST /api/sessions/clear rejects a non-allowlisted Origin before mutating", async () => {
    const res = await request(
      buildApp(),
      "POST",
      API_SESSIONS_CLEAR,
      {},
      {
        Origin: "http://attacker.example",
      },
    );
    expect(res.status).toBe(403);
    expect(clearAllSessions).not.toHaveBeenCalled();
  });

  it("POST /api/sessions/clear refuses in read-only mode", async () => {
    isStoreReadOnly.mockReturnValue(true);
    const res = await request(buildApp(), "POST", API_SESSIONS_CLEAR, {});
    expect(res.status).toBe(403);
    expect(clearAllSessions).not.toHaveBeenCalled();
  });

  it("GET /api/sessions strips filePath to basename for non-loopback callers (#1121 F5)", async () => {
    isLoopbackMock.mockReturnValue(false);
    listSessionsMetadata.mockResolvedValue([
      { filePath: "/home/user/Documents/work.md", lastAccessed: 100, annotationCount: 2 },
    ]);
    const res = await request(buildApp(), "GET", API_SESSIONS);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      data: {
        sessions: [{ filePath: "work.md", lastAccessed: 100, annotationCount: 2 }],
      },
    });
  });

  it("GET /api/sessions returns full filePath for loopback callers", async () => {
    isLoopbackMock.mockReturnValue(true);
    listSessionsMetadata.mockResolvedValue([
      { filePath: "/home/user/Documents/work.md", lastAccessed: 100, annotationCount: 2 },
    ]);
    const res = await request(buildApp(), "GET", API_SESSIONS);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      data: {
        sessions: [
          { filePath: "/home/user/Documents/work.md", lastAccessed: 100, annotationCount: 2 },
        ],
      },
    });
  });
});
