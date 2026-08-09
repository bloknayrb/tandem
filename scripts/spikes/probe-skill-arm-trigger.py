"""Does `when: "on-skill-invoke:<skill>"` defer a plugin monitor until dispatch,
and what does `<skill>` have to be?

Companion to probe-monitor-tty.py; same ConPTY approach, same prerequisites
(see that file's docstring and docs/spikes/plugin-monitor-tty-activation.md).

    ./ptyenv/Scripts/python.exe scripts/spikes/probe-skill-arm-trigger.py <dir> <cwd>

Two phases, because one phase cannot distinguish "correctly deferred" from
"ignored in a way that disables the monitor":

  Phase 1  idle -> NEITHER monitor may arm
  Phase 2  dispatch the skill -> exactly one form should arm

Two monitors are declared, differing only in the `when` name form -- bare
(`armcheck`) versus plugin-qualified (`monprobe:armcheck`) -- so a single run
says which one the host matches instead of requiring a guess per run.

The reader runs on a daemon thread: pywinpty's read() blocks, and phase 1 is
deliberately an idle session that stops repainting, so a deadline-checking read
loop hangs forever. The first version of this script did exactly that.
"""

import json
import os
import sys
import threading
import time
from datetime import datetime, timezone

from winpty import PtyProcess

FORMS = {"bare": "on-skill-invoke:armcheck", "qualified": "on-skill-invoke:monprobe:armcheck"}

MANIFEST = {
    "name": "monprobe",
    "version": "0.0.1",
    "description": "on-skill-invoke arm-trigger probe",
    "experimental": {
        "monitors": [
            {
                "name": tag,
                "command": f'node "${{CLAUDE_PLUGIN_ROOT}}/emit.mjs" {tag}',
                "description": f"{tag} skill-name form",
                "when": when,
            }
            for tag, when in FORMS.items()
        ]
    },
}

SKILL = """---
name: armcheck
description: Probe skill whose dispatch should arm an on-skill-invoke monitor. Does nothing else.
---

Reply with exactly the word ACK and stop. Do not use any tools.
"""

EMITTER = '''\
import { appendFileSync } from "node:fs";
import { join } from "node:path";

const tag = process.argv[2] ?? "unknown";
const marker = join(import.meta.dirname, `marker-${tag}.log`);

appendFileSync(marker, `ARMED ${tag} ${new Date().toISOString()}\\n`);
setInterval(() => {
  appendFileSync(marker, `EMIT ${tag} ${new Date().toISOString()}\\n`);
  console.log(`PROBE-${tag}`);
}, 6000);
'''


def now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds")


def write_fixture(root: str) -> None:
    if os.path.isdir(root) and os.listdir(root):
        manifest = os.path.join(root, ".claude-plugin", "plugin.json")
        if not os.path.exists(manifest):
            raise SystemExit(f"refusing to write the fixture into non-empty {root!r}")
        with open(manifest, encoding="utf-8") as fh:
            if '"monprobe"' not in fh.read():
                raise SystemExit(f"{root!r} holds a plugin that is not this fixture")
    os.makedirs(os.path.join(root, ".claude-plugin"), exist_ok=True)
    os.makedirs(os.path.join(root, "skills", "armcheck"), exist_ok=True)
    with open(os.path.join(root, ".claude-plugin", "plugin.json"), "w", newline="") as fh:
        json.dump(MANIFEST, fh, indent=2)
    with open(os.path.join(root, "skills", "armcheck", "SKILL.md"), "w", newline="") as fh:
        fh.write(SKILL)
    with open(os.path.join(root, "emit.mjs"), "w", newline="") as fh:
        fh.write(EMITTER)


def main() -> int:
    if len(sys.argv) < 3:
        print(__doc__)
        return 2

    plugin = os.path.abspath(sys.argv[1])
    cwd = os.path.abspath(sys.argv[2])
    baseline = int(sys.argv[3]) if len(sys.argv) > 3 else 35
    after = int(sys.argv[4]) if len(sys.argv) > 4 else 70

    write_fixture(plugin)
    markers = {t: os.path.join(plugin, f"marker-{t}.log") for t in FORMS}
    capture = os.path.join(plugin, "pty-capture.txt")
    for stale in (*markers.values(), capture):
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
                # pywinpty decodes to str, so a UTF-8 sequence split across a chunk
                # boundary raises here. Losing those bytes is fine; letting the thread
                # die is not -- an empty capture reads as "the skill never dispatched".
                time.sleep(0.01)
            except Exception:  # noqa: BLE001 -- the pty closing is the exit condition
                return

    threading.Thread(target=reader, daemon=True).start()

    armed = {t: False for t in FORMS}
    try:
        time.sleep(baseline)
        idle = {t: os.path.exists(m) for t, m in markers.items()}
        print(f"[{now()}] PHASE 1 idle {baseline}s -> armed: {idle}", flush=True)

        print(f"[{now()}] dispatching /armcheck", flush=True)
        proc.write("/armcheck")
        time.sleep(2)
        proc.write("\r")

        deadline = time.time() + after
        while time.time() < deadline and not any(os.path.exists(m) for m in markers.values()):
            time.sleep(1)
        armed = {t: os.path.exists(m) for t, m in markers.items()}
        print(f"[{now()}] PHASE 2 -> armed: {armed}", flush=True)
    finally:
        with open(capture, "w", encoding="utf-8", newline="") as fh:
            fh.write("".join(chunks))
        try:
            proc.terminate(force=True)
        except Exception:  # noqa: BLE001 -- teardown must not mask the result
            pass
        print(f"terminated at {now()}", flush=True)

    if any(idle.values()):
        print("VERDICT: FAIL — armed while idle; `when` was ignored")
        return 1
    winners = [t for t, ok in armed.items() if ok]
    if not winners:
        print("VERDICT: FAIL — never armed. Check the capture: did the skill dispatch at all?")
        return 1
    print(f"VERDICT: PASS — deferred, then armed. Matching name form(s): {winners}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
