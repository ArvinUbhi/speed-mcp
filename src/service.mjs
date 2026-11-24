import { discover, loadPolicy, authorize, materialize, fail } from './config.mjs';
import { Pool } from './pool.mjs';
import { runWorkflow } from './engine.mjs';

export async function context(options = {}) {
  const inventory = await discover(options); const policy = await loadPolicy(options.policyFile);
  return { inventory, policy, pool: new Pool(inventory, policy) };
}
export async function status(options = {}) {
  const inventory = await discover(options); const policy = await loadPolicy(options.policyFile);
  return {
    workspace: inventory.workspace, discoveryMode: inventory.discoveryMode, sources: inventory.sources, scope: inventory.scope, warnings: inventory.warnings,
    servers: [...inventory.servers.values()].map(entry => {
      let state = 'ready'; let reason;
      try { materialize(entry); authorize(entry, policy); } catch (e) { state = e.code; reason = e.message; }
      return { name: entry.name, source: entry.source, transport: entry.raw.type ?? (entry.raw.url ? 'http' : 'stdio'), state, reason,
        approvedTools: state === 'ready' ? authorize(entry, policy).tools : [] };
    }),
    fallback: 'Use the original Copilot MCP tools for servers absent here, host-managed OAuth, or operations outside Speed MCP grants.'
  };
}
export async function search(query, options = {}) {
  const { inventory, policy, pool } = await context(options);
  try {
    const names = options.server ? [options.server] : [...inventory.servers.keys()];
    const terms = query.toLowerCase().split(/\s+/).filter(Boolean); const matches = []; const unavailable = [];
    for (const name of names) {
      const entry = pool.entry(name);
      try {
        const grant = authorize(entry, policy);
        for (const tool of await pool.catalog(name)) {
          const haystack = `${name} ${tool.name} ${tool.description ?? ''}`.toLowerCase();
          const score = terms.filter(t => haystack.includes(t)).length;
          if (score || !terms.length) matches.push({ server: name, tool: tool.name, description: (tool.description ?? '').slice(0, 350), approved: grant.tools.includes(tool.name), score });
        }
      } catch (e) { unavailable.push({ server: name, code: e.code ?? 'CONNECTION_FAILED', message: pool.sanitize(e.message) }); }
    }
    matches.sort((a,b) => b.score - a.score || a.tool.localeCompare(b.tool));
    return { matches: matches.slice(0, 20), totalMatches: matches.length, unavailable };
  } finally { await pool.close(); }
}
export async function describe(server, tool, options = {}) {
  const { pool } = await context(options);
  try {
    const entry = (await pool.catalog(server)).find(t => t.name === tool);
    if (!entry) fail('TOOL_UNAVAILABLE', 'Tool is absent or excluded by server configuration.');
    if (Buffer.byteLength(JSON.stringify(entry)) > 60000) fail('SCHEMA_LIMIT', 'Tool schema is too large. Use the direct Copilot tool.');
    return entry;
  } finally { await pool.close(); }
}
export async function run(plan, options = {}) {
  const { pool } = await context(options);
  try { return await runWorkflow(plan, pool, { signal: options.signal, dryRun: options.dryRun }); }
  finally { await pool.close(); }
}
