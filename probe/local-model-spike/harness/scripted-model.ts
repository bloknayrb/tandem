/**
 * A scripted stand-in for a model server's RESPONSES, for the dry run and the
 * fingerprint capture. It answers the shipped client's requests with streamed
 * frames written in advance; it sends nothing and decides nothing about what
 * the product asks for.
 *
 * Frames are the OpenAI-compatible streaming shape the shipped client reads
 * (`data: {…}` lines, then `data: [DONE]`).
 */

export interface ScriptedToolCall {
  id: string;
  name: string;
  /** Arguments as an object, or raw text to send as-is (for a malformed call). */
  args: Record<string, unknown> | string;
}

export interface ScriptedTurn {
  /** Content deltas, in order. */
  content?: string[];
  toolCalls?: ScriptedToolCall[];
  /** Extra raw JSON frames to put before the content (reasoning fields, an error frame, usage). */
  extraFrames?: unknown[];
  /** Answer with this HTTP status and no stream. */
  status?: number;
  /** Reject the request as a connection failure would. */
  connectionError?: string;
  /** Answer 200, send these chunks (none when empty), then send nothing more
   *  and never close: a server that accepted the request and went quiet. The
   *  body errors only when the request's own signal aborts, as a real one does. */
  hang?: string[];
  /** Called when the request arrives, before any frame is sent. */
  onRequest?: (body: Record<string, unknown>) => void;
}

export interface ScriptedCall {
  url: string;
  body: Record<string, unknown>;
  init: RequestInit | undefined;
}

function frame(payload: unknown): string {
  return `data: ${JSON.stringify(payload)}\n\n`;
}

/** The streamed frames for one scripted turn. */
export function framesFor(turn: ScriptedTurn): string[] {
  const frames: string[] = [];
  for (const extra of turn.extraFrames ?? []) frames.push(frame(extra));
  for (const delta of turn.content ?? []) {
    frames.push(frame({ choices: [{ delta: { content: delta } }] }));
  }
  (turn.toolCalls ?? []).forEach((tc, index) => {
    frames.push(
      frame({
        choices: [
          {
            delta: {
              tool_calls: [
                {
                  index,
                  id: tc.id,
                  function: {
                    name: tc.name,
                    arguments: typeof tc.args === "string" ? tc.args : JSON.stringify(tc.args),
                  },
                },
              ],
            },
          },
        ],
      }),
    );
  });
  frames.push("data: [DONE]\n\n");
  return frames;
}

/** A streaming Response made of these chunks. */
export function streamOf(chunks: string[]): Response {
  const enc = new TextEncoder();
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        for (const c of chunks) controller.enqueue(enc.encode(c));
        controller.close();
      },
    }),
    { status: 200, headers: { "content-type": "text/event-stream" } },
  );
}

/** A 200 streaming Response that sends `chunks` and then hangs until `signal` aborts. */
function hangingStream(chunks: string[], signal: AbortSignal | undefined): Response {
  const enc = new TextEncoder();
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        for (const c of chunks) controller.enqueue(enc.encode(c));
        const fail = () =>
          controller.error(signal?.reason ?? new DOMException("This operation was aborted", "AbortError"));
        if (signal?.aborted) fail();
        else signal?.addEventListener("abort", fail, { once: true });
      },
    }),
    { status: 200, headers: { "content-type": "text/event-stream" } },
  );
}

/**
 * A `fetch` that answers chat requests from `script`: an array used in order
 * (the last entry repeats), or a function of the request's index.
 */
export function scriptedFetch(
  script: ScriptedTurn[] | ((index: number, body: Record<string, unknown>) => ScriptedTurn),
): { fetch: typeof fetch; calls: ScriptedCall[] } {
  const calls: ScriptedCall[] = [];
  const impl = async (
    input: Parameters<typeof fetch>[0],
    init?: Parameters<typeof fetch>[1],
  ): Promise<Response> => {
    const url =
      typeof input === "string" ? input : input instanceof URL ? input.href : (input as Request).url;
    const body = JSON.parse(typeof init?.body === "string" ? init.body : "{}") as Record<
      string,
      unknown
    >;
    const index = calls.length;
    calls.push({ url, body, init });
    const turn =
      typeof script === "function"
        ? script(index, body)
        : (script[Math.min(index, script.length - 1)] ?? {});
    turn.onRequest?.(body);
    if (turn.connectionError !== undefined) {
      const err = new TypeError("fetch failed") as TypeError & { cause?: unknown };
      err.cause = { code: turn.connectionError };
      throw err;
    }
    if (turn.status !== undefined && turn.status !== 200) {
      return new Response("scripted error body", { status: turn.status });
    }
    if (turn.hang !== undefined) return hangingStream(turn.hang, init?.signal ?? undefined);
    return streamOf(framesFor(turn));
  };
  return { fetch: impl as typeof fetch, calls };
}
