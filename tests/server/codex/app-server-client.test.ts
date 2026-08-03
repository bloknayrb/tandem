import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";

import { CodexAppServerClient } from "../../../src/codex-agent/app-server-client.js";

function fakeChild(onRequest: (message: Record<string, unknown>) => unknown) {
  const child = new EventEmitter() as ChildProcessWithoutNullStreams;
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = vi.fn(() => true);
  const sent: Record<string, unknown>[] = [];
  let buffer = "";
  child.stdin.setEncoding("utf8");
  child.stdin.on("data", (chunk: string) => {
    buffer += chunk;
    let newline: number;
    while ((newline = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      const message = JSON.parse(line) as Record<string, unknown>;
      sent.push(message);
      if (typeof message.id === "number") {
        const result = onRequest(message);
        child.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: message.id, result })}\n`);
      }
    }
  });
  return { child, sent };
}

describe("CodexAppServerClient", () => {
  it("initializes a workspace-write thread and wraps Tandem events as untrusted data", async () => {
    const { child, sent } = fakeChild((message) => {
      if (message.method === "initialize") return {};
      if (message.method === "thread/start") return { thread: { id: "thread-1" } };
      if (message.method === "turn/start") return { turn: { id: "turn-1" } };
      return {};
    });
    const client = new CodexAppServerClient({
      cwd: "C:/repo",
      spawnProcess: () => child,
    });

    await client.initialize();
    await client.enqueueEvent({ type: "document_changed", documentId: "doc-1" });

    const threadStart = sent.find((message) => message.method === "thread/start");
    expect(threadStart?.params).toMatchObject({
      cwd: "C:/repo",
      approvalPolicy: "on-request",
      sandbox: "workspace-write",
    });
    const turnStart = sent.find((message) => message.method === "turn/start");
    expect(JSON.stringify(turnStart)).toContain("untrusted data");
    expect(JSON.stringify(turnStart)).toContain("tandem_checkInbox");
  });

  it("routes app-server command approvals through the supplied callback", async () => {
    const requestApproval = vi.fn(async () => ({ decision: "accept" }));
    const { child, sent } = fakeChild((message) => {
      if (message.method === "initialize") return {};
      if (message.method === "thread/start") return { thread: { id: "thread-1" } };
      return {};
    });
    const client = new CodexAppServerClient({
      cwd: "C:/repo",
      spawnProcess: () => child,
      requestApproval,
    });
    await client.initialize();

    child.stdout.write(
      `${JSON.stringify({
        jsonrpc: "2.0",
        id: "approval-99",
        method: "item/commandExecution/requestApproval",
        params: { command: "npm test" },
      })}\n`,
    );
    await vi.waitFor(() => expect(requestApproval).toHaveBeenCalledOnce());
    await vi.waitFor(() =>
      expect(sent).toContainEqual({
        jsonrpc: "2.0",
        id: "approval-99",
        result: { decision: "accept" },
      }),
    );
  });

  it("declines legacy approvals with the legacy response shape when no broker is available", async () => {
    const { child, sent } = fakeChild((message) => {
      if (message.method === "initialize") return {};
      if (message.method === "thread/start") return { thread: { id: "thread-1" } };
      return {};
    });
    const client = new CodexAppServerClient({
      cwd: "C:/repo",
      spawnProcess: () => child,
    });
    await client.initialize();

    child.stdout.write(
      `${JSON.stringify({ jsonrpc: "2.0", id: 100, method: "execCommandApproval", params: {} })}\n`,
    );

    await vi.waitFor(() =>
      expect(sent).toContainEqual({
        jsonrpc: "2.0",
        id: 100,
        result: {
          decision: { denied: { rejection: "Tandem approval unavailable" } },
        },
      }),
    );
  });

  it("fails closed with protocol-valid responses for unsupported interactive requests", async () => {
    const { child, sent } = fakeChild((message) => {
      if (message.method === "initialize") return {};
      if (message.method === "thread/start") return { thread: { id: "thread-1" } };
      return {};
    });
    const client = new CodexAppServerClient({
      cwd: "C:/repo",
      spawnProcess: () => child,
    });
    await client.initialize();

    child.stdout.write(
      `${JSON.stringify({
        jsonrpc: "2.0",
        id: "permissions-1",
        method: "item/permissions/requestApproval",
        params: {},
      })}\n`,
    );
    child.stdout.write(
      `${JSON.stringify({
        jsonrpc: "2.0",
        id: "elicitation-1",
        method: "mcpServer/elicitation/request",
        params: {},
      })}\n`,
    );

    await vi.waitFor(() =>
      expect(sent).toContainEqual({
        jsonrpc: "2.0",
        id: "permissions-1",
        result: { permissions: {}, scope: "turn" },
      }),
    );
    await vi.waitFor(() =>
      expect(sent).toContainEqual({
        jsonrpc: "2.0",
        id: "elicitation-1",
        result: { action: "decline", content: null, _meta: null },
      }),
    );
  });

  it("resumes the persisted thread and records the returned thread id", async () => {
    const onThreadId = vi.fn(async () => {});
    const { child, sent } = fakeChild((message) => {
      if (message.method === "initialize") return {};
      if (message.method === "thread/resume") return { thread: { id: "thread-restored" } };
      return {};
    });
    const client = new CodexAppServerClient({
      cwd: "C:/repo",
      initialThreadId: "thread-old",
      onThreadId,
      spawnProcess: () => child,
    });

    await client.initialize();

    expect(sent.find((message) => message.method === "thread/resume")?.params).toMatchObject({
      threadId: "thread-old",
      cwd: "C:/repo",
      approvalPolicy: "on-request",
      sandbox: "workspace-write",
    });
    expect(sent.some((message) => message.method === "thread/start")).toBe(false);
    expect(onThreadId).toHaveBeenCalledWith("thread-restored");
  });

  it("reports unexpected app-server loss so the supervisor can restart the worker", async () => {
    const onFatal = vi.fn();
    const { child } = fakeChild((message) => {
      if (message.method === "initialize") return {};
      if (message.method === "thread/start") return { thread: { id: "thread-1" } };
      return {};
    });
    const client = new CodexAppServerClient({
      cwd: "C:/repo",
      spawnProcess: () => child,
      onFatal,
    });
    await client.initialize();

    child.emit("exit", 1, null);

    expect(onFatal).toHaveBeenCalledOnce();
    expect(onFatal).toHaveBeenCalledWith(
      expect.objectContaining({ message: "Codex app-server exited" }),
    );
  });
});
