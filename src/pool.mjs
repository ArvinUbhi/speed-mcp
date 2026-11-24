import { VERSION } from './version.mjs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport, getDefaultEnvironment } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { EnvHttpProxyAgent, fetch as proxyFetch } from 'undici';
import Ajv from 'ajv';
import Ajv2020 from 'ajv/dist/2020.js';
import { SpeedError, authorize, fail, materialize } from './config.mjs';

const activePools = new Set();
export const closeAllPools = () => Promise.allSettled([...activePools].map(pool => pool.close()));
export class Pool {
  constructor(inventory, policy, { connectTimeout = 15000, maxBytes = 2 * 1024 * 1024 } = {}) {
    this.inventory = inventory; this.policy = policy; this.connections = new Map();
    this.transports = new Set(); this.clients = new Set(); this.connectTimeout = connectTimeout;
    this.maxBytes = maxBytes; this.closed = false; this.secrets = new Set();
    this.controller = new AbortController();
    this.ajv = new Ajv({ allErrors: true, strict: false, validateFormats: false });
    this.ajv2020 = new Ajv2020({ allErrors: true, strict: false, validateFormats: false });
    activePools.add(this);
  }
  sanitize(value) {
    let text = String(value);
    for (const secret of this.secrets) if (secret.length >= 4) text = text.split(secret).join('[REDACTED]');
    return text.replace(/https?:\/\/[^\s"<>]+/g, '[remote endpoint]');
  }
  entry(name) {
    if (!this.inventory.servers.has(name)) fail('SERVER_UNAVAILABLE', `Server ${name} is not available in discovered JSON. Use the direct Copilot tool if present.`);
    return this.inventory.servers.get(name);
  }
  async connect(name) {
    if (this.closed) fail('CLOSED', 'Workflow connection pool is closed.');
    const entry = this.entry(name); authorize(entry, this.policy);
    if (!this.connections.has(name)) this.connections.set(name, this.open(entry));
    return this.connections.get(name);
  }
  async open(entry) {
    const c = materialize(entry);
    for (const v of Object.values(c.headers ?? {})) this.secrets.add(v);
    for (const [k,v] of Object.entries(c.env ?? {})) if (/token|secret|password|key|proxy/i.test(k)) this.secrets.add(v);
    let transport, agent;
    if (c.kind === 'stdio' || c.kind === 'local') {
      const inherited = getDefaultEnvironment();
      for (const k of ['HTTPS_PROXY','HTTP_PROXY','ALL_PROXY','NO_PROXY','https_proxy','http_proxy','all_proxy','no_proxy','NODE_EXTRA_CA_CERTS','SSL_CERT_FILE','SSL_CERT_DIR']) if (process.env[k]) inherited[k] = process.env[k];
      transport = new StdioClientTransport({ command: c.command, args: c.args, cwd: c.cwd, env: { ...inherited, ...c.env }, stderr: 'pipe' });
      // Drain server diagnostics without exposing credential-bearing stderr to the model.
      transport.stderr?.on('data', () => {});
    } else {
      agent = new EnvHttpProxyAgent();
      const fetcher = (url, init) => proxyFetch(url, { ...init, dispatcher: agent, redirect: 'error' });
      const options = { requestInit: { headers: c.headers }, fetch: fetcher };
      transport = c.kind === 'sse' ? new SSEClientTransport(new URL(c.url), options) : new StreamableHTTPClientTransport(new URL(c.url), options);
    }
    this.transports.add(transport);
    const client = new Client({ name: 'speed-mcp', version: VERSION }); this.clients.add(client);
    let timer;
    try {
      await Promise.race([
        client.connect(transport, { timeout: this.connectTimeout, signal: this.controller.signal }),
        new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Connection timed out.')), this.connectTimeout); })
      ]);
      if (this.closed) fail('CLOSED', 'Workflow ended during connection.');
      const tools = []; let cursor; const seen = new Set(); let pages = 0;
      do {
        if (this.closed || ++pages > 100) fail('CATALOG_LIMIT', 'Tool catalog page limit exceeded or connection closed.');
        const page = await client.listTools(cursor ? { cursor } : {}, { timeout: Math.min(c.timeout, 30000), signal: this.controller.signal });
        tools.push(...page.tools); cursor = page.nextCursor;
        if (tools.length > 10000 || (cursor && seen.has(cursor))) fail('CATALOG_LIMIT', 'Tool catalog pagination exceeded its limit.');
        seen.add(cursor);
      } while (cursor);
      return { client, transport, agent, config: c, validators: new Map(), tools: tools.filter(t => c.tools.includes('*') || c.tools.includes(t.name)) };
    } catch (e) {
      await transport.close().catch(() => {}); await agent?.close().catch(() => {});
      fail(e instanceof SpeedError ? e.code : 'CONNECTION_FAILED', `Could not connect to ${entry.name}. Check command, environment, proxy, certificates and authentication. Use direct Copilot tools for host-managed sign-in. Upstream diagnostics are withheld because they can contain credentials.`);
    } finally { clearTimeout(timer); }
  }
  async catalog(name) { return (await this.connect(name)).tools; }
  async validateArguments(name, tool, args) {
    authorize(this.entry(name), this.policy, tool);
    const conn = await this.connect(name);
    const definition = conn.tools.find(t => t.name === tool);
    if (!definition) fail('TOOL_UNAVAILABLE', `${name}/${tool} is absent or excluded by the MCP configuration.`);
    let validate = conn.validators.get(tool);
    if (!validate) {
      try {
        const validator = definition.inputSchema.$schema?.includes('draft-07') ? this.ajv : this.ajv2020;
        validate = validator.compile(definition.inputSchema); conn.validators.set(tool, validate);
      } catch { fail('SCHEMA_UNSUPPORTED', `Cannot validate ${name}/${tool}'s input schema. Use its direct Copilot tool.`); }
    }
    if (!validate(args)) fail('ARGUMENTS_INVALID', `Arguments do not match ${name}/${tool}. Inspect speed_mcp_describe before calling.`);
    return conn;
  }
  async call(name, tool, args, signal) {
    const conn = await this.validateArguments(name, tool, args);
    let result;
    try { result = await conn.client.callTool({ name: tool, arguments: args }, undefined, { timeout: Math.min(conn.config.timeout, 60000), signal: signal ? AbortSignal.any([signal, this.controller.signal]) : this.controller.signal }); }
    catch (e) { fail('TOOL_FAILED', `${name}/${tool} failed or was interrupted. Check the direct tool and connection. Upstream diagnostics are withheld to protect credentials. No automatic retry was made.`); }
    if (result.isError) fail('TOOL_REPORTED_ERROR', `${name}/${tool} returned isError. Inspect the failure through its direct tool; no automatic retry was made.`);
    if (Buffer.byteLength(JSON.stringify(result)) > this.maxBytes) fail('RESULT_LIMIT', `${name}/${tool} returned too much data. Filter or paginate at the source.`);
    if (result.structuredContent !== undefined) return result.structuredContent;
    if (result.content?.length === 1 && result.content[0].type === 'text') {
      try { return JSON.parse(result.content[0].text); } catch { return { text: result.content[0].text }; }
    }
    return { content: (result.content ?? []).map(block => ['image','audio'].includes(block.type) ? { type: block.type, omitted: true } : block) };
  }
  abort() { this.controller.abort(); }
  async close() {
    this.closed = true; this.controller.abort(); activePools.delete(this);
    await Promise.allSettled([...this.clients].map(c => c.close()));
    await Promise.allSettled([...this.transports].map(t => t.close()));
    const ready = await Promise.allSettled(this.connections.values());
    await Promise.allSettled(ready.filter(r => r.status === 'fulfilled').map(r => r.value.agent?.close()));
  }
}
