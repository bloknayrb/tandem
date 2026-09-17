/**
 * The in-memory MCP harness: an `McpServer` with a caller-supplied registrar
 * list, linked to a real `Client` over an `InMemoryTransport` pair.
 *
 * Driving the REGISTERED handler is what separates a real tool test from one
 * that reimplements the tool's filters and then asserts its own model of them.
 * The counter-example was `tests/server/annotation-tools.test.ts`'s
 * "tandem_getAnnotations tool logic" describe block, which filtered in the test
 * itself and never called a handler; ADR-035 Unit 8g exists because of it. It
 * was rewritten onto this harness in #2048, and four of its six rows changed
 * meaning once they began exercising the real filter — which is what leaving
 * one in place costs, not an argument that the rewrite was optional. So the
 * point of this module is not line count — it is that ~20 lines of
 * boilerplate is exactly the friction that produces the next hand-rolled
 * filter test, and a one-line import makes the right shape the easy one.
 *
 * Deliberately imports NO `src/` module at all — not even `src/shared` — so a
 * suite whose `vi.mock` factories and hoisted dynamic imports decide its module
 * graph can import this file without perturbing that graph. (Stricter than its
 * precedent, `tests/helpers/wire-code-fixtures.ts`, which says "no `src/server`
 * module" and then imports `src/shared/constants.js`.)
 *
 * No `server` handle is returned: nothing needs one, and returning it invites
 * registering a tool after connect.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

/**
 * Stand up a connected in-memory MCP client over `registrars`.
 *
 * Registrars are closures, so an arity-2 registrar fits unchanged:
 * `(s) => registerDiagnosticsTools(s, opts)`.
 *
 * `close()` awaits the client then the server, making it at least as strong as
 * the hand-written client-only closes it replaces. It is hygiene rather than a
 * leak fix: `InMemoryTransport` holds only a message queue and a reference to
 * its peer — no timer, socket or fd — and its own `close()` already awaits the
 * other side. Call it in the scope that created the client.
 *
 * From a file-level `afterEach`, call it as `await close?.()` off an
 * `(() => Promise<void>) | undefined` binding and clear that binding after —
 * vitest runs `afterEach` even when `beforeEach` threw, so an unguarded call on
 * a never-assigned binding reports `close is not a function` ON TOP OF the real
 * cause, and on any later test the same path re-closes the PREVIOUS test's
 * client instead.
 */
export async function setupMcpServer(
  registrars: Array<(server: McpServer) => void>,
): Promise<{ client: Client; close: () => Promise<void> }> {
  const server = new McpServer({ name: "tandem-test", version: "0.0.1" });
  for (const register of registrars) register(server);

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test-client", version: "0.0.1" });
  await server.connect(serverTransport);
  await client.connect(clientTransport);

  return {
    client,
    close: async () => {
      await client.close();
      await server.close();
    },
  };
}

/**
 * The text envelope every tool returns, parsed out of `content`.
 *
 * **The parameter admits two shapes because the call sites genuinely hold two,
 * and no single hand-written shape covers both.** Measured, not guessed:
 *
 * - `callTool` returns a UNION whose legacy `CompatibilityCallToolResult` arm
 *   carries `toolResult` and no `content` key. So `{ content: unknown }` is
 *   rejected (that arm lacks a required property) and `{ content?: unknown }`
 *   is rejected too — an all-optional target is a TS *weak type*, and the arm
 *   "has no properties in common" with it. That was 93 errors, from the files
 *   that pass a raw `callTool` result.
 * - Naming only `Awaited<ReturnType<Client["callTool"]>>` then rejects the
 *   files that pass a narrowed cast, which is missing `toolResult`. That was
 *   the remaining 5.
 *
 * Hence the explicit union. Both halves were observed at `typecheck:tests`
 * before this signature settled; neither is hypothetical.
 *
 * The cast to a plain array shape stays inside, because TS's deep Zod-inferred
 * union for `content` blows up ("is of type 'unknown'") the moment it is
 * iterated (`.find`, `for...of`).
 */
export function parseResult(
  result:
    | Awaited<ReturnType<Client["callTool"]>>
    | { content: Array<{ type: string; text?: string }> },
) {
  const content = result.content as Array<{ type: string; text?: string }>;
  const textContent = content.find((c) => c.type === "text");
  return textContent?.text ? JSON.parse(textContent.text) : null;
}
