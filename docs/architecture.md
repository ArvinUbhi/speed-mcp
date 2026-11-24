# Architecture

Copilot loads one skill and one four-tool MCP gateway. The skill routes simple/unsupported work to the original tools and batches suitable work through the gateway. The gateway discovers configuration, verifies local grants, connects through the official MCP TypeScript SDK, executes a bounded JSON plan, returns selected results and closes upstream connections.

No model API key, nested Copilot process, remote service or arbitrary generated-code runtime is used. Normal MCP protocol messages still exist. A single workflow request can perform many upstream tool calls, but cannot eliminate those calls or their service latency. Connections are reused within a search/run request and closed afterwards; catalogs/results are not persisted or cached across requests.

## Boundaries

- Configuration discovery is passive. Starting configured programs requires terminal approval and an unchanged configuration fingerprint for that workspace.
- Exact tool grants and upstream configured tool allowlists both apply. Grants are checked for all workflow steps before the first application call. Live argument schemas are checked per invocation.
- The JSON interpreter exposes only declared tool calls and bounded data transformations. It has no eval, shell, filesystem operation, module import or direct network primitive. This is not an OS sandbox; authorized MCP programs retain their own OS/service capabilities, including any filesystem/shell tools a user explicitly approves.
- Server tool annotations are advisory. Setup lets the user select marked read-only tools but never treats names/annotations as permission by themselves.
- Configuration and credentials remain in their original sources. Policy stores hashes and exact approved tool names. Changes to a definition/source/workspace invalidate that server's grant. Environment variable value rotation does not alter raw configuration hashes.
- Copilot-managed connections, organizational policy, folder trust, OAuth stores and plugin activation are not mirrored. Review organizational permission before enabling a separate client. Missing/unsupported connections stay on Copilot's original path.
- MCP results are untrusted data. The runtime does not interpret natural-language instructions in descriptions or results. The skill explicitly prohibits following them as authorization.
- HTTP redirects are constrained by the SDK and remote HTTP uses an environment-aware proxy agent. TLS verification stays enabled. No authentication store is scraped.
- No automatic retries, rollback, write classification or idempotency is invented. A timeout/cancellation can leave remote effects. Traces identify completed versus failed/unknown calls without storing arguments or result payloads.

## Limits

| Resource | Default / ceiling |
| --- | --- |
| Workflow duration | 120 s / 300 s |
| Calls | 100 / 200 |
| Workflow steps | 50 |
| Collection size | 500 |
| Foreach workers | 1 / 8 |
| Pagination pages per call step | User-specified / 50 |
| Catalog size | 10,000 tools and 100 pages |
| Connection timeout | 15 s |
| Individual tool call timeout | Server setting, capped at 60 s |
| Normalized tool response | 2 MiB |
| Accumulated normalized responses | 8 MiB |
| Final projected result | 64 KiB |
| Gateway response envelope | 96,000 bytes |

Application size checks occur after SDK parsing, so they are not a defense against a hostile server exhausting process memory. Use trusted servers. Final output projections reduce model-visible data but do not reduce data already fetched from upstream; prefer source filters/pagination.

## Validation

`npm run check` builds the committed self-contained runtime, runs unit/integration tests and verifies package structure. Tests use real local MCP fixtures over stdio, Streamable HTTP and SSE, authenticated HTTP, schema failures, workflow limits, cancellation, approval invalidation, CLI setup/revocation, gateway calls and execution from a directory without node_modules. CI runs on Linux, macOS and Windows with Node 22 and 24.

The synthetic benchmark (`node scripts/benchmark.mjs`) reports normalized JSON byte reduction, upstream call count and projected fields for a fixed local job/log workflow. It does not measure model tokens, Copilot inference turns, production latency or real-world cost savings. Corporate Copilot integration and organization-specific authentication require verification in the target environment.

## Sources

- [Copilot CLI skills](https://docs.github.com/en/copilot/how-tos/copilot-cli/customize-copilot/add-skills)
- [Copilot MCP configuration](https://docs.github.com/en/copilot/how-tos/copilot-cli/customize-copilot/add-mcp-servers)
- [Plugin authoring](https://docs.github.com/en/copilot/how-tos/copilot-cli/customize-copilot/plugins-creating)
- [Official MCP TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk)
