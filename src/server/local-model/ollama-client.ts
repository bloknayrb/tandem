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

/** POST JSON to a validated loopback URL with timeout + abort + bounded read. */
async function postJson(
  url: string,
  payload: unknown,
  opts: { timeoutMs: number; maxResponseBytes: number; signal?: AbortSignal },
): Promise<unknown> {
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
    const text = await readBoundedText(res, opts.maxResponseBytes);
    return JSON.parse(text);
  } finally {
    clearTimeout(timer);
  }
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
    stream: false,
    temperature,
  };
}

function buildNativeBody(
  model: string,
  messages: ChatMessage[],
  tools: ToolSchema[],
  temperature: number,
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
    stream: false,
    options: { temperature },
  };
}

/** Trim trailing slashes so `${base}/v1/...` doesn't double up. */
function baseUrl(endpoint: string): string {
  return endpoint.replace(/\/+$/, "");
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

  if (transport === "v1") {
    const body = buildV1Body(config.modelId, messages, tools, temperature, toolChoice);
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
  const body = buildNativeBody(config.modelId, messages, tools, temperature);
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
