"""When a plugin skill and a non-plugin skill share a name, which one does a bare
`/<name>` dispatch, and can a plugin monitor arm off it at all?

This is the hazard flagged in docs/spikes/plugin-monitor-tty-activation.md F6:
Tandem ships the `tandem` skill twice -- the plugin auto-loads `skills/`, and
`tandem setup --apply` installs a user-level copy into `~/.claude/skills/tandem/`.
The arm trigger can only bind to the plugin's copy, so if the other copy is what a
bare dispatch resolves to, the monitor never arms in the configuration our own
setup creates.

    ./ptyenv/Scripts/python.exe scripts/spikes/probe-skill-name-collision.py <plugindir> <cwd>

The host matches `a.when === "on-skill-invoke:" + <published skill name>` -- plain
string equality against whatever the dispatcher publishes. So the plugin declares
BOTH forms as two monitors, and a bare dispatch tells us which name a non-plugin
skill publishes:

  bare marker appears       -> a non-plugin dispatch publishes the unqualified name,
                               and the manifest can catch both by declaring both
  only qualified appears    -> non-plugin dispatches are invisible to the trigger;
                               the double-install needs a product-level fix

Three phases. The last one dispatches the qualified name as a CONTROL: without it,
"neither armed" cannot be told apart from a broken fixture.

The competing copy is placed in the *cwd's* `.claude/skills/` rather than in
`~/.claude/skills/` deliberately: same question (plugin vs non-plugin source), no
write to the operator's real Claude config. Precedence between user-level and
project-level is not what is being measured -- plugin-vs-not is.

The two SKILL.md bodies ask for different one-word replies, so the pty capture says
which copy actually ran even when no marker appears.

Same ConPTY harness and prerequisites as probe-skill-arm-trigger.py.
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

# tag -> the `when` value that should arm it
TRIGGERS = {
    "bare": f"on-skill-invoke:{SKILL_NAME}",
    "qualified": f"on-skill-invoke:{PLUGIN_NAME}:{SKILL_NAME}",
}

MANIFEST = {
    "name": PLUGIN_NAME,
    "version": "0.0.1",
    "description": "skill-name collision probe",
    "experimental": {
        "monitors": [
            {
                "name": tag,
                "command": f'node "${{CLAUDE_PLUGIN_ROOT}}/emit.mjs" {tag}',
                "description": f"arms on the {tag} name form",
                "when": when,
            }
            for tag, when in TRIGGERS.items()
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

const tag = process.argv[2] ?? "unknown";
const marker = join(import.meta.dirname, `marker-${tag}.log`);
appendFileSync(marker, `ARMED ${tag} ${new Date().toISOString()}\\n`);
setInterval(() => console.log(`PROBE-${tag}`), 6000);
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
        return "both (one per phase, as expected once the control runs)"
    return "neither (no reply seen -- did it dispatch at all?)"


def main() -> int:
    if len(sys.argv) < 3:
        print(__doc__)
        return 2

    plugin = os.path.abspath(sys.argv[1])
    cwd = os.path.abspath(sys.argv[2])
    settle = int(sys.argv[3]) if len(sys.argv) > 3 else 35
    window = int(sys.argv[4]) if len(sys.argv) > 4 else 70

    os.makedirs(cwd, exist_ok=True)
    write_fixtures(plugin, cwd)
    markers = {tag: os.path.join(plugin, f"marker-{tag}.log") for tag in TRIGGERS}
    capture_path = os.path.join(plugin, "pty-capture.txt")
    for stale in (*markers.values(), capture_path):
        if os.path.exists(stale):
            os.remove(stale)

    def armed() -> dict[str, bool]:
        return {tag: os.path.exists(path) for tag, path in markers.items()}

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

    def dispatch(name: str, label: str) -> dict[str, bool]:
        print(f"[{now()}] dispatching {label} /{name}", flush=True)
        proc.write(f"/{name}")
        time.sleep(2)
        proc.write("\r")
        deadline = time.time() + window
        while time.time() < deadline and not any(armed().values()):
            time.sleep(1)
        state = armed()
        print(f"[{now()}] after {label}: {state}", flush=True)
        return state

    after_bare: dict[str, bool] = {}
    after_control: dict[str, bool] = {}
    try:
        time.sleep(settle)
        if len("".join(chunks)) < 200:
            print("WARNING: the session barely rendered; any dispatch result is suspect")
        idle = armed()
        print(f"[{now()}] idle {settle}s -> {idle}", flush=True)
        if any(idle.values()):
            print("VERDICT: FAIL — armed while idle; `when` was ignored")
            return 1

        after_bare = dispatch(SKILL_NAME, "bare")
        if not any(after_bare.values()):
            after_control = dispatch(f"{PLUGIN_NAME}:{SKILL_NAME}", "CONTROL qualified")
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

    print(f"bare /{SKILL_NAME} ran: {which_ran(capture)}")
    if after_bare.get("bare"):
        print("VERDICT: MANIFEST-SOLVABLE — a non-plugin dispatch publishes the")
        print("  unqualified name, so declaring both forms catches either copy.")
        return 0
    if after_bare.get("qualified"):
        print("VERDICT: NO COLLISION — the bare name resolved to the plugin copy.")
        return 0
    if after_control.get("qualified"):
        print("VERDICT: PRODUCT-LEVEL FIX NEEDED — the bare dispatch armed nothing")
        print("  even with both forms declared, and the control armed. A non-plugin")
        print("  skill is invisible to the trigger; the double-install must go.")
        return 1
    print("VERDICT: INCONCLUSIVE — the control did not arm either; read pty-capture.txt.")
    return 2


if __name__ == "__main__":
    raise SystemExit(main())
