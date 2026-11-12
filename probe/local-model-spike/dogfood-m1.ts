/**
 * Live dogfood (#1123): one chat message through the SHIPPED collaborator
 * against a real Ollama, in either tier. The #2403 hardware checklist runs it.
 *
 *   npx tsx probe/local-model-spike/dogfood-m1.ts --model <tag> --tier editing
 *   npx tsx probe/local-model-spike/dogfood-m1.ts --model <tag> --tier chat
 *
 * --model is required (exit 2 without it): there is no default model.
 * --tier defaults to editing. --endpoint defaults to http://127.0.0.1:11434.
 *
 * It calls the product exactly as a measurement trial does (`harness/trial.ts`):
 * the collaborator decides whether to inline the document, the timeouts, the
 * budgets and the streaming, and the reply printed is what the chat row holds.
 *
 *  - editing: the model is asked for a comment. PASS means an annotation was
 *    written to the document.
 *  - chat (the shipped default): the SAME request. PASS means nothing was
 *    written and it answered in text.
 *
 * Exit codes: 0 PASS, 1 FAIL, 2 bad arguments. PASS and FAIL are those two
 * mechanical checks only. Whether the reply CLAIMS to have changed the
 * document is for a person to judge: the script prints the reply and any
 * claim-check flags, and nobody has read them for you.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { parseArgs, tierArg } from "./harness/args.js";
import { isolateAppData, printable, say } from "./harness/entry-common.js";
import { isMain } from "./harness/main-guard.js";

const DOC = `# Project Plan

The budget is $500 for the first phase of the rollout.

We will hire two engineers and ship the beta in eight weeks. The timeline is aggressive but achievable with focus.
`;

const TASK = "Leave a brief comment on the sentence about the budget.";

export async function main(argv: readonly string[]): Promise<number> {
  const { values } = parseArgs(argv);
  const modelId = values.get("model");
  if (!modelId) {
    say("dogfood-m1: --model <tag> is required (there is no default model)");
    return 2;
  }
  const rawTier = values.get("tier") ?? "editing";
  const tier = tierArg(rawTier);
  if (!tier) {
    say(`dogfood-m1: --tier must be "chat" or "editing" (got ${printable(JSON.stringify(rawTier))})`);
    return 2;
  }
  const endpoint = values.get("endpoint") ?? "http://127.0.0.1:11434";

  // The product's app data goes to a throwaway directory, set before it loads.
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "tandem-dogfood-"));
  isolateAppData(scratch);
  try {
    const [{ runTrial }, { harnessConfig }, { classifyTrial }, { claimCheck }] = await Promise.all([
      import("./harness/trial.js"),
      import("./harness/model-config.js"),
      import("./harness/classify.js"),
      import("./harness/claims.js"),
    ]);

    say(`[dogfood] tier=${tier} model=${printable(modelId)} endpoint=${printable(endpoint)}`);
    const obs = await runTrial({
      markdown: DOC,
      prompt: TASK,
      tier,
      config: harnessConfig(modelId, endpoint),
    });
    const ending = classifyTrial(obs);

    say(`[dogfood] ended: ${ending.ending} (${ending.detail})`);
    if (obs.loop) say(`[dogfood] metrics: ${JSON.stringify(obs.loop.metrics)}`);
    for (const step of obs.loop?.steps ?? []) {
      for (const call of step.toolCalls) {
        say(printable(`[dogfood]   turn ${step.turn}: ${call.name} -> ${JSON.stringify(call.outcome)}`, 1000));
      }
    }
    say(`[dogfood] annotations written: ${obs.writes.annotations.length}`);
    for (const a of obs.writes.annotations) {
      say(printable(`[dogfood]   ${a.kind} on ${JSON.stringify(a.anchoredText)}: ${JSON.stringify(a.content)}`, 1000));
    }
    for (const n of obs.notices) say(printable(`[dogfood] notice shown to the user: ${JSON.stringify(n.message)}`, 1000));
    say(printable(`[dogfood] chat reply (what the chat row holds): ${JSON.stringify(obs.reply)}`, 8000));

    const claims = claimCheck({
      tier,
      reply: obs.reply,
      turnTexts: obs.turns.map((t) => t.text),
      writes: obs.writes,
      documentText: obs.documentText,
      actionRequested: true,
    });
    if (claims.flags.length > 0) {
      say("[dogfood] claim check flagged this reply (a pattern match that nobody has read; not a verdict):");
      for (const f of claims.flags) say(printable(`[dogfood]   ${f.kind} in ${f.where}: ${JSON.stringify(f.excerpt)}`, 600));
    }

    let pass: boolean;
    if (tier === "editing") {
      pass = obs.writes.annotations.length > 0;
      say(pass ? "[dogfood] PASS (editing) — an annotation was written" : `[dogfood] FAIL (editing) — no annotation (ended ${ending.ending})`);
    } else {
      pass = obs.writes.annotations.length === 0 && obs.writes.replies.length === 0 && obs.reply.trim().length > 0;
      const refused = (obs.loop?.steps ?? []).flatMap((s) => s.toolCalls).filter((c) => c.outcome.kind === "refused");
      say(`[dogfood] refused tool calls: ${refused.length}`);
      say(pass ? "[dogfood] PASS (chat) — nothing written, the model answered in text" : "[dogfood] FAIL (chat) — something was written, or there was no text reply");
    }
    say("[dogfood] READ the chat reply above: it must not say a comment or a change was made unless one was.");
    return pass ? 0 : 1;
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}

if (isMain(import.meta.url)) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (err) => {
      say(`[dogfood] FAILED: ${printable(err instanceof Error ? (err.stack ?? err.message) : String(err), 4000)}`);
      process.exit(1);
    },
  );
}
