/**
 * The fetch tap: an OBSERVER of the shipped chat client's traffic.
 *
 * It wraps `globalThis.fetch`, passes every call through untouched, and for the
 * two chat paths reads a `clone()` of the response beside the product's own
 * read. It builds no request and changes none: what the product sends and what
 * the product receives are exactly what they would be without it. That is why
 * it is exempt, by name, from the "harness defines no chat request" source pin
 * (`tests/server/local-model/harness/source-pin.test.ts`).
 *
 * What it is for (brief R2.6, R2.7, R3.4): the shipped client keeps only
 * `content` and tool calls, so three things a measurement needs are invisible
 * in the loop's result — reasoning that came back in a separate field, an error
 * frame inside a stream that still ended cleanly, and the prompt token count.
 *
 * The field names below are ASSUMED, not verified against a real server (this
 * was built with no model): `reasoning`, `reasoning_content` and `thinking` on
 * a v1 delta or message, `thinking` on a native message, a top-level `error`,
 * `usage.prompt_tokens` (v1) and `prompt_eval_count` (native).
 */

/** The two paths the shipped client posts chat to. Read-only knowledge of where
 *  to look, not a request: the tap never issues a call to either. */
const CHAT_PATH_SUFFIXES = ["/v1/chat/completions", "/api/chat"] as const;

/** Stop reading a clone after this much, so a runaway stream the product has
 *  already cut cannot keep the tap reading for ever. Above the product's cap. */
const TAP_READ_CAP_BYTES = 8 * 1024 * 1024;

export interface TapRecord {
  /** Path only: the endpoint is the developer's own loopback address. */
  path: string;
  /** The JSON body the product sent, parsed, or null when it was not JSON. */
  requestBody: Record<string, unknown> | null;
  /** Length in characters of the body the product sent. */
  requestChars: number;
  /** HTTP status, or null when `fetch` threw before a response. */
  status: number | null;
  /** `fetch` rejected before a response: the error's name, message and cause code. */
  thrown: { name: string; message: string; code: string | null } | null;
  /** Characters of reasoning seen in a separate field of the raw response. */
  separateReasoningChars: number;
  /** A frame carried a top-level `error`. */
  errorFrame: boolean;
  /** Prompt token count the server reported, when it reported one. */
  promptTokens: number | null;
  /** The clone could not be read to its end (aborted, errored, or over the tap's cap). */
  readIncomplete: boolean;
}

export interface FetchTap {
  records: TapRecord[];
  /** Wait for every clone read to finish (bounded), then stop observing. */
  settle: (waitMs?: number) => Promise<void>;
  /** Put the previous `fetch` back. Idempotent. */
  restore: () => void;
}

function isChatUrl(url: string): string | null {
  let pathname: string;
  try {
    pathname = new URL(url).pathname;
  } catch {
    return null;
  }
  return CHAT_PATH_SUFFIXES.some((s) => pathname.endsWith(s)) ? pathname : null;
}

function asRecord(v: unknown): Record<string, unknown> | null {
  return typeof v === "object" && v !== null && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : null;
}

function stringLength(v: unknown): number {
  return typeof v === "string" ? v.length : 0;
}

const REASONING_FIELDS = ["reasoning", "reasoning_content", "thinking"] as const;

/** Fold one parsed frame (or whole JSON body) into the record. */
function observeFrame(frame: Record<string, unknown>, rec: TapRecord): void {
  if (frame.error !== undefined && frame.error !== null) rec.errorFrame = true;

  const usage = asRecord(frame.usage);
  if (usage && typeof usage.prompt_tokens === "number") rec.promptTokens = usage.prompt_tokens;
  if (typeof frame.prompt_eval_count === "number") rec.promptTokens = frame.prompt_eval_count;

  const carriers: (Record<string, unknown> | null)[] = [asRecord(frame.message)];
  if (Array.isArray(frame.choices)) {
    for (const choice of frame.choices) {
      const c = asRecord(choice);
      carriers.push(asRecord(c?.delta), asRecord(c?.message));
    }
  }
  for (const carrier of carriers) {
    if (!carrier) continue;
    for (const field of REASONING_FIELDS) rec.separateReasoningChars += stringLength(carrier[field]);
  }
}

function observeLine(line: string, rec: TapRecord): void {
  let text = line.trim();
  if (text === "" || text.startsWith(":")) return;
  if (text.startsWith("data:")) text = text.slice("data:".length).trim();
  if (text === "[DONE]") return;
  try {
    const parsed = asRecord(JSON.parse(text));
    if (parsed) observeFrame(parsed, rec);
  } catch {
    // Not JSON: nothing to observe. The product decides what that means.
  }
}

async function readClone(
  clone: Response,
  rec: TapRecord,
  open: Map<ReadableStreamDefaultReader<Uint8Array>, TapRecord>,
): Promise<void> {
  const body = clone.body;
  if (!body) return;
  const reader = body.getReader();
  open.set(reader, rec);
  const decoder = new TextDecoder("utf-8");
  let buffered = "";
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > TAP_READ_CAP_BYTES) {
        rec.readIncomplete = true;
        await reader.cancel().catch(() => {});
        return;
      }
      buffered += decoder.decode(value, { stream: true });
      let nl = buffered.indexOf("\n");
      while (nl !== -1) {
        observeLine(buffered.slice(0, nl), rec);
        buffered = buffered.slice(nl + 1);
        nl = buffered.indexOf("\n");
      }
    }
    buffered += decoder.decode();
    if (buffered.trim().length > 0) observeLine(buffered, rec);
  } catch {
    rec.readIncomplete = true;
  } finally {
    open.delete(reader);
  }
}

/**
 * Start observing. Wraps whatever `globalThis.fetch` is NOW (in the dry run
 * that is the scripted stub), so install it after any stub and restore it
 * before the stub is removed.
 */
export function installFetchTap(): FetchTap {
  const previous = globalThis.fetch;
  const records: TapRecord[] = [];
  const pending: Promise<void>[] = [];
  /** Each clone still being read, with the record it belongs to. */
  const open = new Map<ReadableStreamDefaultReader<Uint8Array>, TapRecord>();
  let restored = false;

  const tapped = async (
    input: Parameters<typeof fetch>[0],
    init?: Parameters<typeof fetch>[1],
  ): Promise<Response> => {
    const url =
      typeof input === "string" ? input : input instanceof URL ? input.href : (input as Request).url;
    const path = isChatUrl(url);
    if (path === null) return previous(input, init);

    const bodyText = typeof init?.body === "string" ? init.body : "";
    let requestBody: Record<string, unknown> | null = null;
    try {
      requestBody = asRecord(JSON.parse(bodyText));
    } catch {
      requestBody = null;
    }
    const rec: TapRecord = {
      path,
      requestBody,
      requestChars: bodyText.length,
      status: null,
      thrown: null,
      separateReasoningChars: 0,
      errorFrame: false,
      promptTokens: null,
      readIncomplete: false,
    };
    records.push(rec);

    let res: Response;
    try {
      res = await previous(input, init);
    } catch (err) {
      const e = err as { name?: unknown; message?: unknown; cause?: { code?: unknown } };
      rec.thrown = {
        name: typeof e?.name === "string" ? e.name : "Error",
        message: typeof e?.message === "string" ? e.message : String(err),
        code: typeof e?.cause?.code === "string" ? e.cause.code : null,
      };
      throw err;
    }
    rec.status = res.status;
    if (res.ok && res.body) {
      let clone: Response | null = null;
      try {
        clone = res.clone();
      } catch {
        rec.readIncomplete = true;
      }
      if (clone) pending.push(readClone(clone, rec, open));
    }
    return res;
  };

  globalThis.fetch = tapped as typeof fetch;

  const restore = () => {
    if (restored) return;
    restored = true;
    if (globalThis.fetch === (tapped as typeof fetch)) globalThis.fetch = previous;
  };

  return {
    records,
    restore,
    settle: async (waitMs = 2000) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const all = Promise.allSettled(pending).then(() => undefined);
      const bound = new Promise<void>((resolve) => {
        timer = setTimeout(resolve, waitMs);
      });
      await Promise.race([all, bound]);
      if (timer) clearTimeout(timer);
      // The product has finished with its side of every response. A clone still
      // being read (the product cut a runaway stream at its cap and cancelled
      // only its own branch) would keep the connection, and the model's
      // generation, alive into the next trial: cancel it.
      // The record marked is the one that reader belongs to, so the
      // classifier sees which response was not read to its end.
      for (const [reader, rec] of [...open]) {
        rec.readIncomplete = true;
        await reader.cancel().catch(() => {});
      }
      restore();
    },
  };
}
