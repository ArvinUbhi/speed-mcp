# Speed MCP

**Less tool chatter. More work.**

Batch MCP calls, follow dependencies, paginate and filter results before they reach Copilot. Discover existing MCPs from Copilot and your MCP JSON. Keep the evidence. Drop the noise.

```sh
copilot plugin install ArvinUbhi/speed-mcp
```

Then ask Copilot:

> Use /speed-mcp to investigate my failed jobs using the available MCP tools.

On first use, Copilot gives you a terminal setup command. Review the discovered servers and approve the tools you want. Approvals are scoped to each workspace; changed configurations need approval again.

**Node.js 22+ and a Copilot CLI supporting Agent Plugins 1.0. No npm install. No extra API key. No background service to manage.**

- Automatically finds plugin MCPs through Copilot’s configuration export.
- Dry-run plans check references, permissions and static arguments before execution.
- Four gateway tools: status, search, describe, run.
- Bounded JSON workflows: loops, concurrency, pagination, conditions and projections.
- Stdio, Streamable HTTP and SSE. Proxy-aware HTTP. Live argument validation.
- Bundled runtime, detailed skill, explicit grants and execution traces.

Reuses **configuration**, opening its own connections. Copilot-managed OAuth, built-in connectors and unsupported servers use Copilot's original tools. If configuration export is unavailable, JSON discovery still works. Copilot enterprise policy and approvals are not imported; use only where permitted.

## Manual setup on a work PC (Windows)

No GitHub access from Copilot, Git installation, npm install or build is needed. Node.js 22+ must be available on the work PC (`node --version`). Your existing upstream MCP programs and credentials are still required.

### 1. Copy the files

On a machine that can access GitHub, open this repository, choose **Code → Download ZIP**, and extract it. Transfer the extracted folder through your approved internal file-sharing route. If browser downloads work on the work PC, you can download and extract it there instead.

Choose a folder you can write to, for example `C:\Tools\speed-mcp`. This is just an example: use your actual extracted folder path in every command below. You do not need to set `USERPROFILE` or `HOME`. Put the files there, with `plugin.json` directly inside it—not inside a second `speed-mcp-main` folder. Keep the whole folder structure, especially `dist/`, `skills/`, `plugin.json`, `mcp.json` and `LICENSE`. The runtime and its dependencies are already bundled in `dist/`; do not copy just `SKILL.md` or run npm.

### 2. Install from the local folder

In PowerShell:

```powershell
$speedMcpRoot = 'C:\Tools\speed-mcp' # Replace with your actual folder path
copilot plugin install "$speedMcpRoot"
```

This installs from the files on your PC; it does not fetch the plugin from GitHub.

### 3. Approve your existing MCP tools

Open PowerShell in the repository you want Copilot to work on, **not** the Speed MCP folder. Run:

```powershell
$speedMcpRoot = 'C:\Tools\speed-mcp' # Replace with your actual folder path
node "$speedMcpRoot\dist\speed-mcp.mjs" status --workspace "$PWD"
node "$speedMcpRoot\dist\speed-mcp.mjs" setup --workspace "$PWD"
```

Review each discovered server and select the exact tools to approve. No second MCP configuration is normally needed. Open a new Copilot session, check `/skills list` and `/mcp`, then ask it to use `/speed-mcp`. Approvals are per workspace; repeat setup for another repository. Host-managed OAuth connections continue through Copilot's original tools.

### If local plugin installation is unavailable

Keep the same complete folder at the same path. Register its skill from disk:

```powershell
$speedMcpRoot = 'C:\Tools\speed-mcp' # Replace with your actual folder path
copilot skill add "$speedMcpRoot\skills\speed-mcp"
```

Locate the MCP configuration file using Node's home-directory lookup, without relying on `USERPROFILE`:

```powershell
node -p "require('node:path').join(process.env.COPILOT_HOME || require('node:path').join(require('node:os').homedir(), '.copilot'), 'mcp-config.json')"
```

This also respects `COPILOT_HOME` if you already use a custom Copilot settings directory. Back up the file at the printed path privately and add the `speed-mcp` entry **alongside** your other servers. Create the file with this envelope only if it does not exist:

```json
{
  "mcpServers": {
    "speed-mcp": {
      "type": "stdio",
      "command": "node",
      "args": [
        "C:/Tools/speed-mcp/dist/speed-mcp.mjs",
        "serve"
      ],
      "tools": ["*"]
    }
  }
}
```

Replace `C:/Tools/speed-mcp` with the actual absolute path where you copied Speed MCP. Use forward slashes in JSON paths as shown. If Node is not on Copilot's PATH, set `command` to the absolute path of your approved Node executable. Do not paste the plugin's `${PLUGIN_ROOT}` placeholder into this user configuration; it needs a real absolute path here.

Restart the Copilot session and follow step 3. The skill must stay in the complete Speed MCP folder because its launcher uses the bundled runtime via relative paths. If your organization also disables custom skills or MCP servers, an administrator will need to enable this setup.

### Manual updates

Replace the transferred folder with the new version, keeping its path unchanged. For a local plugin install, run `copilot plugin install "$speedMcpRoot"` again so Copilot refreshes its cached copy, then open a new session. For the direct skill/MCP setup, replace the files and open a new session. Existing approvals remain valid when the upstream server definitions and workspace are unchanged.

[Setup & compatibility](skills/speed-mcp/references/setup.md) · [Workflow language](skills/speed-mcp/references/workflows.md) · [Architecture](docs/architecture.md)

Update: `copilot plugin update speed-mcp`. Development: `npm ci && npm run check`. MIT.
