/**
 * Best-effort facts about the server and the model, for a run's identity.
 *
 * These are METADATA calls, not chat: no model is asked anything. Every field
 * is "unknown" when it cannot be read, and nothing here is fatal except what
 * `preflight.ts` decides to stop on.
 *
 * NOTHING BELOW HAS BEEN RUN AGAINST A REAL SERVER. The paths and field names
 * are assumptions from Ollama's published API as the author remembers it:
 *   GET  /api/version   → { version }
 *   GET  /api/tags      → { models: [{ name, model, digest, details: { parameter_size, quantization_level } }] }
 *   POST /api/show      → 404 when the model is missing; { capabilities: [...], model_info: { "<arch>.context_length": n }, parameters: "num_ctx 4096\n…" }
 *   GET  /api/ps        → { models: [{ name, model, digest, context_length }] }
 * A server that answers differently yields "unknown", never a wrong value.
 *
 * The endpoint is checked by the product's own `validateEndpoint` by the
 * caller, who hands this module the validated URL. Redirects are refused, each
 * call has a short timeout and a body cap, and every string taken from a
 * response is length-capped and stripped of control characters before it can
 * reach a terminal or a file: whatever owns that loopback port wrote it.
 */

const META_TIMEOUT_MS = 10_000;
const META_BODY_CAP_BYTES = 1024 * 1024;
const META_STRING_CAP = 200;

export const UNKNOWN = "unknown";

export interface ModelFacts {
  /** false only when the server said, in so many words, that it has no such model. */
  exists: boolean | "unknown";
  /** false only on an explicit capability list that lacks tools. */
  toolSupport: boolean | "unknown";
  digest: string;
  ollamaVersion: string;
  contextLength: number | "unknown";
  /** Settings read from the server that change output, as text. */
  serverSettings: Record<string, string> | "unknown";
}

/** Printable, bounded text from an untrusted response. */
export function cleanMetaString(v: unknown): string {
  if (typeof v !== "string" && typeof v !== "number") return UNKNOWN;
  const text = String(v)
    // Control characters, and the bidi and zero-width formatting characters.
    .replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, "")
    .trim()
    .slice(0, META_STRING_CAP);
  return text.length > 0 ? text : UNKNOWN;
}

function asRecord(v: unknown): Record<string, unknown> | null {
  return typeof v === "object" && v !== null && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : null;
}

interface MetaResponse {
  status: number | null;
  json: Record<string, unknown> | null;
}

async function metaCall(base: URL, pathname: string, body?: unknown): Promise<MetaResponse> {
  const url = new URL(base.href);
  // Connect to the address that was checked, never to a name resolved again.
  if (url.hostname.toLowerCase() === "localhost") url.hostname = "127.0.0.1";
  url.pathname = `${url.pathname.replace(/\/+$/, "")}${pathname}`;
  url.search = "";
  url.hash = "";
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), META_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: body === undefined ? "GET" : "POST",
      ...(body === undefined
        ? {}
        : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
      redirect: "error",
      signal: ctrl.signal,
    });
    const reader = res.body?.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    if (reader) {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!value) continue;
        total += value.byteLength;
        if (total > META_BODY_CAP_BYTES) {
          await reader.cancel().catch(() => {});
          return { status: res.status, json: null };
        }
        chunks.push(value);
      }
    }
    let json: Record<string, unknown> | null = null;
    try {
      json = asRecord(JSON.parse(Buffer.concat(chunks).toString("utf8")));
    } catch {
      json = null;
    }
    return { status: res.status, json };
  } catch {
    return { status: null, json: null };
  } finally {
    clearTimeout(timer);
  }
}

function modelEntry(list: unknown, tag: string): Record<string, unknown> | null {
  if (!Array.isArray(list)) return null;
  for (const item of list) {
    const rec = asRecord(item);
    if (rec && (rec.name === tag || rec.model === tag)) return rec;
  }
  return null;
}

/** Read what can be read about `modelTag`. Never throws. */
export async function readModelFacts(base: URL, modelTag: string): Promise<ModelFacts> {
  const facts: ModelFacts = {
    exists: UNKNOWN,
    toolSupport: UNKNOWN,
    digest: UNKNOWN,
    ollamaVersion: UNKNOWN,
    contextLength: UNKNOWN,
    serverSettings: UNKNOWN,
  };

  const version = await metaCall(base, "/api/version");
  if (version.json) facts.ollamaVersion = cleanMetaString(version.json.version);

  const show = await metaCall(base, "/api/show", { model: modelTag });
  if (show.status === 404) facts.exists = false;
  if (show.status === 200 && show.json) {
    facts.exists = true;
    if (Array.isArray(show.json.capabilities)) {
      facts.toolSupport = show.json.capabilities.includes("tools");
    }
    const settings: Record<string, string> = {};
    if (typeof show.json.parameters === "string") {
      settings.parameters = cleanMetaString(show.json.parameters.replace(/\s+/g, " "));
    }
    const details = asRecord(show.json.details);
    if (details) {
      for (const key of ["parameter_size", "quantization_level", "family"]) {
        if (details[key] !== undefined) settings[key] = cleanMetaString(details[key]);
      }
    }
    if (Object.keys(settings).length > 0) facts.serverSettings = settings;
    const info = asRecord(show.json.model_info);
    if (info) {
      for (const [key, value] of Object.entries(info)) {
        if (key.endsWith(".context_length") && typeof value === "number") {
          // The model's maximum. Overwritten below by what the server is
          // actually running it with, when that can be read.
          facts.contextLength = value;
        }
      }
    }
    const numCtx = /(?:^|\s)num_ctx\s+(\d+)/.exec(
      typeof show.json.parameters === "string" ? show.json.parameters : "",
    );
    if (numCtx) facts.contextLength = Number(numCtx[1]);
  }

  const tags = await metaCall(base, "/api/tags");
  const tagged = modelEntry(tags.json?.models, modelTag);
  if (tagged) {
    facts.digest = cleanMetaString(tagged.digest);
    if (facts.exists === UNKNOWN) facts.exists = true;
  }

  return facts;
}

/** The context length the server is running the loaded model with, if it says. */
export async function readLoadedContextLength(
  base: URL,
  modelTag: string,
): Promise<number | "unknown"> {
  const ps = await metaCall(base, "/api/ps");
  const loaded = modelEntry(ps.json?.models, modelTag);
  return loaded && typeof loaded.context_length === "number" ? loaded.context_length : UNKNOWN;
}
