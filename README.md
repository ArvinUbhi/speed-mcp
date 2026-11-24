# Speed MCP

**Less tool chatter. More work.**

Batch MCP calls, follow dependencies, paginate and filter results before they reach Copilot. Reuse your existing MCP JSON. Keep the evidence. Drop the noise.

```sh
copilot plugin install ArvinUbhi/speed-mcp
```

Then ask Copilot:

> Use /speed-mcp to investigate my failed jobs using the available MCP tools.

On first use, Copilot gives you a terminal setup command. Review the discovered servers and approve the tools you want. Approvals are scoped to each workspace; changed configurations need approval again.

**Node.js 22+ and a Copilot CLI supporting Agent Plugins 1.0. No npm install. No extra API key. No background service to manage.**

- Four gateway tools: status, search, describe, run.
- Bounded JSON workflows: loops, concurrency, pagination, conditions and projections.
- Stdio, Streamable HTTP and SSE. Proxy-aware HTTP. Live argument validation.
- Bundled runtime, detailed skill, explicit grants and execution traces.

Reuses **configuration**, opening its own connections. Copilot-managed OAuth, built-in connectors and unsupported servers use Copilot's original tools. Plugin-only upstream JSON can be supplied explicitly. Copilot enterprise policy and approvals are not imported; use only where permitted.

[Setup & compatibility](skills/speed-mcp/references/setup.md) · [Workflow language](skills/speed-mcp/references/workflows.md) · [Architecture](docs/architecture.md)

Development: `npm ci && npm run check`. MIT.
