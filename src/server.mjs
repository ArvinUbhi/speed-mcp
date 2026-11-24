import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import Ajv from 'ajv';
import { status, search, describe, run } from './service.mjs';
import { closeAllPools } from './pool.mjs';
import { workflowSchema } from './engine.mjs';
const common = { workspace: { type: 'string', description: 'Absolute working directory of the user task. Always provide it.' }, configs: { type: 'array', items: { type: 'string' }, maxItems: 20, description: 'Optional explicit upstream MCP JSON paths. Never pass the Speed MCP gateway config.' } };
const schema = (properties, required = []) => ({ type: 'object', additionalProperties: false, properties: { ...common, ...properties }, required: ['workspace', ...required] });
export const tools = [
  { name: 'speed_mcp_status', description: 'Inspect discovered upstream MCP JSON and existing local approvals without starting any server. Missing/OAuth/unapproved tools must use the original Copilot tools. Never changes configuration or grants.', inputSchema: schema({}) },
  { name: 'speed_mcp_search', description: 'Search live tool catalogs of approved upstream MCP servers. Returns at most 20 names and short descriptions, not every schema. Server startup can execute its configured command. Narrow with server when possible.', inputSchema: schema({ query: { type: 'string', maxLength: 200 }, server: { type: 'string' } }, ['query']) },
  { name: 'speed_mcp_describe', description: 'Read the exact current input schema for one upstream MCP tool. Inspect this before building a workflow; never invent arguments or result paths.', inputSchema: schema({ server: { type: 'string' }, tool: { type: 'string' } }, ['server','tool']) },
  { name: 'speed_mcp_run', description: 'Execute a bounded version-1 JSON workflow over explicitly approved MCP tools. Supports dependent steps, foreach, pagination, conditions and projections. No arbitrary JavaScript/shell. No retries or rollback. On failure inspect trace and do not blindly rerun completed writes. Read the speed-mcp skill workflow reference first.', inputSchema: schema({ workflow: workflowSchema }, ['workflow']) }
];
export async function serve(options = {}) {
  const server = new Server({ name: 'speed-mcp', version: '1.0.0' }, { capabilities: { tools: {} } });
  const ajv = new Ajv({ strict: false }); const checks = new Map(tools.map(t => [t.name, ajv.compile(t.inputSchema)]));
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));
  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    try {
      const args = request.params.arguments ?? {}; const check = checks.get(request.params.name);
      if (!check || !check(args)) throw Object.assign(new Error('Unknown tool or invalid arguments. Inspect the declared input schema.'), { code: 'ARGUMENTS_INVALID' });
      if (Buffer.byteLength(JSON.stringify(args)) > 1024 * 1024) throw Object.assign(new Error('Request exceeds 1 MiB.'), { code: 'REQUEST_LIMIT' });
      const opts = { ...options, workspace: args.workspace, configs: [...(options.configs ?? []), ...(args.configs ?? [])], signal: extra.signal };
      let value;
      switch (request.params.name) {
        case 'speed_mcp_status': value = await status(opts); break;
        case 'speed_mcp_search': value = await search(args.query, { ...opts, server: args.server }); break;
        case 'speed_mcp_describe': value = await describe(args.server, args.tool, opts); break;
        case 'speed_mcp_run': value = await run(args.workflow, opts); break;
      }
      const text = JSON.stringify(value);
      if (Buffer.byteLength(text) > 96000) throw Object.assign(new Error('Response too large. Narrow to one server or tool.'), { code: 'OUTPUT_LIMIT' });
      return { content: [{ type: 'text', text }], isError: value.ok === false };
    } catch (e) {
      // Never echo unexpected SDK/configuration errors: these may contain credentials.
      const known = typeof e.code === 'string' && /^[A-Z_]+$/.test(e.code);
      return { content: [{ type: 'text', text: JSON.stringify({ ok: false, error: { code: known ? e.code : 'REQUEST_FAILED', message: known ? e.message : 'Request failed. Check terminal doctor; no credentials are returned.' } }) }], isError: true };
    }
  });
  await server.connect(new StdioServerTransport());
  const close = async () => { await closeAllPools(); await server.close(); process.exit(0); };
  process.once('SIGTERM', close); process.once('SIGINT', close);
  process.stdin.once('end', close);
  return server;
}
