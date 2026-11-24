import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import { copilotInventory } from './copilot-config.mjs';

export class SpeedError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}
export const fail = (code, message) => { throw new SpeedError(code, message); };
export const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export const homeDir = () => path.resolve(process.env.SPEED_MCP_HOME || path.join(process.env.COPILOT_HOME || path.join(os.homedir(), '.copilot'), 'speed-mcp'));
export const policyPath = () => path.join(homeDir(), 'policy.json');
export async function jsonFile(file, optional = false) {
  try { return JSON.parse(await fs.readFile(file, 'utf8')); }
  catch (e) {
    if (optional && e.code === 'ENOENT') return null;
    fail('CONFIG_INVALID', `Cannot read valid JSON from ${file}. Fix the file; comments and trailing commas are not supported.`);
  }
}
export function expand(value, env = process.env) {
  if (typeof value !== 'string') fail('CONFIG_INVALID', 'Configuration values must be strings.');
  return value.replace(/\$\{([^}]+)\}/g, (_, token) => {
    const name = token.startsWith('env:') ? token.slice(4) : token;
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) fail('AUTH_UNAVAILABLE', 'Interactive input or unsupported variable in MCP configuration. Use the direct Copilot tool.');
    if (env[name] === undefined) fail('ENV_MISSING', `Required environment variable ${name} is missing. Start Copilot from the shell that defines it.`);
    return env[name];
  });
}
async function exists(file) { try { await fs.access(file); return true; } catch { return false; } }
export async function discover({ workspace = process.cwd(), configs = [], copilotHome = process.env.COPILOT_HOME || path.join(os.homedir(), '.copilot'), signal, inventoryReader = copilotInventory } = {}) {
  workspace = await fs.realpath(path.resolve(workspace));
  const files = [path.join(copilotHome, 'mcp-config.json')];
  // Match repository precedence: root to working directory, .mcp.json wins locally.
  const parents = []; let cursor = workspace; let root = null;
  for (;;) {
    parents.push(cursor);
    if (await exists(path.join(cursor, '.git'))) { root = cursor; break; }
    const next = path.dirname(cursor); if (next === cursor) break; cursor = next;
  }
  if (root) for (const dir of parents.reverse()) files.push(path.join(dir, '.github', 'mcp.json'), path.join(dir, '.mcp.json'));
  const extras = [...(process.env.SPEED_MCP_CONFIGS || '').split(path.delimiter).filter(Boolean), ...configs];
  const extraFiles = extras.map(f => path.resolve(workspace, f));
  const servers = new Map(); const sources = []; const warnings = [];
  const addFile = async file => {
    const doc = await jsonFile(file, true); if (!doc) return;
    const entries = doc.mcpServers ?? doc.servers ?? Object.fromEntries(Object.entries(doc).filter(([k]) => !k.startsWith('$')));
    if (!entries || typeof entries !== 'object' || Array.isArray(entries)) fail('CONFIG_INVALID', `Expected a server map in ${file}.`);
    sources.push(file);
    for (const [name, raw] of Object.entries(entries)) {
      if (name === 'speed-mcp' || name.startsWith('$')) continue;
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) fail('CONFIG_INVALID', `Invalid server ${name} in ${file}.`);
      if (raw.command && JSON.stringify(raw).includes('speed-mcp.mjs')) { warnings.push(`Skipped recursive gateway ${name}.`); continue; }
      servers.set(name, { name, raw, source: file, workspace, fingerprint: digest({ raw, source: file, workspace }) });
    }
  };
  for (const file of [...new Set(files)]) await addFile(file);
  const exported = await inventoryReader({ workspace, copilotHome, signal });
  if (exported.warning) warnings.push(exported.warning);
  if (exported.servers) {
    sources.push('copilot mcp list --json');
    for (const [name, definition] of Object.entries(exported.servers)) {
      if (name === 'speed-mcp' || name.startsWith('$')) continue;
      if (!definition || typeof definition !== 'object' || Array.isArray(definition)) {
        warnings.push(`Ignored malformed exported server ${name}.`); continue;
      }
      if (JSON.stringify(definition).includes('speed-mcp.mjs')) continue;
      // Existing JSON definitions retain stable hashes. Respect disabled state in the host export.
      if (servers.has(name)) {
        if (definition.enabled === false || definition.disabled === true) {
          const existing = servers.get(name);
          existing.raw = { ...existing.raw, enabled: false };
          existing.fingerprint = digest({ raw: existing.raw, source: existing.source, workspace });
        }
        continue;
      }
      const { sourcePluginVersion, sourcePluginSpec, source, sourcePlugin, ...raw } = definition;
      const pluginRoot = raw.env?.PLUGIN_ROOT ?? raw.env?.COPILOT_PLUGIN_ROOT;
      if (pluginRoot !== undefined && (typeof pluginRoot !== 'string' || !path.isAbsolute(pluginRoot))) {
        warnings.push(`Ignored exported server ${name} with an invalid plugin root.`); continue;
      }
      const origin = `copilot:${source ?? 'configuration'}:${sourcePlugin ?? name}`;
      servers.set(name, { name, raw, source: origin, pluginRoot, workspace, fingerprint: digest({ raw, source: origin, workspace }) });
    }
  }
  for (const file of [...new Set(extraFiles)]) await addFile(file);
  return { workspace, servers, sources, warnings, discoveryMode: exported.mode,
    scope: 'User/repository JSON, available Copilot configuration export (including plugin definitions), then explicit files. Connections, OAuth stores and tool approvals are not shared; enterprise policy enforcement is not imported.' };
}
export function materialize(entry) {
  const c = entry.raw;
  if (c.disabled === true || c.enabled === false) fail('SERVER_DISABLED', `Server ${entry.name} is disabled.`);
  const kind = c.type || (c.url ? 'http' : 'stdio');
  if (!['local','stdio','http','streamable-http','sse'].includes(kind)) fail('TRANSPORT_UNSUPPORTED', `Unsupported transport for ${entry.name}. Use its direct Copilot tool.`);
  if (Object.keys(c).some(k => /oauth|oidc/i.test(k))) fail('AUTH_UNAVAILABLE', `Server ${entry.name} needs host-managed authentication. Use its direct Copilot tool.`);
  const env = { ...process.env, PLUGIN_ROOT: entry.pluginRoot ?? path.dirname(entry.source) };
  const result = { kind, tools: c.tools ?? ['*'], timeout: c.timeout ?? 30000 };
  if (!Array.isArray(result.tools) || result.tools.some(t => typeof t !== 'string')) fail('CONFIG_INVALID', 'tools must be an array of tool names.');
  if (!Number.isFinite(result.timeout) || result.timeout < 1) fail('CONFIG_INVALID', 'timeout must be positive milliseconds.');
  if (kind === 'local' || kind === 'stdio') {
    if (typeof c.command !== 'string' || !c.command) fail('CONFIG_INVALID', `Missing command for ${entry.name}.`);
    result.command = expand(c.command, env);
    result.args = (c.args ?? []).map(v => expand(v, env));
    result.cwd = path.resolve(entry.workspace, expand(c.cwd ?? c.workingDirectory ?? entry.workspace, env));
    result.env = Object.fromEntries(Object.entries(c.env ?? {}).map(([k,v]) => [k, expand(v, env)]));
  } else {
    result.url = expand(c.url, env);
    const url = new URL(result.url);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) fail('CONFIG_INVALID', 'MCP URL must be HTTP(S), without embedded credentials.');
    if (url.protocol === 'http:' && !['localhost','127.0.0.1','[::1]'].includes(url.hostname)) fail('INSECURE_URL', 'Use HTTPS for remote MCP connections.');
    result.headers = Object.fromEntries(Object.entries(c.headers ?? {}).map(([k,v]) => [k, expand(v, env)]));
  }
  return result;
}
export async function loadPolicy(file = policyPath()) {
  const p = await jsonFile(file, true);
  if (!p) return { version: 1, grants: {} };
  if (p.version !== 1 || !p.grants || typeof p.grants !== 'object' || Array.isArray(p.grants)) fail('POLICY_INVALID', 'Unsupported policy file. Run setup from your terminal.');
  for (const grant of Object.values(p.grants)) {
    if (!grant || typeof grant.fingerprint !== 'string' || !Array.isArray(grant.tools) || grant.tools.some(t => typeof t !== 'string' || !t || t === '*')) {
      fail('POLICY_INVALID', 'Invalid approval record. Restore the policy backup or run terminal setup after correcting the policy file.');
    }
  }
  return p;
}
export function authorize(entry, policy, tool) {
  const key = `${entry.workspace}::${entry.name}`;
  const grant = Object.hasOwn(policy.grants, key) ? policy.grants[key] : null;
  if (!grant || grant.fingerprint !== entry.fingerprint) fail('SETUP_REQUIRED', `Approve ${entry.name} for this workspace using terminal setup. Configuration changes require approval again.`);
  if (tool && !grant.tools.includes(tool)) fail('TOOL_NOT_APPROVED', `${entry.name}/${tool} is not approved in Speed MCP. Use the direct Copilot tool or ask the user to update terminal setup.`);
  return grant;
}
export async function savePolicy(policy, file = policyPath()) {
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.${randomUUID()}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(policy, null, 2) + '\n', { mode: 0o600 });
  await fs.rename(tmp, file);
}

// Merge each approval change against fresh state under a cross-process lock.
// A crash leaves an explicit lock to inspect rather than guessing whether a writer is alive.
export async function updatePolicy(mutate, file = policyPath(), { timeoutMs = 5000 } = {}) {
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const lockPath = `${file}.lock`; const deadline = Date.now() + timeoutMs;
  let lock;
  while (!lock) {
    try { lock = await fs.open(lockPath, 'wx', 0o600); }
    catch (e) {
      if (e.code !== 'EEXIST') throw e;
      if (Date.now() >= deadline) fail('POLICY_BUSY', 'Another setup/revoke operation holds the approval lock. Wait for it to finish. If a process crashed, inspect the lock before removing it manually.');
      await new Promise(resolve => setTimeout(resolve, 25));
    }
  }
  try {
    await lock.writeFile(JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() }));
    const latest = await loadPolicy(file);
    await mutate(latest);
    await savePolicy(latest, file);
    return latest;
  } finally { await lock.close(); await fs.unlink(lockPath); }
}
