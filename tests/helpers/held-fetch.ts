/**
 * A `fetch` stub whose answers are held open and released by hand — no sleeps
 * (#1123 part B's chat-answerer tests). Each call is recorded with its URL,
 * method and JSON body; `answer` resolves it, `fail` rejects it at the network
 * level, `timeout` rejects it as `AbortSignal.timeout` does.
 */
import { tick } from "svelte";
import { expect, vi } from "vitest";

export interface HeldCall {
  url: string;
  method: string;
  body?: unknown;
  answer: (status: number, body: unknown) => Promise<void>;
  fail: () => Promise<void>;
  timeout: () => Promise<void>;
}

/** Enough microtask turns for a promise continuation chain to run out. */
export async function drain(): Promise<void> {
  for (let i = 0; i < 60; i++) await Promise.resolve();
  await tick();
}

export function installHeldFetch(): {
  calls: HeldCall[];
  request: (n: number) => Promise<HeldCall>;
} {
  const calls: HeldCall[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn((url: string, init?: RequestInit) => {
      return new Promise<Response>((resolve, reject) => {
        calls.push({
          url: String(url),
          method: init?.method ?? "GET",
          ...(typeof init?.body === "string" ? { body: JSON.parse(init.body) as unknown } : {}),
          answer: async (status, body) => {
            resolve(
              new Response(JSON.stringify(body), {
                status,
                headers: { "Content-Type": "application/json" },
              }),
            );
            await drain();
          },
          fail: async () => {
            reject(new TypeError("fetch failed"));
            await drain();
          },
          timeout: async () => {
            reject(new DOMException("The operation timed out.", "TimeoutError"));
            await drain();
          },
        });
      });
    }),
  );
  return {
    calls,
    request: async (n: number) => {
      await vi.waitFor(() => expect(calls.length).toBeGreaterThanOrEqual(n));
      return calls[n - 1] as HeldCall;
    },
  };
}
