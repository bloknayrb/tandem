"""Does the plugin host respawn a monitor that exits, and does the exit code matter?

This decides whether a monitor can "stand down" -- the singleton design where a
second Claude Code session sees a monitor already running for Tandem and yields
instead of opening a second SSE subscription. Yielding means exiting. If the host
respawns on exit, a yielding monitor becomes a spin loop: spawn, yield, exit,
respawn, forever, once per session for the life of the session.

It also settles a live disagreement in our own tree. `src/monitor/run.ts` says
"exit 1 so the plugin host respawns us" (the EPIPE path depends on it), while the
`when: "always"` arming rationale assumes an exhausted monitor stays dead. Both
cannot be right.

    ./ptyenv/Scripts/python.exe scripts/spikes/probe-monitor-respawn.py <plugindir> <cwd>

Two monitors, identical but for exit code: one exits 0, one exits 1. Each appends
a line to its own marker before exiting, so the marker's LINE COUNT is the respawn
count. One line = never respawned. Many = respawned, and the interval tells you
whether it is throttled.

The cwd must already be trusted -- an untrusted one parks the session on the
workspace-trust prompt and nothing arms at all (see the gotcha in
docs/spikes/plugin-monitor-tty-activation.md F8).
"""

import json
import os
import sys
import threading
import time
from datetime import datetime, timezone

from winpty import PtyProcess

CODES = {"zero": 0, "one": 1}

MANIFEST = {
    "name": "respawnprobe",
    "version": "0.0.1",
    "description": "monitor respawn-on-exit probe",
    "experimental": {
        "monitors": [
            {
                "name": tag,
                "command": f'node "${{CLAUDE_PLUGIN_ROOT}}/emit.mjs" {tag} {code}',
                "description": f"exits {code} immediately",
                "when": "always",
            }
            for tag, code in CODES.items()
        ]
    },
}

EMITTER = '''\
import { appendFileSync } from "node:fs";
import { join } from "node:path";

const [tag, code] = process.argv.slice(2);
appendFileSync(join(import.meta.dirname, `marker-${tag}.log`), `START ${new Date().toISOString()}\\n`);
// Say nothing on stdout: a line would become a task_notification and the model
// might react, which is not what is being measured.
process.exit(Number(code));
'''


def now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds")


def main() -> int:
    if len(sys.argv) < 3:
        print(__doc__)
        return 2

    plugin = os.path.abspath(sys.argv[1])
    cwd = os.path.abspath(sys.argv[2])
    window = int(sys.argv[3]) if len(sys.argv) > 3 else 120

    manifest_path = os.path.join(plugin, ".claude-plugin", "plugin.json")
    if os.path.isdir(plugin) and os.listdir(plugin) and not os.path.exists(manifest_path):
        raise SystemExit(f"refusing to write the fixture into non-empty {plugin!r}")
    os.makedirs(os.path.join(plugin, ".claude-plugin"), exist_ok=True)
    with open(manifest_path, "w", newline="") as fh:
        json.dump(MANIFEST, fh, indent=2)
    with open(os.path.join(plugin, "emit.mjs"), "w", newline="") as fh:
        fh.write(EMITTER)

    markers = {tag: os.path.join(plugin, f"marker-{tag}.log") for tag in CODES}
    for stale in markers.values():
        if os.path.exists(stale):
            os.remove(stale)

    chunks: list[str] = []
    proc = PtyProcess.spawn(["claude", "--plugin-dir", plugin], cwd=cwd, dimensions=(40, 120))
    print(f"spawn at {now()}", flush=True)

    def reader() -> None:
        while True:
            try:
                chunks.append(proc.read(4096))
            except UnicodeDecodeError:
                time.sleep(0.01)
            except Exception:  # noqa: BLE001
                return

    threading.Thread(target=reader, daemon=True).start()

    def counts() -> dict[str, int]:
        out = {}
        for tag, path in markers.items():
            if not os.path.exists(path):
                out[tag] = 0
                continue
            with open(path, encoding="utf-8") as fh:
                out[tag] = sum(1 for line in fh if line.strip())
        return out

    try:
        deadline = time.time() + window
        while time.time() < deadline:
            time.sleep(10)
            print(f"[{now()}] starts so far: {counts()}", flush=True)
    finally:
        with open(os.path.join(plugin, "pty-capture.txt"), "w", encoding="utf-8", newline="") as fh:
            fh.write("".join(chunks))
        try:
            proc.terminate(force=True)
        except Exception:  # noqa: BLE001
            pass
        print(f"terminated at {now()}", flush=True)

    final = counts()
    print(f"FINAL start counts: {final}")
    for tag, n in final.items():
        if n == 0:
            print(f"  {tag}: never armed — inconclusive for this arm")
        elif n == 1:
            print(f"  exit {CODES[tag]}: NOT respawned (armed once, stayed dead)")
        else:
            print(f"  exit {CODES[tag]}: RESPAWNED {n - 1}x in {window}s")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
