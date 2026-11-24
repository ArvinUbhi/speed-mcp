#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { discover, loadPolicy, savePolicy, materialize, policyPath, fail } from './config.mjs';
import { Pool } from './pool.mjs';
import { status, search, describe, run } from './service.mjs';
import { serve } from './server.mjs';
import { checkWorkflow } from './engine.mjs';

export function parse(argv) {
  const command = argv[0] ?? 'help'; const options = { configs: [] };
  const flags = { '--workspace':'workspace','--config':'configs','--server':'server','--tool':'tool','--query':'query','--file':'file','--allow':'allow' };
  for (let i = 1; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--yes') { options.yes = true; continue; }
    const key = flags[arg];
    if (!key || !argv[i + 1] || argv[i + 1].startsWith('--')) fail('USAGE', `Unknown or missing option ${arg}. Run help.`);
    const value = argv[++i];
    if (key === 'configs') options.configs.push(value); else options[key] = value;
  }
  return { command, options };
}
export async function setup(options) {
  const inventory = await discover(options); const policy = await loadPolicy();
  const names = options.server ? [options.server] : [...inventory.servers.keys()];
  if (options.yes && (!options.server || options.allow === undefined)) fail('USAGE', 'Noninteractive setup requires --server NAME --allow exact,tool,names --yes. Do not generate grants without the user explicitly approving those tools.');
  if (!options.yes && !stdin.isTTY) fail('TERMINAL_REQUIRED', 'Run setup in your own interactive terminal, or explicitly specify --server, --allow and --yes.');
  const rl = options.yes ? null : createInterface({ input: stdin, output: stdout });
  const reports = [];
  try {
    for (const name of names) {
      const entry = inventory.servers.get(name);
      if (!entry) fail('SERVER_UNAVAILABLE', `Unknown server ${name}. Run status.`);
      let c;
      try { c = materialize(entry); } catch (e) { reports.push({ server: name, state: e.code, message: e.message }); continue; }
      if (rl) {
        stdout.write(`\nServer: ${name}\nSource: ${entry.source}\nWorkspace: ${entry.workspace}\nTransport: ${c.kind}\n`);
        stdout.write(c.command ? `Executable: ${c.command}\n` : `Remote host: ${new URL(c.url).host}\n`);
        stdout.write('Review this configuration file yourself, including arguments, environment and tool permissions. Local MCP programs run with your OS privileges. Speed MCP does not import Copilot enterprise policy or tool approvals.\n');
        if ((await rl.question('Start this server to inspect its tools? Type yes: ')).trim() !== 'yes') { reports.push({ server: name, state: 'skipped' }); continue; }
      }
      const temporary = { version: 1, grants: { [`${entry.workspace}::${name}`]: { fingerprint: entry.fingerprint, tools: [] } } };
      const pool = new Pool(inventory, temporary);
      try {
        const catalog = await pool.catalog(name);
        let selected;
        if (rl) {
          for (const t of catalog) stdout.write(`  ${t.name}${t.annotations?.readOnlyHint === true ? ' [server claims read-only]' : ''}\n`);
          stdout.write('Annotations are advisory, not proof of safety. Approve only tools you are allowed to use.\n');
          const answer = (await rl.question('Exact comma-separated tool names, "read-only" for marked tools, or blank to skip: ')).trim();
          selected = answer === 'read-only' ? catalog.filter(t => t.annotations?.readOnlyHint === true && t.annotations?.destructiveHint !== true).map(t => t.name) : answer.split(',').map(s => s.trim()).filter(Boolean);
        } else selected = options.allow.split(',').map(s => s.trim()).filter(Boolean);
        if (selected.some(t => !catalog.some(d => d.name === t))) fail('TOOL_UNAVAILABLE', 'An approval names an unavailable tool. Nothing saved for this server.');
        if (!selected.length) { reports.push({ server: name, state: 'skipped' }); continue; }
        policy.grants[`${entry.workspace}::${name}`] = { fingerprint: entry.fingerprint, tools: [...new Set(selected)], approvedAt: new Date().toISOString() };
        await savePolicy(policy);
        reports.push({ server: name, state: 'approved', tools: selected });
      } catch (e) { reports.push({ server: name, state: e.code ?? 'CONNECTION_FAILED', message: pool.sanitize(e.message) }); }
      finally { await pool.close(); }
    }
  } finally { rl?.close(); }
  return { policyFile: policyPath(), reports, notice: 'Approvals apply only to the displayed workspace and exact server configuration. Direct Copilot tools retain their own permissions.' };
}
async function readPlan(file) {
  if (!file) fail('USAGE', 'Provide --file workflow.json.');
  const stat = await fs.stat(file);
  if (stat.size > 1024 * 1024) fail('REQUEST_LIMIT', 'Workflow exceeds 1 MiB.');
  return JSON.parse(await fs.readFile(file, 'utf8'));
}
const help = `Speed MCP — less tool chatter, more work. Node 22+; no npm install needed.\n\nnode dist/speed-mcp.mjs COMMAND [OPTIONS]\n\n  status                   Discover configuration; never starts upstream servers\n  setup                    Interactively approve servers and exact tools\n  doctor                   Test connections for approved servers\n  search --query TEXT      Find relevant tools (optional --server NAME)\n  describe --server NAME --tool NAME\n  validate --file PLAN     Validate workflow structure without any MCP calls\n  run --file PLAN          Run an approved bounded JSON workflow\n  revoke --server NAME     Remove that workspace's local approval\n  serve                    Start the four-tool stdio MCP gateway\n\nCommon: --workspace ABSOLUTE_PATH, --config UPSTREAM_JSON (repeatable)\nNoninteractive setup: --server NAME --allow tool_one,tool_two --yes\nOnly use --yes after the user explicitly approved those exact tools.\nSPEED_MCP_HOME overrides policy location; COPILOT_HOME overrides Copilot config home.\nSPEED_MCP_CONFIGS supplies extra config paths separated by the OS path delimiter.\nManaged policy, live sessions and Copilot OAuth caches are never imported.\n`;
export async function main(argv = process.argv.slice(2)) {
  if (Number(process.versions.node.split('.')[0]) < 22) fail('NODE_VERSION', 'Speed MCP requires Node.js 22 or newer on PATH.');
  const { command, options } = parse(argv);
  let value;
  switch (command) {
    case 'help': case '--help': stdout.write(help); return;
    case 'serve': await serve(options); return;
    case 'status': value = await status(options); break;
    case 'setup': value = await setup(options); if (value.reports.some(r => !['approved','skipped'].includes(r.state))) process.exitCode = 1; break;
    case 'search': value = await search(options.query ?? '', options); break;
    case 'describe': if (!options.server || !options.tool) fail('USAGE', 'Provide --server and --tool.'); value = await describe(options.server, options.tool, options); break;
    case 'run': value = await run(await readPlan(options.file), options); if (!value.ok) process.exitCode = 1; break;
    case 'validate': checkWorkflow(await readPlan(options.file)); value = { ok: true, notice: 'Structure is valid. Live schemas, permissions and result paths are checked at execution.' }; break;
    case 'doctor': {
      const report = await status(options); const inventory = await discover(options); const policy = await loadPolicy(); const pool = new Pool(inventory, policy);
      try {
        for (const entry of report.servers) {
          if (entry.state !== 'ready') continue;
          try { entry.availableTools = (await pool.catalog(entry.name)).length; entry.state = 'connected'; }
          catch (e) { entry.state = e.code ?? 'CONNECTION_FAILED'; entry.reason = pool.sanitize(e.message); }
        }
      } finally { await pool.close(); }
      value = report; break;
    }
    case 'revoke': {
      if (!options.server) fail('USAGE', 'Provide --server NAME.');
      const inventory = await discover(options); const policy = await loadPolicy(); delete policy.grants[`${inventory.workspace}::${options.server}`]; await savePolicy(policy); value = { ok: true, revoked: options.server }; break;
    }
    default: fail('USAGE', 'Unknown command. Run help.');
  }
  stdout.write(JSON.stringify(value, null, 2) + '\n');
}
export function reportError(e) {
  const known = typeof e.code === 'string' && /^[A-Z_]+$/.test(e.code);
  process.stderr.write(JSON.stringify({ ok: false, error: { code: known ? e.code : 'FAILED', message: known ? e.message : 'Operation failed. Check the input file and configuration; internal details are withheld to protect credentials.' } }) + '\n');
  process.exitCode = 1;
}
// Node resolves symlinked entrypoints (including macOS /var -> /private/var) in import.meta.url.
const canonicalFile = async file => {
  const resolved = await fs.realpath(path.resolve(file)).catch(() => path.resolve(file));
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
};
const invokedFile = process.argv[1] ? await canonicalFile(process.argv[1]) : null;
if (invokedFile === await canonicalFile(fileURLToPath(import.meta.url))) main().catch(reportError);
