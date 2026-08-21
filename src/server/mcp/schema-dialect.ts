/**
 * Strip the JSON Schema dialect declaration from `tools/list` (#1564).
 *
 * The MCP SDK converts every `inputSchema` and `outputSchema` with
 * `zod-to-json-schema` at its **default target**, which stamps
 * `"$schema": "http://json-schema.org/draft-07/schema#"` on the root of each
 * one. Claude Code's MCP client validates advertised output schemas as JSON
 * Schema **2020-12 only** and rejects a tool that declares any other dialect —
 * client-side, before a single `tools/call` reaches this server:
 *
 *     Error: Tool 'tandem_status' has an invalid outputSchema: JSON Schema
 *     declares an unsupported dialect ("$schema":
 *     "http://json-schema.org/draft-07/schema#").
 *
 * That silently removed the seven `outputSchema` tools — `tandem_checkInbox`
 * and `tandem_status` among them, so the entire poll surface — from a live
 * Claude Code session, while the same calls succeeded over raw JSON-RPC.
 *
 * ## Why strip rather than re-declare
 *
 * The dialect is not a consumer default to be negotiated — the protocol fixes
 * it. The SDK's own wire types say so: `ToolSchema.inputSchema` is documented
 * as "A JSON Schema 2020-12 object defining the expected parameters for the
 * tool", and `outputSchema` likewise. So the draft-07 stamp is a spec violation
 * on the SDK's side and Claude Code is the conformant party. (The stamp travels
 * rather than being rejected at the SDK boundary because the wire schema is a
 * `.catchall(z.unknown())` — it declares `type`/`properties`/`required` and
 * passes anything else through.)
 *
 * Given that, rewriting the value to the 2020-12 URI would be a redundant claim
 * — and a false one if the emitted schema ever used a construct the two
 * dialects read differently. Omitting it says exactly what is true: this is the
 * one dialect the protocol allows.
 *
 * This is worth reporting upstream rather than only working around; nothing
 * here depends on that happening.
 *
 * The strip is only sound while nothing we emit is dialect-sensitive, and that
 * is not a thing to assume — `tests/server/mcp-schema-dialect.test.ts` walks
 * every emitted schema and fails on the keywords whose meaning actually moved
 * between draft-07 and 2020-12 (array-form `items`, `additionalItems`,
 * `dependencies`, and a `$ref` with validation siblings). Today there are none:
 * the 19 `$ref`s we emit are bare same-document pointers.
 *
 * ## Why input schemas too, when only output schemas were rejected
 *
 * The bug report inferred that input schemas were accepted because they omit
 * `$schema`. They do not — all 32 carry the identical draft-07 declaration, and
 * the only reason they pass is that the client does not currently run them
 * through the same validator. Fixing one half would leave the other half armed
 * against exactly the client-side tightening that produced this issue.
 *
 * ## Why this reaches into the SDK's handler map
 *
 * The conversion happens inside the SDK's own `tools/list` handler, from zod
 * shapes it holds privately, at list time — there is no seam before it, and no
 * public option reaches it: `toJsonSchemaCompat` accepts a `target`, but
 * `mcp.js` never passes one and the zod-v3 branch ignores it anyway. The
 * handler map is the one place the finished result can be intercepted without
 * reimplementing the listing (and thereby silently dropping `title`,
 * `annotations`, `execution`, `_meta`, or the `enabled` filter on the next SDK
 * bump).
 *
 * ## What happens if the SDK moves that field
 *
 * `installSchemaDialectStrip` logs and returns `false`; it does not throw. An
 * earlier draft threw, on the argument that an unstartable server beats one
 * that quietly ships tools Claude Code will not call — but that compares
 * against the wrong baseline. The state it degrades to is exactly the state
 * this module was written to fix, in which 25 tools and the whole editor kept
 * working; throwing would instead take out the editor, Hocuspocus and all
 * document access. It also matches `snapshotToolCount` in `server.ts`, which
 * handles the same class of private-field drift on the same object the same
 * way.
 *
 * The real detector is not the runtime check at all: an SDK bump moves the
 * lockfile, and `tests/server/mcp-schema-dialect.test.ts` drives a real
 * `tools/list` over HTTP and fails in CI. The log line is for the case that
 * reaches a user's machine anyway.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

/** The wire method name, read from the SDK's own schema so a rename cannot silently no-op. */
const LIST_TOOLS_METHOD: string = ListToolsRequestSchema.shape.method.value;

/**
 * Recursively remove every `$schema` key.
 *
 * Recursive rather than root-only: `zod-to-json-schema` emits it at the root
 * today, but its `definitions` bucket is a plausible second home, and a nested
 * declaration would be rejected by the same validator for the same reason.
 * Nothing in a `tools/list` result is user data — it is schemas and strings —
 * so there is no value-shaped `$schema` to preserve.
 */
export function stripSchemaDialect<T>(value: T): T {
  if (Array.isArray(value)) return value.map(stripSchemaDialect) as unknown as T;
  if (value === null || typeof value !== "object") return value;
  const out: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (key === "$schema") continue;
    out[key] = stripSchemaDialect(child);
  }
  return out as unknown as T;
}

/** The shape of a `tools/list` result, as far as this module cares. */
interface ToolsListResult {
  tools?: Array<Record<string, unknown>>;
}

/** Strip the dialect from each tool's `inputSchema` / `outputSchema`, leaving the rest alone. */
export function stripToolSchemaDialects<T>(result: T): T {
  const tools = (result as ToolsListResult | null)?.tools;
  if (!Array.isArray(tools)) return result;
  return {
    ...(result as object),
    tools: tools.map((tool) => {
      const next: Record<string, unknown> = { ...tool };
      for (const key of ["inputSchema", "outputSchema"] as const) {
        if (next[key] !== undefined) next[key] = stripSchemaDialect(next[key]);
      }
      return next;
    }),
  } as unknown as T;
}

/** A `Server` with its handler map exposed — see the module doc for why this is read directly. */
type HandlerMapHolder = {
  _requestHandlers?: Map<string, (request: unknown, extra: unknown) => Promise<unknown>>;
};

/**
 * Wrap the SDK's `tools/list` handler so no advertised schema declares a dialect.
 *
 * Call AFTER every tool is registered: `McpServer` installs its tool handlers
 * lazily on the first `registerTool`, so on an empty server there is nothing to
 * wrap. Returns whether the wrap went on, and logs when it did not — see the
 * module doc for why this reports rather than throws. Safe to call twice: the
 * second wrap strips an already-stripped result, which is a no-op.
 */
export function installSchemaDialectStrip(server: McpServer): boolean {
  const handlers = (server.server as unknown as HandlerMapHolder)._requestHandlers;
  const original = handlers?.get(LIST_TOOLS_METHOD);
  if (!handlers || !original) {
    console.error(
      `[Tandem] Cannot strip the JSON Schema dialect: no ${LIST_TOOLS_METHOD} handler to wrap. ` +
        "Tools declaring an outputSchema will be rejected by Claude Code's client. " +
        "Register tools before calling installSchemaDialectStrip, and check whether the " +
        "MCP SDK still keeps its request handlers in Server._requestHandlers (#1564).",
    );
    return false;
  }
  handlers.set(LIST_TOOLS_METHOD, async (request, extra) =>
    stripToolSchemaDialects(await original(request, extra)),
  );
  return true;
}
