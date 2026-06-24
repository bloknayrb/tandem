/**
 * M1.1 live dogfood (#1123): drive the PRODUCTIONIZED loop (src/server/local-model)
 * against real Ollama and confirm it creates a correctly-anchored annotation.
 * Run: npx tsx probe/local-model-spike/dogfood-m1.ts
 * Requires a local Ollama with the model below pulled. Not part of CI.
 */
import { loadMarkdown } from "../../src/server/file-io/markdown.js";
import { runLocalModelTurn } from "../../src/server/local-model/index.js";
import { Y_MAP_ANNOTATIONS } from "../../src/shared/constants.js";
import * as Y from "yjs";

const DOC = `# Project Plan

The budget is $500 for the first phase of the rollout.

We will hire two engineers and ship the beta in eight weeks. The timeline is aggressive but achievable with focus.
`;

async function main() {
  const ydoc = new Y.Doc();
  loadMarkdown(ydoc, DOC);

  console.error("[dogfood] running loop against qwen2.5:14b-instruct …");
  const res = await runLocalModelTurn({
    ydoc,
    config: { endpoint: "http://127.0.0.1:11434", modelId: "qwen2.5:14b-instruct", transport: "v1" },
    task: "Leave a brief comment on the sentence about the budget.",
    includeFullText: true,
    timeoutMs: 240_000,
  });

  console.error("[dogfood] metrics:", JSON.stringify(res.metrics));
  const anns = ydoc.getMap(Y_MAP_ANNOTATIONS);
  console.error(`[dogfood] annotations created: ${anns.size}`);
  for (const [id, value] of anns.entries()) {
    const a = value as { author?: string; type?: string; content?: string; range?: { from: number; to: number } };
    console.error(`[dogfood]   ${id}: author=${a.author} type=${a.type} range=${JSON.stringify(a.range)} content=${JSON.stringify(a.content)}`);
  }
  console.error(`[dogfood] final chat text: ${JSON.stringify(res.finalContent)}`);
  ydoc.destroy();
  console.error(anns.size > 0 ? "[dogfood] PASS — real annotation created" : "[dogfood] (no annotation — model chose chat-only)");
}

main().catch((e) => {
  console.error("[dogfood] FAILED:", e);
  process.exit(1);
});
