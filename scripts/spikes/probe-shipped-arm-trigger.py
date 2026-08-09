"""Does the SHIPPED manifest's arm trigger fire against the real `tandem` skill?

`probe-skill-name-collision.py` answered the mechanism question with synthetic
names (spike findings F7/F8): a bare `/<name>` dispatch resolves to the
NON-plugin copy when both exist, and the host's matcher is plain string equality
against the published name, so declaring both name forms catches either copy.

This probe asks the narrower follow-up that the synthetic fixture cannot: are the
two `when` strings in `.claude-plugin/plugin.json` the RIGHT strings for the real
plugin/skill pair, in the exact double-install shape a `tandem setup --apply`
user ends up in? A typo, a rename of `skills/tandem/`, or a change to the skill's
frontmatter `name:` would all leave the manifest syntactically fine and silently
un-armable.

    ./ptyenv/Scripts/python.exe scripts/spikes/probe-shipped-arm-trigger.py <workdir> <trusted-cwd>

Two substitutions are made to the real manifest, and neither touches what is
under test:

  * `mcpServers` is stripped -- the probe must not spawn `npx` MCP servers.
  * each monitor's `command` becomes a marker emitter. Arming is decided by the
    `when` match BEFORE anything is spawned, so the command is irrelevant to this
    measurement -- and the real command's PATH problem is a separate, measured,
    unfixable-by-manifest issue (#1354 -> #1335).

`name`, `when`, and the skill's frontmatter are copied VERBATIM. The skill body
is replaced with a one-word reply so the dispatch does not kick off real Tandem
work against a server this probe did not start; the published name comes from the
frontmatter, which is preserved.

Prerequisites, and the two traps that have produced false results before:

  * pywinpty in a venv (`ptyenv`), and `claude.exe` on PATH -- not `claude`.
  * the cwd must ALREADY be a trusted workspace. A fresh directory parks the
    session on the trust prompt, which is activation gate #4, and every monitor
    reads as "did not arm" for a reason that has nothing to do with `when`.
  * the reader thread must survive `UnicodeDecodeError` (see below).
"""

import json
import os
import re
import shutil
import sys
import threading
import time
from datetime import datetime, timezone

from winpty import PtyProcess

REPO = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
MANIFEST_PATH = os.path.join(REPO, ".claude-plugin", "plugin.json")
SKILL_PATH = os.path.join(REPO, "skills", "tandem", "SKILL.md")

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


def frontmatter() -> str:
    """The real skill's frontmatter block, verbatim -- it carries the published name."""
    text = open(SKILL_PATH, encoding="utf-8").read()
    match = re.match(r"^---\r?\n.*?\r?\n---\r?\n", text, re.DOTALL)
    if not match:
        raise SystemExit(f"no frontmatter block at the top of {SKILL_PATH}")
    return match.group(0)


def skill_body(reply: str) -> str:
    return f"{frontmatter()}\nReply with exactly the word {reply} and stop. Do not use any tools.\n"


def build(workdir: str, cwd: str) -> tuple[str, str, dict[str, str], str]:
    """Returns (plugin dir, skill name, {monitor name -> its `when`}, plugin name)."""
    manifest = json.load(open(MANIFEST_PATH, encoding="utf-8"))
    monitors = manifest.get("experimental", {}).get("monitors", [])
    if not monitors:
        raise SystemExit("the shipped manifest declares no monitors -- nothing to probe")

    manifest.pop("mcpServers", None)
    for mon in monitors:
        mon["command"] = f'node "${{CLAUDE_PLUGIN_ROOT}}/emit.mjs" {mon["name"]}'

    plugin_name = manifest["name"]
    skill_name = os.path.basename(os.path.dirname(SKILL_PATH))

    plugin = os.path.join(workdir, "plugin")
    os.makedirs(os.path.join(plugin, ".claude-plugin"), exist_ok=True)
    os.makedirs(os.path.join(plugin, "skills", skill_name), exist_ok=True)
    with open(os.path.join(plugin, ".claude-plugin", "plugin.json"), "w", newline="") as fh:
        json.dump(manifest, fh, indent=2)
    with open(os.path.join(plugin, "skills", skill_name, "SKILL.md"), "w", encoding="utf-8", newline="") as fh:
        fh.write(skill_body("PLUGINCOPY"))
    with open(os.path.join(plugin, "emit.mjs"), "w", newline="") as fh:
        fh.write(EMITTER)

    # The double-install shape: a second, NON-plugin copy of the same skill.
    # Placed project-level rather than in the operator's real ~/.claude/skills.
    rival = os.path.join(cwd, ".claude", "skills", skill_name)
    os.makedirs(rival, exist_ok=True)
    with open(os.path.join(rival, "SKILL.md"), "w", encoding="utf-8", newline="") as fh:
        fh.write(skill_body("RIVALCOPY"))

    return plugin, skill_name, {m["name"]: m.get("when", "") for m in monitors}, plugin_name


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

    workdir = os.path.abspath(sys.argv[1])
    cwd = os.path.abspath(sys.argv[2])
    settle = int(sys.argv[3]) if len(sys.argv) > 3 else 35
    window = int(sys.argv[4]) if len(sys.argv) > 4 else 70

    if not os.path.isdir(cwd):
        raise SystemExit(f"{cwd!r} does not exist -- pass an ALREADY-TRUSTED workspace")
    os.makedirs(workdir, exist_ok=True)
    plugin, skill_name, triggers, plugin_name = build(workdir, cwd)

    print(f"shipped triggers: {json.dumps(triggers, indent=2)}")
    qualified = f"{plugin_name}:{skill_name}"

    markers = {name: os.path.join(plugin, f"marker-{name}.log") for name in triggers}
    capture_path = os.path.join(workdir, "pty-capture.txt")
    for stale in (*markers.values(), capture_path):
        if os.path.exists(stale):
            os.remove(stale)

    def armed() -> dict[str, bool]:
        return {name: os.path.exists(path) for name, path in markers.items()}

    chunks: list[str] = []
    proc = PtyProcess.spawn(["claude", "--plugin-dir", plugin], cwd=cwd, dimensions=(40, 120))
    print(f"spawn at {now()}", flush=True)

    def reader() -> None:
        while True:
            try:
                chunks.append(proc.read(4096))
            except UnicodeDecodeError:
                # pywinpty decodes to str; a UTF-8 sequence split across a chunk
                # boundary raises here. Losing those bytes is fine, letting the
                # thread die is not -- that produced a 5-byte capture and a false
                # INCONCLUSIVE once already.
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
            print("VERDICT: FAIL — armed while idle; the shipped `when` was ignored")
            return 1

        after_bare = dispatch(skill_name, "bare")
        if not any(after_bare.values()):
            after_control = dispatch(qualified, "CONTROL qualified")
    finally:
        capture = "".join(chunks)
        with open(capture_path, "w", encoding="utf-8", newline="") as fh:
            fh.write(capture)
        try:
            proc.terminate(force=True)
        except Exception:  # noqa: BLE001 -- teardown must not mask the result
            pass
        print(f"terminated at {now()}", flush=True)
        shutil.rmtree(os.path.join(cwd, ".claude", "skills", skill_name), ignore_errors=True)

    print(f"bare /{skill_name} ran: {which_ran(capture)}")
    hit = [name for name, on in after_bare.items() if on]
    if hit:
        print(f"VERDICT: PASS — the shipped manifest armed {hit} on a bare dispatch")
        print("  in the double-install shape. The trigger strings are correct.")
        return 0
    control_hit = [name for name, on in after_control.items() if on]
    if control_hit:
        print(f"VERDICT: PARTIAL — only the qualified control armed ({control_hit}).")
        print("  The bare-name entry does not cover the non-plugin copy after all.")
        return 1
    print("VERDICT: INCONCLUSIVE — nothing armed, control included. Read pty-capture.txt.")
    return 2


if __name__ == "__main__":
    raise SystemExit(main())
