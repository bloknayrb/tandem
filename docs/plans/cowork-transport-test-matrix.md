# Cowork Transport — Phase 1 Test Matrix (run when ready)

Goal: decide **how** a Cowork session can reach Tandem (MCP on `127.0.0.1:3479`) with **no admin rights**, so we know which redesign branch to build. ~30–45 min, hands-on. Stop at the first test that passes.

Context: today's Windows "Enable Cowork" is broken three ways (plain `netsh` never elevates; the server only binds loopback; the Host-header allowlist would 403 a VM request). Phase 0 (shipped, commit `f4f69b61`) only fixed the lying UI. This matrix settles the real transport. Full plan: `~/.claude/plans/i-ve-just-tried-enabling-deep-alpaca.md`.

**The bet is genuinely contested.** A third-party article + Tandem's own `apply.ts:199` comment say Claude Desktop auto-bridges `claude_desktop_config.json` stdio MCP servers into Cowork (host-side) — which would let us delete the firewall + per-workspace machinery entirely (Branch A). But Tandem's *own* earlier testing (ADR-023, Probe 6) found global-config entries surfaced **zero** tools in Cowork, and quotes an Anthropic article saying config servers aren't available there. So Test A must be **decisive** before we delete ~2600 lines.

---

## Before you start (record these as evidence)

- [ ] **Claude Desktop version** (Help → About).
- [ ] **Install type:** MSIX/Store *or* direct-download (or both). MSIX virtualizes the config path — if both exist, run Test A on each.
- [ ] **Cowork session network policy** = unrestricted (an egress block looks identical to "NAT needed" in curl output — rule it out first).
- [ ] **Token hygiene:** `tandem rotate-token` to a throwaway token *before* testing, and again *after*. Never paste configs/logs into chat unredacted — scrub any `TANDEM_AUTH_TOKEN`. (`/health` is auth-exempt and returns only a version, so its output is safe to share.)
- [ ] Confirm sidecar is up: `curl http://127.0.0.1:3479/health` from a host terminal → expect 200 + version.
- [ ] Confirm the wizard's `tandem` stdio entry is in the **correct** `claude_desktop_config.json` for the install type (re-run the integration wizard if unsure). MSIX copy lives under `…\Packages\Claude_*\LocalCache\Roaming\Claude\`, not `%APPDATA%`.

---

## Test A — does the SDK bridge work? (the contested bet → Branch A)

1. Ensure **no** per-workspace `tandem` entries exist (delete the `tandem` key from any `…\local-agent-mode-sessions\<ws>\<vm>\cowork_plugins\installed_plugins.json`).
2. Restart Claude Desktop (config is read only at launch).
3. Open a document in Tandem on the host (so there's observable state).
4. Start a Cowork session. In the Cowork chat, ask the agent:
   - "List your available tools — do you have any `tandem_*` tools, and how many?" (Tandem exposes ~31; watch for truncation.)
   - "Call `tandem_status`." then "Call `tandem_listDocuments`." (Does it return the host-open doc? That proves end-to-end, not just registration.)
5. **Locate the bridge process** (this is the crux — host vs VM settles everything): on the host while the session is live, run in PowerShell:
   `Get-Process node,npx -ErrorAction SilentlyContinue | Select Id,ProcessName,StartTime`
   — a node/npx process that appears when the session starts = the bridge runs **host-side** (reaches `127.0.0.1` directly → Branch A is real).
6. **Two workspaces:** open a second/new Cowork workspace, confirm `tandem_*` tools appear there too with **zero** per-workspace writes (this is what justifies deleting the heal task).
7. **Lifecycle:** kill Tandem mid-session, watch the in-session error, restart Tandem, confirm the next tool call recovers *without* restarting Desktop.
8. If tools are **absent**, retry once with the config `TANDEM_URL` set to `http://host.docker.internal:3479` before concluding "no bridge" (distinguishes no-bridge from bridge-spawns-in-VM).

**PASS** (tools present + `tandem_listDocuments` round-trips + works on a 2nd workspace, ideally both install types) → **Branch A**: delete the firewall + per-workspace installer; "Enable" becomes a config-entry check. *(Caveat to resolve in Branch A: the entry runs `npx -y tandem-editor` — needs Node on the host PATH. Decide: bundle the binary vs document the Node prereq.)*

**FAIL** → Test B.

---

## Test B — per-workspace entry + loopback proxy? (ADR-023's validated path → Branch B)

1. Hand-write the three JSON files into **one** workspace's `cowork_plugins\` (reversible; merge if they already exist). Shapes (from `cowork_installer.rs`):
   - `installed_plugins.json`:
     `{"mcpServers":{"tandem":{"type":"stdio","command":"npx","args":["-y","tandem-editor","mcp-stdio"],"env":{"TANDEM_AUTH_TOKEN":"<throwaway-token>","TANDEM_URL":"http://host.docker.internal:3479"}}}}`
   - `known_marketplaces.json`:
     `{"marketplaces":{"tandem":{"id":"tandem","name":"Tandem","description":"Collaborative AI-human document editor","url":"https://github.com/bloknayrb/tandem"}}}`
   - `cowork_settings.json`: `{"enabledPlugins":["tandem@tandem"]}`
2. Start/restart a Cowork session in that workspace.
3. Inside the session, have the agent run in its terminal and report **verbatim** output:
   - `cat /etc/hosts | grep -i docker` and `ip route show default` (record the resolved IP + gateway)
   - `curl -sv http://host.docker.internal:3479/health` ← the decisive probe
4. **Interpretation (critical):** *any* HTTP response — **including a 403** — means the packet reached Tandem's Express server (the Host-header allowlist 403s `host.docker.internal`, so 403 is **positive** evidence). Only a **connection refused / timeout** means the transport failed.
5. Also note whether `tandem_*` tools appear / `tandem_status` succeeds in the session.
6. Clean up: remove the manual entries afterward.

**PASS** (any HTTP response from inside the VM, host still loopback-bound, no firewall rule) → **Branch B**: keep the per-workspace installer, delete the firewall/UAC machinery. *(Production Branch B then needs `host.docker.internal` added to the Host allowlist — a deliberate DNS-rebinding decision.)*

**FAIL** (connection refused/timeout) → Test C.

---

## Test C — NAT characterization (only if A and B both fail → Branch C, near-nonviable)

1. From Test B, record the VM's `host.docker.internal` IP + default gateway.
2. Stop Tandem; run the sidecar manually bound non-loopback: `TANDEM_BIND_HOST=<vEthernet host IP>` + `TANDEM_AUTH_TOKEN=<throwaway>` (the bind check already requires the token for non-loopback).
3. From inside the VM: `curl http://host.docker.internal:3479/health` — first with **no** firewall rule, then after adding one from an **elevated** terminal:
   `netsh advfirewall firewall add rule name="Tandem Cowork TEST" dir=in action=allow protocol=TCP localport=3479 remoteip=<cidr>`
4. Determine **which firewall** actually drops the packet: Win11's Hyper-V Firewall (`Get-NetFirewallHyperVRule`) is separate from `netsh advfirewall` and may be the real gate.
5. Record exactly which (bind, rule, firewall-type) combo succeeds. **Delete the test rule afterward.**

⚠️ Branch C is near-nonviable: the Hyper-V Default Switch subnet + vEthernet IP **re-randomize every reboot**, so any persisted rule/bind/URL rots nightly → a UAC prompt per reboot or a privileged service. If C is the only thing that works, that's a Bryan decision, not an auto-implement.

---

## After the matrix

Record the outcome (with the process-location + tool-count evidence + Desktop version) and write **ADR-045 "Cowork Transport"**, explicitly superseding/version-qualifying ADR-023's bridging findings. Then implement the winning branch per `~/.claude/plans/i-ve-just-tried-enabling-deep-alpaca.md` (Phase 2), with the kill gates armed. **Don't delete anything until the matrix resolves.**
