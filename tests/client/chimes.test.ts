import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * #2168 A1: a chime requested while the AudioContext is not running must not
 * be scheduled against the frozen clock (N requests would fire as one burst on
 * resume). One pending slot, latest wins, dropped after 2 s.
 */

interface Deferred {
  resolve(): void;
  reject(err: unknown): void;
}

class FakeAudioContext {
  static instances: FakeAudioContext[] = [];
  state: AudioContextState = "suspended";
  currentTime = 0;
  destination = {};
  starts: number[] = [];
  resumes: Deferred[] = [];
  resumeThrows = false;

  constructor() {
    FakeAudioContext.instances.push(this);
  }

  resume(): Promise<void> {
    if (this.resumeThrows) throw new Error("resume threw");
    return new Promise<void>((resolve, reject) => {
      this.resumes.push({ resolve, reject });
    });
  }

  createOscillator() {
    return {
      type: "sine",
      frequency: { value: 0 },
      connect: () => {},
      start: (t: number) => {
        this.starts.push(t);
      },
      stop: () => {},
    };
  }

  createGain() {
    return {
      gain: {
        setValueAtTime: () => {},
        exponentialRampToValueAtTime: () => {},
      },
      connect: () => {},
    };
  }
}

async function load() {
  vi.resetModules();
  return import("../../src/client/notifications/chimes");
}

function ctx(): FakeAudioContext {
  const instance = FakeAudioContext.instances.at(-1);
  if (!instance) throw new Error("no AudioContext was created");
  return instance;
}

/** Resume the latest pending `resume()` and let its `.then` run. */
async function resolveResume(c: FakeAudioContext, index = c.resumes.length - 1): Promise<void> {
  c.state = "running";
  c.resumes[index].resolve();
  await vi.advanceTimersByTimeAsync(0);
}

describe("playChime (#2168)", () => {
  beforeEach(() => {
    FakeAudioContext.instances = [];
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date", "performance"] });
    vi.stubGlobal("AudioContext", FakeAudioContext);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("schedules synchronously on a running context", async () => {
    const { playChime } = await load();
    playChime("ping", 100);
    // First call creates the context suspended; make a running one.
    const c = ctx();
    c.state = "running";
    c.currentTime = 3;
    playChime("ping", 100);
    expect(c.starts).toEqual([3.01]);
  });

  it("schedules once when a suspended context resumes within 2 s", async () => {
    const { playChime } = await load();
    playChime("ping", 100);
    const c = ctx();
    expect(c.starts).toEqual([]);
    vi.advanceTimersByTime(400);
    // Scheduled against the clock as read at resolve time, not request time.
    c.currentTime = 7;
    await resolveResume(c);
    expect(c.starts).toEqual([7.01]);
  });

  it("plays exactly one chime for three requests while suspended", async () => {
    const { playChime } = await load();
    playChime("ping", 100);
    playChime("ping", 100);
    playChime("ping", 100);
    const c = ctx();
    expect(c.resumes).toHaveLength(3);
    c.state = "running";
    for (const pending of c.resumes) pending.resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(c.starts).toHaveLength(1);
  });

  it("drops a chime whose resume settles after 5 minutes", async () => {
    const { playChime } = await load();
    playChime("ping", 100);
    const c = ctx();
    vi.advanceTimersByTime(5 * 60_000);
    await resolveResume(c);
    expect(c.starts).toEqual([]);
  });

  it("does not schedule if the context is still not running after resume", async () => {
    const { playChime } = await load();
    playChime("ping", 100);
    const c = ctx();
    c.resumes[0].resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(c.starts).toEqual([]);
  });

  it("does not throw when resume rejects or throws", async () => {
    const { playChime } = await load();
    playChime("ping", 100);
    const c = ctx();
    c.resumes[0].reject(new Error("denied"));
    await vi.advanceTimersByTimeAsync(0);
    expect(c.starts).toEqual([]);
    c.resumeThrows = true;
    expect(() => playChime("ping", 100)).not.toThrow();
    expect(c.starts).toEqual([]);
  });

  it("plays nothing for sound none or volume 0", async () => {
    const { playChime } = await load();
    playChime("none", 100);
    playChime("ping", 0);
    expect(FakeAudioContext.instances).toHaveLength(0);
  });
});
