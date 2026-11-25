import type { ChatSound } from "../hooks/useTandemSettings";

/**
 * Reply sounds (#2168): short phrases played on recorded instruments. Each
 * sound is the same falling fifth, G6 then C6 160 ms later, played on a blend
 * of real recordings. The OS notification is posted without a sound, so this
 * is the only one.
 *
 * **The recordings.** Sixteen clips in `public/chimes/` (eight instruments,
 * one clip per note), excerpts of the Versilian Community Sample Library,
 * which is CC0 1.0; `public/chimes/LICENSE-VCSL.txt` records each clip's
 * source and hash, and `scripts/chimes/prepare-samples.py` how they were cut.
 * They are 16-bit PCM WAV because every webview decodes PCM with nothing
 * extra installed. They are loaded with `fetch` (same origin, so the desktop
 * CSP's `connect-src 'self'` covers it; no `media-src` change) and decoded
 * with `decodeAudioData`. `TUNING` holds each clip's measured playback rate:
 * VCSL's note names are not reliable, so the rates come from the measured
 * fundamental, never the file name.
 *
 * **The mix** matches the audition page the sounds were chosen on, at its
 * default settings: each source at 0.7 × its layer volume (× 0.9 on the low
 * note), panned −0.12 / +0.12, a 0.12 send into a short generated reverb, and
 * a gentle compressor before the output. Volume scales each play's own
 * output, so a later play at another volume never changes one still ringing.
 * These are louder than the old synthesized chimes at the same setting; the
 * compressor tames peaks but is not a hard ceiling.
 *
 * **Autoplay and the frozen clock.** In a browser, an `AudioContext` created
 * without a prior user gesture starts `suspended`; `armChimes()` resumes it on
 * the first pointer/key input. The desktop webviews (WebView2, WKWebView,
 * WebKitGTK) allow autoplay, so `resume()` succeeds there and only takes a
 * moment. A suspended context's `currentTime` does not advance, so sounds
 * scheduled on it would all fire together when it resumes. A sound is
 * therefore scheduled only on a running context with all its clips decoded.
 * Otherwise the request takes ONE pending slot (the latest request wins) and
 * plays only if `resume()` and every clip's load have settled, the context is
 * running and every clip decoded, within `MAX_RESUME_WAIT_MS` of the request
 * (a stale sound is worse than none; the notification and title count still
 * carry it). A preview, which the user is waiting on, gets
 * `MAX_PREVIEW_WAIT_MS` so a first load is not dropped. A sound plays whole
 * or not at all: a blend missing an instrument is a sound nobody chose.
 *
 * **Loading.** Every fetch and decode has its own deadline, and any failure
 * (a non-OK response, a rejected fetch, an undecodable body such as the SPA
 * fallback's HTML for a missing file, or a missed deadline) evicts that clip
 * from every cache, so the next play starts it over and a stalled load can
 * never pin a clip for the session. The one exception is a decode that hangs
 * past its deadline: it cannot be cancelled, so that clip is not retried until
 * the page reloads. `decodeAudioData` detaches the buffer it is given, so it
 * gets a copy: no path decodes cached bytes twice today, and the copy keeps a
 * future one from failing on a detached buffer. Fetch and decode deadlines run one after the other, so a
 * very slow first load can outlast a preview's wait; it still fills the cache
 * and the next preview plays at once.
 */

type Instrument = "glock" | "vibes" | "marimba" | "chimes" | "harp" | "xylo" | "piano" | "balafon";
type NoteName = "hi" | "lo";
export type ReplySound = Exclude<ChatSound, "none">;

/** One instrument in a blend: [instrument, volume, octave shift, delay in ms]. */
type Layer = readonly [instrument: Instrument, volume: number, octave?: number, delayMs?: number];

interface Blend {
  /** Layers that play both notes. */
  readonly both: readonly Layer[];
  /** Layers that play only the high note. */
  readonly hi?: readonly Layer[];
  /** Layers that play only the low note. */
  readonly lo?: readonly Layer[];
}

/** Playback rate that lands each clip on G6 (hi) and C6 (lo), from its measured fundamental. */
export const TUNING: Readonly<Record<Instrument, readonly [hi: number, lo: number]>> = {
  glock: [0.99302, 0.99307],
  vibes: [1.18913, 1.0001],
  marimba: [1.12376, 1.05942],
  chimes: [1.05845, 0.99914],
  harp: [1.12618, 1.06482],
  xylo: [0.9907, 0.99119],
  piano: [1.06009, 1.00048],
  balafon: [1.13171, 1.00048],
};

export const BLENDS: Readonly<Record<ReplySound, Blend>> = {
  "marimba-glock": {
    both: [
      ["marimba", 0.8],
      ["glock", 0.35],
    ],
  },
  "harp-glock": {
    both: [
      ["harp", 0.75],
      ["glock", 0.45],
    ],
  },
  "piano-vibes": {
    both: [
      ["piano", 0.65],
      ["vibes", 0.55],
    ],
  },
  "vibes-low-marimba": {
    both: [
      ["vibes", 0.7],
      ["marimba", 0.55, -1],
    ],
  },
  "glock-to-vibes": { both: [], hi: [["glock", 0.8]], lo: [["vibes", 0.95]] },
  "balafon-chimes": {
    both: [
      ["balafon", 0.6],
      ["chimes", 0.6],
    ],
  },
  "xylo-chimes": {
    both: [
      ["xylo", 0.35],
      ["chimes", 0.8, 0, 8],
    ],
  },
  "harp-vibes-glock": {
    both: [
      ["harp", 0.55],
      ["vibes", 0.5],
      ["glock", 0.3],
    ],
  },
  "chimes-low-harp": {
    both: [
      ["chimes", 0.7],
      ["harp", 0.5, -1],
    ],
  },
};

const NOTE_GAP_S = 0.16;
const LAYER_GAIN = 0.7;
const LOW_NOTE_GAIN = 0.9;
const PAN = 0.12;
const REVERB_SEND = 0.12;
const START_OFFSET_S = 0.01;
const PREVIEW_FADE_S = 0.03;

/**
 * How long a reply sound may wait for `resume()` and loading. Long enough for
 * a desktop cold start; far shorter than a browser tab left untouched until
 * the user's first click.
 */
const MAX_RESUME_WAIT_MS = 2_000;
/** How long a preview may wait: the user asked for it and is listening. */
const MAX_PREVIEW_WAIT_MS = 10_000;
/** Deadline for one clip's fetch, and separately for its decode. */
const LOAD_DEADLINE_MS = 8_000;

export type ChimeStatus =
  | "played"
  | "skipped"
  | "superseded"
  | "not-running"
  | "failed"
  | "timeout";

interface Bus {
  master: GainNode;
  reverb: ConvolverNode;
}

interface Voice {
  sources: AudioBufferSourceNode[];
  outputs: GainNode[];
}

let context: AudioContext | null = null;
let bus: Bus | null = null;
let armed = false;
// Bumped by every request: a pending (resume- or load-gated) sound plays only
// if no later request has superseded it, so at most one is ever waiting.
let latestRequest = 0;
let previewVoice: Voice | null = null;

const bytes = new Map<string, Promise<ArrayBuffer>>();
const decoding = new Map<string, Promise<AudioBuffer>>();
const ready = new Map<string, AudioBuffer>();
/** Clips whose decode hung: not retried for the rest of the page's life. */
const undecodable = new Set<string>();
const warned = new Set<string>();

function clipKey(instrument: Instrument, note: NoteName): string {
  return `${instrument}_${note}`;
}

/**
 * Root-absolute on the page's own origin, never the API base (on desktop that
 * is another origin). The client is always served at the root.
 */
export function clipUrl(clip: string): string {
  return `/chimes/${clip}.wav`;
}

/** Every clip a sound needs. */
export function clipsFor(sound: ReplySound): string[] {
  const blend = BLENDS[sound];
  const clips = new Set<string>();
  for (const [instrument] of blend.both) {
    clips.add(clipKey(instrument, "hi"));
    clips.add(clipKey(instrument, "lo"));
  }
  for (const [instrument] of blend.hi ?? []) clips.add(clipKey(instrument, "hi"));
  for (const [instrument] of blend.lo ?? []) clips.add(clipKey(instrument, "lo"));
  return [...clips];
}

function getContext(): AudioContext | null {
  if (context) return context;
  try {
    const Ctor =
      typeof window !== "undefined"
        ? (window.AudioContext ??
          (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext)
        : undefined;
    if (!Ctor) return null;
    context = new Ctor();
    return context;
  } catch {
    return null;
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

class DeadlineError extends Error {}

/** Reject with a `DeadlineError` if `promise` has not settled within `ms`. */
function withDeadline<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new DeadlineError(`${what} timed out`)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

function fetchBytes(clip: string): Promise<ArrayBuffer> {
  const cached = bytes.get(clip);
  if (cached) return cached;
  // AbortController + timer rather than AbortSignal.timeout(): the latter is
  // missing from Safari 15, the macOS 12 floor.
  const controller = typeof AbortController !== "undefined" ? new AbortController() : null;
  const load = (async () => {
    const res = await fetch(clipUrl(clip), controller ? { signal: controller.signal } : undefined);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.arrayBuffer();
  })();
  const promise = withDeadline(load, LOAD_DEADLINE_MS, "fetch");
  promise.catch(() => {
    controller?.abort();
    if (bytes.get(clip) === promise) bytes.delete(clip);
  });
  bytes.set(clip, promise);
  return promise;
}

function loadClip(ctx: AudioContext, clip: string): Promise<AudioBuffer> {
  const done = ready.get(clip);
  if (done) return Promise.resolve(done);
  if (undecodable.has(clip)) return Promise.reject(new Error(`${clip} could not be decoded`));
  const cached = decoding.get(clip);
  if (cached) return cached;
  const source = fetchBytes(clip);
  const promise = source
    .then((buf) =>
      withDeadline(ctx.decodeAudioData(buf.slice(0)), LOAD_DEADLINE_MS, "decode").catch(
        (err: unknown) => {
          // A decode that hangs (a webview missing its PCM decoder) cannot be
          // cancelled; retrying would start another hung decode on every play.
          if (err instanceof DeadlineError) undecodable.add(clip);
          throw err;
        },
      ),
    )
    .then((decoded) => {
      ready.set(clip, decoded);
      return decoded;
    });
  decoding.set(clip, promise);
  promise.then(
    () => {
      if (decoding.get(clip) === promise) decoding.delete(clip);
    },
    (err: unknown) => {
      if (decoding.get(clip) === promise) decoding.delete(clip);
      if (bytes.get(clip) === source) bytes.delete(clip);
      if (!warned.has(clip)) {
        warned.add(clip);
        console.warn(`[notifications] reply sound clip ${clip} failed to load:`, err);
      }
    },
  );
  return promise;
}

/**
 * Fetch (not decode) the clips a sound needs, so its first play doesn't wait
 * on the network. Creates no `AudioContext`, so it is safe before any gesture.
 */
export function preloadChimes(sound: ChatSound): void {
  if (sound === "none" || !BLENDS[sound] || typeof fetch !== "function") return;
  for (const clip of clipsFor(sound)) fetchBytes(clip).catch(() => {});
}

/** Resume the audio context on the first user input. Idempotent. */
export function armChimes(): void {
  if (armed || typeof window === "undefined") return;
  armed = true;
  const resume = () => {
    window.removeEventListener("pointerdown", resume, true);
    window.removeEventListener("keydown", resume, true);
    void getContext()
      ?.resume()
      .catch(() => {});
  };
  window.addEventListener("pointerdown", resume, true);
  window.addEventListener("keydown", resume, true);
}

/** Play a reply sound at `volume` (0–100). Best-effort: never throws. */
export function playChime(sound: ChatSound, volume: number): void {
  void request(sound, volume, MAX_RESUME_WAIT_MS, false);
}

/**
 * Play a sound from Settings. Stops any earlier preview still sounding, so
 * moving through the list doesn't stack phrases. Resolves with what happened;
 * never rejects.
 */
export function previewChime(sound: ChatSound, volume: number): Promise<ChimeStatus> {
  return request(sound, volume, MAX_PREVIEW_WAIT_MS, true);
}

async function request(
  sound: ChatSound,
  volume: number,
  waitMs: number,
  preview: boolean,
): Promise<ChimeStatus> {
  // Even a request that plays nothing supersedes a pending one: choosing None,
  // or dragging the volume to 0, must not let an earlier preview play later.
  const id = ++latestRequest;
  if (preview && context) stopPreview(context);
  const blend = sound === "none" || !(volume > 0) ? undefined : BLENDS[sound];
  if (!blend) return "skipped";
  const ctx = getContext();
  if (!ctx) return "failed";
  const clips = clipsFor(sound as ReplySound);

  if (ctx.state === "running" && clips.every((clip) => ready.has(clip))) {
    return play(ctx, blend, volume, preview);
  }

  const requestedAt = performance.now();
  let resumed: Promise<unknown>;
  try {
    resumed = ctx.state === "running" ? Promise.resolve() : ctx.resume();
  } catch (err) {
    resumed = Promise.reject(err);
  }
  const settled = Promise.allSettled([resumed, ...clips.map((clip) => loadClip(ctx, clip))]);
  const first = await Promise.race([
    settled.then(() => "settled" as const),
    delay(waitMs).then(() => "timeout" as const),
  ]);
  if (id !== latestRequest) return "superseded";
  if (first === "timeout" || performance.now() - requestedAt > waitMs) return "timeout";
  if (ctx.state !== "running") return "not-running";
  if (!clips.every((clip) => ready.has(clip))) return "failed";
  return play(ctx, blend, volume, preview);
}

function play(ctx: AudioContext, blend: Blend, volume: number, preview: boolean): ChimeStatus {
  const voice = scheduleBlend(ctx, blend, volume);
  if (!voice) return "failed";
  if (preview) previewVoice = voice;
  return "played";
}

function stopPreview(ctx: AudioContext): void {
  const voice = previewVoice;
  previewVoice = null;
  if (!voice) return;
  try {
    const now = ctx.currentTime;
    for (const output of voice.outputs) output.gain.setTargetAtTime(0, now, PREVIEW_FADE_S / 3);
    for (const source of voice.sources) source.stop(now + PREVIEW_FADE_S);
  } catch {
    // A source that already ended may refuse stop(); nothing left to silence.
  }
}

function getBus(ctx: AudioContext): Bus {
  if (bus) return bus;
  const compressor = ctx.createDynamicsCompressor();
  compressor.threshold.value = -8;
  compressor.knee.value = 6;
  compressor.ratio.value = 3;
  compressor.attack.value = 0.003;
  compressor.release.value = 0.2;
  const master = ctx.createGain();
  master.connect(compressor);
  compressor.connect(ctx.destination);
  const reverb = ctx.createConvolver();
  reverb.buffer = impulse(ctx, 1.6, 3.2);
  reverb.connect(master);
  bus = { master, reverb };
  return bus;
}

/** A small room: stereo noise with a power-curve decay. */
function impulse(ctx: AudioContext, seconds: number, decay: number): AudioBuffer {
  const length = Math.floor(ctx.sampleRate * seconds);
  const buffer = ctx.createBuffer(2, length, ctx.sampleRate);
  for (let channel = 0; channel < 2; channel++) {
    const data = buffer.getChannelData(channel);
    for (let i = 0; i < length; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / length) ** decay;
  }
  return buffer;
}

/** Schedule `blend` relative to the context clock as read now. */
function scheduleBlend(ctx: AudioContext, blend: Blend, volume: number): Voice | null {
  try {
    const { master, reverb } = getBus(ctx);
    const level = Math.min(1, volume / 100);
    const dry = ctx.createGain();
    dry.gain.value = level;
    dry.connect(master);
    const wet = ctx.createGain();
    wet.gain.value = level;
    wet.connect(reverb);
    const start = ctx.currentTime + START_OFFSET_S;
    const sources: AudioBufferSourceNode[] = [];

    const note = (layer: Layer, name: NoteName) => {
      const [instrument, layerVolume, octave = 0, delayMs = 0] = layer;
      const buffer = ready.get(clipKey(instrument, name));
      if (!buffer) return;
      const source = ctx.createBufferSource();
      source.buffer = buffer;
      source.playbackRate.value = TUNING[instrument][name === "hi" ? 0 : 1] * 2 ** octave;
      const gain = ctx.createGain();
      gain.gain.value = LAYER_GAIN * layerVolume * (name === "lo" ? LOW_NOTE_GAIN : 1);
      const pan = ctx.createStereoPanner();
      pan.pan.value = name === "hi" ? -PAN : PAN;
      const send = ctx.createGain();
      send.gain.value = REVERB_SEND;
      source.connect(gain);
      gain.connect(pan);
      pan.connect(dry);
      pan.connect(send);
      send.connect(wet);
      source.start(start + (name === "lo" ? NOTE_GAP_S : 0) + delayMs / 1000);
      sources.push(source);
    };

    for (const layer of blend.both) {
      note(layer, "hi");
      note(layer, "lo");
    }
    for (const layer of blend.hi ?? []) note(layer, "hi");
    for (const layer of blend.lo ?? []) note(layer, "lo");
    return { sources, outputs: [dry, wet] };
  } catch (err) {
    console.warn("[notifications] reply sound failed:", err);
    return null;
  }
}
