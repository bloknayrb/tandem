import http from "node:http";
import type { AddressInfo } from "node:net";

/**
 * A stub OpenAI-compatible model server for the local-model E2E specs (#1123
 * PR 8b; ADR-039's amendment on E2E against a stubbed local model). CI cannot
 * host a real model, and the model call is the SERVER's (the E2E backend
 * calls `POST {endpoint}/v1/chat/completions` for every local provider), so
 * `page.route` cannot answer it: this listens on a real loopback port instead.
 *
 * Bound to `127.0.0.1` on port 0, so the OS picks a free port: never
 * `localhost` (which may resolve to another interface), never a harness or
 * product port (`scripts/test-ports.ts`). It speaks only the `v1` shape the
 * local-model client sends, and has no tool-call mode (Ruling R-e5): a reply
 * is plain assistant text, which ends the client's turn.
 *
 * The frames are those `handleV1Line` in `src/server/local-model/ollama-client.ts`
 * reads: `data: {json}` lines carrying `choices[0].delta.content`, a final
 * frame with `finish_reason: "stop"`, then `data: [DONE]`.
 * `tests/scripts/e2e-local-model-stub.test.ts` drives the real client against
 * this stub in `check`, so the two cannot drift apart unnoticed while the
 * specs that use it are skipped dark.
 */

export type StubMode = { kind: "reply"; text: string } | { kind: "status"; code: number };

export interface StubRequest {
  method: string;
  path: string;
  /** The parsed JSON body, or the raw text when it was not JSON. */
  body: unknown;
}

export interface StubModel {
  /** `http://127.0.0.1:<port>`: what an entry's Endpoint is set to. */
  url: string;
  /** Every request received, in order. Read with `expect.poll`. */
  requests: StubRequest[];
  setMode(mode: StubMode): void;
  close(): Promise<void>;
}

const COMPLETIONS = "/v1/chat/completions";

function frame(payload: unknown): string {
  return `data: ${JSON.stringify(payload)}\n\n`;
}

export async function startStubModel(): Promise<StubModel> {
  const requests: StubRequest[] = [];
  let mode: StubMode = { kind: "status", code: 503 };

  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf-8");
      let body: unknown = raw;
      try {
        body = raw === "" ? null : JSON.parse(raw);
      } catch {
        // Kept as text: a test can still see what arrived.
      }
      const path = new URL(req.url ?? "/", "http://127.0.0.1").pathname;
      requests.push({ method: req.method ?? "", path, body });

      if (req.method !== "POST" || path !== COMPLETIONS) {
        res.writeHead(404, { "content-type": "application/json" });
        res.end("{}");
        return;
      }
      if (mode.kind === "status") {
        res.writeHead(mode.code, { "content-type": "application/json" });
        res.end("{}");
        return;
      }
      const stream = (body as { stream?: unknown } | null)?.stream === true;
      if (!stream) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            choices: [
              {
                index: 0,
                message: { role: "assistant", content: mode.text },
                finish_reason: "stop",
              },
            ],
          }),
        );
        return;
      }
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
      res.write(
        frame({ choices: [{ index: 0, delta: { role: "assistant", content: mode.text } }] }),
      );
      res.write(frame({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }));
      res.end("data: [DONE]\n\n");
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const { port } = server.address() as AddressInfo;

  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    setMode(next) {
      mode = next;
    },
    close() {
      return new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      });
    },
  };
}

/** The text of every user message in a recorded completions request. */
export function userTexts(request: StubRequest): string[] {
  const messages = (request.body as { messages?: Array<{ role?: string; content?: unknown }> })
    ?.messages;
  if (!Array.isArray(messages)) return [];
  return messages
    .filter((m) => m?.role === "user" && typeof m.content === "string")
    .map((m) => m.content as string);
}
