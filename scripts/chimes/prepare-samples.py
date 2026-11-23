# /// script
# requires-python = ">=3.11"
# dependencies = ["numpy>=1.26"]
# ///
"""Rebuild the reply-sound clips in public/chimes/ from the Versilian
Community Sample Library (VCSL, CC0 1.0).

    uv run scripts/chimes/prepare-samples.py <work_dir> [--write public/chimes]

The committed clips are the exact files auditioned when the sounds were
chosen (2026-11-23). This script re-derives them from the same recordings
with the same steps; its output matches them closely (same lengths, same
measured pitch) but not bit for bit, because the audition clips' export step
was not kept. Re-run it only to add or replace a clip, and re-audition and
re-tune what it writes.

A developer tool: no build step or CI job runs it. It needs ffmpeg on PATH.
Downloads are cached under <work_dir>/raw (untrusted data: they are only
decoded by ffmpeg, never imported or executed).

For each clip it:
  1. downloads the source WAV from VCSL at the pinned commit below;
  2. decodes it to mono 44.1 kHz float, starts it at the onset (the first
     sample above 2% of peak, less 2 ms), keeps 2.4 s, and levels it so the
     first 0.3 s has RMS 0.12, with peaks capped at 0.89;
  3. resamples to 32 kHz, keeps at most 2.0 s, and fades the last 1.4 s
     (or the whole tail, for a shorter recording) to silence;
  4. writes 16-bit PCM with no metadata chunk, and prints the strongest
     spectral peaks so the playback rates in src/client/notifications/chimes.ts
     (TUNING) can be checked against the measured fundamentals.

VCSL folder note names are not reliable (vibraphone, hand chimes, marimba and
piano are named an octave low): always tune from the measured peak, never the
file name.
"""

import hashlib
import json
import subprocess
import sys
import urllib.parse
import urllib.request
import wave
from pathlib import Path

import numpy as np

VCSL_COMMIT = "c1ea7bcc3c7309650ab0da9d15c9cd1fbc4a4c7e"
BASE = f"https://raw.githubusercontent.com/sgossner/VCSL/{VCSL_COMMIT}/"
S = "Idiophones/Struck Idiophones/"

# Clip name -> source path in VCSL. "hi" is tuned to G6 and "lo" to C6 at playback.
SAMPLES = {
    "glock_hi": S + "Glockenspiel/glock_soft_G5_01.wav",
    "glock_lo": S + "Glockenspiel/glock_soft_C5_02.wav",
    "vibes_hi": S + "Vibraphone/Soft Mallets/Vibes_soft_E5_v1_rr1_Main.wav",
    "vibes_lo": S + "Vibraphone/Soft Mallets/Vibes_soft_C5_v1_rr1_Main.wav",
    "marimba_hi": S + "Marimba/Marimba_hit_Outrigger_F5_soft_01.wav",
    "marimba_lo": S + "Marimba/Marimba_hit_Outrigger_B4_soft_01.wav",
    "chimes_hi": S + "Hand Chimes/sus_F#5_r01_main.wav",
    "chimes_lo": S + "Hand Chimes/sus_C5_r01_main.wav",
    "harp_hi": "Chordophones/Composite Chordophones/Concert Harp/KSHarp_F6_mf1.wav",
    "harp_lo": "Chordophones/Composite Chordophones/Concert Harp/KSHarp_B5_mf1.wav",
    "xylo_hi": S + "Xylophone/Soft Mallets/Xylo_Soft_G5_pp_01_far.wav",
    "xylo_lo": S + "Xylophone/Soft Mallets/Xylo_Soft_C5_pp_01_far.wav",
    "piano_hi": "Chordophones/Zithers/Grand Piano, Kawai/Sustains/GPiano_sus_F#5_v2_rr1_Player.wav",
    "piano_lo": "Chordophones/Zithers/Grand Piano, Kawai/Sustains/GPiano_sus_C5_v2_rr1_Player.wav",
    "balafon_hi": S + "Balafon/Soft Mallet/EthnicXylo_softM_F5_vl2_rr2_Mid.wav",
    "balafon_lo": S + "Balafon/Soft Mallet/EthnicXylo_softM_C5_vl2_rr1_Mid.wav",
}

WORK_SR = 44100
OUT_SR = 32000
OUT_SECONDS = 2.0
FADE_SECONDS = 1.4


def decode(src: Path, sr: int) -> np.ndarray:
    raw = subprocess.run(
        ["ffmpeg", "-loglevel", "error", "-i", str(src), "-ac", "1", "-ar", str(sr), "-f", "f32le", "-"],
        check=True,
        capture_output=True,
    ).stdout
    return np.frombuffer(raw, dtype=np.float32).astype(np.float64)


def level(x: np.ndarray) -> np.ndarray:
    peak = np.max(np.abs(x))
    onset = int(np.argmax(np.abs(x) > 0.02 * peak))
    onset = max(0, onset - int(0.002 * WORK_SR))
    y = x[onset : onset + int(2.4 * WORK_SR)].copy()
    rms = np.sqrt(np.mean(y[: int(0.3 * WORK_SR)] ** 2))
    y *= 0.12 / max(rms, 1e-9)
    p = np.max(np.abs(y))
    if p > 0.89:
        y *= 0.89 / p
    return y


def resample(y: np.ndarray) -> np.ndarray:
    """Resample WORK_SR -> OUT_SR through ffmpeg's resampler (float in, float out)."""
    out = subprocess.run(
        ["ffmpeg", "-loglevel", "error", "-f", "f32le", "-ar", str(WORK_SR), "-ac", "1", "-i", "-",
         "-ar", str(OUT_SR), "-f", "f32le", "-"],
        input=y.astype(np.float32).tobytes(),
        check=True,
        capture_output=True,
    ).stdout
    return np.frombuffer(out, dtype=np.float32).astype(np.float64)


def shape(y: np.ndarray) -> np.ndarray:
    y = y[: int(OUT_SECONDS * OUT_SR)].copy()
    fade = min(len(y), int(FADE_SECONDS * OUT_SR))
    y[len(y) - fade :] *= np.linspace(1, 0, fade) ** 2
    return y


def write_wav(path: Path, y: np.ndarray) -> None:
    # The stdlib writer emits a bare RIFF/fmt/data file: no LIST/INFO chunk.
    with wave.open(str(path), "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(OUT_SR)
        w.writeframes((np.clip(y, -1, 1) * 32767).astype("<i2").tobytes())


def peaks(y: np.ndarray, sr: int) -> list[tuple[float, float]]:
    seg = y[int(0.03 * sr) : int(0.6 * sr)]
    seg = seg * np.hanning(len(seg))
    n = 1 << 17
    spec = np.abs(np.fft.rfft(seg, n))
    freqs = np.fft.rfftfreq(n, 1 / sr)
    band = (freqs > 150) & (freqs < 8000)
    spec_b, freqs_b = spec[band], freqs[band]
    found: list[tuple[float, float]] = []
    for i in np.argsort(spec_b)[::-1]:
        f = float(freqs_b[i])
        if all(abs(f - g) / g > 0.03 for g, _ in found):
            found.append((round(f, 1), round(float(20 * np.log10(spec_b[i] / spec_b.max())), 1)))
        if len(found) == 5:
            break
    return found


def main() -> None:
    args = sys.argv[1:]
    if not args:
        sys.exit(__doc__)
    work = Path(args[0])
    dest = Path(args[args.index("--write") + 1]) if "--write" in args else work / "clips"
    raw = work / "raw"
    raw.mkdir(parents=True, exist_ok=True)
    dest.mkdir(parents=True, exist_ok=True)
    report = {}
    for key, rel in SAMPLES.items():
        src = raw / (key + ".wav")
        if not src.exists():
            urllib.request.urlretrieve(BASE + urllib.parse.quote(rel), src)
        y = shape(resample(level(decode(src, WORK_SR))))
        dst = dest / (key + ".wav")
        write_wav(dst, y)
        report[key] = {
            "source": rel,
            "sha256": hashlib.sha256(dst.read_bytes()).hexdigest(),
            "seconds": round(len(y) / OUT_SR, 3),
            "peaks": peaks(y, OUT_SR),
        }
        print(key, report[key]["seconds"], report[key]["peaks"][:2])
    (work / "report.json").write_text(json.dumps(report, indent=1), encoding="utf-8")


if __name__ == "__main__":
    main()
