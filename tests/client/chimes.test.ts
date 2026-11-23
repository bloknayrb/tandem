import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CHAT_SOUNDS } from "../../src/client/hooks/useTandemSettings";

/**
 * #2168: reply sounds are blends of recorded clips (public/chimes/).
 *
 * The frozen-clock rule (A1): a sound requested while the AudioContext is not
 * running, or before its clips are decoded, is never scheduled against the
 * frozen clock. One pending slot, latest wins, dropped after 2 s (10 s for a
 * preview). Loading: per-load deadlines, eviction on any failure, a copy to
 * `decodeAudioData` (which detaches its input), whole blend or nothing.
 */

const PUBLIC_CHIMES = join(__dirname, "../../public/chimes");

interface Deferred {
  resolve(): void;
  reject(err: unknown): void;
}

interface FakeNode {
  connections: FakeNode[];
  connect(node: FakeNode): void;
}

function node<T extends object>(extra: T): T & FakeNode {
  const n = {
    connections: [] as FakeNode[],
    connect(to: FakeNode) {
      n.connections.push(to);
    },
    ...extra,
  };
  return n;
}

interface Start {
  t: number;
  clip: string;
  rate: number;
  gain: number;
  pan: number;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** What a fake fetch of a clip does. */
type FetchMode = "ok" | "404" | "html" | "hang";

class FakeAudioContext {
  static instances: FakeAudioContext[] = [];
  state: AudioContextState = "suspended";
  currentTime = 0;
  sampleRate = 100;
  destination = node({});
  starts: Start[] = [];
  stops: number[] = [];
  resumes: Deferred[] = [];
  resumeThrows = false;
  decodeCalls = 0;
  decodeHangs = false;
  private seenBuffers = new WeakSet<ArrayBuffer>();

  constructor() {
    FakeAudioContext.instances.push(this);
  }

  resume(): Promise<void> {
    if (this.resumeThrows) throw new Error("resume threw");
    return new Promise<void>((resolve, reject) => {
      this.resumes.push({ resolve, reject });
    });
  }

  decodeAudioData(buf: ArrayBuffer): Promise<{ clip: string }> {
    this.decodeCalls++;
    // A real decode detaches its input: handing the same buffer over twice fails.
    if (this.seenBuffers.has(buf)) return Promise.reject(new TypeError("detached ArrayBuffer"));
    this.seenBuffers.add(buf);
    if (this.decodeHangs) return new Promise(() => {});
    const text = decoder.decode(buf);
    if (!text.startsWith("clip:")) return Promise.reject(new Error("EncodingError: not audio"));
    return Promise.resolve({ clip: text.slice("clip:".length) });
  }

  createGain() {
    return node({ gain: { value: 1, setTargetAtTime: vi.fn() } });
  }

  createStereoPanner() {
    return node({ pan: { value: 0 } });
  }

  createConvolver() {
    return node({ buffer: null as unknown });
  }

  createDynamicsCompressor() {
    const p = () => ({ value: 0 });
    return node({ threshold: p(), knee: p(), ratio: p(), attack: p(), release: p() });
  }

  createBuffer(_channels: number, length: number) {
    return { getChannelData: () => new Float32Array(length) };
  }

  createBufferSource() {
    const source = node({
      buffer: null as { clip: string } | null,
      playbackRate: { value: 1 },
      start: (t: number) => {
        const gain = source.connections[0] as FakeNode & { gain: { value: number } };
        const pan = gain.connections[0] as FakeNode & { pan: { value: number } };
        this.starts.push({
          t,
          clip: source.buffer?.clip ?? "?",
          rate: source.playbackRate.value,
          gain: gain.gain.value,
          pan: pan.pan.value,
        });
      },
      stop: (t: number) => {
        this.stops.push(t);
      },
    });
    return source;
  }
}

let fetchModes: Map<string, FetchMode>;
let fetchCalls: string[];

function fakeFetch(url: string, init?: { signal?: AbortSignal }) {
  fetchCalls.push(url);
  const clip = url.replace(/^\/chimes\//, "").replace(/\.wav$/, "");
  const mode = fetchModes.get(clip) ?? "ok";
  const body = (text: string) => encoder.encode(text).buffer as ArrayBuffer;
  if (mode === "hang") {
    return new Promise((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
    });
  }
  if (mode === "404")
    return Promise.resolve({ ok: false, status: 404, arrayBuffer: async () => body("") });
  if (mode === "html")
    return Promise.resolve({
      ok: true,
      status: 200,
      arrayBuffer: async () => body("<!doctype html>"),
    });
  return Promise.resolve({ ok: true, status: 200, arrayBuffer: async () => body(`clip:${clip}`) });
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

/** Let pending promise callbacks (fetch, decode, resume) run. */
async function flush(): Promise<void> {
  await vi.advanceTimersByTimeAsync(0);
}

/** Resume the latest pending `resume()` and let its callbacks run. */
async function resolveResume(c: FakeAudioContext, index = c.resumes.length - 1): Promise<void> {
  c.state = "running";
  c.resumes[index].resolve();
  await flush();
}

type Chimes = Awaited<ReturnType<typeof load>>;

/** Make the context running with every clip of `sound` decoded, then forget what played. */
async function warm(
  chimes: Chimes,
  sound: Parameters<Chimes["playChime"]>[0],
): Promise<FakeAudioContext> {
  chimes.playChime(sound, 100);
  const c = ctx();
  await resolveResume(c);
  expect(c.starts.length).toBeGreaterThan(0);
  c.starts = [];
  c.stops = [];
  return c;
}

describe("reply sounds (#2168)", () => {
  beforeEach(() => {
    FakeAudioContext.instances = [];
    fetchModes = new Map();
    fetchCalls = [];
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date", "performance"] });
    vi.stubGlobal("AudioContext", FakeAudioContext);
    vi.stubGlobal("fetch", vi.fn(fakeFetch));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  describe("the frozen-clock rule", () => {
    it("schedules synchronously on a running context once the clips are decoded", async () => {
      const chimes = await load();
      const c = await warm(chimes, "harp-glock");
      c.currentTime = 3;
      chimes.playChime("harp-glock", 100);
      expect(c.starts.map((s) => s.t).sort()).toEqual([3.01, 3.01, 3.17, 3.17]);
    });

    it("schedules once when a suspended context resumes within 2 s, against the clock read then", async () => {
      const chimes = await load();
      chimes.playChime("harp-glock", 100);
      const c = ctx();
      await flush();
      expect(c.starts).toEqual([]);
      vi.advanceTimersByTime(400);
      c.currentTime = 7;
      await resolveResume(c);
      expect(c.starts.map((s) => s.t).sort()).toEqual([7.01, 7.01, 7.17, 7.17]);
    });

    it("plays exactly one sound for three requests while suspended", async () => {
      const chimes = await load();
      chimes.playChime("harp-glock", 100);
      chimes.playChime("harp-glock", 100);
      chimes.playChime("harp-glock", 100);
      const c = ctx();
      expect(c.resumes).toHaveLength(3);
      c.state = "running";
      for (const pending of c.resumes) pending.resolve();
      await flush();
      expect(c.starts).toHaveLength(4);
    });

    it("drops a sound whose resume settles after 5 minutes", async () => {
      const chimes = await load();
      chimes.playChime("harp-glock", 100);
      const c = ctx();
      await vi.advanceTimersByTimeAsync(5 * 60_000);
      await resolveResume(c);
      expect(c.starts).toEqual([]);
    });

    it("does not schedule if the context is still not running after resume", async () => {
      const chimes = await load();
      const status = chimes.previewChime("harp-glock", 100);
      const c = ctx();
      c.resumes[0].resolve();
      await flush();
      expect(await status).toBe("not-running");
      expect(c.starts).toEqual([]);
    });

    it("does not schedule if the context was suspended again before the clips finished loading", async () => {
      const chimes = await load();
      const c = await warm(chimes, "harp-glock");
      // Running, so no resume() is asked for; the cold clips load while the
      // context is interrupted, and the state is read when they settle.
      const status = chimes.previewChime("piano-vibes", 100);
      c.state = "suspended";
      await flush();
      expect(await status).toBe("not-running");
      expect(c.starts).toEqual([]);
    });

    it("does not throw when resume rejects or throws", async () => {
      const chimes = await load();
      chimes.playChime("harp-glock", 100);
      const c = ctx();
      c.resumes[0].reject(new Error("denied"));
      await flush();
      expect(c.starts).toEqual([]);
      c.resumeThrows = true;
      expect(() => chimes.playChime("harp-glock", 100)).not.toThrow();
      await flush();
      expect(c.starts).toEqual([]);
    });

    it("plays nothing, and creates no context, for sound none or volume 0", async () => {
      const chimes = await load();
      chimes.playChime("none", 100);
      chimes.playChime("harp-glock", 0);
      expect(await chimes.previewChime("none", 100)).toBe("skipped");
      expect(FakeAudioContext.instances).toHaveLength(0);
      expect(fetchCalls).toEqual([]);
    });
  });

  describe("the blends", () => {
    it("plays each instrument on G6 then C6 160 ms later, at the measured rate, 0.9 on the low note", async () => {
      const chimes = await load();
      const c = await warm(chimes, "vibes-low-marimba");
      chimes.playChime("vibes-low-marimba", 100);
      const byClip = Object.fromEntries(c.starts.map((s) => [s.clip, s]));
      expect(Object.keys(byClip).sort()).toEqual([
        "marimba_hi",
        "marimba_lo",
        "vibes_hi",
        "vibes_lo",
      ]);
      expect(byClip.vibes_hi.t).toBeCloseTo(0.01);
      expect(byClip.vibes_lo.t).toBeCloseTo(0.17);
      expect(byClip.vibes_hi.rate).toBeCloseTo(chimes.TUNING.vibes[0]);
      // The marimba plays an octave down: half its tuned rate.
      expect(byClip.marimba_hi.rate).toBeCloseTo(chimes.TUNING.marimba[0] / 2);
      expect(byClip.marimba_lo.rate).toBeCloseTo(chimes.TUNING.marimba[1] / 2);
      expect(byClip.vibes_hi.gain).toBeCloseTo(0.7 * 0.7);
      expect(byClip.vibes_lo.gain).toBeCloseTo(0.7 * 0.7 * 0.9);
      expect(byClip.marimba_hi.gain).toBeCloseTo(0.7 * 0.55);
      expect(byClip.vibes_hi.pan).toBeCloseTo(-0.12);
      expect(byClip.vibes_lo.pan).toBeCloseTo(0.12);
    });

    it("delays the chimes 8 ms behind the xylophone tap", async () => {
      const chimes = await load();
      const c = await warm(chimes, "xylo-chimes");
      chimes.playChime("xylo-chimes", 100);
      const t = Object.fromEntries(c.starts.map((s) => [s.clip, s.t]));
      expect(t.xylo_hi).toBeCloseTo(0.01);
      expect(t.chimes_hi).toBeCloseTo(0.018);
      expect(t.chimes_lo).toBeCloseTo(0.178);
    });

    it("plays the glockenspiel on the high note only and the vibraphone on the low note only", async () => {
      const chimes = await load();
      const c = await warm(chimes, "glock-to-vibes");
      chimes.playChime("glock-to-vibes", 100);
      expect(c.starts.map((s) => [s.clip, Number(s.t.toFixed(3))])).toEqual([
        ["glock_hi", 0.01],
        ["vibes_lo", 0.17],
      ]);
    });

    it("every sound but none has a blend, and every clip it needs has a tuning", async () => {
      const chimes = await load();
      const sounds = CHAT_SOUNDS.filter((s) => s !== "none");
      expect(Object.keys(chimes.BLENDS).sort()).toEqual([...sounds].sort());
      for (const sound of sounds) {
        for (const clip of chimes.clipsFor(sound)) {
          const [instrument] = clip.split("_");
          expect(chimes.TUNING, `${sound}: ${clip}`).toHaveProperty(instrument);
        }
      }
    });

    it("every clip is a file in public/chimes, every file is used, and the licence file lists each with its hash", async () => {
      const chimes = await load();
      const used = new Set(
        CHAT_SOUNDS.filter((s) => s !== "none").flatMap((s) => chimes.clipsFor(s)),
      );
      const files = readdirSync(PUBLIC_CHIMES).filter((f) => f.endsWith(".wav"));
      expect(files.map((f) => f.replace(/\.wav$/, "")).sort()).toEqual([...used].sort());
      const licence = readFileSync(join(PUBLIC_CHIMES, "LICENSE-VCSL.txt"), "utf8");
      expect(licence).toContain("CC0 1.0 Universal");
      for (const file of files) {
        const hash = createHash("sha256")
          .update(readFileSync(join(PUBLIC_CHIMES, file)))
          .digest("hex");
        expect(licence, file).toMatch(new RegExp(`${file}[^\\n]*\\n\\s+${hash}`));
      }
    });
  });

  describe("loading", () => {
    it("waits for a cold clip on a running context, and concurrent requests share one fetch per clip", async () => {
      const chimes = await load();
      const c = await warm(chimes, "harp-glock");
      const before = fetchCalls.length;
      chimes.playChime("piano-vibes", 100);
      chimes.playChime("piano-vibes", 100);
      expect(c.starts).toEqual([]);
      await flush();
      expect(fetchCalls.length - before).toBe(4);
      expect(c.starts).toHaveLength(4);
    });

    it("a 404 fails the preview, plays nothing, warns once, and the next play refetches", async () => {
      const chimes = await load();
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      await warm(chimes, "harp-glock");
      fetchModes.set("piano_hi", "404");
      const c = ctx();
      expect(await chimes.previewChime("piano-vibes", 100)).toBe("failed");
      expect(c.starts).toEqual([]);
      expect(await chimes.previewChime("piano-vibes", 100)).toBe("failed");
      expect(warn).toHaveBeenCalledTimes(1);
      fetchModes.delete("piano_hi");
      const calls = fetchCalls.filter((u) => u.includes("piano_hi")).length;
      expect(await chimes.previewChime("piano-vibes", 100)).toBe("played");
      expect(fetchCalls.filter((u) => u.includes("piano_hi")).length).toBe(calls + 1);
    });

    it("an HTML body (the SPA fallback for a missing file) fails at decode and is refetched next time", async () => {
      const chimes = await load();
      vi.spyOn(console, "warn").mockImplementation(() => {});
      await warm(chimes, "harp-glock");
      fetchModes.set("piano_lo", "html");
      expect(await chimes.previewChime("piano-vibes", 100)).toBe("failed");
      fetchModes.delete("piano_lo");
      expect(await chimes.previewChime("piano-vibes", 100)).toBe("played");
    });

    it("plays the whole blend or nothing: one missing clip silences the sound", async () => {
      const chimes = await load();
      vi.spyOn(console, "warn").mockImplementation(() => {});
      const c = await warm(chimes, "harp-glock");
      fetchModes.set("vibes_lo", "404");
      chimes.playChime("piano-vibes", 100);
      await flush();
      expect(c.starts).toEqual([]);
    });

    it("a fetch that never answers is abandoned at 8 s, fails the preview, and is fetched again next time", async () => {
      const chimes = await load();
      vi.spyOn(console, "warn").mockImplementation(() => {});
      await warm(chimes, "harp-glock");
      fetchModes.set("piano_hi", "hang");
      let status: string | undefined;
      void chimes.previewChime("piano-vibes", 100).then((s) => {
        status = s;
      });
      await vi.advanceTimersByTimeAsync(7_999);
      expect(status).toBeUndefined();
      fetchModes.delete("piano_hi");
      await vi.advanceTimersByTimeAsync(1);
      expect(status).toBe("failed");
      expect(await chimes.previewChime("piano-vibes", 100)).toBe("played");
    });

    it("a preview still waiting on resume() after 10 s reports timeout", async () => {
      const chimes = await load();
      const status = chimes.previewChime("harp-glock", 100);
      await vi.advanceTimersByTimeAsync(10_000);
      expect(await status).toBe("timeout");
      expect(ctx().starts).toEqual([]);
    });

    it("a reply sound whose load outlasts 2 s is dropped, but the load still fills the cache", async () => {
      const chimes = await load();
      const c = await warm(chimes, "harp-glock");
      fetchModes.set("piano_hi", "hang");
      chimes.playChime("piano-vibes", 100);
      await vi.advanceTimersByTimeAsync(2_001);
      fetchModes.delete("piano_hi");
      // The hung fetch is abandoned at 8 s; a fresh one then fills the cache.
      await vi.advanceTimersByTimeAsync(8_000);
      expect(c.starts).toEqual([]);
      expect(await chimes.previewChime("piano-vibes", 100)).toBe("played");
      c.starts = [];
      chimes.playChime("piano-vibes", 100);
      expect(c.starts).toHaveLength(4);
    });

    it("a decode that hangs marks the clip undecodable for the page instead of starting another hung decode", async () => {
      const chimes = await load();
      vi.spyOn(console, "warn").mockImplementation(() => {});
      const c = await warm(chimes, "harp-glock");
      c.decodeHangs = true;
      const status = chimes.previewChime("piano-vibes", 100);
      await vi.advanceTimersByTimeAsync(8_000);
      expect(await status).toBe("failed");
      const decodes = c.decodeCalls;
      c.decodeHangs = false;
      // All four decodes hung, so none is started again.
      expect(await chimes.previewChime("piano-vibes", 100)).toBe("failed");
      expect(c.decodeCalls).toBe(decodes);
    });

    it("preloadChimes fetches the clips without creating an AudioContext", async () => {
      const chimes = await load();
      chimes.preloadChimes("vibes-low-marimba");
      await flush();
      expect(FakeAudioContext.instances).toHaveLength(0);
      expect(fetchCalls.sort()).toEqual([
        "/chimes/marimba_hi.wav",
        "/chimes/marimba_lo.wav",
        "/chimes/vibes_hi.wav",
        "/chimes/vibes_lo.wav",
      ]);
      chimes.playChime("vibes-low-marimba", 100);
      await resolveResume(ctx());
      expect(fetchCalls).toHaveLength(4);
      expect(ctx().starts).toHaveLength(4);
    });
  });

  describe("previews", () => {
    it("a newer request supersedes a pending preview, and the pending one reports superseded", async () => {
      const chimes = await load();
      const c = await warm(chimes, "harp-glock");
      fetchModes.set("piano_hi", "hang");
      const first = chimes.previewChime("piano-vibes", 100);
      const second = chimes.previewChime("harp-glock", 100);
      expect(await second).toBe("played");
      await vi.advanceTimersByTimeAsync(10_000);
      expect(await first).toBe("superseded");
      expect(c.starts.every((s) => s.clip.startsWith("harp") || s.clip.startsWith("glock"))).toBe(
        true,
      );
    });

    it("choosing None supersedes a pending preview", async () => {
      const chimes = await load();
      const c = await warm(chimes, "harp-glock");
      fetchModes.set("piano_hi", "hang");
      const pending = chimes.previewChime("piano-vibes", 100);
      expect(await chimes.previewChime("none", 100)).toBe("skipped");
      fetchModes.delete("piano_hi");
      await vi.advanceTimersByTimeAsync(10_000);
      expect(await pending).toBe("superseded");
      expect(c.starts).toEqual([]);
    });

    it("a preview stops the previous preview's sources but never a reply sound that is playing", async () => {
      const chimes = await load();
      const c = await warm(chimes, "harp-glock");
      chimes.playChime("harp-glock", 100);
      expect(await chimes.previewChime("harp-glock", 100)).toBe("played");
      expect(c.stops).toEqual([]);
      expect(await chimes.previewChime("harp-glock", 100)).toBe("played");
      // Only the first preview's four sources were stopped.
      expect(c.stops).toHaveLength(4);
    });
  });
});
