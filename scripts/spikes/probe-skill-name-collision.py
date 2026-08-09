"""When a plugin skill and a non-plugin skill share a name, which one does a bare
`/<name>` dispatch, and does the plugin's `on-skill-invoke` monitor still arm?

This is the hazard flagged in docs/spikes/plugin-monitor-tty-activation.md F6:
Tandem ships the `tandem` skill twice -- the plugin auto-loads `skills/`, and
`tandem setup --apply` installs a user-level copy into `~/.claude/skills/tandem/`.
The arm trigger binds to the plugin's copy, so if the other copy is what a bare
dispatch resolves to, the monitor never arms in the configuration our own setup
creates.

    ./ptyenv/Scripts/python.exe scripts/spikes/probe-skill-name-collision.py <plugindir> <cwd>

The competing copy is placed in the *cwd's* `.claude/skills/` rather than in
`~/.claude/skills/` deliberately: same question (plugin vs non-plugin source),
no write to the operator's real Claude config. Precedence between user-level and
project-level is not what is being measured -- plugin-vs-not is.

The two SKILL.md bodies ask for different one-word replies, so the pty capture
says which copy actually ran even when the marker file is absent.

Same ConPTY harness and prerequisites as probe-skill-arm-trigger.py; the reader
runs on a daemon thread because pywinpty's read() blocks and an idle TUI stops
repainting.
"""

import json
import os
import shutil
import sys
import threading
import time
from datetime import datetime, timezone

from winpty import PtyProcess

PLUGIN_NAME = "monprobe"
SKILL_NAME = "armcheck"

MANIFEST = {
    "name": PLUGIN_NAME,
    "version": "0.0.1",
    "description": "skill-name collision probe",
    "experimental": {
        "monitors": [
            {
                "name": "collide",
                "command": 'node "${CLAUDE_PLUGIN_ROOT}/emit.mjs"',
                "description": "arms only if the plugin's own skill copy is dispatched",
                "when": f"on-skill-invoke:{PLUGIN_NAME}:{SKILL_NAME}",
            }
        ]
    },
}


def skill(reply: str) -> str:
    return f"""---
name: {SKILL_NAME}
description: Probe skill for the plugin-vs-non-plugin name collision test. Does nothing else.
---

Reply with exactly the word {reply} and stop. Do not use any tools.
"""


EMITTER = '''\
import { appendFileSync } from "node:fs";
import { join } from "node:path";

const marker = join(import.meta.dirname, "marker.log");
appendFileSync(marker, `ARMED ${new Date().toISOString()}\\n`);
setInterval(() => console.log("PROBE-collide"), 6000);
'''


def now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds")


def write_fixtures(plugin: str, cwd: str) -> None:
    manifest_path = os.path.join(plugin, ".claude-plugin", "plugin.json")
    if os.path.isdir(plugin) and os.listdir(plugin) and not os.path.exists(manifest_path):
        raise SystemExit(f"refusing to write the fixture into non-empty {plugin!r}")
    os.makedirs(os.path.join(plugin, ".claude-plugin"), exist_ok=True)
    os.makedirs(os.path.join(plugin, "skills", SKILL_NAME), exist_ok=True)
    with open(manifest_path, "w", newline="") as fh:
        json.dump(MANIFEST, fh, indent=2)
    with open(os.path.join(plugin, "skills", SKILL_NAME, "SKILL.md"), "w", newline="") as fh:
        fh.write(skill("PLUGINCOPY"))
    with open(os.path.join(plugin, "emit.mjs"), "w", newline="") as fh:
        fh.write(EMITTER)

    rival = os.path.join(cwd, ".claude", "skills", SKILL_NAME)
    os.makedirs(rival, exist_ok=True)
    with open(os.path.join(rival, "SKILL.md"), "w", newline="") as fh:
        fh.write(skill("RIVALCOPY"))


def which_ran(capture: str) -> str:
    plugin_hit = "PLUGINCOPY" in capture
    rival_hit = "RIVALCOPY" in capture
    if plugin_hit and not rival_hit:
        return "plugin copy"
    if rival_hit and not plugin_hit:
        return "non-plugin copy"
    if plugin_hit and rival_hit:
        return "ambiguous (both words present)"
    return "neither (no reply seen -- did it dispatch at all?)"


def main() -> int:
    if len(sys.argv) < 3:
        print(__doc__)
        return 2

    plugin = os.path.abspath(sys.argv[1])
    cwd = os.path.abspath(sys.argv[2])
    settle = int(sys.argv[3]) if len(sys.argv) > 3 else 35
    after = int(sys.argv[4]) if len(sys.argv) > 4 else 70

    os.makedirs(cwd, exist_ok=True)
    write_fixtures(plugin, cwd)
    marker = os.path.join(plugin, "marker.log")
    capture_path = os.path.join(plugin, "pty-capture.txt")
    for stale in (marker, capture_path):
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
                # die is not -- that is what silently produced a 5-byte capture.
                time.sleep(0.01)
            except Exception:  # noqa: BLE001 -- the pty closing is the exit condition
                return

    threading.Thread(target=reader, daemon=True).start()

    try:
        time.sleep(settle)
        if len("".join(chunks)) < 200:
            print("WARNING: the session barely rendered; a dispatch result will be suspect")
        if os.path.exists(marker):
            print("WARNING: armed while idle -- `when` was ignored; the rest is meaningless")

        print(f"[{now()}] dispatching bare /{SKILL_NAME}", flush=True)
        proc.write(f"/{SKILL_NAME}")
        time.sleep(2)
        proc.write("\r")

        deadline = time.time() + after
        while time.time() < deadline and not os.path.exists(marker):
            time.sleep(1)
        armed = os.path.exists(marker)
        print(f"[{now()}] armed after bare dispatch: {armed}", flush=True)
    finally:
        capture = "".join(chunks)
        with open(capture_path, "w", encoding="utf-8", newline="") as fh:
            fh.write(capture)
        try:
            proc.terminate(force=True)
        except Exception:  # noqa: BLE001 -- teardown must not mask the result
            pass
        print(f"terminated at {now()}", flush=True)
        shutil.rmtree(os.path.join(cwd, ".claude", "skills", SKILL_NAME), ignore_errors=True)

    ran = which_ran(capture)
    print(f"bare /{SKILL_NAME} ran: {ran}")
    if armed and ran == "plugin copy":
        print("VERDICT: NO HAZARD — the bare name resolves to the plugin copy and arms.")
        return 0
    if not armed and ran == "non-plugin copy":
        print("VERDICT: HAZARD CONFIRMED — the bare name resolves to the other copy; no arm.")
        return 1
    print("VERDICT: INCONCLUSIVE — read pty-capture.txt; the dispatch may not have landed.")
    return 2


if __name__ == "__main__":
    raise SystemExit(main())
