/**
 * The fingerprint of what is measured (#1123 brief R3.5).
 *
 * If this test fails after you changed a prompt, a tool schema, a tool-result
 * or refusal text, a budget, a timeout or the request the client sends: that
 * is the point. The published measurement (when there is one) no longer
 * describes what ships. Update `probe/local-model-spike/fingerprint.json`'s
 * `current` to the value printed below, and leave `published` alone — the
 * report then marks the published numbers stale until a new run is published.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { computeFingerprint } from "../../../../probe/local-model-spike/harness/fingerprint.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
const FILE = path.join(ROOT, "probe/local-model-spike/fingerprint.json");

beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe("the fingerprint", () => {
  it("is deterministic, restores the globals it borrows, and equals the tracked one", async () => {
    const fetchBefore = globalThis.fetch;
    const setTimeoutBefore = globalThis.setTimeout;
    const nowBefore = Date.now;

    const first = await computeFingerprint();
    const second = await computeFingerprint();
    expect(second.fingerprint).toBe(first.fingerprint);
    expect(second.inputs).toEqual(first.inputs);

    expect(globalThis.fetch).toBe(fetchBefore);
    expect(globalThis.setTimeout).toBe(setTimeoutBefore);
    expect(Date.now).toBe(nowBefore);

    const tracked = JSON.parse(fs.readFileSync(FILE, "utf8")) as {
      current: string;
      published: string | null;
      statement: string;
    };
    expect(
      first.fingerprint,
      `what the model sees or is limited by has changed. New fingerprint: ${first.fingerprint}. See the note at the top of this file.`,
    ).toBe(tracked.current);
  }, 60_000);

  it("the tracked file holds the current fingerprint, the published one and a one-line statement", () => {
    const tracked = JSON.parse(fs.readFileSync(FILE, "utf8")) as Record<string, unknown>;
    expect(Object.keys(tracked).sort()).toEqual(["current", "published", "statement"]);
    expect(tracked.current).toMatch(/^[0-9a-f]{32}$/);
    expect(tracked.published === null || /^[0-9a-f]{32}$/.test(String(tracked.published))).toBe(
      true,
    );
    expect(typeof tracked.statement).toBe("string");
    expect(String(tracked.statement).trim().length).toBeGreaterThan(20);
    expect(String(tracked.statement)).not.toContain("\n");
    // Nothing has been measured in this repository yet.
    expect(tracked.published).toBeNull();
  });

  it("covers everything the model sees or is limited by", async () => {
    const { inputs } = await computeFingerprint();
    const text = JSON.stringify(inputs);

    // Both system prompts, the user-turn template in every form, both tool lists.
    expect(Object.keys(inputs.systemPrompts as object)).toEqual(["chat", "editing"]);
    expect(Object.keys(inputs.userPrompts as object).sort()).toEqual([
      "chat-inline",
      "chat-long",
      "editing-inline",
      "editing-long",
    ]);
    expect(Object.keys(inputs.tools as object).sort()).toEqual(["chat", "editing"]);

    // Every refusal code the dispatch can hand a model is exercised, so a
    // changed text behind any of them changes the fingerprint.
    const tools = fs.readFileSync(path.join(ROOT, "src/server/local-model/tools.ts"), "utf8");
    const codes = new Set([...tools.matchAll(/error: "([A-Z_]+)"/g)].map((m) => m[1]));
    expect(codes.size).toBeGreaterThanOrEqual(5);
    for (const code of codes) expect(text, code).toContain(`"error":"${code}"`);
    for (const code of ["HEADING_OVERLAP", "NOT_FOUND", "ANCHOR_NOT_FOUND"])
      expect(text, code).toContain(code);
    // The three "proposed, not changed" notes.
    expect(text.match(/The document text has NOT been changed/g)?.length).toBeGreaterThanOrEqual(3);
    // Ids are normalised, so two computations agree.
    expect(text).not.toMatch(/ann_\d{10,}/);

    // The call shape, captured from scripted runs rather than restated.
    const request = inputs.request as Record<
      string,
      { path: string; body: Record<string, unknown>; composedTask: string; redirect: string }
    >;
    expect(request.chat.path).toBe("/v1/chat/completions");
    expect(request.chat.body.stream).toBe(true);
    expect(typeof request.chat.body.temperature).toBe("number");
    expect(request.chat.redirect).toBe("error");
    expect(request.chat.composedTask).toContain("The user has selected:");
    expect(inputs.inline).toMatchObject({ inlinedAtLimit: true, inlinedOverLimit: false });
    const budgets = inputs.budgets as {
      turnBudget: { exit: string; turns: number };
      toolCallBudget: { exit: string; toolCalls: number };
    };
    expect(budgets.turnBudget.exit).toBe("max_turns");
    expect(budgets.toolCallBudget.exit).toBe("max_tool_calls");
    const timeouts = inputs.timeouts as {
      firstTurnTimeoutMs: number;
      secondTurnTimeoutMs: number;
      clockStepMs: number;
    };
    // The second turn's timeout is what was left of the run deadline, so it is
    // shorter than a full turn: the deadline is in the fingerprint too.
    expect(timeouts.firstTurnTimeoutMs).toBeGreaterThan(0);
    expect(timeouts.secondTurnTimeoutMs).toBeLessThan(timeouts.firstTurnTimeoutMs);
    expect(timeouts.secondTurnTimeoutMs % 1000).toBe(0); // a virtual clock: no real time leaks in
    expect((inputs.sinkCap as { tail: string }).tail).toContain("Reply truncated");
    expect(
      (inputs.editingOff as { secondRequest: Record<string, unknown> }).secondRequest.tools,
    ).toBeUndefined();
  }, 60_000);
});
