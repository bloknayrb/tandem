# Coverage manifest: security

Generated from the agent transcript. Zero model tokens.

## Files touched (103)
- .claude/projects/-home-user-tandem/10b2005f-9798-55d6-8f09-2eba1cfdb6ab/tool-results/butthaidv.txt
- .github/workflows/
- docs/a.md
- docs/configuration.md
- docs/link.md
- docs/security.md
- scripts/test-ports.ts
- src-tauri/capabilities/
- src-tauri/gen/schemas
- src-tauri/gen/schemas/
- src-tauri/gen/schemas/desktop-schema.json
- src-tauri/src
- src-tauri/src/
- src-tauri/src/autostart.rs
- src-tauri/src/cowork_commands.rs
- src-tauri/src/cowork_installer.rs
- src-tauri/src/firewall.rs
- src-tauri/src/keychain.rs
- src-tauri/src/lib.rs
- src-tauri/src/pending_update.rs
- src-tauri/src/sidecar.rs
- src-tauri/src/token_store.rs
- src-tauri/tauri.conf.json
- src/channel/run.ts
- src/cli/doctor.ts
- src/cli/mcp-stdio.ts
- src/cli/rotate-token.ts
- src/client
- src/client/editor/extensions/markdown-html.ts
- src/client/editor/utils/url-safety.ts
- src/client/keychain/keychain-invoke.ts
- src/client/panels/chat-markdown.ts
- src/client/utils/backend-ports.ts
- src/client/utils/fileUpload.ts
- src/monitor/run.ts
- src/server
- src/server/
- src/server/annotations/store.ts
- src/server/auth/middleware.ts
- src/server/auth/token-store.ts
- src/server/bind-check.ts
- src/server/documents/open.ts
- src/server/events/queue.ts
- src/server/events/sse.ts
- src/server/events/wake-socket.ts
- src/server/file-io/doc-backup.ts
- src/server/file-io/docx-comments.ts
- src/server/file-io/docx-footnotes.ts
- src/server/file-io/docx-html.ts
- src/server/file-io/docx-lost-features.ts
- src/server/file-io/docx-size-gate.ts
- src/server/file-io/docx-walker.ts
- src/server/file-io/index.ts
- src/server/index.ts
- src/server/integrations/api-routes.ts
- src/server/integrations/apply.ts
- src/server/integrations/existing-config.ts
- src/server/integrations/install-claude-cli.ts
- src/server/integrations/keychain.ts
- src/server/integrations/schema.ts
- src/server/launcher/api-routes.ts
- src/server/launcher/supervisor.ts
- src/server/license/activation.ts
- src/server/license/public-key.ts
- src/server/license/verifier.ts
- src/server/local-model/collaborator.ts
- src/server/local-model/config-source.ts
- src/server/local-model/config.ts
- src/server/local-model/index.ts
- src/server/local-model/ollama-client.ts
- src/server/mcp/
- src/server/mcp/annotations.ts
- src/server/mcp/api-routes.ts
- src/server/mcp/awareness.ts
- src/server/mcp/channel-routes.ts
- src/server/mcp/convert.ts
- src/server/mcp/document-service.ts
- src/server/mcp/document.ts
- src/server/mcp/docx-apply.ts
- src/server/mcp/navigation.ts
- src/server/mcp/routes
- src/server/mcp/routes/_shared.ts
- src/server/mcp/routes/open.ts
- src/server/mcp/routes/upload.ts
- src/server/mcp/server.ts
- src/server/models/api-routes.ts
- src/server/notifications.ts
- src/server/platform.ts
- src/server/sentry.ts
- src/server/session/manager.ts
- src/server/startup-file.ts
- src/server/yjs/provider.ts
- src/shared/
- src/shared/auth/token-file.ts
- src/shared/cli-runtime.ts
- src/shared/constants.ts
- src/shared/image-src-safety.ts
- src/shared/redact-user-paths.ts
- src/shared/sanitize.ts
- src/shared/scrub-text.ts
- src/shared/sse-consumer.ts
- src/shared/windows-path-safety.ts
- src/stdio-bridge/index.ts

## Commands run (105)
- `wc -l <repo>/docs/security.md; cat <scratchpad>/open-issues.txt 2>/dev/null | head`
- `cat <repo>/docs/security.md`
- `find src -type f \( -name '*.ts' -o -name '*.rs' -o -name '*.mjs' \) | grep -v node_modules | sort; echo; find src-tauri -type f -name '*.rs' 2>/dev/null | sort`
- `grep -n -i 'env\|TANDEM_\|app.data\|XDG\|HOME' docs/configuration.md 2>/dev/null | head -80; echo ---; grep -rn 'process.env.TANDEM' src/server/index.ts src/ser`
- `sed -n 1,140p <repo>/docs/security.md`
- `sed -n 140,300p <repo>/docs/security.md`
- `sed -n 300,535p <repo>/docs/security.md`
- `sed -n 140,225p <repo>/docs/security.md`
- `sed -n 225,300p <repo>/docs/security.md`
- `cat -n <repo>/src/server/auth/middleware.ts`
- `cat -n <repo>/src/server/mcp/api-routes.ts`
- `sed -n 380,720p <repo>/src/server/mcp/server.ts | cat -n | sed 's/^ *\([0-9]*\)/\1+379/' | awk -F'\t' '{split($1,a,"+"); printf "%d\t%s\n", a[1]+a[2]`
- `sed -n 140,182p <repo>/docs/security.md`
- `sed -n 182,225p <repo>/docs/security.md`
- `sed -n 720,900p <repo>/src/server/mcp/server.ts | cat -n | awk -F'\t' '{printf "%d\t%s\n", $1+719, $2}'`
- `cat -n <repo>/src/server/mcp/routes/_shared.ts`
- `cat -n <repo>/src/server/mcp/routes/open.ts; echo ======; cat -n <repo>/src/server/mcp/routes/upload.ts`
- `wc -l <repo>/src/server/documents/open.ts <repo>/src/server/yjs/provider.ts <repo>/src/server/events/wake-socket.ts <home>/`
- `node -e "console.log(require('@modelcontextprotocol/sdk/package.json').version)"; f=$(find node_modules/@modelcontextprotocol/sdk/dist -name 'express.js' -path `
- `sed -n 1,330p <repo>/src/server/documents/open.ts | cat -n`
- `sed -n 330,700p <repo>/src/server/documents/open.ts | cat -n | awk -F'\t' '{printf "%d\t%s\n", $1+329, $2}'`
- `sed -n 700,996p <repo>/src/server/documents/open.ts | cat -n | awk -F'\t' '{printf "%d\t%s\n", $1+699, $2}'`
- `cat -n <repo>/src/server/yjs/provider.ts`
- `cat -n <repo>/src/server/events/wake-socket.ts`
- `cd <repo>/src/server/mcp/routes && for f in close.ts save.ts rename.ts; do echo "=== $f"; cat -n $f; done`
- `cd <repo>/src/server/mcp/routes && for f in convert.ts backups.ts sessions.ts rotate-token.ts; do echo "=== $f"; cat -n $f; done`
- `cd <repo>/src/server/mcp/routes && for f in shutdown.ts scratchpad.ts store-reclaim.ts diagnostics.ts document-raw.ts; do echo "=== $f"; cat -n $f; d`
- `cd <repo>/src/server/mcp/routes && for f in annotation-reply.ts remove-annotation.ts mode-release.ts license.ts document-reload.ts external-conflict.`
- `cat -n <repo>/src/server/mcp/channel-routes.ts`
- `cat <transcript tool result, not kept> | sed -n 1,400p`
- `cat <transcript tool result, not kept> | sed -n 400,900p`
- `cd <repo>/src/server/mcp/routes && for f in info.ts notify-stream.ts health.ts mode.ts send-open-result.ts; do echo "=== $f"; cat -n $f; done; echo "`
- `sed -n 1,400p <repo>/src/server/integrations/api-routes.ts | cat -n`
- `sed -n 400,800p <repo>/src/server/integrations/api-routes.ts | cat -n | awk -F'\t' '{printf "%d\t%s\n", $1+399, $2}'`
- `sed -n 800,1174p <repo>/src/server/integrations/api-routes.ts | cat -n | awk -F'\t' '{printf "%d\t%s\n", $1+799, $2}'`
- `cat -n <repo>/src/server/file-io/index.ts; echo ===; cat -n <repo>/src/shared/windows-path-safety.ts`
- `sed -n 1,420p <repo>/src/server/session/manager.ts | cat -n`
- `sed -n 420,802p <repo>/src/server/session/manager.ts | cat -n | awk -F'\t' '{printf "%d\t%s\n", $1+419, $2}'`
- `cat -n <repo>/src/server/events/sse.ts; echo ===; cat -n <repo>/src/server/file-io/doc-backup.ts | head -220`
- `grep -n '^export \(async \)\?function\|^function\|^async function\|^export const\|^const .*= new\|JSON.parse\|Object.assign\|\.\.\.\(existing\|opened\|root\|par`
- `sed -n 240,420p src/server/integrations/apply.ts | cat -n | awk -F'\t' '{printf "%d\t%s\n", $1+239, $2}'`
- `sed -n 520,700p src/server/integrations/apply.ts | cat -n | awk -F'\t' '{printf "%d\t%s\n", $1+519, $2}'`
- `sed -n 980,1130p src/server/integrations/apply.ts | cat -n | awk -F'\t' '{printf "%d\t%s\n", $1+979, $2}'`
- `sed -n 1,400p src/server/launcher/api-routes.ts | cat -n`
- `sed -n 400,786p src/server/launcher/api-routes.ts | cat -n | awk -F'\t' '{printf "%d\t%s\n", $1+399, $2}'`
- `cat -n src/server/models/api-routes.ts`
- `grep -n '^export \(async \)\?function\|^async function\|^function' src/server/mcp/document-service.ts | head -80`
- `cat -n src/server/mcp/convert.ts`
- `cat -n src/server/sentry.ts; echo ====; cat -n src/shared/scrub-text.ts; echo ====; cat -n src/shared/redact-user-paths.ts`
- `cat -n src/server/license/verifier.ts; echo ====; cat -n src/server/license/public-key.ts; echo ====; sed -n 1,200p src/server/license/activation.ts | cat -n`
- `sed -n 1,300p src/server/local-model/ollama-client.ts | cat -n; echo ====; grep -n 'baseUrl\|fetch(\|url' src/server/local-model/config.ts | head -40`
- `grep -rn 'spawn(\|spawnSync(\|execFile(\|execFileSync(\|exec(\|execSync(\|shell: true\|Command::new\|\.arg(\|std::process' src src-tauri/src --include=*.ts --in`
- `grep -n 'resolveRouteCwd\|TANDEM_CLAUDE_CMD\|claudeCmd\|spawn(\|shell\|env:\|process.env\|windowsHide\|args\b.*=' src/server/launcher/supervisor.ts | head -80`
- `cat -n src/server/local-model/config.ts | sed -n 1,140p; echo ====; grep -n 'BYO_MODELS_ENABLED\|startLocalModelCollaborator\|return' src/server/local-model/ind`
- `grep -n 'outputPath\|realpath\|atomicWrite\|endsWith\|annotations\.\(md\|json\)\|rejectUnsafe' src/server/mcp/annotations.ts | head -60; echo ====; grep -n 'bac`
- `sed -n 637,760p src/server/mcp/document-service.ts | cat -n | awk -F'\t' '{printf "%d\t%s\n", $1+636, $2}'`
- `sed -n 974,1100p src/server/mcp/document-service.ts | cat -n | awk -F'\t' '{printf "%d\t%s\n", $1+973, $2}'`
- `grep -n 'registerTool\|server.tool(\|"tandem_[a-zA-Z]*"' src/server/mcp/*.ts | grep -v test | head -60; echo ====; grep -n 'filePath\|z\.\(string\|number\|objec`
- `cat src-tauri/tauri.conf.json; echo ====; ls src-tauri/capabilities/; for f in src-tauri/capabilities/*.json; do echo "--- $f"; cat "$f"; done`
- `cat -n src/server/integrations/install-claude-cli.ts | sed -n 1,260p`
- `cat -n src/client/panels/chat-markdown.ts | head -150; echo ====; cat -n src/shared/sanitize.ts | head -80; echo ====; cat -n src/shared/image-src-safety.ts | h`
- `cat -n src/server/auth/token-store.ts; echo ====; cat -n src/shared/auth/token-file.ts | head -120; echo ====; cat -n src/server/bind-check.ts`
- `cat -n src/shared/cli-runtime.ts; echo ====; grep -n 'TANDEM_URL\|token\|Authorization\|https\|http:' src/stdio-bridge/index.ts src/cli/mcp-stdio.ts src/channel`
- `grep -n 'MAX\|buffer\|length >\|slice(\|shift()\|splice' src/server/events/queue.ts | head -30; echo ====; grep -n 'MAX_\|length >\|byteLength\|1024' src/server`
- `sed -n 380,420p src/server/launcher/supervisor.ts | cat -n | awk -F'\t' '{printf "%d\t%s\n", $1+379, $2}'; echo ...; sed -n 740,835p src/server/launcher/supervi`
- `sed -n 260,470p src/server/integrations/install-claude-cli.ts | cat -n | awk -F'\t' '{printf "%d\t%s\n", $1+259, $2}'`
- `sed -n 380,470p src/server/mcp/document.ts | cat -n | awk -F'\t' '{printf "%d\t%s\n", $1+379, $2}'; echo ...; sed -n 540,640p src/server/mcp/document.ts | cat -`
- `grep -n '#\[tauri::command\]' -A2 src-tauri/src/lib.rs | grep 'fn ' | head -60; echo ...; sed -n 1880,1950p src-tauri/src/lib.rs; echo ...; sed -n 430,520p src-`
- `grep -n 'fn cowork_set_lan_ip_override\|fn cowork_apply_token\|fn cowork_detect_vethernet\|Ipv4Addr\|parse::<\|is_valid_ip\|validate' src-tauri/src/cowork_comma`
- `sed -n 1,140p src/client/editor/utils/url-safety.ts | cat -n; echo ...; sed -n 1,90p src/server/file-io/docx-html.ts | cat -n; echo ...; grep -n 'html\|Html\|DO`
- `sed -n 1,330p src/server/index.ts | cat -n`
- `sed -n 330,720p src/server/index.ts | cat -n | awk -F'\t' '{printf "%d\t%s\n", $1+329, $2}'`
- `sed -n 1,380p src/server/mcp/server.ts | cat -n | grep -v '^\s*[0-9]*\s*\*' | grep -v '^\s*[0-9]*\s*//' | grep -v '^\s*[0-9]*\s*$' | head -220`
- `grep -n 'LoopbackUrl\|AbsolutePath\|z\.\|refine\|strict()' src/server/integrations/schema.ts | head -60; echo ...; sed -n 1,80p src/server/integrations/keychain`
- `cat -n src/cli/rotate-token.ts | sed -n 1,200p`
- `sed -n 140,250p src/server/platform.ts | cat -n | awk -F'\t' '{printf "%d\t%s\n", $1+139, $2}'; echo ...; grep -n 'CHANNEL_EVENT_BUFFER_SIZE\|CHANNEL_EVENT_BUFF`
- `git log --all -p -S'sk-ant-' --oneline 2>/dev/null | grep -E '^\+' | grep -E 'sk-ant-[A-Za-z0-9_-]{20,}' | grep -v 'redacted\|test\|\[' | head -5; echo "---ghp"`
- `ls src-tauri/gen/schemas 2>/dev/null; grep -o '"fs:default"[^}]*' src-tauri/gen/schemas/desktop-schema.json 2>/dev/null | head -3; grep -rn 'fs:default\|allow-r`
- `sed -n 1541,1652p src/server/mcp/document-service.ts | cat -n | awk -F'\t' '{printf "%d\t%s\n", $1+1540, $2}'; echo ...; grep -n 'export function\|export async `
- `sed -n 160,260p src-tauri/src/lib.rs; echo ....; sed -n 2225,2345p src-tauri/src/lib.rs`
- `grep -n 'plugin(tauri_plugin\|\.plugin(\|invoke_handler\|generate_handler' src-tauri/src/lib.rs | head -30; echo ....; grep -n '"@tauri-apps' package.json; echo`
- `git log --all -p -S'TANDEM_AUTH_TOKEN=' --oneline | grep -E '^\+.*TANDEM_AUTH_TOKEN=[A-Za-z0-9_-]{32,}' | head -5; echo "---bearer"; git log --all -p --oneline `
- `grep -n 'import\|XMLParser\|parse(\|DOCTYPE\|ENTITY\|processEntities\|allowBooleanAttributes' src/server/file-io/docx-comments.ts | head -20; echo ....; grep -n`
- `cat -n src/server/startup-file.ts | sed -n 1,120p; echo ....; sed -n 1,120p src/server/mcp/navigation.ts | cat -n`
- `ls dist/ 2>/dev/null; ls dist/server 2>/dev/null | head; which tsx; ls node_modules/.bin/tsx 2>/dev/null; for p in 4918 4919 4928 4929; do (ss -ltn 2>/dev/null `
- `sed -n 1,120p src/stdio-bridge/index.ts | cat -n | grep -v '^\s*[0-9]*\s*\*' | grep -v '^\s*[0-9]*\s*//' | head -90; echo ....; grep -n 'TANDEM_URL\|resolveTand`
- `grep -n 'maxPayload\|maxHttpBufferSize\|timeout\|new Hocuspocus\|extensions' src/server/yjs/provider.ts; node -e "const p=require('@hocuspocus/server/package.js`
- `sed -n 1,80p src/client/utils/fileUpload.ts | cat -n; echo ....; grep -n 'fetch(\|API_BASE\|MCP_BASE_URL\|credentials' src/client/utils/backend-ports.ts src/cli`
- `grep -n 'function resolveCwd\|resolveSafeCwd(\|workingDirectory' src/server/launcher/supervisor.ts | head -20; echo ....; sed -n "$(grep -n 'function resolveCwd`
- `sed -n 2670,2730p src/cli/doctor.ts | cat -n | awk -F'\t' '{printf "%d\t%s\n", $1+2669, $2}'`
- `sed -n 440,500p src-tauri/src/firewall.rs; echo ....; sed -n 880,960p src-tauri/src/firewall.rs; echo ....; grep -n 'fn parse_subnet\|fn validate\|Ipv4\|cidr' s`
- `sed -n 1578,1640p src-tauri/src/lib.rs; echo ....; grep -n '#\[tauri::command\]' -A3 src-tauri/src/keychain.rs src-tauri/src/token_store.rs src-tauri/src/cowork`
- `cat node_modules/@modelcontextprotocol/sdk/dist/esm/server/middleware/hostHeaderValidation.js; echo ....; grep '"version"' node_modules/@hocuspocus/server/packa`
- `grep -rn 'pushNotification(' src/server --include=*.ts -A6 | grep -E 'message:' | grep -E 'filePath|\$\{path\|\$\{p\}|\$\{target|\$\{resolved|\$\{dir|err\.messa`
- `sed -n 1,80p src/server/local-model/collaborator.ts | grep -n 'BYO_MODELS_ENABLED\|return\|wire(\|export function start' ; echo ....; sed -n 1,60p src/server/lo`
- `S=<scratchpad>; mkdir -p $S/probe/appdata $S/probe/home $S/probe/docs; printf '# Hello\n\nSom`
- `grep -rn 'TANDEM_BIND_HOST\|TANDEM_LAN_IP\|TANDEM_ALLOW_UNAUTH' src-tauri/src/*.rs | head -12; echo ....; sed -n 30,100p src-tauri/src/keychain.rs`
- `cd <scratchpad>/probe && B=http://127.0.0.1:4919; echo "== P1 upload 300KB JSON (SDK 100kb pa`
- `B=http://127.0.0.1:4919; for r in open close upload annotation-reply remove-annotation rotate-token save convert apply-changes scratchpad channel-reply mode/rel`
- `B=http://127.0.0.1:4919; echo "== Host variants on /api/info"; for h in 'evil.example' 'localhost:4919' '127.0.0.1.evil.example' '[::1]:4919' '127.0.0.1:4919' '`
- `cat > <scratchpad>/probe/ws.mjs <<'EOF' import WebSocket from "ws"; const cases = [   ["wake `
- `B=http://127.0.0.1:4919; echo "== open a.md via JSON"; curl -s -X POST -H 'Content-Type: application/json' --data '{"filePath":"<scratchpad-path>`
- `pkill -f 'node dist/server/index.js' 2>/dev/null; sleep 1; pgrep -fa 'dist/server/index.js' || echo "probe server stopped"; cat > <scratchpad-path>`
- `P=$(ss -ltnp 2>/dev/null | awk '/:4919 /{match($0,/pid=([0-9]+)/,m); print m[1]}' | head -1); [ -n "$P" ] && kill "$P" && echo "killed server pid $P" || echo "n`
- `(fuser -k 4919/tcp 2>/dev/null || lsof -ti TCP:4919 | xargs -r kill) ; sleep 1; ss -ltn 2>/dev/null | grep -E ':491[89] ' || echo "ports 4918/4919 free"`

## Probe/executed outputs (8)

### node -e "console.log(require('@modelcontextprotocol/sdk/package.json').version)"; f=$(find node_modules/@modelcontextprotocol/sdk/dist -name 'express.js' -path '*server*' | head -1); echo $f; cat -n "
(output 3125 chars)
```
undefined
node_modules/@modelcontextprotocol/sdk/dist/esm/server/express.js
     1	import express from 'express';
     2	import { hostHeaderValidation, localhostHostValidation } from './middleware/hostHeaderValidation.js';
     3	/**
     4	 * Creates an Express application pre-configured for MCP servers.
     5	 *
     6	 * When the host is '127.0.0.1', 'localhost', or '::1' (the default is '127.0.0.1'),
     7	 * DNS rebinding protection middleware is automatically applied to protect against
     8	 * DNS rebinding attacks on localhost servers.
     9	 *
    10	 * @param options - Configuration options
    11	 * @returns A configured Express application
    12	 *
    13	 * @example
    14	 * ```typescript
    15	 * // Basic usage - defaults to 127.0.0.1 with DNS rebinding protection
    16	 * const app = createMcpExpressApp();
    17	 *
    18	 * // Custom host - DNS rebinding protection only applied for localhost hosts
    19	 * const app = createMcpExpressApp({ host: '0.0.0.0' }); // No automatic DNS rebinding protection
    20	 * const app = createMcpExpressApp({ host: 'localhost' }); // DNS rebinding protection enabled
    21	 *
    22	 * // Custom allowed hosts for non-localhost binding
    23	 * const app = createMcpExpressApp({ host: '0.0.0.0', allowedHosts: ['myapp.local', 'localhost'] });
    24	 * ```
    25	 */
    26	export function createMcpExpressApp(options = {}) {
    27	    const { host = '127.0.0.1', allowedHosts } = options;
    28	    const app = express();
    29	    app.use(express.json());
    30	    // If allowedHosts is explicitly provided, use that for validation
    31	    if (allowedHosts) {
    32	        app.use(hostHeaderValidation(allowedHosts));
    33	    }
    34	    else {
    35	        // Apply DNS rebinding protection automatically for localhost hosts
    36	        const localhostHosts = ['127.0.0.1', 'localhost', '::1'];
    37	        if (localhostHosts.includes(host)) {
    38	            app.use(localhostHostValidation());
    39	        }
    40	        else if (host === '0.0.0.0' || host === '::') {
    41	            // Warn when binding to all interfaces without DNS rebinding protection
    42	            // eslint-disable-next-line no-console
    43	            console.warn(`Warning: Server is binding to ${host} without DNS rebinding protection. ` +
    44	                'Consider using the allowedHosts option to restrict allowed hosts, ' +
    45	                'or use authentication to protect your server.');
    46	        }
    47	    }
    48	    return app;
    49	}
    50	//# sourceMappingURL=express.js.map====
node_modules/@modelcontextprotocol/sdk/dist/esm/server/auth/middleware
node_modules/@modelcontextprotocol/sdk/dist/esm/server/middleware
node_modules/@modelcontextprotocol/sdk/dist/esm/server/middleware/hostHeaderValidation.js.map
node_modules/@modelcontextprotocol/sdk/dist/esm/server/middleware/hostHeaderValidation.js
node_modules/@modelcontextprotocol/sdk/dist/esm/server/middlew
```

### ls dist/ 2>/dev/null; ls dist/server 2>/dev/null | head; which tsx; ls node_modules/.bin/tsx 2>/dev/null; for p in 4918 4919 4928 4929; do (ss -ltn 2>/dev/null | grep -q ":$p " && echo "$p busy") || e
(output 139 chars)
```
channel
cli
client
monitor
server
stdio-bridge
index.js
index.js.map
node_modules/.bin/tsx
4918 free
4919 free
4928 free
4929 free
v22.22.2
```

### grep -n 'maxPayload\|maxHttpBufferSize\|timeout\|new Hocuspocus\|extensions' src/server/yjs/provider.ts; node -e "const p=require('@hocuspocus/server/package.json');console.log('hocuspocus',p.version)
(output 1027 chars)
```
102:  hocuspocusInstance = new Hocuspocus({
node:internal/modules/cjs/loader:657
      throw e;
      ^

Error [ERR_PACKAGE_PATH_NOT_EXPORTED]: Package subpath './package.json' is not defined by "exports" in <repo>/node_modules/@hocuspocus/server/package.json
    at exportsNotFound (node:internal/modules/esm/resolve:314:10)
    at packageExportsResolve (node:internal/modules/esm/resolve:661:9)
    at resolveExports (node:internal/modules/cjs/loader:650:36)
    at Function._findPath (node:internal/modules/cjs/loader:717:31)
    at Function._resolveFilename (node:internal/modules/cjs/loader:1369:27)
    at defaultResolveImpl (node:internal/modules/cjs/loader:1025:19)
    at resolveForCJSWithHooks (node:internal/modules/cjs/loader:1030:22)
    at Function._load (node:internal/modules/cjs/loader:1192:37)
    at TracingChannel.traceSync (node:diagnostics_channel:328:14)
    at wrapModuleLoad (node:internal/modules/cjs/loader:237:24) {
  code: 'ERR_PACKAGE_PATH_NOT_EXPORTED'
}

Node.js v22.22.2
5.2.1 8.21.0
```

### S=<scratchpad>; mkdir -p $S/probe/appdata $S/probe/home $S/probe/docs; printf '# Hello\n\nSome text.\n' > $S/probe/docs/a.md; TANDEM_
(output 793 chars)
```
started
[1]+  Done                    TANDEM_APP_DATA_DIR=$S/probe/appdata HOME=$S/probe/home TANDEM_PORT=4918 TANDEM_MCP_PORT=4919 TANDEM_NO_SAMPLE=1 TANDEM_DISABLE_LAUNCHER=1 TANDEM_DISABLE_FIRST_RUN_WIZARD=1 setsid nohup node dist/server/index.js > $S/probe/server.log 2>&1
  WebSocket:   ws://127.0.0.1:4918
  Health:      http://127.0.0.1:4919/health

  Open your AI client (Claude by default) and ask it to review a document.

{"status":"ok","version":"0.24.1","transport":"http","hasSession":false,"push":{"subscribers":0,"lastEventAt":null,"eventCount":0},"delivery":{"pollCount":0,"forwardCount":0,"state":"idle","latencyMs":null,"waitingMs":null,"sincePollMs":null}}
-rw-r--r-- 1 root root 7392859 Sep  2 13:41 <repo>/dist/server/index.js
2026-09-02 09:20:39 -0400 3fb6408
```

### cd <scratchpad>/probe && B=http://127.0.0.1:4919; echo "== P1 upload 300KB JSON (SDK 100kb parser?)"; node -e "process.stdout.write(J
(output 642 chars)
```
== P1 upload 300KB JSON (SDK 100kb parser?)
413
<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Error</title>
</head>
<body>
<pre>PayloadTooLargeError: request entity too large<br> &nbsp; &nbsp;at readStream2 (file://<repo>/dist/server/index.js:102834:21)<br> &nbsp; &nbsp;at getRawBody (file://<repo>/di
== P1b upload 50KB
{"data":{"documentId":"small-cxefns","filePath":"upload://4b5106b9-5f3e-4c70-971a-cdae9d8cd6cd/small.md","fileName":"small.md","format":"md","readOnly":true,"source":"upload","tokenEstimate":12500,"pa
== P1c open 300KB via /api/open body (filePath only, but big padding)
413
```

### B=http://127.0.0.1:4919; for r in open close upload annotation-reply remove-annotation rotate-token save convert apply-changes scratchpad channel-reply mode/release sessions/clear store/reclaim-lock; 
(output 2625 chars)
```
open                   text/plain evil-origin: 400 {"error":"BAD_REQUEST","message":"filePath is required"}
close                  text/plain evil-origin: 400 {"error":"BAD_REQUEST","message":"documentId is required"}
upload                 text/plain evil-origin: 400 {"error":"BAD_REQUEST","message":"fileName is required"}
annotation-reply       text/plain evil-origin: 400 {"error":"BAD_REQUEST","message":"annotationId is required"}
remove-annotation      text/plain evil-origin: 400 {"error":"BAD_REQUEST","message":"annotationId is required"}
rotate-token           text/plain evil-origin: 400 {"error":"BAD_REQUEST","message":"rotate-token requires a JSON body (send {} with Content-Type: application/js
save                   text/plain evil-origin: 403 {"error":"FORBIDDEN","code":"BAD_ORIGIN","message":"Origin not allowlisted for /api/save"}
convert                text/plain evil-origin: 403 {"error":"FORBIDDEN","code":"BAD_ORIGIN","message":"Origin not allowlisted for /api/convert"}
apply-changes          text/plain evil-origin: 403 {"error":"FORBIDDEN","code":"BAD_ORIGIN","message":"Origin not allowlisted for /api/apply-changes"}
scratchpad             text/plain evil-origin: 403 {"error":"FORBIDDEN","code":"BAD_ORIGIN","message":"Origin not allowlisted for /api/scratchpad"}
channel-reply          text/plain evil-origin: 400 {"error":"BAD_REQUEST","message":"text is required"}
mode/release           text/plain evil-origin: 403 {"error":"FORBIDDEN","code":"BAD_ORIGIN","message":"Origin not allowlisted for /api/mode/release"}
sessions/clear         text/plain evil-origin: 403 {"error":"FORBIDDEN","code":"BAD_ORIGIN","message":"Origin not allowlisted for /api/sessions/clear"}
store/reclaim-lock     text/plain evil-origin: 403 {"error":"FORBIDDEN","code":"BAD_ORIGIN","message":"Origin not allowlisted for /api/store/reclaim-lock"}
== DELETE /api/chat preflight from evil
HTTP/1.1 204 No Content
Access-Control-Allow-Methods: GET, POST, DELETE, OPTIONS
Access-Control-Allow-Headers: Content-Type
== DELETE /api/chat direct (curl, no browser)
{"ok":true,"cleared":0}
== POST /api/open JSON with evil Origin (no origin gate — expected to reach handler)
{"data":{"documentId":"a-1wqdfx","filePath":"<scratchpad>/probe/docs/a.md","fileName":"a.md","format":"md","readOnly":false,"source":"file","tokenEstimate":5,"pageEstimate":1,"restoredFromSession":false,"alreadyOpen":false,"forceRelo
== its preflight
HTTP/1.1 204 No Content
Access-Control-Allow-Methods: GET, POST, DELETE, OPTIONS
Access-Control-Allow-Headers: Content-Type
```

### B=http://127.0.0.1:4919; echo "== Host variants on /api/info"; for h in 'evil.example' 'localhost:4919' '127.0.0.1.evil.example' '[::1]:4919' '127.0.0.1:4919' 'TAURI.LOCALHOST' 'tauri.localhost'; do p
(output 1305 chars)
```
== Host variants on /api/info
evil.example                 403
localhost:4919               403
127.0.0.1.evil.example       403
[::1]:4919                   403
127.0.0.1:4919               200
TAURI.LOCALHOST              403
tauri.localhost              403
== Host variants on /mcp (POST non-init)
evil.example                 403
localhost:4919               404
[::1]:4919                   404
127.0.0.1:4919               404
== Origin variants: ACAO on /api/info
null                             (no ACAO)
http://evil.example              (no ACAO)
http://127.0.0.1:9999            Access-Control-Allow-Origin: http://127.0.0.1:9999
https://127.0.0.1                Access-Control-Allow-Origin: https://127.0.0.1
http://tauri.localhost           Access-Control-Allow-Origin: http://tauri.localhost
tauri://localhost                Access-Control-Allow-Origin: tauri://localhost
http://127.0.0.1.evil.example    (no ACAO)
http://localhost:5173            (no ACAO)
== SSE notify-stream ACAO merge
Access-Control-Allow-Origin: http://127.0.0.1:9999
Access-Control-Allow-Headers: Content-Type
Content-Type: text/event-stream
== static traversal
200
200
200
== strict json
<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Error</title>
</head>
<body>
<pre>SyntaxError: Une
```

### B=http://127.0.0.1:4919; echo "== open a.md via JSON"; curl -s -X POST -H 'Content-Type: application/json' --data '{"filePath":"<scratchpad-path>
(output 222 chars)
```
<tool_use_error>InputValidationError: [
  {
    "code": "custom",
    "path": [
      "command"
    ],
    "message": "command contains control characters that would be hidden in the approval dialog"
  }
]</tool_use_error>
```
