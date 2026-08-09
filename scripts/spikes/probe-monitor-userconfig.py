"""Does `${user_config.KEY}` substitute into a plugin monitor's command, and does
its `default` apply without the user answering a prompt?

This matters because two of our own documents state that the plugin monitor's
exit-127 failure has no manifest-level fix (docs/spikes/plugin-delivery.md F-macOS,
docs/troubleshooting.md "Plugin monitor reports exit 127"). The reasoning is that
monitors are spawned through a NON-LOGIN shell, so a GUI-launched Claude Code has
no Node on PATH and a bare `node`/`npx` command word cannot resolve.

`userConfig` would defeat that: the manifest declares a `file` field defaulting to
`node`, the user points it at their real binary once at enable time, and the
command word becomes an absolute path. The monitor `command` field's own
description lists `${user_config.*}` among the substitutions, but the userConfig
schema's description mentions only "MCP/LSP server config, hook commands, and
skill/agent content" -- so the two disagree and it has to be measured.

    ./ptyenv/Scripts/python.exe scripts/spikes/probe-monitor-userconfig.py <plugindir> <cwd>

Two monitors, both `when: "always"`:

  control      node "${CLAUDE_PLUGIN_ROOT}/emit.mjs" control
  substituted  "${user_config.node_path}" "${CLAUDE_PLUGIN_ROOT}/emit.mjs" substituted

`node_path` defaults to the absolute path of this machine's node. The control
exists so that "substituted did not arm" can be told apart from "nothing armed at
all" -- without it, a blocked enable-time prompt and a failed substitution look
identical. An unsubstituted command would try to execute the literal
`${user_config.node_path}` and fail, so the marker is proof of substitution.

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

TAGS = ("control", "substituted")

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


def manifest(node_path: str) -> dict:
    return {
        "name": "cfgprobe",
        "version": "0.0.1",
        "description": "user_config substitution probe",
        "userConfig": {
            "node_path": {
                "type": "file",
                "title": "Path to Node.js",
                "description": "Absolute path to the node binary.",
                "default": node_path,
            }
        },
        "experimental": {
            "monitors": [
                {
                    "name": "control",
                    "command": 'node "${CLAUDE_PLUGIN_ROOT}/emit.mjs" control',
                    "description": "bare node command word",
                    "when": "always",
                },
                {
                    "name": "substituted",
                    "command": (
                        '"${user_config.node_path}" "${CLAUDE_PLUGIN_ROOT}/emit.mjs" substituted'
                    ),
                    "description": "command word from user_config",
                    "when": "always",
                },
            ]
        },
    }


def write_fixture(root: str, node_path: str) -> None:
    manifest_path = os.path.join(root, ".claude-plugin", "plugin.json")
    if os.path.isdir(root) and os.listdir(root) and not os.path.exists(manifest_path):
        raise SystemExit(f"refusing to write the fixture into non-empty {root!r}")
    os.makedirs(os.path.join(root, ".claude-plugin"), exist_ok=True)
    with open(manifest_path, "w", newline="") as fh:
        json.dump(manifest(node_path), fh, indent=2)
    with open(os.path.join(root, "emit.mjs"), "w", newline="") as fh:
        fh.write(EMITTER)


def main() -> int:
    if len(sys.argv) < 3:
        print(__doc__)
        return 2

    plugin = os.path.abspath(sys.argv[1])
    cwd = os.path.abspath(sys.argv[2])
    window = int(sys.argv[3]) if len(sys.argv) > 3 else 75

    node_path = shutil.which("node")
    if not node_path:
        raise SystemExit("no node on PATH; this probe needs one to use as the default")
    node_path = os.path.abspath(node_path)
    print(f"node_path default = {node_path}", flush=True)

    os.makedirs(cwd, exist_ok=True)
    write_fixture(plugin, node_path)
    markers = {tag: os.path.join(plugin, f"marker-{tag}.log") for tag in TAGS}
    capture_path = os.path.join(plugin, "pty-capture.txt")
    for stale in (*markers.values(), capture_path):
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
            except Exception:  # noqa: BLE001 -- the pty closing is the exit condition
                return

    threading.Thread(target=reader, daemon=True).start()

    try:
        deadline = time.time() + window
        while time.time() < deadline and not all(os.path.exists(m) for m in markers.values()):
            time.sleep(1)
        armed = {tag: os.path.exists(path) for tag, path in markers.items()}
        print(f"[{now()}] armed: {armed}", flush=True)
    finally:
        capture = "".join(chunks)
        with open(capture_path, "w", encoding="utf-8", newline="") as fh:
            fh.write(capture)
        try:
            proc.terminate(force=True)
        except Exception:  # noqa: BLE001 -- teardown must not mask the result
            pass
        print(f"terminated at {now()}", flush=True)

    if armed["substituted"]:
        print("VERDICT: SUBSTITUTED — ${user_config.KEY} resolves in a monitor command,")
        print("  and its `default` applies with no answered prompt.")
        return 0
    if armed["control"]:
        print("VERDICT: NOT SUBSTITUTED — the control armed and the substituted one did not.")
        print("  user_config does not reach monitor commands (or the default is not applied).")
        return 1
    print("VERDICT: INCONCLUSIVE — neither armed; read pty-capture.txt for a prompt or error.")
    return 2


if __name__ == "__main__":
    raise SystemExit(main())
