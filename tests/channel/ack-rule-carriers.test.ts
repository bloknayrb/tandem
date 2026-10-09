/**
 * The channel shim is the one carrier of the ack-before-work rule a push-only
 * session may ever read (it can go a whole task without polling), so losing it
 * silently turns off the editor's "working on it" state for that population.
 *
 * Source-level, like `run-timeouts.test.ts`: the shim builds its server inside
 * `runChannel` and exports neither the instructions nor the tool list.
 */
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const RUN_TS = fileURLToPath(new URL("../../src/channel/run.ts", import.meta.url));

describe("channel shim — ack rule carriers", () => {
  it("puts CHAT_ACK_RULE in the instructions and the tandem_reply description", async () => {
    const src = await readFile(RUN_TS, "utf8");
    const instructions = /instructions:\s*\[([\s\S]*?)\]\.join/.exec(src)?.[1] ?? "";
    expect(instructions, "shim instructions array").toContain("CHAT_ACK_RULE");
    expect(src).toMatch(/description:\s*`Reply to a chat message in Tandem\. \$\{CHAT_ACK_RULE\}`/);
  });

  it("declares inProgress and forwards every argument to /api/channel-reply", async () => {
    const src = await readFile(RUN_TS, "utf8");
    expect(src).toMatch(/inProgress:\s*\{\s*type:\s*"boolean"/);
    // Pass-through is what carries `inProgress` and `replyTo`; a picked-fields
    // body would drop the ack flag with no error anywhere.
    expect(src).toContain("body: JSON.stringify(args)");
  });
});
