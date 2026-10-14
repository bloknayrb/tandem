import type { ChatSound } from "../hooks/useTandemSettings";

/**
 * Reply chimes (#2168), synthesized with Web Audio rather than shipped as
 * files: no `media-src` CSP change, no asset licensing, identical on every OS.
 * The OS notification is posted without a sound, so this is the only chime.
 *
 * Autoplay policy: in a browser, an `AudioContext` created without a prior
 * user gesture starts `suspended`. `armChimes()` resumes it on the first
 * pointer/key input, after which a chime can play while the window is in the
 * background. The desktop webviews are different: wry turns autoplay on for
 * all three (WebView2, WKWebView, WebKitGTK), so there `resume()` succeeds
 * without a gesture and only takes a moment.
 *
 * A chime requested while the context is not running is therefore never
 * scheduled against the frozen clock. A suspended context's `currentTime`
 * does not advance, so notes scheduled "now" on it all fire together the
 * moment it resumes — N replies before the first click in a browser tab used
 * to play as one N × `MAX_GAIN` burst. Instead there is ONE pending slot: the
 * latest request wins, and it plays only if `resume()` settles to `running`
 * within `MAX_RESUME_WAIT_MS`. That keeps the first desktop chime after a cold
 * or hidden launch, and drops a browser chime requested minutes before the
 * user's first click (a stale sound is worse than none — the notification and
 * the title count still carry it).
 */

interface Note {
  /** Frequency in Hz. */
  freq: number;
  /** Start offset in seconds. */
  at: number;
  /** Decay time in seconds. */
  decay: number;
  type: OscillatorType;
}

const PRESETS: Readonly<Record<Exclude<ChatSound, "none">, readonly Note[]>> = {
  // Two rising sine notes — the default.
  chime: [
    { freq: 784, at: 0, decay: 0.45, type: "sine" },
    { freq: 1175, at: 0.12, decay: 0.6, type: "sine" },
  ],
  // One note with a quiet octave partial, long tail.
  bell: [
    { freq: 660, at: 0, decay: 1.1, type: "sine" },
    { freq: 1320, at: 0, decay: 0.7, type: "triangle" },
  ],
  // A short, low blip.
  pop: [{ freq: 440, at: 0, decay: 0.12, type: "triangle" }],
  // A short, high blip.
  ping: [{ freq: 1568, at: 0, decay: 0.25, type: "sine" }],
};

/** Peak gain at volume 100 — chimes should never be startling. */
const MAX_GAIN = 0.35;

/**
 * How long a chime requested while the context is not running may wait for
 * `resume()`. Long enough for a desktop cold start; far shorter than a
 * browser tab left untouched until the user's first click.
 */
const MAX_RESUME_WAIT_MS = 2_000;

let context: AudioContext | null = null;
let armed = false;
// Bumped by every `playChime` call: a pending (resume-gated) chime plays only
// if no later request has superseded it, so at most one is ever waiting.
let latestRequest = 0;

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

/** Play a chime at `volume` (0–100). Best-effort: never throws. */
export function playChime(sound: ChatSound, volume: number): void {
  if (sound === "none" || volume <= 0) return;
  const notes = PRESETS[sound];
  const ctx = getContext();
  if (!notes || !ctx) return;
  const peak = MAX_GAIN * Math.min(1, volume / 100);
  const request = ++latestRequest;
  if (ctx.state === "running") {
    scheduleNotes(ctx, notes, peak);
    return;
  }
  const requestedAt = performance.now();
  try {
    ctx
      .resume()
      .then(() => {
        if (request !== latestRequest) return;
        if (ctx.state !== "running") return;
        if (performance.now() - requestedAt > MAX_RESUME_WAIT_MS) return;
        scheduleNotes(ctx, notes, peak);
      })
      .catch(() => {});
  } catch {
    // `resume()` threw synchronously (or returned no promise): no chime.
  }
}

/** Schedule `notes` relative to the context clock as read now. */
function scheduleNotes(ctx: AudioContext, notes: readonly Note[], peak: number): void {
  try {
    const start = ctx.currentTime + 0.01;
    for (const note of notes) {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = note.type;
      osc.frequency.value = note.freq;
      const t0 = start + note.at;
      gain.gain.setValueAtTime(0.0001, t0);
      gain.gain.exponentialRampToValueAtTime(peak, t0 + 0.01);
      gain.gain.exponentialRampToValueAtTime(0.0001, t0 + note.decay);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(t0);
      osc.stop(t0 + note.decay + 0.05);
    }
  } catch (err) {
    console.warn("[notifications] chime failed:", err);
  }
}
