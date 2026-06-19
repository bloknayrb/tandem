/**
 * Local-model chat client (#1123 M1, ADR-039) — productionized from the M0
 * spike's `probe/local-model-spike/ollama.ts`.
 *
 * Two transports, normalized to one `{content, toolCalls}` shape so the loop is
 * transport-agnostic:
 *  - "v1":     OpenAI-compatible POST {endpoint}/v1/chat/completions
 *  - "native": Ollama-native       POST {endpoint}/api/chat
 *
 * Hardening beyond the harness (security review #1123):
 *  - endpoint comes from config, validated to loopback at the fetch boundary
 *    (validate-at-use, not just at config time);
 *  - `redirect: "error"` — a 3xx must not be followed off the loopback host;
 *  - a mandatory bounded reader caps the response (content-length is untrusted);
 *  - the caller's AbortSignal is honored alongside the per-request timeout;
 *  - error bodies are kept on stderr, never folded into the thrown message that
 *    may later reach the UI (the message carries only the status class).
 *
 * No SDK, no deps — Node 22+ global fetch / web streams.
 */
import { type LocalModelConfig, type LocalModelTransport, validateEndpoint } from "./config.js";

export interface ToolSchema {
  name: string;
  description: string;
  parameters: Record<string, unknown>; // JSON Schema for the args object
}

export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  /** assistant turns may carry tool calls (echoed back on the next request) */
  tool_calls?: RawToolCall[];
  /** tool-result turns reference the call they answer */
  tool_call_id?: string;
  /** native transport keys tool results by name, not id */
  tool_name?: string;
}

export interface RawToolCall {
  id: string;
  name: string;
  /** parsed args, or null if JSON.parse failed (the loop records the fault) */
  args: Record<string, unknown> | null;
  rawArgs: string;
  parseError?: string;
}

export interface ChatResult {
  content: string;
  toolCalls: RawToolCall[];
  /** raw provider response, for diagnostics */
  raw: unknown;
  latencyMs: number;
}

/** "auto" lets the model decide; a {function} object FORCES that single tool. */
export type ToolChoice = "auto" | "none" | { type: "function"; function: { name: string } };

export interface ChatOpts {
  config: Pick<LocalModelConfig, "endpoint" | "modelId" | "transport">;
  messages: ChatMessage[];
  tools: ToolSchema[];
  temperature?: number;
  timeoutMs?: number;
  toolChoice?: ToolChoice;
  signal?: AbortSignal;
  /** response size ceiling; a hostile/buggy endpoint can lie about content-length. */
  maxResponseBytes?: number;
  /**
   * When provided (#1123 M1.2), the request streams (`stream:true`) and this is
   * invoked per assistant CONTENT delta as tokens arrive, while `chat()` still
   * returns the SAME accumulated `{content, toolCalls}` shape. Absent → the
   * non-streaming `stream:false` path runs verbatim (byte-identical wire body).
   */
  onContentDelta?: (delta: string) => void;
}

const DEFAULT_TIMEOUT_MS = 180_000;
const DEFAULT_MAX_RESPONSE_BYTES = 16 * 1024 * 1024; // 16 MB

let callCounter = 0;
function nextId(): string {
  callCounter += 1;
  return `call_${callCounter}`;
}

function parseArgs(raw: unknown): {
  args: Record<string, unknown> | null;
  rawArgs: string;
  parseError?: string;
} {
  if (raw == null) return { args: {}, rawArgs: "" };
  if (typeof raw === "object") {
    // native transport already gives an object
    return { args: raw as Record<string, unknown>, rawArgs: JSON.stringify(raw) };
  }
  const rawArgs = String(raw);
  try {
    return { args: JSON.parse(rawArgs), rawArgs };
  } catch (err) {
    return { args: null, rawArgs, parseError: err instanceof Error ? err.message : String(err) };
  }
}

/** Read a Response body to text with a hard byte ceiling, then return the text. */
async function readBoundedText(res: Response, capBytes: number): Promise<string> {
  const body = res.body;
  if (!body) return "";
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) {
        total += value.byteLength;
        if (total > capBytes) {
          await reader.cancel().catch(() => {});
          throw new Error(`local model response exceeded ${capBytes}-byte cap`);
        }
        chunks.push(value);
      }
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks).toString("utf8");
}

/**
 * POST JSON to a validated loopback URL with timeout + abort, then hand the OK
 * response to `consume`. Single-sources the loopback-security contract —
 * `redirect:"error"`, the dual-signal (caller + timeout) abort merge, and the
 * body-free HTTP-error redaction (raw body to stderr only) — so the streaming
 * (`fetchStream`) and non-streaming (`postJson`) callers can never drift. The
 * timeout timer is held across `consume` (a streamed read must run under it), so
 * the deadline bounds the whole request+read, not just the connect.
 */
async function postLoopback<T>(
  url: string,
  payload: unknown,
  opts: { timeoutMs: number; signal?: AbortSignal },
  consume: (res: Response) => Promise<T>,
): Promise<T> {
  const timeoutCtrl = new AbortController();
  const timer = setTimeout(() => timeoutCtrl.abort(), opts.timeoutMs);
  const signal = opts.signal
    ? AbortSignal.any([opts.signal, timeoutCtrl.signal])
    : timeoutCtrl.signal;
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
      // A redirect to a non-loopback host would defeat the allowlist — never follow.
      redirect: "error",
      signal,
    });
    if (!res.ok) {
      // Keep the raw body on stderr only; the thrown message carries only the
      // status class so it's safe if it later reaches the UI.
      const errBody = await readBoundedText(res, 4096).catch(() => "");
      if (errBody)
        console.error(`[local-model] endpoint ${res.status} body: ${errBody.slice(0, 300)}`);
      throw new Error(`local model endpoint returned HTTP ${res.status}`);
    }
    return await consume(res);
  } finally {
    clearTimeout(timer);
  }
}

/** POST JSON to a validated loopback URL with timeout + abort + bounded read. */
async function postJson(
  url: string,
  payload: unknown,
  opts: { timeoutMs: number; maxResponseBytes: number; signal?: AbortSignal },
): Promise<unknown> {
  return postLoopback(url, payload, opts, async (res) => {
    const text = await readBoundedText(res, opts.maxResponseBytes);
    try {
      return JSON.parse(text);
    } catch {
      // A 200 with a non-JSON body (a reverse-proxy HTML page, an NDJSON stream
      // from a server ignoring stream:false) is a distinct fault from a network
      // error — surface it as its own message so the loop doesn't bucket it as a
      // generic "error". Body-free on purpose: the raw text is a third-party
      // payload and a V8 parse error can embed a source snippet.
      throw new Error("local model returned a non-JSON response");
    }
  });
}

function toOpenAITools(tools: ToolSchema[]): unknown[] {
  return tools.map((t) => ({
    type: "function",
    function: { name: t.name, description: t.description, parameters: t.parameters },
  }));
}

function buildV1Body(
  model: string,
  messages: ChatMessage[],
  tools: ToolSchema[],
  temperature: number,
  toolChoice: ToolChoice,
  stream: boolean,
): unknown {
  return {
    model,
    messages: messages.map((m) => ({
      role: m.role,
      content: m.content,
      ...(m.tool_calls
        ? {
            tool_calls: m.tool_calls.map((tc) => ({
              id: tc.id,
              type: "function",
              function: { name: tc.name, arguments: tc.rawArgs || JSON.stringify(tc.args ?? {}) },
            })),
          }
        : {}),
      ...(m.tool_call_id ? { tool_call_id: m.tool_call_id } : {}),
    })),
    ...(tools.length ? { tools: toOpenAITools(tools), tool_choice: toolChoice } : {}),
    stream,
    temperature,
  };
}

function buildNativeBody(
  model: string,
  messages: ChatMessage[],
  tools: ToolSchema[],
  temperature: number,
  stream: boolean,
): unknown {
  return {
    model,
    messages: messages.map((m) => ({
      role: m.role,
      content: m.content,
      ...(m.tool_calls
        ? {
            tool_calls: m.tool_calls.map((tc) => ({
              function: { name: tc.name, arguments: tc.args ?? {} },
            })),
          }
        : {}),
      ...(m.tool_name ? { tool_name: m.tool_name } : {}),
    })),
    tools: toOpenAITools(tools),
    stream,
    options: { temperature },
  };
}

/** Trim trailing slashes so `${base}/v1/...` doesn't double up. */
function baseUrl(endpoint: string): string {
  return endpoint.replace(/\/+$/, "");
}

// ---------------------------------------------------------------------------
// Streaming (#1123 M1.2) — opt-in via ChatOpts.onContentDelta. Each invariant
// below is a verified silent-failure risk from the pre-code review, not
// boilerplate; see the plan §3.5b.
// ---------------------------------------------------------------------------

interface StreamAccum {
  content: string;
  /** v1: fragmented tool_call args keyed by the delta's OWN `index` (not array
   *  position — else two parallel calls cross-contaminate their argument JSON). */
  v1Tools: Map<number, { id?: string; name?: string; args: string }>;
  /** native: whole tool_call objects (args already an object). */
  nativeTools: { name: string; args: unknown }[];
  /** count of recognized protocol frames; 0 at stream end ⇒ not a real stream
   *  (e.g. a reverse-proxy HTML page) ⇒ the caller throws body-free. */
  validFrames: number;
}

function newStreamAccum(): StreamAccum {
  return { content: "", v1Tools: new Map(), nativeTools: [], validFrames: 0 };
}

/** Process one v1 SSE line. Returns true when the stream is done (`[DONE]`). */
function handleV1Line(
  line: string,
  acc: StreamAccum,
  onContentDelta?: (d: string) => void,
): boolean {
  const t = line.trim();
  if (t === "" || t.startsWith(":")) return false; // blank / SSE keep-alive comment
  if (!t.startsWith("data:")) return false; // unknown framing — skip, don't kill the turn
  const data = t.slice("data:".length).trim();
  if (data === "[DONE]") {
    acc.validFrames += 1;
    return true;
  }
  let parsed: {
    choices?: {
      delta?: {
        content?: string;
        tool_calls?: {
          index?: number;
          id?: string;
          function?: { name?: string; arguments?: string };
        }[];
      };
    }[];
  };
  try {
    parsed = JSON.parse(data);
  } catch {
    // A data: payload that SHOULD be JSON but isn't — an anomaly, not routine.
    // Body-free log + continue (review H2); never swallow a content line as "fine".
    console.error("[local-model] stream: unparseable v1 data frame");
    return false;
  }
  acc.validFrames += 1;
  const delta = parsed.choices?.[0]?.delta;
  if (delta?.content) {
    acc.content += delta.content;
    onContentDelta?.(delta.content);
  }
  if (Array.isArray(delta?.tool_calls)) {
    for (const tc of delta.tool_calls) {
      const idx = typeof tc.index === "number" ? tc.index : 0;
      const entry = acc.v1Tools.get(idx) ?? { args: "" };
      if (tc.id) entry.id = tc.id;
      if (tc.function?.name) entry.name = tc.function.name;
      if (typeof tc.function?.arguments === "string") entry.args += tc.function.arguments;
      acc.v1Tools.set(idx, entry);
    }
  }
  return false;
}

/** Process one native NDJSON line. Returns true when the stream is done. */
function handleNativeLine(
  line: string,
  acc: StreamAccum,
  onContentDelta?: (d: string) => void,
): boolean {
  const t = line.trim();
  if (t === "") return false;
  let parsed: {
    message?: {
      content?: string;
      tool_calls?: { function?: { name?: string; arguments?: unknown } }[];
    };
    done?: boolean;
  };
  try {
    parsed = JSON.parse(t);
  } catch {
    console.error("[local-model] stream: unparseable native NDJSON line");
    return false;
  }
  acc.validFrames += 1;
  const content = parsed.message?.content;
  if (typeof content === "string" && content.length > 0) {
    acc.content += content;
    onContentDelta?.(content);
  }
  if (Array.isArray(parsed.message?.tool_calls)) {
    for (const tc of parsed.message.tool_calls) {
      acc.nativeTools.push({ name: tc.function?.name ?? "", args: tc.function?.arguments });
    }
  }
  return parsed.done === true;
}

/**
 * Read a streamed response: a RAW-byte cap checked pre-decode (so a newline-less
 * flood can't grow the line buffer unbounded → OOM), ONE long-lived TextDecoder
 * (a multi-byte codepoint split across a chunk boundary must not decode to two
 * U+FFFDs), feeding each complete line to `onLine`. Stops on EOF or when
 * `onLine` reports done.
 */
async function readStream(
  res: Response,
  capBytes: number,
  onLine: (line: string) => boolean,
): Promise<void> {
  const body = res.body;
  if (!body) return;
  const reader = body.getReader();
  const decoder = new TextDecoder("utf-8");
  let lineBuffer = "";
  let rawBytes = 0;
  let done = false;
  try {
    while (!done) {
      const { done: streamDone, value } = await reader.read();
      if (streamDone) break;
      if (!value) continue;
      rawBytes += value.byteLength;
      if (rawBytes > capBytes) {
        await reader.cancel().catch(() => {});
        throw new Error(`local model response exceeded ${capBytes}-byte cap`);
      }
      lineBuffer += decoder.decode(value, { stream: true });
      let nl = lineBuffer.indexOf("\n");
      while (nl !== -1) {
        const line = lineBuffer.slice(0, nl);
        lineBuffer = lineBuffer.slice(nl + 1);
        if (onLine(line)) {
          done = true;
          break;
        }
        nl = lineBuffer.indexOf("\n");
      }
    }
    // Flush any trailing partial codepoint, then a final unterminated line.
    if (!done) {
      lineBuffer += decoder.decode();
      if (lineBuffer.length > 0) onLine(lineBuffer);
    }
  } finally {
    reader.releaseLock();
  }
}

/** POST JSON and read a streamed response. Reuses `postLoopback`, whose timer is
 *  held across the whole read (cleared only after the stream fully drains), so a
 *  provider that sends headers then stalls is still killed. */
async function fetchStream(
  url: string,
  payload: unknown,
  opts: { timeoutMs: number; maxResponseBytes: number; signal?: AbortSignal },
  onLine: (line: string) => boolean,
): Promise<void> {
  return postLoopback(url, payload, opts, (res) => readStream(res, opts.maxResponseBytes, onLine));
}

/** Streamed variant of `chat()` — same return shape, content delivered live via
 *  `onContentDelta`. Tool calls are accumulated and dispatched only once the
 *  turn completes (never partially). */
async function chatStreaming(
  opts: ChatOpts,
  ctx: {
    base: string;
    transport: LocalModelTransport;
    temperature: number;
    toolChoice: ToolChoice;
    timeoutMs: number;
    maxResponseBytes: number;
    started: number;
  },
): Promise<ChatResult> {
  const { config, messages, tools, signal, onContentDelta } = opts;
  const { base, transport, temperature, toolChoice, timeoutMs, maxResponseBytes, started } = ctx;
  const acc = newStreamAccum();
  const url = transport === "v1" ? `${base}/v1/chat/completions` : `${base}/api/chat`;
  const body =
    transport === "v1"
      ? buildV1Body(config.modelId, messages, tools, temperature, toolChoice, true)
      : buildNativeBody(config.modelId, messages, tools, temperature, true);
  const onLine =
    transport === "v1"
      ? (line: string) => handleV1Line(line, acc, onContentDelta)
      : (line: string) => handleNativeLine(line, acc, onContentDelta);

  await fetchStream(url, body, { timeoutMs, maxResponseBytes, signal }, onLine);

  // A 200 that produced zero recognizable frames (e.g. a reverse-proxy HTML
  // page despite stream:true) is a non-JSON response — body-free, like postJson.
  if (acc.validFrames === 0) throw new Error("local model returned a non-JSON response");

  const toolCalls: RawToolCall[] =
    transport === "v1"
      ? [...acc.v1Tools.entries()]
          .sort((a, b) => a[0] - b[0])
          .map(([, e]) => {
            // "" args (a no-param tool) parses like a missing field → {args:{}};
            // a malformed reassembled payload STILL yields {args:null,parseError}
            // so the loop's jsonParseFailures ledger stays honest (review C2).
            const { args, rawArgs, parseError } = parseArgs(e.args === "" ? null : e.args);
            return { id: e.id ?? nextId(), name: e.name ?? "", args, rawArgs, parseError };
          })
      : acc.nativeTools.map((tc) => {
          const { args, rawArgs, parseError } = parseArgs(tc.args);
          return { id: nextId(), name: tc.name, args, rawArgs, parseError };
        });

  return { content: acc.content, toolCalls, raw: null, latencyMs: Date.now() - started };
}

export async function chat(opts: ChatOpts): Promise<ChatResult> {
  const { config, messages, tools, temperature = 0.2, toolChoice = "auto", signal } = opts;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxResponseBytes = opts.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;

  // Validate-at-use: re-check the endpoint immediately before issuing the fetch,
  // so a config relocated server-side (M1a) can't drift past the loopback gate.
  const validated = validateEndpoint(config.endpoint);
  if (!validated.ok) throw new Error(`invalid local-model endpoint (${validated.code})`);

  const base = baseUrl(config.endpoint);
  const started = Date.now();
  const transport: LocalModelTransport = config.transport;

  // Streaming path (opt-in via onContentDelta). The non-streaming branches below
  // are unchanged — `stream:false` keeps their wire body byte-identical.
  if (opts.onContentDelta) {
    return chatStreaming(opts, {
      base,
      transport,
      temperature,
      toolChoice,
      timeoutMs,
      maxResponseBytes,
      started,
    });
  }

  if (transport === "v1") {
    const body = buildV1Body(config.modelId, messages, tools, temperature, toolChoice, false);
    const raw = (await postJson(`${base}/v1/chat/completions`, body, {
      timeoutMs,
      maxResponseBytes,
      signal,
    })) as {
      choices?: {
        message?: {
          content?: string;
          tool_calls?: { id?: string; function?: { name?: string; arguments?: unknown } }[];
        };
      }[];
    };
    const msg = raw.choices?.[0]?.message ?? {};
    const toolCalls: RawToolCall[] = (msg.tool_calls ?? []).map((tc) => {
      const { args, rawArgs, parseError } = parseArgs(tc.function?.arguments);
      return { id: tc.id ?? nextId(), name: tc.function?.name ?? "", args, rawArgs, parseError };
    });
    return { content: msg.content ?? "", toolCalls, raw, latencyMs: Date.now() - started };
  }

  // native /api/chat
  const body = buildNativeBody(config.modelId, messages, tools, temperature, false);
  const raw = (await postJson(`${base}/api/chat`, body, {
    timeoutMs,
    maxResponseBytes,
    signal,
  })) as {
    message?: {
      content?: string;
      tool_calls?: { function?: { name?: string; arguments?: unknown } }[];
    };
  };
  const msg = raw.message ?? {};
  const toolCalls: RawToolCall[] = (msg.tool_calls ?? []).map((tc) => {
    const { args, rawArgs, parseError } = parseArgs(tc.function?.arguments);
    return { id: nextId(), name: tc.function?.name ?? "", args, rawArgs, parseError };
  });
  return { content: msg.content ?? "", toolCalls, raw, latencyMs: Date.now() - started };
}
