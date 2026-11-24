# Setup and troubleshooting

## Installation

Install the COMPLETE plugin, not just the SKILL.md:

```text
copilot plugin install ArvinUbhi/speed-mcp
```

Require Node.js 22+ on PATH and a Copilot CLI version supporting Agent Plugins 1.0. The plugin includes its runtime and dependencies. Users do not run npm install. The gateway is a child process of Copilot, not a separately administered daemon. Local upstream MCPs still require their own configured executable/runtime, just as in Copilot.

If the enterprise marketplace is the distribution route, register this repository in the organization's existing catalog. Do not create a second marketplace unless requested. If GitHub downloads are blocked, distribute a complete checkout through the approved internal channel and install it using `copilot plugin install "<local-plugin-directory>"`.

## First use

1. Locate the skill's installed directory from its loaded context or `/skills info speed-mcp`. Do not assume a cache version/path.
2. Determine the user's absolute task workspace.
3. Run status through the gateway or the skill wrapper. This is read-only discovery and starts no upstream process.
4. Present ONE exact terminal command using the installed wrapper path:

```text
node "<absolute-skill-directory>/scripts/speed-mcp.mjs" setup --workspace "<absolute-task-workspace>"
```

5. Have the user run it in their own terminal. Setup lists each server's source, transport, executable/host and workspace. It asks before starting the server to inspect its catalog, then asks for exact tool names or `read-only`. The latter is a convenient selection based on advisory server annotations; it is not independent proof of safety. Enter blank to skip a server. Only approved names are stored.
6. Re-run status, then search/describe the tools needed for the actual task. A setup report can contain connection failures even if other servers succeeded. Check each report state.

Terminal setup is deliberately not an MCP tool. Do not edit policy.json or silently call setup with --yes. For scripted rollout, `setup --server NAME --allow exact_tool,another_tool --yes` is available only after explicit authorization of those tool names. Do not grant `*`; tool grants are exact names.

Approvals are local to the workspace's canonical absolute path and exact configuration hash. A new workspace, changed server definition, changed source path or moved plugin configuration may require setup again. Version updates alone do not clear approvals; a hash change only occurs when the discovered server definition, source or workspace changes. New tools are never auto-approved. Setup replaces the selected server's approved tool list; it does not append silently.

## Configuration sources

Precedence, lowest to highest:

1. `COPILOT_HOME/mcp-config.json`, or `~/.copilot/mcp-config.json` if COPILOT_HOME is unset.
2. Within a Git repository, each directory from its root to the task workspace: `.github/mcp.json`, then `.mcp.json`. The nearer directory wins. `.git` can be a directory or a worktree file. Outside a Git repository, no ancestor repository files are loaded.
3. The passive `copilot mcp list --json` configuration export adds servers absent from JSON discovery, including installed-plugin definitions. JSON server hashes remain stable; exported disabled state is respected.
4. Explicit extra files in `SPEED_MCP_CONFIGS` (OS path delimiter), followed by repeated `--config` CLI arguments or gateway `configs` entries.

Accepted envelopes: `{ "mcpServers": {...} }`, `{ "servers": {...} }` and a bare server map. This permits explicitly supplying a VS Code-format file, but Speed MCP does not automatically scan `.vscode/mcp.json`. Input files must be JSON, not JSONC. The CLI export does not replace host policy enforcement or supply OAuth sessions. Exported sources appear as `copilot:plugin:NAME` in status; review them privately with `copilot mcp get SERVER --json`. A malformed discovered file causes an explicit error rather than silently ignoring part of the configuration.

The plugin's own gateway definition and recognizable recursive copies are skipped. Never pass Speed MCP's own mcp.json as an upstream source.

Plugin MCPs are discovered automatically when Copilot provides a supported configuration export. This inventories configuration without starting upstream MCPs, and avoids guessing internal plugin-cache paths. The export is capped at 2 MiB and 8 seconds; missing/older CLI versions or unsupported output fall back to JSON files with a warning. Set SPEED_MCP_COPILOT_BIN to the trusted Copilot executable if it is not on PATH, or SPEED_MCP_DISCOVERY=json to use files only. No separate configuration copy is saved. For a server absent from both sources, use the direct tool, or establish the actual upstream plugin mcp.json path and explicitly include it in setup AND subsequent requests. Do not scrape authentication caches. For persistent additional sources, configure SPEED_MCP_CONFIGS in the shell that launches Copilot; separate multiple paths with `;` on Windows or `:` on Unix.

Example for an established extra file:

```text
node "<absolute-skill-directory>/scripts/speed-mcp.mjs" setup --workspace "<workspace>" --config "<upstream-plugin>/mcp.json"
```

The gateway request must then include `"configs":["<upstream-plugin>/mcp.json"]`, or inherit the same SPEED_MCP_CONFIGS. Explicit source order is deliberate and can override existing names; status identifies the winning source. Always inspect the source before approval.

## Supported definitions

| Setting | Behavior |
| --- | --- |
| `type: local` or `stdio` | Start configured `command` and `args` with no application-added shell |
| `type: http` or `streamable-http` | Streamable HTTP transport |
| `type: sse` | Legacy SSE transport |
| Type omitted | Infer HTTP if URL exists, otherwise stdio |
| `disabled: true` / `enabled: false` | Never connect |
| `tools` | Configuration allowlist applies in addition to local grants; `[]` permits no tools |
| `timeout` | Per-request timeout, capped at 60 seconds for calls |
| `cwd` / `workingDirectory` | Resolve relative to task workspace; default is the workspace |
| `env` | Explicit configured child-process variables; `${NAME}` and `${env:NAME}` expand from the parent shell |
| `headers` | Explicit headers, with the same environment expansion |
| `${PLUGIN_ROOT}` | Root supplied by Copilot for exported plugin definitions, or directory containing an explicitly supplied upstream MCP JSON |
| `${input:...}` or OAuth/OIDC fields | Unsupported host-managed credentials; use direct tools |

No automatic interactive OAuth login or credential-store integration exists. A remote definition with only a URL may still require Copilot-managed OAuth; if the helper cannot authenticate, use the original tool. Never promise setup can export Copilot's authenticated session.

Stdio inherits the SDK's standard OS environment plus proxy/certificate variables, then explicit server env overrides. Credentials not included in that environment must be declared in the upstream `env` map; do not assume every shell variable is inherited.

Remote endpoints require HTTPS except loopback HTTP. Embedded URL credentials and cross-origin redirects are not supported. The helper does not expose credentials in status. Upstream process stderr is drained without forwarding it to the model. Tool result projections can still contain sensitive application data, so select fields appropriate to the user's task.

## Corporate proxy and certificates

The HTTP client uses an environment-aware proxy agent with HTTP_PROXY, HTTPS_PROXY and NO_PROXY (and supported lowercase forms). Stdio servers receive those variables but decide themselves how to handle them. Start Copilot from the shell containing the existing proxy configuration; do not ask the user to paste proxy credentials.

For corporate TLS, use the organization's certificate bundle via NODE_EXTRA_CA_CERTS before launching Node/Copilot. Never use NODE_TLS_REJECT_UNAUTHORIZED=0 or disable TLS verification. SDK remote connections do not inherit Copilot-specific custom fetch implementations.

## Commands and state

Run commands through `node "<skill-directory>/scripts/speed-mcp.mjs" COMMAND`:

- `status --workspace PATH`: inspect sources and approvals without starting servers.
- `doctor --workspace PATH`: connect to already approved servers and count available tools; never invokes application tools.
- `search --query TEXT --server NAME --workspace PATH`: narrow catalog search.
- `describe --server NAME --tool NAME --workspace PATH`: one original tool schema.
- `validate --file PLAN`: check structure, expression syntax, reference scope and step order without connections.
- `plan --file PLAN --workspace PATH`: check live catalogs/grants/static arguments without application calls.
- `run --file PLAN --workspace PATH`: execute a bounded workflow.
- `revoke --server NAME --workspace PATH`: remove that server's local grant.

All commands accept repeated `--config PATH`. Policy defaults to `~/.copilot/speed-mcp/policy.json` (under COPILOT_HOME when set); SPEED_MCP_HOME overrides its containing directory. Policy contains hashes, tool names and approval timestamps, not copied server credentials. File modes are restrictive on Unix; Windows protection depends on the user's directory ACLs. Setup and revoke merge changes against fresh state under a cross-process file lock, so simultaneous sessions do not overwrite each other’s approvals. A busy or leftover crash lock reports POLICY_BUSY; inspect it before manually removing it. Invalid policy records fail closed. The policy is a local trust record, not a security boundary against a process that can edit the user's files.

## Troubleshooting sequence

Inspect status first. If ready but connection fails, run doctor. Check the original source file privately, configured executable availability, working directory, parent-shell environment, proxy, corporate certificates and authentication. Do not dump secrets to the conversation. If the server works only through Copilot's own host-managed connection, use that direct tool rather than repeatedly reconnecting. A server that cannot tolerate two instances may need direct-tool fallback too.
