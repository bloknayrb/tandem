/**
 * Minimal Ollama chat client for the #1123 M0 spike.
 *
 * Two transports, selectable per the Phase B per-model tool-call gate:
 *  - "v1":  OpenAI-compatible POST /v1/chat/completions
 *  - "native": Ollama-native POST /api/chat
 * Both are normalized to the same {content, toolCalls} shape so loop.ts is
 * transport-agnostic. The OpenAI /v1 tool passthrough is model/version-quirky
 * (Ollama 0.30.x); if a model won't emit tool calls over /v1 we flip to native.
 *
 * No SDK, no deps — Node 22+ global fetch.
 */

export type Transport = "v1" | "native";

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
  /** parsed args, or the raw string if JSON.parse failed (loop records the fault) */
  args: Record<string, unknown> | null;
  rawArgs: string;
  parseError?: string;
}

export interface ChatResult {
  content: string;
  toolCalls: RawToolCall[];
  /** raw provider response for the trial log */
  raw: unknown;
  latencyMs: number;
}

const HOST = process.env.OLLAMA_HOST ?? "http://localhost:11434";

let callCounter = 0;
function nextId(): string {
  callCounter += 1;
  return `call_${callCounter}`;
}

function parseArgs(raw: unknown): { args: Record<string, unknown> | null; rawArgs: string; parseError?: string } {
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

async function fetchWithTimeout(url: string, body: unknown, timeoutMs: number): Promise<unknown> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`Ollama ${res.status}: ${text.slice(0, 300)}`);
    }
    return await res.json();
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

/** "auto" (default) lets the model decide; a {function} object FORCES that single tool — used by the single-shot FALLBACK runner. */
export type ToolChoice = "auto" | "none" | { type: "function"; function: { name: string } };

export interface ChatOpts {
  model: string;
  messages: ChatMessage[];
  tools: ToolSchema[];
  transport: Transport;
  temperature?: number;
  timeoutMs?: number;
  toolChoice?: ToolChoice;
}

export async function chat(opts: ChatOpts): Promise<ChatResult> {
  const { model, messages, tools, transport, temperature = 0.2, timeoutMs = 180_000, toolChoice = "auto" } = opts;
  const started = Date.now();

  if (transport === "v1") {
    const body = {
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
    const raw = (await fetchWithTimeout(`${HOST}/v1/chat/completions`, body, timeoutMs)) as {
      choices?: { message?: { content?: string; tool_calls?: { id?: string; function?: { name?: string; arguments?: unknown } }[] } }[];
    };
    const msg = raw.choices?.[0]?.message ?? {};
    const toolCalls: RawToolCall[] = (msg.tool_calls ?? []).map((tc) => {
      const { args, rawArgs, parseError } = parseArgs(tc.function?.arguments);
      return { id: tc.id ?? nextId(), name: tc.function?.name ?? "", args, rawArgs, parseError };
    });
    return { content: msg.content ?? "", toolCalls, raw, latencyMs: Date.now() - started };
  }

  // native /api/chat
  const body = {
    model,
    messages: messages.map((m) => ({
      role: m.role,
      content: m.content,
      ...(m.tool_calls
        ? { tool_calls: m.tool_calls.map((tc) => ({ function: { name: tc.name, arguments: tc.args ?? {} } })) }
        : {}),
      ...(m.tool_name ? { tool_name: m.tool_name } : {}),
    })),
    tools: toOpenAITools(tools),
    stream: false,
    options: { temperature },
  };
  const raw = (await fetchWithTimeout(`${HOST}/api/chat`, body, timeoutMs)) as {
    message?: { content?: string; tool_calls?: { function?: { name?: string; arguments?: unknown } }[] };
  };
  const msg = raw.message ?? {};
  const toolCalls: RawToolCall[] = (msg.tool_calls ?? []).map((tc) => {
    const { args, rawArgs, parseError } = parseArgs(tc.function?.arguments);
    return { id: nextId(), name: tc.function?.name ?? "", args, rawArgs, parseError };
  });
  return { content: msg.content ?? "", toolCalls, raw, latencyMs: Date.now() - started };
}
