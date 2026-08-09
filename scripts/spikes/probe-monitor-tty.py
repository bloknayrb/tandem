"""Does a manifest-declared plugin monitor arm in a TTY-attached session?

Fills the one blank cell in docs/spikes/plugin-delivery.md F3. Every earlier
probe ran headless -- and monitors are armed from an Ink useEffect in the
interactive UI, so headless was the one mode guaranteed to show nothing.

winpty(1) refuses when its own stdin is not a tty, which is why this went
untested for so long; pywinpty drives ConPTY directly and has no such
requirement. It is deliberately NOT a repo dependency:

    python -m venv ptyenv
    ./ptyenv/Scripts/python.exe -m pip install pywinpty
    ./ptyenv/Scripts/python.exe scripts/spikes/probe-monitor-tty.py <dir> <cwd> [seconds]

Arming is observed through a marker file the monitor writes on start, NOT
through the terminal -- no ANSI parsing, and no dependence on the model
choosing to react to the event. Delivery is observed separately, by grepping
the PTY capture for the emitted event text.

Findings from the 2026-08-09 run are written up in
docs/spikes/plugin-monitor-tty-activation.md.
"""

import json
import os
import sys
import time

from winpty import PtyProcess

MANIFEST = {
    "name": "monprobe",
    "version": "0.0.1",
    "description": "Monitor activation probe",
    "experimental": {
        "monitors": [
            {
                "name": "probe",
                # ${CLAUDE_PLUGIN_ROOT} is substituted into the command string.
                # Note it is NOT exported to the child -- see F5 in the writeup.
                "command": 'node "${CLAUDE_PLUGIN_ROOT}/emit.mjs"',
                "description": "Tandem monitor activation probe",
                "when": "always",
            }
        ]
    },
}

EMITTER = '''\
import { appendFileSync } from "node:fs";
import { join } from "node:path";

const marker = join(import.meta.dirname, "marker.log");
const stamp = () => new Date().toISOString();

appendFileSync(
  marker,
  `ARMED ${stamp()} cwd=${process.cwd()} root=${process.env.CLAUDE_PLUGIN_ROOT ?? "<unset>"}\\n`,
);

let n = 0;
setInterval(() => {
  n += 1;
  appendFileSync(marker, `EMIT ${n} ${stamp()}\\n`);
  console.log(`PROBE-EVENT-${n} at ${stamp()}`);
}, 6000);
'''


def ensure_fixture(plugin_dir: str) -> None:
    os.makedirs(os.path.join(plugin_dir, ".claude-plugin"), exist_ok=True)
    manifest_path = os.path.join(plugin_dir, ".claude-plugin", "plugin.json")
    with open(manifest_path, "w", encoding="utf-8", newline="") as fh:
        json.dump(MANIFEST, fh, indent=2)
    with open(os.path.join(plugin_dir, "emit.mjs"), "w", encoding="utf-8", newline="") as fh:
        fh.write(EMITTER)


def main() -> int:
    if len(sys.argv) < 3:
        print(__doc__)
        return 2

    plugin_dir = os.path.abspath(sys.argv[1])
    cwd = os.path.abspath(sys.argv[2])
    # Boot alone eats ~15-20s of the window, and a woken turn needs several more.
    # A 22s run reproduced ARMING and showed "1 monitor" in the statusline but
    # closed before any turn rendered -- enough to mistake for a delivery null.
    seconds = int(sys.argv[3]) if len(sys.argv) > 3 else 60

    ensure_fixture(plugin_dir)
    capture = os.path.join(plugin_dir, "pty-capture.txt")
    marker = os.path.join(plugin_dir, "marker.log")
    for stale in (capture, marker):
        if os.path.exists(stale):
            os.remove(stale)

    argv = ["claude", "--plugin-dir", plugin_dir]
    print(f"spawning: {' '.join(argv)}\n  cwd={cwd}\n  capture={capture}", flush=True)

    proc = PtyProcess.spawn(argv, cwd=cwd, dimensions=(40, 120))
    chunks = []
    deadline = time.time() + seconds
    try:
        while time.time() < deadline and proc.isalive():
            try:
                chunks.append(proc.read(4096))
            except EOFError:
                break
    finally:
        with open(capture, "w", encoding="utf-8", newline="") as fh:
            fh.write("".join(chunks))
        try:
            proc.terminate(force=True)
        except Exception:  # noqa: BLE001 -- teardown must not mask the result
            pass

    if os.path.exists(marker):
        with open(marker, encoding="utf-8") as fh:
            print("=== ARMED (marker written by the monitor) ===")
            print(fh.read())
        return 0

    print("=== NO MARKER: the monitor did not arm ===")
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
