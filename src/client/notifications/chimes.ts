import type { ChatSound } from "../hooks/useTandemSettings";

/**
 * Reply chimes (#2168), synthesized with Web Audio rather than shipped as
 * files: no `media-src` CSP change, no asset licensing, identical on every OS.
 * The OS notification is posted without a sound, so this is the only chime.
 *
 * Autoplay policy: an `AudioContext` created without a prior user gesture
 * starts `suspended`. `armChimes()` resumes it on the first pointer/key input,
 * after which a chime can play while the window is in the background.
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

let context: AudioContext | null = null;
let armed = false;

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
  try {
    if (ctx.state === "suspended") void ctx.resume().catch(() => {});
    const peak = MAX_GAIN * Math.min(1, volume / 100);
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
