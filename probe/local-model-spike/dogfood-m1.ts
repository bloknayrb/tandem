/**
 * Live dogfood (#1123): drive the PRODUCTION loop (src/server/local-model)
 * against a real Ollama, in either tier.
 *
 *   npx tsx probe/local-model-spike/dogfood-m1.ts --tier editing
 *   npx tsx probe/local-model-spike/dogfood-m1.ts --tier chat
 *
 * Optional: --model <id> (default qwen2.5:14b-instruct), --endpoint <url>
 * (default http://127.0.0.1:11434).
 *
 *  - editing: the model is asked for a comment. PASS means a correctly
 *    anchored annotation was created.
 *  - chat (the shipped default): the SAME request. PASS means NO annotation
 *    was created and it answered in text. (That the model is offered only the
 *    reading tools in this tier is pinned by tests, not checked here.) The last lines also print whether the reply claims to have
 *    changed the document, for a human to read; that is not asserted.
 *
 * Requires a local Ollama with the model pulled. Not part of CI, and not
 * typechecked.
 */
import { loadMarkdown } from "../../src/server/file-io/markdown.js";
import { runLocalModelTurn } from "../../src/server/local-model/index.js";
import { Y_MAP_ANNOTATIONS } from "../../src/shared/constants.js";
import * as Y from "yjs";

const DOC = `# Project Plan

The budget is $500 for the first phase of the rollout.

We will hire two engineers and ship the beta in eight weeks. The timeline is aggressive but achievable with focus.
`;

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

async function main() {
  const tier = arg("tier", "editing");
  if (tier !== "chat" && tier !== "editing") {
    throw new Error(`--tier must be "chat" or "editing" (got "${tier}")`);
  }
  const modelId = arg("model", "qwen2.5:14b-instruct");
  const endpoint = arg("endpoint", "http://127.0.0.1:11434");

  const ydoc = new Y.Doc();
  loadMarkdown(ydoc, DOC);

  console.error(`[dogfood] tier=${tier} model=${modelId} endpoint=${endpoint}`);
  const res = await runLocalModelTurn({
    ydoc,
    config: {
      endpoint,
      modelId,
      transport: "v1",
      agentIdentity: { provider: "local-ollama", displayName: modelId },
    },
    task: "Leave a brief comment on the sentence about the budget.",
    includeFullText: true,
    timeoutMs: 240_000,
    // The tier: this is the same switch the collaborator reads from the user's
    // setting. Off means the model is offered only the reading tools and every
    // writing call is refused.
    editingAllowed: () => tier === "editing",
  });

  console.error("[dogfood] metrics:", JSON.stringify(res.metrics));
  for (const step of res.steps) {
    for (const call of step.toolCalls) {
      console.error(`[dogfood]   turn ${step.turn}: ${call.name} -> ${JSON.stringify(call.outcome)}`);
    }
  }
  const anns = ydoc.getMap(Y_MAP_ANNOTATIONS);
  console.error(`[dogfood] annotations created: ${anns.size}`);
  for (const [id, value] of anns.entries()) {
    const a = value as { author?: string; type?: string; content?: string; range?: { from: number; to: number } };
    console.error(`[dogfood]   ${id}: author=${a.author} type=${a.type} range=${JSON.stringify(a.range)} content=${JSON.stringify(a.content)}`);
  }
  console.error(`[dogfood] final chat text: ${JSON.stringify(res.finalContent)}`);
  const refused = res.steps.flatMap((s) => s.toolCalls).filter((c) => c.outcome.kind === "refused");
  ydoc.destroy();

  let pass: boolean;
  if (tier === "editing") {
    pass = anns.size > 0;
    console.error(pass ? "[dogfood] PASS (editing) — real annotation created" : `[dogfood] FAIL (editing) — no annotation (exit=${res.metrics.exit})`);
  } else {
    pass = anns.size === 0 && res.finalContent.trim().length > 0;
    console.error(`[dogfood] refused writing calls: ${refused.length}`);
    console.error(pass ? "[dogfood] PASS (chat) — nothing written, model answered in text" : "[dogfood] FAIL (chat) — an annotation was written, or there was no text reply");
    console.error("[dogfood] READ the final chat text above: it must not say a comment or change was made.");
  }
  if (!pass) process.exit(1);
}

main().catch((e) => {
  console.error("[dogfood] FAILED:", e);
  process.exit(1);
});
