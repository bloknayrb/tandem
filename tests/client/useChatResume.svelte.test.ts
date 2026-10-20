/**
 * The resume row's state (#2196), driven by a reactive stand-in for the slice
 * of readiness it reads. What it must get right: a send records a request only
 * when a message will really start Claude, the row clears once Claude runs (so
 * a later idle stop does not resurrect it), the status is re-read soon after the
 * send, and the grace runs out on a timer rather than waiting for a re-render.
 */
import { flushSync } from "svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AiChip } from "../../src/client/hooks/useAiReadiness.svelte";
import { RESUME_GRACE_MS } from "../../src/client/panels/chat-resume";
import {
  type ChatResumeReadiness,
  createChatResume,
  RESUME_FIRST_READ_MS,
} from "../../src/client/panels/useChatResume.svelte";
import type { LauncherStandby } from "../../src/shared/launcher/contract";

function fakeReadiness() {
  const r = $state({
    launcherRunning: false,
    launcherRestarting: false,
    launcherStarting: false,
    launcherStandby: "off" as LauncherStandby | null,
    launcherStartsOnMessage: true,
    launcherRemedy: "start" as Exclude<AiChip, null> | null,
    serverUnreachable: false,
    lastClaudeMessageAt: null as number | null,
  });
  const refreshLauncherStatus = vi.fn();
  const afterLauncherAction = vi.fn();
  const readiness: ChatResumeReadiness = {
    get launcherRunning() {
      return r.launcherRunning;
    },
    get launcherRestarting() {
      return r.launcherRestarting;
    },
    get launcherStarting() {
      return r.launcherStarting;
    },
    get launcherStandby() {
      return r.launcherStandby;
    },
    get launcherStartsOnMessage() {
      return r.launcherStartsOnMessage;
    },
    get launcherRemedy() {
      return r.launcherRemedy;
    },
    get serverUnreachable() {
      return r.serverUnreachable;
    },
    refreshLauncherStatus,
  };
  return { r, readiness, refreshLauncherStatus, afterLauncherAction };
}

let dispose: (() => void) | null = null;
/** Read by the hook's `lastClaudeMessageAt`; a test sets it through `reply()`. */
const lastClaude = $state<{ at: number | null }>({ at: null });

function mount(readiness: ChatResumeReadiness, afterLauncherAction: () => void = () => {}) {
  let made!: ReturnType<typeof createChatResume>;
  dispose = $effect.root(() => {
    made = createChatResume(readiness, afterLauncherAction, () => lastClaude.at);
  });
  flushSync();
  return made;
}

beforeEach(() => {
  vi.useFakeTimers();
  lastClaude.at = null;
});

afterEach(() => {
  dispose?.();
  dispose = null;
  vi.useRealTimers();
});

describe("createChatResume", () => {
  it("a send that will start Claude shows the row and holds the toast back", () => {
    const { readiness } = fakeReadiness();
    const resume = mount(readiness);
    expect(resume.view).toBeNull();
    resume.noteSent();
    flushSync();
    expect(resume.view).toEqual({ kind: "resuming", verb: "starting" });
    expect(resume.pending).toBe(true);
  });

  it("a send that will not start Claude (another AI on, licence) records nothing", () => {
    const { r, readiness } = fakeReadiness();
    r.launcherStartsOnMessage = false;
    const resume = mount(readiness);
    resume.noteSent();
    flushSync();
    expect(resume.view).toBeNull();
    expect(resume.pending).toBe(false);
  });

  it("a send during the user's own Start is answered by it", () => {
    const { r, readiness } = fakeReadiness();
    r.launcherStartsOnMessage = false;
    r.launcherStarting = true;
    r.launcherRestarting = true;
    const resume = mount(readiness);
    resume.noteSent();
    flushSync();
    expect(resume.view).toMatchObject({ kind: "resuming" });
  });

  it("a later send replaces a stale request", () => {
    const { r, readiness } = fakeReadiness();
    const resume = mount(readiness);
    resume.noteSent();
    r.launcherStandby = null;
    r.launcherRemedy = "restart";
    flushSync();
    expect(resume.view).toEqual({ kind: "failed", remedy: "restart" });
    r.launcherStartsOnMessage = false;
    resume.noteSent();
    flushSync();
    expect(resume.view).toBeNull();
    expect(resume.pending).toBe(false);
  });

  it("clears once Claude runs, so a later idle stop does not bring the row back", () => {
    const { r, readiness } = fakeReadiness();
    const resume = mount(readiness);
    resume.noteSent();
    r.launcherRunning = true;
    r.launcherStandby = null;
    flushSync();
    expect(resume.view).toBeNull();
    // Idle-stopped again, long after.
    r.launcherRunning = false;
    r.launcherStandby = "idle";
    vi.advanceTimersByTime(RESUME_GRACE_MS * 2);
    flushSync();
    expect(resume.view).toBeNull();
    expect(resume.pending).toBe(false);
  });

  it("re-reads the launcher status soon after the send, and runs the launcher action's re-reads", () => {
    const { readiness, refreshLauncherStatus, afterLauncherAction } = fakeReadiness();
    const resume = mount(readiness, afterLauncherAction);
    resume.noteSent();
    flushSync();
    expect(afterLauncherAction).toHaveBeenCalledOnce();
    expect(refreshLauncherStatus).not.toHaveBeenCalled();
    vi.advanceTimersByTime(RESUME_FIRST_READ_MS);
    expect(refreshLauncherStatus).toHaveBeenCalledOnce();
  });

  it("a send that starts nothing runs no re-reads", () => {
    const { r, readiness, refreshLauncherStatus, afterLauncherAction } = fakeReadiness();
    r.launcherStartsOnMessage = false;
    const resume = mount(readiness, afterLauncherAction);
    resume.noteSent();
    flushSync();
    vi.advanceTimersByTime(RESUME_FIRST_READ_MS * 10);
    expect(afterLauncherAction).not.toHaveBeenCalled();
    expect(refreshLauncherStatus).not.toHaveBeenCalled();
  });

  it("a Claude reply after the send clears the row — some AI answered", () => {
    const { r, readiness } = fakeReadiness();
    const resume = mount(readiness);
    lastClaude.at = Date.now() - 1_000; // an older reply does not count
    resume.noteSent();
    r.launcherStandby = null;
    r.launcherRemedy = "restart";
    flushSync();
    expect(resume.view).toEqual({ kind: "failed", remedy: "restart" });
    lastClaude.at = Date.now() + 5;
    flushSync();
    expect(resume.view).toBeNull();
    expect(resume.pending).toBe(false);
  });

  it("the grace still ends when its timer fires against a clock stepped back", () => {
    const { readiness } = fakeReadiness();
    const resume = mount(readiness);
    resume.noteSent();
    flushSync();
    vi.setSystemTime(Date.now() - 5_000);
    vi.advanceTimersByTime(RESUME_GRACE_MS);
    flushSync();
    expect(resume.view).toEqual({ kind: "failed", remedy: "start" });
  });

  it("stops promising when the grace runs out with nothing begun — on a timer", () => {
    const { readiness } = fakeReadiness();
    const resume = mount(readiness);
    resume.noteSent();
    flushSync();
    expect(resume.view).toMatchObject({ kind: "resuming" });
    vi.advanceTimersByTime(RESUME_GRACE_MS);
    flushSync();
    expect(resume.view).toEqual({ kind: "failed", remedy: "start" });
  });
});
