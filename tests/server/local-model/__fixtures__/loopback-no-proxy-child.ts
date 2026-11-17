/**
 * Child-process entry for `tests/server/local-model/loopback-no-proxy.test.ts`
 * (#1123, #2422). Started with `node --import tsx` and Node's environment proxy
 * on, it makes ONE real request through the shipped code, then prints a single
 * `RESULT <json>` line on stdout and exits.
 *
 * argv[2] is a JSON spec:
 * - `{"kind":"chat","endpoint":…,"sentinel":…,"stream":bool}` calls `chat()`
 *   from `src/server/local-model/ollama-client.ts` (v1 transport), with the
 *   sentinel inside `messages`, and reports the content and, when streaming,
 *   every delta the callback received;
 * - `{"kind":"probe","port":…,"host":…}` calls `probeTandemInstance` from
 *   `src/server/platform.ts` with a one-attempt schedule.
 *
 * Not a test file (no `.test.ts`): vitest never collects it.
 */
import { chat } from "../../../../src/server/local-model/ollama-client.js";
import { probeTandemInstance } from "../../../../src/server/platform.js";

type Spec =
  | { kind: "chat"; endpoint: string; sentinel: string; stream: boolean }
  | { kind: "probe"; port: number; host: string };

function report(result: unknown): void {
  process.stdout.write(`RESULT ${JSON.stringify(result)}\n`);
}

async function main(): Promise<void> {
  const spec = JSON.parse(process.argv[2] ?? "{}") as Spec;
  if (spec.kind === "chat") {
    const deltas: string[] = [];
    const res = await chat({
      config: { endpoint: spec.endpoint, modelId: "test-model", transport: "v1" },
      messages: [{ role: "user", content: `please read ${spec.sentinel}` }],
      tools: [],
      timeoutMs: 15_000,
      ...(spec.stream ? { onContentDelta: (d: string) => deltas.push(d) } : {}),
    });
    report({ ok: true, content: res.content, deltas });
    return;
  }
  const probe = await probeTandemInstance(
    spec.port,
    { attempts: 1, timeoutMs: 15_000, delayMs: 10 },
    spec.host,
  );
  report({ ok: true, probe });
}

main().then(
  () => process.exit(0),
  (err: unknown) => {
    report({
      ok: false,
      error: err instanceof Error ? `${err.name}: ${err.message}` : String(err),
    });
    process.exit(1);
  },
);
