// tests/monitor/fetch-harness.ts
import { vi } from "vitest";

/**
 * A controllable SSE stream. Test code calls .push() to emit bytes,
 * .end() to signal done, or .error(err) to reject the next read.
 */
export class ControllableStream {
  private controller: ReadableStreamDefaultController<Uint8Array> | null = null;
  public readonly stream: ReadableStream<Uint8Array>;
  private encoder = new TextEncoder();

  constructor() {
    this.stream = new ReadableStream<Uint8Array>({
      start: (c) => {
        this.controller = c;
      },
    });
  }
  push(text: string) {
    this.controller?.enqueue(this.encoder.encode(text));
  }
  end() {
    this.controller?.close();
  }
  error(err: Error) {
    this.controller?.error(err);
  }
}

/**
 * Per-URL fetch behavior. Test code registers handlers keyed by URL
 * substring; unmatched URLs throw to fail loudly.
 */
export interface FetchHandler {
  (url: string, init?: RequestInit): Promise<Response> | Response;
}

export interface FetchStub {
  on(urlSubstr: string, handler: FetchHandler): void;
  /** Array of {url, init} for every fetch made. */
  readonly calls: Array<{ url: string; init?: RequestInit }>;
  install(): void;
  restore(): void;
}

export function createFetchStub(): FetchStub {
  const handlers: Array<{ url: string; handler: FetchHandler }> = [];
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  let original: typeof fetch | undefined;

  const stubFn: typeof fetch = async (input, init) => {
    const url =
      typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    calls.push({ url, init });
    for (const { url: match, handler } of handlers) {
      if (url.includes(match)) {
        return handler(url, init);
      }
    }
    throw new Error(`[fetch-harness] Unhandled fetch: ${url}`);
  };

  return {
    calls,
    on(urlSubstr, handler) {
      handlers.push({ url: urlSubstr, handler });
    },
    install() {
      original = globalThis.fetch;
      vi.stubGlobal("fetch", stubFn);
    },
    restore() {
      if (original !== undefined) {
        vi.stubGlobal("fetch", original);
      }
    },
  };
}

/** Build a Response whose body is a ControllableStream. */
export function sseResponse(stream: ControllableStream, init?: ResponseInit): Response {
  return new Response(stream.stream, {
    status: 200,
    headers: { "Content-Type": "text/event-stream" },
    ...init,
  });
}

/** Frame helper: wrap a TandemEvent object into SSE wire format. */
export function sseFrame(event: unknown, id?: string): string {
  const parts: string[] = [];
  if (id) parts.push(`id: ${id}`);
  parts.push(`data: ${JSON.stringify(event)}`);
  return parts.join("\n") + "\n\n";
}

/**
 * Install fake timers with the faking surface the monitor tests need.
 * Explicitly opts into faking setTimeout, clearTimeout, setInterval,
 * clearInterval, Date, and performance. AbortSignal.timeout is built
 * on setTimeout, so this is enough to fake it. Also keeps queueMicrotask
 * real so awaited .catch() chains resolve predictably.
 */
export function installMonitorFakeTimers(): void {
  vi.useFakeTimers({
    toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date", "performance"],
  });
}
