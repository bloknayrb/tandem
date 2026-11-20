import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chat, requestFailure } from "../../src/server/local-model/ollama-client.js";
import { type StubModel, startStubModel } from "../e2e/local-model-stub.js";

/**
 * The E2E stub model server (`tests/e2e/local-model-stub.ts`, #1123 PR 8b)
 * against the REAL local-model client. The specs that use the stub run only
 * with `BYO_MODELS_ENABLED` on, so if the stub's frames drifted from what
 * `ollama-client.ts` parses, only the advisory lit job would notice. This file
 * is flag-neutral (`chat()` is not gated) and runs in `check`.
 */

let stub: StubModel;

beforeAll(async () => {
  stub = await startStubModel();
});

afterAll(async () => {
  await stub.close();
});

const config = () => ({ endpoint: stub.url, modelId: "stub-model", transport: "v1" as const });

describe("the E2E stub model server speaks what the local-model client reads", () => {
  it("binds 127.0.0.1 on an OS-chosen port", () => {
    expect(stub.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
  });

  it("streams a reply the client reads as plain text, with no tool call", async () => {
    stub.setMode({ kind: "reply", text: "streamed hello" });
    const deltas: string[] = [];
    const before = stub.requests.length;
    const res = await chat({
      config: config(),
      messages: [{ role: "user", content: "say hello" }],
      tools: [],
      onContentDelta: (d) => deltas.push(d),
    });
    expect(res.content).toBe("streamed hello");
    expect(res.toolCalls).toEqual([]);
    expect(deltas.join("")).toBe("streamed hello");
    const [req] = stub.requests.slice(before);
    expect(req.method).toBe("POST");
    expect(req.path).toBe("/v1/chat/completions");
    expect((req.body as { model: string; stream: boolean }).model).toBe("stub-model");
    expect((req.body as { stream: boolean }).stream).toBe(true);
  });

  it("answers a non-streaming request with the same text", async () => {
    stub.setMode({ kind: "reply", text: "plain hello" });
    const res = await chat({
      config: config(),
      messages: [{ role: "user", content: "say hello" }],
      tools: [],
    });
    expect(res.content).toBe("plain hello");
  });

  it("answers the status it is set to, which the client tags by that status", async () => {
    // The tag is what picks the user-facing text (`runFailureCause` in
    // collaborator.ts: an http 404 is "not-found"), which the E2E spec asserts.
    stub.setMode({ kind: "status", code: 404 });
    const err = await chat({
      config: config(),
      messages: [{ role: "user", content: "x" }],
      tools: [],
      onContentDelta: () => {},
    }).catch((e: unknown) => e);
    expect(requestFailure(err)).toEqual({ kind: "http", status: 404 });
  });
});
