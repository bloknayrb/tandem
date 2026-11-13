/**
 * Shared pieces for the measurement-harness tests (#1123). No model and no
 * network: every "model" here is a scripted stream.
 */
import { vi } from "vitest";
import { harnessConfig } from "../../../../probe/local-model-spike/harness/model-config.js";
import {
  ALL_SCENARIOS,
  fixtureFor,
} from "../../../../probe/local-model-spike/harness/scenarios/index.js";
import type { Scenario } from "../../../../probe/local-model-spike/harness/scenarios/types.js";
import {
  framesFor,
  type ScriptedTurn,
  scriptedFetch,
} from "../../../../probe/local-model-spike/harness/scripted-model.js";
import {
  runTrial,
  type TrialObservation,
} from "../../../../probe/local-model-spike/harness/trial.js";

export const CONFIG = harnessConfig("scripted:model", "http://127.0.0.1:11434");

export function scenario(id: string): Scenario {
  const s = ALL_SCENARIOS.find((x) => x.id === id);
  if (!s) throw new Error(`no scenario ${id}`);
  return s;
}

export function firstOf(
  group: Scenario["group"],
  pred: (s: Scenario) => boolean = () => true,
): Scenario {
  const s = ALL_SCENARIOS.find((x) => x.group === group && pred(x));
  if (!s) throw new Error(`no scenario in group ${group}`);
  return s;
}

/** Stub `fetch` with a script; returns the calls it received. */
export function stubScript(script: Parameters<typeof scriptedFetch>[0]) {
  const stub = scriptedFetch(script);
  vi.stubGlobal("fetch", stub.fetch);
  return stub.calls;
}

export function trialInput(s: Scenario) {
  return {
    markdown: fixtureFor(s).markdown,
    prompt: s.prompt,
    selectedText: s.selectedText,
    tier: s.tier,
    config: CONFIG,
  };
}

export async function runScripted(
  s: Scenario,
  script: Parameters<typeof scriptedFetch>[0],
): Promise<{ obs: TrialObservation; calls: ReturnType<typeof stubScript> }> {
  const calls = stubScript(script);
  const obs = await runTrial(trialInput(s));
  return { obs, calls };
}

/**
 * A `fetch` whose stream the test drives by hand: `push` a frame, `close` it,
 * or leave it stalled. It honours the request's abort signal the way a real
 * `fetch` does (the body errors with an AbortError).
 */
export function manualStream() {
  const enc = new TextEncoder();
  let controller: ReadableStreamDefaultController<Uint8Array> | null = null;
  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c;
    },
  });
  return {
    response: (init?: RequestInit) => {
      init?.signal?.addEventListener("abort", () => {
        try {
          controller?.error(new DOMException("The operation was aborted.", "AbortError"));
        } catch {
          // already closed
        }
      });
      return new Response(stream, { status: 200 });
    },
    push: (turn: ScriptedTurn) => {
      // Every frame except the terminating [DONE].
      for (const f of framesFor(turn).slice(0, -1)) controller?.enqueue(enc.encode(f));
    },
    close: () => {
      controller?.enqueue(enc.encode("data: [DONE]\n\n"));
      controller?.close();
    },
    fail: (err: Error) => controller?.error(err),
  };
}

/** Under fake timers: advance until `promise` settles. */
export async function advanceUntil<T>(
  promise: Promise<T>,
  stepMs = 1000,
  maxSteps = 2000,
): Promise<T> {
  let settled = false;
  let value: T | undefined;
  let error: unknown;
  promise.then(
    (v) => {
      settled = true;
      value = v;
    },
    (e) => {
      settled = true;
      error = e;
    },
  );
  for (let i = 0; i < maxSteps && !settled; i++) await vi.advanceTimersByTimeAsync(stepMs);
  if (!settled) throw new Error("promise did not settle under fake timers");
  if (error) throw error;
  return value as T;
}
